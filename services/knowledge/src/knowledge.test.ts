import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApi } from './api.js';
import { openDatabase } from './db.js';
import { normalize, type Embedder } from './embed.js';
import { Knowledge } from './knowledge.js';
import { chunk, ftsQuery, queryWords, slugify } from './text.js';

/** Bag-of-words vectors; "운동" and "헬스" count as the same word so meaning-only matches can be tested. */
function fakeEmbedder(): Embedder & { calls: number } {
  const synonyms: Record<string, string> = { 운동: '헬스', workout: '헬스' };
  return {
    model: 'fake',
    calls: 0,
    async embed(texts: string[]) {
      this.calls++;
      return texts.map((t) => {
        const v = new Array(1024).fill(0);
        for (const w of queryWords(t)) {
          const word = synonyms[w] ?? w;
          let h = 0;
          for (const c of word) h = (h * 31 + c.charCodeAt(0)) >>> 0;
          v[h % 1024] += 1;
        }
        return normalize(v);
      });
    },
  };
}

function setup(options: { embedder?: Embedder | null; documentsDir?: string | null; now?: () => Date } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-'));
  const db = openDatabase(join(dir, 'k.db'));
  let clock = new Date('2026-11-22T15:00:00Z');
  const kb = new Knowledge(db, {
    timeZone: 'America/Toronto',
    blobDir: join(dir, 'blobs'),
    documentsDir: options.documentsDir === undefined ? null : options.documentsDir,
    embedder: options.embedder === undefined ? null : options.embedder,
    now: options.now ?? (() => clock),
  });
  return { kb, db, dir, tick: (ms: number) => (clock = new Date(clock.getTime() + ms)) };
}

describe('text helpers', () => {
  it('chunks long text with overlap and keeps short text whole', () => {
    assert.deepEqual(chunk('짧은 글'), ['짧은 글']);
    const long = Array.from({ length: 100 }, (_, i) => `Sentence number ${i} about CSC263 heaps.`).join(' ');
    const parts = chunk(long);
    assert.ok(parts.length >= 3);
    assert.ok(parts.every((p) => p.length <= 1200));
  });
  it('makes slugs and keyword queries that survive Korean particles', () => {
    assert.equal(slugify('CSC263 자료구조!'), 'csc263-자료구조');
    assert.deepEqual(queryWords('헬스를 언제 했지? CSC263은'), ['헬스', '언제', '했지', 'csc263']);
    assert.equal(ftsQuery('?!'), null);
  });
});

describe('pages, facts, links', () => {
  it('starts with the owner page and creates, finds and updates pages', () => {
    const { kb } = setup();
    assert.equal(kb.getPage('me').page.type, 'me');
    const created = kb.savePage({ title: 'CSC263 자료구조', type: 'course', summary: 'UTM 가을 학기 수업', aliases: ['csc263', '자구'] }, 'hermes');
    assert.equal(created.created, true);
    assert.equal(created.page.slug, 'csc263-자료구조');
    assert.equal(kb.findPage('자구')?.title, 'CSC263 자료구조');
    assert.equal(kb.findPage('csc263 자료구조')?.slug, 'csc263-자료구조');
    const updated = kb.savePage({ page: 'csc263', summary: '힙과 해시를 배우는 수업' }, 'hermes');
    assert.equal(updated.created, false);
    assert.equal(updated.page.summary, '힙과 해시를 배우는 수업');
    assert.throws(() => kb.savePage({ title: 'X' }, 'hermes'), /needs title and type/);
    assert.throws(() => kb.savePage({ page: 'me', type: 'topic' }, 'hermes'), /cannot change type/);
    assert.throws(() => kb.savePage({ title: 'Y', type: 'me' }, 'hermes'), /reserved/);
    assert.throws(() => kb.savePage({ title: 'Z', type: 'topic', secret: 1 }, 'hermes'), /Unexpected fields/);
  });

  it('keeps fact history when a fact changes and refuses unknown pages', () => {
    const { kb } = setup();
    kb.savePage({ title: '헬스', type: 'habit' }, 'hermes');
    const fact = kb.addFact({ page: '헬스', text: '월·수·금 아침 7시에 한다' }, 'hermes');
    assert.equal(kb.addFact({ page: '헬스', text: '월·수·금 아침 7시에 한다' }, 'hermes').duplicate, true);
    const changed = kb.changeFact(fact.id, { text: '화·목 저녁 8시에 한다', reason: '학기가 바뀜' }, 'hermes');
    const page = kb.getPage('헬스');
    assert.deepEqual(page.facts.map((f) => f.text), ['화·목 저녁 8시에 한다']);
    assert.equal(changed.replaced, fact.id);
    assert.ok(kb.changes(10).some((c) => c.action === 'supersede' && (c.detail as { before: string }).before === '월·수·금 아침 7시에 한다'));
    kb.changeFact(changed.id, { remove: true, reason: '그만둠' }, 'hermes');
    assert.equal(kb.getPage('헬스').facts.length, 0);
    assert.throws(() => kb.addFact({ page: '없는 페이지', text: 'x' }, 'hermes'), /No page/);
  });

  it('links pages and builds the graph', () => {
    const { kb } = setup();
    kb.savePage({ title: '인턴 준비', type: 'goal' }, 'hermes');
    kb.savePage({ title: 'CSC263', type: 'course' }, 'hermes');
    assert.equal(kb.link({ from: 'CSC263', to: '인턴 준비', relation: 'goal_of' }, 'hermes').linked, true);
    assert.equal(kb.link({ from: 'CSC263', to: '인턴 준비', relation: 'goal_of' }, 'hermes').duplicate, true);
    assert.throws(() => kb.link({ from: 'CSC263', to: 'CSC263' }, 'hermes'), /itself/);
    assert.throws(() => kb.link({ from: 'CSC263', to: '인턴 준비', relation: 'Bad Rel' }, 'hermes'), /relation/);
    kb.addActivity({ at: '2026-11-21T19:00', minutes: 90, kind: 'study', title: '힙 문제 풀이', pages: ['CSC263', '인턴 준비'] }, 'hermes');
    const graph = kb.graph();
    assert.ok(graph.nodes.some((n) => n.id === 'csc263' && n.activities === 1));
    assert.ok(graph.edges.some((e) => e.relation === 'goal_of'));
    assert.ok(graph.edges.some((e) => e.relation === 'done_together'));
    assert.equal(kb.getPage('인턴 준비').linkedFrom[0].from.title, 'CSC263');
  });
});

