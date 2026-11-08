
export class ConversationMemory {
  constructor(db, limit = 16) {
    if (!db) throw new Error("Database connection is required.");

    this.db = db;
    this.limit = limit;

    this.insertMessage = db.prepare(`
      INSERT INTO messages
      (user_id, role, content, created_at)
      VALUES (?, ?, ?, ?)
    `);

    this.getRecentMessages = db.prepare(`
      SELECT role, content, created_at
      FROM (
        SELECT id, role, content, created_at
        FROM messages
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT ?
      )
      ORDER BY id ASC
    `);

    this.deleteMessages = db.prepare(`
      DELETE FROM messages WHERE user_id = ?
    `);

    this.countMessages = db.prepare(`
      SELECT COUNT(*) AS total
      FROM messages
      WHERE user_id = ?
    `);
  }

  add(userId, role, content) {
    if (!userId || typeof userId !== "string") {
      throw new Error("Invalid user ID.");
    }

    if (!["user", "model"].includes(role)) {
      throw new Error("Invalid message role.");
    }

    if (typeof content !== "string" || !content.trim()) {
      throw new Error("Message content cannot be empty.");
    }

    this.insertMessage.run(
      userId,
      role,
      content.trim(),
      new Date().toISOString()
    );
  }

  recent(userId) {
    if (!userId) throw new Error("User ID is required.");

    return this.getRecentMessages.all(userId, this.limit);
  }

  clear(userId) {
    if (!userId) throw new Error("User ID is required.");

    return this.deleteMessages.run(userId);
  }

  count(userId) {
    if (!userId) throw new Error("User ID is required.");

    return this.countMessages.get(userId).total;
  }
}
