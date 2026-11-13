import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import {
  createWhatsAppClient,
  inspectWppMessageShape,
  normalizeWppMessage,
  resolveLidRecipient,
} from "../whatsapp/client.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} };

test("LID resolution requires an exact WPP mapping and a verified private chat", async () => {
  const calls = [];
  const client = {
    async getChatById(id) {
      calls.push(id);
      return {
        id: { _serialized: id },
        contact: { id },
        isUser: true,
        isGroup: false,
        isBroadcast: false,
        isReadOnly: false,
      };
    },
    async getPnLidEntry(lid) {
      calls.push(["mapping", lid]);
      return {
        lid: { _serialized: lid },
        phoneNumber: { _serialized: "254700123456@c.us" },
      };
    },
  };
  assert.equal(
    await resolveLidRecipient(client, "opaque-user@lid"),
    "254700123456@c.us",
  );
  assert.deepEqual(calls, [
    "opaque-user@lid",
    ["mapping", "opaque-user@lid"],
  ]);

  await assert.rejects(
    resolveLidRecipient({
      ...client,
      async getChatById(id) {
        return {
          id: { _serialized: id },
          contact: { id },
          isUser: false,
          isGroup: true,
        };
      },
    }, "opaque-user@lid"),
    { code: "LID_RECIPIENT_NOT_PRIVATE" },
  );

  await assert.rejects(
    resolveLidRecipient({
      ...client,
      async getPnLidEntry(lid) {
        return {
          lid: { _serialized: lid },
        };
      },
    }, "unknown-lid@lid"),
    { code: "LID_RECIPIENT_UNRESOLVED" },
  );
});

function createRecordingLogger() {
  const entries = [];
  return {
    entries,
    info: (event, metadata) => entries.push({ level: "info", event, metadata }),
    warn: (event, metadata) => entries.push({ level: "warn", event, metadata }),
    error: (event, metadata) => entries.push({ level: "error", event, metadata }),
  };
}

test("WPPConnect messages are normalized for the existing individual-chat handler", async () => {
  const calls = [];
  const client = {
    async getChatById(id) {
      calls.push(["chat", id]);
      return {
        id: { _serialized: id },
        isGroup: false,
        isBroadcast: false,
      };
    },
    async sendText(id, text) {
      calls.push(["send", id, text]);
    },
    async startTyping(id, duration) {
      calls.push(["typing", id, duration]);
    },
    async downloadMedia(id) {
      calls.push(["download", id]);
      return "data:text/plain;base64,aGVsbG8=";
    },
  };
  const incoming = normalizeWppMessage({
    id: "message-1",
    from: "254700123456@c.us",
    fromMe: false,
    body: "",
    type: "document",
    isMedia: true,
    mimetype: "text/plain",
    timestamp: 123,
  }, client);

  assert.equal(incoming.id._serialized, "message-1");
  assert.equal(incoming.originalId, "message-1");
  assert.equal(incoming.hasMedia, true);
  assert.equal(incoming.mediaMetadataPresent, true);
  assert.equal(incoming.mediaDownloadAvailable, true);
  assert.equal(incoming.type, "document");
  assert.equal(incoming.timestamp, 123);
  assert.equal(incoming.metadata.originalId, "message-1");
  const chat = await incoming.getChat();
  assert.deepEqual(chat.id, { _serialized: "254700123456@c.us" });
  assert.equal(chat.isGroup, false);
  assert.equal(chat.isBroadcast, false);
  await chat.sendStateTyping();
  await incoming.reply("received");
  assert.deepEqual(await incoming.downloadMedia(), {
    filename: "document.txt",
    mimetype: "text/plain",
    data: "aGVsbG8=",
  });
  assert.deepEqual(calls, [
    ["chat", "254700123456@c.us"],
    ["typing", "254700123456@c.us", 5_000],
    ["send", "254700123456@c.us", "received"],
    ["download", "message-1"],
  ]);
});

