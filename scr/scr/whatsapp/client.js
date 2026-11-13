import path from "node:path";
import { randomUUID } from "node:crypto";
import wppconnect from "@wppconnect-team/wppconnect";
import { closeBrowser, initBrowser } from "@wppconnect-team/wppconnect/dist/controllers/browser.js";
import { defaultOptions } from "@wppconnect-team/wppconnect/dist/config/create-config.js";
import {
  extractAcknowledgementMessageId,
  messageIdFingerprint,
} from "./outbound.js";

const SESSION_NAME = "atom-maurice-test";
const PROFILE_DIRECTORY = path.join("Atom", "whatsapp-session", "session-atom-maurice-wppconnect");
const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const AUTO_CLOSE_MS = 0;
const DEVICE_SYNC_TIMEOUT_MS = 180_000;

const terminalStateReasons = {
  UNPAIRED: "whatsapp_session_unpaired",
  UNPAIRED_IDLE: "whatsapp_session_unpaired",
  DISCONNECTED: "whatsapp_connection_disconnected",
  TIMEOUT: "whatsapp_connection_timeout",
  CONFLICT: "whatsapp_session_conflict",
  UNLAUNCHED: "whatsapp_web_unlaunched",
  PROXYBLOCK: "whatsapp_proxy_blocked",
  TOS_BLOCK: "whatsapp_terms_blocked",
  SMB_TOS_BLOCK: "whatsapp_business_terms_blocked",
  DEPRECATED_VERSION: "whatsapp_web_version_deprecated",
};

const statusReasons = {
  notLogged: "whatsapp_authentication_required",
  disconnectedMobile: "whatsapp_mobile_disconnected",
  phoneNotConnected: "whatsapp_phone_not_connected",
  qrReadError: "whatsapp_authentication_failed",
  qrReadFail: "whatsapp_qr_read_failed",
};

const filenameForMimeType = (mimetype) => ({
  "application/pdf": "document.pdf",
  "text/plain": "document.txt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "document.docx",
}[mimetype] || "document");

const MESSAGE_METADATA_FIELDS = [
  "ack",
  "associationType",
  "author",
  "broadcast",
  "caption",
  "chatId",
  "directPath",
  "filehash",
  "from",
  "fromMe",
  "isGroupMsg",
  "isMedia",
  "isNotification",
  "isPSA",
  "isViewOnce",
  "mediaKeyTimestamp",
  "mentionedJidList",
  "mimetype",
  "notifyName",
  "subtype",
  "timestamp",
  "to",
  "type",
  "viewMode",
  "filename",
  "fileName",
];

const MEDIA_MESSAGE_TYPES = new Set(["image", "video", "document", "audio", "ptt", "sticker"]);
const SENSITIVE_SHAPE_KEY = /body|content|caption|phone|number|address|name|from|to|author|sender|token|secret|password|cookie|credential|media.?key|url|path|hash/i;
const SAFE_MEDIA_SHAPE_KEYS = new Set(["clientUrl", "directPath", "filehash"]);

function serializedWppId(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return value._serialized || value.serialized || "";
}

