import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import PQueue from 'p-queue';
import { classifyIncomingMessage } from './messageFilter.js';
import { classifyWhatsAppMessage } from './messageClassification.js';
import { validateText } from '../security/validation.js';
import { stageIncomingDocument, cleanupStagedDocument } from '../tools/documents.js';

const IDLE_QUEUE_MS = 5 * 60_000;
const MAX_QUEUED_MESSAGES = 25;
const MAX_SEEN_MESSAGES = 5000;
const SEEN_MESSAGE_TTL_MS = 60 * 60_000;
const DIAGNOSTICS_SUMMARY_INTERVAL_MS = 5 * 60_000;
const TEMP_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'temp');
const DOCUMENT_FILENAMES = new Map([
  ['application/pdf', 'document.pdf'],
  ['text/plain', 'document.txt'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'document.docx'],
]);

function safeWhatsAppId(value) {
  if (typeof value !== 'string') return undefined;
  const totalDigits = (value.match(/\d/g) || []).length;
  let digitsToMask = Math.max(0, totalDigits - 4);
  return value.replace(/\d/g, (digit) => {
    if (digitsToMask > 0) {
      digitsToMask -= 1;
      return '*';
    }
    return digit;
  });
}

function messageKey(msg, userId) {
  const serializedId = msg.id?._serialized;
  if (typeof serializedId === 'string' && serializedId.length > 0) {
    return `id:${userId}:${serializedId}`;
  }

  if (Number.isFinite(msg.timestamp)) {
    const media = msg._data?.filename || msg._data?.mimetype || '';
    return `fallback:${JSON.stringify([
      userId,
      msg.timestamp,
      msg.type || '',
      msg.body || '',
      media,
    ])}`;
  }
  return null;
}

