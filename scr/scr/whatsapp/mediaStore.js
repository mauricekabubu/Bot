import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const EXTENSIONS = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['video/mp4', '.mp4'],
  ['video/3gpp', '.3gp'],
  ['audio/aac', '.aac'],
  ['audio/mpeg', '.mp3'],
  ['audio/ogg', '.ogg'],
  ['audio/opus', '.opus'],
  ['audio/wav', '.wav'],
  ['application/pdf', '.pdf'],
  ['text/plain', '.txt'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
]);

function decodeBase64(value, maxBytes) {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > Math.ceil(maxBytes / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw Object.assign(new Error('Invalid or oversized media data.'), {
      code: 'INVALID_OR_OVERSIZED_MEDIA',
    });
  }
  const buffer = Buffer.from(value, 'base64');
  if (
    !buffer.length ||
    buffer.length > maxBytes ||
    buffer.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')
  ) {
    throw Object.assign(new Error('Invalid or oversized media data.'), {
      code: 'INVALID_OR_OVERSIZED_MEDIA',
    });
  }
  return buffer;
}

function safeFailureCode(error) {
  const code = error?.code || error?.name || 'MEDIA_DOWNLOAD_FAILED';
  return String(code).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100);
}

export class IncomingMediaStore {
  constructor({ db, directory, maxFileBytes, maxTotalBytes, logger }) {
    if (!db || !directory || !Number.isInteger(maxFileBytes) || maxFileBytes < 1 ||
        !Number.isInteger(maxTotalBytes) || maxTotalBytes < maxFileBytes) {
      throw new Error('Incoming media storage requires a database, directory, and valid size limits.');
    }
    this.db = db;
    this.directory = path.resolve(directory);
    this.maxFileBytes = maxFileBytes;
    this.maxTotalBytes = maxTotalBytes;
    this.logger = logger || { info() {}, warn() {}, error() {} };
    this.db.prepare(`
      UPDATE incoming_media
      SET status = 'failed', failure_code = 'PROCESS_RESTART_DURING_DOWNLOAD',
          reserved_bytes = 0, updated_at = ?
      WHERE status = 'downloading'
    `).run(new Date().toISOString());
    this.findByMessage = db.prepare(`
      SELECT event_uuid, status, file_path, size_bytes, failure_code
      FROM incoming_media
      WHERE chat_id = ? AND whatsapp_message_id = ?
    `);
    this.findByEventUuid = db.prepare(`
      SELECT event_uuid, status, file_path, size_bytes, failure_code
      FROM incoming_media WHERE event_uuid = ?
    `);
    this.reserveTransaction = db.transaction((message) => {
      const existing = (message.whatsappMessageId
        ? this.findByMessage.get(message.chatId, message.whatsappMessageId)
        : null) || this.findByEventUuid.get(message.eventUuid);
      if (existing) return { existing };

      const now = new Date().toISOString();
      const total = Number(db.prepare(`
        SELECT COALESCE(SUM(size_bytes + reserved_bytes), 0) AS bytes
        FROM incoming_media WHERE status IN ('downloading', 'downloaded')
      `).get().bytes);
      const size = maxFileBytes;
      if (total + size > maxTotalBytes) {
        db.prepare(`
          INSERT INTO incoming_media (
            event_uuid, whatsapp_message_id, chat_id, status,
            failure_code, created_at, updated_at
          ) VALUES (?, ?, ?, 'skipped', 'MEDIA_STORAGE_QUOTA_EXCEEDED', ?, ?)
        `).run(message.eventUuid, message.whatsappMessageId, message.chatId, now, now);
        return { skipped: 'MEDIA_STORAGE_QUOTA_EXCEEDED' };
      }

      db.prepare(`
        INSERT INTO incoming_media (
          event_uuid, whatsapp_message_id, chat_id, status, reserved_bytes,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'downloading', ?, ?, ?)
      `).run(message.eventUuid, message.whatsappMessageId, message.chatId, size, now, now);
      return { reserved: true };
    });
    this.completeTransaction = db.transaction((filePath, mimetype, sizeBytes, sha256, eventUuid) => {
      const reservation = db.prepare(`
        SELECT reserved_bytes FROM incoming_media
        WHERE event_uuid = ? AND status = 'downloading'
      `).get(eventUuid);
      if (!reservation) return false;
      const total = Number(db.prepare(`
        SELECT COALESCE(SUM(size_bytes + reserved_bytes), 0) AS bytes
        FROM incoming_media WHERE status IN ('downloading', 'downloaded')
      `).get().bytes);
      if (total - reservation.reserved_bytes + sizeBytes > maxTotalBytes) {
        return false;
      }
      return this.complete.run(
        filePath,
        mimetype,
        sizeBytes,
        sha256,
        new Date().toISOString(),
        eventUuid,
      ).changes === 1;
    });
    this.complete = db.prepare(`
      UPDATE incoming_media
      SET status = 'downloaded', file_path = ?, mimetype = ?, size_bytes = ?,
          reserved_bytes = 0, sha256 = ?, failure_code = NULL, updated_at = ?
      WHERE event_uuid = ? AND status = 'downloading'
    `);
    this.fail = db.prepare(`
      UPDATE incoming_media
      SET status = ?, failure_code = ?, reserved_bytes = 0, updated_at = ?
      WHERE event_uuid = ? AND status IN ('downloading', 'skipped')
    `);
  }

