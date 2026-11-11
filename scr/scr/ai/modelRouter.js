import { createHash, randomUUID } from "node:crypto";
import {
  providerErrorClassification,
  retryAfterMilliseconds,
} from "./providers.js";

const PROVIDER_IDS = ["gemini", "openai", "claude", "ollama"];
const CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_RETRY_AFTER_MS = 30_000;
const QUOTA_COOLDOWN_MS = 6 * 60 * 60_000;

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function safeCode(error, category) {
  const code = String(error?.code || error?.name || category)
    .replace(/[^a-z0-9_.-]/gi, "_")
    .slice(0, 100);
  return code || category;
}

function normalizedResult(result, provider, model, latencyMs) {
  const text = typeof result === "string" ? result.trim() : result?.text?.trim();
  if (!text) {
    const error = new Error("PROVIDER_EMPTY_RESPONSE");
    error.code = "EMPTY_RESPONSE";
    throw error;
  }
  return {
    text,
    provider: typeof result === "object" && result.provider ? result.provider : provider.id,
    model: typeof result === "object" && result.model ? result.model : model,
    usage: {
      inputTokens: Number.isSafeInteger(result?.usage?.inputTokens) ? result.usage.inputTokens : 0,
      outputTokens: Number.isSafeInteger(result?.usage?.outputTokens) ? result.usage.outputTokens : 0,
    },
    finishReason: typeof result?.finishReason === "string" ? result.finishReason : null,
    latencyMs: Number.isFinite(result?.latencyMs) ? result.latencyMs : latencyMs,
  };
}

