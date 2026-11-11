
import { buildContext } from "./contextBuilder.js";
import { PendingConfirmationStore } from "../security/permissions.js";

function safeErrorMessage(error, sensitiveValues = []) {
  let message = String(error?.message || error).split(/\r?\n/, 1)[0];
  for (const value of sensitiveValues.filter((item) => typeof item === "string" && item.length > 0)) {
    message = message.replaceAll(value, "[redacted]");
  }
  return message
    .replace(/(key|token|authorization)=?[^\s,]+/gi, "$1=[redacted]")
    .slice(0, 300);
}

export class Agent {
  constructor({
    conversation,
    longTerm,
    gemini,
    router,
    tools,
    logger,
    confirmations = new PendingConfirmationStore(),
  }) {
    Object.assign(this, {
      conversation,
      longTerm,
      gemini,
      router,
      tools,
      logger,
      confirmations
    });
  }

  async respond(userId, text, { eventUuid } = {}) {
    if (!userId || typeof userId !== "string") {
      throw new Error("A valid user ID is required.");
    }

    if (typeof text !== "string" || !text.trim()) {
      return "Niaje! Nitext message yako kwanza.";
    }

    const input = text.trim();

    const remember = input.match(
      /^remember\s+(preference|personal_fact|goal|project|instruction)\s*:\s*(.+)$/i
    ) || input.match(/^save memory\s*:\s*(.+)$/i);
    if (remember) {
      const kind = remember.length === 3 ? remember[1].toLowerCase() : "preference";
      const fact = remember.length === 3 ? remember[2] : remember[1];
      try {
        const added = this.longTerm.add(userId, fact, kind);
        return added ? "Sawa, nimehifadhi hiyo memory." : "Hiyo memory iko saved tayari.";
      } catch (error) {
        if (error.message === "SENSITIVE_MEMORY_REJECTED") {
          return "Siwezi kuhifadhi passwords, API keys, tokens, au secrets.";
        }
        throw error;
      }
    }

    if (/^(?:show|list|view) memories$/i.test(input)) {
      const memories = this.longTerm.list(userId, 50);
      if (!memories.length) return "Bado huna long-term memories zilizohifadhiwa.";
      return memories.map(({ id, kind, fact }) => `${id}. [${kind}] ${fact}`).join("\n");
    }

    const forget = input.match(/^(?:forget|delete) memory\s+(\d+)$/i);
    if (forget) {
      const deleted = this.longTerm.delete(userId, Number(forget[1]));
      return deleted ? "Sawa, nimefuta hiyo memory." : "Sikupata memory yenye hiyo ID.";
    }

    if (/^cancel$/i.test(input)) return this.confirmations.cancel(userId) ? "Sawa, nimecancel hiyo action." : "Hakuna action pending ya kucancel.";
    if (/^confirm$/i.test(input)) {
      if (!this.confirmations.confirm(userId, 'delete_memory')) return "Hakuna valid memory deletion confirmation. Tuma `clear memory` kuanza tena.";
      this.conversation.clear(userId); this.longTerm.clear(userId);
      return "Sawa, nimefuta conversation na memory yako hapa Atom.";
    }
    // Clear conversation and long-term memory only after user-specific confirmation.
    if (/^\s*clear(?:\s+memory)?\s*$/i.test(input)) {
      this.confirmations.request(userId, 'delete_memory');
      return "Hii itafuta conversation na memory yako ya Atom. Reply `CONFIRM` within 5 minutes kuendelea, ama `CANCEL`.";
    }

    // Handle basic calculations
    const calc = input.match(
      /^\s*(?:calculate|calc)\s+(.+)$/i
    );

    if (calc) {
      try {
        const calculator = this.tools.get("calculator");

        if (!calculator) {
          return "Calculator haipatikani kwa sasa.";
        }

        const { result } = await calculator.execute({
          expression: calc[1]
        });

        const answer = `Fresh — answer ni ${result}.`;

        this.conversation.add(userId, "user", input);
        this.conversation.add(userId, "model", answer);

        return answer;

      } catch (error) {
        return "Hiyo calculation haiko valid. Tumia numbers na basic operators pekee.";
      }
    }

    // Build model context
    const context = buildContext({
      history: this.conversation.recent(userId),
      memories: this.longTerm.list(userId),
      text: input
    });

    // Generate AI response
    let reply;
    let provider;
    let model;
    let usage;
    const generationStartedAt = Date.now();

    try {
      if (this.router) {
        const generated = await this.router.generate(context, { userId, eventUuid });
        reply = generated.text;
        provider = generated.provider;
        model = generated.model;
        usage = generated.usage;
      } else {
        reply = await this.gemini.generate(context, { eventUuid });
        model = this.gemini?.config?.GEMINI_MODEL;
        provider = "gemini";
      }

      if (typeof reply !== "string" || !reply.trim()) {
        throw new Error("Empty AI response.");
      }
    } catch (error) {
      this.logger?.error("ai_response_generation_failed", {
        eventUuid,
        provider,
        model: model || this.gemini?.config?.GEMINI_MODEL,
        errorName: error?.name || "Error",
        ...(error?.code ? { errorCode: String(error.code).slice(0, 100) } : {}),
        errorMessage: safeErrorMessage(error, [
          input,
          this.gemini?.config?.GEMINI_API_KEY,
        ]),
      });
      if (error?.code === "NO_AI_PROVIDERS_CONFIGURED") {
        reply = "AI providers hawijaconfigurewa bado. Configure at least one provider, then restart.";
      } else if (!this.router && /not[_\s]+configured/i.test(String(error?.message))) {
        reply = "Niko ready, lakini Gemini haijaconfigurewa bado. Ongeza GEMINI_API_KEY kwa .env, then restart.";
      } else {
        reply = "Pole, AI service imepata issue ya muda. Jaribu tena kidogo.";
      }
      this.logger?.info("ai_response_generated", {
        eventUuid,
        provider,
        model: model || this.gemini?.config?.GEMINI_MODEL,
        responseLength: reply.length,
        responseKind: "fallback",
        durationMs: Date.now() - generationStartedAt,
      });
      return reply;
    }

    this.logger?.info("ai_response_generated", {
      eventUuid,
      provider,
      model: model || this.gemini?.config?.GEMINI_MODEL,
      inputTokens: usage?.inputTokens || 0,
      outputTokens: usage?.outputTokens || 0,
      responseLength: reply.length,
      durationMs: Date.now() - generationStartedAt,
    });

    try {
      this.conversation.add(userId, "user", input);
      this.conversation.add(userId, "model", reply);
    } catch (error) {
      this.logger?.error("conversation_memory_persistence_failed", {
        eventUuid,
        errorName: error?.name || "Error",
        ...(error?.code ? { errorCode: String(error.code).slice(0, 100) } : {}),
        errorMessage: safeErrorMessage(error, [input, reply]),
      });
    }

    return reply;
  }
}