describe('fact kinds', () => {
  it('upgrades an older database: existing facts stay valid and untyped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-'));
    const file = join(dir, 'k.db');
    const old = openDatabase(file, { upTo: 2 });
    const ts = '2026-11-01T00:00:00.000Z';
    old.prepare('INSERT INTO pages (id, slug, title, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('p1', 'mat223', 'MAT223', 'course', ts, ts);
    old.prepare('INSERT INTO facts (id, page_id, text, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('f1', 'p1', 'Test 1: 47/50 (94%)', 'hermes', ts, ts);
    assert.ok(!(old.prepare('PRAGMA table_info(facts)').all() as Array<{ name: string }>).some((c) => c.name === 'kind'));
    old.close();

    const db = openDatabase(file);
    assert.equal((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version, 4);
    const kb = new Knowledge(db, { timeZone: 'America/Toronto', blobDir: join(dir, 'blobs'), documentsDir: null, embedder: null });
    assert.deepEqual(kb.getPage('MAT223').facts.map((f) => [f.text, f.kind]), [['Test 1: 47/50 (94%)', null]]);
    assert.equal(kb.listFacts(new URLSearchParams('kind=none')).total, 1);
    assert.deepEqual(kb.changeFact('f1', { kind: 'score' }, 'operator'), { id: 'f1', kind: 'score', retyped: true });
    db.close();
    const again = openDatabase(file);   // reopening runs no migration twice
    assert.equal((again.prepare('SELECT version FROM schema_version').get() as { version: number }).version, 4);
    assert.equal((again.prepare('SELECT kind FROM facts WHERE id = ?').get('f1') as { kind: string }).kind, 'score');
    again.close();
  });

  it('stores, validates, keeps and lists kinds', () => {
    const { kb } = setup();
    kb.savePage({ title: 'MAT223', type: 'course' }, 'hermes');
    const score = kb.addFact({ page: 'MAT223', text: 'Test 1: 47/50 (94%)', kind: 'score' }, 'hermes');
    assert.equal(score.kind, 'score');
    const plain = kb.addFact({ page: 'MAT223', text: '교재: Liu 노트' }, 'hermes');
    assert.equal(plain.kind, null);
    assert.equal(kb.addFact({ page: 'MAT223', text: 'test 1: 47/50 (94%)', kind: 'other' }, 'hermes').kind, 'score', 'a duplicate keeps its kind');
    assert.throws(() => kb.addFact({ page: 'MAT223', text: 'x', kind: 'grade' }, 'hermes'), /kind must be one of score, mistake/);
    assert.throws(() => kb.addFact({ page: 'MAT223', text: 'x', kind: 3 }, 'hermes'), /kind must be one of/);

    // a kind alone is set in place (same fact id, logged); a new text keeps the kind unless one is given
    assert.deepEqual(kb.changeFact(plain.id, { kind: 'resource' }, 'operator'), { id: plain.id, kind: 'resource', retyped: true });
    assert.deepEqual(kb.changeFact(plain.id, { kind: 'resource' }, 'operator'), { id: plain.id, kind: 'resource', retyped: false });
    assert.ok(kb.changes(5).some((c) => c.action === 'retype' && c.entityId === plain.id && (c.detail as { before: unknown; after: unknown }).after === 'resource'));
    const reworded = kb.changeFact(plain.id, { text: '교재: Liu 노트 1-4장' }, 'hermes');
    assert.equal(reworded.kind, 'resource');
    const cleared = kb.changeFact(reworded.id!, { text: '교재: Liu 노트 1-5장', kind: null }, 'hermes');
    assert.equal(cleared.kind, null);
    assert.throws(() => kb.changeFact(score.id, { kind: 'bogus' }, 'hermes'), /kind must be one of/);
    assert.deepEqual(kb.getPage('MAT223').facts.map((f) => [f.text, f.kind]), [['Test 1: 47/50 (94%)', 'score'], ['교재: Liu 노트 1-5장', null]]);

    const byKind = kb.listFacts(new URLSearchParams('kind=score'));
    assert.equal(byKind.total, 1);
    assert.deepEqual(byKind.facts[0].page, { slug: 'mat223', title: 'MAT223', type: 'course' });
    assert.equal(kb.listFacts(new URLSearchParams('kind=none&type=course')).facts[0].text, '교재: Liu 노트 1-5장');
    assert.equal(kb.listFacts(new URLSearchParams('page=MAT223&limit=1&offset=1')).facts.length, 1);
    assert.throws(() => kb.listFacts(new URLSearchParams('kind=grade')), /kind must be one of/);
    assert.throws(() => kb.listFacts(new URLSearchParams('limit=0')), /limit must be 1-500/);
    assert.throws(() => kb.listFacts(new URLSearchParams('offset=-1')), /offset/);
  });
});