export class ModelRouter {
  constructor({
    db,
    providers,
    logger,
    priorities = PROVIDER_IDS,
    maxFailoverAttempts = 3,
    maxOutputTokens = 500,
    temperature = 0.7,
    quotaCooldownMs = QUOTA_COOLDOWN_MS,
    circuitFailureThreshold = CIRCUIT_FAILURE_THRESHOLD,
    baseRetryDelayMs = 250,
    sleep = wait,
    random = Math.random,
    now = () => Date.now(),
  }) {
    if (!db || !Array.isArray(providers) || !providers.length) {
      throw new Error("ModelRouter requires a database and at least one provider.");
    }
    this.db = db;
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
    this.logger = logger;
    this.priorities = this.normalizePriorities(priorities);
    this.maxFailoverAttempts = Math.max(0, Math.min(3, maxFailoverAttempts));
    this.maxOutputTokens = maxOutputTokens;
    this.temperature = temperature;
    this.quotaCooldownMs = quotaCooldownMs;
    this.circuitFailureThreshold = circuitFailureThreshold;
    this.baseRetryDelayMs = baseRetryDelayMs;
    this.sleep = sleep;
    this.random = random;
    this.now = now;
    this.db.prepare(`
      INSERT INTO ai_model_config(id, mode, provider, model, priorities_json, updated_at)
      VALUES(1, 'auto', NULL, NULL, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(JSON.stringify(this.priorities), new Date(this.now()).toISOString());
    const ensureProviderState = this.db.prepare(`
      INSERT INTO ai_provider_state(provider, availability, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        availability = CASE
          WHEN ai_provider_state.availability IN ('unavailable', 'misconfigured')
            AND excluded.availability = 'available' THEN 'available'
          WHEN excluded.availability = 'unavailable' THEN 'unavailable'
          ELSE ai_provider_state.availability
        END,
        failure_count = CASE
          WHEN excluded.availability = 'available'
            AND ai_provider_state.availability IN ('unavailable', 'misconfigured')
          THEN 0 ELSE ai_provider_state.failure_count
        END,
        cooldown_until = CASE
          WHEN excluded.availability = 'available'
            AND ai_provider_state.availability IN ('unavailable', 'misconfigured')
          THEN NULL ELSE ai_provider_state.cooldown_until
        END,
        circuit_open_until = CASE
          WHEN excluded.availability = 'available'
            AND ai_provider_state.availability IN ('unavailable', 'misconfigured')
          THEN NULL ELSE ai_provider_state.circuit_open_until
        END,
        updated_at = excluded.updated_at
    `);
    const nowIso = new Date(this.now()).toISOString();
    for (const provider of this.providers.values()) {
      ensureProviderState.run(
        provider.id,
        provider.isConfigured ? "available" : "unavailable",
        nowIso,
      );
    }
    this.persistPrioritiesIfChanged();
  }

  normalizePriorities(values) {
    const requested = Array.isArray(values)
      ? values
      : String(values || "").split(",");
    const valid = requested.map((id) => String(id).trim().toLowerCase())
      .filter((id) => this.providers.has(id));
    return [...new Set([...valid, ...this.providers.keys()])];
  }

  getGlobalConfig() {
    return this.db.prepare("SELECT * FROM ai_model_config WHERE id = 1").get();
  }

  persistPrioritiesIfChanged() {
    const current = this.getGlobalConfig();
    const persisted = JSON.parse(current.priorities_json);
    const priorities = this.normalizePriorities(persisted.length ? persisted : this.priorities);
    if (JSON.stringify(priorities) !== JSON.stringify(persisted)) {
      this.db.prepare(`
        UPDATE ai_model_config SET priorities_json = ?, updated_at = ? WHERE id = 1
      `).run(JSON.stringify(priorities), new Date(this.now()).toISOString());
    }
    this.priorities = priorities;
  }

  async setGlobalSelection(selection) {
    const now = new Date(this.now()).toISOString();
    if (selection === "auto") {
      this.db.prepare(`
        UPDATE ai_model_config
        SET mode = 'auto', provider = NULL, model = NULL, updated_at = ?
        WHERE id = 1
      `).run(now);
    } else {
      const provider = this.providers.get(selection);
      if (!provider) throw new Error("UNKNOWN_AI_PROVIDER");
      this.db.prepare(`
        UPDATE ai_model_config SET mode = 'manual', provider = ?, model = ?, updated_at = ?
        WHERE id = 1
      `).run(provider.id, provider.models?.[0] || null, now);
    }
    this.logger?.info("ai_model_selection_changed", {
      scope: "global",
      mode: selection === "auto" ? "auto" : "manual",
      provider: selection === "auto" ? null : selection,
    });
    return this.getStatus();
  }

  async setContactPreference(contactId, selection) {
    if (!contactId || /@(g\.us|newsletter|broadcast)$/i.test(contactId)) {
      throw new Error("INVALID_AI_CONTACT");
    }
    const now = new Date(this.now()).toISOString();
    if (selection === "auto") {
      this.db.prepare(`
        INSERT INTO ai_contact_preferences(contact_id, mode, provider, model, updated_at)
        VALUES (?, 'auto', NULL, NULL, ?)
        ON CONFLICT(contact_id) DO UPDATE SET
          mode = 'auto', provider = NULL, model = NULL, updated_at = excluded.updated_at
      `).run(contactId, now);
    } else {
      const provider = this.providers.get(selection);
      if (!provider) throw new Error("UNKNOWN_AI_PROVIDER");
      this.db.prepare(`
        INSERT INTO ai_contact_preferences(contact_id, mode, provider, model, updated_at)
        VALUES (?, 'manual', ?, ?, ?)
        ON CONFLICT(contact_id) DO UPDATE SET
          mode = 'manual', provider = excluded.provider, model = excluded.model,
          updated_at = excluded.updated_at
      `).run(contactId, provider.id, provider.models?.[0] || null, now);
    }
    this.logger?.info("ai_model_selection_changed", {
      scope: "contact",
      contactKey: createHash("sha256").update(contactId).digest("hex").slice(0, 12),
      mode: selection === "auto" ? "auto" : "manual",
      provider: selection === "auto" ? null : selection,
    });
    return selection;
  }

  setPriorities(priorities) {
    const requested = Array.isArray(priorities)
      ? priorities
      : String(priorities || "").split(",");
    const unknown = requested.map((id) => String(id).trim().toLowerCase())
      .filter((id) => id && !this.providers.has(id));
    if (unknown.length) throw new Error("UNKNOWN_AI_PROVIDER");
    const normalized = this.normalizePriorities(priorities);
    this.priorities = normalized;
    this.db.prepare(`
      UPDATE ai_model_config SET priorities_json = ?, updated_at = ? WHERE id = 1
    `).run(JSON.stringify(normalized), new Date(this.now()).toISOString());
    this.logger?.info("ai_model_selection_changed", {
      scope: "global-priority",
      priorities: normalized,
    });
    return normalized;
  }

  getContactPreference(contactId) {
    return this.db.prepare(
      "SELECT mode, provider, model FROM ai_contact_preferences WHERE contact_id = ?",
    ).get(contactId) || null;
  }

  providerState(providerId) {
    return this.db.prepare(
      "SELECT * FROM ai_provider_state WHERE provider = ?",
    ).get(providerId);
  }

  getStatus(userId) {
    const global = this.getGlobalConfig();
    const contact = userId ? this.getContactPreference(userId) : null;
    const priorities = this.normalizePriorities(JSON.parse(global.priorities_json));
    const activeStates = [...this.providers.values()].map((provider) => {
      const state = this.providerState(provider.id);
      const deadline = state?.circuit_open_until || state?.cooldown_until;
      const expired = deadline && Date.parse(deadline) <= this.now();
      return {
        id: provider.id,
        configured: provider.isConfigured === true,
        models: [...(provider.models || [])],
        availability: expired &&
          ["cooldown", "circuit_open"].includes(state.availability)
          ? "available"
          : state?.availability || "unavailable",
      };
    });
    const selectedProvider = contact
      ? contact.mode === "manual" ? contact.provider : null
      : global.mode === "manual" ? global.provider : null;
    const selectedModel = contact
      ? contact.model
      : global.model;
    const order = selectedProvider
      ? [selectedProvider, ...priorities.filter((id) => id !== selectedProvider)]
      : priorities;
    const activeProvider = order.find((providerId) => activeStates.some((provider) =>
        provider.id === providerId &&
        provider.configured &&
        provider.availability === "available")) || null;
    const mode = contact?.mode || global.mode;
    const activeModel = activeProvider === selectedProvider && selectedModel
      ? selectedModel
      : this.providers.get(activeProvider)?.models?.[0] || null;
    return {
      mode,
      globalMode: global.mode,
      preferredProvider: selectedProvider || "auto",
      activeProvider,
      activeModel,
      priorities,
      providers: activeStates,
    };
  }

  formatStatus(userId) {
    const status = this.getStatus(userId);
    const providers = status.providers.map((provider) =>
      `- ${provider.id}: ${provider.configured ? provider.models.join(", ") : "not configured"} (${provider.availability})`
    );
    return [
      `Mode: ${status.mode}${status.mode !== status.globalMode ? ` (global: ${status.globalMode})` : ""}`,
      `Preferred provider: ${status.preferredProvider}`,
      `Active provider: ${status.activeProvider || "none"}${status.activeModel ? ` / ${status.activeModel}` : ""}`,
      `Priority: ${status.priorities.join(" → ")}`,
      "Providers:",
      ...providers,
      "Per-contact: use `/model contact <auto|gemini|openai|claude|ollama>`.",
    ].join("\n");
  }

  candidateProviders(userId) {
    const global = this.getGlobalConfig();
    const contact = userId ? this.getContactPreference(userId) : null;
    const priorities = this.normalizePriorities(JSON.parse(global.priorities_json));
    const selectedProvider = contact
      ? contact.mode === "manual" ? contact.provider : null
      : global.mode === "manual" ? global.provider : null;
    const selectedModel = contact
      ? contact.model
      : global.model;
    const primaryProvider = selectedProvider ||
      (this.providers.has("gemini") ? "gemini" : priorities[0]);
    const orderedIds = [
      primaryProvider,
      ...priorities.filter((id) => id !== primaryProvider),
    ];
    return orderedIds.map((id) => {
      const provider = this.providers.get(id);
      return {
        provider,
        model: id === selectedProvider && selectedModel
          ? selectedModel
          : provider?.models?.[0],
      };
    }).filter(({ provider }) => Boolean(provider));
  }

  async generate(context, { userId, eventUuid } = {}) {
    const correlationId = eventUuid || randomUUID();
    const candidates = this.candidateProviders(userId);
    const contactPreference = userId ? this.getContactPreference(userId) : null;
    const attemptedModels = [];
    this.logger?.info("ai_router_selection", {
      correlationId,
      mode: contactPreference?.mode || this.getGlobalConfig().mode,
      primaryProvider: candidates[0]?.provider.id || null,
      configuredProviderCount: candidates.filter(({ provider }) =>
        provider.isConfigured === true).length,
    });
    if (!candidates.some(({ provider }) => provider.isConfigured === true)) {
      const error = new Error("NO_AI_PROVIDERS_CONFIGURED");
      error.code = "NO_AI_PROVIDERS_CONFIGURED";
      throw error;
    }
    let failedOverProviders = 0;
    let previousProvider = null;
    let previousReason = null;
    let lastError;
    for (const candidate of candidates) {
      const { provider, model } = candidate;
      if (provider.isConfigured !== true) {
        this.logger?.info("ai_router_provider_skipped", {
          correlationId,
          provider: provider.id,
          reason: "not_configured",
        });
        continue;
      }
      if (!provider.capabilities?.includes("text") ||
          !provider.capabilities?.includes("conversation")) continue;
      const availability = this.getEligibleAvailability(provider.id);
      if (!availability.eligible) {
        this.logger?.info("ai_router_provider_skipped", {
          correlationId,
          provider: provider.id,
          reason: availability.reason,
        });
        continue;
      }
      if (previousProvider && previousProvider !== provider.id) {
        if (failedOverProviders >= this.maxFailoverAttempts) break;
        failedOverProviders += 1;
        this.recordFailover(correlationId, previousProvider, provider.id, previousReason);
        this.logger?.warn("ai_provider_failover_started", {
          correlationId,
          fromProvider: previousProvider,
          toProvider: provider.id,
          reason: previousReason,
        });
      }
      const models = provider.id === "gemini"
        ? [...new Set([model, ...(provider.models || [])].filter(Boolean))]
        : [model];
      let providerErrors = [];
      const providerAttemptedModels = [];
      for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
        const attemptedModel = models[modelIndex];
        attemptedModels.push({ provider: provider.id, model: attemptedModel });
        providerAttemptedModels.push(attemptedModel);
        if (modelIndex > 0) {
          const reason = providerErrors.at(-1)?.classification || previousReason;
          this.logger?.warn("ai_model_failover_started", {
            correlationId,
            provider: provider.id,
            fromModel: models[modelIndex - 1],
            toModel: attemptedModel,
            reason,
          });
        }
        try {
          const result = await this.requestProvider(
            provider,
            attemptedModel,
            context,
            correlationId,
            { retrySameModel: provider.id !== "gemini" },
          );
          this.recordSuccess(provider.id, attemptedModel, result);
          this.logger?.info(previousReason
            ? "ai_provider_failover_succeeded"
            : "ai_provider_request_succeeded", {
            correlationId,
            provider: result.provider,
            model: result.model,
            latencyMs: result.latencyMs,
            responseLength: result.text.length,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            finishReason: result.finishReason,
            attemptedModels,
          });
          return result;
        } catch (error) {
          lastError = error;
          const classification = providerErrorClassification(error);
          previousReason = classification;
          providerErrors.push({ error, classification });
          this.logger?.error("ai_provider_request_failed", {
            correlationId,
            provider: provider.id,
            model: attemptedModel,
            classification,
            status: Number.isFinite(Number(error?.status)) ? Number(error.status) : undefined,
            errorCode: safeCode(error, classification),
          });
          if (classification === "quota_exhausted") {
            this.logger?.warn("ai_provider_quota_exhausted", {
              correlationId,
              provider: provider.id,
              model: attemptedModel,
            });
          }
          if (provider.id !== "gemini") {
            this.recordFailure(provider.id, attemptedModel, error, classification, correlationId);
            break;
          }
          const hasAlternativeModel = modelIndex + 1 < models.length;
          if (classification === "invalid_key" || !hasAlternativeModel ||
              !["rate_limited", "quota_exhausted", "temporary", "invalid_model", "invalid_response"]
                .includes(classification)) {
            const providerWideFailure = providerErrors.find(({ classification: errorType }) =>
              ["quota_exhausted", "rate_limited"].includes(errorType));
            const failureToRecord = providerWideFailure || { error, classification };
            this.recordFailure(
              provider.id,
              attemptedModel,
              failureToRecord.error,
              failureToRecord.classification,
              correlationId,
            );
            break;
          }
        }
      }
      if (providerErrors.length > 0) {
        previousReason = providerErrors.at(-1).classification;
      }
      if (providerErrors.length > 0) {
        this.logger?.warn("ai_provider_abandoned", {
          correlationId,
          provider: provider.id,
          reason: previousReason,
          attemptedModels: providerAttemptedModels,
        });
      }
      previousProvider = provider.id;
    }
    const error = new Error("ALL_AI_PROVIDERS_FAILED");
    error.code = "ALL_AI_PROVIDERS_FAILED";
    error.cause = lastError;
    error.attemptedModels = attemptedModels;
    throw error;
  }

  getEligibleAvailability(providerId) {
    const state = this.providerState(providerId);
    if (!state || state.availability === "unavailable" ||
        state.availability === "misconfigured") {
      return { eligible: false, reason: state?.availability || "unavailable" };
    }
    const deadline = state.circuit_open_until || state.cooldown_until;
    const deadlineMs = deadline ? Date.parse(deadline) : 0;
    if (deadlineMs > this.now()) {
      return { eligible: false, reason: state.availability };
    }
    if (state.availability !== "available") {
      this.db.prepare(`
        UPDATE ai_provider_state SET availability = 'available',
          cooldown_until = NULL, circuit_open_until = NULL, updated_at = ?
        WHERE provider = ?
      `).run(new Date(this.now()).toISOString(), providerId);
    }
    return { eligible: true };
  }

  async requestProvider(
    provider,
    model,
    context,
    correlationId,
    { retrySameModel = true } = {},
  ) {
    let lastError;
    const maxAttempts = retrySameModel ? 3 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const startedAt = this.now();
      this.recordRequest(provider.id, model);
      this.logger?.info("ai_provider_request_started", {
        correlationId,
        provider: provider.id,
        model,
        attempt: attempt + 1,
      });
      try {
        const result = await provider.generate({
          ...context,
          maxOutputTokens: this.maxOutputTokens,
          temperature: this.temperature,
        }, { model, eventUuid: correlationId, normalized: true });
        const normalized = normalizedResult(
          result,
          provider,
          model,
          this.now() - startedAt,
        );
        return normalized;
      } catch (error) {
        lastError = error;
        this.recordRequestFailure(provider.id, model);
        const classification = providerErrorClassification(error);
        const retryLimit = classification === "rate_limited" ? 1 : 2;
        if (
          !retrySameModel ||
          attempt >= retryLimit ||
          !["temporary", "rate_limited"].includes(classification)
        ) break;
        const exponentialDelay = this.baseRetryDelayMs * (2 ** attempt) +
          Math.floor(this.random() * this.baseRetryDelayMs);
        const retryAfter = this.retryAfterFor(error);
        if (Number.isFinite(retryAfter) && retryAfter > 120_000) break;
        const delay = Number.isFinite(retryAfter)
          ? Math.max(exponentialDelay, retryAfter)
          : exponentialDelay;
        await this.sleep(delay);
      }
    }
    throw lastError;
  }

  retryAfterFor(error) {
    if (
      error?.retryAfterMs !== undefined &&
      error?.retryAfterMs !== null &&
      Number.isFinite(Number(error.retryAfterMs))
    ) {
      return Number(error.retryAfterMs);
    }
    const headers = error?.headers || error?.response?.headers;
    const value = typeof headers?.get === "function"
      ? headers.get("retry-after")
      : headers?.["retry-after"];
    return retryAfterMilliseconds(value, this.now());
  }

  recordRequest(provider, model) {
    this.db.prepare(`
      INSERT INTO ai_model_usage(
        provider, model, requests, last_used_at
      ) VALUES (?, ?, 1, ?)
      ON CONFLICT(provider, model) DO UPDATE SET
        requests = requests + 1, last_used_at = excluded.last_used_at
    `).run(provider, model || "unknown", new Date(this.now()).toISOString());
  }

  recordSuccess(providerId, requestedModel, result) {
    this.db.prepare(`
      UPDATE ai_model_usage SET successes = successes + 1,
        input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
        last_used_at = ?
      WHERE provider = ? AND model = ?
    `).run(
      result.usage.inputTokens,
      result.usage.outputTokens,
      new Date(this.now()).toISOString(),
      providerId,
      requestedModel || "unknown",
    );
    this.db.prepare(`
      UPDATE ai_provider_state SET availability = 'available',
        failure_count = 0, cooldown_until = NULL, circuit_open_until = NULL,
        last_error_code = NULL, updated_at = ?
      WHERE provider = ?
    `).run(new Date(this.now()).toISOString(), providerId);
  }

  recordFailure(providerId, model, error, classification, correlationId) {
    const current = this.providerState(providerId);
    const failures = (current?.failure_count || 0) + 1;
    const now = this.now();
    let availability = "available";
    let cooldownUntil = null;
    let circuitOpenUntil = null;
    if (classification === "invalid_key" || classification === "invalid_model") {
      availability = "misconfigured";
    } else if (classification === "quota_exhausted") {
      availability = "cooldown";
      cooldownUntil = new Date(now + this.quotaCooldownMs).toISOString();
    } else if (classification === "rate_limited") {
      availability = "cooldown";
      const retryAfter = this.retryAfterFor(error);
      cooldownUntil = new Date(now + (
        Number.isFinite(retryAfter)
          ? Math.max(retryAfter, DEFAULT_RETRY_AFTER_MS)
          : DEFAULT_RETRY_AFTER_MS
      )).toISOString();
    } else if (failures >= this.circuitFailureThreshold) {
      availability = "circuit_open";
      circuitOpenUntil = new Date(now + DEFAULT_RETRY_AFTER_MS).toISOString();
      this.logger?.warn("ai_provider_circuit_opened", {
        correlationId,
        provider: providerId,
        failureCount: failures,
        cooldownMs: DEFAULT_RETRY_AFTER_MS,
      });
    }
    this.db.prepare(`
      UPDATE ai_provider_state SET availability = ?, failure_count = ?,
        cooldown_until = ?, circuit_open_until = ?, last_error_code = ?,
        updated_at = ? WHERE provider = ?
    `).run(
      availability,
      failures,
      cooldownUntil,
      circuitOpenUntil,
      safeCode(error, classification),
      new Date(now).toISOString(),
      providerId,
    );
  }

  recordRequestFailure(provider, model) {
    this.db.prepare(`
      UPDATE ai_model_usage SET failures = failures + 1, last_used_at = ?
      WHERE provider = ? AND model = ?
    `).run(new Date(this.now()).toISOString(), provider, model || "unknown");
  }

  recordFailover(correlationId, fromProvider, toProvider, reason) {
    this.db.prepare(`
      INSERT INTO ai_failover_events(
        correlation_id, from_provider, to_provider, reason, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(correlationId, fromProvider, toProvider, reason, new Date(this.now()).toISOString());
  }
}