export function createMessageHandler({
  agent,
  limiter,
  logger,
  config,
  outbound,
  newsletterStore,
  mediaStore,
  inboundStore,
  modelRouter,
  adminContacts = [],
  tempDirectory = TEMP_DIRECTORY,
}) {
  const queues = new Map();
  const seen = new Map();
  const seenObjects = new WeakSet();
  const diagnostics = {
    eventsReceived: 0,
    privateIncomingCandidates: 0,
    privateMessagesRejected: 0,
    privateMessagesVerified: 0,
    groupEvents: 0,
    newsletterEvents: 0,
    aiProcessingStarted: 0,
    outboundReplyAttempts: 0,
  };
  const authorizedModelAdmins = new Set(adminContacts
    .filter((contact) => typeof contact === "string")
    .map((contact) => contact.trim().toLowerCase())
    .filter((contact) => /@(c\.us|lid)$/.test(contact)));
  if (!authorizedModelAdmins.size) {
    logger.warn("ai_model_admins_not_configured", {});
  }

  async function handleModelCommand(msg, userId, text) {
    if (typeof text !== "string") return false;
    const match = text.match(/^\/model(?:\s+([\s\S]*))?$/i);
    if (!match) return false;
    if (!authorizedModelAdmins.has(userId.toLowerCase())) {
      logger.warn("ai_model_command_unauthorized", {
        eventUuid: msg.eventUuid,
        command: "model",
      });
      await sendReply(msg, "Hii command ni ya administrator pekee.", "model-command-unauthorized");
      return true;
    }
    if (!modelRouter) {
      await sendReply(msg, "Model selection is unavailable right now.", "model-command");
      return true;
    }
    const args = (match[1] || "").trim().split(/\s+/).filter(Boolean);
    const first = (args[0] || "status").toLowerCase();
    const second = (args[1] || "").toLowerCase();
    if (args.length === 0 || first === "status") {
      await sendReply(msg, modelRouter.formatStatus(userId), "model-status");
      return true;
    }
    if (first === "contact") {
      const selection = second || "auto";
      if (!["auto", "gemini", "openai", "claude", "ollama"].includes(selection) ||
          args.length > 2) {
        await sendReply(
          msg,
          "Tumia `/model contact <auto|gemini|openai|claude|ollama>`.",
          "model-command-help",
        );
        return true;
      }
      await modelRouter.setContactPreference(userId, selection);
      await sendReply(msg, `Contact model preference set to ${selection}.`, "model-contact-selection");
      return true;
    }
    if (first === "priority") {
      const requested = args.length === 2 ? args[1].split(",").filter(Boolean) : [];
      if (!requested.length) {
        await sendReply(
          msg,
          "Tumia `/model priority gemini,openai,claude,ollama`.",
          "model-command-help",
        );
        return true;
      }
      if (requested.some((provider) =>
        !["gemini", "openai", "claude", "ollama"].includes(provider.toLowerCase()))) {
        await sendReply(
          msg,
          "Unknown provider. Use only gemini, openai, claude, and ollama.",
          "model-command-help",
        );
        return true;
      }
      const priorities = modelRouter.setPriorities(requested);
      await sendReply(msg, `Provider priority order: ${priorities.join(" → ")}`, "model-priority");
      return true;
    }
    if (args.length > 1 || !["auto", "gemini", "openai", "claude", "ollama"].includes(first)) {
      await sendReply(
        msg,
        "Tumia `/model status`, `/model auto`, `/model <provider>`, au `/model priority <provider,...>`.",
        "model-command-help",
      );
      return true;
    }
    await modelRouter.setGlobalSelection(first);
    const selected = first === "auto" ? "automatic routing" : first;
    await sendReply(msg, `Global model selection set to ${selected}.`, "model-global-selection");
    return true;
  }

  function getDiagnosticsSummary() {
    return { ...diagnostics };
  }

  function logDiagnosticsSummary() {
    logger.info('whatsapp_handler_diagnostics_summary', {
      ...getDiagnosticsSummary(),
      intervalMs: DIAGNOSTICS_SUMMARY_INTERVAL_MS,
    });
  }
  logDiagnosticsSummary();
  const diagnosticsTimer = setInterval(
    logDiagnosticsSummary,
    DIAGNOSTICS_SUMMARY_INTERVAL_MS,
  );
  diagnosticsTimer.unref?.();

  function sendReply(msg, text, purpose) {
    diagnostics.outboundReplyAttempts += 1;
    if (!outbound) return msg.reply(text);
    const serializedId = msg.id?._serialized;
    const recipient = msg.chatId || msg.from || msg.userId;
    logger.info('whatsapp_outbound_reply_attempted', {
      eventUuid: msg.eventUuid,
      inboundWhatsAppMessageIdPresent: Boolean(msg.whatsappMessageId || serializedId),
      purpose,
    });
    return Promise.resolve(outbound.sendText(recipient, text, {
      messageType: 'automatic_reply',
      idempotencyKey: typeof serializedId === 'string' && serializedId
        ? `inbound:${serializedId}:${purpose}`
        : null,
    })).then((result) => {
      logger.info('whatsapp_outbound_reply_result', {
        eventUuid: msg.eventUuid,
        status: result?.status || 'unknown',
        accepted: result?.accepted === true,
        whatsappMessageIdPresent: Boolean(result?.messageId),
      });
      if (result?.ok !== true) {
        throw Object.assign(new Error('Outbound message was not accepted.'), {
          code: result?.error || 'OUTBOUND_MESSAGE_NOT_ACCEPTED',
        });
      }
      return result;
    });
  }

  function pruneSeen(now) {
    for (const [key, seenAt] of seen) {
      if (now - seenAt > SEEN_MESSAGE_TTL_MS) seen.delete(key);
    }
    while (seen.size > MAX_SEEN_MESSAGES) {
      seen.delete(seen.keys().next().value);
    }
  }

  function isDuplicate(msg, userId) {
    const serializedId = msg?.whatsappMessageId || msg?.id?._serialized;
    if (!serializedId && msg && typeof msg === 'object') {
      if (seenObjects.has(msg)) return true;
      seenObjects.add(msg);
    }

    const key = messageKey(msg, userId);
    if (!key) {
      logger.debug('message_deduplication_unavailable', { user: safeWhatsAppId(userId) });
      return false;
    }

    const now = Date.now();
    pruneSeen(now);
    if (seen.has(key)) return true;
    seen.set(key, now);
    pruneSeen(now);
    return false;
  }

  function scheduleQueueCleanup(userId, item) {
    clearTimeout(item.cleanupTimer);
    item.cleanupTimer = setTimeout(() => {
      if (queues.get(userId) !== item) return;
      if (item.queue.size > 0 || item.queue.pending > 0) {
        scheduleQueueCleanup(userId, item);
        return;
      }

      const idleFor = Date.now() - item.lastUsed;
      if (idleFor < IDLE_QUEUE_MS) {
        item.cleanupTimer = setTimeout(
          () => scheduleQueueCleanup(userId, item),
          IDLE_QUEUE_MS - idleFor,
        );
        item.cleanupTimer.unref?.();
        return;
      }
      queues.delete(userId);
    }, IDLE_QUEUE_MS);
    item.cleanupTimer.unref?.();
  }

  async function handleMessage(msg, item, userId) {
    let claimed = false;
    try {
      const outcome = await classifyIncomingMessage(msg, (message) => message.getChat());
      if (!outcome.accepted) {
        const rejectedClassification = outcome.classification ||
          classifyWhatsAppMessage(msg);
        if (
          rejectedClassification.chatId.endsWith('@c.us') ||
          rejectedClassification.chatId.endsWith('@lid')
        ) {
          diagnostics.privateMessagesRejected += 1;
          logger.warn('whatsapp_private_message_rejected', {
            eventUuid: msg.eventUuid,
            reason: outcome.reason,
            rejectionStage: outcome.reason === 'unverified-chat' ||
              outcome.reason === 'chat-id-mismatch' ||
              outcome.reason === 'unsupported-chat'
              ? 'chat-verification'
              : 'classification',
            whatsappMessageIdPresent: Boolean(msg.whatsappMessageId || msg.id?._serialized),
          });
        }
        const rejectedMetadata = {
          eventUuid: msg.eventUuid,
          conversationType: rejectedClassification.conversationType,
          reason: outcome.reason,
          chatId: safeWhatsAppId(rejectedClassification.chatId),
          messageType: msg.type,
          hasBody: typeof msg.body === 'string' && msg.body.length > 0,
          hasMedia: msg.hasMedia === true,
        };
        if (rejectedClassification.conversationType === 'unknown') {
          logger.warn('whatsapp_unknown_event_received', rejectedMetadata);
        } else {
          logger.info('whatsapp_non_customer_event_received', rejectedMetadata);
        }
        logger.info('whatsapp_message_classification_result', {
          eventUuid: msg.eventUuid,
          conversationType: rejectedClassification.conversationType,
          reason: outcome.reason,
          verified: false,
        });
        return { status: 'skipped', reason: outcome.reason };
      }
      diagnostics.privateMessagesVerified += 1;
      msg.chatId = outcome.userId;
      logger.info('whatsapp_message_classification_result', {
        eventUuid: msg?.eventUuid,
        conversationType: outcome.classification.conversationType,
        reason: outcome.classification.reason,
        verified: true,
      });
      logger.info('whatsapp_private_message_received', {
        eventUuid: msg.eventUuid,
        conversationType: outcome.classification.conversationType,
        whatsappMessageIdPresent: Boolean(msg.whatsappMessageId || msg.id?._serialized),
        messageType: msg.type,
      });
      logger.info('whatsapp_private_message_verified', {
        eventUuid: msg.eventUuid,
        whatsappMessageIdPresent: Boolean(msg.whatsappMessageId || msg.id?._serialized),
        conversationType: outcome.classification.conversationType,
      });
      logger.info('message_added_to_processing_queue', {
        user: safeWhatsAppId(userId),
        eventUuid: msg.eventUuid,
        messageIdPresent: Boolean(msg.whatsappMessageId || msg.id?._serialized),
        queued: item.queue.size,
      });
      if (inboundStore) {
        const claim = inboundStore.claim(msg);
        if (!claim.claimed) {
          logger.info('whatsapp_inbound_duplicate_skipped', {
            eventUuid: msg.eventUuid,
            whatsappMessageIdPresent: Boolean(msg.whatsappMessageId),
            reason: claim.reason,
          });
          return { status: 'skipped', reason: claim.reason };
        }
        claimed = claim.persistent;
      }
      if (isDuplicate(msg, userId)) {
        logger.debug('message_rejected', {
          reason: 'duplicate',
          whatsappMessageIdPresent: Boolean(msg.whatsappMessageId || msg.id?._serialized),
        });
        if (claimed) inboundStore.complete(msg);
        return { status: 'skipped', reason: 'duplicate' };
      }
      logger.info('incoming_message_accepted', {
        user: safeWhatsAppId(userId),
        whatsappMessageIdPresent: Boolean(msg.whatsappMessageId || msg.id?._serialized),
        eventUuid: msg.eventUuid,
      });

      if (/^stop$/i.test(outcome.text)) {
        outbound?.setSuppressed(userId, true);
        logger.info('recipient_suppressed', { user: safeWhatsAppId(userId) });
        if (claimed) inboundStore.complete(msg);
        return { status: 'processed' };
      }
      if (/^start$/i.test(outcome.text) && outbound?.isSuppressed(userId)) {
        outbound.setSuppressed(userId, false);
        await sendReply(msg, 'Atom notifications are re-enabled.', 'opt-in-confirmation');
        if (claimed) inboundStore.complete(msg);
        return { status: 'processed' };
      }
      if (!limiter.allow(userId)) {
        await sendReply(msg, 'Pole, umefika message limit ya dakika. Jaribu tena shortly.', 'rate-limit');
        if (claimed) inboundStore.complete(msg);
        return { status: 'processed' };
      }
      if (await handleModelCommand(msg, userId, outcome.text)) {
        if (claimed) inboundStore.complete(msg);
        return { status: 'processed' };
      }

      const chat = outcome.chat || await msg.getChat();
      await chat.sendStateTyping?.();

      let storedMedia;
      if (outcome.hasMedia && mediaStore) {
        storedMedia = await mediaStore.download(msg);
        logger.info('whatsapp_media_storage_result', {
          eventUuid: msg.eventUuid,
          whatsappMessageIdPresent: Boolean(msg.whatsappMessageId),
          mediaType: msg.type,
          status: storedMedia.status,
          ...(storedMedia.reason ? { reason: storedMedia.reason } : {}),
          ...(storedMedia.duplicate ? { duplicate: true } : {}),
        });
      } else if (outcome.hasMedia) {
        logger.warn('whatsapp_media_storage_unavailable', {
          eventUuid: msg.eventUuid,
          whatsappMessageIdPresent: Boolean(msg.whatsappMessageId),
          mediaType: msg.type,
        });
      }

      if (outcome.hasMedia) {
        if (msg.type !== 'document') {
          await sendReply(msg, 'Pole, currently na-support documents pekee, si hii media type.', 'unsupported-media');
          if (claimed) inboundStore.complete(msg);
          return { status: 'processed' };
        }

        let staged;
        try {
          let media;
          if (mediaStore) {
            if (storedMedia?.status !== 'downloaded' || !storedMedia.filePath) {
              await sendReply(msg, 'Pole, sikuweza kupakua document hiyo safely.', 'document-download-failed');
              if (claimed) inboundStore.complete(msg);
              return { status: 'processed' };
            }
            const bytes = await fs.readFile(storedMedia.filePath);
            media = {
              filename: msg.metadata?.filename || msg.metadata?.fileName ||
                DOCUMENT_FILENAMES.get(storedMedia.mimetype) || 'document',
              mimetype: storedMedia.mimetype,
              data: bytes.toString('base64'),
            };
          } else {
            media = await msg.downloadMedia();
          }
          staged = await stageIncomingDocument(
            media,
            config.MAX_FILE_SIZE_MB * 1024 * 1024,
            tempDirectory,
          );
          await sendReply(msg, 'Nimepokea document yako safely, lakini document text extraction haija-implementiwa bado.', 'document-received');
          if (claimed) inboundStore.complete(msg);
          return { status: 'processed' };
        } finally {
          if (staged) {
            try {
              await cleanupStagedDocument(staged);
            } catch (error) {
              logger.error('temporary_document_cleanup_failed', { code: error.code || error.name });
            }
          }
        }
      }

      const text = validateText(outcome.text, config.MAX_MESSAGE_LENGTH);
      logger.info('individual_message_received', {
        user: safeWhatsAppId(outcome.userId),
        chars: text.length,
      });
      logger.info('ai_processing_started', {
        eventUuid: msg.eventUuid,
        model: agent.gemini?.config?.GEMINI_MODEL,
        messageIdPresent: Boolean(msg.whatsappMessageId || msg.id?._serialized),
      });
      diagnostics.aiProcessingStarted += 1;
      const aiStartedAt = Date.now();
      const reply = await agent.respond(outcome.userId, text, { eventUuid: msg.eventUuid });
      logger.info('ai_response_ready_for_delivery', {
        eventUuid: msg.eventUuid,
        durationMs: Date.now() - aiStartedAt,
        responseLength: reply.length,
      });
      try {
        await sendReply(msg, reply, 'ai-response');
      } catch (error) {
        logger.error('ai_response_delivery_failed', {
          eventUuid: msg.eventUuid,
          responseGenerated: true,
          responseLength: reply.length,
          errorName: error?.name || 'Error',
          ...(error?.code ? { errorCode: String(error.code).slice(0, 100) } : {}),
        });
        if (claimed) inboundStore.fail(msg, error);
        return { status: 'delivery-failed', reason: error?.code || 'OUTBOUND_DELIVERY_FAILED' };
      }
      if (claimed) inboundStore.complete(msg);
      return { status: 'processed' };
    } catch (error) {
      logger.error('message_processing_failed', {
        eventUuid: msg.eventUuid,
        whatsappMessageIdPresent: Boolean(msg.whatsappMessageId),
        errorName: error?.name || 'Error',
        ...(error?.code ? { errorCode: error.code } : {}),
      });
      if (claimed) inboundStore.fail(msg, error);
      const failedKey = messageKey(msg, userId);
      if (failedKey) seen.delete(failedKey);
      try {
        await sendReply(msg, 'Pole, kuna issue kidogo. Jaribu tena baadaye.', 'processing-error');
        if (claimed) inboundStore.complete(msg);
      } catch {
        logger.warn('message_error_reply_failed', { eventUuid: msg.eventUuid });
      }
      return { status: 'failed' };
    } finally {
      item.lastUsed = Date.now();
      scheduleQueueCleanup(userId, item);
    }
  }

  const handleIncoming = async (msg) => {
    diagnostics.eventsReceived += 1;
    const classification = classifyWhatsAppMessage(msg);
    if (classification.pipeline === 'store-newsletter') {
      diagnostics.newsletterEvents += 1;
      logger.info('whatsapp_newsletter_event_received', {
        eventUuid: msg?.eventUuid,
        whatsappMessageIdPresent: Boolean(msg?.whatsappMessageId || msg?.id?._serialized),
        channelId: safeWhatsAppId(classification.chatId),
        messageType: msg?.type,
      });
      try {
        if (!newsletterStore) {
          throw new Error('Newsletter store is not configured.');
        }
        const result = newsletterStore.record(msg);
        logger.info('whatsapp_newsletter_update_stored', {
          eventUuid: result.eventUuid,
          whatsappMessageIdPresent: Boolean(result.whatsappMessageId),
          missingWhatsAppMessageId: result.missingWhatsAppMessageId,
          channelId: safeWhatsAppId(classification.chatId),
          authorId: safeWhatsAppId(classification.participantId),
          messageType: msg.type,
          duplicate: result.duplicate,
        });
        if (result.missingWhatsAppMessageId) {
          logger.warn('whatsapp_newsletter_message_id_missing', {
            eventUuid: result.eventUuid,
            channelId: safeWhatsAppId(classification.chatId),
          });
        }
      } catch (error) {
        const diagnostic = {
          errorName: error?.name || 'Error',
          errorMessage: error?.message || String(error),
          ...(error?.code ? { errorCode: error.code } : {}),
        };
        logger.error('whatsapp_newsletter_update_store_failed', {
          eventUuid: msg?.eventUuid,
          whatsappMessageIdPresent: Boolean(msg?.whatsappMessageId || msg?.id?._serialized),
          channelId: safeWhatsAppId(classification.chatId),
          ...diagnostic,
        });
        if (config?.LOG_LEVEL === 'debug' && error?.stack) {
          logger.debug('whatsapp_newsletter_update_store_error_details', {
            eventUuid: msg?.eventUuid,
            stack: error.stack,
          });
        }
      }
      return;
    }

    if (msg?.fromMe) {
      logger.debug('message_rejected', { reason: 'self', eventUuid: msg?.eventUuid });
      return { status: 'skipped', reason: 'self' };
    }

    const privateAddressCandidate = classification.chatId.endsWith('@c.us') ||
      classification.chatId.endsWith('@lid');
    if (privateAddressCandidate) {
      diagnostics.privateIncomingCandidates += 1;
    }
    if (!privateAddressCandidate && classification.conversationType === 'group') {
      diagnostics.groupEvents += 1;
      logger.info('whatsapp_group_event_received', {
        eventUuid: msg?.eventUuid,
        conversationType: classification.conversationType,
        chatId: safeWhatsAppId(classification.chatId),
        participantId: safeWhatsAppId(classification.participantId),
        messageType: msg?.type,
      });
    }
    if (!privateAddressCandidate) {
      const metadata = {
        conversationType: classification.conversationType,
        reason: classification.reason,
        chatId: safeWhatsAppId(classification.chatId),
        participantId: safeWhatsAppId(classification.participantId),
        eventUuid: msg?.eventUuid,
        whatsappMessageIdPresent: Boolean(msg?.whatsappMessageId || msg?.id?._serialized),
        messageIdMissing: msg?.messageIdMissing === true ||
          !(msg?.whatsappMessageId || msg?.id?._serialized),
        messageType: typeof msg?.type === 'string' ? msg.type : undefined,
        subtype: typeof msg?.subtype === 'string' ? msg.subtype : undefined,
        isNotification: msg?.isNotification === true,
        isPSA: msg?.isPSA === true,
        hasBody: typeof msg?.body === 'string' && msg.body.length > 0,
        hasMedia: msg?.hasMedia === true,
      };
      if (metadata.conversationType === 'unknown') {
        logger.warn('whatsapp_unknown_event_received', metadata);
      } else {
        logger.info('whatsapp_non_customer_event_received', metadata);
      }
      logger.info('whatsapp_message_classification_result', {
        eventUuid: msg?.eventUuid,
        conversationType: classification.conversationType,
        reason: classification.reason,
        accepted: false,
      });
      return { status: 'skipped', reason: classification.reason };
    }

    const sender = classification.chatId;

    let item = queues.get(sender);
    if (!item) {
      item = { queue: new PQueue({ concurrency: 1 }), lastUsed: Date.now(), cleanupTimer: undefined };
      queues.set(sender, item);
    }
    item.lastUsed = Date.now();

    if (item.queue.size >= MAX_QUEUED_MESSAGES) {
      try {
        await sendReply(msg, 'Pole, bado nashughulikia messages zako. Jaribu tena baada ya muda mfupi.', 'queue-full');
        return { status: 'processed' };
      } catch {
        return { status: 'failed' };
      }
    }

    try {
      return await item.queue.add(() => handleMessage(msg, item, sender));
    } catch (error) {
      logger.error('whatsapp_message_queue_failed', {
        eventUuid: msg.eventUuid,
        errorName: error?.name || 'Error',
        errorMessage: error?.message || String(error),
      });
      return { status: 'failed' };
    }
  };
  handleIncoming.getDiagnosticsSummary = getDiagnosticsSummary;
  handleIncoming.logDiagnosticsSummary = logDiagnosticsSummary;
  return handleIncoming;
}
