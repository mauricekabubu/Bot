
import { GoogleGenAI } from "@google/genai";
import { systemInstruction } from "./prompts.js";

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
      ? new GoogleGenAI({
          apiKey: config.GEMINI_API_KEY,
          timeout: config.AI_PROVIDER_TIMEOUT_MS || 60_000,
          maxRetries: 0,
        })
      : null;
  }

  get id() {
    return "gemini";
  }

  get isConfigured() {
    return Boolean(this.client);
  }

  get models() {
    const fallbacks = Array.isArray(this.config.GEMINI_FALLBACK_MODELS)
      ? this.config.GEMINI_FALLBACK_MODELS
      : String(this.config.GEMINI_FALLBACK_MODELS || "").split(",");
    return [...new Set([
      this.config.GEMINI_MODEL,
      ...fallbacks.map((model) => String(model).trim()).filter(Boolean),
    ])];
  }

  get capabilities() {
    return ["text", "conversation"];
  }

  async generate(
    context,
    { eventUuid, model = this.config.GEMINI_MODEL, normalized = false } = {},
  ) {
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

    const startedAt = Date.now();
    this.logger?.info("gemini_request_started", {
      eventUuid,
      model,
    });
    try {
      const response = await this.client.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
          maxOutputTokens: context.maxOutputTokens ?? this.config.MAX_OUTPUT_TOKENS,
          temperature: context.temperature ?? this.config.TEMPERATURE,
        },
      });

      const reply = response.text?.trim();

      if (!reply) {
        throw new Error("GEMINI_EMPTY_RESPONSE");
      }

      this.logger?.info("gemini_response_received", {
        eventUuid,
        model,
        durationMs: Date.now() - startedAt,
        responseLength: reply.length,
      });
      if (!normalized) return reply;
      return {
        text: reply,
        provider: this.id,
        model: response.modelVersion || model,
        usage: {
          inputTokens: response.usageMetadata?.promptTokenCount || 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
        },
        finishReason: response.candidates?.[0]?.finishReason || null,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      this.logger?.warn("gemini_request_failed", {
        eventUuid,
        model,
        durationMs: Date.now() - startedAt,
        retryable: false,
        errorName: error?.name || "Error",
        ...(error?.code ? { errorCode: String(error.code).slice(0, 100) } : {}),
        errorMessage: safeErrorMessage(error, [
          context.text,
          ...(context.history || []).map((message) => message.content),
          ...(context.memories || []),
          this.config.GEMINI_API_KEY,
        ]),
      });
      throw error;
    }
  }
}