describe('activities', () => {
  it('records, filters, changes and removes activities', () => {
    const { kb } = setup();
    kb.savePage({ title: 'CSC263', type: 'course' }, 'hermes');
    const a = kb.addActivity({ at: '2026-11-20T19:00', minutes: 60, kind: 'study', title: '5장 복습', outcome: '문제 3개', feeling: '어려웠음', pages: ['CSC263'] }, 'hermes');
    kb.addActivity({ at: '2026-11-21', kind: 'chore', title: '빨래' }, 'hermes');
    assert.equal(kb.timeline(new URLSearchParams({ from: '2026-11-20', to: '2026-11-21' })).activities.length, 2);
    const study = kb.timeline(new URLSearchParams({ page: 'CSC263' }));
    assert.equal(study.totalMinutes, 60);
    assert.deepEqual(study.activities[0].pages, ['CSC263']);
    kb.changeActivity(a.activity.id, { minutes: 90 }, 'hermes');
    assert.equal(kb.timeline(new URLSearchParams({ kind: 'study' })).totalMinutes, 90);
    kb.changeActivity(a.activity.id, { remove: true }, 'hermes');
    assert.equal(kb.timeline(new URLSearchParams({ kind: 'study' })).activities.length, 0);
    assert.throws(() => kb.addActivity({ at: '11/20', title: 'x' }, 'hermes'), /YYYY-MM-DD/);
    assert.throws(() => kb.addActivity({ title: 'x', kind: 'nap' }, 'hermes'), /kind must be/);
    assert.throws(() => kb.addActivity({ title: 'x', pages: ['없음'] }, 'hermes'), /No page/);
  });
});

