import 'server-only';
import { readFile, stat } from 'node:fs/promises';
import { checkSnapshot, type ServiceMapSnapshot } from './service-map';

/** The host collector's output, mounted read-only (compose.dashboard.yaml: ./data/service-map). */
export function serviceMapFile(): string {
  return process.env.SERVICE_MAP_FILE?.trim() || '/var/lib/service-map/service-map.json';
}

const MAX_BYTES = 4 * 1024 * 1024;

export type ServiceMapRead =
  | { ok: true; snapshot: ServiceMapSnapshot }
  | { ok: false; code: 'missing' | 'too_large' | 'invalid'; message: string };

export async function readServiceMap(file = serviceMapFile()): Promise<ServiceMapRead> {
  try {
    const info = await stat(file);
    if (info.size > MAX_BYTES) return { ok: false, code: 'too_large', message: `snapshot is ${info.size} bytes` };
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    const checked = checkSnapshot(parsed);
    return checked.ok ? { ok: true, snapshot: checked.snapshot } : { ok: false, code: 'invalid', message: checked.reason };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, code: 'missing', message: 'no snapshot yet' };
    return { ok: false, code: 'invalid', message: err instanceof SyntaxError ? 'not valid JSON' : 'unreadable' };
  }
}