export async function resolveLidRecipient(client, recipient) {
  if (!recipient.endsWith("@lid")) return recipient;
  if (
    typeof client?.getChatById !== "function" ||
    typeof client?.getPnLidEntry !== "function"
  ) {
    throw Object.assign(new Error("WPPConnect LID resolution is unavailable."), {
      code: "LID_RESOLUTION_UNAVAILABLE",
    });
  }

  let chat;
  try {
    chat = await client.getChatById(recipient);
  } catch (error) {
    throw Object.assign(new Error("WPPConnect private LID chat lookup failed."), {
      code: "LID_CHAT_LOOKUP_FAILED",
      cause: error,
    });
  }
  const chatId = serializedWppId(chat?.id);
  const contactId = serializedWppId(chat?.contact?.id);
  const exactChatMatch = chatId === recipient || contactId === recipient;
  if (
    !exactChatMatch ||
    chat?.isUser !== true ||
    chat?.isGroup !== false ||
    chat?.isBroadcast === true ||
    chat?.isStatus === true ||
    chat?.isReadOnly === true
  ) {
    throw Object.assign(new Error("LID did not resolve to the verified private chat."), {
      code: "LID_RECIPIENT_NOT_PRIVATE",
    });
  }

  let mapping;
  try {
    mapping = await client.getPnLidEntry(recipient);
  } catch (error) {
    throw Object.assign(new Error("WPPConnect LID-to-phone mapping lookup failed."), {
      code: "LID_MAPPING_LOOKUP_FAILED",
      cause: error,
    });
  }
  const mappedLid = serializedWppId(mapping?.lid);
  const phoneNumber = serializedWppId(mapping?.phoneNumber);
  if (
    mappedLid !== recipient ||
    typeof phoneNumber !== "string" ||
    !/^\d{6,15}@c\.us$/.test(phoneNumber)
  ) {
    throw Object.assign(new Error("No verified phone-number mapping exists for this LID."), {
      code: "LID_RECIPIENT_UNRESOLVED",
    });
  }
  return phoneNumber;
}

function mediaMetadata(message, client) {
  const mediaType = MEDIA_MESSAGE_TYPES.has(message?.type);
  const mediaMetadataPresent = Boolean(
    (message?.mediaData && typeof message.mediaData === "object") ||
    message?.mimetype ||
    message?.clientUrl ||
    message?.directPath ||
    message?.filehash
  );
  const hasMedia = message?.isMedia === true || mediaType;
  return {
    hasMedia,
    mediaMetadataPresent,
    downloadable: hasMedia && Boolean(serializedWppId(message?.id)) &&
      typeof client?.downloadMedia === "function",
  };
}

function describeShape(value, prefix, output, depth = 0) {
  if (!value || typeof value !== "object" || depth > 2 || output.length >= 50) return;
  for (const key of Object.keys(value)) {
    if (SENSITIVE_SHAPE_KEY.test(key) && !SAFE_MEDIA_SHAPE_KEYS.has(key)) continue;
    const child = value[key];
    const childType = child === null ? "null" : Array.isArray(child)
      ? "array"
      : typeof child;
    const fieldPath = prefix ? `${prefix}.${key}` : key;
    output.push({ path: fieldPath, type: childType });
    if (childType === "object") describeShape(child, fieldPath, output, depth + 1);
    if (output.length >= 50) break;
  }
}

export function inspectWppMessageShape(message) {
  const fields = [];
  describeShape(message, "", fields);
  return fields;
}

