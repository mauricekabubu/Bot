import { classifyWhatsAppMessage } from './messageClassification.js';

function serializedId(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return value._serialized || value.serialized || '';
}

export async function classifyIncomingMessage(msg, getChat = async () => null) {
  if (!msg || typeof msg !== 'object') return { accepted: false, reason: 'invalid-message' };
  if (msg.fromMe) return { accepted: false, reason: 'self' };
  let classification = classifyWhatsAppMessage(msg);
  const candidateId = classification.chatId;
  const mayBePrivate = candidateId.endsWith('@c.us') || candidateId.endsWith('@lid');
  if (classification.conversationType !== 'individual' && !mayBePrivate) {
    const reasons = {
      group: 'group',
      status: 'broadcast',
      newsletter: 'newsletter',
      system: 'system',
      unknown: 'unsupported-id',
    };
    return {
      accepted: false,
      reason: reasons[classification.conversationType] || 'unsupported-id',
      classification,
    };
  }
  let chat;
  try {
    chat = await getChat(msg);
  } catch {
    return { accepted: false, reason: 'unverified-chat' };
  }
  if (!chat) return { accepted: false, reason: 'unverified-chat' };

  const chatId = serializedId(chat.id);
  const contactId = serializedId(chat.contact?.id);
  const identifierMatches = chatId === candidateId || contactId === candidateId;
  const resolvedPrivateId = chatId.endsWith('@c.us') || chatId.endsWith('@lid');
  if (!identifierMatches || !resolvedPrivateId) {
    return { accepted: false, reason: 'chat-id-mismatch' };
  }
  classification = classifyWhatsAppMessage({
    ...msg,
    chatMetadata: { ...chat, id: chatId, contact: { id: contactId } },
  });
  if (classification.conversationType !== 'individual') {
    return {
      accepted: false,
      reason: classification.conversationType === 'group' ? 'group' : 'unsupported-chat',
      classification,
    };
  }
  const isSupportedPrivateId = chat.isUser === true &&
    chat.isGroup === false &&
    resolvedPrivateId;
  if (
    chat.isGroup ||
    chat.isStatus ||
    chat.isBroadcast ||
    chat.isReadOnly === true ||
    !isSupportedPrivateId
  ) {
    return {
      accepted: false,
      reason: chat.isGroup ? 'group' : chat.isBroadcast || chat.isStatus
        ? 'broadcast'
        : 'unsupported-chat',
      classification,
    };
  }

  const text = typeof msg.body === 'string' ? msg.body.trim() : '';
  const hasMedia = msg.hasMedia === true;
  if (!text && !hasMedia) return { accepted: false, reason: 'empty', classification };
  return { accepted: true, userId: chatId, text, hasMedia, classification, chat };
}