test("media type is distinguished from available media metadata and downloaded bytes", () => {
  const mediaOnlyByType = normalizeWppMessage({
    id: "image-id",
    from: "254700123456@c.us",
    type: "image",
    isMedia: false,
  }, { async downloadMedia() {} });
  assert.equal(mediaOnlyByType.hasMedia, true);
  assert.equal(mediaOnlyByType.mediaMetadataPresent, false);
  assert.equal(mediaOnlyByType.mediaDownloadAvailable, true);

  const imageWithMetadata = normalizeWppMessage({
    id: { _serialized: "image-id-with-media" },
    from: "254700123456@c.us",
    type: "image",
    isMedia: false,
    mimetype: "image/jpeg",
  }, { async downloadMedia() {} });
  assert.equal(imageWithMetadata.hasMedia, true);
  assert.equal(imageWithMetadata.mediaMetadataPresent, true);
  assert.equal(imageWithMetadata.mediaDownloadAvailable, true);

  const missingId = normalizeWppMessage({
    from: "254700123456@c.us",
    type: "image",
    isMedia: true,
    mimetype: "image/jpeg",
  }, {});
  assert.equal(missingId.hasMedia, true);
  assert.equal(missingId.mediaDownloadAvailable, false);
});

test("WPPConnect IDs and metadata use the installed serialized callback shape", () => {
  const incoming = normalizeWppMessage({
    id: "3EB0A1B2C3D4E5F6",
    chatId: { _serialized: "123456@newsletter" },
    author: "publisher@newsletter",
    type: "image",
    timestamp: 123,
    size: 2048,
    mimetype: "image/jpeg",
    isMedia: true,
  }, { async downloadMedia() { return "aGVsbG8="; } });

  assert.equal(incoming.whatsappMessageId, "3EB0A1B2C3D4E5F6");
  assert.equal(incoming.originalId, "3EB0A1B2C3D4E5F6");
  assert.equal(incoming.chatId, "123456@newsletter");
  assert.equal(incoming.author, "publisher@newsletter");
  assert.equal(incoming.timestamp, 123);
  assert.equal(incoming.mediaSize, 2048);
  assert.equal(incoming.mediaDownloadAvailable, true);
});

test("safe callback shape inspection reports field paths and types but no private values", () => {
  const shape = inspectWppMessageShape({
    id: { _serialized: "private-message-id", remote: "private-chat-id" },
    type: "image",
    mimetype: "image/jpeg",
    body: "private message body",
    from: "254700123456@c.us",
    mediaKey: "private-media-key",
    directPath: "private-media-url",
  });
  assert.ok(shape.some(({ path, type }) => path === "id._serialized" && type === "string"));
  assert.ok(shape.some(({ path, type }) => path === "mimetype" && type === "string"));
  assert.ok(shape.some(({ path, type }) => path === "directPath" && type === "string"));
  assert.equal(shape.some(({ path }) => /body|from|mediaKey/i.test(path)), false);
  assert.equal(JSON.stringify(shape).includes("private-media-url"), false);
  assert.equal(JSON.stringify(shape).includes("private message body"), false);
});

test("WPPConnect normalization preserves chat, participant, and event metadata", async () => {
  let fetchedChatId;
  const incoming = normalizeWppMessage({
    id: "original-message-id",
    from: "254700123456@c.us",
    chatId: { _serialized: "12345-67890@g.us" },
    author: "254700123456@c.us",
    fromMe: false,
    body: "group message",
    type: "chat",
    subtype: "",
    isGroupMsg: true,
    isNotification: false,
    isPSA: false,
    broadcast: false,
    isMedia: false,
    timestamp: 789,
  }, {
    async getChatById(id) {
      fetchedChatId = id;
      return { id: { _serialized: id }, isGroup: true };
    },
  });

  assert.equal(incoming.id._serialized, "original-message-id");
  assert.equal(incoming.originalId, "original-message-id");
  assert.equal(incoming.chatId, "12345-67890@g.us");
  assert.equal(incoming.author, "254700123456@c.us");
  assert.equal(incoming.isGroupMsg, true);
  assert.equal(incoming.metadata.subtype, "");
  const chat = await incoming.getChat();
  assert.equal(fetchedChatId, "12345-67890@g.us");
  assert.equal(chat.id._serialized, "12345-67890@g.us");
  assert.equal(chat.isGroup, true);
});