describe('raw originals', () => {
  it('stores chat turns once per external id and never changes them', () => {
    const { kb, db } = setup();
    const first = kb.addRaw({ source: 'chat', kind: 'discord-turn', text: 'owner: 오늘 CSC263 5장 했어\nkelly: 기록했어요', externalId: 'turn:abc' }, 'hermes');
    assert.equal(first.duplicate, false);
    assert.equal(kb.addRaw({ source: 'chat', kind: 'discord-turn', text: 'other', externalId: 'turn:abc' }, 'hermes').duplicate, true);
    assert.throws(() => db.prepare('UPDATE raw_items SET text = ? WHERE id = ?').run('changed', first.id), /immutable/);
    assert.throws(() => db.prepare('DELETE FROM raw_items WHERE id = ?').run(first.id), /immutable/);
    const read = kb.getRaw(first.id, new URLSearchParams({ offset: '7', limit: '100' }));
    assert.ok(read.text.startsWith('오늘 CSC263'));
    assert.equal(kb.listRaw(new URLSearchParams({ source: 'chat' })).length, 1);
    assert.throws(() => kb.addRaw({ source: 'web', kind: 'x', text: 'y' }, 'hermes'), /source must be/);
    assert.throws(() => kb.addRaw({ source: 'chat', kind: 'xx', text: 'y', externalId: 'bad id' }, 'hermes'), /externalId/);
  });

  it('copies attached documents by hash from the attachment folder only', async () => {
    const docs = mkdtempSync(join(tmpdir(), 'kb-docs-'));
    mkdirSync(join(docs, 'native-inputs', 'aa'), { recursive: true });
    writeFileSync(join(docs, 'native-inputs', 'aa', 'doc_0123456789ab_MAT223.pdf'), '%PDF-1.4 fake');
    writeFileSync(join(docs, 'doc_0123456789ab_MAT223.pdf'), '%PDF-1.4 fake');
    const outside = join(tmpdir(), `kb-outside-${process.pid}.txt`);
    writeFileSync(outside, 'secret');
    const { kb, dir } = setup({ documentsDir: docs });
    const stored = await kb.addDocument({ file: 'doc_0123456789ab_MAT223.pdf', text: 'Term Test 1: Oct 15 (20%)', contentType: 'application/pdf', pageCount: 14 }, 'hermes');
    assert.equal(stored.title, 'MAT223.pdf');
    assert.equal((await kb.addDocument({ file: 'doc_0123456789ab_MAT223.pdf', text: 'again' }, 'hermes')).duplicate, true);
    const raw = kb.getRaw(stored.id, new URLSearchParams());
    assert.equal(raw.storedOriginal, true);
    assert.equal(raw.meta.pageCount, 14);
    for (const name of ['../k.db', '..', join(dir, 'k.db'), 'nope.pdf']) {
      await assert.rejects(() => kb.addDocument({ file: name, text: '' }, 'hermes'), /plain file name|No attached file/);
    }
    try {
      symlinkSync(outside, join(docs, 'doc_0123456789ab_link.txt'));
      await assert.rejects(() => kb.addDocument({ file: 'doc_0123456789ab_link.txt', text: '' }, 'hermes'), /No attached file/);
    } catch (error) {
      if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    rmSync(outside, { force: true });
    await assert.rejects(() => setup().kb.addDocument({ file: 'a.pdf', text: '' }, 'hermes'), /not mounted/);
  });

  it('keeps one original when identical attachments arrive concurrently with different names and extensions', async () => {
    const docs = mkdtempSync(join(tmpdir(), 'kb-duplicate-media-'));
    writeFileSync(join(docs, 'one.png'), 'same image content');
    writeFileSync(join(docs, 'two.jpg'), 'same image content');
    const { kb, dir } = setup({ documentsDir: docs });
    const archived = await Promise.all(
      ['one.png', 'two.jpg'].map((file) => kb.addDocument({ file, text: '' }, 'hermes')),
    );
    assert.equal(archived[0].id, archived[1].id);
    assert.equal(archived.filter((entry) => !entry.duplicate).length, 1);
    assert.equal(readdirSync(join(dir, 'blobs')).length, 1);
  });
});

describe('nightly knowledge review', () => {
  it('uses the closed Toronto day and keeps source-linked completed work and explicit facts once', () => {
    let now = new Date('2026-11-25T05:16:00Z'); // 00:16 Toronto
    const { kb, db } = setup({ now: () => now });
    kb.savePage({ title: 'CSC207', type: 'course' }, 'hermes');
    const raw = kb.addRaw({
      source: 'chat', kind: 'discord-turn', occurredAt: '2026-11-25T04:59:00Z',
      text: 'owner: 오늘 CSC207 45분 공부했어\n사실 [CSC207]: 시험은 강의실에서 본다\n내일 수업 들을 예정이야\n\nkelly: 오늘 60분 운동했어',
    }, 'hermes');
    kb.addRaw({
      source: 'import', kind: 'text', occurredAt: '2026-11-25T04:00:00Z',
      text: '활동: 운동 90분\n사실 [CSC207]: 다른 자료에서 본 문장',
    }, 'operator');
    kb.addRaw({
      source: 'chat', kind: 'discord-turn', occurredAt: '2026-11-25T04:10:00Z',
      text: "owner: [The user sent a text document: 'notes.txt'. The file is also saved at: /opt/data/cache/documents/notes.txt]\n활동: 45분 운동\n사실 [CSC207]: 첨부 파일 문장\n\nkelly: 파일을 읽었어요.",
    }, 'hermes');
    const result = kb.runNightlyReview('00:15');
    assert.deepEqual(result, { days: 1, weeks: 1, activities: 1, facts: 1 });
    const timeline = kb.timeline(new URLSearchParams({ from: '2026-11-24', to: '2026-11-24' }));
    assert.equal(timeline.totalMinutes, 45);
    assert.deepEqual(timeline.activities[0].pages, ['CSC207']);
    assert.equal((db.prepare('SELECT source_raw_id FROM activities').get() as { source_raw_id: string }).source_raw_id, raw.id);
    assert.equal(kb.getPage('CSC207').facts[0].text, '시험은 강의실에서 본다');
    const summaries = kb.listRaw(new URLSearchParams({ source: 'system' }));
    const daily = summaries.find((item) => item.kind === 'daily-review')!;
    assert.equal(daily.date, '2026-11-24');
    assert.match(kb.getRaw(daily.id, new URLSearchParams()).text, /활동 1건.*45분/);
    assert.deepEqual(kb.runNightlyReview('00:15'), { days: 0, weeks: 0, activities: 0, facts: 0 });
    kb.changeActivity(timeline.activities[0].id, { remove: true }, 'hermes');
    assert.match(kb.getRaw(daily.id, new URLSearchParams()).text, /활동 0건/);
    now = new Date('2026-11-26T05:14:59Z');
    assert.equal(kb.runNightlyReview('00:15').days, 0);
    now = new Date('2026-11-26T05:15:00Z');
    assert.equal(kb.runNightlyReview('00:15').days, 1);
  });

  it('reuses a matching activity Kelly already recorded around the same report', () => {
    let now = new Date('2026-11-25T00:00:00Z');
    const { kb } = setup({ now: () => now });
    kb.addActivity({ kind: 'exercise', title: '운동', minutes: 25 }, 'hermes');
    kb.addRaw({ source: 'chat', kind: 'discord-turn', text: 'owner: 오늘 25분 운동했어\n\nkelly: 기록했어요.' }, 'hermes');
    now = new Date('2026-11-25T05:16:00Z');
    assert.equal(kb.runNightlyReview('00:15').activities, 0);
    assert.equal(kb.timeline(new URLSearchParams()).activities.length, 1);
    assert.throws(() => kb.addRaw({ source: 'system', kind: 'daily-review', text: '가짜 요약' }, 'hermes'), /nightly job/);
  });
});

describe('local media extraction', () => {
  it('holds audio while its model is missing and indexes derived OCR without modifying the original', async () => {
    const docs = mkdtempSync(join(tmpdir(), 'kb-media-'));
    const { kb, db } = setup({ documentsDir: docs });
    const png = 'doc_0123456789ab_slide.png';
    const wav = 'doc_0123456789ab_lecture.wav';
    writeFileSync(join(docs, png), 'fixture image');
    writeFileSync(join(docs, wav), 'fixture audio');
    const image = await kb.addDocument({ file: png, text: '' }, 'hermes');
    const audio = await kb.addDocument({ file: wav, text: '' }, 'hermes');
    const job = kb.nextMediaJob(false)!;
    assert.equal(job.id, image.id);
    assert.deepEqual(kb.getRaw(audio.id, new URLSearchParams()).extraction, { method: 'transcription', status: 'waiting_model' });
    kb.finishMediaJob(job, { status: 'complete', text: 'Quicksort lecture' });
    assert.equal((db.prepare('SELECT text FROM raw_items WHERE id = ?').get(image.id) as { text: string }).text, '');
    assert.equal(kb.getRaw(image.id, new URLSearchParams()).text, 'Quicksort lecture');
    assert.equal((await kb.search('Quicksort', { kinds: ['raw'] }))[0].id, image.id);
    assert.equal(kb.nextMediaJob(false), null);
    assert.equal(kb.nextMediaJob(true)?.id, audio.id);
    kb.purge({ target: 'raw', id: image.id, reason: 'remove fixture' }, 'operator');
    assert.equal(db.prepare('SELECT * FROM media_extractions WHERE raw_id = ?').get(image.id), undefined);
    assert.equal((await kb.search('Quicksort', { kinds: ['raw'] })).length, 0);
  });

  it('processes pending importer originals written with schema v3', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-before-media-'));
    const dbFile = join(dir, 'knowledge.db');
    const blobDir = join(dir, 'blobs');
    const before = openDatabase(dbFile, { upTo: 3 });
    const options = { timeZone: 'America/Toronto', blobDir, documentsDir: null, embedder: null };
    let storedId: string;
    try {
      const kb = new Knowledge(before, options);
      const bytes = Buffer.from('fixture old image');
      const sha = createHash('sha256').update(bytes).digest('hex');
      const blob = sha + '.png';
      writeFileSync(join(blobDir, blob), bytes);
      storedId = (await kb.addRawFile({
        sha256: sha, blob, size: bytes.length, title: 'An older page.png', kind: 'image',
        text: '', meta: { extract: 'pending:ocr' },
      }, 'operator')).id;
    } finally {
      before.close();
    }
    const after = openDatabase(dbFile);
    try {
      const migrated = new Knowledge(after, options);
      assert.equal(migrated.nextMediaJob(false)?.id, storedId);
      assert.equal(migrated.getRaw(storedId, new URLSearchParams()).storedOriginal, true);
    } finally {
      after.close();
    }
  });

  it('defers transient extractor failures and keeps permanent failures out of the queue', async () => {
    let now = new Date('2026-11-25T10:00:00Z');
    const docs = mkdtempSync(join(tmpdir(), 'kb-media-'));
    const { kb } = setup({ documentsDir: docs, now: () => now });
    writeFileSync(join(docs, 'fake.mp4'), 'fixture video');
    const video = await kb.addDocument({ file: 'fake.mp4', text: '' }, 'hermes');
    const job = kb.nextMediaJob(true)!;
    kb.finishMediaJob(job, { status: 'failed', code: 'timeout' });
    assert.equal(kb.getRaw(video.id, new URLSearchParams()).extraction?.status, 'retrying');
    assert.equal(kb.nextMediaJob(true), null);
    now = new Date('2026-11-25T10:05:00Z');
    assert.equal(kb.nextMediaJob(true)?.id, video.id);
    kb.finishMediaJob(job, { status: 'failed', code: 'no_audio' });
    assert.deepEqual(kb.getRaw(video.id, new URLSearchParams()).extraction, { method: 'transcription', status: 'failed', code: 'no_audio' });
    assert.equal(kb.nextMediaJob(true), null);
  });
});

