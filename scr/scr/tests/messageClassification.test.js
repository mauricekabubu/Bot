import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../memory/database.js";
import { classifyWhatsAppMessage } from "../whatsapp/messageClassification.js";
import { createMessageHandler } from "../whatsapp/messageHandler.js";
import { NewsletterStore } from "../whatsapp/newsletterStore.js";
import { classifyIncomingMessage } from "../whatsapp/messageFilter.js";

test("classifies an individual using the actual WPPConnect chatId", () => {
  assert.deepEqual(classifyWhatsAppMessage({
    from: "group@g.us",
    chatId: "254700123456@c.us",
    id: "individual-1",
  }), {
    conversationType: "individual",
    reason: "individual-contact",
    chatId: "254700123456@c.us",
    participantId: "",
    pipeline: "customer",
  });
});

test("classifies groups and retains the actual author as participant", () => {
  assert.deepEqual(classifyWhatsAppMessage({
    from: "fallback@c.us",
    chatId: { _serialized: "12345-67890@g.us" },
    author: "254700123456@c.us",
    isGroupMsg: true,
  }), {
    conversationType: "group",
    reason: "group-message",
    chatId: "12345-67890@g.us",
    participantId: "254700123456@c.us",
    pipeline: "exclude",
  });
});

test("group messages without a participant remain groups and do not enter customer handling", () => {
  const result = classifyWhatsAppMessage({
    chatId: "12345-67890@g.us",
    from: "254700123456@c.us",
    isGroupMsg: true,
  });
  assert.equal(result.conversationType, "group");
  assert.equal(result.chatId, "12345-67890@g.us");
  assert.equal(result.participantId, "");
  assert.equal(result.pipeline, "exclude");
});

test("verified LID one-to-one chats are accepted but LID participants are not conversations", async () => {
  const message = {
    chatId: "opaque-user@lid",
    from: "opaque-user@lid",
    type: "chat",
    body: "hello",
    chatMetadata: { id: "opaque-user@lid", isUser: true, isGroup: false },
    getChat: async () => ({
      id: { _serialized: "opaque-user@lid" },
      isUser: true,
      isGroup: false,
      isBroadcast: false,
      isStatus: false,
    }),
  };
  const accepted = await classifyIncomingMessage(message, (item) => item.getChat());
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.userId, "opaque-user@lid");
  assert.equal(accepted.classification.reason, "verified-lid-contact");

  const resolvedAlias = await classifyIncomingMessage({
    ...message,
    chatMetadata: undefined,
    getChat: async () => ({
      id: { _serialized: "254700123456@c.us" },
      contact: { id: "opaque-user@lid" },
      isUser: true,
      isGroup: false,
      isBroadcast: false,
      isStatus: false,
    }),
  }, (item) => item.getChat());
  assert.equal(resolvedAlias.accepted, true);
  assert.equal(resolvedAlias.userId, "254700123456@c.us");

  const groupParticipant = classifyWhatsAppMessage({
    chatId: "opaque-user@lid",
    author: "opaque-user@lid",
    isGroupMsg: true,
    chatMetadata: { id: "opaque-user@lid", isUser: true, isGroup: false },
  });
  assert.equal(groupParticipant.pipeline, "exclude");
  const unverified = await classifyIncomingMessage({
    ...message,
    chatMetadata: undefined,
    getChat: async () => ({
      id: { _serialized: "opaque-user@lid" },
      isUser: false,
      isGroup: false,
    }),
  }, (item) => item.getChat());
  assert.equal(unverified.accepted, false);
});

test("classifies newsletters independently from customer chats", () => {
  assert.equal(classifyWhatsAppMessage({
    from: "254700123456@c.us",
    chatId: "123456@newsletter",
    author: "publisher@newsletter",
  }).conversationType, "newsletter");
  assert.equal(classifyWhatsAppMessage({
    chatId: "123456@newsletter",
  }).pipeline, "store-newsletter");
});

test("classifies status broadcasts without treating them as contacts", () => {
  for (const chatId of ["status@broadcast", "123456@broadcast"]) {
    assert.equal(classifyWhatsAppMessage({ chatId }).conversationType, "status");
    assert.equal(classifyWhatsAppMessage({ chatId }).pipeline, "exclude");
  }
  assert.equal(classifyWhatsAppMessage({
    chatId: "254700123456@c.us",
    broadcast: true,
  }).conversationType, "status");
});

test("classifies system and unknown events for safe logging", () => {
  assert.equal(classifyWhatsAppMessage({
    chatId: "service@c.us",
    isNotification: true,
  }).conversationType, "system");
  for (const type of ["protocol", "notification_template", "group_notification"]) {
    const result = classifyWhatsAppMessage({ chatId: "service@c.us", type });
    assert.equal(result.conversationType, "system");
    assert.equal(result.pipeline, "log");
  }
  assert.equal(classifyWhatsAppMessage({
    chatId: "opaque@lid",
    type: "future-event",
  }).conversationType, "unknown");
  assert.equal(classifyWhatsAppMessage(null).conversationType, "unknown");
});