test("group messages preserve valid WhatsApp IDs and use no replacement ID when missing", () => {
  const client = {};
  const valid = normalizeWppMessage({
    id: "3EB0A1B2C3D4E5F6",
    from: "254700123456@c.us",
    chatId: "12345-67890@g.us",
    author: "254700123456@lid",
    type: "chat",
    t: 1_700_000_000,
  }, client);
  assert.equal(valid.chatId, "12345-67890@g.us");
  assert.equal(valid.author, "254700123456@lid");
  assert.equal(valid.id._serialized, "3EB0A1B2C3D4E5F6");
  assert.equal(valid.whatsappMessageId, "3EB0A1B2C3D4E5F6");
  assert.equal(valid.messageIdMissing, false);
  assert.equal(valid.timestamp, 1_700_000_000);

  const missing = normalizeWppMessage({
    from: "254700123456@c.us",
    chatId: "12345-67890@g.us",
    author: "254700123456@lid",
    type: "chat",
    t: 1_700_000_001,
  }, client);
  assert.equal(missing.id._serialized, "");
  assert.equal(missing.whatsappMessageId, null);
  assert.equal(missing.messageIdMissing, true);
  assert.match(missing.eventUuid, /^[0-9a-f-]{36}$/i);
  assert.notEqual(missing.eventUuid, valid.eventUuid);
});

test("WPPConnect adapter waits for login and forwards individual messages", async () => {
  let options;
  let onMessage;
  let onAck;
  let handlerMessage;
  let acknowledgement;
  const nativeClient = {
    async isConnected() { return true; },
    onStateChange() {},
    onMessage(callback) { onMessage = callback; },
    onAck(callback) { onAck = callback; },
    async sendText() {},
    async startTyping() {},
    async close() {},
  };
  const adapter = createWhatsAppClient({
    config: { WHATSAPP_SESSION_PATH: "C:\\data\\whatsapp-session" },
    handler: async (message) => { handlerMessage = message; },
    logger,
    outbound: { handleAck: (ack) => { acknowledgement = ack; } },
    createClient: async (value) => {
      options = value;
      return nativeClient;
    },
  });

  await adapter.initialize();
  assert.equal(options.session, "atom-maurice-test");
  assert.equal(options.waitForLogin, true);
  assert.equal(options.autoClose, 0);
  assert.equal(options.deviceSyncTimeout, 180_000);
  assert.equal(
    options.puppeteerOptions.userDataDir,
    path.join(
      process.env.LOCALAPPDATA || "C:\\data\\whatsapp-session",
      "Atom",
      "whatsapp-session",
      "session-atom-maurice-wppconnect",
    ),
  );
  assert.equal(adapter.isReady(), true);
  assert.equal(adapter.diagnostics().acknowledgementTrackingAvailable, true);
  assert.equal(adapter.diagnostics().canSend, true);
  onAck({ ack: 2, id: { _serialized: "sent-id" } });
  assert.equal(acknowledgement.ack, 2);

  await onMessage({
    id: "message-2",
    from: "254700123456@c.us",
    fromMe: false,
    body: "hello",
    type: "chat",
    isMedia: false,
    timestamp: 456,
  });
  assert.equal(handlerMessage.body, "hello");

  await adapter.destroy();
  assert.equal(adapter.isReady(), false);
});

test("outbound adapter delegates awaited sends to the initialized WPPConnect client", async () => {
  let releaseSend;
  let called = false;
  let invocation;
  const pending = new Promise((resolve) => { releaseSend = resolve; });
  const nativeClient = {
    async isConnected() { return true; },
    onStateChange() {},
    onMessage() {},
    async sendText(recipient, text) {
      called = true;
      invocation = { recipient, text };
      await pending;
      return { id: { _serialized: "native-client-send-id" } };
    },
    async close() {},
  };
  const adapter = createWhatsAppClient({
    config: { WHATSAPP_SESSION_PATH: "C:\\data\\whatsapp-session" },
    handler: async () => {},
    logger,
    createClient: async () => nativeClient,
  });
  await adapter.initialize();
  const client = adapter.client;
  let settled = false;
  const send = client.sendMessage("254700123456@c.us", "reply")
    .then((response) => {
      settled = true;
      return response;
    });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(adapter.isReady(), true);
  assert.equal(called, true);
  assert.deepEqual(invocation, {
    recipient: "254700123456@c.us",
    text: "reply",
  });
  assert.equal(settled, false);
  releaseSend();
  assert.deepEqual(await send, { id: { _serialized: "native-client-send-id" } });
  await adapter.destroy();
});

