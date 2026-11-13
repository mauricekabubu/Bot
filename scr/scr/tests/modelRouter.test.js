import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { Agent } from "../ai/agent.js";
import { GeminiProvider } from "../ai/gemini.js";
import { AnthropicProvider, OllamaProvider, OpenAIProvider } from "../ai/providers.js";
import { ModelRouter } from "../ai/modelRouter.js";
import { migrateDatabase } from "../memory/database.js";
import { OutboundMessageService } from "../whatsapp/outbound.js";
import { createMessageHandler } from "../whatsapp/messageHandler.js";

function freshLogger() {
  return {
    entries: [],
    info(event, metadata) { this.entries.push({ level: "info", event, metadata }); },
    warn(event, metadata) { this.entries.push({ level: "warn", event, metadata }); },
    error(event, metadata) { this.entries.push({ level: "error", event, metadata }); },
  };
}

function createDatabase() {
  const db = new Database(":memory:");
  migrateDatabase(db);
  return db;
}

function mockProvider(id, action, {
  configured = true,
  model = `${id}-test-model`,
  models = [model],
} = {}) {
  const provider = {
    id,
    isConfigured: configured,
    models,
    capabilities: ["text", "conversation"],
    calls: [],
    async generate(context, options) {
      this.calls.push({ context, options });
      return action(context, options, this.calls.length);
    },
  };
  return provider;
}

function createRouter(db, providers, options = {}) {
  return new ModelRouter({
    db,
    providers,
    logger: options.logger || freshLogger(),
    priorities: options.priorities || providers.map(({ id }) => id),
    maxFailoverAttempts: options.maxFailoverAttempts ?? 3,
    sleep: options.sleep || (async () => {}),
    random: () => 0,
    baseRetryDelayMs: options.baseRetryDelayMs ?? 0,
    quotaCooldownMs: options.quotaCooldownMs ?? 60_000,
    now: options.now,
  });
}

function failure(status, code, message = "provider failure", extra = {}) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

const requestContext = {
  history: [{ role: "user", content: "prior conversation" }],
  memories: ["safe user preference"],
  text: "current message",
};

test("Gemini provider success returns normalized response and logs a correlation ID", async () => {
  const db = createDatabase();
  try {
    const log = freshLogger();
    const gemini = mockProvider("gemini", async () => ({
      text: "Gemini answer",
      provider: "gemini",
      model: "gemini-fast",
      usage: { inputTokens: 7, outputTokens: 3 },
      finishReason: "STOP",
      latencyMs: 12,
    }));
    const router = createRouter(db, [gemini], { logger: log });
    const result = await router.generate(requestContext, {
      userId: "private@c.us",
      eventUuid: "request-1",
    });
    assert.deepEqual(result, {
      text: "Gemini answer",
      provider: "gemini",
      model: "gemini-fast",
      usage: { inputTokens: 7, outputTokens: 3 },
      finishReason: "STOP",
      latencyMs: 12,
    });
    assert.ok(log.entries.some(({ event, metadata }) =>
      event === "ai_provider_request_started" && metadata.correlationId === "request-1"));
    const serializedLogs = JSON.stringify(log.entries);
    assert.equal(serializedLogs.includes(requestContext.text), false);
    assert.equal(serializedLogs.includes("private@c.us"), false);
    assert.equal(serializedLogs.includes("safe user preference"), false);
    assert.equal(db.prepare(
      "SELECT requests, successes, input_tokens, output_tokens FROM ai_model_usage",
    ).get().successes, 1);
  } finally {
    db.close();
  }
});

test("Gemini model list includes distinct configured fallbacks after the primary", () => {
  const provider = new GeminiProvider({
    GEMINI_API_KEY: "test-key",
    GEMINI_MODEL: "gemini-primary",
    GEMINI_FALLBACK_MODELS: "gemini-backup, gemini-primary, gemini-backup-2",
  });
  assert.deepEqual(provider.models, [
    "gemini-primary",
    "gemini-backup",
    "gemini-backup-2",
  ]);
});

