import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../memory/database.js';
import { InboundMessageStore } from '../whatsapp/inboundStore.js';
import { createMessageHandler } from '../whatsapp/messageHandler.js';

async function withDatabase(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'atom-inbound-'));
  const db = openDatabase(path.join(directory, 'atom.db'));
  try {
    await run({ db });
  } finally {
    if (db.open) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('completed inbound IDs persist across store restart and interrupted work can retry', async () => withDatabase(async ({ db }) => {
  let store = new InboundMessageStore(db);
  const message = {
    eventUuid: 'event-1',
    chatId: '254700123456@c.us',
    whatsappMessageId: 'inbound-wa-1',
  };
  assert.equal(store.claim(message).claimed, true);
  store.complete(message);
  store = new InboundMessageStore(db);
  assert.deepEqual(store.claim({ ...message, eventUuid: 'replay-event' }), {
    claimed: false,
    reason: 'already-completed',
  });

  const interrupted = {
    ...message,
    eventUuid: 'event-2',
    whatsappMessageId: 'inbound-wa-2',
  };
  assert.equal(store.claim(interrupted).claimed, true);
  store = new InboundMessageStore(db);
  const retried = store.claim({ ...interrupted, eventUuid: 'retry-event' });
  assert.equal(retried.claimed, true);
  assert.equal(retried.retry, true);
  store.complete(interrupted);
}));

test('message handler does not generate duplicate AI replies after recreation', async () => withDatabase(async ({ db }) => {
  let aiCalls = 0;
  const inboundStore = new InboundMessageStore(db);
  const makeHandler = () => createMessageHandler({
    agent: {
      async respond() {
        aiCalls += 1;
        return 'reply';
      },
    },
    limiter: { allow: () => true },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    config: { MAX_MESSAGE_LENGTH: 100, MAX_FILE_SIZE_MB: 1 },
    inboundStore,
    outbound: {
      async sendText() {
        return { ok: true, status: 'sent', accepted: true, messageId: 'outbound-id' };
      },
    },
  });
  const createMessage = () => ({
    chatId: '254700123456@c.us',
    from: '254700123456@c.us',
    fromMe: false,
    body: 'hello',
    id: { _serialized: 'incoming-id' },
    whatsappMessageId: 'incoming-id',
    eventUuid: `event-${Math.random()}`,
    type: 'chat',
    hasMedia: false,
    getChat: async () => ({
      id: { _serialized: '254700123456@c.us' },
      isUser: true,
      isGroup: false,
      isBroadcast: false,
      isStatus: false,
      sendStateTyping: async () => {},
    }),
  });
  const first = await makeHandler()(createMessage());
  const restarted = await makeHandler()(createMessage());
  assert.equal(first.status, 'processed');
  assert.equal(restarted.status, 'skipped');
  assert.equal(aiCalls, 1);
  assert.equal(db.prepare(
    'SELECT status FROM inbound_message_events WHERE whatsapp_message_id = ?',
  ).get('incoming-id').status, 'completed');
}));
