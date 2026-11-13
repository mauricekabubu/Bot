import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrateDatabase, openDatabase } from '../memory/database.js';
import { LongTermMemory } from '../memory/longTermMemory.js';
import { Agent } from '../ai/agent.js';
import { createMessageHandler } from '../whatsapp/messageHandler.js';
import {
  acknowledgementStatus,
  normalizeRecipient,
  normalizeWhatsAppMessageId,
  OutboundMessageService,
} from '../whatsapp/outbound.js';
import { ReminderService } from '../tools/reminders.js';

async function withAsyncDatabase(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atom-outbound-'));
  const filename = path.join(directory, 'atom.db');
  const db = openDatabase(filename);
  try {
    return await run({ db, filename, directory });
  } finally {
    if (db.open) db.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };
const baseService = (db, overrides = {}) => new OutboundMessageService({
  db,
  getClient: () => ({ sendMessage: async () => ({ id: { _serialized: 'wa-message-1' } }) }),
  isReady: () => true,
  logger: quietLogger,
  ...overrides,
});

test('versioned migration preserves legacy data and adds indexes/tables', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
    CREATE TABLE messages(id INTEGER PRIMARY KEY, user_id TEXT, role TEXT, content TEXT, created_at TEXT);
    CREATE TABLE memories(id INTEGER PRIMARY KEY, user_id TEXT, fact TEXT, kind TEXT, created_at TEXT);
    CREATE TABLE reminders(id INTEGER PRIMARY KEY, user_id TEXT, text TEXT, due_at TEXT,
      completed INTEGER DEFAULT 0, notified INTEGER DEFAULT 0, created_at TEXT);
    INSERT INTO messages VALUES(1, 'user@c.us', 'user', 'kept', '2025-01-01');
    INSERT INTO reminders VALUES(1, 'user@c.us', 'keep reminder', '2025-01-02', 0, 0, '2025-01-01');
  `);
    migrateDatabase(db);
    assert.equal(db.prepare('SELECT content FROM messages WHERE id=1').get().content, 'kept');
    assert.equal(db.prepare('SELECT text,delivery_attempts,last_error FROM reminders WHERE id=1').get().delivery_attempts, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 8);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='newsletter_updates'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='incoming_media'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inbound_message_events'").get());
    assert.deepEqual(
      db.prepare('PRAGMA table_info(newsletter_updates)').all().map(({ name }) => name),
      [
        'id',
        'event_uuid',
        'whatsapp_message_id',
        'missing_whatsapp_message_id',
        'channel_id',
        'author_id',
        'message_type',
        'body',
        'timestamp',
        'metadata_json',
        'received_at',
      ],
    );
    assert.ok(db.prepare("PRAGMA index_list('messages')").all().some((row) => row.name === 'messages_user_recent'));
    assert.ok(db.prepare("PRAGMA index_list('outbound_messages')").all().some((row) => row.name === 'outbound_status_created'));
    assert.deepEqual(
      db.prepare("PRAGMA index_xinfo('messages_user_recent')").all()
        .filter((column) => column.key === 1).map((column) => [column.name, column.desc]),
      [['user_id', 0], ['created_at', 1], ['id', 1]],
    );
    migrateDatabase(db);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
  } finally {
    db.close();
  }
});

test('newsletter schema migration preserves existing updates and permits missing WhatsApp IDs', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations(version, applied_at)
      VALUES (1, 'old'), (2, 'old'), (3, 'old');
      CREATE TABLE newsletter_updates (
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
      CREATE INDEX newsletter_updates_recent
        ON newsletter_updates(channel_id, timestamp DESC, id DESC);
      INSERT INTO newsletter_updates(
        id, message_id, channel_id, author_id, message_type, body,
        timestamp, metadata_json, received_at
      ) VALUES(
        7, 'legacy-wa-id', '123@newsletter', 'author@newsletter', 'chat',
        'existing update', 123, '{}', '2025-01-01'
      );
    `);

    migrateDatabase(db);

    const saved = db.prepare(`
      SELECT id, event_uuid, whatsapp_message_id, missing_whatsapp_message_id,
        channel_id, body
      FROM newsletter_updates
    `).get();
    assert.equal(saved.id, 7);
    assert.match(saved.event_uuid, /^[0-9a-f-]{36}$/i);
    assert.equal(saved.whatsapp_message_id, 'legacy-wa-id');
    assert.equal(saved.missing_whatsapp_message_id, 0);
    assert.equal(saved.channel_id, '123@newsletter');
    assert.equal(saved.body, 'existing update');
    db.prepare(`
      INSERT INTO newsletter_updates(
        event_uuid, whatsapp_message_id, missing_whatsapp_message_id,
        channel_id, metadata_json, received_at
      ) VALUES (?, NULL, 1, ?, '{}', 'now')
    `).run('new-event-uuid', '123@newsletter');
    assert.equal(db.prepare(`
      SELECT missing_whatsapp_message_id FROM newsletter_updates
      WHERE event_uuid = 'new-event-uuid'
    `).get().missing_whatsapp_message_id, 1);
    assert.throws(() => db.prepare(`
      INSERT INTO newsletter_updates(
        event_uuid, whatsapp_message_id, missing_whatsapp_message_id,
        channel_id, metadata_json, received_at
      ) VALUES (?, ?, 0, ?, '{}', 'now')
    `).run('duplicate-event-uuid', 'legacy-wa-id', '123@newsletter'), {
      code: 'SQLITE_CONSTRAINT_UNIQUE',
    });
  } finally {
    db.close();
  }
});

