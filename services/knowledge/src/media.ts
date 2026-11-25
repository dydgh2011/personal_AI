import { connect } from 'node:net';
import { extname } from 'node:path';

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff'] as const;
export const SOUND_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.wmv'] as const;
export const MAX_EXTRACTED_CHARS = 180_000;
export const MAX_MEDIA_BYTES = 4 * 1024 ** 3;
const RESPONSE_BYTES = 2 * 1024 ** 2;
const FAILURES = ['too_large', 'too_long', 'no_audio', 'invalid_file', 'timeout', 'engine_failed', 'model_required', 'unsupported'] as const;

export type MediaKind = 'ocr' | 'transcription';
export type MediaJob = { id: string; blob: string; method: MediaKind };
export type MediaErrorCode = (typeof FAILURES)[number];
export type MediaResult = { status: 'complete'; text: string } | { status: 'failed'; code: MediaErrorCode };

export function mediaKind(blob: string): MediaKind | null {
  const ext = extname(blob).toLowerCase();
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return 'ocr';
  if ((SOUND_EXTENSIONS as readonly string[]).includes(ext)) return 'transcription';
  return null;
}

function request(path: string, payload: object, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    const chunks: Buffer[] = [];
    let size = 0;
    const timeout = setTimeout(() => socket.destroy(new Error('Media worker deadline exceeded')), timeoutMs);
    socket.once('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > RESPONSE_BYTES) {
        socket.destroy(new Error('Media worker response exceeded the limit'));
        return;
      }
      chunks.push(chunk);
    });
    socket.once('error', reject);
    socket.once('close', () => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Media worker did not return a result'));
      }
    });
  });
}

export async function mediaCapabilities(path: string): Promise<{ transcription: boolean }> {
  const reply = await request(path, { op: 'status' }, 3_000) as { transcription?: unknown } | null;
  if (typeof reply?.transcription !== 'boolean') throw new Error('Invalid media worker status');
  return { transcription: reply.transcription };
}

export async function extractMedia(path: string, job: MediaJob): Promise<MediaResult> {
  const reply = await request(path, { op: 'extract', blob: job.blob }, 65 * 60_000) as Partial<{
    status: unknown; code: MediaErrorCode; text: unknown;
  }> | null;
  if (reply?.status === 'complete' && typeof reply.text === 'string' && reply.text.length <= MAX_EXTRACTED_CHARS * 2) {
    return { status: 'complete', text: redactExtract(reply.text).trim().slice(0, MAX_EXTRACTED_CHARS) };
  }
  if (reply?.status === 'failed' && reply.code && FAILURES.includes(reply.code)) return { status: 'failed', code: reply.code };
  throw new Error('Invalid media worker result');
}

/** Media text receives the same credential masking as text attachments from Hermes. */
function redactExtract(text: string): string {
  return text
    .replace(/https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/g, '[redacted:discord-webhook]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted:private-key]')
    .replace(/\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|GOCSPX-[A-Za-z0-9_-]{10,})/g, '[redacted:api-key]')
    .replace(/\bbearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi, '[redacted:bearer]')
    .replace(/(?<![\p{L}\p{N}_])(password|passwd|비밀번호|패스워드)\s*[:=]\s*\S+/giu, '$1: [redacted:password]');
}