test("WPPConnect adapter supports installed getContact API and configurable sync timeout", async () => {
  let options;
  let lookedUp;
  const nativeClient = {
    async isConnected() { return true; },
    onStateChange() {},
    onMessage() {},
    async sendText() {},
    async getContact(id) {
      lookedUp = id;
      return { id, isWAContact: true, isMyContact: true, isBusiness: false };
    },
    async close() {},
  };
  const adapter = createWhatsAppClient({
    config: {
      WHATSAPP_SESSION_PATH: "C:\\data\\whatsapp-session",
      WHATSAPP_DEVICE_SYNC_TIMEOUT_MS: 300_000,
    },
    handler: async () => {},
    logger,
    createClient: async (value) => {
      options = value;
      return nativeClient;
    },
  });

  test("startup recovery uses the installed unread API and excludes known non-private chats", async () => {
    const events = createRecordingLogger();
    const received = [];
    const unread = [
      { id: { fromMe: false, remote: "123-456@g.us", _serialized: "group-1" }, type: "chat", t: 1 },
      { id: { fromMe: false, remote: "254700123456@c.us", _serialized: "private-1" }, from: "254700123456@c.us", body: "old private", type: "chat", t: 2 },
      { id: { fromMe: false, remote: "opaque-user@lid", _serialized: "lid-1" }, from: "opaque-user@lid", body: "old LID", type: "chat", t: 3 },
      { id: { fromMe: false, remote: "status@broadcast", _serialized: "status-1" }, type: "chat", t: 4 },
      { id: { fromMe: false, remote: "channel@newsletter", _serialized: "newsletter-1" }, type: "chat", t: 5 },
    ];
    let unreadCalls = 0;
    const nativeClient = {
      async isConnected() { return true; },
      onStateChange() {},
      onMessage() {},
      async getAllUnreadMessages() {
        unreadCalls += 1;
        return unread;
      },
      async close() {},
    };
    const adapter = createWhatsAppClient({
      config: {
        WHATSAPP_SESSION_PATH: "C:\\data\\whatsapp-session",
        WHATSAPP_UNREAD_RECOVERY_LIMIT: 10,
      },
      handler: async (message) => {
        received.push(message);
        return { status: "processed" };
      },
      logger: {
        ...events,
        debug: (event, metadata) => events.entries.push({ level: "debug", event, metadata }),
      },
      createClient: async () => nativeClient,
    });

    await adapter.initialize();
    const recovery = await adapter.recoverUnreadMessages();
    assert.equal(recovery.status, "completed");
    assert.equal(recovery.discovered, 5);
    assert.equal(recovery.processed, 2);
    assert.equal(recovery.skipped, 3);
    assert.equal(unreadCalls, 1);
    assert.deepEqual(received.map((message) => message.chatId), [
      "254700123456@c.us",
      "opaque-user@lid",
    ]);
    assert.equal(received[0].body, "old private");
    assert.equal(received[0].whatsappMessageId, "private-1");
    await adapter.destroy();
  });

  test("messages emitted before CONNECTED are queued and delivered after readiness", async () => {
    const events = createRecordingLogger();
    let onMessage;
    let onStateChange;
    const received = [];
    const nativeClient = {
      async isConnected() { return false; },
      onStateChange(callback) { onStateChange = callback; },
      onMessage(callback) { onMessage = callback; },
      async getAllUnreadMessages() { return []; },
      async close() {},
    };
    const adapter = createWhatsAppClient({
      config: { WHATSAPP_SESSION_PATH: "C:\\data\\whatsapp-session" },
      handler: async (message) => {
        received.push(message);
        return { status: "processed" };
      },
      logger: {
        ...events,
        debug: (event, metadata) => events.entries.push({ level: "debug", event, metadata }),
      },
      createClient: async () => nativeClient,
    });
    await adapter.initialize();
    assert.equal((await onMessage({
      id: "early-message",
      from: "254700123456@c.us",
      body: "hello",
      type: "chat",
    })).status, "queued");
    assert.equal(received.length, 0);
    onStateChange("CONNECTED");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(received.length, 1);
    assert.equal(received[0].whatsappMessageId, "early-message");
    assert.ok(events.entries.some(({ event }) => event === "whatsapp_message_queued_before_ready"));
    await adapter.destroy();
  });

  await adapter.initialize();
  assert.equal(options.deviceSyncTimeout, 300_000);
  assert.deepEqual(await adapter.lookupContact("254700123456@c.us"), {
    found: true,
    isBusiness: false,
    isMyContact: true,
  });
  assert.equal(lookedUp, "254700123456@c.us");
  await adapter.destroy();
});