describe('search and recall', () => {
  it('finds facts by keyword even with Korean particles', async () => {
    const { kb } = setup();
    kb.savePage({ title: '헬스', type: 'habit' }, 'hermes');
    kb.addFact({ page: '헬스', text: '월·수·금 아침 7시에 헬스장에 간다' }, 'hermes');
    kb.addRaw({ source: 'chat', kind: 'discord-turn', text: '오늘은 날씨가 좋다' }, 'hermes');
    const hits = await kb.search('헬스를 언제 가?');
    assert.equal(hits[0].page?.title, '헬스');
    assert.ok(hits.every((h) => h.match === 'keyword'));
    const onlyRaw = await kb.search('날씨', { kinds: ['raw'] });
    assert.equal(onlyRaw.length, 1);
    await assert.rejects(kb.search('  '), /q is required/);
  });

  it('adds meaning matches once items are embedded, and recall keeps only clear matches', async () => {
    const embedder = fakeEmbedder();
    const { kb } = setup({ embedder });
    kb.savePage({ title: '헬스', type: 'habit', summary: '헬스' }, 'hermes');
    kb.addFact({ page: '헬스', text: '헬스' }, 'hermes');
    kb.savePage({ title: '빨래', type: 'habit', summary: '세탁기 일요일' }, 'hermes');
    assert.ok((await kb.embedPending(50)) >= 4);
    assert.equal(await kb.embedPending(50), 0);
    const hits = await kb.search('운동');
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].page?.title, '헬스');
    assert.equal(hits[0].match, 'meaning');
    const recall = await kb.recall('운동');
    assert.ok(recall.count >= 1);
    assert.match(recall.text, /헬스/);
    assert.equal((await kb.recall('양자역학 블랙홀')).count, 0);
    assert.equal(kb.stats().embedded, kb.stats().searchItems);
  });

  it('re-embeds an item when its text changes', async () => {
    const { kb } = setup({ embedder: fakeEmbedder() });
    kb.savePage({ title: '목표', type: 'goal', summary: '인턴' }, 'hermes');
    await kb.embedPending(50);
    kb.savePage({ page: '목표', summary: '대학원' }, 'hermes');
    assert.equal(kb.stats().embedded, kb.stats().searchItems - 1);
  });

  it('builds a compact profile for the system prompt', () => {
    const { kb } = setup();
    kb.savePage({ page: 'me', summary: '토론토 UTM 컴퓨터과학 학생. 아침형.' }, 'hermes');
    kb.addFact({ page: 'me', text: '6시에 일어난다' }, 'hermes');
    kb.savePage({ title: 'CSC263', type: 'course' }, 'hermes');
    const p = kb.profile(true) as { text: string; pages: string; pageCount: number };
    assert.match(p.text, /UTM/);
    assert.match(p.text, /6시/);
    assert.equal(p.pages, 'course: CSC263');
    assert.equal(p.pageCount, 1);
  });

  it('always puts every preference into the compact profile, beyond the last 12 owner facts', () => {
    const { kb } = setup();
    kb.addFact({ page: 'preferences', text: '선호: 메일 요약은 마감일을 맨 앞에' }, 'hermes');
    for (let i = 0; i < 20; i++) kb.addFact({ page: 'me', text: `사실 ${i}` }, 'hermes');
    const p = kb.profile(true) as { text: string; pages: string };
    assert.match(p.text, /Owner preferences and feedback/);
    assert.match(p.text, /마감일을 맨 앞에/);
    assert.doesNotMatch(p.text, /사실 0/); // me facts are still capped
    assert.doesNotMatch(p.pages, /취향과 피드백/);
    assert.equal(kb.getPage('피드백').page.slug, 'preferences'); // found by alias too
  });
});