test("primary Gemini model succeeds without trying fallback models or other providers", async () => {
  const db = createDatabase();
  try {
    const gemini = mockProvider("gemini", async (_context, options) => ({
      text: "primary answer",
      provider: "gemini",
      model: options.model,
    }), { models: ["gemini-primary", "gemini-backup"] });
    const openai = mockProvider("openai", async () => "unused");
    const router = createRouter(db, [gemini, openai]);
    const result = await router.generate(requestContext, { eventUuid: "primary-success" });
    assert.equal(result.model, "gemini-primary");
    assert.deepEqual(gemini.calls.map(({ options }) => options.model), ["gemini-primary"]);
    assert.equal(openai.calls.length, 0);
  } finally {
    db.close();
  }
});

test("retryable primary Gemini failure uses a different fallback model with the same context", async () => {
  const db = createDatabase();
  try {
    const gemini = mockProvider("gemini", async (context, options) => {
      if (options.model === "gemini-primary") throw failure(503, "SERVER_ERROR");
      return { text: "fallback answer", provider: "gemini", model: options.model };
    }, { models: ["gemini-primary", "gemini-fallback"] });
    const openai = mockProvider("openai", async () => "unused");
    const router = createRouter(db, [gemini, openai]);
    const result = await router.generate(requestContext, { eventUuid: "model-fallback" });
    assert.equal(result.text, "fallback answer");
    assert.deepEqual(gemini.calls.map(({ options }) => options.model), [
      "gemini-primary",
      "gemini-fallback",
    ]);
    assert.deepEqual(
      gemini.calls.map(({ context }) => ({
        history: context.history,
        memories: context.memories,
        text: context.text,
      })),
      [requestContext, requestContext],
    );
    assert.equal(openai.calls.length, 0);
    assert.ok(router.logger.entries.some(({ event, metadata }) =>
      event === "ai_model_failover_started" &&
      metadata.fromModel === "gemini-primary" &&
      metadata.toModel === "gemini-fallback" &&
      metadata.correlationId === "model-fallback"));
  } finally {
    db.close();
  }
});

test("Gemini primary and fallback models fail before OpenAI is tried", async () => {
  const db = createDatabase();
  try {
    const gemini = mockProvider("gemini", async () => {
      throw failure(503, "SERVER_ERROR");
    }, { models: ["gemini-primary", "gemini-fallback"] });
    const openai = mockProvider("openai", async () => "OpenAI response");
    const router = createRouter(db, [gemini, openai]);
    const result = await router.generate(requestContext, { eventUuid: "gemini-to-openai" });
    assert.equal(result.provider, "openai");
    assert.deepEqual(gemini.calls.map(({ options }) => options.model), [
      "gemini-primary",
      "gemini-fallback",
    ]);
    assert.equal(openai.calls.length, 1);
    assert.deepEqual(
      db.prepare("SELECT from_provider, to_provider, reason FROM ai_failover_events").get(),
      { from_provider: "gemini", to_provider: "openai", reason: "temporary" },
    );
  } finally {
    db.close();
  }
});

test("Gemini and OpenAI failures fall through to Claude after Gemini model fallbacks", async () => {
  const db = createDatabase();
  try {
    const gemini = mockProvider("gemini", async () => {
      throw failure(503, "SERVER_ERROR");
    }, { models: ["gemini-primary", "gemini-fallback"] });
    const openai = mockProvider("openai", async () => {
      throw failure(401, "INVALID_API_KEY");
    });
    const claude = mockProvider("claude", async () => "Claude response");
    const router = createRouter(db, [gemini, openai, claude]);
    const result = await router.generate(requestContext, { eventUuid: "claude-fallback" });
    assert.equal(result.provider, "claude");
    assert.deepEqual(gemini.calls.map(({ options }) => options.model), [
      "gemini-primary",
      "gemini-fallback",
    ]);
    assert.equal(openai.calls.length, 1);
    assert.equal(claude.calls.length, 1);
    assert.deepEqual(
      db.prepare("SELECT from_provider, to_provider FROM ai_failover_events ORDER BY id")
        .all().map(({ from_provider, to_provider }) => [from_provider, to_provider]),
      [["gemini", "openai"], ["openai", "claude"]],
    );
  } finally {
    db.close();
  }
});