test("debug callback diagnostics omit body, message IDs, and contact identifiers", async () => {
  const events = createRecordingLogger();
  let onMessage;
  const adapter = createWhatsAppClient({
    config: { WHATSAPP_SESSION_PATH: "C:\\data\\whatsapp-session", LOG_LEVEL: "debug" },
    handler: async () => {},
    logger: { ...events, debug: (event, metadata) => events.entries.push({ level: "debug", event, metadata }) },
    createClient: async () => ({
      async isConnected() { return true; },
      onStateChange() {},
      onMessage(callback) { onMessage = callback; },
      async downloadMedia() { return "aGVsbG8="; },
      async close() {},
    }),
  });
  await adapter.initialize();
  await onMessage({
    id: { _serialized: "private-message-id" },
    from: "254700123456@c.us",
    body: "private message body",
    type: "image",
    isMedia: false,
    mimetype: "image/jpeg",
  });
  const diagnostic = events.entries.find(({ event }) =>
    event === "whatsapp_incoming_message_shape");
  assert.equal(diagnostic.metadata.messageIdPresent, true);
  assert.equal(diagnostic.metadata.normalizedHasMedia, true);
  assert.equal(diagnostic.metadata.mediaDownloadAvailable, true);
  const serialized = JSON.stringify(diagnostic);
  assert.equal(serialized.includes("private-message-id"), false);
  assert.equal(serialized.includes("private message body"), false);
  assert.equal(serialized.includes("254700123456"), false);
  await adapter.destroy();
});

test("unexpected browser closure is logged as a disconnect without calling close", async () => {
  const events = createRecordingLogger();
  let onStatus;
  let closeCalls = 0;
  const nativeClient = {
    async isConnected() { return true; },
    onStateChange() {},
    onMessage() {},
    async sendText() {},
    async close() { closeCalls += 1; },
  };
  const adapter = createWhatsAppClient({
    config: { WHATSAPP_SESSION_PATH: "C:\\data\\whatsapp-session" },
    handler: async () => {},
    logger: events,
    createClient: async (options) => {
      onStatus = options.statusFind;
      return nativeClient;
    },
  });

  await adapter.initialize();
  assert.equal(adapter.isReady(), true);
  onStatus("browserClose", "atom-maurice-test");

  assert.equal(adapter.isReady(), false);
  assert.equal(closeCalls, 0);
  assert.deepEqual(
    events.entries.find(({ event }) => event === "whatsapp_browser_disconnected"),
    {
      level: "error",
      event: "whatsapp_browser_disconnected",
      metadata: {
        reason: "unexpected_browser_disconnect",
        status: "browserClose",
        session: "atom-maurice-test",
        lastState: "isLogged",
        intentional: false,
        shutdownReason: undefined,
      },
    },
  );
});

