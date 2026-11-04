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

export function since(iso: string | null | undefined): string {
  if (!iso) return 'unknown';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return 'unknown';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function duration(start: string | null, end: string | null): string {
  if (!start || !end) return 'unknown';
  const s = (Date.parse(end) - Date.parse(start)) / 1000;
  return Number.isFinite(s) ? `${s.toFixed(1)}s` : 'unknown';
}