async function observeLifecycle({ browser, page, lastState, shutdownReason, logger }) {
  const browserProcess = browser?.process?.();
  const snapshot = () => ({
    timestamp: new Date().toISOString(),
    browserPid: browserProcess?.pid ?? null,
    processExitCode: browserProcess?.exitCode ?? null,
    processSignalCode: browserProcess?.signalCode ?? null,
    browserConnected: typeof browser?.isConnected === "function"
      ? browser.isConnected()
      : null,
    pageClosed: typeof page?.isClosed === "function" ? page.isClosed() : null,
    lastWhatsAppState: lastState(),
    intentionalShutdown: Boolean(shutdownReason()),
    shutdownReason: shutdownReason() || undefined,
  });
  const report = (event, level = "warn", details = {}) => {
    logger[level]("whatsapp_puppeteer_lifecycle", {
      event,
      ...snapshot(),
      ...details,
    });
  };
  const listen = (target, event, callback) => {
    if (typeof target?.on !== "function") return false;
    target.on(event, callback);
    return true;
  };
  const observedPages = new WeakSet();
  const wrappedTargets = new WeakMap();
  const observeCloseCall = (target, method, event) => {
    if (!target || typeof target[method] !== "function") return false;
    let methods = wrappedTargets.get(target);
    if (!methods) {
      methods = new Set();
      wrappedTargets.set(target, methods);
    }
    if (methods.has(method)) return true;
    const original = target[method];
    try {
      target[method] = function (...args) {
        report(event, shutdownReason() ? "info" : "warn");
        const stack = new Error().stack;
        if (stack) logger.debug?.("whatsapp_puppeteer_close_call_stack", { event, stack });
        return Reflect.apply(original, this, args);
      };
      methods.add(method);
      return true;
    } catch (error) {
      report("lifecycle_method_instrumentation_failed", "warn", {
        method,
        errorName: error?.name || "Error",
      });
      return false;
    }
  };
  const attachPage = (observedPage) => {
    if (!observedPage || observedPages.has(observedPage)) return;
    observedPages.add(observedPage);
    page = observedPage;
    listen(page, "close", () => report(
      "page_closed",
      shutdownReason() ? "info" : "error",
    ));
    listen(page, "error", (error) => report("page_crashed", "error", {
      errorName: error?.name || "Error",
      errorMessage: error?.message || String(error),
    }));
    listen(page, "pageerror", (error) => report("page_error", "error", {
      errorName: error?.name || "Error",
      errorMessage: error?.message || String(error),
    }));
    const pageCloseMethod = observeCloseCall(page, "close", "page_close_requested");
    logger.info("whatsapp_page_lifecycle_diagnostics_attached", snapshot());
    return pageCloseMethod;
  };
  const browserCloseMethod = observeCloseCall(browser, "close", "browser_close_requested");
  const browserDisconnectMethod = observeCloseCall(
    browser,
    "disconnect",
    "browser_disconnect_requested",
  );

  const attached = {
    browserDisconnected: listen(browser, "disconnected", () => report(
      "browser_disconnected",
      shutdownReason() ? "info" : "error",
    )),
    targetDestroyed: listen(browser, "targetdestroyed", (target) => {
      if (target?.type?.() !== "page") return;
      report("browser_target_destroyed", shutdownReason() ? "info" : "warn", {
        targetType: "page",
      });
    }),
    targetCreated: listen(browser, "targetcreated", (target) => {
      if (target?.type?.() !== "page" || typeof target.page !== "function") return;
      void Promise.resolve().then(() => target.page()).then(attachPage).catch((error) => report(
        "page_diagnostic_attach_failed",
        "error",
        { errorName: error?.name || "Error", errorMessage: error?.message || String(error) },
      ));
    }),
    processExit: listen(browserProcess, "exit", (exitCode, signal) => report(
      "browser_process_exit",
      shutdownReason() ? "info" : "error",
      { exitCode, signal },
    )),
    processClose: listen(browserProcess, "close", (exitCode, signal) => report(
      "browser_process_close",
      shutdownReason() ? "info" : "error",
      { exitCode, signal },
    )),
    processError: listen(browserProcess, "error", (error) => report(
      "browser_process_error",
      "error",
      {
        errorName: error?.name || "Error",
        errorMessage: error?.message || String(error),
        ...(error?.code ? { errorCode: error.code } : {}),
      },
    )),
  };
  attachPage(page);
  if (typeof browser?.pages === "function") {
    try {
      for (const existingPage of await browser.pages()) attachPage(existingPage);
    } catch (error) {
      report("existing_page_enumeration_failed", "warn", {
        errorName: error?.name || "Error",
        errorMessage: error?.message || String(error),
      });
    }
  }
  attached.pageClose = Boolean(page && observedPages.has(page));
  attached.pageCrash = attached.pageClose;
  attached.pageError = attached.pageClose;
  attached.browserCloseCall = browserCloseMethod;
  attached.browserDisconnectCall = browserDisconnectMethod;
  logger.info("whatsapp_puppeteer_diagnostics_attached", {
    ...snapshot(),
    listeners: attached,
  });
  return { setPage: attachPage };
}

function preserveMessageMetadata(message) {
  const metadata = {};
  for (const field of MESSAGE_METADATA_FIELDS) {
    const value = message[field];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      metadata[field] = value;
    } else if (Array.isArray(value)) {
      metadata[field] = value.filter((item) => typeof item === "string");
    } else if (field === "chatId" && value && typeof value === "object") {
      metadata[field] = serializedWppId(value);
    }
  }
  metadata.originalId = serializedWppId(message.id);
  return metadata;
}