  async download(message) {
    const eventUuid = typeof message?.eventUuid === 'string' && message.eventUuid
      ? message.eventUuid
      : crypto.randomUUID();
    const normalized = {
      eventUuid,
      chatId: typeof message?.chatId === 'string' ? message.chatId : '',
      whatsappMessageId: typeof message?.whatsappMessageId === 'string'
        ? message.whatsappMessageId
        : null,
    };
    if (!normalized.whatsappMessageId) {
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO incoming_media (
          event_uuid, whatsapp_message_id, chat_id, status,
          failure_code, created_at, updated_at
        ) VALUES (?, NULL, ?, 'skipped', 'MISSING_WHATSAPP_MESSAGE_ID', ?, ?)
        ON CONFLICT(event_uuid) DO NOTHING
      `).run(eventUuid, normalized.chatId, now, now);
      return { eventUuid, status: 'skipped', reason: 'MISSING_WHATSAPP_MESSAGE_ID' };
    }
    const recordSkipped = (failureCode) => {
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO incoming_media (
          event_uuid, whatsapp_message_id, chat_id, status,
          failure_code, created_at, updated_at
        ) VALUES (?, ?, ?, 'skipped', ?, ?, ?)
        ON CONFLICT DO NOTHING
      `).run(eventUuid, normalized.whatsappMessageId, normalized.chatId, failureCode, now, now);
      return { eventUuid, status: 'skipped', reason: failureCode };
    };
    if (message?.mediaDownloadAvailable !== true ||
        typeof message?.downloadMedia !== 'function') {
      return recordSkipped('MEDIA_DOWNLOAD_UNAVAILABLE');
    }
    const estimatedBytes = Number.isSafeInteger(message.mediaSize) && message.mediaSize > 0
      ? message.mediaSize
      : 0;
    if (estimatedBytes > this.maxFileBytes) {
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO incoming_media (
          event_uuid, whatsapp_message_id, chat_id, status, failure_code, created_at, updated_at
        ) VALUES (?, ?, ?, 'skipped', 'MEDIA_FILE_SIZE_LIMIT_EXCEEDED', ?, ?)
        ON CONFLICT DO NOTHING
      `).run(eventUuid, normalized.whatsappMessageId, normalized.chatId, now, now);
      return { eventUuid, status: 'skipped', reason: 'MEDIA_FILE_SIZE_LIMIT_EXCEEDED' };
    }

    const reservation = this.reserveTransaction(normalized);
    if (reservation.existing) {
      return {
        eventUuid: reservation.existing.event_uuid,
        status: reservation.existing.status,
        filePath: reservation.existing.file_path || undefined,
        duplicate: true,
        failureCode: reservation.existing.failure_code || undefined,
      };
    }
    if (reservation.skipped) {
      return { eventUuid, status: 'skipped', reason: reservation.skipped };
    }

    let filePath;
    try {
      this.logger.info('whatsapp_media_download_attempted', {
        eventUuid,
        whatsappMessageIdPresent: true,
        mediaType: message.type,
        mimetype: typeof message.mimetype === 'string' ? message.mimetype : undefined,
      });
      const downloaded = await message.downloadMedia();
      const buffer = Buffer.isBuffer(downloaded?.buffer)
        ? downloaded.buffer
        : decodeBase64(downloaded?.data, this.maxFileBytes);
      if (buffer.length > this.maxFileBytes) {
        throw Object.assign(new Error('Media exceeds the configured file size limit.'), {
          code: 'MEDIA_FILE_SIZE_LIMIT_EXCEEDED',
        });
      }
      const mimetype = typeof downloaded?.mimetype === 'string'
        ? downloaded.mimetype.slice(0, 120)
        : 'application/octet-stream';
      const baseMimeType = mimetype.split(';', 1)[0].trim().toLowerCase();
      const extension = EXTENSIONS.get(baseMimeType) || '.bin';
      await fs.mkdir(this.directory, { recursive: true });
      filePath = path.join(this.directory, `${crypto.randomUUID()}${extension}`);
      await fs.writeFile(filePath, buffer, { flag: 'wx', mode: 0o600 });
      const saved = this.completeTransaction(
        filePath,
        mimetype,
        buffer.length,
        crypto.createHash('sha256').update(buffer).digest('hex'),
        eventUuid,
      );
      if (!saved) {
        throw Object.assign(new Error('Media download reservation was lost.'), {
          code: 'MEDIA_STORAGE_QUOTA_EXCEEDED',
        });
      }
      this.logger.info('whatsapp_media_download_succeeded', {
        eventUuid,
        whatsappMessageIdPresent: true,
        mediaType: message.type,
        mimetype,
        sizeBytes: buffer.length,
      });
      return {
        eventUuid,
        status: 'downloaded',
        filePath,
        mimetype,
        sizeBytes: buffer.length,
        duplicate: false,
      };
    } catch (error) {
      if (filePath) await fs.rm(filePath, { force: true });
      const failureCode = safeFailureCode(error);
      this.fail.run('failed', failureCode, new Date().toISOString(), eventUuid);
      this.logger.warn('whatsapp_media_download_failed', {
        eventUuid,
        whatsappMessageIdPresent: true,
        mediaType: message.type,
        failureCode,
        errorName: error?.name || 'Error',
      });
      return { eventUuid, status: 'failed', reason: failureCode };
    }
  }
}
