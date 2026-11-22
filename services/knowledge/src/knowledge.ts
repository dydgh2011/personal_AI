import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { basename, extname, join, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { EMBED_DIMENSIONS, transaction } from './db.js';
import { EmbedError, type Embedder } from './embed.js';
import { chunk, clip, ftsQuery, slugify, snippet } from './text.js';

export class KnowledgeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const bad = (message: string, extra: Record<string, unknown> = {}) => new KnowledgeError(400, 'invalid_request', message, extra);
const notFound = (message: string, extra: Record<string, unknown> = {}) => new KnowledgeError(404, 'not_found', message, extra);

export type Actor = 'hermes' | 'system' | 'operator';

export const PAGE_TYPES = ['me', 'course', 'topic', 'goal', 'project', 'person', 'habit', 'place', 'org', 'other'] as const;
export const ACTIVITY_KINDS = [
  'study', 'class', 'assignment', 'exam', 'project', 'coding', 'reading', 'experiment', 'exercise',
  'chore', 'errand', 'social', 'work', 'rest', 'health', 'other',
] as const;
const RAW_SOURCES = ['chat', 'note', 'import', 'system'] as const;
const SEARCH_KINDS = ['page', 'fact', 'activity', 'raw'] as const;
type SearchKind = (typeof SEARCH_KINDS)[number];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
const RELATION = /^[a-z][a-z_]{1,29}$/;
const KIND = /^[a-z0-9][a-z0-9._-]{1,40}$/;
const EXTERNAL_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const MAX_RAW_CHARS = 5_000_000;
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const RAW_READ_CHARS = 8000;
const DOC_PREFIX = /^doc_[0-9a-f]{6,32}_/;
/** Semantic match needed for automatic recall (bge-m3 cosine; unrelated text is usually below 0.45). */
const RECALL_MIN_SIMILARITY = 0.5;
const SEMANTIC_MIN_SIMILARITY = 0.35;

export interface PageRow {
  id: string;
  slug: string;
  title: string;
  type: string;
  summary: string;
  aliases: string;
  archived: number;
  created_at: string;
  updated_at: string;
}
interface FactRow {
  id: string;
  page_id: string;
  text: string;
  observed_on: string | null;
  source_raw_id: string | null;
  source_note: string | null;
  status: string;
  superseded_by: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}
interface ActivityRow {
  id: string;
  started_at: string;
  minutes: number | null;
  kind: string;
  title: string;
  detail: string | null;
  outcome: string | null;
  feeling: string | null;
  source_raw_id: string | null;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}
interface RawRow {
  id: string;
  source: string;
  kind: string;
  title: string | null;
  occurred_at: string;
  received_at: string;
  external_id: string | null;
  sha256: string | null;
  content_type: string | null;
  size: number;
  blob: string | null;
  text: string;
  meta: string;
}
interface ItemRow {
  rowid: number;
  kind: SearchKind;
  ref_id: string;
  part: number;
  page_id: string | null;
  date: string | null;
  text: string;
}

export interface SearchHit {
  kind: SearchKind;
  id: string;
  part?: number;
  title: string;
  snippet: string;
  page?: { slug: string; title: string; type: string };
  date?: string;
  match: 'keyword' | 'meaning' | 'both';
  similarity?: number;
}

export interface KnowledgeOptions {
  timeZone: string;
  blobDir: string;
  /** Hermes's chat attachment folder, mounted read-only (null = documents cannot be stored). */
  documentsDir: string | null;
  embedder: Embedder | null;
  now?: () => Date;
}

// ---- small validators -------------------------------------------------------------------------

function str(body: Record<string, unknown>, key: string, max: number, required = false): string | undefined {
  const v = body[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`${key} is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw bad(`${key} must be a string`);
  const t = v.trim();
  if (required && !t) throw bad(`${key} must not be blank`);
  if (t.length > max) throw bad(`${key} is longer than ${max} characters`);
  return t;
}

function only(body: Record<string, unknown>, allowed: string[]) {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length) throw bad(`Unexpected fields: ${extra.join(', ')} (allowed: ${allowed.join(', ')})`);
}

function oneOf<T extends string>(value: unknown, key: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw bad(`${key} must be one of ${allowed.join(', ')}`);
  return value as T;
}

function dateStr(value: unknown, key: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw bad(`${key} must be a date YYYY-MM-DD`);
  return value;
}

function intIn(value: unknown, key: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw bad(`${key} must be an integer ${min}-${max}`);
  return value as number;
}

function strList(value: unknown, key: string, maxItems: number, maxLen: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems || !value.every((v) => typeof v === 'string' && v.trim() && v.length <= maxLen)) {
    throw bad(`${key} must be a list of up to ${maxItems} non-empty strings`);
  }
  return [...new Set((value as string[]).map((v) => v.trim()))];
}

function displayName(file: string): string {
  return file.replace(DOC_PREFIX, '');
}

// ---- the store --------------------------------------------------------------------------------

export class Knowledge {
  readonly timeZone: string;
  private readonly db: DatabaseSync;
  private readonly blobDir: string;
  private readonly documentsDir: string | null;
  readonly embedder: Embedder | null;
  private readonly now: () => Date;

  constructor(db: DatabaseSync, options: KnowledgeOptions) {
    this.db = db;
    this.timeZone = options.timeZone;
    this.blobDir = options.blobDir;
    this.documentsDir = options.documentsDir;
    this.embedder = options.embedder;
    this.now = options.now ?? (() => new Date());
    mkdirSync(this.blobDir, { recursive: true });
    this.ensureMe();
  }

  private iso(): string {
    return this.now().toISOString();
  }

  /** Local YYYY-MM-DD of an instant. */
  localDate(at: Date = this.now()): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  }

  private log(actor: Actor, action: string, entity: string, entityId: string | null, detail: unknown) {
    this.db
      .prepare('INSERT INTO change_log (ts, actor, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(this.iso(), actor, action, entity, entityId, JSON.stringify(detail));
  }

  private ensureMe() {
    if (this.db.prepare("SELECT 1 FROM pages WHERE slug = 'me'").get()) return;
    const ts = this.iso();
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO pages (id, slug, title, type, summary, aliases, created_at, updated_at) VALUES (?, 'me', ?, 'me', '', '[]', ?, ?)")
      .run(id, '나 (owner)', ts, ts);
    this.indexPage(id);
  }

  // ---- search index maintenance ----

  private setItem(kind: SearchKind, refId: string, part: number, text: string, pageId: string | null, date: string | null) {
    const existing = this.db.prepare('SELECT rowid, text FROM search_items WHERE kind = ? AND ref_id = ? AND part = ?').get(kind, refId, part) as
      | { rowid: number; text: string }
      | undefined;
    if (existing) {
      if (existing.text === text) {
        this.db.prepare('UPDATE search_items SET page_id = ?, date = ? WHERE rowid = ?').run(pageId, date, existing.rowid);
        return;
      }
      this.db
        .prepare('UPDATE search_items SET text = ?, page_id = ?, date = ?, embed_model = NULL, embed_failed_at = NULL WHERE rowid = ?')
        .run(text, pageId, date, existing.rowid);
      this.db.prepare('DELETE FROM vec_items WHERE rowid = ?').run(BigInt(existing.rowid));
      return;
    }
    this.db.prepare('INSERT INTO search_items (kind, ref_id, part, page_id, date, text) VALUES (?, ?, ?, ?, ?, ?)').run(kind, refId, part, pageId, date, text);
  }

  private dropItems(kind: SearchKind, refId: string) {
    const rows = this.db.prepare('SELECT rowid FROM search_items WHERE kind = ? AND ref_id = ?').all(kind, refId) as Array<{ rowid: number }>;
    const dropVector = this.db.prepare('DELETE FROM vec_items WHERE rowid = ?');
    for (const r of rows) dropVector.run(BigInt(r.rowid));
    this.db.prepare('DELETE FROM search_items WHERE kind = ? AND ref_id = ?').run(kind, refId);
  }

  private indexPage(pageId: string) {
    const p = this.db.prepare('SELECT * FROM pages WHERE id = ?').get(pageId) as unknown as PageRow;
    if (p.archived) return this.dropItems('page', p.id);
    const aliases = JSON.parse(p.aliases) as string[];
    const text = `${p.title} (${p.type})${aliases.length ? ` [${aliases.join(', ')}]` : ''}${p.summary ? `: ${p.summary}` : ''}`;
    this.setItem('page', p.id, 0, text, p.id, null);
    // Facts carry the page title in their text: refresh them when the title changes.
    const facts = this.db.prepare("SELECT id FROM facts WHERE page_id = ? AND status = 'active'").all(p.id) as Array<{ id: string }>;
    for (const f of facts) this.indexFact(f.id);
  }

  private indexFact(factId: string) {
    const f = this.db.prepare('SELECT f.*, p.title AS page_title FROM facts f JOIN pages p ON p.id = f.page_id WHERE f.id = ?').get(factId) as unknown as FactRow & {
      page_title: string;
    };
    if (f.status !== 'active') return this.dropItems('fact', f.id);
    this.setItem('fact', f.id, 0, `${f.page_title}: ${f.text}`, f.page_id, f.observed_on);
  }

  private indexActivity(activityId: string) {
    const a = this.db.prepare('SELECT * FROM activities WHERE id = ?').get(activityId) as unknown as ActivityRow;
    if (a.status !== 'active') return this.dropItems('activity', a.id);
    const pages = this.activityPages(a.id);
    const text = [a.started_at, a.kind, a.title, a.detail, a.outcome, a.feeling, pages.length ? `(${pages.map((p) => p.title).join(', ')})` : '']
      .filter(Boolean)
      .join(' · ');
    this.setItem('activity', a.id, 0, text, pages[0]?.id ?? null, a.started_at.slice(0, 10));
  }

  private indexRaw(raw: { id: string; text: string; title: string | null; occurred_at: string }) {
    const date = this.localDate(new Date(raw.occurred_at));
    const pieces = chunk(raw.text);
    pieces.forEach((piece, i) => this.setItem('raw', raw.id, i, i === 0 && raw.title ? `${raw.title}\n${piece}` : piece, null, date));
  }

  // ---- layer 0: raw originals ----

  addRaw(body: Record<string, unknown>, actor: Actor) {
    only(body, ['source', 'kind', 'title', 'text', 'occurredAt', 'externalId', 'meta']);
    const source = oneOf(body.source, 'source', RAW_SOURCES);
    const kind = str(body, 'kind', 41, true)!;
    if (!KIND.test(kind)) throw bad('kind must be 2-41 characters of a-z 0-9 . _ -');
    const title = str(body, 'title', 200);
    if (typeof body.text !== 'string' || !body.text.trim()) throw bad('text is required');
    if (body.text.length > MAX_RAW_CHARS) throw bad(`text is longer than ${MAX_RAW_CHARS} characters`);
    const text = body.text;
    let occurredAt = this.iso();
    if (body.occurredAt !== undefined) {
      if (typeof body.occurredAt !== 'string' || Number.isNaN(Date.parse(body.occurredAt))) throw bad('occurredAt must be an ISO time');
      occurredAt = new Date(body.occurredAt).toISOString();
    }
    const externalId = str(body, 'externalId', 200);
    if (externalId !== undefined && !EXTERNAL_ID.test(externalId)) throw bad('externalId must be 1-200 characters of A-Z a-z 0-9 . _ : -');
    const meta = body.meta ?? {};
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta) || JSON.stringify(meta).length > 8192) throw bad('meta must be a JSON object under 8 KB');

    if (externalId) {
      const dup = this.db.prepare('SELECT id FROM raw_items WHERE source = ? AND external_id = ?').get(source, externalId) as { id: string } | undefined;
      if (dup) return { id: dup.id, duplicate: true };
    }
    const id = randomUUID();
    transaction(this.db, () => {
      this.db
        .prepare(
          'INSERT INTO raw_items (id, source, kind, title, occurred_at, received_at, external_id, sha256, content_type, size, blob, text, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)',
        )
        .run(id, source, kind, title ?? null, occurredAt, this.iso(), externalId ?? null, createHash('sha256').update(text).digest('hex'), 'text/plain', Buffer.byteLength(text), text, JSON.stringify(meta));
      this.indexRaw({ id, text, title: title ?? null, occurred_at: occurredAt });
      if (source !== 'chat') this.log(actor, 'add', 'raw', id, { source, kind, title, chars: text.length });
    });
    return { id, duplicate: false };
  }

  /** The attached file named `file` in Hermes's attachment folder, if it is a regular file inside it. */
  private findDocument(file: string): string {
    if (!this.documentsDir) throw new KnowledgeError(503, 'not_configured', 'The attachment folder is not mounted');
    if (!/^[^/\\\0]{1,255}$/.test(file) || file === '.' || file === '..') throw bad('file must be a plain file name');
    const root = realpathSync(this.documentsDir);
    const folders = [root];
    const native = join(root, 'native-inputs');
    try {
      if (lstatSync(native).isDirectory()) {
        for (const d of readdirSync(native, { withFileTypes: true })) if (d.isDirectory()) folders.push(join(native, d.name));
      }
    } catch {
      /* no native-inputs */
    }
    let best: { path: string; mtime: number } | null = null;
    for (const folder of folders) {
      const candidate = join(folder, file);
      let st;
      try {
        st = lstatSync(candidate);
      } catch {
        continue;
      }
      if (!st.isFile()) continue; // lstat: symlinks are not files
      const real = realpathSync(candidate);
      if (!real.startsWith(root + sep)) continue;
      if (!best || st.mtimeMs > best.mtime) best = { path: real, mtime: st.mtimeMs };
    }
    if (!best) throw notFound(`No attached file named ${file}`);
    return best.path;
  }

  /** Stores an attached document: the original bytes (copied once, by hash) plus the text the caller extracted. */
  addDocument(body: Record<string, unknown>, actor: Actor) {
    only(body, ['file', 'text', 'contentType', 'pageCount', 'meta']);
    const file = str(body, 'file', 255, true)!;
    if (typeof body.text !== 'string') throw bad('text is required (the extracted text; may be empty for images)');
    if (body.text.length > MAX_RAW_CHARS) throw bad(`text is longer than ${MAX_RAW_CHARS} characters`);
    const contentType = str(body, 'contentType', 100);
    const pageCount = intIn(body.pageCount, 'pageCount', 0, 100_000);
    const meta = body.meta ?? {};
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta) || JSON.stringify(meta).length > 8192) throw bad('meta must be a JSON object under 8 KB');
    const path = this.findDocument(file);
    const st = statSync(path);
    if (st.size > MAX_DOCUMENT_BYTES) throw new KnowledgeError(413, 'too_large', 'The document is larger than 50 MB');
    const bytes = readFileSync(path);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const dup = this.db.prepare('SELECT id FROM raw_items WHERE blob IS NOT NULL AND sha256 = ?').get(sha) as { id: string } | undefined;
    if (dup) return { id: dup.id, duplicate: true };
    const ext = extname(file).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10);
    const blob = `${sha}${ext}`;
    try {
      copyFileSync(path, join(this.blobDir, blob));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const id = randomUUID();
    const title = displayName(basename(file));
    const occurredAt = new Date(st.mtimeMs).toISOString();
    const text = body.text;
    transaction(this.db, () => {
      this.db
        .prepare(
          "INSERT INTO raw_items (id, source, kind, title, occurred_at, received_at, external_id, sha256, content_type, size, blob, text, meta) VALUES (?, 'document', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)",
        )
        .run(id, ext.replace('.', '') || 'file', title, occurredAt, this.iso(), sha, contentType ?? null, st.size, blob, text, JSON.stringify({ ...(meta as object), pageCount }));
      if (text.trim()) this.indexRaw({ id, text, title, occurred_at: occurredAt });
      this.log(actor, 'add', 'raw', id, { source: 'document', title, bytes: st.size, chars: text.length });
    });
    return { id, duplicate: false, title };
  }

  listRaw(query: URLSearchParams) {
    const where: string[] = [];
    const args: string[] = [];
    const source = query.get('source');
    if (source) {
      oneOf(source, 'source', [...RAW_SOURCES, 'document'] as const);
      where.push('source = ?');
      args.push(source);
    }
    const from = dateStr(query.get('from') ?? undefined, 'from');
    const to = dateStr(query.get('to') ?? undefined, 'to');
    if (from) {
      where.push('occurred_at >= ?');
      args.push(new Date(`${from}T00:00:00Z`).toISOString());
    }
    if (to) {
      where.push('occurred_at < ?');
      args.push(new Date(Date.parse(`${to}T00:00:00Z`) + 2 * 86_400_000).toISOString());
    }
    const limit = Math.min(Number(query.get('limit') ?? 20) || 20, 100);
    const rows = this.db
      .prepare(`SELECT id, source, kind, title, occurred_at, size, substr(text, 1, 200) AS preview FROM raw_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY occurred_at DESC LIMIT ${limit}`)
      .all(...args) as Array<{ id: string; source: string; kind: string; title: string | null; occurred_at: string; size: number; preview: string }>;
    return rows
      .filter((r) => (from || to ? this.inRange(r.occurred_at, from, to) : true))
      .map((r) => ({ id: r.id, source: r.source, kind: r.kind, title: r.title, date: this.localDate(new Date(r.occurred_at)), size: r.size, preview: clip(r.preview, 160) }));
  }

  private inRange(iso: string, from?: string, to?: string): boolean {
    const d = this.localDate(new Date(iso));
    return (!from || d >= from) && (!to || d <= to);
  }

  getRaw(id: string, query: URLSearchParams) {
    const r = this.db.prepare('SELECT * FROM raw_items WHERE id = ?').get(id) as unknown as RawRow | undefined;
    if (!r) throw notFound('No raw item with this id');
    const offset = Math.max(0, Number(query.get('offset') ?? 0) || 0);
    const limit = Math.min(Math.max(Number(query.get('limit') ?? RAW_READ_CHARS) || RAW_READ_CHARS, 100), RAW_READ_CHARS);
    return {
      id: r.id,
      source: r.source,
      kind: r.kind,
      title: r.title,
      occurredAt: r.occurred_at,
      date: this.localDate(new Date(r.occurred_at)),
      size: r.size,
      storedOriginal: r.blob !== null,
      totalChars: r.text.length,
      offset,
      text: r.text.slice(offset, offset + limit),
      more: offset + limit < r.text.length,
      meta: JSON.parse(r.meta),
    };
  }

  /** The stored original with this content hash, if any (importers skip files already stored). */
  rawBySha(sha: string) {
    if (!/^[0-9a-f]{64}$/.test(sha)) throw bad('sha256 must be 64 hex characters');
    const r = this.db.prepare('SELECT id, title, source, kind FROM raw_items WHERE sha256 = ? AND blob IS NOT NULL').get(sha) as
      | { id: string; title: string | null; source: string; kind: string }
      | undefined;
    if (!r) throw notFound('No stored original with this hash');
    return r;
  }

  /**
   * Registers a file an importer already copied into the blob folder as <sha256><ext>, with the text it
   * extracted. The file must exist with the given size; files up to 512 MB are re-hashed to check.
   */
  async addRawFile(body: Record<string, unknown>, actor: Actor) {
    only(body, ['sha256', 'blob', 'size', 'title', 'path', 'kind', 'contentType', 'text', 'pageCount', 'occurredAt', 'meta']);
    const sha = str(body, 'sha256', 64, true)!;
    if (!/^[0-9a-f]{64}$/.test(sha)) throw bad('sha256 must be 64 hex characters');
    const blob = str(body, 'blob', 80, true)!;
    if (!new RegExp(`^${sha}(\\.[a-z0-9]{1,10})?$`).test(blob)) throw bad('blob must be <sha256> plus an optional lower-case extension');
    const size = intIn(body.size, 'size', 0, Number.MAX_SAFE_INTEGER);
    if (size === undefined) throw bad('size is required');
    const title = str(body, 'title', 300, true)!;
    const path = str(body, 'path', 1000);
    const kind = str(body, 'kind', 41, true)!;
    if (!KIND.test(kind)) throw bad('kind must be 2-41 characters of a-z 0-9 . _ -');
    const contentType = str(body, 'contentType', 100);
    const pageCount = intIn(body.pageCount, 'pageCount', 0, 1_000_000);
    if (typeof body.text !== 'string') throw bad('text is required (may be empty when nothing could be extracted)');
    if (body.text.length > MAX_RAW_CHARS) throw bad(`text is longer than ${MAX_RAW_CHARS} characters`);
    const text = body.text;
    let occurredAt = this.iso();
    if (body.occurredAt !== undefined) {
      if (typeof body.occurredAt !== 'string' || Number.isNaN(Date.parse(body.occurredAt))) throw bad('occurredAt must be an ISO time');
      occurredAt = new Date(body.occurredAt).toISOString();
    }
    const meta = body.meta ?? {};
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta) || JSON.stringify(meta).length > 8192) throw bad('meta must be a JSON object under 8 KB');

    const dup = this.db.prepare('SELECT id FROM raw_items WHERE blob IS NOT NULL AND sha256 = ?').get(sha) as { id: string } | undefined;
    if (dup) return { id: dup.id, duplicate: true };
    const file = join(this.blobDir, blob);
    let st;
    try {
      st = lstatSync(file);
    } catch {
      throw notFound(`The blob ${blob} is not in the blob folder`);
    }
    if (!st.isFile() || st.size !== size) throw bad('The blob is missing or has another size');
    if (size <= 512 * 1024 * 1024 && (await sha256File(file)) !== sha) throw bad('The blob content does not match sha256');

    const id = randomUUID();
    transaction(this.db, () => {
      this.db
        .prepare(
          "INSERT INTO raw_items (id, source, kind, title, occurred_at, received_at, external_id, sha256, content_type, size, blob, text, meta) VALUES (?, 'import', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)",
        )
        .run(id, kind, title, occurredAt, this.iso(), sha, contentType ?? null, size, blob, text, JSON.stringify({ ...(meta as object), path, pageCount }));
      if (text.trim()) this.indexRaw({ id, text, title, occurred_at: occurredAt });
      this.log(actor, 'add', 'raw', id, { source: 'import', kind, title, path, bytes: size, chars: text.length });
    });
    return { id, duplicate: false };
  }

  /**
   * Permanent deletion on the owner's request (wrong or private information). Unlike remove/supersede,
   * nothing is kept: the row, its search entries and vectors, older versions of a fact, the stored file
   * of an original, and the content in the change log (replaced by a tombstone with the reason).
   */
  purge(body: Record<string, unknown>, actor: Actor): { purged: string; versions?: number; facts?: number; fileDeleted?: boolean } {
    only(body, ['target', 'id', 'page', 'reason']);
    const target = oneOf(body.target, 'target', ['raw', 'fact', 'activity', 'page'] as const);
    const reason = str(body, 'reason', 300, true)!;
    const scrub = this.db.prepare("UPDATE change_log SET detail = '{\"purged\":true}' WHERE entity_id = ?");
    const tombstone = (entity: string, ids: string[], extra: Record<string, unknown> = {}) =>
      this.log(actor, 'purge', entity, ids[0] ?? null, { ids, reason, ...extra });

    if (target === 'page') {
      const p = this.page(str(body, 'page', 200) ?? str(body, 'id', 200) ?? '');
      if (p.slug === 'me') throw bad('The owner page cannot be purged (purge its facts instead)');
      return transaction(this.db, () => {
        const facts = this.db.prepare('SELECT id FROM facts WHERE page_id = ?').all(p.id) as Array<{ id: string }>;
        for (const f of facts) {
          this.dropItems('fact', f.id);
          scrub.run(f.id);
        }
        this.db.prepare('DELETE FROM facts WHERE page_id = ?').run(p.id);
        this.db.prepare('DELETE FROM links WHERE from_page = ? OR to_page = ?').run(p.id, p.id);
        const touched = this.db.prepare('SELECT activity_id FROM activity_pages WHERE page_id = ?').all(p.id) as Array<{ activity_id: string }>;
        this.db.prepare('DELETE FROM activity_pages WHERE page_id = ?').run(p.id);
        for (const a of touched) this.indexActivity(a.activity_id);
        this.dropItems('page', p.id);
        this.db.prepare('DELETE FROM pages WHERE id = ?').run(p.id);
        scrub.run(p.id);
        tombstone('page', [p.id], { facts: facts.length });
        return { purged: 'page', facts: facts.length };
      });
    }

    const id = str(body, 'id', 64, true)!;
    if (target === 'fact') {
      const f = this.db.prepare('SELECT * FROM facts WHERE id = ?').get(id) as unknown as FactRow | undefined;
      if (!f) throw notFound('No fact with this id');
      return transaction(this.db, () => {
        // The fact and every version it replaced (they say the same wrong thing in older words).
        const ids = [f.id];
        for (let at = f.id; ; ) {
          const older = this.db.prepare('SELECT id FROM facts WHERE superseded_by = ?').get(at) as { id: string } | undefined;
          if (!older) break;
          ids.push(older.id);
          at = older.id;
        }
        for (const x of ids) {
          this.dropItems('fact', x);
          this.db.prepare('UPDATE facts SET superseded_by = NULL WHERE superseded_by = ?').run(x);
          this.db.prepare('DELETE FROM facts WHERE id = ?').run(x);
          scrub.run(x);
        }
        tombstone('fact', ids);
        return { purged: 'fact', versions: ids.length };
      });
    }

    if (target === 'activity') {
      if (!this.db.prepare('SELECT 1 FROM activities WHERE id = ?').get(id)) throw notFound('No activity with this id');
      return transaction(this.db, () => {
        this.dropItems('activity', id);
        this.db.prepare('DELETE FROM activity_pages WHERE activity_id = ?').run(id);
        this.db.prepare('DELETE FROM activities WHERE id = ?').run(id);
        scrub.run(id);
        tombstone('activity', [id]);
        return { purged: 'activity' };
      });
    }

    const r = this.db.prepare('SELECT id, blob FROM raw_items WHERE id = ?').get(id) as { id: string; blob: string | null } | undefined;
    if (!r) throw notFound('No raw item with this id');
    const result = transaction(this.db, () => {
      this.db.prepare('UPDATE facts SET source_raw_id = NULL WHERE source_raw_id = ?').run(id);
      this.db.prepare('UPDATE activities SET source_raw_id = NULL WHERE source_raw_id = ?').run(id);
      this.dropItems('raw', id);
      this.db.prepare('INSERT INTO purge_allow (id) VALUES (?)').run(id);
      this.db.prepare('DELETE FROM raw_items WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM purge_allow WHERE id = ?').run(id);
      scrub.run(id);
      tombstone('raw', [id]);
      return { purged: 'raw', fileDeleted: false };
    });
    if (r.blob && !this.db.prepare('SELECT 1 FROM raw_items WHERE blob = ?').get(r.blob)) {
      const file = join(this.blobDir, r.blob);
      if (existsSync(file)) {
        unlinkSync(file);
        result.fileDeleted = true;
      }
    }
    return result;
  }

  // ---- layer 2: pages, facts, links ----

  /** Finds a page by slug, title or alias (case-insensitive). */
  findPage(ref: string): PageRow | undefined {
    const key = ref.trim();
    if (!key) return undefined;
    const bySlug = this.db.prepare('SELECT * FROM pages WHERE slug = ?').get(key.toLowerCase()) as unknown as PageRow | undefined;
    if (bySlug) return bySlug;
    const byTitle = this.db.prepare('SELECT * FROM pages WHERE lower(title) = lower(?)').get(key) as unknown as PageRow | undefined;
    if (byTitle) return byTitle;
    const bySlugified = this.db.prepare('SELECT * FROM pages WHERE slug = ?').get(slugify(key)) as unknown as PageRow | undefined;
    if (bySlugified) return bySlugified;
    const lower = key.toLowerCase();
    const all = this.db.prepare("SELECT * FROM pages WHERE aliases != '[]'").all() as unknown as PageRow[];
    return all.find((p) => (JSON.parse(p.aliases) as string[]).some((a) => a.toLowerCase() === lower));
  }

  private page(ref: string): PageRow {
    const p = this.findPage(ref);
    if (!p) {
      const similar = this.db
        .prepare('SELECT title FROM pages WHERE title LIKE ? OR slug LIKE ? LIMIT 5')
        .all(`%${ref.slice(0, 40)}%`, `%${slugify(ref).slice(0, 40)}%`) as Array<{ title: string }>;
      throw notFound(`No page "${ref}" (create it with page_save first)`, similar.length ? { similar: similar.map((s) => s.title) } : {});
    }
    return p;
  }

  /** Creates a page (title + type) or updates the given fields of an existing one. */
  savePage(body: Record<string, unknown>, actor: Actor) {
    only(body, ['page', 'title', 'type', 'summary', 'aliases', 'archived']);
    const ref = str(body, 'page', 200);
    const title = str(body, 'title', 120);
    const summary = str(body, 'summary', 4000);
    const aliases = body.aliases === undefined ? undefined : strList(body.aliases, 'aliases', 20, 80);
    const archived = body.archived === undefined ? undefined : body.archived === true;
    if (body.archived !== undefined && typeof body.archived !== 'boolean') throw bad('archived must be true or false');
    const type = body.type === undefined ? undefined : oneOf(body.type, 'type', PAGE_TYPES);
    if (type === 'me') throw bad('type me is reserved for the owner page (slug "me")');
    const existing = this.findPage(ref ?? title ?? '');
    const ts = this.iso();
    return transaction(this.db, () => {
      if (!existing) {
        if (!title || !type) throw bad('A new page needs title and type');
        let slug = slugify(title);
        for (let n = 2; this.db.prepare('SELECT 1 FROM pages WHERE slug = ?').get(slug); n++) slug = `${slugify(title).slice(0, 75)}-${n}`;
        const id = randomUUID();
        this.db
          .prepare('INSERT INTO pages (id, slug, title, type, summary, aliases, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)')
          .run(id, slug, title, type, summary ?? '', JSON.stringify(aliases ?? []), ts, ts);
        this.indexPage(id);
        this.log(actor, 'create', 'page', id, { slug, title, type, summary, aliases });
        return { created: true, page: this.pageView(id) };
      }
      if (existing.slug === 'me' && (type !== undefined || archived)) throw bad('The owner page cannot change type or be archived');
      const after = {
        title: title ?? existing.title,
        type: type ?? existing.type,
        summary: summary ?? existing.summary,
        aliases: aliases ? JSON.stringify(aliases) : existing.aliases,
        archived: archived === undefined ? existing.archived : archived ? 1 : 0,
      };
      this.db
        .prepare('UPDATE pages SET title = ?, type = ?, summary = ?, aliases = ?, archived = ?, updated_at = ? WHERE id = ?')
        .run(after.title, after.type, after.summary, after.aliases, after.archived, ts, existing.id);
      this.indexPage(existing.id);
      this.log(actor, 'update', 'page', existing.id, {
        before: { title: existing.title, type: existing.type, summary: existing.summary, aliases: existing.aliases, archived: existing.archived },
        after,
      });
      return { created: false, page: this.pageView(existing.id) };
    });
  }

  private pageView(id: string) {
    const p = this.db.prepare('SELECT * FROM pages WHERE id = ?').get(id) as unknown as PageRow;
    return { slug: p.slug, title: p.title, type: p.type, summary: p.summary, aliases: JSON.parse(p.aliases) as string[], archived: !!p.archived, updatedAt: p.updated_at };
  }

  /** A page with its active facts, links both ways and recent activities. */
  getPage(ref: string) {
    const p = this.page(ref);
    const facts = this.db
      .prepare("SELECT id, text, observed_on, source_raw_id, source_note, created_at FROM facts WHERE page_id = ? AND status = 'active' ORDER BY coalesce(observed_on, substr(created_at, 1, 10)), created_at")
      .all(p.id) as Array<{ id: string; text: string; observed_on: string | null; source_raw_id: string | null; source_note: string | null; created_at: string }>;
    const out = this.db
      .prepare('SELECT l.relation, l.note, p.slug, p.title, p.type FROM links l JOIN pages p ON p.id = l.to_page WHERE l.from_page = ? AND p.archived = 0')
      .all(p.id) as Array<{ relation: string; note: string | null; slug: string; title: string; type: string }>;
    const incoming = this.db
      .prepare('SELECT l.relation, l.note, p.slug, p.title, p.type FROM links l JOIN pages p ON p.id = l.from_page WHERE l.to_page = ? AND p.archived = 0')
      .all(p.id) as Array<{ relation: string; note: string | null; slug: string; title: string; type: string }>;
    const activities = this.db
      .prepare(
        "SELECT a.* FROM activities a JOIN activity_pages ap ON ap.activity_id = a.id WHERE ap.page_id = ? AND a.status = 'active' ORDER BY a.started_at DESC LIMIT 10",
      )
      .all(p.id) as unknown as ActivityRow[];
    const activityCount = (this.db.prepare("SELECT count(*) AS n FROM activity_pages ap JOIN activities a ON a.id = ap.activity_id WHERE ap.page_id = ? AND a.status = 'active'").get(p.id) as { n: number }).n;
    return {
      page: this.pageView(p.id),
      facts: facts.map((f) => ({ id: f.id, text: f.text, observedOn: f.observed_on, source: f.source_raw_id ? { rawId: f.source_raw_id } : f.source_note ?? null })),
      links: out.map((l) => ({ relation: l.relation, to: { slug: l.slug, title: l.title, type: l.type }, note: l.note })),
      linkedFrom: incoming.map((l) => ({ relation: l.relation, from: { slug: l.slug, title: l.title, type: l.type }, note: l.note })),
      recentActivities: activities.map((a) => this.activityView(a)),
      activityCount,
    };
  }

  listPages(query: URLSearchParams) {
    const type = query.get('type');
    if (type) oneOf(type, 'type', PAGE_TYPES);
    const rows = this.db
      .prepare(
        `SELECT p.slug, p.title, p.type, p.summary, (SELECT count(*) FROM facts f WHERE f.page_id = p.id AND f.status = 'active') AS facts
         FROM pages p WHERE p.archived = 0 ${type ? 'AND p.type = ?' : ''} ORDER BY p.type, p.title`,
      )
      .all(...(type ? [type] : [])) as Array<{ slug: string; title: string; type: string; summary: string; facts: number }>;
    return rows.map((r) => ({ slug: r.slug, title: r.title, type: r.type, summary: clip(r.summary, 140), facts: r.facts }));
  }

  private rawRef(value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !this.db.prepare('SELECT 1 FROM raw_items WHERE id = ?').get(value)) throw bad('sourceRawId must be the id of a stored raw item');
    return value;
  }

  addFact(body: Record<string, unknown>, actor: Actor) {
    only(body, ['page', 'text', 'observedOn', 'sourceRawId', 'sourceNote']);
    const p = this.page(str(body, 'page', 200, true)!);
    const text = str(body, 'text', 1000, true)!;
    const observedOn = dateStr(body.observedOn, 'observedOn') ?? this.localDate();
    const sourceRawId = this.rawRef(body.sourceRawId);
    const sourceNote = str(body, 'sourceNote', 200) ?? (actor === 'hermes' ? 'owner said in chat' : null);
    const same = this.db.prepare("SELECT id FROM facts WHERE page_id = ? AND status = 'active' AND lower(text) = lower(?)").get(p.id, text) as { id: string } | undefined;
    if (same) return { id: same.id, duplicate: true, page: p.title };
    const id = randomUUID();
    const ts = this.iso();
    transaction(this.db, () => {
      this.db
        .prepare('INSERT INTO facts (id, page_id, text, observed_on, source_raw_id, source_note, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, p.id, text, observedOn, sourceRawId, sourceNote, 'active', actor, ts, ts);
      this.db.prepare('UPDATE pages SET updated_at = ? WHERE id = ?').run(ts, p.id);
      this.indexFact(id);
      this.log(actor, 'add', 'fact', id, { page: p.slug, text, observedOn, sourceRawId, sourceNote });
    });
    return { id, duplicate: false, page: p.title };
  }

  /** Replaces a fact (the old one stays as superseded, so the history is kept) or removes it. */
  changeFact(id: string, body: Record<string, unknown>, actor: Actor) {
    only(body, ['text', 'observedOn', 'remove', 'reason']);
    const f = this.db.prepare('SELECT * FROM facts WHERE id = ?').get(id) as unknown as FactRow | undefined;
    if (!f || f.status !== 'active') throw notFound('No active fact with this id');
    const reason = str(body, 'reason', 300);
    const ts = this.iso();
    if (body.remove === true) {
      transaction(this.db, () => {
        this.db.prepare("UPDATE facts SET status = 'removed', updated_at = ? WHERE id = ?").run(ts, id);
        this.indexFact(id);
        this.log(actor, 'remove', 'fact', id, { text: f.text, reason });
      });
      return { removed: true };
    }
    const text = str(body, 'text', 1000, true)!;
    const observedOn = dateStr(body.observedOn, 'observedOn') ?? this.localDate();
    const newId = randomUUID();
    transaction(this.db, () => {
      this.db
        .prepare('INSERT INTO facts (id, page_id, text, observed_on, source_raw_id, source_note, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(newId, f.page_id, text, observedOn, null, reason ?? (actor === 'hermes' ? 'owner said in chat' : null), 'active', actor, ts, ts);
      this.db.prepare("UPDATE facts SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?").run(newId, ts, id);
      this.indexFact(id);
      this.indexFact(newId);
      this.log(actor, 'supersede', 'fact', id, { before: f.text, after: text, newId, reason });
    });
    return { id: newId, replaced: id };
  }

  link(body: Record<string, unknown>, actor: Actor) {
    only(body, ['from', 'to', 'relation', 'note', 'remove']);
    const from = this.page(str(body, 'from', 200, true)!);
    const to = this.page(str(body, 'to', 200, true)!);
    if (from.id === to.id) throw bad('A page cannot link to itself');
    const relation = str(body, 'relation', 30) ?? 'related';
    if (!RELATION.test(relation)) throw bad('relation must be 2-30 characters of a-z and _ (e.g. related, part_of, prerequisite, goal_of, uses)');
    const note = str(body, 'note', 300);
    if (body.remove === true) {
      const result = this.db.prepare('DELETE FROM links WHERE from_page = ? AND to_page = ? AND relation = ?').run(from.id, to.id, relation);
      if (result.changes) this.log(actor, 'unlink', 'link', null, { from: from.slug, to: to.slug, relation });
      return { removed: result.changes > 0 };
    }
    const result = this.db
      .prepare('INSERT OR IGNORE INTO links (from_page, to_page, relation, note, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(from.id, to.id, relation, note ?? null, this.iso());
    if (result.changes) this.log(actor, 'link', 'link', null, { from: from.slug, to: to.slug, relation, note });
    return { linked: true, duplicate: result.changes === 0, from: from.title, to: to.title, relation };
  }

  // ---- layer 1: activities ----

  private activityPages(id: string) {
    return this.db.prepare('SELECT p.id, p.slug, p.title FROM activity_pages ap JOIN pages p ON p.id = ap.page_id WHERE ap.activity_id = ? ORDER BY p.title').all(id) as Array<{
      id: string;
      slug: string;
      title: string;
    }>;
  }

  private activityView(a: ActivityRow) {
    return {
      id: a.id,
      at: a.started_at,
      minutes: a.minutes,
      kind: a.kind,
      title: a.title,
      detail: a.detail,
      outcome: a.outcome,
      feeling: a.feeling,
      pages: this.activityPages(a.id).map((p) => p.title),
    };
  }

  addActivity(body: Record<string, unknown>, actor: Actor) {
    only(body, ['at', 'minutes', 'kind', 'title', 'detail', 'outcome', 'feeling', 'pages', 'sourceRawId']);
    const at = str(body, 'at', 16) ?? this.localDate();
    if (!LOCAL_TIME.test(at)) throw bad('at must be YYYY-MM-DD or YYYY-MM-DDTHH:MM (local time)');
    const minutes = intIn(body.minutes, 'minutes', 1, 24 * 60);
    const kind = oneOf(body.kind ?? 'other', 'kind', ACTIVITY_KINDS);
    const title = str(body, 'title', 200, true)!;
    const detail = str(body, 'detail', 2000);
    const outcome = str(body, 'outcome', 1000);
    const feeling = str(body, 'feeling', 300);
    const pageRefs = strList(body.pages, 'pages', 10, 200);
    const pages = pageRefs.map((r) => this.page(r));
    const sourceRawId = this.rawRef(body.sourceRawId);
    const id = randomUUID();
    const ts = this.iso();
    transaction(this.db, () => {
      this.db
        .prepare(
          'INSERT INTO activities (id, started_at, minutes, kind, title, detail, outcome, feeling, source_raw_id, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, at, minutes ?? null, kind, title, detail ?? null, outcome ?? null, feeling ?? null, sourceRawId, 'active', actor, ts, ts);
      for (const p of pages) this.db.prepare('INSERT OR IGNORE INTO activity_pages (activity_id, page_id) VALUES (?, ?)').run(id, p.id);
      this.indexActivity(id);
      this.log(actor, 'add', 'activity', id, { at, minutes, kind, title, detail, outcome, feeling, pages: pages.map((p) => p.slug) });
    });
    return { activity: this.activityView(this.db.prepare('SELECT * FROM activities WHERE id = ?').get(id) as unknown as ActivityRow) };
  }

  changeActivity(id: string, body: Record<string, unknown>, actor: Actor) {
    only(body, ['at', 'minutes', 'kind', 'title', 'detail', 'outcome', 'feeling', 'pages', 'remove']);
    const a = this.db.prepare('SELECT * FROM activities WHERE id = ?').get(id) as unknown as ActivityRow | undefined;
    if (!a || a.status !== 'active') throw notFound('No activity with this id');
    const ts = this.iso();
    if (body.remove === true) {
      transaction(this.db, () => {
        this.db.prepare("UPDATE activities SET status = 'removed', updated_at = ? WHERE id = ?").run(ts, id);
        this.indexActivity(id);
        this.log(actor, 'remove', 'activity', id, { title: a.title, at: a.started_at });
      });
      return { removed: true };
    }
    const at = str(body, 'at', 16) ?? a.started_at;
    if (!LOCAL_TIME.test(at)) throw bad('at must be YYYY-MM-DD or YYYY-MM-DDTHH:MM (local time)');
    const after = {
      started_at: at,
      minutes: body.minutes === undefined ? a.minutes : (intIn(body.minutes, 'minutes', 1, 24 * 60) ?? null),
      kind: body.kind === undefined ? a.kind : oneOf(body.kind, 'kind', ACTIVITY_KINDS),
      title: str(body, 'title', 200) ?? a.title,
      detail: body.detail === undefined ? a.detail : (str(body, 'detail', 2000) ?? null),
      outcome: body.outcome === undefined ? a.outcome : (str(body, 'outcome', 1000) ?? null),
      feeling: body.feeling === undefined ? a.feeling : (str(body, 'feeling', 300) ?? null),
    };
    const pages = body.pages === undefined ? null : strList(body.pages, 'pages', 10, 200).map((r) => this.page(r));
    transaction(this.db, () => {
      this.db
        .prepare('UPDATE activities SET started_at = ?, minutes = ?, kind = ?, title = ?, detail = ?, outcome = ?, feeling = ?, updated_at = ? WHERE id = ?')
        .run(after.started_at, after.minutes, after.kind, after.title, after.detail, after.outcome, after.feeling, ts, id);
      if (pages) {
        this.db.prepare('DELETE FROM activity_pages WHERE activity_id = ?').run(id);
        for (const p of pages) this.db.prepare('INSERT OR IGNORE INTO activity_pages (activity_id, page_id) VALUES (?, ?)').run(id, p.id);
      }
      this.indexActivity(id);
      this.log(actor, 'update', 'activity', id, { before: { ...a }, after: { ...after, pages: pages?.map((p) => p.slug) } });
    });
    return { activity: this.activityView(this.db.prepare('SELECT * FROM activities WHERE id = ?').get(id) as unknown as ActivityRow) };
  }

  timeline(query: URLSearchParams) {
    const from = dateStr(query.get('from') ?? undefined, 'from');
    const to = dateStr(query.get('to') ?? undefined, 'to');
    const kind = query.get('kind');
    if (kind) oneOf(kind, 'kind', ACTIVITY_KINDS);
    const pageRef = query.get('page');
    const page = pageRef ? this.page(pageRef) : null;
    const limit = Math.min(Number(query.get('limit') ?? 30) || 30, 100);
    const where = ["a.status = 'active'"];
    const args: string[] = [];
    if (from) {
      where.push('substr(a.started_at, 1, 10) >= ?');
      args.push(from);
    }
    if (to) {
      where.push('substr(a.started_at, 1, 10) <= ?');
      args.push(to);
    }
    if (kind) {
      where.push('a.kind = ?');
      args.push(kind);
    }
    if (page) {
      where.push('EXISTS (SELECT 1 FROM activity_pages ap WHERE ap.activity_id = a.id AND ap.page_id = ?)');
      args.push(page.id);
    }
    const rows = this.db.prepare(`SELECT a.* FROM activities a WHERE ${where.join(' AND ')} ORDER BY a.started_at DESC LIMIT ${limit}`).all(...args) as unknown as ActivityRow[];
    const totalMinutes = rows.reduce((s, a) => s + (a.minutes ?? 0), 0);
    return { activities: rows.map((a) => this.activityView(a)), totalMinutes };
  }

  // ---- layer 3: profile and index ----

  profile(compact = false) {
    const me = this.getPage('me');
    const index = this.db
      .prepare("SELECT type, title FROM pages WHERE archived = 0 AND slug != 'me' ORDER BY type, updated_at DESC")
      .all() as Array<{ type: string; title: string }>;
    const byType: Record<string, string[]> = {};
    for (const r of index) (byType[r.type] ??= []).push(r.title);
    const since = new Date(this.now().getTime() - 7 * 86_400_000);
    const week = this.timeline(new URLSearchParams({ from: this.localDate(since), limit: '100' }));
    if (!compact) return { me, index: byType, lastSevenDays: { activities: week.activities.length, minutes: week.totalMinutes } };
    // Compact text for Hermes's system prompt: short and stable.
    const lines: string[] = [];
    if (me.page.summary) lines.push(clip(me.page.summary, 500));
    for (const f of me.facts.slice(-12)) lines.push(`- ${clip(f.text, 140)}`);
    const pageList = Object.entries(byType)
      .map(([t, titles]) => `${t}: ${titles.slice(0, 12).join(', ')}${titles.length > 12 ? ` (+${titles.length - 12})` : ''}`)
      .join(' | ');
    return { text: lines.join('\n'), pages: clip(pageList, 600), pageCount: index.length };
  }

  graph() {
    const nodes = this.db
      .prepare(
        `SELECT p.id, p.slug, p.title, p.type,
           (SELECT count(*) FROM facts f WHERE f.page_id = p.id AND f.status = 'active') AS facts,
           (SELECT count(*) FROM activity_pages ap JOIN activities a ON a.id = ap.activity_id WHERE ap.page_id = p.id AND a.status = 'active') AS activities
         FROM pages p WHERE p.archived = 0`,
      )
      .all() as Array<{ id: string; slug: string; title: string; type: string; facts: number; activities: number }>;
    const edges = this.db
      .prepare('SELECT f.slug AS source, t.slug AS target, l.relation FROM links l JOIN pages f ON f.id = l.from_page JOIN pages t ON t.id = l.to_page WHERE f.archived = 0 AND t.archived = 0')
      .all() as Array<{ source: string; target: string; relation: string }>;
    // Pages that appear in the same activities are related through what the owner did.
    const together = this.db
      .prepare(
        `SELECT pa.slug AS source, pb.slug AS target, count(*) AS weight FROM activity_pages a1
         JOIN activity_pages a2 ON a2.activity_id = a1.activity_id AND a2.page_id > a1.page_id
         JOIN activities act ON act.id = a1.activity_id AND act.status = 'active'
         JOIN pages pa ON pa.id = a1.page_id JOIN pages pb ON pb.id = a2.page_id
         GROUP BY a1.page_id, a2.page_id`,
      )
      .all() as Array<{ source: string; target: string; weight: number }>;
    return {
      nodes: nodes.map((n) => ({ id: n.slug, title: n.title, type: n.type, facts: n.facts, activities: n.activities })),
      edges: [...edges.map((e) => ({ ...e, weight: 1 })), ...together.map((e) => ({ ...e, relation: 'done_together' }))],
    };
  }

  changes(limit: number) {
    const rows = this.db.prepare('SELECT * FROM change_log ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 200)) as Array<{
      id: number;
      ts: string;
      actor: string;
      action: string;
      entity: string;
      entity_id: string | null;
      detail: string;
    }>;
    return rows.map((r) => ({ id: r.id, at: r.ts, actor: r.actor, action: r.action, entity: r.entity, entityId: r.entity_id, detail: JSON.parse(r.detail) }));
  }

  stats() {
    const count = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      raw: count('SELECT count(*) AS n FROM raw_items'),
      pages: count('SELECT count(*) AS n FROM pages WHERE archived = 0'),
      facts: count("SELECT count(*) AS n FROM facts WHERE status = 'active'"),
      activities: count("SELECT count(*) AS n FROM activities WHERE status = 'active'"),
      searchItems: count('SELECT count(*) AS n FROM search_items'),
      embedded: count('SELECT count(*) AS n FROM search_items WHERE embed_model IS NOT NULL'),
      storedFiles: count('SELECT count(*) AS n FROM raw_items WHERE blob IS NOT NULL'),
      semantic: this.embedder ? this.embedder.model : null,
    };
  }

  // ---- search ----

  /** Embeds up to `batch` items that have no vector yet. Returns how many were embedded. */
  async embedPending(batch = 32): Promise<number> {
    if (!this.embedder) return 0;
    const retryBefore = new Date(this.now().getTime() - 10 * 60_000).toISOString();
    const rows = this.db
      .prepare('SELECT rowid, text FROM search_items WHERE embed_model IS NULL AND (embed_failed_at IS NULL OR embed_failed_at < ?) ORDER BY rowid LIMIT ?')
      .all(retryBefore, batch) as Array<{ rowid: number; text: string }>;
    if (!rows.length) return 0;
    let vectors: Float32Array[];
    try {
      vectors = await this.embedder.embed(rows.map((r) => r.text));
    } catch (error) {
      if (error instanceof EmbedError && !error.unreachable) {
        const mark = this.db.prepare('UPDATE search_items SET embed_failed_at = ? WHERE rowid = ?');
        for (const r of rows) mark.run(this.iso(), r.rowid);
      }
      throw error;
    }
    if (vectors.some((v) => v.length !== EMBED_DIMENSIONS)) throw new EmbedError(`The embedding model must return ${EMBED_DIMENSIONS} dimensions`, false);
    const mark = this.db.prepare('UPDATE search_items SET embed_model = ?, embed_failed_at = NULL WHERE rowid = ? AND text = ?');
    const drop = this.db.prepare('DELETE FROM vec_items WHERE rowid = ?');
    const store = this.db.prepare("INSERT INTO vec_items(rowid, embedding) VALUES (?, vec_quantize_int8(vec_f32(?), 'unit'))");
    transaction(this.db, () => {
      rows.forEach((r, i) => {
        // Only if the text is still the one that was embedded (it may have changed meanwhile).
        if (!mark.run(this.embedder!.model, r.rowid, r.text).changes) return;
        drop.run(BigInt(r.rowid));
        store.run(BigInt(r.rowid), new Uint8Array(vectors[i].buffer, vectors[i].byteOffset, vectors[i].byteLength));
      });
    });
    return rows.length;
  }

  /** Keyword (FTS5, word prefixes) + meaning (embeddings) search, merged by rank. */
  async search(q: string, options: { kinds?: SearchKind[]; limit?: number; semanticTimeoutMs?: number } = {}): Promise<SearchHit[]> {
    const query = q.trim().slice(0, 300);
    if (!query) throw bad('q is required');
    const kinds = new Set(options.kinds?.length ? options.kinds : SEARCH_KINDS);
    const limit = Math.min(Math.max(options.limit ?? 8, 1), 30);
    const ranks = new Map<number, { score: number; keyword: boolean; similarity?: number }>();
    const add = (rowid: number, rank: number, keyword: boolean, similarity?: number) => {
      const r = ranks.get(rowid) ?? { score: 0, keyword: false };
      r.score += 1 / (60 + rank);
      if (keyword) r.keyword = true;
      if (similarity !== undefined) r.similarity = similarity;
      ranks.set(rowid, r);
    };

    const fts = ftsQuery(query);
    if (fts) {
      const rows = this.db
        .prepare('SELECT s.rowid, s.kind FROM search_fts JOIN search_items s ON s.rowid = search_fts.rowid WHERE search_fts MATCH ? ORDER BY bm25(search_fts) LIMIT 200')
        .all(fts) as Array<{ rowid: number; kind: SearchKind }>;
      rows.filter((r) => kinds.has(r.kind)).slice(0, 50).forEach((r, i) => add(r.rowid, i, true));
    }

    if (this.embedder) {
      try {
        const [qv] = await Promise.race([
          this.embedder.embed([query]),
          new Promise<never>((_, reject) => setTimeout(() => reject(new EmbedError('timeout', true)), options.semanticTimeoutMs ?? 5000)),
        ]);
        if (qv.length !== EMBED_DIMENSIONS) throw new EmbedError('wrong dimensions', false);
        const nearest = this.db
          .prepare("SELECT rowid, distance FROM vec_items WHERE embedding MATCH vec_quantize_int8(vec_f32(?), 'unit') AND k = 300 ORDER BY distance")
          .all(new Uint8Array(qv.buffer, qv.byteOffset, qv.byteLength)) as Array<{ rowid: number; distance: number }>;
        const scored = nearest.map((n) => ({ rowid: Number(n.rowid), sim: 1 - n.distance })).filter((s) => s.sim >= SEMANTIC_MIN_SIMILARITY);
        const kindOf = this.db.prepare('SELECT kind FROM search_items WHERE rowid = ?');
        let rank = 0;
        for (const s of scored) {
          if (rank >= 50) break;
          const k = (kindOf.get(s.rowid) as { kind: SearchKind } | undefined)?.kind;
          if (!k || !kinds.has(k)) continue;
          add(s.rowid, rank++, false, s.sim);
        }
      } catch {
        /* semantic search is a bonus: keyword results still answer */
      }
    }

    const ordered = [...ranks.entries()].sort((a, b) => b[1].score - a[1].score);
    const hits: SearchHit[] = [];
    const seenRaw = new Set<string>();
    const getItem = this.db.prepare('SELECT rowid, kind, ref_id, part, page_id, date, text FROM search_items WHERE rowid = ?');
    for (const [rowid, r] of ordered) {
      if (hits.length >= limit) break;
      const item = getItem.get(rowid) as unknown as ItemRow | undefined;
      if (!item) continue;
      if (item.kind === 'raw') {
        if (seenRaw.has(item.ref_id)) continue;
        seenRaw.add(item.ref_id);
      }
      hits.push(this.hit(item, query, r.keyword ? (r.similarity !== undefined ? 'both' : 'keyword') : 'meaning', r.similarity));
    }
    return hits;
  }

  private hit(item: ItemRow, q: string, match: SearchHit['match'], similarity?: number): SearchHit {
    const page = item.page_id
      ? (this.db.prepare('SELECT slug, title, type FROM pages WHERE id = ?').get(item.page_id) as { slug: string; title: string; type: string } | undefined)
      : undefined;
    let title = page?.title ?? '';
    if (item.kind === 'raw') {
      const raw = this.db.prepare('SELECT source, kind, title FROM raw_items WHERE id = ?').get(item.ref_id) as { source: string; kind: string; title: string | null };
      title = raw.title ?? `${raw.source}/${raw.kind}`;
    } else if (item.kind === 'activity') {
      title = (this.db.prepare('SELECT title FROM activities WHERE id = ?').get(item.ref_id) as { title: string }).title;
    }
    return {
      kind: item.kind,
      id: item.ref_id,
      ...(item.kind === 'raw' ? { part: item.part } : {}),
      title,
      snippet: snippet(item.text, q),
      ...(page ? { page } : {}),
      ...(item.date ? { date: item.date } : {}),
      match,
      ...(similarity !== undefined ? { similarity: Math.round(similarity * 100) / 100 } : {}),
    };
  }

  /**
   * Automatic recall for Hermes: a few short lines about pages, facts and activities that clearly
   * match the owner's message (keyword hit, or meaning similarity >= 0.5). Empty when nothing fits.
   */
  async recall(q: string): Promise<{ text: string; count: number }> {
    const hits = await this.search(q, { kinds: ['page', 'fact', 'activity'], limit: 8, semanticTimeoutMs: 2500 });
    const lines: string[] = [];
    let size = 0;
    for (const h of hits) {
      if (h.match === 'meaning' && (h.similarity ?? 0) < RECALL_MIN_SIMILARITY) continue;
      if (h.page?.slug === 'me' && h.kind === 'page') continue;
      const line =
        h.kind === 'fact'
          ? `- ${h.page?.title}: ${clip(h.snippet.replace(new RegExp(`^${escapeRegex(h.page?.title ?? '')}: `), ''), 200)}`
          : h.kind === 'page'
            ? `- [${h.page?.type}] ${clip(h.snippet, 200)}`
            : `- ${h.date ?? ''} ${clip(h.snippet, 200)}`;
      if (size + line.length > 1000) break;
      lines.push(line);
      size += line.length + 1;
      if (lines.length >= 6) break;
    }
    return { text: lines.join('\n'), count: lines.length };
  }
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
