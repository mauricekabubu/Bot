import { randomUUID } from "node:crypto";

function extractWhatsAppMessageId(message) {
  const value = message?.whatsappMessageId ?? message?.id;
  if (typeof value === "string") return value || null;
  if (value && typeof value === "object") {
    if (typeof value._serialized === "string") return value._serialized || null;
    if (typeof value.serialized === "string") return value.serialized || null;
  }
  return null;
}

export class NewsletterStore {
  constructor(db) {
    if (!db) throw new Error("Database connection is required.");
    this.insertUpdate = db.prepare(`
      INSERT INTO newsletter_updates (
        event_uuid, whatsapp_message_id, missing_whatsapp_message_id,
        channel_id, author_id, message_type, body, timestamp,
        metadata_json, received_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `);
    this.findByWhatsAppId = db.prepare(`
      SELECT event_uuid FROM newsletter_updates
      WHERE channel_id = ? AND whatsapp_message_id = ?
    `);
    this.findByEventUuid = db.prepare(`
      SELECT event_uuid FROM newsletter_updates WHERE event_uuid = ?
    `);
  }

  record(message) {
    if (
      typeof message?.chatId !== "string" ||
      !message.chatId.endsWith("@newsletter")
    ) {
      throw new Error("Invalid newsletter channel ID.");
    }

    const whatsappMessageId = extractWhatsAppMessageId(message);
    const eventUuid = typeof message.eventUuid === "string" && message.eventUuid
      ? message.eventUuid
      : randomUUID();
    const result = this.insertUpdate.run(
      eventUuid,
      whatsappMessageId,
      whatsappMessageId ? 0 : 1,
      message.chatId,
      message.author || message.participant || "",
      typeof message.type === "string" ? message.type : "",
      typeof message.body === "string" ? message.body : "",
      Number.isFinite(message.timestamp) ? message.timestamp : null,
      JSON.stringify(message.metadata || {}),
      new Date().toISOString(),
    );

    const existing = result.changes === 0
      ? (whatsappMessageId
        ? this.findByWhatsAppId.get(message.chatId, whatsappMessageId)
        : null) || this.findByEventUuid.get(eventUuid)
      : null;
    return {
      eventUuid: existing?.event_uuid || eventUuid,
      whatsappMessageId,
      missingWhatsAppMessageId: !whatsappMessageId,
      inserted: result.changes === 1,
      duplicate: Boolean(existing),
    };
  }
}
