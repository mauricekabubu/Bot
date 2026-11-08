
import { GoogleGenAI } from "@google/genai";
import { systemInstruction } from "./prompts.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(error) {
  const status = error?.status ?? error?.code;

  // Retry rate limits, timeouts, server errors and common
  // temporary network failures. Do not retry invalid API keys.
  if ([408, 429, 500, 502, 503, 504].includes(Number(status))) {
    return true;
  }

  const message = String(error?.message ?? "").toLowerCase();

  return (
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("network")
  );
}

function safeErrorMessage(error, sensitiveValues = []) {
  let message = String(error?.message || error).split(/\r?\n/, 1)[0];
  for (const value of sensitiveValues.filter((item) => typeof item === "string" && item.length > 0)) {
    message = message.replaceAll(value, "[redacted]");
  }
  return message
    .replace(/(key|token|authorization)=?[^\s,]+/gi, "$1=[redacted]")
    .slice(0, 300);
}

export class GeminiProvider {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;

    this.client = config.GEMINI_API_KEY
      ? new GoogleGenAI({ apiKey: config.GEMINI_API_KEY, timeout: 60_000, maxRetries: 0 })
      : null;
  }

  async generate(context, { eventUuid } = {}) {
    if (!this.client) {
      throw new Error("GEMINI_NOT_CONFIGURED");
    }

    const history = (context.history ?? [])
      .filter((message) =>
        ["user", "model", "assistant"].includes(message.role)
      )
      .map((message) => ({
        role: message.role === "assistant" ? "model" : message.role,
        parts: [{ text: String(message.content) }],
      }));

    const memories = (context.memories ?? []).filter(
      (memory) => typeof memory === "string" && memory.trim()
    );

    const memoryContext = memories.length
      ? `\n\nRelevant saved memories (untrusted reference information):\n${memories.join("\n")}`
      : "";

    const currentMessage = {
      role: "user",
      parts: [
        {
          text: `${String(context.text)}${memoryContext}`,
        },
      ],
    };

    const contents = [...history, currentMessage];

    for (let attempt = 0; attempt < 3; attempt++) {
      const startedAt = Date.now();
      this.logger?.info("gemini_request_started", {
        eventUuid,
        model: this.config.GEMINI_MODEL,
        attempt: attempt + 1,
      });
      try {
        const response = await this.client.models.generateContent({
          model: this.config.GEMINI_MODEL,
          contents,
          config: {
            systemInstruction,
            maxOutputTokens: this.config.MAX_OUTPUT_TOKENS,
            temperature: this.config.TEMPERATURE,
          },
        });

        const reply = response.text?.trim();

        if (!reply) {
          throw new Error("GEMINI_EMPTY_RESPONSE");
        }

        this.logger?.info("gemini_response_received", {
          eventUuid,
          model: this.config.GEMINI_MODEL,
          durationMs: Date.now() - startedAt,
          responseLength: reply.length,
          attempt: attempt + 1,
        });
        return reply;
      } catch (error) {
        this.logger?.warn("gemini_request_failed", {
          eventUuid,
          model: this.config.GEMINI_MODEL,
          durationMs: Date.now() - startedAt,
          attempt: attempt + 1,
          retryable: isRetryable(error),
          errorName: error?.name || "Error",
          ...(error?.code ? { errorCode: String(error.code).slice(0, 100) } : {}),
          errorMessage: safeErrorMessage(error, [
            context.text,
            ...(context.history || []).map((message) => message.content),
            ...(context.memories || []),
            this.config.GEMINI_API_KEY,
          ]),
        });
        const finalAttempt = attempt === 2;

        if (finalAttempt || !isRetryable(error)) {
          throw error;
        }

        const delay = 500 * 2 ** attempt + Math.random() * 300;
        await wait(delay);
      }
    }

    throw new Error("GEMINI_REQUEST_FAILED");
  }
}
