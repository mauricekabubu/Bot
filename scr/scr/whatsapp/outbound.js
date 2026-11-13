import { createHash } from 'node:crypto';

const ACK_STATUS = new Map([
  [-7, 'failed'],
  [-6, 'failed'],
  [-5, 'failed'],
  [-4, 'failed'],
  [-3, 'failed'],
  [-2, 'failed'],
  [-1, 'failed'],
  [1, 'sent'],
  [2, 'delivered'],
  [3, 'read'],
]);
const PENDING_ACK_TTL_MS = 60_000;
const MAX_PENDING_ACKS = 1000;

export function normalizeWhatsAppMessageId(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object') return null;
  if (typeof value._serialized === 'string') return value._serialized.trim() || null;
  if (typeof value.serialized === 'string') return value.serialized.trim() || null;
  return null;
}

export function extractAcknowledgementMessageId(ack) {
  return normalizeWhatsAppMessageId(ack?.id);
}

export function acknowledgementStatus(value) {
  return ACK_STATUS.get(Number(value)) || null;
}

export function messageIdFingerprint(messageId) {
  return createHash('sha256').update(messageId).digest('hex').slice(0, 12);
}

function acknowledgementShape(ack) {
  const id = ack && typeof ack === 'object' ? ack.id : undefined;
  return {
    payloadType: ack === null ? 'null' : typeof ack,
    payloadKeys: ack && typeof ack === 'object' ? Object.keys(ack) : [],
    idType: id === null ? 'null' : typeof id,
    idKeys: id && typeof id === 'object' ? Object.keys(id) : [],
    idFromMe: typeof id?.fromMe === 'boolean' ? id.fromMe : undefined,
    innerIdPresent: typeof id?.id === 'string' && id.id.length > 0,
    remotePresent: Boolean(id?.remote),
  };
}

export function normalizeRecipient(value) {
  if (typeof value !== 'string') return null;
  const identifier = value.trim();
  if (/^[A-Za-z0-9._:-]{1,128}@lid$/i.test(identifier)) return identifier;
  const digits = value.trim().replace(/[\s()+-]/g, '').replace(/@c\.us$/i, '');
  return /^\d{6,15}$/.test(digits) ? `${digits}@c.us` : null;
}

const maskedRecipient = (recipient) => {
  const match = recipient.match(/^(.+)@([^@]+)$/);
  if (!match) return '[recipient]';
  const [, local, domain] = match;
  return `${local.length > 4 ? `${'*'.repeat(local.length - 4)}${local.slice(-4)}` : '****'}@${domain}`;
};