test("Puppeteer lifecycle diagnostics distinguish page closure, crashes, targets, browser and process exit", async () => {
  const events = createRecordingLogger();
  events.debug = (event, metadata) => events.entries.push({ level: "debug", event, metadata });
  const page = new EventEmitter();
  page.closed = false;
  page.isClosed = () => page.closed;
  page.close = async () => {};
  const browser = new EventEmitter();
  browser.connected = true;
  browser.isConnected = () => browser.connected;
  browser.close = async () => {};
  browser.disconnect = () => {};
  browser.process = () => browserProcess;
  const browserProcess = new EventEmitter();
  browserProcess.pid = 4567;
  browserProcess.exitCode = null;
  browserProcess.signalCode = null;
  const nativeClient = {
    waPage: page,
    async isConnected() { return true; },
    onStateChange() {},
    onMessage() {},
    async close() {},
  };
  page.browser = () => browser;
  const adapter = createWhatsAppClient({
    config: { WHATSAPP_SESSION_PATH: "C:\\data\\whatsapp-session" },
    handler: async () => {},
    logger: events,
    createClient: async () => nativeClient,
  });

  await adapter.initialize();
  const attached = events.entries.find(({ event }) =>
    event === "whatsapp_puppeteer_diagnostics_attached");
  assert.equal(attached.metadata.browserPid, 4567);
  assert.equal(attached.metadata.browserConnected, true);
  assert.equal(attached.metadata.pageClosed, false);
  assert.deepEqual(attached.metadata.listeners, {
    browserDisconnected: true,
    pageClose: true,
    pageCrash: true,
    pageError: true,
    targetDestroyed: true,
    targetCreated: true,
    browserCloseCall: true,
    browserDisconnectCall: true,
    processExit: true,
    processClose: true,
    processError: true,
  });

  page.closed = true;
  page.emit("close");
  page.emit("error", new Error("renderer crashed"));
  page.emit("pageerror", new Error("page script failed"));
  browser.emit("targetdestroyed", { type: () => "page" });
  browser.connected = false;
  browser.emit("disconnected");
  browserProcess.exitCode = 1;
  browserProcess.emit("exit", 1, null);
  browserProcess.emit("close", 1, null);
  browserProcess.emit("error", Object.assign(new Error("spawn failed"), { code: "EIO" }));

  const lifecycleEvents = events.entries
    .filter(({ event }) => event === "whatsapp_puppeteer_lifecycle")
    .map(({ metadata }) => metadata);
  assert.deepEqual(lifecycleEvents.map(({ event }) => event), [
    "page_closed",
    "page_crashed",
    "page_error",
    "browser_target_destroyed",
    "browser_disconnected",
    "browser_process_exit",
    "browser_process_close",
    "browser_process_error",
  ]);
  assert.ok(lifecycleEvents.every(({ browserPid, lastWhatsAppState, intentionalShutdown }) =>
    browserPid === 4567 &&
    lastWhatsAppState === "isLogged" &&
    intentionalShutdown === false));
  assert.equal(lifecycleEvents[0].pageClosed, true);
  assert.equal(lifecycleEvents[3].targetType, "page");
  assert.equal(lifecycleEvents[5].exitCode, 1);
  assert.equal(lifecycleEvents[5].signal, null);
  assert.equal(lifecycleEvents[7].errorCode, "EIO");
  await page.close();
  await browser.close();
  browser.disconnect();
  assert.deepEqual(
    events.entries
      .filter(({ event }) => event === "whatsapp_puppeteer_lifecycle")
      .slice(-3)
      .map(({ metadata }) => metadata.event),
    ["page_close_requested", "browser_close_requested", "browser_disconnect_requested"],
  );
  assert.ok(events.entries.some(({ event, metadata }) =>
    event === "whatsapp_puppeteer_close_call_stack" &&
    metadata.event === "page_close_requested" &&
    metadata.stack.includes("at ")));
  await adapter.destroy();
});

