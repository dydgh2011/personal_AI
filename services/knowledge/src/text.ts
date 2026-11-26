/** Text helpers: chunking for search, slugs, keyword queries. */

export const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 150;

/** Splits text into ~1200-character pieces on line/sentence boundaries, with a small overlap. */
export function chunk(text: string, size = CHUNK_CHARS): string[] {
  const clean = text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (clean.length <= size) return clean ? [clean] : [];
  const parts: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start + Math.floor(size / 2), end);
      const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('. '), window.lastIndexOf('다. '));
      if (cut > 0) end = start + Math.floor(size / 2) + cut + 1;
    }
    parts.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return parts.filter(Boolean);
}

/** URL-safe, readable slug; keeps Korean letters (older Korean pages keep their slug when renamed). */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || 'page';
}

// Korean particles that stick to the end of a word ("헬스를", "CSC263은"): dropped from query words
// so a prefix search still finds the stored word.
const PARTICLES = ['에서는', '에서', '으로', '까지', '부터', '한테', '에게', '이랑', '처럼', '보다', '은', '는', '이', '가', '을', '를', '에', '의', '로', '와', '과', '도', '만', '랑'];

export function queryWords(q: string): string[] {
  const words = (q.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => {
    for (const p of PARTICLES) {
      if (w.length > p.length + 1 && w.endsWith(p) && /[가-힣]$/.test(w)) return w.slice(0, -p.length);
    }
    return w;
  });
  return [...new Set(words.filter((w) => w.length >= 2 || /[가-힣]/.test(w)))].slice(0, 12);
}

/**
 * FTS5 query: any of the words, each as a prefix. Words contain only letters/digits, so no quoting issues.
 * `extra` adds the words of other names for what the question mentions (a page's English title when the
 * question used its Korean alias, and the other way round), so a Korean question finds English text.
 */
export function ftsQuery(q: string, extra: string[] = []): string | null {
  const words = [...new Set([...queryWords(q), ...extra.flatMap((e) => queryWords(e))])].slice(0, 24);
  return words.length ? words.map((w) => `"${w}"*`).join(' OR ') : null;
}

/** Lowercase letters and digits only: "Linear Algebra" -> "linearalgebra", "선형대수는" -> "선형대수는". */
export function squash(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Whether a page name (title or alias) is mentioned in a question, spaces and punctuation ignored, so a
 * Korean particle after the name still counts ("선형대수는"). Short names must be a whole word, so
 * "me" or "AI" does not match inside "game" or "said".
 */
export function mentions(question: string, name: string): boolean {
  const n = squash(name);
  if (!n) return false;
  if (/[가-힣]/.test(n)) return n.length >= 2 && squash(question).includes(n);
  if (n.length >= 4) return squash(question).includes(n);
  return n.length >= 2 && queryWords(question).some((w) => w === n);
}

/** A short excerpt around the first query word (or the start). */
export function snippet(text: string, q: string, max = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const lower = flat.toLowerCase();
  let at = -1;
  for (const w of queryWords(q)) {
    at = lower.indexOf(w);
    if (at >= 0) break;
  }
  const start = at < 0 ? 0 : Math.max(0, at - Math.floor(max / 3));
  const piece = flat.slice(start, start + max);
  return (start > 0 ? '…' : '') + piece + (start + max < flat.length ? '…' : '');
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
}