test("missing OpenAI credentials skip that provider and continue to Claude", async () => {
  const db = createDatabase();
  try {
    const gemini = mockProvider("gemini", async () => {
      throw failure(503, "SERVER_ERROR");
    });
    const openai = mockProvider("openai", async () => "must not run", { configured: false });
    const claude = mockProvider("claude", async () => "Claude response");
    const logger = freshLogger();
    const router = createRouter(db, [gemini, openai, claude], { logger });
    const result = await router.generate(requestContext, { eventUuid: "missing-openai-key" });
    assert.equal(result.provider, "claude");
    assert.equal(openai.calls.length, 0);
    assert.ok(logger.entries.some(({ event, metadata }) =>
      event === "ai_router_provider_skipped" &&
      metadata.provider === "openai" &&
      metadata.reason === "not_configured"));
  } finally {
    db.close();
  }
});

test("empty Gemini responses are rejected and fall through to another Gemini model", async () => {
  const db = createDatabase();
  try {
    const gemini = mockProvider("gemini", async (_context, options) =>
      options.model === "gemini-primary"
        ? ""
        : "non-empty fallback", {
      models: ["gemini-primary", "gemini-fallback"],
    });
    const router = createRouter(db, [gemini]);
    const result = await router.generate(requestContext);
    assert.equal(result.text, "non-empty fallback");
    assert.deepEqual(gemini.calls.map(({ options }) => options.model), [
      "gemini-primary",
      "gemini-fallback",
    ]);
  } finally {
    db.close();
  }
});

test("quota failure across Gemini models cools down Gemini before the next message", async () => {
  const db = createDatabase();
  try {
    const gemini = mockProvider("gemini", async (_context, options) => {
      if (options.model === "gemini-primary") {
        throw failure(429, "insufficient_quota");
      }
      throw failure(503, "SERVER_ERROR");
    }, { models: ["gemini-primary", "gemini-fallback"] });
    const openai = mockProvider("openai", async () => "OpenAI response");
    const router = createRouter(db, [gemini, openai]);
    await router.generate(requestContext);
    await router.generate(requestContext);
    assert.deepEqual(gemini.calls.map(({ options }) => options.model), [
      "gemini-primary",
      "gemini-fallback",
    ]);
    assert.equal(router.providerState("gemini").availability, "cooldown");
    assert.equal(openai.calls.length, 2);
  } finally {
    db.close();
  }
});

test("Gemini quota exhaustion fails over immediately to OpenAI", async () => {
  const db = createDatabase();
  try {
    const gemini = mockProvider("gemini", async () => {
      throw failure(429, "RESOURCE_EXHAUSTED", "quota exhausted");
    });
    const openai = mockProvider("openai", async () => "OpenAI response");
    const router = createRouter(db, [gemini, openai]);
    const result = await router.generate(requestContext, { eventUuid: "quota-request" });
    assert.equal(result.provider, "openai");
    assert.equal(gemini.calls.length, 1);
    assert.equal(openai.calls.length, 1);
    assert.equal(router.providerState("gemini").availability, "cooldown");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ai_failover_events").get().count, 1);
  } finally {
    db.close();
  }
});

test("router tries Gemini then OpenAI and succeeds with Claude after provider failures", async () => {
  const db = createDatabase();
  try {
    const gemini = mockProvider("gemini", async () => {
      throw failure(401, "INVALID_API_KEY");
    });
    const openai = mockProvider("openai", async () => {
      throw failure(401, "INVALID_API_KEY");
    });
    const claude = mockProvider("claude", async () => "Claude response");
    const router = createRouter(db, [gemini, openai, claude]);
    const result = await router.generate(requestContext, { eventUuid: "three-provider" });
    assert.equal(result.provider, "claude");
    assert.deepEqual([gemini.calls.length, openai.calls.length, claude.calls.length], [1, 1, 1]);
    assert.deepEqual(
      db.prepare("SELECT from_provider, to_provider FROM ai_failover_events ORDER BY id")
        .all().map(({ from_provider, to_provider }) => [from_provider, to_provider]),
      [["gemini", "openai"], ["openai", "claude"]],
    );
  } finally {
    db.close();
  }
});

