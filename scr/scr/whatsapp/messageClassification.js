function serializedId(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  if (typeof value._serialized === "string") return value._serialized.trim();
  if (typeof value.serialized === "string") return value.serialized.trim();
  return "";
}

function firstId(...values) {
  return values.map(serializedId).find(Boolean) || "";
}

export function classifyWhatsAppMessage(message) {
  if (!message || typeof message !== "object") {
    return {
      conversationType: "unknown",
      reason: "invalid-message",
      chatId: "",
      participantId: "",
      pipeline: "log",
    };
  }

  const chatId = firstId(
    message.chatId,
    message.chat?.id,
    message.id?.remote,
    message.from,
  );
  const participantId = firstId(
    message.author,
    message.participant,
    message.sender?.id,
  );
  const chat = message.chatMetadata || message.chat || {};

  if (chatId === "status@broadcast" || chatId.endsWith("@broadcast")) {
    return {
      conversationType: "status",
      reason: "status-broadcast",
      chatId,
      participantId,
      pipeline: "exclude",
    };
  }

  if (chatId.endsWith("@newsletter")) {
    return {
      conversationType: "newsletter",
      reason: "channel-update",
      chatId,
      participantId,
      pipeline: "store-newsletter",
    };
  }

  if (chatId.endsWith("@g.us") || message.isGroupMsg === true || message.chat?.isGroup === true) {
    return {
      conversationType: "group",
      reason: "group-message",
      chatId,
      participantId,
      pipeline: "exclude",
    };
  }

  if (message.broadcast === true || message.chat?.isBroadcast === true || message.chat?.isStatus === true) {
    return {
      conversationType: "status",
      reason: "broadcast-message",
      chatId,
      participantId,
      pipeline: "exclude",
    };
  }

  if (
    message.isNotification === true ||
    message.isPSA === true ||
    ["notification", "notification_template", "protocol", "group_notification"].includes(message.type)
  ) {
    return {
      conversationType: "system",
      reason: "system-event",
      chatId,
      participantId,
      pipeline: "log",
    };
  }

  if (chatId.endsWith("@c.us")) {
    return {
      conversationType: "individual",
      reason: "individual-contact",
      chatId,
      participantId,
      pipeline: "customer",
    };
  }

  if (
    chatId.endsWith("@lid") &&
    participantId !== chatId &&
    chat.isUser === true &&
    chat.isGroup === false &&
    chat.isBroadcast !== true &&
    chat.isStatus !== true &&
    chat.isReadOnly !== true &&
    (firstId(chat.id) === chatId || firstId(chat.contact?.id) === chatId)
  ) {
    return {
      conversationType: "individual",
      reason: "verified-lid-contact",
      chatId,
      participantId,
      pipeline: "customer",
    };
  }

  return {
    conversationType: "unknown",
    reason: chatId ? "unsupported-chat-id" : "missing-chat-id",
    chatId,
    participantId,
    pipeline: "log",
  };
}