export class OutboundMessageService {
  constructor({
    db,
    getClient,
    isReady,
    logger,
    testRecipients = '',
    pendingAckTtlMs = PENDING_ACK_TTL_MS,
  }) {
    if (!db || typeof getClient !== 'function' || typeof isReady !== 'function') {
      throw new Error('Outbound messaging requires a database and WhatsApp client accessors.');
    }
    this.db = db;
    this.getClient = getClient;
    this.isReady = isReady;
    this.logger = logger || { info() {}, warn() {}, error() {} };
    if (!Number.isInteger(pendingAckTtlMs) || pendingAckTtlMs < 1) {
      throw new Error('Pending acknowledgement TTL must be a positive integer.');
    }
    this.pendingAckTtlMs = pendingAckTtlMs;
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE outbound_messages
      SET status = 'unknown', error_message = 'PROCESS_RESTART_DURING_SEND',
          last_updated_at = ?
      WHERE status = 'sending'
    `).run(now);
    this.db.prepare(`
      UPDATE outbound_messages
      SET status = 'failed', error_message = 'PROCESS_RESTART_BEFORE_SEND',
          last_updated_at = ?
      WHERE status = 'queued'
    `).run(now);
    this.configuredTestRecipients = new Set(
      String(testRecipients).split(',').map(normalizeRecipient).filter(Boolean),
    );
    this.insert = db.prepare(`
      INSERT INTO outbound_messages (
        user_id, recipient_number, message_type, content_hash, status,
        idempotency_key, created_at, last_updated_at
      ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
    `);
    this.byIdempotencyKey = db.prepare(
      'SELECT * FROM outbound_messages WHERE idempotency_key = ?',
    );
    this.byMessageId = db.prepare(
      'SELECT id, status FROM outbound_messages WHERE message_id = ?',
    );
    this.inFlightSend = db.prepare(
      "SELECT 1 FROM outbound_messages WHERE status = 'sending' LIMIT 1",
    );
    this.updateStatus = db.prepare(`
      UPDATE outbound_messages
      SET status = ?, message_id = COALESCE(?, message_id),
          error_message = ?, sent_at = COALESCE(?, sent_at),
          delivered_at = COALESCE(?, delivered_at),
          read_at = COALESCE(?, read_at), last_updated_at = ?
      WHERE id = ?
    `);
    this.pendingAcknowledgements = new Map();
    this.pendingAcknowledgementTimers = new Map();
  }

  isApprovedTestRecipient(recipient) {
    return this.configuredTestRecipients.has(recipient) ||
      Boolean(this.db.prepare(
        'SELECT 1 FROM outbound_test_recipients WHERE recipient_number = ?',
      ).get(recipient));
  }

  approveTestRecipient(value) {
    const recipient = normalizeRecipient(value);
    if (!recipient) throw new Error('INVALID_RECIPIENT');
    this.db.prepare(`
      INSERT INTO outbound_test_recipients(recipient_number, approved_at)
      VALUES (?, ?)
      ON CONFLICT(recipient_number) DO NOTHING
    `).run(recipient, new Date().toISOString());
    return recipient;
  }

  setSuppressed(value, suppressed, reason = 'user-request') {
    const recipient = normalizeRecipient(value);
    if (!recipient) throw new Error('INVALID_RECIPIENT');
    if (suppressed) {
      this.db.prepare(`
        INSERT INTO recipient_suppressions(recipient_number, suppressed_at, reason)
        VALUES (?, ?, ?)
        ON CONFLICT(recipient_number) DO UPDATE SET
          suppressed_at = excluded.suppressed_at, reason = excluded.reason
      `).run(recipient, new Date().toISOString(), reason);
    } else {
      this.db.prepare(
        'DELETE FROM recipient_suppressions WHERE recipient_number = ?',
      ).run(recipient);
    }
  }

  isSuppressed(recipient) {
    return Boolean(this.db.prepare(
      'SELECT 1 FROM recipient_suppressions WHERE recipient_number = ?',
    ).get(recipient));
  }

  setState(id, status, { messageId = null, error = null } = {}) {
    const now = new Date().toISOString();
    const stateTime = status === 'sent' ? now : null;
    const deliveredTime = status === 'delivered' || status === 'read' ? now : null;
    const readTime = status === 'read' ? now : null;
    this.updateStatus.run(status, messageId, error, stateTime, deliveredTime, readTime, now, id);
    return this.db.prepare('SELECT * FROM outbound_messages WHERE id = ?').get(id);
  }

  async sendText(value, text, {
    messageType = 'text',
    idempotencyKey = null,
    testMode = false,
  } = {}) {
    const recipient = normalizeRecipient(value);
    if (!recipient) return { ok: false, status: 'failed', error: 'INVALID_RECIPIENT', accepted: false };
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, status: 'failed', error: 'INVALID_MESSAGE', accepted: false };
    }

    const now = new Date().toISOString();
    let recordId;
    let preSendRetryClaimed = false;
    let preSendRetryCandidate = null;
    if (idempotencyKey) {
      const existing = this.byIdempotencyKey.get(idempotencyKey);
      if (existing) {
        const retryableResolutionFailure = [
          'LID_CHAT_LOOKUP_FAILED',
          'LID_MAPPING_LOOKUP_FAILED',
        ].includes(existing.error_message);
        const retryCandidate = existing.status === 'failed' &&
          existing.attempt_count === 0 &&
          retryableResolutionFailure;
        if (!retryCandidate) {
          return {
            ok: ['sent', 'delivered', 'read'].includes(existing.status),
            duplicate: true,
            status: existing.status,
            messageId: existing.message_id,
            recordId: existing.id,
            accepted: ['sent', 'delivered', 'read'].includes(existing.status)
              ? true
              : existing.status === 'unknown'
                ? null
                : false,
          };
        }
        recordId = existing.id;
        preSendRetryCandidate = existing;
      }
    }

    if (!recordId) {
      const result = this.insert.run(
        recipient,
        recipient,
        String(messageType).slice(0, 40),
        createHash('sha256').update(text).digest('hex'),
        idempotencyKey,
        now,
        now,
      );
      recordId = Number(result.lastInsertRowid);
    }
    const rejectBeforeSend = (error, { retryable = false } = {}) => {
      if (preSendRetryCandidate && !preSendRetryClaimed) {
        this.logger.info('outbound_pre_send_retry_deferred', {
          recordId,
          reason: error,
        });
        return {
          ok: false,
          duplicate: true,
          status: preSendRetryCandidate.status,
          error: preSendRetryCandidate.error_message,
          recordId,
          accepted: false,
          retryable: true,
        };
      }
      const persistedError = preSendRetryClaimed
        ? `PRE_SEND_RETRY_EXHAUSTED:${error}`
        : error;
      const record = this.setState(recordId, 'failed', { error: persistedError });
      this.logger.warn('outbound_message_failed', {
        recordId,
        recipient: maskedRecipient(recipient),
        reason: error,
      });
      return {
        ok: false,
        status: record.status,
        error,
        recordId,
        accepted: false,
        ...(retryable && !preSendRetryClaimed ? { retryable: true } : {}),
      };
    };

    if (testMode && !this.isApprovedTestRecipient(recipient)) {
      return rejectBeforeSend('TEST_RECIPIENT_NOT_ALLOWLISTED');
    }
    if (this.isSuppressed(recipient)) return rejectBeforeSend('RECIPIENT_SUPPRESSED');
    if (!this.isReady()) return rejectBeforeSend('WHATSAPP_DISCONNECTED');

    let client;
    try {
      client = this.getClient();
    } catch {
      return rejectBeforeSend('WHATSAPP_DISCONNECTED');
    }
    if (!client || typeof client.sendMessage !== 'function') {
      return rejectBeforeSend('WHATSAPP_SEND_UNAVAILABLE');
    }

    if (preSendRetryCandidate) {
      const retryClaim = this.db.prepare(`
        UPDATE outbound_messages
        SET status = 'queued', error_message = 'PRE_SEND_RETRY_CLAIMED',
            last_updated_at = ?
        WHERE id = ? AND status = 'failed' AND attempt_count = 0
          AND error_message = ?
      `).run(now, recordId, preSendRetryCandidate.error_message);
      if (retryClaim.changes !== 1) {
        const current = this.db.prepare(
          'SELECT * FROM outbound_messages WHERE id = ?',
        ).get(recordId);
        return {
          ok: ['sent', 'delivered', 'read'].includes(current.status),
          duplicate: true,
          status: current.status,
          messageId: current.message_id,
          recordId,
          accepted: ['sent', 'delivered', 'read'].includes(current.status)
            ? true
            : current.status === 'unknown'
              ? null
              : false,
        };
      }
      preSendRetryClaimed = true;
      this.logger.info('outbound_pre_send_retry_claimed', {
        recordId,
        reason: preSendRetryCandidate.error_message,
        attemptCount: preSendRetryCandidate.attempt_count,
      });
    }

    let sendRecipient = recipient;
    if (recipient.endsWith('@lid')) {
      if (typeof client.resolveRecipient !== 'function') {
        return rejectBeforeSend('LID_RESOLUTION_UNAVAILABLE');
      }
      try {
        sendRecipient = normalizeRecipient(await client.resolveRecipient(recipient));
        const verifiedLidMapping = recipient.endsWith('@lid') &&
          sendRecipient?.endsWith('@c.us');
        if (!verifiedLidMapping) {
          return rejectBeforeSend('LID_RECIPIENT_UNRESOLVED');
        }
        this.logger.info('outbound_lid_recipient_resolved', {
          recordId,
          originalRecipient: maskedRecipient(recipient),
          destination: maskedRecipient(sendRecipient),
          destinationType: 'verified_phone_number_mapping',
        });
      } catch (error) {
        const errorCode = error?.code || 'LID_RECIPIENT_UNRESOLVED';
        this.logger.warn('outbound_lid_recipient_resolution_failed', {
          recordId,
          recipient: maskedRecipient(recipient),
          errorName: error?.name || 'Error',
          errorCode,
        });
        return rejectBeforeSend(errorCode, {
          retryable: ['LID_CHAT_LOOKUP_FAILED', 'LID_MAPPING_LOOKUP_FAILED']
            .includes(errorCode),
        });
      }
    }

    this.db.prepare(`
      UPDATE outbound_messages
      SET status = 'sending', attempt_count = attempt_count + 1, last_updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), recordId);
    this.logger.info('outbound_message_sending_started', {
      recordId,
      recipient: maskedRecipient(recipient),
      destination: maskedRecipient(sendRecipient),
      messageType,
      correlationRecordPersisted: true,
    });