test("all provider failures produce a bounded aggregate error", async () => {
  const db = createDatabase();
  try {
    const providers = ["gemini", "openai", "claude", "ollama"].map((id) =>
      mockProvider(id, async () => { throw failure(401, "INVALID_API_KEY"); }));
    const router = createRouter(db, providers);
    await assert.rejects(
      router.generate(requestContext, { eventUuid: "all-fail" }),
      { code: "ALL_AI_PROVIDERS_FAILED" },
    );
    assert.deepEqual(providers.map(({ calls }) => calls.length), [1, 1, 1, 1]);
  } finally {
    db.close();
  }
});

test("invalid API keys and invalid model IDs disable that provider until reconfigured", async () => {
  const db = createDatabase();
  try {
    const provider = mockProvider("gemini", async () => {
      throw failure(401, "invalid_api_key");
    });
    const router = createRouter(db, [provider]);
    await assert.rejects(router.generate(requestContext), { code: "ALL_AI_PROVIDERS_FAILED" });
    assert.equal(router.providerState("gemini").availability, "misconfigured");
    await assert.rejects(router.generate(requestContext), { code: "ALL_AI_PROVIDERS_FAILED" });
    assert.equal(provider.calls.length, 1);

    const invalidModelDb = createDatabase();
    try {
      const invalidModel = mockProvider("openai", async () => {
        throw failure(404, "model_not_found");
      });
      const invalidModelRouter = createRouter(invalidModelDb, [invalidModel]);
      await assert.rejects(invalidModelRouter.generate(requestContext), {
        code: "ALL_AI_PROVIDERS_FAILED",
      });
      assert.equal(invalidModelRouter.providerState("openai").availability, "misconfigured");
    } finally {
      invalidModelDb.close();
    }
  } finally {
    db.close();
  }
});

test("temporary rate limits retry once and honor Retry-After", async () => {
  const db = createDatabase();
  try {
    const delays = [];
    const provider = mockProvider("openai", async (_context, _options, call) => {
      if (call === 1) throw failure(429, "rate_limit", "try later", { retryAfterMs: 1800 });
      return "recovered";
    });
    const router = createRouter(db, [provider], {
      sleep: async (delay) => delays.push(delay),
    });
    const response = await router.generate(requestContext);
    assert.equal(response.text, "recovered");
    assert.equal(provider.calls.length, 2);
    assert.deepEqual(delays, [1800]);
  } finally {
    db.close();
  }
});

test("temporary provider failures use bounded exponential backoff with jitter", async () => {
  const db = createDatabase();
  try {
    const delays = [];
    const provider = mockProvider("openai", async (_context, _options, call) => {
      if (call < 3) throw failure(503, "SERVER_ERROR");
      return "recovered after backoff";
    });
    const router = createRouter(db, [provider], {
      baseRetryDelayMs: 100,
      sleep: async (delay) => delays.push(delay),
    });
    assert.equal((await router.generate(requestContext)).text, "recovered after backoff");
    assert.equal(provider.calls.length, 3);
    assert.deepEqual(delays, [100, 200]);
    const usage = db.prepare("SELECT requests, failures, successes FROM ai_model_usage").get();
    assert.deepEqual(usage, { requests: 3, failures: 2, successes: 1 });
  } finally {
    db.close();
  }
});

