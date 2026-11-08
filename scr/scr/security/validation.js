import path from 'node:path';

export function validateText(text, maxLength) { if (typeof text !== 'string' || !text.trim()) throw new Error('A text message is required.'); if (text.length > maxLength) throw new Error(`Message is too long (maximum ${maxLength} characters).`); return text.trim(); }

const DOCUMENT_TYPES = new Map([
  ['.pdf', ['application/pdf']],
  ['.txt', ['text/plain']],
  ['.docx', ['application/vnd.openxmlformats-officedocument.wordprocessingml.document']],
]);

export function validateDocument({ filename, mimetype, size }, maxBytes) {
  const ext = path.extname(filename || '').toLowerCase();
  if (
    typeof filename !== 'string' ||
    !DOCUMENT_TYPES.get(ext)?.includes(mimetype) ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    !Number.isFinite(maxBytes) ||
    maxBytes <= 0 ||
    size > maxBytes
  ) {
    throw new Error('Unsupported or oversized document.');
  }
  return true;
}
