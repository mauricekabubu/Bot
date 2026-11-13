import test from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../ai/agent.js";
import { GeminiProvider } from "../ai/gemini.js";

function recordingLogger() {
  const entries = [];
  return {
    entries,
    info: (event, metadata) => entries.push({ level: "info", event, metadata }),
    warn: (event, metadata) => entries.push({ level: "warn", event, metadata }),
    error: (event, metadata) => entries.push({ level: "error", event, metadata }),
  };
}

test("Gemini logs request and response diagnostics without logging input text", async () => {
  const logger = recordingLogger();
  const provider = new GeminiProvider({
    GEMINI_API_KEY: "test-key",
    GEMINI_MODEL: "test-model",
    MAX_OUTPUT_TOKENS: 200,
    TEMPERATURE: 0.2,
  }, logger);
  let request;
  provider.client = {
    models: {
      async generateContent(value) {
        request = value;
        return { text: "A useful response." };
      },
    },
  };
  assert.equal(await provider.generate({
    history: [],
    memories: [],
    text: "private input",
  }, { eventUuid: "event-1" }), "A useful response.");
  assert.equal(request.model, "test-model");
  assert.deepEqual(logger.entries.map(({ event }) => event), [
    "gemini_request_started",
    "gemini_response_received",
  ]);
  assert.equal(logger.entries[0].metadata.eventUuid, "event-1");
  assert.equal(logger.entries[1].metadata.responseLength, 18);
  assert.equal(JSON.stringify(logger.entries).includes("private input"), false);
});

test("Agent returns a generated answer if conversation persistence fails", async () => {
  const logger = recordingLogger();
  const agent = new Agent({
    conversation: {
      recent: () => [],
      add() { throw new Error("storage failed for private input"); },
    },
    longTerm: { list: () => [] },
    gemini: {
      config: { GEMINI_MODEL: "test-model" },
      async generate() { return "Reply from AI."; },
    },
    tools: new Map(),
    logger,
  });
  assert.equal(await agent.respond("opaque@lid", "private input", {
    eventUuid: "event-2",
  }), "Reply from AI.");
  const persistenceFailure = logger.entries.find(
    ({ event }) => event === "conversation_memory_persistence_failed",
  );
  assert.ok(persistenceFailure);
  assert.equal(JSON.stringify(persistenceFailure).includes("private input"), false);
  assert.ok(logger.entries.some(({ event }) => event === "ai_response_generated"));
});

test("Agent logs Gemini failures and returns a safe fallback", async () => {
  const logger = recordingLogger();
  const agent = new Agent({
    conversation: { recent: () => [], add() {} },
    longTerm: { list: () => [] },
    gemini: {
      config: { GEMINI_MODEL: "test-model" },
      async generate() { throw new Error("failed on private input"); },
    },
    tools: new Map(),
    logger,
  });
  const reply = await agent.respond("opaque@lid", "private input", {
    eventUuid: "event-3",
  });
  assert.match(reply, /AI service imepata issue/);
  const failure = logger.entries.find(({ event }) => event === "ai_response_generation_failed");
  assert.ok(failure);
  assert.equal(failure.metadata.errorMessage.includes("private input"), false);
  assert.ok(logger.entries.some(({ event }) => event === "ai_response_generated"));
});

test("Agent distinguishes an unconfigured Gemini provider", async () => {
  const agent = new Agent({
    conversation: { recent: () => [], add() {} },
    longTerm: { list: () => [] },
    gemini: { async generate() { throw new Error("GEMINI_NOT_CONFIGURED"); } },
    tools: new Map(),
    logger: recordingLogger(),
  });
  assert.match(
    await agent.respond("opaque@lid", "hello"),
    /Gemini haijaconfigurewa bado/,
  );
});