test("concurrent messages keep their own text, history, and generated response", async () => {
  const db = createDatabase();
  try {
    const provider = mockProvider("gemini", async (context) => {
      await new Promise((resolve) => setTimeout(resolve, context.text === "first" ? 10 : 0));
      return `reply:${context.text}`;
    });
    const router = createRouter(db, [provider]);
    const firstContext = { ...requestContext, text: "first" };
    const secondContext = {
      ...requestContext,
      history: [{ role: "user", content: "other user's history" }],
      text: "second",
    };
    const [first, second] = await Promise.all([
      router.generate(firstContext, { userId: "first@c.us", eventUuid: "parallel-1" }),
      router.generate(secondContext, { userId: "second@c.us", eventUuid: "parallel-2" }),
    ]);
    assert.equal(first.text, "reply:first");
    assert.equal(second.text, "reply:second");
    assert.deepEqual(provider.calls.map(({ context }) => context.text).sort(), [
      "first",
      "second",
    ]);
    assert.equal(provider.calls.find(({ context }) => context.text === "second")
      .context.history[0].content, "other user's history");
  } finally {
    db.close();
  }
});

test("concurrent private WhatsApp messages send only their own AI responses", async () => {
  const db = createDatabase();
  try {
    const provider = mockProvider("gemini", async (context) => {
      await new Promise((resolve) => setTimeout(resolve, context.text === "first" ? 10 : 0));
      return `reply:${context.text}`;
    });
    const router = createRouter(db, [provider]);
    const histories = new Map();
    const agent = new Agent({
      conversation: {
        recent(userId) { return histories.get(userId) || []; },
        add(userId, role, content) {
          const history = histories.get(userId) || [];
          history.push({ role, content });
          histories.set(userId, history);
        },
      },
      longTerm: { list: () => [] },
      gemini: { config: { GEMINI_MODEL: "gemini-primary" } },
      router,
      tools: new Map(),
      logger: freshLogger(),
    });
    const sent = [];
    const handler = createMessageHandler({
      agent,
      limiter: { allow: () => true },
      logger: freshLogger(),
      config: { MAX_MESSAGE_LENGTH: 500, MAX_FILE_SIZE_MB: 1 },
      outbound: {
        async sendText(recipient, text) {
          sent.push({ recipient, text });
          return { ok: true, status: "sent", accepted: true };
        },
      },
    });
    const message = (sender, text, id) => ({
      from: sender,
      chatId: sender,
      body: text,
      id: { _serialized: id },
      type: "chat",
      hasMedia: false,
      getChat: async () => ({
        id: { _serialized: sender },
        isUser: true,
        isGroup: false,
      }),
    });
    await Promise.all([
      handler(message("first@c.us", "first", "incoming-first")),
      handler(message("second@c.us", "second", "incoming-second")),
    ]);
    assert.deepEqual(sent.sort((a, b) => a.recipient.localeCompare(b.recipient)), [
      { recipient: "first@c.us", text: "reply:first" },
      { recipient: "second@c.us", text: "reply:second" },
    ]);
  } finally {
    db.close();
  }
});

test("quota failure is not retried and cooldown suppresses the provider on the next request", async () => {
  const db = createDatabase();
  try {
    let now = Date.now();
    const gemini = mockProvider("gemini", async () => {
      throw failure(429, "insufficient_quota");
    });
    const openai = mockProvider("openai", async () => "fallback");
    const router = createRouter(db, [gemini, openai], {
      now: () => now,
      quotaCooldownMs: 60_000,
    });
    await router.generate(requestContext);
    await router.generate(requestContext);
    assert.equal(gemini.calls.length, 1);
    assert.equal(openai.calls.length, 2);
    assert.equal(router.providerState("gemini").availability, "cooldown");
    now += 60_001;
    await router.generate(requestContext);
    assert.equal(gemini.calls.length, 2);
  } finally {
    db.close();
  }
});

test("conversation history and memories remain intact during provider switching", async () => {
  const db = createDatabase();
  try {
    let now = Date.now();
    const gemini = mockProvider("gemini", async () => "first response");
    const openai = mockProvider("openai", async () => "second response");
    const router = createRouter(db, [gemini, openai], { now: () => now });
    await router.generate(requestContext, { userId: "person@c.us" });
    await router.setGlobalSelection("openai");
    const next = {
      ...requestContext,
      history: [...requestContext.history, { role: "model", content: "first response" }],
    };
    await router.generate(next, { userId: "person@c.us" });
    assert.deepEqual(gemini.calls[0].context.history, requestContext.history);
    assert.deepEqual(openai.calls[0].context.history, next.history);
    assert.equal(openai.calls[0].context.memories[0], "safe user preference");
    now += 1;
  } finally {
    db.close();
  }
});

