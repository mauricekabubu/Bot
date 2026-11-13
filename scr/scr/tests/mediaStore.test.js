import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../memory/database.js';
import { IncomingMediaStore } from '../whatsapp/mediaStore.js';

async function withStore(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'atom-media-'));
  const db = openDatabase(path.join(directory, 'atom.db'));
  const mediaDirectory = path.join(directory, 'media');
  try {
    await run({ db, directory, mediaDirectory });
  } finally {
    if (db.open) db.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const makeStore = (db, directory) => new IncomingMediaStore({
  db,
  directory,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 5 * 1024 * 1024,
});

function mediaMessage(overrides = {}) {
  return {
    eventUuid: randomUUID(),
    chatId: '254700000001@c.us',
    whatsappMessageId: 'wa-media-1',
    mediaDownloadAvailable: true,
    type: 'image',
    downloadMedia: async () => ({
      data: Buffer.from('small media fixture').toString('base64'),
      mimetype: 'image/jpeg',
    }),
    ...overrides,
  };
}

test('downloads supported attachment types once and reuses the stored record after restart', async () => withStore(async ({ db, mediaDirectory }) => {
  const store = makeStore(db, mediaDirectory);
  const cases = [
    ['image', 'image/jpeg', '.jpg'],
    ['video', 'video/mp4', '.mp4'],
    ['document', 'application/pdf', '.pdf'],
    ['audio', 'audio/mpeg', '.mp3'],
    ['ptt', 'audio/ogg; codecs=opus', '.ogg'],
    ['sticker', 'image/webp', '.webp'],
  ];

  for (const [index, [type, mimetype, extension]] of cases.entries()) {
    let downloadCount = 0;
    const message = mediaMessage({
      eventUuid: `media-event-${index}`,
      whatsappMessageId: `wa-media-${index}`,
      type,
      downloadMedia: async () => {
        downloadCount += 1;
        return {
          data: Buffer.from(`${type} fixture`).toString('base64'),
          mimetype,
        };
      },
    });
    const result = await store.download(message);
    assert.equal(result.status, 'downloaded');
    assert.equal(path.extname(result.filePath), extension);
    assert.equal(downloadCount, 1);
    assert.equal((await fs.readFile(result.filePath)).toString(), `${type} fixture`);

    const restartedStore = makeStore(db, mediaDirectory);
    const duplicate = await restartedStore.download({
      ...message,
      eventUuid: `duplicate-event-${index}`,
      downloadMedia: async () => assert.fail('duplicate media must not download again'),
    });
    assert.equal(duplicate.status, 'downloaded');
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.filePath, result.filePath);
  }
  assert.equal(db.prepare(
    "SELECT COUNT(*) AS count FROM incoming_media WHERE status = 'downloaded'",
  ).get().count, cases.length);
}));

test('missing IDs and unavailable download APIs are recorded as skipped without inventing IDs', async () => withStore(async ({ db, mediaDirectory }) => {
  const store = makeStore(db, mediaDirectory);
  const missingId = await store.download(mediaMessage({
    eventUuid: 'missing-id-event',
    whatsappMessageId: null,
  }));
  const unavailable = await store.download(mediaMessage({
    eventUuid: 'unavailable-event',
    whatsappMessageId: 'wa-no-download',
    mediaDownloadAvailable: false,
  }));
  const oversized = mediaMessage({
    eventUuid: 'oversized-event',
    whatsappMessageId: 'wa-oversized',
    mediaSize: 2 * 1024 * 1024,
  });
  const oversizedFirst = await store.download(oversized);
  const oversizedDuplicate = await store.download({
    ...oversized,
    eventUuid: 'oversized-duplicate-event',
  });

  assert.equal(missingId.status, 'skipped');
  assert.equal(missingId.reason, 'MISSING_WHATSAPP_MESSAGE_ID');
  assert.equal(unavailable.status, 'skipped');
  assert.equal(unavailable.reason, 'MEDIA_DOWNLOAD_UNAVAILABLE');
  assert.equal(oversizedFirst.reason, 'MEDIA_FILE_SIZE_LIMIT_EXCEEDED');
  assert.equal(oversizedDuplicate.reason, 'MEDIA_FILE_SIZE_LIMIT_EXCEEDED');
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM incoming_media WHERE whatsapp_message_id = 'wa-oversized'
  `).get().count, 1);
  assert.deepEqual(db.prepare(`
    SELECT whatsapp_message_id, status, failure_code
    FROM incoming_media ORDER BY event_uuid
  `).all().filter((row) => row.whatsapp_message_id !== 'wa-oversized'), [
    {
      whatsapp_message_id: null,
      status: 'skipped',
      failure_code: 'MISSING_WHATSAPP_MESSAGE_ID',
    },
    {
      whatsapp_message_id: 'wa-no-download',
      status: 'skipped',
      failure_code: 'MEDIA_DOWNLOAD_UNAVAILABLE',
    },
  ]);
}));

test('expired or failed media downloads are recorded and can be investigated', async () => withStore(async ({ db, mediaDirectory }) => {
  const store = makeStore(db, mediaDirectory);
  const result = await store.download(mediaMessage({
    eventUuid: 'expired-media-event',
    downloadMedia: async () => {
      throw Object.assign(new Error('media expired'), { code: 'MEDIA_EXPIRED' });
    },
  }));
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'MEDIA_EXPIRED');
  assert.deepEqual(db.prepare(`
    SELECT status, reserved_bytes, failure_code
    FROM incoming_media WHERE event_uuid = 'expired-media-event'
  `).get(), {
    status: 'failed',
    reserved_bytes: 0,
    failure_code: 'MEDIA_EXPIRED',
  });
}));
