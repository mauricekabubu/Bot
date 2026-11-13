import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stageIncomingDocument, cleanupStagedDocument } from '../tools/documents.js';
import { ReminderService } from '../tools/reminders.js';
import { classifyIncomingMessage } from '../whatsapp/messageFilter.js';
import { createMessageHandler } from '../whatsapp/messageHandler.js';

const individualChat = (id) => ({
  id: { _serialized: id },
  isUser: true,
  isGroup: false,
  sendStateTyping: async () => {},
});
const incoming = (overrides = {}) => {
  const from = '254700123456@c.us';
  return {
    from,
    fromMe: false,
    body: 'hello',
    id: { _serialized: `message-${Math.random()}` },
    type: 'chat',
    hasMedia: false,
    getChat: async () => individualChat(from),
    reply: async () => undefined,
    ...overrides,
  };
};
const logger = { debug() {}, info() {}, warn() {}, error() {} };

test('chat verification requires a matching, verified individual chat', async () => {
  const msg = incoming();
  assert.equal((await classifyIncomingMessage(msg, async () => { throw new Error('offline'); })).accepted, false);
  assert.equal((await classifyIncomingMessage(msg, async () => null)).accepted, false);
  assert.equal((await classifyIncomingMessage(msg, async () => individualChat('different@c.us'))).accepted, false);
  assert.equal((await classifyIncomingMessage(msg, async () => ({ id: {}, isUser: true, isGroup: false }))).accepted, false);
  assert.equal((await classifyIncomingMessage(msg, async () => ({ ...individualChat(msg.from), isBroadcast: true }))).accepted, false);
  assert.equal((await classifyIncomingMessage(incoming({ from: '123@g.us' }))).accepted, false);
  assert.equal((await classifyIncomingMessage(incoming({ from: 'status@broadcast' }))).accepted, false);
  assert.equal((await classifyIncomingMessage(incoming({ fromMe: true }))).accepted, false);
  assert.equal((await classifyIncomingMessage(incoming({ from: '123@lid' }))).accepted, false);
  assert.equal((await classifyIncomingMessage(msg, async () => individualChat(msg.from))).accepted, true);
});

test('handler preserves per-user order, deduplicates messages, and permits missing serialized IDs', async () => {
  const received = [];
  const handler = createMessageHandler({
    agent: { async respond(_user, text) { received.push(text); return 'ok'; } },
    limiter: { allow: () => true },
    logger,
    config: { MAX_MESSAGE_LENGTH: 100, MAX_FILE_SIZE_MB: 1 },
  });
  let releaseFirstChat;
  const firstChat = new Promise((resolve) => { releaseFirstChat = resolve; });
  const first = incoming({
    body: 'first',
    id: { _serialized: 'same-id' },
    getChat: async () => { await firstChat; return individualChat('254700123456@c.us'); },
  });
  const second = incoming({ body: 'second', id: { _serialized: 'second-id' } });

  const firstTask = handler(first);
  const secondTask = handler(second);
  releaseFirstChat();
  await Promise.all([firstTask, secondTask]);
  await handler(incoming({ body: 'duplicate', id: { _serialized: 'same-id' } }));
  assert.deepEqual(received, ['first', 'second']);

  const noId = incoming({ body: 'no id', id: {}, timestamp: 123 });
  await handler(noId);
  await handler(incoming({ body: 'no id', id: {}, timestamp: 123 }));
  assert.deepEqual(received, ['first', 'second', 'no id']);
});