test("newsletter updates persist separately with original IDs and metadata", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atom-newsletter-"));
  const db = openDatabase(path.join(directory, "test.db"));
  try {
    const store = new NewsletterStore(db);
    const message = {
      id: { _serialized: "newsletter-msg-1" },
      chatId: "123456@newsletter",
      author: "publisher@newsletter",
      type: "chat",
      body: "Channel update",
      timestamp: 123,
      metadata: { originalId: "newsletter-msg-1", subtype: "" },
    };

    const stored = store.record(message);
    assert.equal(stored.inserted, true);
    assert.equal(stored.duplicate, false);
    assert.equal(store.record(message).duplicate, true);
    assert.deepEqual(db.prepare(`
      SELECT event_uuid, whatsapp_message_id, missing_whatsapp_message_id,
        channel_id, author_id, message_type, body, timestamp, metadata_json
      FROM newsletter_updates
    `).get(), {
      event_uuid: stored.eventUuid,
      whatsapp_message_id: "newsletter-msg-1",
      missing_whatsapp_message_id: 0,
      channel_id: "123456@newsletter",
      author_id: "publisher@newsletter",
      message_type: "chat",
      body: "Channel update",
      timestamp: 123,
      metadata_json: JSON.stringify(message.metadata),
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages").get().count, 0);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("newsletter updates without WhatsApp IDs receive distinct internal UUIDs", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atom-newsletter-no-id-"));
  const db = openDatabase(path.join(directory, "test.db"));
  try {
    const store = new NewsletterStore(db);
    const message = {
      id: { _serialized: "" },
      whatsappMessageId: null,
      messageIdMissing: true,
      chatId: "123456@newsletter",
      body: "same update",
    };

    const first = store.record(message);
    const second = store.record(message);
    assert.equal(first.inserted, true);
    assert.equal(first.missingWhatsAppMessageId, true);
    assert.equal(first.whatsappMessageId, null);
    assert.notEqual(first.eventUuid, second.eventUuid);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM newsletter_updates
      WHERE whatsapp_message_id IS NULL AND missing_whatsapp_message_id = 1
    `).get().count, 2);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("only individual contacts enter the customer pipeline; other events are logged", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atom-classifier-"));
  const db = openDatabase(path.join(directory, "test.db"));
  const events = [];
  let agentCalls = 0;
  const logger = {
    debug: (event, metadata) => events.push({ event, metadata }),
    info: (event, metadata) => events.push({ event, metadata }),
    warn: (event, metadata) => events.push({ event, metadata }),
    error: (event, metadata) => events.push({ event, metadata }),
  };
  const handler = createMessageHandler({
    agent: { async respond() { agentCalls += 1; return "reply"; } },
    limiter: { allow: () => true },
    logger,
    config: { MAX_MESSAGE_LENGTH: 100, MAX_FILE_SIZE_MB: 1 },
    newsletterStore: new NewsletterStore(db),
  });

  try {
    await handler({
      chatId: "12345-67890@g.us",
      author: "254700123456@c.us",
      id: { _serialized: "group-msg" },
      body: "group text",
    });
    await handler({
      chatId: "123456@newsletter",
      author: "publisher@newsletter",
      id: { _serialized: "channel-msg" },
      body: "channel text",
      metadata: { originalId: "channel-msg" },
    });
    await handler({
      chatId: "status@broadcast",
      id: { _serialized: "status-msg" },
      body: "status text",
    });
    await handler({
      chatId: "opaque@lid",
      id: { _serialized: "unknown-msg" },
      type: "future-event",
      body: "unknown text",
    });

    assert.equal(agentCalls, 0);
    assert.deepEqual(handler.getDiagnosticsSummary(), {
      eventsReceived: 4,
      privateIncomingCandidates: 1,
      privateMessagesRejected: 1,
      privateMessagesVerified: 0,
      groupEvents: 1,
      newsletterEvents: 1,
      aiProcessingStarted: 0,
      outboundReplyAttempts: 0,
    });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM newsletter_updates").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages").get().count, 0);
    assert.deepEqual(events.map(({ event }) => event), [
      "ai_model_admins_not_configured",
      "whatsapp_handler_diagnostics_summary",
      "whatsapp_group_event_received",
      "whatsapp_non_customer_event_received",
      "whatsapp_message_classification_result",
      "whatsapp_newsletter_event_received",
      "whatsapp_newsletter_update_stored",
      "whatsapp_non_customer_event_received",
      "whatsapp_message_classification_result",
      "whatsapp_private_message_rejected",
      "whatsapp_unknown_event_received",
      "whatsapp_message_classification_result",
    ]);
    assert.equal(
      events.find(({ event }) => event === "whatsapp_non_customer_event_received")
        .metadata.participantId,
      "********3456@c.us",
    );
    assert.equal(
      events.find(({ event }) => event === "whatsapp_unknown_event_received")
        .metadata.hasBody,
      true,
    );
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("private messages rejected by chat verification are explicitly distinguished", async () => {
  const events = [];
  const handler = createMessageHandler({
    agent: { async respond() { assert.fail("unverified chat must not reach AI"); } },
    limiter: { allow: () => true },
    logger: {
      debug() {},
      info: (event, metadata) => events.push({ event, metadata }),
      warn: (event, metadata) => events.push({ event, metadata }),
      error() {},
    },
    config: { MAX_MESSAGE_LENGTH: 100, MAX_FILE_SIZE_MB: 1 },
  });
  const result = await handler({
    chatId: "254700123456@c.us",
    body: "hello",
    type: "chat",
    id: { _serialized: "unverified-message" },
    getChat: async () => { throw new Error("chat lookup unavailable"); },
  });
  assert.equal(result.status, "skipped");
  assert.ok(events.some(({ event, metadata }) =>
    event === "whatsapp_private_message_rejected" &&
    metadata.rejectionStage === "chat-verification"));
});

test("media storage is limited to accepted individual-customer conversations", async () => {
  const stored = [];
  const handler = createMessageHandler({
    agent: { async respond() { return "reply"; } },
    limiter: { allow: () => true },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    config: { MAX_MESSAGE_LENGTH: 100, MAX_FILE_SIZE_MB: 1 },
    mediaStore: {
      async download(message) {
        stored.push(message.chatId);
        return { status: "skipped", reason: "test" };
      },
    },
  });
  const incoming = (chatId, suffix) => ({
    chatId,
    from: chatId,
    fromMe: false,
    body: "",
    type: "image",
    hasMedia: true,
    id: { _serialized: `media-${suffix}` },
    eventUuid: `event-${suffix}`,
    whatsappMessageId: `media-${suffix}`,
    getChat: async () => ({
      id: { _serialized: chatId },
      isUser: chatId.endsWith("@c.us"),
      isGroup: chatId.endsWith("@g.us"),
      isBroadcast: chatId.endsWith("@broadcast"),
      isStatus: chatId === "status@broadcast",
      sendStateTyping: async () => {},
    }),
    reply: async () => {},
  });

  await handler(incoming("12345-67890@g.us", "group"));
  await handler(incoming("status@broadcast", "status"));
  await handler(incoming("123456@newsletter", "newsletter"));
  await handler(incoming("254700123456@c.us", "individual"));
  assert.deepEqual(stored, ["254700123456@c.us"]);
});

test("newsletter persistence failures log structured diagnostics without message content", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atom-newsletter-failure-"));
  const db = openDatabase(path.join(directory, "test.db"));
  const events = [];
  try {
    db.exec(`
      CREATE TRIGGER fail_newsletter_insert
      BEFORE INSERT ON newsletter_updates
      BEGIN
        SELECT RAISE(FAIL, 'newsletter persistence test failure');
      END;
    `);
    const store = new NewsletterStore(db);
    const handler = createMessageHandler({
      agent: { async respond() { assert.fail("newsletter reached AI"); } },
      limiter: { allow: () => true },
      logger: {
        debug: (event, metadata) => events.push({ level: "debug", event, metadata }),
        info: (event, metadata) => events.push({ level: "info", event, metadata }),
        warn: (event, metadata) => events.push({ level: "warn", event, metadata }),
        error: (event, metadata) => events.push({ level: "error", event, metadata }),
      },
      config: { LOG_LEVEL: "debug" },
      newsletterStore: store,
    });

    await handler({
      chatId: "123456@newsletter",
      id: { _serialized: "newsletter-id" },
      body: "private newsletter text",
      eventUuid: "event-for-failed-write",
    });

    const failure = events.find(({ event }) =>
      event === "whatsapp_newsletter_update_store_failed");
    assert.equal(failure.metadata.errorName, "SqliteError");
    assert.match(failure.metadata.errorMessage, /newsletter persistence test failure/);
    assert.equal(failure.metadata.errorCode, "SQLITE_CONSTRAINT_TRIGGER");
    assert.equal(failure.metadata.eventUuid, "event-for-failed-write");
    assert.equal(JSON.stringify(failure).includes("private newsletter text"), false);
    assert.ok(events.some(({ event, metadata }) =>
      event === "whatsapp_newsletter_update_store_error_details" &&
      typeof metadata.stack === "string"));
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