test("per-contact model preferences override global selection without changing it", async () => {
  const db = createDatabase();
  try {
    const gemini = mockProvider("gemini", async () => "gemini");
    const openai = mockProvider("openai", async () => "openai");
    const router = createRouter(db, [gemini, openai]);
    await router.setContactPreference("preferred@lid", "openai");
    assert.equal((await router.generate(requestContext, { userId: "preferred@lid" })).provider, "openai");
    assert.equal((await router.generate(requestContext, { userId: "other@c.us" })).provider, "gemini");
    assert.equal(router.getGlobalConfig().mode, "auto");
    await router.setGlobalSelection("openai");
    await router.setContactPreference("preferred@lid", "auto");
    assert.equal((await router.generate(requestContext, { userId: "preferred@lid" })).provider, "gemini");
    assert.equal((await router.generate(requestContext, { userId: "other@c.us" })).provider, "openai");
    await assert.rejects(router.setContactPreference("group@g.us", "openai"), {
      message: "INVALID_AI_CONTACT",
    });
  } finally {
    db.close();
  }
});

test("global and contact model configuration survives router reconstruction", async () => {
  const db = createDatabase();
  try {
    const providers = [
      mockProvider("gemini", async () => "gemini"),
      mockProvider("openai", async () => "openai"),
    ];
    const first = createRouter(db, providers);
    await first.setGlobalSelection("openai");
    await first.setContactPreference("admin@c.us", "gemini");
    first.setPriorities(["openai", "gemini"]);
    const second = createRouter(db, providers, { priorities: ["gemini", "openai"] });
    assert.equal(second.getStatus().mode, "manual");
    assert.equal(second.getStatus().activeProvider, "openai");
    assert.deepEqual(second.getStatus().priorities.slice(0, 2), ["openai", "gemini"]);
    assert.deepEqual(second.getContactPreference("admin@c.us"), {
      mode: "manual",
      provider: "gemini",
      model: "gemini-test-model",
    });
  } finally {
    db.close();
  }
});

test("administrator model commands are authorized and non-admin commands cannot change config", async () => {
  const db = createDatabase();
  try {
    const gemini = mockProvider("gemini", async () => "unused");
    const openai = mockProvider("openai", async () => "unused");
    const router = createRouter(db, [gemini, openai]);
    const replies = [];
    const handler = createMessageHandler({
      agent: { async respond() { assert.fail("model command must not reach AI"); } },
      limiter: { allow: () => true },
      logger: freshLogger(),
      config: { MAX_MESSAGE_LENGTH: 500, MAX_FILE_SIZE_MB: 1 },
      modelRouter: router,
      adminContacts: ["admin@c.us"],
      outbound: {
        async sendText(recipient, text) {
          replies.push({ recipient, text });
          return { ok: true, status: "sent", accepted: true };
        },
      },
    });
    const message = (from, body, id) => ({
      from,
      chatId: from,
      body,
      id: { _serialized: id },
      type: "chat",
      hasMedia: false,
      getChat: async () => ({
        id: { _serialized: from },
        isUser: true,
        isGroup: false,
      }),
    });
    await handler(message("intruder@c.us", "/model openai", "command-unauthorized"));
    assert.equal(router.getGlobalConfig().mode, "auto");
    assert.match(replies[0].text, /administrator pekee/);

    await handler(message("admin@c.us", "/model openai", "command-authorized"));
    assert.equal(router.getGlobalConfig().provider, "openai");
    assert.match(replies[1].text, /openai/);

    await handler(message("admin@c.us", "/model status", "command-status"));
    assert.match(replies[2].text, /Providers:/);
    assert.match(replies[2].text, /openai-test-model/);

    await handler(message(
      "admin@c.us",
      "/model priority openai,gemini",
      "command-priority",
    ));
    assert.deepEqual(router.getStatus().priorities.slice(0, 2), ["openai", "gemini"]);
    assert.match(replies[3].text, /openai → gemini/);
  } finally {
    db.close();
  }
});

