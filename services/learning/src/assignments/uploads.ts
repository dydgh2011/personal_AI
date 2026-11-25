import { createHash } from 'node:crypto';
import { extname } from 'node:path';

/**
 * Submission uploads. Files are stored as inert bytes in the learning database and are never
 * executed, unpacked, rendered or parsed here - code submissions included (running code needs an
 * isolated runner that is decided separately; see ROADMAP L2-03). The rules below only decide
 * what may be stored:
 * - small: MAX_FILE_BYTES per file, MAX_FILES per submission, MAX_TOTAL_BYTES together
 * - an allow-list of extensions in three categories, and the bytes must match the category
 *   (text = valid UTF-8 without NUL bytes; images and PDF by their magic bytes)
 * - known executable / archive signatures are refused whatever the extension says
 * - the media type is decided here from the bytes; the uploader's type is ignored
 * - the name is reduced to a safe display name (no path, no control characters)
 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_FILES = 4;
export const MAX_TOTAL_BYTES = 6 * 1024 * 1024;
export const MAX_BODY_CHARS = 100_000;

export type FileCategory = 'text' | 'image' | 'pdf';

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'log', 'tex', 'toml', 'ini', 'cfg',
  'py', 'ipynb', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'go', 'rs', 'rb', 'php',
  'swift', 'scala', 'sql', 'sh', 'bash', 'ps1', 'r', 'm', 'jl', 'lua', 'dart', 'html', 'css', 'scss', 'vue', 'svelte',
]);
const IMAGE_EXT: Record<string, string[]> = { png: ['image/png'], jpg: ['image/jpeg'], jpeg: ['image/jpeg'], gif: ['image/gif'], webp: ['image/webp'] };

/** Extensions shown to the owner (dashboard `accept` list and error messages). */
export const ALLOWED_EXTENSIONS = [...TEXT_EXT, ...Object.keys(IMAGE_EXT), 'pdf'].sort();

export interface StoredFile {
  name: string;
  mediaType: string;
  category: FileCategory;
  size: number;
  sha256: string;
  content: Buffer;
}

export class UploadError extends Error {}

const startsWith = (b: Buffer, sig: number[] | string, offset = 0) => {
  const bytes = typeof sig === 'string' ? Buffer.from(sig, 'latin1') : Buffer.from(sig);
  return b.length >= offset + bytes.length && b.subarray(offset, offset + bytes.length).equals(bytes);
};

/** Executables, archives and other containers we never store, whatever the name says. */
function forbiddenSignature(b: Buffer): string | null {
  if (startsWith(b, 'MZ')) return 'Windows executable';
  if (startsWith(b, [0x7f, 0x45, 0x4c, 0x46])) return 'ELF executable';
  if ([[0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe]].some((s) => startsWith(b, s))) return 'Mach-O / Java class file';
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06])) return 'ZIP archive (also docx/xlsx/jar/apk)';
  if (startsWith(b, [0x1f, 0x8b])) return 'gzip archive';
  if (startsWith(b, 'Rar!')) return 'RAR archive';
  if (startsWith(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z archive';
  if (startsWith(b, [0xd0, 0xcf, 0x11, 0xe0])) return 'OLE document';
  if (startsWith(b, [0x00, 0x61, 0x73, 0x6d])) return 'WebAssembly module';
  return null;
}

function sniffImage(b: Buffer): string | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(b, 'GIF87a') || startsWith(b, 'GIF89a')) return 'image/gif';
  if (startsWith(b, 'RIFF') && startsWith(b, 'WEBP', 8)) return 'image/webp';
  return null;
}

/** Display name only: last path segment, no control or reserved characters, bounded length. */
export function safeFileName(raw: string): string {
  const base = String(raw ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f<>:"|?*‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (!cleaned) return 'file';
  if (cleaned.length <= 120) return cleaned;
  const ext = extname(cleaned).slice(0, 12);
  return cleaned.slice(0, 120 - ext.length) + ext;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decodes and checks one uploaded file. Throws UploadError with an owner-readable reason. */
export function checkUpload(input: { name: string; contentBase64: string }): StoredFile {
  const name = safeFileName(input.name);
  const b64 = String(input.contentBase64 ?? '').replace(/\s+/g, '');
  if (!BASE64.test(b64) || b64.length % 4 !== 0) throw new UploadError(`${name}: content is not valid base64`);
  if ((b64.length / 4) * 3 > MAX_FILE_BYTES + 3) throw new UploadError(`${name}: larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  const content = Buffer.from(b64, 'base64');
  if (content.length === 0) throw new UploadError(`${name}: the file is empty`);
  if (content.length > MAX_FILE_BYTES) throw new UploadError(`${name}: larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  const forbidden = forbiddenSignature(content);
  if (forbidden) throw new UploadError(`${name}: ${forbidden} files are not accepted`);
  const ext = extname(name).slice(1).toLowerCase();
  let category: FileCategory;
  let mediaType: string;
  if (TEXT_EXT.has(ext)) {
    if (content.includes(0)) throw new UploadError(`${name}: contains binary data; text and code files must be plain UTF-8`);
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      throw new UploadError(`${name}: is not valid UTF-8 text`);
    }
    category = 'text';
    // Always served back as plain text, never as HTML/script, whatever the extension.
    mediaType = 'text/plain; charset=utf-8';
  } else if (IMAGE_EXT[ext]) {
    const sniffed = sniffImage(content);
    if (!sniffed || !IMAGE_EXT[ext].includes(sniffed)) throw new UploadError(`${name}: the content is not a ${ext.toUpperCase()} image`);
    category = 'image';
    mediaType = sniffed;
  } else if (ext === 'pdf') {
    if (!startsWith(content, '%PDF-')) throw new UploadError(`${name}: the content is not a PDF`);
    category = 'pdf';
    mediaType = 'application/pdf';
  } else {
    throw new UploadError(`${name}: .${ext || '(none)'} files are not accepted (allowed: text/code, PNG/JPEG/GIF/WebP images, PDF)`);
  }
  return { name, mediaType, category, size: content.length, sha256: createHash('sha256').update(content).digest('hex'), content };
}

/** Checks a whole submission's files (count, total size, duplicate names get a suffix). */
export function checkUploads(inputs: Array<{ name: string; contentBase64: string }>): StoredFile[] {
  if (inputs.length > MAX_FILES) throw new UploadError(`At most ${MAX_FILES} files per submission`);
  const files = inputs.map(checkUpload);
  const total = files.reduce((s, f) => s + f.size, 0);
  if (total > MAX_TOTAL_BYTES) throw new UploadError(`Files together are larger than ${MAX_TOTAL_BYTES / 1024 / 1024} MB`);
  const seen = new Map<string, number>();
  for (const f of files) {
    const n = (seen.get(f.name) ?? 0) + 1;
    seen.set(f.name, n);
    if (n > 1) {
      const ext = extname(f.name);
      f.name = `${f.name.slice(0, f.name.length - ext.length)} (${n})${ext}`;
    }
  }
  return files;
}