describe('imports and permanent deletion', () => {
  it('registers files an importer put in the blob folder, once per content', async () => {
    const { kb, dir } = setup();
    const bytes = Buffer.from('Chapter 3: conditional probability');
    const sha = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(join(dir, 'blobs', `${sha}.txt`), bytes);
    assert.throws(() => kb.rawBySha(sha), /No stored original/);
    const added = await kb.addRawFile(
      { sha256: sha, blob: `${sha}.txt`, size: bytes.length, title: 'stats-book.txt', path: 'courses/STA/stats-book.txt', kind: 'txt', text: bytes.toString() },
      'operator',
    );
    assert.equal(added.duplicate, false);
    assert.equal(kb.rawBySha(sha).id, added.id);
    assert.equal((await kb.addRawFile({ sha256: sha, blob: `${sha}.txt`, size: bytes.length, title: 'copy.txt', kind: 'txt', text: '' }, 'operator')).duplicate, true);
    assert.equal(kb.getRaw(added.id, new URLSearchParams()).meta.path, 'courses/STA/stats-book.txt');
    const other = createHash('sha256').update('x').digest('hex');
    writeFileSync(join(dir, 'blobs', `${other}.txt`), 'not x');
    await assert.rejects(kb.addRawFile({ sha256: other, blob: `${other}.txt`, size: 5, title: 't', kind: 'txt', text: '' }, 'operator'), /does not match/);
    await assert.rejects(kb.addRawFile({ sha256: other, blob: '../k.db', size: 5, title: 't', kind: 'txt', text: '' }, 'operator'), /blob must be/);
    await assert.rejects(kb.addRawFile({ sha256: other, blob: `${other}.pdf`, size: 5, title: 't', kind: 'pdf', text: '' }, 'operator'), /not in the blob folder/);
  });

  it('purges a fact with its older versions and scrubs the change log', () => {
    const { kb } = setup();
    kb.savePage({ title: '헬스', type: 'habit' }, 'hermes');
    const v1 = kb.addFact({ page: '헬스', text: '비밀 장소에서 운동' }, 'hermes');
    const v2 = kb.changeFact(v1.id, { text: '다른 비밀 장소에서 운동' }, 'hermes');
    const result = kb.purge({ target: 'fact', id: v2.id, reason: '잘못 저장됨' }, 'hermes');
    assert.equal(result.versions, 2);
    assert.equal(kb.getPage('헬스').facts.length, 0);
    const log = JSON.stringify(kb.changes(50));
    assert.ok(!log.includes('비밀 장소'), 'the purged text is gone from the change log');
    assert.ok(kb.changes(5).some((c) => c.action === 'purge' && (c.detail as { reason: string }).reason === '잘못 저장됨'));
  });

  it('purges pages, activities and originals (with the stored file)', async () => {
    const docs = mkdtempSync(join(tmpdir(), 'kb-docs-'));
    writeFileSync(join(docs, 'doc_0123456789ab_private.txt'), 'private notes');
    const { kb, dir } = setup({ documentsDir: docs });
    kb.savePage({ title: '옛 프로젝트', type: 'project' }, 'hermes');
    kb.addFact({ page: '옛 프로젝트', text: '2024년에 함' }, 'hermes');
    const act = kb.addActivity({ title: '옛 프로젝트 회의', pages: ['옛 프로젝트'] }, 'hermes');
    assert.equal(kb.purge({ target: 'page', page: '옛 프로젝트', reason: '필요 없음' }, 'hermes').facts, 1);
    assert.equal(kb.findPage('옛 프로젝트'), undefined);
    assert.deepEqual(kb.timeline(new URLSearchParams()).activities[0].pages, []);
    kb.purge({ target: 'activity', id: act.activity.id, reason: '필요 없음' }, 'hermes');
    assert.equal(kb.timeline(new URLSearchParams()).activities.length, 0);
    assert.throws(() => kb.purge({ target: 'page', page: 'me', reason: 'x' }, 'hermes'), /owner page/);

    const doc = await kb.addDocument({ file: 'doc_0123456789ab_private.txt', text: 'private notes' }, 'hermes');
    kb.savePage({ title: '메모', type: 'other' }, 'hermes');
    const fact = kb.addFact({ page: '메모', text: '메모가 있음', sourceRawId: doc.id }, 'hermes');
    const blobs = join(dir, 'blobs');
    assert.equal(existsSync(join(blobs, `${createHash('sha256').update('private notes').digest('hex')}.txt`)), true);
    const purged = kb.purge({ target: 'raw', id: doc.id, reason: '개인 정보' }, 'hermes');
    assert.equal(purged.fileDeleted, true);
    assert.throws(() => kb.getRaw(doc.id, new URLSearchParams()), /No raw item/);
    assert.equal(kb.getPage('메모').facts[0].id, fact.id, 'facts that cited it stay, without the source');
    assert.equal((await kb.search('private', { kinds: ['raw'] })).length, 0);
    assert.throws(() => kb.purge({ target: 'raw', id: doc.id, reason: 'x' }, 'hermes'), /No raw item/);
    assert.throws(() => kb.purge({ target: 'fact', id: 'x' }, 'hermes'), /reason is required/);
  });

  it('keeps originals immutable outside a purge', () => {
    const { kb, db } = setup();
    const r = kb.addRaw({ source: 'note', kind: 'owner-note', text: 'keep me' }, 'hermes');
    assert.throws(() => db.prepare('DELETE FROM raw_items WHERE id = ?').run(r.id), /immutable/);
  });
});