export function normalizeWppMessage(message, client) {
  const sender = serializedWppId(message.from);
  const chatId = serializedWppId(message.chatId) ||
    serializedWppId(message.chat?.id) ||
    serializedWppId(message.id?.remote) ||
    sender;
  const originalId = serializedWppId(message.id);
  const timestamp = Number.isFinite(message.timestamp) ? message.timestamp : message.t;
  const author = serializedWppId(message.author) || serializedWppId(message.participant);
  const media = mediaMetadata(message, client);
  const rawChat = message.chat && typeof message.chat === "object" ? message.chat : {};
  const chatMetadata = {
    id: chatId,
    isUser: rawChat.isUser === true,
    isGroup: rawChat.isGroup === true || message.isGroupMsg === true,
    isBroadcast: rawChat.isBroadcast === true || message.broadcast === true,
    isStatus: rawChat.isStatus === true,
    isReadOnly: rawChat.isReadOnly === true,
    kind: typeof rawChat.kind === "string" ? rawChat.kind : undefined,
  };

  return {
    from: sender,
    chatId,
    chatMetadata,
    sender,
    author,
    participant: author,
    fromMe: message.fromMe === true,
    body: typeof message.body === "string" ? message.body : "",
    id: { _serialized: originalId },
    whatsappMessageId: originalId || null,
    messageIdMissing: !originalId,
    eventUuid: randomUUID(),
    originalId: message.id,
    metadata: preserveMessageMetadata(message),
    type: message.type,
    subtype: message.subtype,
    isGroupMsg: message.isGroupMsg === true,
    isNotification: message.isNotification === true,
    isPSA: message.isPSA === true,
    broadcast: message.broadcast === true,
    hasMedia: media.hasMedia,
    mediaMetadataPresent: media.mediaMetadataPresent,
    mediaDownloadAvailable: media.downloadable,
    mediaSize: Number.isSafeInteger(message.size) && message.size > 0
      ? message.size
      : undefined,
    timestamp,
    getChat: async () => {
      const chat = await client.getChatById(chatId);
      return {
        id: { _serialized: serializedWppId(chat.id) || chatId },
        isUser: chat.isUser === true,
        isGroup: chat.isGroup === true || message.isGroupMsg === true,
        isBroadcast: chat.isBroadcast === true || message.broadcast === true,
        isStatus: chat.isStatus === true,
        isReadOnly: chat.isReadOnly === true,
        kind: chat.kind,
        sendStateTyping: () => client.startTyping(chatId, 5_000),
      };
    },
    reply: (text) => client.sendText(chatId, text),
    downloadMedia: async () => {
      if (!originalId) {
        throw new Error("Cannot download WhatsApp media without its original message ID.");
      }
      if (typeof client?.downloadMedia !== "function") {
        throw new Error("WPPConnect media download is unavailable.");
      }
      const content = await client.downloadMedia(originalId);
      const data = content.replace(/^data:[^;,]+;base64,/, "");
      return {
        filename:
          message.filename ||
          message.fileName ||
          filenameForMimeType(message.mimetype),
        mimetype: message.mimetype,
        data,
      };
    },
  };
}