test('outbound validates recipients, records content hash only, and reports pre-send disconnects', async () => withAsyncDatabase(async ({ db }) => {
  const disconnected = baseService(db, { isReady: () => false });
  const invalid = await disconnected.sendText('12345', 'not sent');
  assert.equal(invalid.error, 'INVALID_RECIPIENT');
  const result = await disconnected.sendText('254700000001', 'private message', { idempotencyKey: 'offline-1' });
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'WHATSAPP_DISCONNECTED');
  const saved = db.prepare('SELECT * FROM outbound_messages').get();
  assert.equal(saved.message_preview, null);
  assert.equal(saved.content_hash.length, 64);
  assert.equal(saved.attempt_count, 0);
}));

test('outbound sends to the exact verified phone mapping and keeps the original LID in audit records', async () => withAsyncDatabase(async ({ db }) => {
  let destination;
  const service = baseService(db, {
    getClient: () => ({
      resolveRecipient: async (recipient) => {
        assert.equal(recipient, 'opaque-contact@lid');
        return '254700000001@c.us';
      },
      sendMessage: async (recipient) => {
        destination = recipient;
        return { id: { _serialized: 'lid-outbound-id' } };
      },
    }),
  });
  assert.equal(normalizeRecipient('opaque-contact@lid'), 'opaque-contact@lid');
  const result = await service.sendText('opaque-contact@lid', 'hello');
  assert.equal(result.ok, true);
  assert.equal(destination, '254700000001@c.us');
  assert.equal(db.prepare(
    'SELECT recipient_number FROM outbound_messages',
  ).get().recipient_number, 'opaque-contact@lid');
  assert.equal(normalizeRecipient('invalid@lid/other'), null);
}));

test('outbound rejects sending to an unresolved raw LID', async () => withAsyncDatabase(async ({ db }) => {
  let sendCount = 0;
  const service = baseService(db, {
    getClient: () => ({
      async resolveRecipient(recipient) {
        return recipient;
      },
      async sendMessage() {
        sendCount += 1;
        return { id: { _serialized: 'must-not-send' } };
      },
    }),
  });
  const result = await service.sendText('opaque-contact@lid', 'hello');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'LID_RECIPIENT_UNRESOLVED');
  assert.equal(sendCount, 0);
  assert.equal(db.prepare('SELECT attempt_count FROM outbound_messages').get().attempt_count, 0);
}));

test('outbound awaits the active WhatsApp client send response before marking sent', async () => withAsyncDatabase(async ({ db }) => {
  let releaseSend;
  let sendCalled = false;
  const pendingSend = new Promise((resolve) => { releaseSend = resolve; });
  const service = baseService(db, {
    getClient: () => ({
      async sendMessage(recipient, text) {
        sendCalled = true;
        assert.equal(recipient, '254700000001@c.us');
        assert.equal(text, 'hello');
        await pendingSend;
        return { id: { _serialized: 'awaited-message-id' } };
      },
    }),
  });
  let settled = false;
  const send = service.sendText('254700000001@c.us', 'hello')
    .then((result) => {
      settled = true;
      return result;
    });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sendCalled, true);
  assert.equal(settled, false);
  assert.equal(db.prepare('SELECT status FROM outbound_messages').get().status, 'sending');
  releaseSend();
  const result = await send;
  assert.equal(result.ok, true);
  assert.equal(result.messageId, 'awaited-message-id');
  assert.equal(db.prepare('SELECT status FROM outbound_messages').get().status, 'sent');
}));

