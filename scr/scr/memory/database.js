import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function addColumnIfMissing(db, table, column, definition) {
  if (!columns(db, table).has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

const migrations = [
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY,
        user_id TEXT NOT NULL,
        fact TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY,
        user_id TEXT NOT NULL,
        text TEXT NOT NULL,
        due_at TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        notified INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);
    addColumnIfMissing(db, 'reminders', 'delivery_attempts', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'reminders', 'last_error', 'TEXT');
    db.exec(`
      CREATE INDEX IF NOT EXISTS messages_user_recent
        ON messages(user_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS memories_user_desc
        ON memories(user_id, id DESC);
      CREATE INDEX IF NOT EXISTS reminders_due
        ON reminders(completed, notified, due_at);
    `);
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS outbound_messages (
        id INTEGER PRIMARY KEY,
        user_id TEXT NOT NULL,
        recipient_number TEXT NOT NULL,
        recipient_name TEXT,
        message_id TEXT,
        message_type TEXT NOT NULL,
        message_preview TEXT,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'unknown'
        )),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL,
        sent_at TEXT,
        delivered_at TEXT,
        read_at TEXT,
        last_updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbound_test_recipients (
        recipient_number TEXT PRIMARY KEY,
        approved_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recipient_suppressions (
        recipient_number TEXT PRIMARY KEY,
        suppressed_at TEXT NOT NULL,
        reason TEXT NOT NULL
      );
    `);
  },
  (db) => {
    db.exec(`
      CREATE INDEX IF NOT EXISTS messages_user_recent
        ON messages(user_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS memories_user_desc
        ON memories(user_id, id DESC);
      CREATE INDEX IF NOT EXISTS outbound_status_created
        ON outbound_messages(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS outbound_recipient_created
        ON outbound_messages(recipient_number, created_at DESC);
      CREATE INDEX IF NOT EXISTS outbound_message_id
        ON outbound_messages(message_id);
    `);
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS newsletter_updates (
        id INTEGER PRIMARY KEY,
        message_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        author_id TEXT NOT NULL DEFAULT '',
        message_type TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        timestamp INTEGER,
        metadata_json TEXT NOT NULL,
        received_at TEXT NOT NULL,
        UNIQUE(channel_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS newsletter_updates_recent
        ON newsletter_updates(channel_id, timestamp DESC, id DESC);
    `);
  },
  (db) => {
    const previousRows = db.prepare(`
      SELECT id, message_id, channel_id, author_id, message_type, body,
        timestamp, metadata_json, received_at
      FROM newsletter_updates
    `).all();
    db.exec(`
      CREATE TABLE newsletter_updates_v5 (
        id INTEGER PRIMARY KEY,
        event_uuid TEXT NOT NULL UNIQUE,
        whatsapp_message_id TEXT,
        missing_whatsapp_message_id INTEGER NOT NULL
          CHECK(missing_whatsapp_message_id IN (0, 1)),
        channel_id TEXT NOT NULL,
        author_id TEXT NOT NULL DEFAULT '',
        message_type TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        timestamp INTEGER,
        metadata_json TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
    `);
    const insertPrevious = db.prepare(`
      INSERT INTO newsletter_updates_v5 (
        id, event_uuid, whatsapp_message_id, missing_whatsapp_message_id,
        channel_id, author_id, message_type, body, timestamp,
        metadata_json, received_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of previousRows) {
      const whatsappMessageId = typeof row.message_id === 'string' && row.message_id
        ? row.message_id
        : null;
      insertPrevious.run(
        row.id,
        randomUUID(),
        whatsappMessageId,
        whatsappMessageId ? 0 : 1,
        row.channel_id,
        row.author_id || '',
        row.message_type || '',
        row.body || '',
        row.timestamp ?? null,
        row.metadata_json || '{}',
        row.received_at,
      );
    }
    db.exec(`
      DROP TABLE newsletter_updates;
      ALTER TABLE newsletter_updates_v5 RENAME TO newsletter_updates;
      CREATE INDEX newsletter_updates_recent
        ON newsletter_updates(channel_id, timestamp DESC, id DESC);
      CREATE UNIQUE INDEX newsletter_updates_whatsapp_id
        ON newsletter_updates(channel_id, whatsapp_message_id)
        WHERE whatsapp_message_id IS NOT NULL;
    `);
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS incoming_media (
        id INTEGER PRIMARY KEY,
        event_uuid TEXT NOT NULL UNIQUE,
        whatsapp_message_id TEXT,
        chat_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'downloading', 'downloaded', 'failed', 'skipped'
        )),
        file_path TEXT,
        mimetype TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0 CHECK(size_bytes >= 0),
        reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes >= 0),
        sha256 TEXT,
        failure_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS incoming_media_whatsapp_id
        ON incoming_media(chat_id, whatsapp_message_id)
        WHERE whatsapp_message_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS incoming_media_status_created
        ON incoming_media(status, created_at);
    `);
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS inbound_message_events (
        id INTEGER PRIMARY KEY,
        event_uuid TEXT NOT NULL UNIQUE,
        chat_id TEXT NOT NULL,
        whatsapp_message_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 1,
        last_error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS inbound_message_whatsapp_id
        ON inbound_message_events(chat_id, whatsapp_message_id)
        WHERE whatsapp_message_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS inbound_message_status_started
        ON inbound_message_events(status, started_at);
    `);
  },
];

export function migrateDatabase(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  const getVersion = db.prepare('SELECT version FROM schema_migrations WHERE version = ?');
  const recordVersion = db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)');

  migrations.forEach((migration, index) => {
    const version = index + 1;
    if (getVersion.get(version)) return;
    db.transaction(() => {
      migration(db);
      recordVersion.run(version, new Date().toISOString());
    })();
  });
}

export function openDatabase(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  migrateDatabase(db);
  return db;
}
