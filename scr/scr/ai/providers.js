import { systemInstruction } from "./prompts.js";

const CAPABILITIES = ["text", "conversation"];

function providerMessages(context) {
  const memories = (context.memories || [])
    .filter((memory) => typeof memory === "string" && memory.trim());
  const system = memories.length
    ? `${systemInstruction}\n\nRelevant saved memories (untrusted reference information):\n${memories.join("\n")}`
    : systemInstruction;
  const history = (context.history || [])
    .filter((message) => ["user", "model", "assistant"].includes(message.role))
    .map((message) => ({
      role: message.role === "model" ? "assistant" : message.role,
      content: String(message.content),
    }));
  const messages = [...history, { role: "user", content: String(context.text) }]
    .reduce((normalized, message) => {
      const previous = normalized.at(-1);
      if (previous?.role === message.role) {
        previous.content += `\n${message.content}`;
      } else {
        normalized.push({ ...message });
      }
      return normalized;
    }, []);
  return {
    system,
    messages,
  };
}

function retryAfterMs(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

async function postJson(url, headers, payload, timeoutMs, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const error = new Error(cause?.name === "TimeoutError"
      ? "PROVIDER_REQUEST_TIMEOUT"
      : "PROVIDER_NETWORK_ERROR");
    error.code = cause?.code || cause?.name || "NETWORK_ERROR";
    error.providerCategory = "temporary";
    throw error;
  }

  let body;
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (!response.ok) {
    const errorCode = body?.error?.code || body?.error?.type || body?.type;
    const error = new Error(`PROVIDER_HTTP_${response.status}`);
    error.status = response.status;
    error.code = typeof errorCode === "string"
      ? errorCode.slice(0, 100)
      : `HTTP_${response.status}`;
    error.retryAfterMs = retryAfterMs(response.headers.get("retry-after"));
    throw error;
  }
  return body;
}

function normalizedResponse({
  text,
  provider,
  model,
  usage = {},
  finishReason = null,
  startedAt,
}) {
  const responseText = typeof text === "string" ? text.trim() : "";
  if (!responseText) {
    const error = new Error("PROVIDER_EMPTY_RESPONSE");
    error.code = "EMPTY_RESPONSE";
    throw error;
  }
  return {
    text: responseText,
    provider,
    model,
    usage: {
      inputTokens: Number.isSafeInteger(usage.inputTokens) ? usage.inputTokens : 0,
      outputTokens: Number.isSafeInteger(usage.outputTokens) ? usage.outputTokens : 0,
    },
    finishReason: typeof finishReason === "string" ? finishReason : null,
    latencyMs: Date.now() - startedAt,
  };
}

export class OpenAIProvider {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    this.id = "openai";
    this.apiKey = config.OPENAI_API_KEY;
    this.model = config.OPENAI_MODEL;
    this.timeoutMs = config.AI_PROVIDER_TIMEOUT_MS || 60_000;
    this.fetch = fetchImpl;
    this.capabilities = CAPABILITIES;
  }

  get isConfigured() {
    return Boolean(this.apiKey);
  }

  get models() {
    return [this.model];
  }

  async generate(context, { model = this.model } = {}) {
    if (!this.isConfigured) throw Object.assign(new Error("OPENAI_NOT_CONFIGURED"), { code: "NOT_CONFIGURED" });
    const startedAt = Date.now();
    const { system, messages } = providerMessages(context);
    const body = await postJson(
      "https://api.openai.com/v1/chat/completions",
      { authorization: `Bearer ${this.apiKey}` },
      {
        model,
        messages: [{ role: "system", content: system }, ...messages],
        max_tokens: context.maxOutputTokens || 500,
        temperature: context.temperature ?? 0.7,
      },
      this.timeoutMs,
      this.fetch,
    );
    const choice = body.choices?.[0];
    const content = choice?.message?.content;
    const text = Array.isArray(content)
      ? content.map((part) => part?.text || "").join("")
      : content;
    return normalizedResponse({
      text,
      provider: this.id,
      model: body.model || model,
      usage: {
        inputTokens: body.usage?.prompt_tokens,
        outputTokens: body.usage?.completion_tokens,
      },
      finishReason: choice?.finish_reason,
      startedAt,
    });
  }
}