test('outbound retries a failed pre-send LID lookup once without creating a duplicate message', async () => withAsyncDatabase(async ({ db }) => {
  let resolutionAttempts = 0;
  const sentRecipients = [];
  const service = baseService(db, {
    getClient: () => ({
      async resolveRecipient(recipient) {
        assert.equal(recipient, 'opaque-contact@lid');
        resolutionAttempts += 1;
        if (resolutionAttempts === 1) {
          throw Object.assign(new Error('temporary WPP lookup failure'), {
            code: 'LID_MAPPING_LOOKUP_FAILED',
          });
        }
        return '254700000001@c.us';
      },
      async sendMessage(recipient) {
        sentRecipients.push(recipient);
        return { id: { _serialized: 'retried-lid-send' } };
      },
    }),
  });
  const options = { idempotencyKey: 'inbound:lid-msg:ai-response' };
  const first = await service.sendText('opaque-contact@lid', 'reply text', options);
  assert.equal(first.ok, false);
  assert.equal(first.retryable, true);
  const second = await service.sendText('opaque-contact@lid', 'reply text', options);
  assert.equal(second.ok, true);
  assert.equal(second.recordId, first.recordId);
  assert.deepEqual(sentRecipients, ['254700000001@c.us']);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM outbound_messages').get().count, 1);
  assert.equal(db.prepare(
    'SELECT attempt_count FROM outbound_messages',
  ).get().attempt_count, 1);
}));

test('outbound does not repeat a failed pre-send LID retry', async () => withAsyncDatabase(async ({ db }) => {
  let resolutionAttempts = 0;
  const service = baseService(db, {
    getClient: () => ({
      async resolveRecipient() {
        resolutionAttempts += 1;
        throw Object.assign(new Error('temporary WPP lookup failure'), {
          code: 'LID_MAPPING_LOOKUP_FAILED',
        });
      },
      async sendMessage() {
        assert.fail('LID resolution must succeed before sending');
      },
    }),
  });
  const options = { idempotencyKey: 'inbound:lid-msg:ai-response' };
  const first = await service.sendText('opaque-contact@lid', 'reply text', options);
  assert.equal(first.retryable, true);
  const retry = await service.sendText('opaque-contact@lid', 'reply text', options);
  assert.equal(retry.error, 'LID_MAPPING_LOOKUP_FAILED');
  assert.equal(retry.retryable, undefined);
  const duplicate = await service.sendText('opaque-contact@lid', 'reply text', options);
  assert.equal(duplicate.duplicate, true);
  assert.equal(resolutionAttempts, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM outbound_messages').get().count, 1);
}));

test('outbound defers the one-shot LID retry while WhatsApp is disconnected', async () => withAsyncDatabase(async ({ db }) => {
  let ready = true;
  let resolutionAttempts = 0;
  const service = baseService(db, {
    isReady: () => ready,
    getClient: () => ({
      async resolveRecipient(recipient) {
        resolutionAttempts += 1;
        if (resolutionAttempts === 1) {
          throw Object.assign(new Error('temporary WPP lookup failure'), {
            code: 'LID_MAPPING_LOOKUP_FAILED',
          });
        }
        return '254700000001@c.us';
      },
      async sendMessage() {
        return { id: { _serialized: 'reconnected-lid-send' } };
      },
    }),
  });
  const options = { idempotencyKey: 'inbound:lid-msg:ai-response' };
  const first = await service.sendText('opaque-contact@lid', 'reply text', options);
  assert.equal(first.retryable, true);

  ready = false;
  const deferred = await service.sendText('opaque-contact@lid', 'reply text', options);
  assert.equal(deferred.retryable, true);
  assert.equal(resolutionAttempts, 1);

  ready = true;
  const retried = await service.sendText('opaque-contact@lid', 'reply text', options);
  assert.equal(retried.ok, true);
  assert.equal(resolutionAttempts, 2);
}));

test('outbound refuses unresolved LID recipients without sending', async () => withAsyncDatabase(async ({ db }) => {
  let sendCount = 0;
  const service = baseService(db, {
    getClient: () => ({
      sendMessage: async () => {
        sendCount += 1;
        return { id: { _serialized: 'must-not-send' } };
      },
      resolveRecipient: async () => {
        throw Object.assign(new Error('mapping unavailable'), { code: 'LID_RECIPIENT_UNRESOLVED' });
      },
    }),
  });
  const result = await service.sendText('opaque-contact@lid', 'hello');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'LID_RECIPIENT_UNRESOLVED');
  assert.equal(sendCount, 0);
}));

test('acknowledgements correlate against persisted outbound IDs after service restart', async () => withAsyncDatabase(async ({ db }) => {
  const firstProcess = baseService(db);
  const sent = await firstProcess.sendText('254700000001', 'hello');
  const restartedProcess = baseService(db);
  assert.equal(
    restartedProcess.handleAck({ id: { _serialized: sent.messageId }, ack: 2 }),
    true,
  );
  assert.equal(db.prepare(
    'SELECT status FROM outbound_messages WHERE message_id = ?',
  ).get(sent.messageId).status, 'delivered');
}));