export function createWhatsAppClient({
  config,
  handler,
  logger,
  outbound,
  enableUnreadRecovery = true,
  createClient = wppconnect.create,
  launchBrowser = initBrowser,
  closeLaunchedBrowser = closeBrowser,
}) {
  let client;
  let ready = false;
  let lastStatus = "not_initialized";
  let ackTrackingAvailable = false;
  let shutdownReason;
  let destroyPromise;
  let initializePromise;
  let browser;
  let page;
  let browserProcess;
  let lifecycleDiagnostics;
  let browserOwnedByAdapter = false;
  const pendingIncoming = [];
  const MAX_PENDING_INCOMING = 1000;
  let unreadRecoveryStarted = false;
  let unreadRecoveryPromise;
  const dispatch = async (message, source) => {
    try {
      const normalized = normalizeWppMessage(message, client);
      logger.info("whatsapp_message_normalized", {
        eventUuid: normalized.eventUuid,
        source,
        whatsappMessageIdPresent: Boolean(normalized.whatsappMessageId),
        messageType: normalized.type,
        hasMedia: normalized.hasMedia,
      });
      return await handler(normalized);
    } catch (error) {
      logger.error("whatsapp_message_dispatch_failed", {
        source,
        errorName: error?.name || "Error",
        errorMessage: error?.message || String(error),
        ...(error?.code ? { errorCode: error.code } : {}),
      });
      if (config?.LOG_LEVEL === "debug" && error?.stack) {
        logger.debug("whatsapp_message_dispatch_error_details", { source, stack: error.stack });
      }
      return { status: "failed" };
    }
  };
  const recoverUnreadMessages = async () => {
    if (!enableUnreadRecovery) return { status: "disabled" };
    if (!ready || !client) return { status: "not-ready" };
    if (unreadRecoveryPromise) return unreadRecoveryPromise;
    if (unreadRecoveryStarted) return { status: "already-completed" };
    unreadRecoveryStarted = true;
    unreadRecoveryPromise = (async () => {
      if (typeof client.getAllUnreadMessages !== "function") {
        logger.warn("whatsapp_unread_recovery_unavailable", {
          reason: "getAllUnreadMessages_not_supported",
        });
        return { status: "unsupported" };
      }
      try {
        const unread = await client.getAllUnreadMessages();
        const messages = Array.isArray(unread) ? unread : [];
        const limit = config.WHATSAPP_UNREAD_RECOVERY_LIMIT ?? 50;
        const selected = messages
          .slice()
          .sort((left, right) => (left?.t || 0) - (right?.t || 0))
          .slice(0, limit);
        const counts = { discovered: messages.length, selected: selected.length, processed: 0, skipped: 0, failed: 0 };
        logger.info("whatsapp_unread_recovery_started", {
          ...counts,
          limit,
        });
        for (const partial of selected) {
          if (!partial || partial.id?.fromMe === true || partial.fromMe === true) {
            counts.skipped += 1;
            continue;
          }
          const chatId = serializedWppId(partial.id?.remote) ||
            serializedWppId(partial.chatId) ||
            serializedWppId(partial.from);
          if (
            !chatId ||
            (!chatId.endsWith("@c.us") && !chatId.endsWith("@lid")) ||
            ["protocol", "notification_template", "group_notification", "notification"].includes(partial.type)
          ) {
            counts.skipped += 1;
            continue;
          }
          const outcome = await dispatch({ ...partial, chatId }, "unread-recovery");
          if (outcome?.status === "processed") counts.processed += 1;
          else if (outcome?.status === "failed") counts.failed += 1;
          else counts.skipped += 1;
        }
        logger.info("whatsapp_unread_recovery_completed", {
          ...counts,
          truncated: messages.length > selected.length,
        });
        return { status: "completed", ...counts };
      } catch (error) {
        unreadRecoveryStarted = false;
        unreadRecoveryPromise = undefined;
        logger.error("whatsapp_unread_recovery_failed", {
          errorName: error?.name || "Error",
          errorMessage: error?.message || String(error),
          ...(error?.code ? { errorCode: error.code } : {}),
        });
        return { status: "failed" };
      }
    })();
    return unreadRecoveryPromise;
  };
  const processPendingAndRecover = async () => {
    while (ready && pendingIncoming.length) {
      const message = pendingIncoming.shift();
      await dispatch(message, "queued-before-connected");
    }
    if (ready) await recoverUnreadMessages();
  };
  const destroy = async (reason = "application_shutdown") => {
    ready = false;
    shutdownReason ||= reason;
    if (!client) return;
    if (!destroyPromise) {
      const closeReason = shutdownReason;
      destroyPromise = (async () => {
        logger.info("whatsapp_client_shutdown_requested", {
          reason: closeReason,
          state: lastStatus,
        });
        await client.close();
        logger.info("whatsapp_client_destroyed", { reason: closeReason });
      })();
    }
    await destroyPromise;
  };

  return {
    get client() {
      if (!client) throw new Error("WhatsApp client is not initialized.");
      return {
        sendMessage: (id, text) => client.sendText(id, text),
        resolveRecipient: (id) => resolveLidRecipient(client, id),
      };
    },

    lookupContact: async (recipient) => {
      if (!client || typeof client.getContact !== "function") {
        throw new Error("WPPConnect contact lookup is unavailable.");
      }
      const contact = await client.getContact(recipient);
      return {
        found: serializedWppId(contact?.id) === recipient,
        isBusiness: contact?.isBusiness === true,
        isMyContact: contact?.isMyContact === true,
      };
    },
    recoverUnreadMessages,

    initialize: async () => {
      if (initializePromise) return initializePromise;
      if (client && !shutdownReason) return;
      initializePromise = (async () => {
      try {
        logger.info("whatsapp_client_configured", {
          session: SESSION_NAME,
          autoCloseMs: AUTO_CLOSE_MS,
          deviceSyncTimeoutMs: config.WHATSAPP_DEVICE_SYNC_TIMEOUT_MS ?? DEVICE_SYNC_TIMEOUT_MS,
        });
        const clientOptions = {
          session: SESSION_NAME,
          catchQR: (_base64, asciiQR) => {
            ready = false;
            logger.info("whatsapp_qr_received");
            console.log(asciiQR);
          },
          statusFind: (status, session) => {
            const previousStatus = lastStatus;
            lastStatus = status;
            const reason = status === "autocloseCalled"
              ? "wppconnect_startup_auto_close"
              : status === "browserClose" || status === "serverClose"
                ? shutdownReason
                  ? "application_shutdown"
                  : "unexpected_browser_disconnect"
                : statusReasons[status];
            logger.info("whatsapp_state_changed", {
              timestamp: new Date().toISOString(),
              status,
              session,
              ...(reason ? { reason } : {}),
                ...(status === "browserClose" || status === "serverClose"
                  ? {
                      lifecycle: browser
                        ? {
                            timestamp: new Date().toISOString(),
                            browserPid: browserProcess?.pid ?? null,
                            processExitCode: browserProcess?.exitCode ?? null,
                            processSignalCode: browserProcess?.signalCode ?? null,
                            browserConnected: browser.isConnected?.() ?? null,
                            pageClosed: page?.isClosed?.() ?? null,
                            lastWhatsAppState: previousStatus,
                            intentionalShutdown: Boolean(shutdownReason),
                            shutdownReason: shutdownReason || undefined,
                          }
                        : { diagnosticListenersAttached: false },
                    }
                  : {}),
            });
            if (status === "isLogged") {
              if (!shutdownReason) {
                ready = true;
                logger.info("whatsapp_connected");
              }
            } else if (
              status === "notLogged" ||
              status === "qrReadSuccess" ||
              status === "disconnectedMobile" ||
              status === "browserClose" ||
              status === "serverClose" ||
              status === "autocloseCalled" ||
              status === "phoneNotConnected"
            ) {
              ready = false;
            }
            if (status === "autocloseCalled") {
              logger.warn("whatsapp_auto_close_requested", {
                reason,
                previousStatus,
                autoCloseMs: AUTO_CLOSE_MS,
                deviceSyncTimeoutMs: config.WHATSAPP_DEVICE_SYNC_TIMEOUT_MS ?? DEVICE_SYNC_TIMEOUT_MS,
              });
            } else if (status === "browserClose" || status === "serverClose") {
              const log = shutdownReason ? logger.info : logger.error;
              log("whatsapp_browser_disconnected", {
                reason,
                status,
                session,
                lastState: previousStatus,
                intentional: Boolean(shutdownReason),
                shutdownReason,
              });
            }
          },
          onLoadingScreen: (percentage, message) => {
            logger.info("whatsapp_loading", { percentage, message });
          },
          headless: false,
          useChrome: true,
          waitForLogin: true,
          autoClose: AUTO_CLOSE_MS,
          deviceSyncTimeout: config.WHATSAPP_DEVICE_SYNC_TIMEOUT_MS ?? DEVICE_SYNC_TIMEOUT_MS,
          updatesLog: false,
          folderNameToken: path.join(
            process.env.LOCALAPPDATA || config.WHATSAPP_SESSION_PATH,
            "Atom",
            "wppconnect-tokens",
          ),
          puppeteerOptions: {
            executablePath: CHROME_PATH,
            userDataDir: path.join(
              process.env.LOCALAPPDATA || config.WHATSAPP_SESSION_PATH,
              PROFILE_DIRECTORY,
            ),
            timeout: 60_000,
          },
        };
        if (createClient === wppconnect.create || launchBrowser !== initBrowser) {
          const launchOptions = {
            ...defaultOptions,
            ...clientOptions,
            puppeteerOptions: {
              ...defaultOptions.puppeteerOptions,
              ...clientOptions.puppeteerOptions,
            },
          };
          browser = await launchBrowser(SESSION_NAME, launchOptions, wppconnect.defaultLogger);
          browserProcess = browser?.process?.();
          browserOwnedByAdapter = true;
          lifecycleDiagnostics = await observeLifecycle({
            browser,
            page: null,
            lastState: () => lastStatus,
            shutdownReason: () => shutdownReason,
            logger,
          });
          clientOptions.browser = browser;
        }
        client = await createClient(clientOptions);

        page = client.waPage;
        browser ||= page?.browser?.();
        browserProcess ||= browser?.process?.();
        if (lifecycleDiagnostics) {
          lifecycleDiagnostics.setPage(page);
        } else {
          lifecycleDiagnostics = await observeLifecycle({
            browser,
            page,
            lastState: () => lastStatus,
            shutdownReason: () => shutdownReason,
            logger,
          });
        }
        if (shutdownReason) {
          await destroy();
          return;
        }

        ready = await client.isConnected();
        if (ready && lastStatus === "not_initialized") {
          lastStatus = "isLogged";
        }
        client.onStateChange((state) => {
          lastStatus = state;
          const reason = terminalStateReasons[state];
          logger.info("whatsapp_state_changed", {
            timestamp: new Date().toISOString(),
            state,
            ...(reason ? { reason } : {}),
          });
          if (reason) {
            logger.warn("whatsapp_terminal_state", { state, reason });
          }
          ready = !shutdownReason && state === "CONNECTED";
          if (ready) {
            logger.info("whatsapp_connected");
            void processPendingAndRecover();
          }
          browserOwnedByAdapter = false;
        });
        if (typeof client.onAck === "function") {
          ackTrackingAvailable = true;
          client.onAck((ack) => {
            const messageId = extractAcknowledgementMessageId(ack);
            logger.info("whatsapp_ack_received", {
              ackValue: ack?.ack,
              whatsappMessageIdPresent: Boolean(messageId),
              ...(messageId
                ? { messageIdFingerprint: messageIdFingerprint(messageId) }
                : {}),
              idType: ack?.id === null ? "null" : typeof ack?.id,
              idKeys: ack?.id && typeof ack.id === "object"
                ? Object.keys(ack.id)
                : [],
              direction: typeof ack?.id?.fromMe === "boolean"
                ? ack.id.fromMe ? "from_self_account" : "from_other_account"
                : "unknown",
            });
            try {
              outbound?.handleAck(ack);
            } catch (error) {
              logger.error("whatsapp_ack_processing_failed", {
                errorName: error?.name || "Error",
                errorMessage: error?.message || String(error),
                ...(error?.code ? { errorCode: error.code } : {}),
              });
              if (config?.LOG_LEVEL === "debug" && error?.stack) {
                logger.debug("whatsapp_ack_processing_error_details", {
                  stack: error.stack,
                });
              }
            }
          });
        }
        client.onMessage(async (message) => {
          logger.info("whatsapp_message_received", {
            whatsappMessageIdPresent: Boolean(serializedWppId(message?.id)),
            messageType: typeof message?.type === "string" ? message.type : undefined,
            readiness: ready ? "ready" : "not-ready",
          });
          if (!ready) {
            if (pendingIncoming.length < MAX_PENDING_INCOMING) {
              pendingIncoming.push(message);
              logger.info("whatsapp_message_queued_before_ready", {
                queued: pendingIncoming.length,
                messageType: typeof message?.type === "string" ? message.type : undefined,
              });
            } else {
              logger.error("whatsapp_pre_ready_message_queue_full", {
                capacity: MAX_PENDING_INCOMING,
              });
            }
            return { status: "queued" };
          }
          let normalized;
          try {
            normalized = normalizeWppMessage(message, client);
          } catch (error) {
            logger.error("whatsapp_message_normalization_failed", {
              errorName: error?.name || "Error",
              errorMessage: error?.message || String(error),
            });
            return { status: "failed" };
          }
          if (config.LOG_LEVEL === "debug") {
            logger.debug("whatsapp_incoming_message_shape", {
              conversationType: normalized.chatId.endsWith("@newsletter")
                ? "newsletter"
                : normalized.chatId === "status@broadcast" ||
                    normalized.chatId.endsWith("@broadcast")
                  ? "status"
                  : normalized.chatId.endsWith("@g.us")
                    ? "group"
                    : normalized.chatId.endsWith("@c.us")
                      ? "individual"
                      : "unknown",
              eventUuid: normalized.eventUuid,
              messageIdPresent: Boolean(normalized.whatsappMessageId),
              messageType: typeof message?.type === "string" ? message.type : undefined,
              rawIsMedia: message?.isMedia === true,
              normalizedHasMedia: normalized.hasMedia,
              mediaMetadataPresent: normalized.mediaMetadataPresent,
              mediaDownloadAvailable: normalized.mediaDownloadAvailable,
              fieldShape: inspectWppMessageShape(message),
            });
          }
          logger.info("incoming_message_received", {
            eventUuid: normalized.eventUuid,
            whatsappMessageIdPresent: Boolean(normalized.whatsappMessageId),
            messageIdMissing: normalized.messageIdMissing,
              messageType: normalized.type,
              hasMedia: normalized.hasMedia,
              mediaMetadataPresent: normalized.mediaMetadataPresent,
              mediaDownloadAvailable: normalized.mediaDownloadAvailable,
              conversationId: normalized.chatId.replace(/\d(?=\d{4}@)/g, "*"),
            });
          let result;
          try {
            result = await handler(normalized);
          } catch (error) {
            logger.error("whatsapp_message_handler_error", {
              eventUuid: normalized.eventUuid,
              errorName: error?.name || "Error",
              ...(error?.code ? { errorCode: error.code } : {}),
            });
            result = { status: "failed" };
          }
          logger.info("whatsapp_message_handler_result", {
            eventUuid: normalized.eventUuid,
            status: result?.status || "completed",
          });
          return result;
        });

        if (ready) {
          logger.info("whatsapp_connected");
          void processPendingAndRecover();
        }
      } catch (error) {
        ready = false;
        if (browser && browserOwnedByAdapter) {
          logger.warn("whatsapp_startup_browser_cleanup_requested", {
            reason: "initialization_failure",
            browserPid: browserProcess?.pid ?? null,
          });
          try {
            if (client) await client.close();
            else await closeLaunchedBrowser(browser);
          } catch (cleanupError) {
            logger.error("whatsapp_startup_browser_cleanup_failed", {
              errorName: cleanupError?.name || "Error",
              errorMessage: cleanupError?.message || String(cleanupError),
            });
          }
          browserOwnedByAdapter = false;
        }
        logger.error("whatsapp_initialization_error", {
          name: error.name,
          message: error.message,
          stack: error.stack,
        });
        throw error;
      }
      })();
      try {
        await initializePromise;
      } catch (error) {
        initializePromise = undefined;
        throw error;
      }
    },

    isReady: () => ready,
    diagnostics: () => ({
      initialized: Boolean(client),
      authenticated: Boolean(client) && (lastStatus === "isLogged" || ready),
      connected: ready,
      canSend: ready && typeof client?.sendText === "function",
      acknowledgementTrackingAvailable: ackTrackingAvailable,
      state: lastStatus,
    }),

    destroy,
  };
}