test("production browser and existing page diagnostics attach before WPPConnect starts", async () => {
  const browser = new EventEmitter();
  const browserProcess = new EventEmitter();
  browserProcess.pid = 7654;
  browserProcess.exitCode = null;
  browserProcess.signalCode = null;
  browser.isConnected = () => true;
  browser.process = () => browserProcess;
  const page = new EventEmitter();
  page.closed = false;
  page.isClosed = () => page.closed;
  page.browser = () => browser;
  browser.pages = async () => [page];
  let observedEarlyInstrumentation = false;
  const adapter = createWhatsAppClient({
    config: { WHATSAPP_SESSION_PATH: "C:\\data\\whatsapp-session" },
    handler: async () => {},
    logger: createRecordingLogger(),
    launchBrowser: async () => browser,
    closeLaunchedBrowser: async () => {},
    createClient: async (options) => {
      observedEarlyInstrumentation =
        options.browser === browser &&
        browser.listenerCount("disconnected") === 1 &&
        browserProcess.listenerCount("exit") === 1 &&
        page.listenerCount("close") === 1 &&
        page.listenerCount("error") === 1;
      return {
        waPage: page,
        async isConnected() { return true; },
        onStateChange() {},
        onMessage() {},
        async close() {},
      };
    },
  });

  await adapter.initialize();
  assert.equal(observedEarlyInstrumentation, true);
  await adapter.destroy("test_complete");
});

test("concurrent initialization creates a single WPPConnect session owner", async () => {
  let createCalls = 0;
  const nativeClient = {
    async isConnected() { return true; },
    onStateChange() {},
    onMessage() {},
    async close() {},
  };
  const adapter = createWhatsAppClient({
    config: { WHATSAPP_SESSION_PATH: "C:\\data\\whatsapp-session" },
    handler: async () => {},
    logger,
    createClient: async () => {
      createCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return nativeClient;
    },
  });

  await Promise.all([adapter.initialize(), adapter.initialize()]);
  assert.equal(createCalls, 1);
  await adapter.destroy("test_complete");
});

test("intentional application shutdown is logged and closes the client exactly once", async () => {
  const events = createRecordingLogger();
  let onStatus;
  let closeCalls = 0;
  const nativeClient = {
    async isConnected() { return true; },
    onStateChange() {},
    onMessage() {},
    async sendText() {},
    async close() {
      closeCalls += 1;
      onStatus("browserClose", "atom-maurice-test");
    },
  };
  const adapter = createWhatsAppClient({
    config: { WHATSAPP_SESSION_PATH: "C:\\data\\whatsapp-session" },
    handler: async () => {},
    logger: events,
    createClient: async (options) => {
      onStatus = options.statusFind;
      return nativeClient;
    },
  });

  await adapter.initialize();
  await Promise.all([adapter.destroy("SIGTERM"), adapter.destroy("SIGTERM")]);

  assert.equal(adapter.isReady(), false);
  assert.equal(closeCalls, 1);
  assert.ok(events.entries.some(({ event, metadata }) =>
    event === "whatsapp_browser_disconnected" &&
    metadata.reason === "application_shutdown" &&
    metadata.intentional === true &&
    metadata.shutdownReason === "SIGTERM"));
  assert.ok(events.entries.some(({ event, metadata }) =>
    event === "whatsapp_client_destroyed" && metadata.reason === "SIGTERM"));
});

test("shutdown requested during initialization closes the client when it becomes available", async () => {
  const events = createRecordingLogger();
  let resolveClient;
  let closeCalls = 0;
  const nativeClient = {
    async isConnected() { return true; },
    onStateChange() {},
    onMessage() {},
    async sendText() {},
    async close() { closeCalls += 1; },
  };
  const adapter = createWhatsAppClient({
    config: { WHATSAPP_SESSION_PATH: "C:\\data\\whatsapp-session" },
    handler: async () => {},
    logger: events,
    createClient: () => new Promise((resolve) => { resolveClient = resolve; }),
  });

  const initialization = adapter.initialize();
  await adapter.destroy("SIGTERM");
  resolveClient(nativeClient);
  await initialization;

  assert.equal(adapter.isReady(), false);
  assert.equal(closeCalls, 1);
  assert.ok(events.entries.some(({ event, metadata }) =>
    event === "whatsapp_client_destroyed" && metadata.reason === "SIGTERM"));
});
