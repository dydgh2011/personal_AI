import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { copyFile, rm } from 'node:fs/promises';
import { basename, extname, join, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { EMBED_DIMENSIONS, transaction } from './db.js';
import { EmbedError, type Embedder } from './embed.js';
import { chunk, clip, ftsQuery, slugify, snippet } from './text.js';
import { IMAGE_EXTENSIONS, MAX_MEDIA_BYTES, SOUND_EXTENSIONS, mediaKind, type MediaJob, type MediaResult } from './media.js';
import { closedDay, isDay, lastClosedWeek, normalizedActivity, reportedEntries, shiftDay, utcDayStart, type ReviewPeriod } from './review.js';

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
const conflict = (message: string, extra: Record<string, unknown> = {}) => new KnowledgeError(409, 'conflict', message, extra);

export type Actor = 'hermes' | 'system' | 'operator' | 'dashboard';

export const PREFERENCES_SLUG = 'preferences';
export const PAGE_TYPES = ['me', 'course', 'topic', 'goal', 'project', 'person', 'habit', 'place', 'org', 'other'] as const;
export const ACTIVITY_KINDS = [
  'study', 'class', 'assignment', 'exam', 'project', 'coding', 'reading', 'experiment', 'exercise',
  'chore', 'errand', 'social', 'work', 'rest', 'health', 'other',
] as const;
/**
 * What a fact records, so code picks facts by kind instead of matching words. Optional: null = untyped
 * (facts stored before kinds existed, or when nothing fits); readers fall back to their old rules for those.
 *   score       a test/quiz/assignment result (47/50 (94%), Term Test 2 11.5/25)
 *   mistake     a lost point, mistake or weak point (Test 1 5(c) 근거가 틀려 0점)
 *   exam        an exam's date, time or place (기말 2026-12-16 09:00–12:00, RA Gym)
 *   deadline    a due date (A2 마감 2026-11-28)
 *   grading     grading rules and weights (배점, 비중, 늦으면 10% 감점)
 *   resource    where to study or practise (textbook, notes, exercise lists)
 *   habit       a routine the owner keeps
 *   preference  how the owner wants things done (likes, feedback)
 *   other       anything else
 */
export const FACT_KINDS = ['score', 'mistake', 'exam', 'deadline', 'grading', 'resource', 'habit', 'preference', 'other'] as const;
export type FactKind = (typeof FACT_KINDS)[number];
const RAW_SOURCES = ['chat', 'note', 'import', 'system', 'school'] as const;
const SEARCH_KINDS = ['page', 'fact', 'activity', 'raw'] as const;
type SearchKind = (typeof SEARCH_KINDS)[number];

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
const RELATION = /^[a-z][a-z_]{1,29}$/;
const KIND = /^[a-z0-9][a-z0-9._-]{1,40}$/;
const EXTERNAL_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const MAX_RAW_CHARS = 5_000_000;
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const RAW_READ_CHARS = 8000;
const DOC_PREFIX = /^doc_[0-9a-f]{6,32}_/;
const REVIEW_KINDS = ['daily-review', 'weekly-review'] as const;
type ReviewKind = (typeof REVIEW_KINDS)[number];
const ATTACHMENT_CACHES = ['documents', 'images', 'audio'] as const;
type AttachmentCache = (typeof ATTACHMENT_CACHES)[number];
/** Semantic match needed for automatic recall (bge-m3 cosine; unrelated text is usually below 0.45). */
const RECALL_MIN_SIMILARITY = 0.5;
const SEMANTIC_MIN_SIMILARITY = 0.35;
/** Graph view bounds (pages, facts, done-together edges) and the fact excerpt length. */
const GRAPH_PAGES = 500;
const GRAPH_MAX_PAGES = 2000;
const GRAPH_FACTS = 2000;
const GRAPH_MAX_FACTS = 5000;
const GRAPH_MAX_TOGETHER = 2000;
const GRAPH_EXCERPT = 200;

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
  kind: FactKind | null;
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
interface MediaRow {
  status: 'complete' | 'empty' | 'failed';
  method: MediaJob['method'];
  text: string;
  code: string | null;
  attempts: number;
  retry_at: string | null;
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
  mediaDirs?: Partial<Record<'images' | 'audio', string>>;
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

/** A fact kind: undefined = not given, null = untyped (clears it on a change). */
function factKind(value: unknown): FactKind | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return oneOf(value, 'kind', FACT_KINDS);
}

function oneOf<T extends string>(value: unknown, key: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw bad(`${key} must be one of ${allowed.join(', ')}`);
  return value as T;
}

function dateStr(value: unknown, key: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !isDay(value)) throw bad(`${key} must be a date YYYY-MM-DD`);
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
  private readonly attachmentDirs: Partial<Record<AttachmentCache, string | null>>;
  readonly embedder: Embedder | null;
  private readonly now: () => Date;
  private transcriptionReady: boolean | undefined;

  constructor(db: DatabaseSync, options: KnowledgeOptions) {
    this.db = db;
    this.timeZone = options.timeZone;
    this.blobDir = options.blobDir;
    this.attachmentDirs = { documents: options.documentsDir, ...options.mediaDirs };
    this.embedder = options.embedder;
    this.now = options.now ?? (() => new Date());
    mkdirSync(this.blobDir, { recursive: true });
    this.ensureMe();
    this.ensurePreferences();
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

  /**
   * The owner's preferences and feedback ("요약은 마감일 먼저", "광고 메일은 무시"): one page whose
   * active facts all go into every Hermes system prompt (profile compact), so feedback given once is
   * followed everywhere, in every later session.
   */
  private ensurePreferences() {
    if (this.db.prepare(`SELECT 1 FROM pages WHERE slug = '${PREFERENCES_SLUG}'`).get()) return;
    const ts = this.iso();
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO pages (id, slug, title, type, summary, aliases, created_at, updated_at) VALUES (?, ?, ?, 'other', ?, ?, ?, ?)")
      .run(id, PREFERENCES_SLUG, '취향과 피드백', '주인이 시스템에 준 취향과 피드백. 모든 대화와 작업에서 항상 따른다.', JSON.stringify(['preferences', '피드백', '취향', '선호']), ts, ts);
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
    if ((REVIEW_KINDS as readonly string[]).includes(kind) && (actor !== 'system' || source !== 'system')) {
      throw bad('Review records are created by the nightly job');
    }
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
  private findDocument(file: string, cache: AttachmentCache): string {
    const directory = this.attachmentDirs[cache];
    if (!directory) throw new KnowledgeError(503, 'not_configured', 'The attachment folder is not mounted');
    if (!/^[^/\\\0]{1,255}$/.test(file) || file === '.' || file === '..') throw bad('file must be a plain file name');
    const root = realpathSync(directory);
    const folders = [root];
    const native = join(root, 'native-inputs');
    try {
      if (cache === 'documents' && lstatSync(native).isDirectory()) {
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
  async addDocument(body: Record<string, unknown>, actor: Actor) {
    only(body, ['file', 'cache', 'text', 'contentType', 'pageCount', 'meta']);
    const file = str(body, 'file', 255, true)!;
    const cache = oneOf(body.cache ?? 'documents', 'cache', ATTACHMENT_CACHES);
    const method = mediaKind(file);
    if ((cache === 'images' && method !== 'ocr') || (cache === 'audio' && method !== 'transcription')) {
      throw bad('Only supported media may be archived from this cache');
    }
    if (typeof body.text !== 'string') throw bad('text is required (the extracted text; may be empty for images)');
    if (body.text.length > MAX_RAW_CHARS) throw bad(`text is longer than ${MAX_RAW_CHARS} characters`);
    const contentType = str(body, 'contentType', 100);
    const pageCount = intIn(body.pageCount, 'pageCount', 0, 100_000);
    const meta = body.meta ?? {};
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta) || JSON.stringify(meta).length > 8192) throw bad('meta must be a JSON object under 8 KB');
    const path = this.findDocument(file, cache);
    const st = statSync(path);
    const ext = extname(file).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10);
    const maxBytes = method === 'transcription' ? MAX_MEDIA_BYTES : MAX_DOCUMENT_BYTES;
    if (st.size > maxBytes) throw new KnowledgeError(413, 'too_large', 'The attachment exceeds the size limit');
    // Hash the staged bytes, then atomically publish a complete blob. Large recordings stay off the heap.
    const staged = join(this.blobDir, '.' + randomUUID() + '.attachment');
    try {
      await copyFile(path, staged);
      if (statSync(staged).size !== st.size) throw bad('The attachment changed while it was being stored');
      const sha = await sha256File(staged);
      // Publish the final file and DB row without yielding to another attachment request.
      const dup = this.db.prepare('SELECT id FROM raw_items WHERE blob IS NOT NULL AND sha256 = ?').get(sha) as { id: string } | undefined;
      if (dup) return { id: dup.id, duplicate: true };
      const blob = sha + ext;
      const finalPath = join(this.blobDir, blob);
      const alreadyOnDisk = existsSync(finalPath);
      const id = randomUUID();
      const title = displayName(basename(file));
      const occurredAt = new Date(st.mtimeMs).toISOString();
      const text = body.text;
      renameSync(staged, finalPath);
      try {
        transaction(this.db, () => {
          this.db
            .prepare(
              "INSERT INTO raw_items (id, source, kind, title, occurred_at, received_at, external_id, sha256, content_type, size, blob, text, meta) VALUES (?, 'document', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)",
            )
            .run(id, ext.replace('.', '') || 'file', title, occurredAt, this.iso(), sha, contentType ?? null, st.size, blob, text, JSON.stringify({ ...(meta as object), pageCount }));
          if (text.trim()) this.indexRaw({ id, text, title, occurred_at: occurredAt });
          this.log(actor, 'add', 'raw', id, { source: 'document', title, bytes: st.size, chars: text.length });
        });
      } catch (error) {
        if (!alreadyOnDisk) rmSync(finalPath, { force: true });
        throw error;
      }
      return { id, duplicate: false, title };
    } finally {
      await rm(staged, { force: true });
    }
  }

  listRaw(query: URLSearchParams) {
    const where: string[] = [];
    const args: string[] = [];
    const source = query.get('source');
    if (source) {
      oneOf(source, 'source', [...RAW_SOURCES, 'document'] as const);
      where.push('r.source = ?');
      args.push(source);
    }
    const from = dateStr(query.get('from') ?? undefined, 'from');
    const to = dateStr(query.get('to') ?? undefined, 'to');
    if (from) {
      where.push('r.occurred_at >= ?');
      args.push(utcDayStart(from, this.timeZone));
    }
    if (to) {
      where.push('r.occurred_at < ?');
      args.push(utcDayStart(shiftDay(to, 1), this.timeZone));
    }
    const limit = Math.max(1, Math.min(Math.trunc(Number(query.get('limit') ?? 20)) || 20, 100));
    const rows = this.db.prepare(`
      SELECT r.id, r.source, r.kind, r.title, r.occurred_at, r.size, r.blob,
        substr(CASE WHEN m.status IS NULL THEN r.text ELSE m.text END, 1, 200) AS preview,
        CASE WHEN r.blob IS NOT NULL THEN r.meta ELSE '{}' END AS meta, r.text <> '' AS supplied_text,
        m.status, m.method, m.code, m.retry_at
      FROM raw_items r LEFT JOIN media_extractions m ON m.raw_id = r.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY r.occurred_at DESC, r.id DESC LIMIT ?
    `).all(...args, limit) as unknown as Array<RawRow & Pick<MediaRow, 'status' | 'method' | 'code' | 'retry_at'> & { preview: string; supplied_text: number }>;
    return rows.map((r) => ({
      id: r.id, source: r.source, kind: r.kind, title: r.title, date: this.localDate(new Date(r.occurred_at)),
      size: r.size, preview: clip(r.preview, 160), ...this.extractionView(r, r.status ? r : undefined, Boolean(r.supplied_text)),
    }));
  }

  private extractionView(
    raw: Pick<RawRow, 'blob' | 'meta'>,
    result?: Pick<MediaRow, 'status' | 'method' | 'code' | 'retry_at'>,
    suppliedText = false,
  ) {
    if (!raw.blob) return {};
    const method = mediaKind(raw.blob);
    if (result) {
      return { extraction: { method: result.method, status: result.retry_at ? 'retrying' : result.status, ...(result.code ? { code: result.code } : {}) } };
    }
    if (method) {
      const status = suppliedText ? 'complete' : method === 'transcription' && this.transcriptionReady === false ? 'waiting_model' : 'pending';
      return { extraction: { method, status } };
    }
    const requested = (JSON.parse(raw.meta) as { extract?: string }).extract;
    return requested === 'pending:ocr' || requested === 'pending:transcription'
      ? { extraction: { method: requested.slice('pending:'.length), status: 'failed', code: 'unsupported' } }
      : {};
  }

  getRaw(id: string, query: URLSearchParams) {
    const r = this.db.prepare('SELECT * FROM raw_items WHERE id = ?').get(id) as unknown as RawRow | undefined;
    if (!r) throw notFound('No raw item with this id');
    const extraction = r.blob
      ? this.db.prepare('SELECT * FROM media_extractions WHERE raw_id = ?').get(r.id) as unknown as MediaRow | undefined
      : undefined;
    const meta = JSON.parse(r.meta) as Record<string, unknown>;
    const period = meta.review as ReviewPeriod | undefined;
    const text = r.source === 'system' && (REVIEW_KINDS as readonly string[]).includes(r.kind) &&
      period && typeof period.from === 'string' && typeof period.to === 'string' && isDay(period.from) && isDay(period.to)
      ? this.reviewText(period)
      : extraction?.text ?? r.text;
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
      totalChars: text.length,
      offset,
      text: text.slice(offset, offset + limit),
      more: offset + limit < text.length,
      meta,
      ...this.extractionView(r, extraction, Boolean(r.text)),
    };
  }

  nextMediaJob(transcription: boolean): MediaJob | null {
    this.transcriptionReady = transcription;
    const extensions = transcription ? [...IMAGE_EXTENSIONS, ...SOUND_EXTENSIONS] : IMAGE_EXTENSIONS;
    const row = this.db.prepare(`
      SELECT r.id, r.blob FROM raw_items r LEFT JOIN media_extractions m ON m.raw_id = r.id
      WHERE r.blob IS NOT NULL AND r.text = ''
        AND substr(r.blob, 65) IN (${extensions.map(() => '?').join(',')})
        AND (m.raw_id IS NULL OR m.retry_at <= ?)
      ORDER BY r.received_at, r.id LIMIT 1
    `).get(...extensions, this.iso()) as { id: string; blob: string } | undefined;
    if (!row) return null;
    const method = mediaKind(row.blob);
    return method ? { ...row, method } : null;
  }

  finishMediaJob(job: MediaJob, result: MediaResult): void {
    if (result.status === 'failed' && result.code === 'model_required') return;
    transaction(this.db, () => {
      const raw = this.db.prepare('SELECT * FROM raw_items WHERE id = ? AND blob = ?').get(job.id, job.blob) as unknown as RawRow | undefined;
      if (!raw || raw.text || mediaKind(job.blob) !== job.method) return;
      const previous = this.db.prepare('SELECT * FROM media_extractions WHERE raw_id = ?').get(job.id) as unknown as MediaRow | undefined;
      if (previous && (previous.status !== 'failed' || !previous.retry_at)) return;
      const text = result.status === 'complete' ? result.text : '';
      const code = result.status === 'failed' ? result.code : null;
      const attempts = (previous?.attempts ?? 0) + 1;
      const retryAt = (code === 'engine_failed' || code === 'timeout') && attempts < 3
        ? new Date(this.now().getTime() + attempts * 5 * 60_000).toISOString()
        : null;
      const status = code ? 'failed' : text ? 'complete' : 'empty';
      this.db.prepare(`
        INSERT INTO media_extractions (raw_id, status, method, text, code, attempts, retry_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(raw_id) DO UPDATE SET status = excluded.status, text = excluded.text, code = excluded.code,
          attempts = excluded.attempts, retry_at = excluded.retry_at, updated_at = excluded.updated_at
      `).run(raw.id, status, job.method, text, code, attempts, retryAt, this.iso());
      if (text) this.indexRaw({ ...raw, text });
      this.log('system', 'extract', 'raw', raw.id, { method: job.method, status, code, chars: text.length });
    });
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
    const stored = this.db.prepare('SELECT id FROM raw_items WHERE blob IS NOT NULL AND sha256 = ?').get(sha) as { id: string } | undefined;
    if (stored) return { id: stored.id, duplicate: true };

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
    only(body, ['page', 'title', 'type', 'summary', 'aliases', 'archived', 'reason']);
    const ref = str(body, 'page', 200);
    const reason = str(body, 'reason', 300);
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
        this.log(actor, 'create', 'page', id, { slug, title, type, summary, aliases, ...(reason ? { reason } : {}) });
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
        ...(reason ? { reason } : {}),
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
      .prepare("SELECT id, text, kind, observed_on, source_raw_id, source_note, created_at FROM facts WHERE page_id = ? AND status = 'active' ORDER BY coalesce(observed_on, substr(created_at, 1, 10)), created_at")
      .all(p.id) as Array<{ id: string; text: string; kind: FactKind | null; observed_on: string | null; source_raw_id: string | null; source_note: string | null; created_at: string }>;
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
      facts: facts.map((f) => ({ id: f.id, text: f.text, kind: f.kind, observedOn: f.observed_on, source: f.source_raw_id ? { rawId: f.source_raw_id } : f.source_note ?? null })),
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

  /**
   * Active facts across pages, oldest first: by kind (or kind=none for untyped ones), page and page type.
   * For the kind backfill and the graph view; a page's own facts come with getPage.
   */
  listFacts(query: URLSearchParams) {
    const kind = query.get('kind');
    if (kind && kind !== 'none') oneOf(kind, 'kind', FACT_KINDS);
    const type = query.get('type');
    if (type) oneOf(type, 'type', PAGE_TYPES);
    const pageRef = query.get('page');
    const page = pageRef ? this.page(pageRef) : null;
    const limit = query.get('limit') === null ? 100 : Number(query.get('limit'));
    if (!(Number.isInteger(limit) && limit >= 1 && limit <= 500)) throw bad('limit must be 1-500');
    const offset = query.get('offset') === null ? 0 : Number(query.get('offset'));
    if (!(Number.isInteger(offset) && offset >= 0)) throw bad('offset must be 0 or more');
    const where = ["f.status = 'active'", 'p.archived = 0'];
    const args: string[] = [];
    if (kind === 'none') where.push('f.kind IS NULL');
    else if (kind) {
      where.push('f.kind = ?');
      args.push(kind);
    }
    if (type) {
      where.push('p.type = ?');
      args.push(type);
    }
    if (page) {
      where.push('f.page_id = ?');
      args.push(page.id);
    }
    const from = `FROM facts f JOIN pages p ON p.id = f.page_id WHERE ${where.join(' AND ')}`;
    const total = (this.db.prepare(`SELECT count(*) AS n ${from}`).get(...args) as { n: number }).n;
    const rows = this.db
      .prepare(`SELECT f.id, f.text, f.kind, f.observed_on, p.slug, p.title, p.type ${from} ORDER BY f.created_at, f.id LIMIT ${limit} OFFSET ${offset}`)
      .all(...args) as Array<{ id: string; text: string; kind: FactKind | null; observed_on: string | null; slug: string; title: string; type: string }>;
    return {
      facts: rows.map((r) => ({ id: r.id, text: r.text, kind: r.kind, observedOn: r.observed_on, page: { slug: r.slug, title: r.title, type: r.type } })),
      total,
    };
  }

  private rawRef(value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !this.db.prepare('SELECT 1 FROM raw_items WHERE id = ?').get(value)) throw bad('sourceRawId must be the id of a stored raw item');
    return value;
  }

  addFact(body: Record<string, unknown>, actor: Actor) {
    only(body, ['page', 'text', 'kind', 'observedOn', 'sourceRawId', 'sourceNote']);
    const p = this.page(str(body, 'page', 200, true)!);
    const text = str(body, 'text', 1000, true)!;
    const kind = factKind(body.kind) ?? null;
    const observedOn = dateStr(body.observedOn, 'observedOn') ?? this.localDate();
    const sourceRawId = this.rawRef(body.sourceRawId);
    const sourceNote = str(body, 'sourceNote', 200) ?? (actor === 'hermes' ? 'owner said in chat' : null);
    const same = this.db.prepare("SELECT id, kind FROM facts WHERE page_id = ? AND status = 'active' AND lower(text) = lower(?)").get(p.id, text) as
      | { id: string; kind: FactKind | null }
      | undefined;
    if (same) return { id: same.id, duplicate: true, page: p.title, kind: same.kind };
    const id = randomUUID();
    const ts = this.iso();
    transaction(this.db, () => {
      this.db
        .prepare('INSERT INTO facts (id, page_id, text, kind, observed_on, source_raw_id, source_note, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, p.id, text, kind, observedOn, sourceRawId, sourceNote, 'active', actor, ts, ts);
      this.db.prepare('UPDATE pages SET updated_at = ? WHERE id = ?').run(ts, p.id);
      this.indexFact(id);
      this.log(actor, 'add', 'fact', id, { page: p.slug, text, kind, observedOn, sourceRawId, sourceNote });
    });
    return { id, duplicate: false, page: p.title, kind };
  }

  /**
   * Replaces a fact (the old one stays as superseded, so the history is kept) or removes it.
   * Only a kind (no text): the kind is set in place (same fact, logged), because it describes the fact
   * rather than changing what it says. A new text keeps the old kind unless a kind is given.
   */
  changeFact(id: string, body: Record<string, unknown>, actor: Actor) {
    only(body, ['text', 'kind', 'observedOn', 'remove', 'reason']);
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
    const kind = factKind(body.kind);
    if (kind !== undefined && body.text === undefined && body.observedOn === undefined) {
      if (kind === f.kind) return { id, kind, retyped: false };
      transaction(this.db, () => {
        this.db.prepare('UPDATE facts SET kind = ?, updated_at = ? WHERE id = ?').run(kind, ts, id);
        this.log(actor, 'retype', 'fact', id, { before: f.kind, after: kind, reason });
      });
      return { id, kind, retyped: true };
    }
    const text = str(body, 'text', 1000, true)!;
    const observedOn = dateStr(body.observedOn, 'observedOn') ?? this.localDate();
    const newKind = kind === undefined ? f.kind : kind;
    const newId = randomUUID();
    transaction(this.db, () => {
      this.db
        .prepare('INSERT INTO facts (id, page_id, text, kind, observed_on, source_raw_id, source_note, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(newId, f.page_id, text, newKind, observedOn, null, reason ?? (actor === 'hermes' ? 'owner said in chat' : null), 'active', actor, ts, ts);
      this.db.prepare("UPDATE facts SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?").run(newId, ts, id);
      this.indexFact(id);
      this.indexFact(newId);
      this.log(actor, 'supersede', 'fact', id, { before: f.text, after: text, ...(newKind !== f.kind ? { kindBefore: f.kind, kind: newKind } : {}), newId, reason });
    });
    return { id: newId, replaced: id, kind: newKind };
  }

  link(body: Record<string, unknown>, actor: Actor) {
    only(body, ['from', 'to', 'relation', 'note', 'remove', 'reason']);
    const from = this.page(str(body, 'from', 200, true)!);
    const to = this.page(str(body, 'to', 200, true)!);
    if (from.id === to.id) throw bad('A page cannot link to itself');
    const relation = str(body, 'relation', 30) ?? 'related';
    if (!RELATION.test(relation)) throw bad('relation must be 2-30 characters of a-z and _ (e.g. related, part_of, prerequisite, goal_of, uses)');
    const note = str(body, 'note', 300);
    const reason = str(body, 'reason', 300);
    const why = reason ? { reason } : {};
    if (body.remove === true) {
      const result = this.db.prepare('DELETE FROM links WHERE from_page = ? AND to_page = ? AND relation = ?').run(from.id, to.id, relation);
      if (result.changes) this.log(actor, 'unlink', 'link', null, { from: from.slug, to: to.slug, relation, ...why });
      return { removed: result.changes > 0 };
    }
    const result = this.db
      .prepare('INSERT OR IGNORE INTO links (from_page, to_page, relation, note, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(from.id, to.id, relation, note ?? null, this.iso());
    if (result.changes) this.log(actor, 'link', 'link', null, { from: from.slug, to: to.slug, relation, note, ...why });
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

  /** A closed day is reviewed once. Bounded catch-up keeps startup work predictable after downtime. */
  runNightlyReview(at: string): { days: number; weeks: number; activities: number; facts: number } {
    const lastDay = closedDay(this.now(), this.timeZone, at);
    const counts = { days: 0, weeks: 0, activities: 0, facts: 0 };
    const latest = this.db.prepare("SELECT external_id FROM raw_items WHERE source = 'system' AND kind = 'daily-review' ORDER BY external_id DESC LIMIT 1")
      .get() as { external_id: string } | undefined;
    const previousDay = latest?.external_id.slice('daily-review:'.length);
    const catchupStart = shiftDay(lastDay, -6);
    const firstDay = previousDay && isDay(previousDay) ? [shiftDay(previousDay, 1), catchupStart].sort().at(-1)! : lastDay;

    for (let day = firstDay; day <= lastDay; day = shiftDay(day, 1)) {
      const rows = this.db.prepare(`
        SELECT id, source, occurred_at, substr(text, 1, 50000) AS text FROM raw_items
        WHERE source IN ('chat', 'note') AND occurred_at >= ? AND occurred_at < ?
        ORDER BY occurred_at, id
      `).iterate(utcDayStart(day, this.timeZone), utcDayStart(shiftDay(day, 1), this.timeZone)) as Iterable<Pick<RawRow, 'id' | 'source' | 'text' | 'occurred_at'>>;
      for (const raw of rows) {
        for (const entry of reportedEntries(raw.source, raw.text, day)) {
          const page = entry.page ? this.findPage(entry.page) : undefined;
          if (entry.type === 'fact') {
            if (!page || page.archived) continue;
            const existing = this.db.prepare('SELECT 1 FROM facts WHERE page_id = ? AND source_raw_id = ? AND lower(text) = lower(?)').get(page.id, raw.id, entry.text);
            if (!existing && !this.addFact({ page: page.slug, text: entry.text, observedOn: entry.at, sourceRawId: raw.id, sourceNote: 'owner explicitly reported' }, 'system').duplicate) {
              counts.facts++;
            }
          } else if (!this.hasReportedActivity(entry, raw)) {
            this.addActivity({
              at: entry.at, title: entry.title, kind: entry.kind, minutes: entry.minutes, sourceRawId: raw.id,
              ...(page && !page.archived ? { pages: [page.slug] } : {}),
            }, 'system');
            counts.activities++;
          }
        }
      }
      this.saveReview('daily-review', { from: day, to: day });
      counts.days++;
    }

    const week = lastClosedWeek(lastDay);
    if (this.saveReview('weekly-review', week)) counts.weeks++;
    return counts;
  }

  private hasReportedActivity(entry: { at: string; title: string; kind: string; minutes?: number }, raw: Pick<RawRow, 'id' | 'occurred_at'>): boolean {
    const stamp = Date.parse(raw.occurred_at);
    const nearbyStart = new Date(stamp - 15 * 60_000).toISOString();
    const nearbyEnd = new Date(stamp + 15 * 60_000).toISOString();
    const recorded = this.db.prepare(`
      SELECT title, source_raw_id, minutes FROM activities WHERE kind = ? AND started_at >= ? AND started_at < ?
        AND (source_raw_id = ? OR (created_by = 'hermes' AND created_at BETWEEN ? AND ?))
    `).all(entry.kind, entry.at, shiftDay(entry.at, 1), raw.id, nearbyStart, nearbyEnd) as Array<{
      title: string; source_raw_id: string | null; minutes: number | null;
    }>;
    const title = normalizedActivity(entry.title);
    return recorded.some((activity) => {
      const other = normalizedActivity(activity.title);
      if (other === title || activity.source_raw_id === raw.id && (other.includes(title) || title.includes(other))) return true;
      return other.length >= 2 && title.length >= 2 && (other.includes(title) || title.includes(other)) && activity.minutes === (entry.minutes ?? null);
    });
  }

  private saveReview(kind: ReviewKind, period: ReviewPeriod): boolean {
    const label = kind === 'daily-review' ? '일간 지식 정리' : '주간 지식 정리';
    const dates = period.from === period.to ? period.to : period.from + ' ~ ' + period.to;
    const result = this.addRaw({
      source: 'system', kind, externalId: kind + ':' + period.to, title: label + ' ' + dates,
      occurredAt: utcDayStart(period.to, this.timeZone), text: label + '\n' + dates + '\n활동 기록과 저장된 사실 요약',
      meta: { review: period },
    }, 'system');
    return !result.duplicate;
  }

  private reviewText(period: ReviewPeriod): string {
    const after = shiftDay(period.to, 1);
    const rawCount = (this.db.prepare(`
      SELECT count(*) AS n FROM raw_items WHERE occurred_at >= ? AND occurred_at < ?
        AND NOT (source = 'system' AND kind IN ('daily-review', 'weekly-review'))
    `).get(utcDayStart(period.from, this.timeZone), utcDayStart(after, this.timeZone)) as { n: number }).n;
    const total = this.db.prepare(`
      SELECT count(*) AS n, coalesce(sum(minutes), 0) AS minutes, count(*) - count(minutes) AS withoutMinutes
      FROM activities WHERE status = 'active' AND started_at >= ? AND started_at < ?
    `).get(period.from, after) as { n: number; minutes: number; withoutMinutes: number };
    const activity = this.db.prepare(`
      SELECT started_at, title, minutes FROM activities WHERE status = 'active' AND started_at >= ? AND started_at < ?
      ORDER BY started_at DESC, id LIMIT 40
    `).all(period.from, after) as Array<Pick<ActivityRow, 'started_at' | 'title' | 'minutes'>>;
    const facts = this.db.prepare(`
      SELECT p.title, f.text, f.observed_on FROM facts f JOIN pages p ON p.id = f.page_id
      WHERE f.status = 'active' AND p.archived = 0 AND f.observed_on BETWEEN ? AND ?
      ORDER BY f.observed_on DESC, f.created_at DESC, f.id LIMIT 30
    `).all(period.from, period.to) as Array<{ title: string; text: string; observed_on: string }>;
    const dates = period.from === period.to ? period.to : period.from + ' ~ ' + period.to;
    const lines = [
      dates + ' · ' + this.timeZone,
      '원본 ' + rawCount + '건 · 활동 ' + total.n + '건 · 기록된 시간 ' + total.minutes + '분' +
        (total.withoutMinutes ? ' · 시간 미기록 ' + total.withoutMinutes + '건' : ''),
    ];
    if (activity.length) lines.push('', '활동', ...activity.map((a) =>
      '- ' + a.started_at + ' ' + a.title + (a.minutes === null ? '' : ' (' + a.minutes + '분)')));
    if (total.n > activity.length) lines.push('나머지 활동은 타임라인에서 볼 수 있습니다.');
    if (facts.length) lines.push('', '최근 사실', ...facts.map((f) =>
      '- ' + f.observed_on + ' ' + f.title + ' · ' + clip(f.text, 250)));
    return lines.join('\n');
  }

  // ---- layer 3: profile and index ----

  profile(compact = false) {
    const me = this.getPage('me');
    const index = this.db
      .prepare("SELECT type, title FROM pages WHERE archived = 0 AND slug NOT IN ('me', 'preferences') ORDER BY type, updated_at DESC")
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
    const prefs = this.getPage(PREFERENCES_SLUG).facts;
    if (prefs.length) {
      lines.push('Owner preferences and feedback (always follow; newest wins when two disagree):');
      for (const f of prefs.slice(-40)) lines.push(`- ${clip(f.text, 200)}`);
    }
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

  /**
   * The knowledge graph for a viewer (the Dashboard's graph page): pages with their names and counts,
   * links, pages done together, and optionally facts as child nodes (short excerpt; full text with
   * factDetail). Bounded: at most maxPages pages (newest changed first, "me" always first) and maxFacts
   * facts; `truncated` and `totals` say when something was left out.
   *   facts=1      include facts (active; with archived=1 also archived ones, status "removed")
   *   archived=1   include archived pages and archived facts
   *   type=<t>     only pages of this type
   * Superseded facts (older versions) are never nodes; they stay in the history.
   */
  graphView(query: URLSearchParams) {
    const allowed = ['facts', 'archived', 'type', 'maxPages', 'maxFacts'];
    const unknown = [...new Set(query.keys())].filter((k) => !allowed.includes(k));
    if (unknown.length) throw bad(`Unexpected parameters: ${unknown.join(', ')} (allowed: ${allowed.join(', ')})`);
    const flag = (name: string) => {
      const v = query.get(name);
      if (v === null || v === '0') return false;
      if (v === '1') return true;
      throw bad(`${name} must be 0 or 1`);
    };
    const bound = (name: string, fallback: number, max: number) => {
      const v = query.get(name);
      if (v === null) return fallback;
      const n = /^\d+$/.test(v) ? Number(v) : NaN;
      if (!(n >= 1 && n <= max)) throw bad(`${name} must be an integer 1-${max}`);
      return n;
    };
    const withFacts = flag('facts');
    const withArchived = flag('archived');
    const type = query.get('type');
    if (type) oneOf(type, 'type', PAGE_TYPES);
    const maxPages = bound('maxPages', GRAPH_PAGES, GRAPH_MAX_PAGES);
    const maxFacts = bound('maxFacts', GRAPH_FACTS, GRAPH_MAX_FACTS);

    const where = [withArchived ? '1' : 'p.archived = 0', ...(type ? ['p.type = ?'] : [])].join(' AND ');
    const args = type ? [type] : [];
    const totalPages = (this.db.prepare(`SELECT count(*) AS n FROM pages p WHERE ${where}`).get(...args) as { n: number }).n;
    const pages = this.db
      .prepare(
        `SELECT p.id, p.slug, p.title, p.type, p.aliases, p.archived, p.updated_at,
           (SELECT count(*) FROM facts f WHERE f.page_id = p.id AND f.status = 'active') AS facts,
           (SELECT count(*) FROM facts f WHERE f.page_id = p.id AND f.status = 'removed') AS archived_facts,
           (SELECT count(*) FROM activity_pages ap JOIN activities a ON a.id = ap.activity_id WHERE ap.page_id = p.id AND a.status = 'active') AS activities
         FROM pages p WHERE ${where} ORDER BY p.slug = 'me' DESC, p.updated_at DESC, p.id LIMIT ${maxPages}`,
      )
      .all(...args) as Array<{
      id: string;
      slug: string;
      title: string;
      type: string;
      aliases: string;
      archived: number;
      updated_at: string;
      facts: number;
      archived_facts: number;
      activities: number;
    }>;
    const ids = JSON.stringify(pages.map((p) => p.id));
    const inSet = (col: string) => `${col} IN (SELECT value FROM json_each(?))`;

    const links = this.db
      .prepare(
        `SELECT f.slug AS source, t.slug AS target, l.relation, l.note FROM links l JOIN pages f ON f.id = l.from_page JOIN pages t ON t.id = l.to_page
         WHERE ${inSet('l.from_page')} AND ${inSet('l.to_page')} ORDER BY l.created_at, f.slug, t.slug, l.relation`,
      )
      .all(ids, ids) as Array<{ source: string; target: string; relation: string; note: string | null }>;
    const together = this.db
      .prepare(
        `SELECT pa.slug AS source, pb.slug AS target, count(*) AS weight FROM activity_pages a1
         JOIN activity_pages a2 ON a2.activity_id = a1.activity_id AND a2.page_id > a1.page_id
         JOIN activities act ON act.id = a1.activity_id AND act.status = 'active'
         JOIN pages pa ON pa.id = a1.page_id JOIN pages pb ON pb.id = a2.page_id
         WHERE ${inSet('a1.page_id')} AND ${inSet('a2.page_id')}
         GROUP BY a1.page_id, a2.page_id ORDER BY weight DESC, pa.slug, pb.slug LIMIT ${GRAPH_MAX_TOGETHER + 1}`,
      )
      .all(ids, ids) as Array<{ source: string; target: string; weight: number }>;

    let facts: Array<Record<string, unknown>> | undefined;
    let totalFacts: number | undefined;
    let factsTruncated = false;
    if (withFacts) {
      const statuses = withArchived ? `('active', 'removed')` : `('active')`;
      const from = `FROM facts f JOIN pages p ON p.id = f.page_id WHERE f.status IN ${statuses} AND ${inSet('f.page_id')}`;
      totalFacts = (this.db.prepare(`SELECT count(*) AS n ${from}`).get(ids) as { n: number }).n;
      const rows = this.db
        .prepare(`SELECT f.id, p.slug, f.text, f.kind, f.status, f.observed_on, f.updated_at ${from} ORDER BY f.created_at DESC, f.id LIMIT ${maxFacts}`)
        .all(ids) as Array<{ id: string; slug: string; text: string; kind: FactKind | null; status: string; observed_on: string | null; updated_at: string }>;
      factsTruncated = totalFacts > rows.length;
      facts = rows.map((f) => {
        const excerpt = clip(f.text, GRAPH_EXCERPT);
        return {
          id: f.id,
          page: f.slug,
          text: excerpt,
          clipped: excerpt !== f.text,
          kind: f.kind,
          status: f.status,
          observedOn: f.observed_on,
          updatedAt: f.updated_at,
        };
      });
    }
    return {
      include: { facts: withFacts, archived: withArchived, type: type ?? null },
      pages: pages.map((p) => ({
        id: p.id,
        slug: p.slug,
        title: p.title,
        type: p.type,
        aliases: JSON.parse(p.aliases) as string[],
        archived: !!p.archived,
        counts: { facts: p.facts, archivedFacts: p.archived_facts, activities: p.activities },
        updatedAt: p.updated_at,
      })),
      ...(facts ? { facts } : {}),
      links: links.map((l) => ({ source: l.source, target: l.target, relation: l.relation, note: l.note })),
      doneTogether: together.slice(0, GRAPH_MAX_TOGETHER).map((e) => ({ source: e.source, target: e.target, weight: e.weight })),
      totals: { pages: totalPages, ...(totalFacts !== undefined ? { facts: totalFacts } : {}) },
      truncated: { pages: totalPages > pages.length, facts: factsTruncated, doneTogether: together.length > GRAPH_MAX_TOGETHER },
      vocab: { pageTypes: PAGE_TYPES, factKinds: FACT_KINDS },
    };
  }

  /** One fact with its full text and history pointers (for the viewer's edit form). Any status. */
  factDetail(id: string) {
    const f = this.db.prepare('SELECT f.*, p.slug AS page_slug, p.title AS page_title FROM facts f JOIN pages p ON p.id = f.page_id WHERE f.id = ?').get(id) as unknown as
      | (FactRow & { page_slug: string; page_title: string })
      | undefined;
    if (!f) throw notFound('No fact with this id');
    return {
      id: f.id,
      page: { slug: f.page_slug, title: f.page_title },
      text: f.text,
      kind: f.kind,
      status: f.status,
      observedOn: f.observed_on,
      source: f.source_raw_id ? { rawId: f.source_raw_id } : (f.source_note ?? null),
      supersededBy: f.superseded_by,
      createdBy: f.created_by,
      createdAt: f.created_at,
      updatedAt: f.updated_at,
    };
  }

  // ---- owner edits from the Dashboard graph page ----
  // Narrow wrappers over the same code paths Hermes uses (changeFact, savePage, link): pages are named by
  // slug only (never created by a typo), a reason is required and lands in change_log with the actor,
  // and nothing here deletes for good (archive/unarchive only; permanent deletion stays with purge).

  private reasonOf(body: Record<string, unknown>): string {
    return str(body, 'reason', 300, true)!;
  }

  private pageBySlug(value: unknown, key: string): PageRow {
    if (typeof value !== 'string' || !value.trim() || value.length > 100) throw bad(`${key} must be a page slug`);
    const p = this.db.prepare('SELECT * FROM pages WHERE slug = ?').get(value.trim()) as unknown as PageRow | undefined;
    if (!p) throw notFound(`No page with slug "${value.trim()}"`);
    return p;
  }

  /** Changes a fact's text and/or kind. A new text replaces the fact (new id; the old one stays as superseded). */
  editFact(id: string, body: Record<string, unknown>, actor: Actor) {
    only(body, ['text', 'kind', 'reason']);
    const reason = this.reasonOf(body);
    if (body.text === undefined && body.kind === undefined) throw bad('Nothing to change: give text and/or kind');
    const text = body.text === undefined ? undefined : str(body, 'text', 1000, true)!;
    const kind = factKind(body.kind);
    const f = this.db.prepare('SELECT * FROM facts WHERE id = ?').get(id) as unknown as FactRow | undefined;
    if (!f) throw notFound('No fact with this id');
    if (f.status === 'removed') throw conflict('This fact is archived; unarchive it before editing');
    if (f.status !== 'active') throw conflict('This fact was replaced by a newer version; edit that one', { supersededBy: f.superseded_by });
    if (text === undefined || text === f.text) {
      if (kind === undefined || kind === f.kind) return { changed: false, fact: this.factDetail(id) };
      this.changeFact(id, { kind, reason }, actor);
      return { changed: true, fact: this.factDetail(id) };
    }
    const same = this.db.prepare("SELECT id FROM facts WHERE page_id = ? AND status = 'active' AND id != ? AND lower(text) = lower(?)").get(f.page_id, id, text) as
      | { id: string }
      | undefined;
    if (same) throw conflict('The page already has an active fact with this text', { id: same.id });
    const result = this.changeFact(id, { text, ...(kind !== undefined ? { kind } : {}), ...(f.observed_on ? { observedOn: f.observed_on } : {}), reason }, actor) as { id: string };
    return { changed: true, replaced: id, fact: this.factDetail(result.id) };
  }

  /** Archives (status "removed": out of search and answers) or unarchives a fact. */
  setFactArchived(id: string, body: Record<string, unknown>, actor: Actor) {
    only(body, ['archived', 'reason']);
    if (typeof body.archived !== 'boolean') throw bad('archived must be true or false');
    const reason = this.reasonOf(body);
    const f = this.db.prepare('SELECT * FROM facts WHERE id = ?').get(id) as unknown as FactRow | undefined;
    if (!f) throw notFound('No fact with this id');
    if (f.status === 'superseded') throw conflict('This fact was replaced by a newer version; archive that one', { supersededBy: f.superseded_by });
    const archived = f.status === 'removed';
    if (archived === body.archived) return { changed: false, fact: this.factDetail(id) };
    if (body.archived) {
      this.changeFact(id, { remove: true, reason }, actor);
      return { changed: true, fact: this.factDetail(id) };
    }
    const same = this.db.prepare("SELECT id FROM facts WHERE page_id = ? AND status = 'active' AND lower(text) = lower(?)").get(f.page_id, f.text) as { id: string } | undefined;
    if (same) throw conflict('The page already has an active fact with this text', { id: same.id });
    transaction(this.db, () => {
      this.db.prepare("UPDATE facts SET status = 'active', updated_at = ? WHERE id = ?").run(this.iso(), id);
      this.indexFact(id);
      this.log(actor, 'restore', 'fact', id, { text: f.text, reason });
    });
    return { changed: true, fact: this.factDetail(id) };
  }

  /** Changes a page's title and/or aliases, or archives/unarchives it. */
  editPage(body: Record<string, unknown>, actor: Actor) {
    only(body, ['page', 'title', 'aliases', 'archived', 'reason']);
    const reason = this.reasonOf(body);
    const p = this.pageBySlug(body.page, 'page');
    if (body.title === undefined && body.aliases === undefined && body.archived === undefined) throw bad('Nothing to change: give title, aliases and/or archived');
    const title = body.title === undefined ? undefined : str(body, 'title', 120, true)!;
    const aliases = body.aliases === undefined ? undefined : strList(body.aliases, 'aliases', 20, 80);
    if (body.archived !== undefined && typeof body.archived !== 'boolean') throw bad('archived must be true or false');
    const archived = body.archived as boolean | undefined;
    if (archived && (p.slug === 'me' || p.slug === PREFERENCES_SLUG)) throw bad(`The page "${p.slug}" cannot be archived`);
    // A name must lead to this page only: page lookups by title or alias would otherwise become ambiguous.
    for (const name of [...(title !== undefined ? [title] : []), ...(aliases ?? [])]) {
      const other = this.findPage(name);
      if (other && other.id !== p.id) throw conflict(`"${name}" already names the page "${other.title}" (${other.slug})`, { page: other.slug });
    }
    const change: Record<string, unknown> = {};
    if (title !== undefined && title !== p.title) change.title = title;
    if (aliases !== undefined && JSON.stringify(aliases) !== p.aliases) change.aliases = aliases;
    if (archived !== undefined && archived !== !!p.archived) change.archived = archived;
    if (!Object.keys(change).length) return { changed: false, page: this.pageView(p.id) };
    const result = this.savePage({ page: p.slug, ...change, reason }, actor);
    return { changed: true, page: result.page };
  }

  /** Adds or removes a link between two pages (named by slug). */
  editLink(body: Record<string, unknown>, actor: Actor) {
    only(body, ['from', 'to', 'relation', 'note', 'remove', 'reason']);
    const reason = this.reasonOf(body);
    const from = this.pageBySlug(body.from, 'from');
    const to = this.pageBySlug(body.to, 'to');
    const relation = str(body, 'relation', 30, true)!;
    if (relation === 'done_together') throw bad('done_together is computed from activities and cannot be set by hand');
    if (body.remove !== undefined && typeof body.remove !== 'boolean') throw bad('remove must be true or false');
    if (body.remove && body.note !== undefined) throw bad('note is only for adding a link');
    const result = this.link(
      { from: from.slug, to: to.slug, relation, ...(body.note !== undefined ? { note: body.note } : {}), ...(body.remove ? { remove: true } : {}), reason },
      actor,
    );
    if (body.remove) {
      if (!(result as { removed: boolean }).removed) throw notFound('No such link');
      return { changed: true, removed: true };
    }
    return { changed: !(result as { duplicate: boolean }).duplicate, link: { source: from.slug, target: to.slug, relation } };
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
