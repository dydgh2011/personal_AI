import type { Dict } from '@/i18n';

export type LineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta';

export interface PatchFile {
  path: string;
  lines: Array<{ kind: LineKind; text: string }>;
}

/**
 * Splits a unified diff into files and classified lines. The result is rendered as plain text
 * (React escapes it), so markup in code or commit messages is never interpreted.
 */
export function parsePatch(patch: string | null): PatchFile[] {
  if (!patch) return [];
  const files: PatchFile[] = [];
  let current: PatchFile | null = null;
  for (const text of patch.split('\n')) {
    const header = /^diff --git a\/(.+?) b\//.exec(text);
    if (header) {
      current = { path: header[1], lines: [{ kind: 'meta', text }] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    let kind: LineKind = 'ctx';
    if (text.startsWith('@@')) kind = 'hunk';
    else if (text.startsWith('+++') || text.startsWith('---') || /^(index|new file|deleted file|similarity|rename|old mode|new mode)/.test(text)) kind = 'meta';
    else if (text.startsWith('+')) kind = 'add';
    else if (text.startsWith('-')) kind = 'del';
    current.lines.push({ kind, text });
  }
  return files;
}

export const short = (sha: string | null | undefined, n = 12) => (sha ? sha.slice(0, n) : 'unknown');

export function since(iso: string | null | undefined, t: Dict): string {
  if (!iso) return t.common.unknown;
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return t.common.unknown;
  if (s < 60) return t.common.secondsAgo(s);
  if (s < 3600) return t.common.minutesAgo(Math.round(s / 60));
  if (s < 86400) return t.common.hoursAgo(Math.round(s / 3600));
  return t.common.daysAgo(Math.round(s / 86400));
}

export function duration(start: string | null, end: string | null, t: Dict): string {
  if (!start || !end) return t.common.unknown;
  const s = (Date.parse(end) - Date.parse(start)) / 1000;
  return Number.isFinite(s) ? t.common.seconds(s.toFixed(1)) : t.common.unknown;
}