describe('API', () => {
  const key = 'k'.repeat(40);
  let base = '';
  let close = () => {};
  before(async () => {
    const { kb } = setup();
    const server = createApi(kb, [{ name: 'hermes-broker', key }], { info() {}, warn() {} });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  after(() => close());
  const call = (path: string, init: RequestInit = {}, k: string | null = key) =>
    fetch(base + path, { ...init, headers: { ...(k ? { 'X-Knowledge-Key': k } : {}), 'Content-Type': 'application/json' } });

  it('requires the key and answers the listed routes', async () => {
    assert.equal((await call('/health', {}, null)).status, 200);
    assert.equal((await call('/status', {}, null)).status, 401);
    assert.equal((await call('/status', {}, 'wrong'.repeat(10))).status, 401);
    assert.equal((await call('/nope')).status, 404);
    assert.equal((await call('/pages', { method: 'PUT' })).status, 405);
    const saved = await call('/pages', { method: 'POST', body: JSON.stringify({ title: 'CSC263', type: 'course' }) });
    assert.equal(saved.status, 200);
    const fact = await call('/facts', { method: 'POST', body: JSON.stringify({ page: 'CSC263', text: 'Test 1은 10/15' }) });
    assert.equal(fact.status, 200);
    const page = (await (await call('/page?ref=csc263')).json()) as { facts: Array<{ text: string }> };
    assert.equal(page.facts[0].text, 'Test 1은 10/15');
    const missing = (await (await call('/page?ref=CSC26')).json()) as { code: string; similar: string[] };
    assert.equal(missing.code, 'not_found');
    assert.deepEqual(missing.similar, ['CSC263']);
    const search = (await (await call('/search?q=test&kinds=fact')).json()) as { results: unknown[] };
    assert.equal(search.results.length, 1);
    assert.equal((await call('/search?q=x&kinds=secret')).status, 400);
    assert.equal((await call('/raw', { method: 'POST', body: '[1]' })).status, 400);
    assert.equal((await call('/raw/file', { method: 'POST', body: '{}' })).status, 403, 'imports are operator-only');
    assert.equal((await call(`/raw/by-sha/${'a'.repeat(64)}`)).status, 403);
    const typed = await call('/facts', { method: 'POST', body: JSON.stringify({ page: 'CSC263', text: 'Test 2 12/15', kind: 'score' }) });
    assert.equal(((await typed.json()) as { kind: string }).kind, 'score');
    const badKind = await call('/facts', { method: 'POST', body: JSON.stringify({ page: 'CSC263', text: 'x', kind: 'grade' }) });
    assert.equal(badKind.status, 400);
    const listed = (await (await call('/facts?kind=score')).json()) as { facts: Array<{ text: string; kind: string }>; total: number };
    assert.deepEqual([listed.total, listed.facts[0].text], [1, 'Test 2 12/15']);
    assert.equal((await call('/facts?kind=grade')).status, 400);
    const change = (await (await call('/changes')).json()) as { changes: Array<{ actor: string }> };
    assert.equal(change.changes[0].actor, 'hermes');
  });
});