test('serialized send response and ACK ID object correlate to the same persisted ID', async () => withAsyncDatabase(async ({ db }) => {
  const messageId = 'true_254700000001@c.us_3EB0A1B2C3D4';
  const service = baseService(db, {
    getClient: () => ({
      sendMessage: async () => ({ id: messageId }),
    }),
  });
  const sent = await service.sendText('254700000001', 'hello');
  assert.equal(sent.messageId, messageId);
  assert.equal(db.prepare(
    'SELECT message_id FROM outbound_messages WHERE id = ?',
  ).get(sent.recordId).message_id, messageId);
  assert.equal(service.handleAck({
    id: {
      fromMe: true,
      remote: '254700000001@c.us',
      id: '3EB0A1B2C3D4',
      _serialized: messageId,
    },
    ack: 2,
  }), true);
  assert.equal(db.prepare(
    'SELECT status FROM outbound_messages WHERE id = ?',
  ).get(sent.recordId).status, 'delivered');
}));

test('message ID normalization preserves the complete serialized identifier in string and object forms', () => {
  const serialized = 'true_254700000001@c.us_3EB0A1B2C3D4';
  assert.equal(normalizeWhatsAppMessageId(serialized), serialized);
  assert.equal(normalizeWhatsAppMessageId({ _serialized: serialized }), serialized);
  assert.equal(normalizeWhatsAppMessageId({ serialized }), serialized);
  assert.equal(normalizeWhatsAppMessageId({
    fromMe: true,
    remote: '254700000001@c.us',
    id: '3EB0A1B2C3D4',
  }), null);
});

test('installed WPPConnect acknowledgement values map sent, received and read accurately', () => {
  assert.equal(acknowledgementStatus(1), 'sent');
  assert.equal(acknowledgementStatus(2), 'delivered');
  assert.equal(acknowledgementStatus(3), 'read');
  assert.equal(acknowledgementStatus(-1), 'failed');
  assert.equal(acknowledgementStatus(-7), 'failed');
  assert.equal(acknowledgementStatus(0), null);
  assert.equal(acknowledgementStatus(4), null);
  assert.equal(acknowledgementStatus(5), null);
});

test('successful acceptance, duplicate suppression, delivery/read and unknown acknowledgements', async () => withAsyncDatabase(async ({ db }) => {
  let sends = 0;
  const service = baseService(db, {
    getClient: () => ({ sendMessage: async () => {
      sends += 1;
      return { id: { _serialized: 'wa-message-1' } };
    } }),
  });
  const sent = await service.sendText('254700000001', 'hello', { idempotencyKey: 'reply-1' });
  assert.equal(sent.status, 'sent');
  assert.equal(sent.accepted, true);
  assert.equal(sends, 1);
  const duplicate = await service.sendText('254700000001', 'hello', { idempotencyKey: 'reply-1' });
  assert.equal(duplicate.duplicate, true);
  assert.equal(sends, 1);

  assert.equal(service.handleAck({ id: { _serialized: 'wa-message-1' }, ack: 2 }), true);
  assert.equal(db.prepare('SELECT status,delivered_at FROM outbound_messages').get().status, 'delivered');
  assert.equal(service.handleAck({ id: 'wa-message-1', ack: 2 }), true);
  assert.equal(db.prepare('SELECT status,delivered_at FROM outbound_messages').get().status, 'delivered');
  assert.equal(service.handleAck({ id: { _serialized: 'wa-message-1' }, ack: 3 }), true);
  assert.ok(db.prepare('SELECT read_at FROM outbound_messages').get().read_at);
  assert.equal(service.handleAck({ id: { _serialized: 'wa-message-1' }, ack: 77 }), false);
  assert.equal(db.prepare('SELECT status FROM outbound_messages').get().status, 'read');
  assert.equal(service.handleAck({ id: { _serialized: 'wa-message-1' }, ack: -1 }), true);
  assert.equal(db.prepare('SELECT status FROM outbound_messages').get().status, 'read');
  assert.equal(service.getReport().read, 1);
  assert.equal(service.getReport().deliverySuccessRate, 100);
}));

test('acknowledgements arriving before send returns are correlated after the returned ID is stored', async () => withAsyncDatabase(async ({ db }) => {
  let service;
  const events = [];
  service = baseService(db, {
    logger: {
      info: (event, metadata) => events.push({ event, metadata }),
      warn: (event, metadata) => events.push({ event, metadata }),
      error() {},
      debug() {},
    },
    getClient: () => ({
      sendMessage: async () => {
        service.handleAck({ id: 'early-ack-id', ack: 2 });
        service.handleAck({ id: { _serialized: 'early-ack-id' }, ack: 3 });
        service.handleAck({ id: { serialized: 'early-ack-id' }, ack: 3 });
        return { id: { _serialized: 'early-ack-id' } };
      },
    }),
  });
  const sent = await service.sendText('254700000001', 'hello');
  assert.equal(sent.messageId, 'early-ack-id');
  assert.equal(sent.status, 'read');
  assert.equal(db.prepare('SELECT status FROM outbound_messages').get().status, 'read');
  assert.equal(events.filter(({ event }) => event === 'whatsapp_ack_pending_correlation').length, 3);
  assert.equal(events.filter(({ event, metadata }) =>
    event === 'whatsapp_ack_pending_correlation' && metadata.duplicate).length, 1);
  assert.equal(events.filter(({ event }) => event === 'whatsapp_ack_ignored').length, 0);
  assert.ok(events.some(({ event }) => event === 'whatsapp_message_delivery_acknowledged'));
  assert.ok(events.some(({ event }) => event === 'whatsapp_message_read_acknowledged'));
}));