test('rejected chats and documents never reach the agent; empty-body documents are routed', async () => {
  let responses = 0;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atom-handler-'));
  try {
    const handler = createMessageHandler({
      agent: { async respond() { responses += 1; return 'ok'; } },
      limiter: { allow: () => true },
      logger,
      config: { MAX_MESSAGE_LENGTH: 100, MAX_FILE_SIZE_MB: 1 },
      tempDirectory: tempDir,
    });

    await handler(incoming({
      getChat: async () => individualChat('another@c.us'),
    }));
    const document = incoming({
      body: '',
      type: 'document',
      hasMedia: true,
      id: { _serialized: 'document-1' },
      downloadMedia: async () => ({
        filename: 'notes.txt',
        mimetype: 'text/plain',
        data: Buffer.from('safe text').toString('base64'),
      }),
    });
    await handler(document);
    assert.equal(responses, 0);
    assert.equal((await fs.readdir(tempDir)).length, 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('stored individual documents are staged from the saved media without downloading twice', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atom-stored-document-'));
  const savedDocument = path.join(tempDir, 'stored.bin');
  await fs.writeFile(savedDocument, Buffer.from('%PDF-test fixture'));
  let downloadCount = 0;
  const replies = [];
  try {
    const handler = createMessageHandler({
      agent: { async respond() { assert.fail('document content is not sent to the agent'); } },
      limiter: { allow: () => true },
      logger,
      config: { MAX_MESSAGE_LENGTH: 100, MAX_FILE_SIZE_MB: 1 },
      tempDirectory: tempDir,
      mediaStore: {
        async download() {
          downloadCount += 1;
          return {
            status: 'downloaded',
            filePath: savedDocument,
            mimetype: 'application/pdf',
          };
        },
      },
    });
    await handler(incoming({
      body: '',
      type: 'document',
      hasMedia: true,
      eventUuid: 'stored-pdf-event',
      whatsappMessageId: 'stored-pdf-message',
      mediaDownloadAvailable: true,
      downloadMedia: async () => assert.fail('media must be read from its stored file'),
      reply: async (text) => replies.push(text),
    }));
    assert.equal(downloadCount, 1);
    assert.match(replies[0], /document yako safely/);
    assert.deepEqual((await fs.readdir(tempDir)).filter((name) =>
      name.startsWith('atom-doc-')), []);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('document staging validates type, signature, size, names, and removes temporary files', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atom-doc-'));
  const media = (overrides = {}) => ({
    filename: 'safe.txt',
    mimetype: 'text/plain',
    data: Buffer.from('hello').toString('base64'),
    ...overrides,
  });
  try {
    await assert.rejects(() => stageIncomingDocument(media({ filename: '..\\outside.txt' }), 100, tempDir));
    await assert.rejects(() => stageIncomingDocument(media({ mimetype: 'application/pdf' }), 100, tempDir));
    await assert.rejects(() => stageIncomingDocument(media({ data: '%%%not-base64%%%' }), 100, tempDir));
    await assert.rejects(() => stageIncomingDocument(media(), 2, tempDir));

    const staged = await stageIncomingDocument(media(), 100, tempDir);
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(staged.filePath)).mode & 0o777, 0o600);
    }
    await cleanupStagedDocument(staged);
    assert.deepEqual(await fs.readdir(tempDir), []);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('reminders validate owners and record failures for later retry', async () => {
  const calls = [];
  let shouldFail = true;
  const reminder = {
    id: 8,
    user_id: '254700123456@c.us',
    text: 'Study',
    delivery_attempts: 0,
  };
  let deliveryNotified = false;
  const db = {
    prepare(sql) {
      return {
        run(...args) {
          calls.push({ sql, args });
          if (sql.includes('SET notified=1,last_error=NULL')) deliveryNotified = true;
          return { changes: 1 };
        },
        all() {
          calls.push({ sql });
          return sql.startsWith('SELECT id,user_id,text')
            ? (deliveryNotified ? [] : [reminder])
            : [];
        },
      };
    },
  };
  const service = new ReminderService(db, async () => {
    if (shouldFail) return { accepted: false, error: 'WHATSAPP_DISCONNECTED' };
    return { accepted: true, status: 'sent' };
  });

  assert.throws(() => service.create('group@g.us', 'Study', Date.now() + 60_000));
  assert.throws(() => service.create('254700123456@c.us', '', Date.now() + 60_000));
  assert.throws(() => service.create('254700123456@c.us', 'Study', 'not a date'));
  service.create('254700123456@c.us', 'Study', Date.now() + 60_000);
  const failures = await service.tick();
  assert.deepEqual(failures, [{ id: 8 }]);
  const failureUpdate = calls.find(({ sql }) => sql.includes('delivery_attempts=delivery_attempts+1'));
  assert.equal(failureUpdate.args[0], 'WhatsApp delivery failed; retry is bounded.');
  assert.equal(failureUpdate.args[0].includes('private delivery detail'), false);

  shouldFail = false;
  const success = await service.tick();
  assert.deepEqual(success, []);
  assert.equal(calls.some(({ sql }) => sql.includes('SET notified=1,last_error=NULL')), true);
});

test('overlapping reminder ticks share one delivery attempt', async () => {
  let notifyCount = 0;
  let releaseDelivery;
  const pendingDelivery = new Promise((resolve) => { releaseDelivery = resolve; });
  const db = {
    prepare(sql) {
      return {
        all: () => sql.startsWith('SELECT id,user_id,text') ? [{
          id: 4,
          user_id: '254700123456@c.us',
          text: 'Pay rent',
        }] : [],
        run: () => ({ changes: 1 }),
      };
    },
  };
  const service = new ReminderService(db, async () => {
    notifyCount += 1;
    await pendingDelivery;
  });

  const first = service.tick();
  const second = service.tick();
  releaseDelivery();
  await Promise.all([first, second]);
  assert.equal(notifyCount, 1);
});
