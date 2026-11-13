export class InboundMessageStore {
  constructor(db) {
    if (!db) throw new Error('Database connection is required.');
    this.db = db;
    db.prepare(`
      UPDATE inbound_message_events
      SET status = 'failed', last_error = 'PROCESS_RESTART_DURING_MESSAGE',
          completed_at = NULL
      WHERE status = 'processing'
    `).run();
    this.find = db.prepare(`
      SELECT id, status FROM inbound_message_events
      WHERE chat_id = ? AND whatsapp_message_id = ?
    `);
    this.insert = db.prepare(`
      INSERT INTO inbound_message_events (
        event_uuid, chat_id, whatsapp_message_id, status, started_at
      ) VALUES (?, ?, ?, 'processing', ?)
      ON CONFLICT(chat_id, whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL
      DO NOTHING
    `);
    this.retry = db.prepare(`
      UPDATE inbound_message_events
      SET event_uuid = ?, status = 'processing', attempts = attempts + 1,
          last_error = NULL, started_at = ?, completed_at = NULL
      WHERE id = ? AND status = 'failed'
    `);
    this.finish = db.prepare(`
      UPDATE inbound_message_events
      SET status = 'completed', last_error = NULL, completed_at = ?
      WHERE chat_id = ? AND whatsapp_message_id = ? AND status = 'processing'
    `);
    this.failRecord = db.prepare(`
      UPDATE inbound_message_events
      SET status = 'failed', last_error = ?
      WHERE chat_id = ? AND whatsapp_message_id = ? AND status = 'processing'
    `);
    this.claimTransaction = db.transaction(({ eventUuid, chatId, messageId }) => {
      if (!messageId) return { claimed: true, persistent: false };
      const current = this.find.get(chatId, messageId);
      if (current?.status === 'completed') return { claimed: false, reason: 'already-completed' };
      if (current?.status === 'processing') return { claimed: false, reason: 'already-processing' };
      const now = new Date().toISOString();
      if (current) {
        this.retry.run(eventUuid, now, current.id);
        return { claimed: true, persistent: true, retry: true };
      }
      this.insert.run(eventUuid, chatId, messageId, now);
      const inserted = this.find.get(chatId, messageId);
      return inserted?.status === 'processing'
        ? { claimed: true, persistent: true }
        : { claimed: false, reason: 'already-processing' };
    });
  }

  claim(message) {
    return this.claimTransaction({
      eventUuid: message.eventUuid,
      chatId: message.chatId,
      messageId: message.whatsappMessageId,
    });
  }

  complete(message) {
    if (!message.whatsappMessageId) return;
    this.finish.run(
      new Date().toISOString(),
      message.chatId,
      message.whatsappMessageId,
    );
  }

  fail(message, error) {
    if (!message.whatsappMessageId) return;
    const code = error?.code || error?.name || 'MESSAGE_PROCESSING_FAILED';
    this.failRecord.run(String(code).slice(0, 100), message.chatId, message.whatsappMessageId);
  }
}