    let response;
    try {
      response = await client.sendMessage(sendRecipient, text);
    } catch (error) {
      const status = 'unknown';
      const recipientDigits = recipient.slice(0, recipient.indexOf('@'));
      const redact = (value) => String(value || '')
        .replaceAll(recipient, '[recipient]')
        .replaceAll(recipientDigits, '[recipient]')
        .replaceAll(text, '[message]')
        .slice(0, 1000);
      this.setState(recordId, status, {
        error: `SEND_RESULT_UNCERTAIN:${error?.code || error?.name || 'Error'}`,
      });
      this.logger.error('outbound_message_failed', {
        recordId,
        recipient: maskedRecipient(recipient),
        destination: maskedRecipient(sendRecipient),
        reason: 'SEND_RESULT_UNCERTAIN',
        errorName: error?.name || 'Error',
        errorMessage: redact(error?.message),
        ...(error?.code ? { errorCode: String(error.code).slice(0, 100) } : {}),
      });
      if (error?.stack) {
        this.logger.debug?.('outbound_message_error_details', {
          recordId,
          stack: redact(error.stack),
        });
      }
      return {
        ok: false,
        status,
        error: 'SEND_RESULT_UNCERTAIN',
        recordId,
        accepted: null,
      };
    }

    const messageId = normalizeWhatsAppMessageId(response?.id);
    this.setState(recordId, 'sent', { messageId });
    if (messageId) {
      this.logger.info('outbound_message_id_persisted', {
        recordId,
        messageIdFingerprint: messageIdFingerprint(messageId),
      });
      this.reconcilePendingAcknowledgements(messageId);
    }
    else {
      this.logger.warn('whatsapp_outbound_message_id_missing', {
        recordId,
        recipient: maskedRecipient(recipient),
      });
    }
    const record = this.db.prepare(
      'SELECT * FROM outbound_messages WHERE id = ?',
    ).get(recordId);
    this.logger.info('whatsapp_accepted_outbound_message', {
      recordId,
      recipient: maskedRecipient(recipient),
      destination: maskedRecipient(sendRecipient),
      whatsappMessageIdPresent: Boolean(messageId),
      ...(messageId ? { messageIdFingerprint: messageIdFingerprint(messageId) } : {}),
    });
    return { ok: true, status: record.status, messageId, recordId, accepted: true };
  }

  handleAck(ack) {
    const messageId = extractAcknowledgementMessageId(ack);
    if (!messageId) {
      this.logger.warn('whatsapp_ack_ignored', {
        reason: 'missing_message_id',
        ackValue: ack?.ack,
        ...acknowledgementShape(ack),
      });
      return false;
    }
    const matches = this.byMessageId.all(messageId);
    if (matches.length > 1) {
      this.logger.error('whatsapp_ack_ambiguous_message_id', {
        matchCount: matches.length,
        ackValue: ack?.ack,
        messageIdFingerprint: messageIdFingerprint(messageId),
      });
      return false;
    }
    const message = matches[0];
    if (!message) {
      const ackValue = Number(ack.ack);
      if (acknowledgementStatus(ackValue) && this.inFlightSend.get()) {
        const duplicate = this.rememberPendingAcknowledgement(messageId, ackValue);
        this.logger.info('whatsapp_ack_pending_correlation', {
          reason: 'outbound_send_in_flight',
          ackValue,
          duplicate,
          messageIdFingerprint: messageIdFingerprint(messageId),
        });
        return false;
      }
      this.logger.warn('whatsapp_ack_unmatched', {
        reason: acknowledgementStatus(ackValue)
          ? 'no_matching_outbound_message'
          : 'unsupported_ack_value',
        ackValue: ack?.ack,
        pendingCorrelation: false,
        messageIdFingerprint: messageIdFingerprint(messageId),
        ...acknowledgementShape(ack),
      });
      return false;
    }
    return this.applyAcknowledgement(message, messageId, ack.ack);
  }

  rememberPendingAcknowledgement(messageId, ackValue) {
    if (!this.pendingAcknowledgements.has(messageId)) {
      this.pendingAcknowledgements.set(messageId, []);
    }
    const pending = this.pendingAcknowledgements.get(messageId);
    const duplicate = pending.find((entry) => entry.ackValue === ackValue);
    if (duplicate) {
      this.logger.debug?.('whatsapp_ack_pending_duplicate', {
        ackValue,
        messageIdFingerprint: messageIdFingerprint(messageId),
      });
      return true;
    } else {
      pending.push({ ackValue, receivedAt: Date.now() });
    }
    if (pending.length > 5) pending.shift();
    while (this.pendingAcknowledgements.size > MAX_PENDING_ACKS) {
      const oldest = this.pendingAcknowledgements.keys().next().value;
      this.pendingAcknowledgements.delete(oldest);
      this.clearPendingAcknowledgementTimer(oldest);
      this.logger.warn('whatsapp_ack_pending_evicted', {
        reason: 'buffer_capacity',
        messageIdFingerprint: messageIdFingerprint(oldest),
      });
    }
    this.schedulePendingAcknowledgementCleanup(messageId);
    return false;
  }

  clearPendingAcknowledgementTimer(messageId) {
    const timer = this.pendingAcknowledgementTimers.get(messageId);
    if (timer) clearTimeout(timer);
    this.pendingAcknowledgementTimers.delete(messageId);
  }

  schedulePendingAcknowledgementCleanup(messageId) {
    this.clearPendingAcknowledgementTimer(messageId);
    const entries = this.pendingAcknowledgements.get(messageId);
    if (!entries?.length) return;
    const expiresAt = Math.min(...entries.map((entry) => entry.receivedAt + this.pendingAckTtlMs));
    const timer = setTimeout(() => {
      this.pendingAcknowledgementTimers.delete(messageId);
      const now = Date.now();
      const current = this.pendingAcknowledgements.get(messageId) || [];
      const fresh = current.filter((entry) => now - entry.receivedAt < this.pendingAckTtlMs);
      const expiredCount = current.length - fresh.length;
      if (fresh.length) this.pendingAcknowledgements.set(messageId, fresh);
      else this.pendingAcknowledgements.delete(messageId);
      if (expiredCount) {
        this.logger.warn('whatsapp_ack_pending_expired', {
          messageIdFingerprint: messageIdFingerprint(messageId),
          ackCount: expiredCount,
        });
      }
      if (fresh.length) this.schedulePendingAcknowledgementCleanup(messageId);
    }, Math.max(1, expiresAt - Date.now()));
    timer.unref?.();
    this.pendingAcknowledgementTimers.set(messageId, timer);
  }

  reconcilePendingAcknowledgements(messageId) {
    const entries = this.pendingAcknowledgements.get(messageId);
    if (!entries) return;
    this.pendingAcknowledgements.delete(messageId);
    this.clearPendingAcknowledgementTimer(messageId);
    const matches = this.byMessageId.all(messageId);
    if (matches.length > 1) {
      this.logger.error('whatsapp_ack_ambiguous_message_id', {
        matchCount: matches.length,
        pendingAckCount: entries.length,
        messageIdFingerprint: messageIdFingerprint(messageId),
      });
      return;
    }
    for (const { ackValue } of entries) {
      const message = matches[0];
      if (message) this.applyAcknowledgement(message, messageId, ackValue);
    }
  }

  applyAcknowledgement(message, messageId, ackValue) {
    const nextStatus = acknowledgementStatus(ackValue);
    if (!nextStatus) {
      this.logger.warn('whatsapp_ack_ignored', {
        reason: 'unsupported_ack_value',
        recordId: message.id,
        ackValue,
      });
      return false;
    }
    const rank = { queued: 0, sending: 0, sent: 1, delivered: 2, read: 3, failed: 0, unknown: 0 };
    if (
      (nextStatus === 'failed' && ['sent', 'delivered', 'read'].includes(message.status)) ||
      (nextStatus !== 'failed' && rank[message.status] >= rank[nextStatus])
    ) {
      this.logger.info('whatsapp_ack_correlated_without_transition', {
        recordId: message.id,
        messageIdFingerprint: messageIdFingerprint(messageId),
        currentStatus: message.status,
        incomingStatus: nextStatus,
      });
      return true;
    }
    const record = this.setState(message.id, nextStatus, {
      messageId,
      error: nextStatus === 'failed' ? 'WHATSAPP_ACK_FAILED' : null,
    });
    this.logger.info(nextStatus === 'read'
      ? 'whatsapp_message_read_acknowledged'
      : nextStatus === 'delivered'
        ? 'whatsapp_message_delivery_acknowledged'
        : 'whatsapp_message_acknowledged', {
      recordId: message.id,
      messageIdFingerprint: messageIdFingerprint(messageId),
      status: record.status,
    });
    return true;
  }

  async waitForAcknowledgement(recordId, timeoutMs = 15_000) {
    if (!Number.isInteger(recordId) || recordId < 1 ||
        !Number.isInteger(timeoutMs) || timeoutMs < 0) {
      throw new Error('Invalid outbound acknowledgement wait parameters.');
    }
    const readStatus = () => this.db.prepare(
      'SELECT status FROM outbound_messages WHERE id = ?',
    ).get(recordId)?.status || null;
    const deadline = Date.now() + timeoutMs;
    let status = readStatus();
    while (status && !['delivered', 'read', 'failed'].includes(status) &&
        Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())));
      status = readStatus();
    }
    return {
      status,
      acknowledged: ['delivered', 'read'].includes(status),
      timedOut: Boolean(status && !['delivered', 'read', 'failed'].includes(status)),
    };
  }

  getReport() {
    const totals = this.db.prepare(`
      SELECT COUNT(*) AS attempted,
        SUM(status IN ('sent','delivered','read')) AS accepted,
        SUM(status = 'delivered') AS delivered,
        SUM(status = 'read') AS read,
        SUM(status = 'failed') AS failed,
        SUM(status = 'unknown') AS unknown
      FROM outbound_messages
      WHERE status != 'queued'
    `).get();
    const attempted = Number(totals.attempted || 0);
    const recentFailures = this.db.prepare(`
      SELECT id, recipient_number, status, error_message, created_at
      FROM outbound_messages WHERE status IN ('failed','unknown')
      ORDER BY id DESC LIMIT 10
    `).all();
    const lastSuccessful = this.db.prepare(`
      SELECT id, recipient_number, message_id, status, sent_at
      FROM outbound_messages WHERE status IN ('sent','delivered','read')
      ORDER BY id DESC LIMIT 1
    `).get() || null;
    const lastFailed = recentFailures.find((entry) => entry.status === 'failed') || null;
    return {
      attempted,
      accepted: Number(totals.accepted || 0),
      delivered: Number(totals.delivered || 0),
      read: Number(totals.read || 0),
      failed: Number(totals.failed || 0),
      unknown: Number(totals.unknown || 0),
      deliverySuccessRate: attempted
        ? Number((((totals.delivered || 0) + (totals.read || 0)) * 100 / attempted).toFixed(1))
        : 0,
      recentFailures,
      lastSuccessful,
      lastFailed,
    };
  }
}
