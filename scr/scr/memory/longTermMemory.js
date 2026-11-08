
const ALLOWED_KINDS = new Set([
  "preference",
  "personal_fact",
  "goal",
  "project",
  "instruction",
]);

export class LongTermMemory {
  constructor(db) {
    this.db = db;

    this.insertStatement = db.prepare(`
      INSERT INTO memories (user_id, fact, kind, created_at)
      VALUES (?, ?, ?, ?)
    `);

    this.listStatement = db.prepare(`
      SELECT id, fact, kind, created_at
      FROM memories
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT ?
    `);

    this.findDuplicate = db.prepare(`
      SELECT id FROM memories
      WHERE user_id = ? AND kind = ? AND lower(trim(fact)) = lower(trim(?))
      LIMIT 1
    `);

    this.clearStatement = db.prepare(`
      DELETE FROM memories WHERE user_id = ?
    `);

    this.deleteStatement = db.prepare(`
      DELETE FROM memories WHERE user_id = ? AND id = ?
    `);
  }

  add(userId, fact, kind = "preference") {
    if (typeof userId !== "string" || !userId.trim()) {
      throw new Error("INVALID_MEMORY_USER");
    }

    if (typeof fact !== "string" || !fact.trim()) {
      throw new Error("INVALID_MEMORY_FACT");
    }

    if (!ALLOWED_KINDS.has(kind)) {
      throw new Error("INVALID_MEMORY_KIND");
    }

    const cleanFact = fact.trim().slice(0, 500);
    if (/\b(password|passcode|api[\s_-]?key|token|secret|credential)\b/i.test(cleanFact)) {
      throw new Error("SENSITIVE_MEMORY_REJECTED");
    }
    if (this.findDuplicate.get(userId, kind, cleanFact)) return false;

    this.insertStatement.run(
      userId,
      cleanFact,
      kind,
      new Date().toISOString()
    );
    return true;
  }

  list(userId, limit = 8) {
    if (typeof userId !== "string" || !userId.trim()) {
      throw new Error("INVALID_MEMORY_USER");
    }

    const safeLimit = Math.max(
      1,
      Math.min(Number.isInteger(limit) ? limit : 8, 50)
    );

    return this.listStatement.all(userId, safeLimit);
  }

  clear(userId) {
    if (typeof userId !== "string" || !userId.trim()) {
      throw new Error("INVALID_MEMORY_USER");
    }

    return this.clearStatement.run(userId).changes;
  }

  delete(userId, id) {
    if (typeof userId !== "string" || !userId.trim()) {
      throw new Error("INVALID_MEMORY_USER");
    }
    if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) {
      throw new Error("INVALID_MEMORY_ID");
    }
    return this.deleteStatement.run(userId, Number(id)).changes;
  }
}
