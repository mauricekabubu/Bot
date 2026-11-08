import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateDocument } from '../security/validation.js';

const signatures = {
  'application/pdf': (data) => data.subarray(0, 5).toString() === '%PDF-',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': (data) =>
    data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
  'text/plain': (data) => !data.includes(0),
};

function documentName(media) {
  if (
    typeof media?.filename !== 'string' ||
    !media.filename ||
    media.filename.length > 255 ||
    /[\0-\x1f\x7f]/.test(media.filename) ||
    media.filename.includes('/') ||
    media.filename.includes('\\') ||
    path.basename(media.filename) !== media.filename
  ) {
    throw new Error('Unsafe document filename.');
  }
  return media.filename;
}

function decodeMediaData(value, maxBytes) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > Math.ceil(maxBytes / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error('Invalid or oversized document data.');
  }

  const data = Buffer.from(value, 'base64');
  if (
    data.length > maxBytes ||
    data.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')
  ) {
    throw new Error('Invalid or oversized document data.');
  }
  return data;
}

export async function stageIncomingDocument(media, maxBytes, tempDir) {
  const filename = documentName(media);
  const ext = path.extname(filename).toLowerCase();
  validateDocument({ filename, mimetype: media.mimetype, size: 1 }, maxBytes);
  if (typeof media.data !== 'string' || media.data.length > Math.ceil(maxBytes / 3) * 4) {
    throw new Error('Invalid or oversized document data.');
  }

  const data = decodeMediaData(media.data, maxBytes);
  validateDocument({ filename, mimetype: media.mimetype, size: data.length }, maxBytes);
  if (!signatures[media.mimetype]?.(data)) {
    throw new Error('Document signature does not match its type.');
  }

  await fs.mkdir(tempDir, { recursive: true });
  const directory = await fs.mkdtemp(path.join(tempDir, 'atom-doc-'));
  const filePath = path.join(directory, `upload-${crypto.randomUUID()}${ext}`);
  try {
    await fs.writeFile(filePath, data, { flag: 'wx', mode: 0o600 });
    return { filePath, directory, filename, mimetype: media.mimetype, size: data.length };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function cleanupStagedDocument(document) {
  if (
    document?.directory &&
    document?.filePath &&
    path.dirname(document.filePath) === document.directory &&
    path.basename(document.directory).startsWith('atom-doc-')
  ) {
    await fs.rm(document.directory, { recursive: true, force: true });
  }
}