test("provider adapters normalize mocked OpenAI, Claude, and Ollama responses", async () => {
  const fakeFetch = async (url, options) => {
    const body = JSON.parse(options.body);
    assert.ok(body.messages.at(-1).content.endsWith("current message"));
    const responseBody = url.endsWith("/api/chat")
      ? {
          model: body.model,
          message: { content: "Ollama answer" },
          prompt_eval_count: 9,
          eval_count: 4,
          done_reason: "stop",
        }
      : url.endsWith("/v1/messages")
        ? {
            model: body.model,
            content: [{ type: "text", text: "Claude answer" }],
            usage: { input_tokens: 8, output_tokens: 3 },
            stop_reason: "end_turn",
          }
        : {
            model: body.model,
            choices: [{
              message: { content: "OpenAI answer" },
              finish_reason: "stop",
            }],
            usage: { prompt_tokens: 7, completion_tokens: 2 },
          };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      async json() { return responseBody; },
    };
  };
  const config = {
    OPENAI_API_KEY: "test-openai-key",
    OPENAI_MODEL: "openai-model",
    ANTHROPIC_API_KEY: "test-claude-key",
    ANTHROPIC_MODEL: "claude-model",
    OLLAMA_BASE_URL: "http://127.0.0.1:11434",
    OLLAMA_MODEL: "ollama-model",
    AI_PROVIDER_TIMEOUT_MS: 5000,
  };
  const providers = [
    new OpenAIProvider(config, { fetchImpl: fakeFetch }),
    new AnthropicProvider(config, { fetchImpl: fakeFetch }),
    new OllamaProvider(config, { fetchImpl: fakeFetch }),
  ];
  for (const [provider, expected, finishReason] of providers.map((provider, index) =>
    [provider, ["OpenAI answer", "Claude answer", "Ollama answer"][index],
      ["stop", "end_turn", "stop"][index]])) {
    const response = await provider.generate(requestContext);
    assert.equal(response.text, expected);
    assert.equal(response.provider, provider.id);
    assert.ok(response.usage.inputTokens > 0);
    assert.ok(response.usage.outputTokens > 0);
    assert.equal(response.finishReason, finishReason);
  }
});

test("AI router feeds the existing outbound service without introducing a second sender", async () => {
  const db = createDatabase();
  try {
    const provider = mockProvider("gemini", async () => ({
      text: "reply through existing service",
      provider: "gemini",
      model: "gemini-test-model",
      usage: { inputTokens: 1, outputTokens: 2 },
    }));
    const router = createRouter(db, [provider]);
    const conversation = {
      recent: () => [],
      add() {},
    };
    const agent = new Agent({
      conversation,
      longTerm: { list: () => [] },
      gemini: { config: { GEMINI_MODEL: "legacy" } },
      router,
      tools: new Map(),
      logger: freshLogger(),
    });
    const sent = [];
    const outbound = new OutboundMessageService({
      db,
      getClient: () => ({
        async sendMessage(recipient, text) {
          sent.push({ recipient, text });
          return { id: { _serialized: "routed-reply-id" } };
        },
      }),
      isReady: () => true,
      logger: freshLogger(),
    });
    const handler = createMessageHandler({
      agent,
      limiter: { allow: () => true },
      logger: freshLogger(),
      config: { MAX_MESSAGE_LENGTH: 500, MAX_FILE_SIZE_MB: 1 },
      outbound,
    });
    const sender = "254700123456@c.us";
    const result = await handler({
      from: sender,
      chatId: sender,
      body: "hello",
      id: { _serialized: "routed-incoming-id" },
      type: "chat",
      hasMedia: false,
      getChat: async () => ({
        id: { _serialized: sender },
        isUser: true,
        isGroup: false,
      }),
    });
    assert.equal(result.status, "processed");
    assert.deepEqual(sent, [{
      recipient: sender,
      text: "reply through existing service",
    }]);
    assert.equal(db.prepare("SELECT message_id FROM outbound_messages").get().message_id, "routed-reply-id");
  } finally {
    db.close();
  }
});