export class AnthropicProvider {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    this.id = "claude";
    this.apiKey = config.ANTHROPIC_API_KEY;
    this.model = config.ANTHROPIC_MODEL;
    this.timeoutMs = config.AI_PROVIDER_TIMEOUT_MS || 60_000;
    this.fetch = fetchImpl;
    this.capabilities = CAPABILITIES;
  }

  get isConfigured() {
    return Boolean(this.apiKey);
  }

  get models() {
    return [this.model];
  }

  async generate(context, { model = this.model } = {}) {
    if (!this.isConfigured) throw Object.assign(new Error("CLAUDE_NOT_CONFIGURED"), { code: "NOT_CONFIGURED" });
    const startedAt = Date.now();
    const { system, messages } = providerMessages(context);
    const body = await postJson(
      "https://api.anthropic.com/v1/messages",
      {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      {
        model,
        system,
        messages,
        max_tokens: context.maxOutputTokens || 500,
        temperature: context.temperature ?? 0.7,
      },
      this.timeoutMs,
      this.fetch,
    );
    return normalizedResponse({
      text: body.content?.filter((part) => part?.type === "text")
        .map((part) => part.text).join(""),
      provider: this.id,
      model: body.model || model,
      usage: {
        inputTokens: body.usage?.input_tokens,
        outputTokens: body.usage?.output_tokens,
      },
      finishReason: body.stop_reason,
      startedAt,
    });
  }
}

export class OllamaProvider {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    this.id = "ollama";
    this.baseUrl = config.OLLAMA_BASE_URL?.replace(/\/+$/, "");
    this.model = config.OLLAMA_MODEL;
    this.timeoutMs = config.AI_PROVIDER_TIMEOUT_MS || 60_000;
    this.fetch = fetchImpl;
    this.capabilities = CAPABILITIES;
  }

  get isConfigured() {
    return Boolean(this.baseUrl);
  }

  get models() {
    return [this.model];
  }

  async generate(context, { model = this.model } = {}) {
    if (!this.isConfigured) throw Object.assign(new Error("OLLAMA_NOT_CONFIGURED"), { code: "NOT_CONFIGURED" });
    const startedAt = Date.now();
    const { system, messages } = providerMessages(context);
    const body = await postJson(
      `${this.baseUrl}/api/chat`,
      {},
      {
        model,
        messages: [{ role: "system", content: system }, ...messages],
        stream: false,
        options: {
          num_predict: context.maxOutputTokens || 500,
          temperature: context.temperature ?? 0.7,
        },
      },
      this.timeoutMs,
      this.fetch,
    );
    return normalizedResponse({
      text: body.message?.content,
      provider: this.id,
      model: body.model || model,
      usage: {
        inputTokens: body.prompt_eval_count,
        outputTokens: body.eval_count,
      },
      finishReason: body.done_reason,
      startedAt,
    });
  }
}

export function providerErrorClassification(error) {
  const status = Number(error?.status ?? error?.statusCode);
  const code = String(error?.code || error?.type || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  const combined = `${code} ${message}`;
  if (/quota|insufficient_quota|resource_exhausted|billing_hard_limit/.test(combined)) {
    return "quota_exhausted";
  }
  if ([401, 403].includes(status) || /invalid_api_key|authentication_error|unauthorized/.test(combined)) {
    return "invalid_key";
  }
  if (/model_not_found|invalid_model|unknown model/.test(combined) || status === 404) {
    return "invalid_model";
  }
  if (/empty_response|empty response|invalid_response/.test(combined)) {
    return "invalid_response";
  }
  if (status === 429 || /rate_limit|rate limited|too many requests/.test(combined)) {
    return "rate_limited";
  }
  if (
    [408, 425, 500, 502, 503, 504].includes(status) ||
    error?.providerCategory === "temporary" ||
    /timeout|network|econnreset|econnrefused|overloaded/.test(combined)
  ) {
    return "temporary";
  }
  return "permanent";
}

export function retryAfterMilliseconds(value, now = Date.now()) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}