test('unknown ACK IDs are not held when no outbound send is in flight', async () => withAsyncDatabase(async ({ db }) => {
  const events = [];
  const service = baseService(db, {
    logger: {
      info: (event, metadata) => events.push({ event, metadata }),
      warn: (event, metadata) => events.push({ event, metadata }),
      error() {},
      debug() {},
    },
  });
  assert.equal(service.handleAck({ id: 'unknown-ack-id', ack: 2 }), false);
  assert.equal(service.pendingAcknowledgements.size, 0);
  assert.ok(events.some(({ event, metadata }) =>
    event === 'whatsapp_ack_unmatched' &&
    metadata.reason === 'no_matching_outbound_message' &&
    metadata.pendingCorrelation === false));
}));

test('ACKs from manual WhatsApp and linked-device messages remain unmatched', async () => withAsyncDatabase(async ({ db }) => {
  const events = [];
  const service = baseService(db, {
    logger: {
      info: (event, metadata) => events.push({ event, metadata }),
      warn: (event, metadata) => events.push({ event, metadata }),
      error() {},
      debug() {},
    },
  });
  const manualMessageAck = {
    id: {
      fromMe: true,
      remote: '254700000001@c.us',
      id: 'manual-web-message',
      _serialized: 'true_254700000001@c.us_manual-web-message',
    },
    ack: 2,
  };
  const linkedDeviceAck = {
    id: {
      fromMe: true,
      remote: '254700000002@c.us',
      id: 'linked-device-message',
      _serialized: 'true_254700000002@c.us_linked-device-message',
    },
    ack: 3,
  };
  assert.equal(service.handleAck(manualMessageAck), false);
  assert.equal(service.handleAck(linkedDeviceAck), false);
  assert.equal(service.handleAck({
    id: {
      fromMe: false,
      remote: '254700000003@c.us',
      id: 'incoming-message',
      _serialized: 'false_254700000003@c.us_incoming-message',
    },
    ack: 3,
  }), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM outbound_messages').get().count, 0);
  assert.equal(events.filter(({ event }) => event === 'whatsapp_ack_unmatched').length, 3);
  assert.ok(events.every(({ event }) => event !== 'whatsapp_message_delivery_acknowledged' &&
    event !== 'whatsapp_message_read_acknowledged'));
}));

test('early ACK buffer expires automatically and is removed', async () => withAsyncDatabase(async ({ db }) => {
  const events = [];
  const service = baseService(db, {
    pendingAckTtlMs: 15,
    logger: {
      info: (event, metadata) => events.push({ event, metadata }),
      warn: (event, metadata) => events.push({ event, metadata }),
      error() {},
      debug() {},
    },
  });
  service.rememberPendingAcknowledgement('early-expiring-ack', 2);
  assert.equal(service.pendingAcknowledgements.size, 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(service.pendingAcknowledgements.size, 0);
  assert.equal(service.pendingAcknowledgementTimers.size, 0);
  assert.ok(events.some(({ event }) => event === 'whatsapp_ack_pending_expired'));
}));

test('ACK buffered during a send that then fails expires without claiming delivery', async () => withAsyncDatabase(async ({ db }) => {
  const service = baseService(db, {
    pendingAckTtlMs: 15,
    getClient: () => ({
      async sendMessage() {
        service.handleAck({
          id: { _serialized: 'uncertain-send-ack' },
          ack: 2,
        });
        throw new Error('send was not accepted');
      },
    }),
  });
  const result = await service.sendText('254700000001', 'hello');
  assert.equal(result.status, 'unknown');
  assert.equal(db.prepare('SELECT status FROM outbound_messages').get().status, 'unknown');
  assert.equal(service.pendingAcknowledgements.size, 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(service.pendingAcknowledgements.size, 0);
  assert.equal(db.prepare('SELECT status FROM outbound_messages').get().status, 'unknown');
}));

test('ambiguous duplicate outbound IDs cannot update either record', async () => withAsyncDatabase(async ({ db }) => {
  const events = [];
  const service = baseService(db, {
    logger: {
      info: (event, metadata) => events.push({ event, metadata }),
      warn: (event, metadata) => events.push({ event, metadata }),
      error: (event, metadata) => events.push({ event, metadata }),
      debug() {},
    },
    getClient: () => ({
      sendMessage: async () => ({ id: 'duplicate-wpp-id' }),
    }),
  });
  await service.sendText('254700000001', 'first');
  await service.sendText('254700000002', 'second');
  assert.equal(service.handleAck({ id: { _serialized: 'duplicate-wpp-id' }, ack: 2 }), false);
  assert.deepEqual(
    db.prepare('SELECT status FROM outbound_messages ORDER BY id').all().map(({ status }) => status),
    ['sent', 'sent'],
  );
  assert.ok(events.some(({ event, metadata }) =>
    event === 'whatsapp_ack_ambiguous_message_id' && metadata.matchCount === 2));
}));

test('one-shot test workflow can wait for and report read acknowledgement', async () => withAsyncDatabase(async ({ db }) => {
  const service = baseService(db);
  const sent = await service.sendText('254700000001', 'hello');
  assert.equal(sent.messageId, 'wa-message-1');
  assert.equal(service.handleAck({ id: { _serialized: sent.messageId }, ack: 3 }), true);
  assert.deepEqual(await service.waitForAcknowledgement(sent.recordId, 10), {
    status: 'read',
    acknowledged: true,
    timedOut: false,
  });
}));

test('acknowledgements correlate exact IDs only and log malformed or unmatched identifiers', async () => withAsyncDatabase(async ({ db }) => {
  const events = [];
  const service = baseService(db, {
    logger: {
      info: (event, metadata) => events.push({ level: 'info', event, metadata }),
      warn: (event, metadata) => events.push({ level: 'warn', event, metadata }),
      error: (event, metadata) => events.push({ level: 'error', event, metadata }),
    },
  });
  await service.sendText('254700000001', 'hello');

  assert.equal(service.handleAck({
    id: { id: 'opaque-message-part', remote: '254700000001@c.us', fromMe: true },
    ack: 3,
  }), false);
  assert.equal(db.prepare('SELECT status FROM outbound_messages').get().status, 'sent');
  assert.equal(service.handleAck({ id: 'wa-message-1', ack: 2 }), true);
  assert.equal(db.prepare('SELECT status FROM outbound_messages').get().status, 'delivered');
  assert.equal(service.handleAck({ id: { _serialized: 'another-message-id' }, ack: 3 }), false);
  assert.equal(db.prepare('SELECT status FROM outbound_messages').get().status, 'delivered');
  assert.equal(service.handleAck({ id: { _serialized: 'wa-message-1' }, ack: 2 }), true);
  assert.equal(db.prepare('SELECT status FROM outbound_messages').get().status, 'delivered');
  assert.equal(service.handleAck({ id: { _serialized: 'not-tracked' }, ack: 3 }), false);
  assert.equal(db.prepare('SELECT status FROM outbound_messages').get().status, 'delivered');

  assert.ok(events.some(({ event, metadata }) =>
    event === 'whatsapp_ack_ignored' &&
    metadata.reason === 'missing_message_id' &&
    metadata.idType === 'object'));
  assert.ok(events.some(({ event, metadata }) =>
    event === 'whatsapp_ack_unmatched' &&
    metadata.reason === 'no_matching_outbound_message'));
}));

test('send exceptions are recorded as unknown and never automatically retried', async () => withAsyncDatabase(async ({ db }) => {
  let sends = 0;
  const events = [];
  const service = baseService(db, {
    logger: {
      info: (event, metadata) => events.push({ level: 'info', event, metadata }),
      warn: (event, metadata) => events.push({ level: 'warn', event, metadata }),
      error: (event, metadata) => events.push({ level: 'error', event, metadata }),
      debug: (event, metadata) => events.push({ level: 'debug', event, metadata }),
    },
    getClient: () => ({
      sendMessage: async () => {
        sends += 1;
        throw new Error('send failed to 254700000001: private message');
      },
    }),
  });
  const result = await service.sendText('254700000001', 'private message', { idempotencyKey: 'uncertain-1' });
  assert.equal(result.status, 'unknown');
  assert.equal(result.accepted, null);
  await service.sendText('254700000001', 'hello again', { idempotencyKey: 'uncertain-1' });
  assert.equal(sends, 1);
  const failure = events.find(({ event }) => event === 'outbound_message_failed');
  assert.equal(failure.metadata.errorName, 'Error');
  assert.equal(failure.metadata.errorMessage, 'send failed to [recipient]: [message]');
  assert.ok(events.some(({ event, metadata }) =>
    event === 'outbound_message_error_details' &&
    !metadata.stack.includes('private message')));
}));

test('test sends require an explicitly approved recipient and suppression is honored', async () => withAsyncDatabase(async ({ db }) => {
  let sends = 0;
  const service = baseService(db, {
    getClient: () => ({ sendMessage: async () => { sends += 1; return { id: 'test-id' }; } }),
  });
  const denied = await service.sendText('254700000001', 'test', { testMode: true });
  assert.equal(denied.error, 'TEST_RECIPIENT_NOT_ALLOWLISTED');
  service.approveTestRecipient('254700000001');
  service.setSuppressed('254700000001', true);
  const suppressed = await service.sendText('254700000001', 'test', { testMode: true });
  assert.equal(suppressed.error, 'RECIPIENT_SUPPRESSED');
  service.setSuppressed('254700000001', false);
  const approved = await service.sendText('254700000001', 'test', { testMode: true });
  assert.equal(approved.ok, true);
  assert.equal(sends, 1);
}));

test('long-term memories deduplicate per user, isolate users, and reject secrets', async () => withAsyncDatabase(async ({ db }) => {
  const memory = new LongTermMemory(db);
  assert.equal(memory.add('a@c.us', 'I prefer concise replies', 'preference'), true);
  assert.equal(memory.add('a@c.us', '  i prefer concise replies ', 'preference'), false);
  assert.equal(memory.add('b@c.us', 'I prefer concise replies', 'preference'), true);
  assert.equal(memory.list('a@c.us').length, 1);
  assert.equal(memory.list('b@c.us').length, 1);
  assert.throws(() => memory.add('a@c.us', 'My API key is abc', 'instruction'), /SENSITIVE_MEMORY_REJECTED/);
  assert.equal(memory.delete('a@c.us', memory.list('b@c.us')[0].id), 0);
}));

test('Agent supports explicit memory save, inspect, and individual deletion', async () => withAsyncDatabase(async ({ db }) => {
  const memory = new LongTermMemory(db);
  const agent = new Agent({
    conversation: { recent: () => [], add() {}, clear() {} },
    longTerm: memory,
    gemini: { generate: async () => 'unused' },
    tools: new Map(),
    logger: quietLogger,
  });
  assert.match(await agent.respond('a@c.us', 'remember preference: I like short answers'), /nimehifadhi/);
  assert.match(await agent.respond('a@c.us', 'remember preference: I like short answers'), /saved tayari/);
  const listed = await agent.respond('a@c.us', 'show memories');
  assert.match(listed, /\[preference\] I like short answers/);
  const memoryId = memory.list('a@c.us')[0].id;
  assert.match(await agent.respond('a@c.us', `forget memory ${memoryId}`), /nimefuta/);
  assert.equal(memory.list('a@c.us').length, 0);
}));

test('reminders route through outbound tracking and do not claim delivery without an ack', async () => withAsyncDatabase(async ({ db }) => {
  const outbound = baseService(db);
  db.prepare(`
    INSERT INTO reminders(user_id,text,due_at,created_at)
    VALUES(?,?,?,?)
  `).run('254700000001@c.us', 'Call back', new Date(0).toISOString(), new Date().toISOString());
  const reminders = new ReminderService(db, (id, text, { reminderId, attempt }) =>
    outbound.sendText(id, text, {
      messageType: 'reminder',
      idempotencyKey: `reminder:${reminderId}:attempt:${attempt}`,
    }));
  await reminders.tick();
  assert.equal(db.prepare('SELECT status FROM outbound_messages').get().status, 'sent');
  assert.equal(db.prepare('SELECT notified FROM reminders').get().notified, 1);
  assert.equal(outbound.getReport().delivered, 0);
}));

test('reminder retries are bounded and uncertain sends are not retried', async () => withAsyncDatabase(async ({ db }) => {
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO reminders(user_id,text,due_at,created_at)
    VALUES(?,?,?,?)
  `);
  insert.run('254700000001@c.us', 'Retry safely', new Date(0).toISOString(), now);
  insert.run('254700000002@c.us', 'Do not duplicate', new Date(0).toISOString(), now);
  let retryCount = 0;
  let uncertainCount = 0;
  const reminders = new ReminderService(db, async (id) => {
    if (id.endsWith('0001@c.us')) {
      retryCount += 1;
      return { accepted: false };
    }
    uncertainCount += 1;
    return { accepted: null };
  });
  await reminders.tick();
  await reminders.tick();
  await reminders.tick();
  await reminders.tick();
  assert.equal(retryCount, 3);
  assert.equal(uncertainCount, 1);
}));

test('incoming message, Agent response, and outbound delivery use the shared service', async () => withAsyncDatabase(async ({ db }) => {
  const outbound = baseService(db);
  const events = [];
  const handlerLogger = {
    info: (event, metadata) => events.push({ event, metadata }),
    warn: (event, metadata) => events.push({ event, metadata }),
    error: (event, metadata) => events.push({ event, metadata }),
    debug: (event, metadata) => events.push({ event, metadata }),
  };
  const agent = new Agent({
    conversation: { recent: () => [], add() {}, clear() {} },
    longTerm: { list: () => [], add() { return true; }, clear() {} },
    gemini: { generate: async () => 'Hello back.' },
    tools: new Map(),
    logger: handlerLogger,
  });
  const handler = createMessageHandler({
    agent,
    limiter: { allow: () => true },
    logger: handlerLogger,
    config: { MAX_MESSAGE_LENGTH: 100, MAX_FILE_SIZE_MB: 1 },
    outbound,
  });
  const sender = '254700000001@c.us';
  await handler({
    from: sender,
    fromMe: false,
    body: 'hello',
    id: { _serialized: 'inbound-1' },
    type: 'chat',
    hasMedia: false,
    getChat: async () => ({
      id: { _serialized: sender },
      isUser: true,
      isGroup: false,
      sendStateTyping: async () => {},
    }),
    reply: async () => assert.fail('production path should use outbound'),
  });
  const sent = db.prepare('SELECT recipient_number,message_type,status FROM outbound_messages').get();
  assert.deepEqual(sent, {
    recipient_number: sender,
    message_type: 'automatic_reply',
    status: 'sent',
  });
  for (const event of [
    'whatsapp_private_message_received',
    'whatsapp_private_message_verified',
    'individual_message_received',
    'ai_processing_started',
    'ai_response_ready_for_delivery',
    'whatsapp_outbound_reply_attempted',
    'whatsapp_outbound_reply_result',
  ]) {
    assert.ok(events.some((entry) => entry.event === event), `missing ${event}`);
  }
  assert.deepEqual(handler.getDiagnosticsSummary(), {
    eventsReceived: 1,
    privateIncomingCandidates: 1,
    privateMessagesRejected: 0,
    privateMessagesVerified: 1,
    groupEvents: 0,
    newsletterEvents: 0,
    aiProcessingStarted: 1,
    outboundReplyAttempts: 1,
  });
}));

test('generated AI response delivery failure is recorded without a second fallback send', async () => withAsyncDatabase(async ({ db }) => {
  const events = [];
  const logger = {
    info: (event, metadata) => events.push({ event, metadata }),
    warn: (event, metadata) => events.push({ event, metadata }),
    error: (event, metadata) => events.push({ event, metadata }),
    debug() {},
  };
  let resolutionAttempts = 0;
  let sendAttempts = 0;
  const outbound = baseService(db, {
    logger,
    getClient: () => ({
      async resolveRecipient() {
        resolutionAttempts += 1;
        throw Object.assign(new Error('valid LID chat rejected during verification'), {
          code: 'LID_RECIPIENT_NOT_PRIVATE',
        });
      },
      async sendMessage() {
        sendAttempts += 1;
        return { id: { _serialized: 'should-not-send' } };
      },
    }),
  });
  const persistedConversation = [];
  const agent = new Agent({
    conversation: {
      recent: () => [],
      add: (...entry) => persistedConversation.push(entry),
    },
    longTerm: { list: () => [] },
    gemini: { generate: async () => 'Generated AI response.' },
    tools: new Map(),
    logger,
  });
  const inboundFailures = [];
  const handler = createMessageHandler({
    agent,
    limiter: { allow: () => true },
    logger,
    config: { MAX_MESSAGE_LENGTH: 100, MAX_FILE_SIZE_MB: 1 },
    outbound,
    inboundStore: {
      claim: () => ({ claimed: true, persistent: true }),
      complete() {},
      fail: (_message, error) => inboundFailures.push(error?.code),
    },
  });
  const chatId = 'opaque-private@lid';
  const result = await handler({
    chatId,
    from: chatId,
    fromMe: false,
    body: 'hello',
    type: 'chat',
    eventUuid: 'lid-delivery-event',
    whatsappMessageId: 'inbound-lid-message',
    id: { _serialized: 'inbound-lid-message' },
    chatMetadata: { id: chatId, isUser: true, isGroup: false },
    getChat: async () => ({
      id: { _serialized: chatId },
      isUser: true,
      isGroup: false,
      isBroadcast: false,
      isStatus: false,
      isReadOnly: false,
      sendStateTyping: async () => {},
    }),
  });

  assert.equal(result.status, 'delivery-failed');
  assert.deepEqual(persistedConversation, [
    [chatId, 'user', 'hello'],
    [chatId, 'model', 'Generated AI response.'],
  ]);
  assert.equal(resolutionAttempts, 1);
  assert.equal(sendAttempts, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM outbound_messages').get().count, 1);
  assert.equal(db.prepare('SELECT status FROM outbound_messages').get().status, 'failed');
  assert.deepEqual(inboundFailures, ['LID_RECIPIENT_NOT_PRIVATE']);
  assert.ok(events.some(({ event, metadata }) =>
    event === 'ai_response_delivery_failed' &&
    metadata.responseGenerated === true));
  assert.equal(events.some(({ event }) => event === 'message_processing_failed'), false);
  assert.equal(events.some(({ event }) => event === 'message_error_reply_failed'), false);
}));
