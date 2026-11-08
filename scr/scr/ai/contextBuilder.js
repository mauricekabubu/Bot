
export function buildContext({
  history = [],
  memories = [],
  text,
}) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("INVALID_CONTEXT_MESSAGE");
  }

  const safeHistory = history
    .filter(
      (message) =>
        message &&
        ["user", "model"].includes(message.role) &&
        typeof message.content === "string"
    )
    .slice(-16)
    .map(({ role, content }) => ({
      role,
      content: content.slice(0, 4000),
    }));

  const safeMemories = memories
    .filter(
      (memory) =>
        memory &&
        typeof memory.fact === "string" &&
        memory.fact.trim()
    )
    .slice(-20)
    .map((memory) => memory.fact.slice(0, 500));

  return {
    history: safeHistory,
    memories: safeMemories,
    text: text.trim(),
  };
}
