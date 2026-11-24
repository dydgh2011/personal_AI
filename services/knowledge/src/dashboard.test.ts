import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { createApi } from './api.js';
import { parseClients } from './clients.js';
import { openDatabase } from './db.js';
import { Knowledge } from './knowledge.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'kb-dash-'));
  const db = openDatabase(join(dir, 'k.db'));
  let clock = new Date('2026-11-22T15:00:00Z');
  const kb = new Knowledge(db, { timeZone: 'America/Toronto', blobDir: join(dir, 'blobs'), documentsDir: null, embedder: null, now: () => clock });
  return { kb, db, dir, tick: (ms = 1000) => (clock = new Date(clock.getTime() + ms)) };
}

/** A small store: a course with facts, a topic linked to it, an activity on both. */
function seed() {
  const s = setup();
  const { kb, tick } = s;
  kb.savePage({ title: 'CSC263', type: 'course', aliases: ['자료구조'] }, 'hermes');
  tick();
  kb.savePage({ title: 'Heaps', type: 'topic' }, 'hermes');
  tick();
  const score = kb.addFact({ page: 'CSC263', text: 'Term Test 1: 10/15', kind: 'score' }, 'hermes');
  tick();
  const exam = kb.addFact({ page: 'CSC263', text: '기말 2026-12-16 09:00', kind: 'exam' }, 'hermes');
  tick();
  const long = kb.addFact({ page: 'Heaps', text: `heap ${'x'.repeat(400)}` }, 'hermes');
  kb.link({ from: 'Heaps', to: 'CSC263', relation: 'part_of' }, 'hermes');
  kb.addActivity({ kind: 'study', title: 'heap 복습', pages: ['CSC263', 'Heaps'] }, 'hermes');
  return { ...s, score: score.id, exam: exam.id, long: long.id };
}

function lastChange(db: DatabaseSync) {
  const r = db.prepare('SELECT actor, action, entity, entity_id, detail FROM change_log ORDER BY id DESC LIMIT 1').get() as {
    actor: string;
    action: string;
    entity: string;
    entity_id: string | null;
    detail: string;
  };
  return { ...r, detail: JSON.parse(r.detail) as Record<string, unknown> };
}

const changeCount = (db: DatabaseSync) => (db.prepare('SELECT count(*) AS n FROM change_log').get() as { n: number }).n;

describe('graph view', () => {
  it('returns pages with names and counts, links and done-together edges; facts only on request', () => {
    const { kb } = seed();
    const g = kb.graphView(new URLSearchParams());
    assert.equal(g.pages[0].slug, 'me', 'the owner page comes first');
    const course = g.pages.find((p) => p.slug === 'csc263')!;
    assert.deepEqual(
      { title: course.title, type: course.type, aliases: course.aliases, archived: course.archived, counts: course.counts },
      { title: 'CSC263', type: 'course', aliases: ['자료구조'], archived: false, counts: { facts: 2, archivedFacts: 0, activities: 1 } },
    );
    assert.match(course.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(g.links, [{ source: 'heaps', target: 'csc263', relation: 'part_of', note: null }]);
    assert.deepEqual(g.doneTogether.map((e) => [e.source, e.target].sort().concat(String(e.weight))), [['csc263', 'heaps', '1']]);
    assert.equal('facts' in g, false, 'facts are left out by default');
    assert.deepEqual(g.totals, { pages: 4 });
    assert.deepEqual(g.truncated, { pages: false, facts: false, doneTogether: false });
    assert.ok(g.vocab.factKinds.includes('score') && g.vocab.pageTypes.includes('course'));

    const withFacts = kb.graphView(new URLSearchParams({ facts: '1' }));
    assert.equal(withFacts.facts!.length, 3);
    const exam = withFacts.facts!.find((f) => f.kind === 'exam')!;
    assert.deepEqual({ page: exam.page, text: exam.text, status: exam.status, clipped: exam.clipped }, { page: 'csc263', text: '기말 2026-12-16 09:00', status: 'active', clipped: false });
    const long = withFacts.facts!.find((f) => f.page === 'heaps')!;
    assert.equal((long.text as string).length, 200, 'long facts come as a 200-character excerpt');
    assert.equal(long.clipped, true);
    assert.equal(withFacts.totals.facts, 3);
  });

  it('leaves archived pages and facts out unless archived=1, and keeps superseded versions out always', () => {
    const { kb, score, exam } = seed();
    kb.editFact(score, { text: 'Term Test 1: 11/15 (regrade)', reason: 'regrade' }, 'dashboard');
    kb.setFactArchived(exam, { archived: true, reason: 'wrong date' }, 'dashboard');
    kb.editPage({ page: 'heaps', archived: true, reason: 'merged into course page' }, 'dashboard');
    const live = kb.graphView(new URLSearchParams({ facts: '1' }));
    assert.deepEqual(live.pages.map((p) => p.slug).sort(), ['csc263', 'me', 'preferences']);
    assert.deepEqual(live.facts!.map((f) => f.text), ['Term Test 1: 11/15 (regrade)']);
    assert.deepEqual(live.links, [], 'links to archived pages are hidden');
    const all = kb.graphView(new URLSearchParams({ facts: '1', archived: '1' }));
    assert.equal(all.pages.find((p) => p.slug === 'heaps')!.archived, true);
    assert.deepEqual(all.facts!.map((f) => `${f.status}:${(f.text as string).slice(0, 10)}`).sort(), ['active:Term Test ', 'active:heap xxxxx', 'removed:기말 2026-12']);
    assert.equal(all.pages.find((p) => p.slug === 'csc263')!.counts.archivedFacts, 1);
    assert.equal(all.links.length, 1);
  });

  it('is bounded and checks its parameters', () => {
    const { kb } = seed();
    const g = kb.graphView(new URLSearchParams({ facts: '1', maxPages: '3', maxFacts: '1' }));
    assert.deepEqual(g.pages.map((p) => p.slug), ['me', 'heaps', 'csc263'], 'the owner page, then the most recently changed');
    assert.deepEqual(g.truncated, { pages: true, facts: true, doneTogether: false });
    assert.deepEqual(g.totals, { pages: 4, facts: 3 });
    assert.equal(g.facts!.length, 1);
    const two = kb.graphView(new URLSearchParams({ facts: '1', maxPages: '2' }));
    assert.deepEqual(two.pages.map((p) => p.slug), ['me', 'heaps']);
    assert.deepEqual(two.facts!.map((f) => f.page), ['heaps'], 'facts only of the included pages');
    assert.deepEqual(two.links, [], 'links only between included pages');
    assert.deepEqual(kb.graphView(new URLSearchParams({ type: 'course' })).pages.map((p) => p.slug), ['csc263']);
    for (const q of [{ facts: 'yes' }, { maxPages: '0' }, { maxPages: '2001' }, { maxFacts: '5001' }, { type: 'secret' }, { limit: '5' }] as Array<Record<string, string>>) {
      assert.throws(() => kb.graphView(new URLSearchParams(q)), /must be|Unexpected/, JSON.stringify(q));
    }
  });
});

describe('dashboard edits', () => {
  it('changes a fact text (new version, old kept) and its kind, logged with actor and reason', () => {
    const { kb, db, score } = seed();
    const r = kb.editFact(score, { text: 'Term Test 1: 11/15', reason: 'regrade' }, 'dashboard');
    assert.equal(r.changed, true);
    assert.equal(r.replaced, score);
    assert.notEqual(r.fact.id, score);
    assert.deepEqual([r.fact.text, r.fact.kind, r.fact.observedOn, r.fact.createdBy], ['Term Test 1: 11/15', 'score', '2026-11-22', 'dashboard']);
    assert.equal(kb.factDetail(score).status, 'superseded');
    assert.equal(kb.factDetail(score).supersededBy, r.fact.id);
    let c = lastChange(db);
    assert.deepEqual([c.actor, c.action, c.entity, c.entity_id, c.detail.reason, c.detail.after], ['dashboard', 'supersede', 'fact', score, 'regrade', 'Term Test 1: 11/15']);

    const k = kb.editFact(r.fact.id, { kind: 'mistake', reason: 'it is a lost point' }, 'dashboard');
    assert.deepEqual([k.changed, k.fact.id, k.fact.kind], [true, r.fact.id, 'mistake']);
    c = lastChange(db);
    assert.deepEqual([c.actor, c.action, c.detail.before, c.detail.after, c.detail.reason], ['dashboard', 'retype', 'score', 'mistake', 'it is a lost point']);

    const cleared = kb.editFact(r.fact.id, { kind: null, reason: 'untyped' }, 'dashboard');
    assert.equal(cleared.fact.kind, null);
    const before = changeCount(db);
    assert.equal(kb.editFact(r.fact.id, { text: 'Term Test 1: 11/15', reason: 'same' }, 'dashboard').changed, false);
    assert.equal(changeCount(db), before, 'no-op edits are not logged');
  });

  it('archives and unarchives a fact (never deletes it)', () => {
    const { kb, db, exam } = seed();
    const a = kb.setFactArchived(exam, { archived: true, reason: 'wrong date' }, 'dashboard');
    assert.deepEqual([a.changed, a.fact.status], [true, 'removed']);
    let c = lastChange(db);
    assert.deepEqual([c.actor, c.action, c.entity_id, c.detail.reason], ['dashboard', 'remove', exam, 'wrong date']);
    assert.equal(kb.getPage('csc263').facts.length, 1, 'archived facts leave answers');
    assert.equal(kb.setFactArchived(exam, { archived: true, reason: 'again' }, 'dashboard').changed, false);

    const u = kb.setFactArchived(exam, { archived: false, reason: 'date was right' }, 'dashboard');
    assert.deepEqual([u.changed, u.fact.status], [true, 'active']);
    c = lastChange(db);
    assert.deepEqual([c.actor, c.action, c.entity, c.entity_id, c.detail.reason], ['dashboard', 'restore', 'fact', exam, 'date was right']);
    assert.equal(kb.getPage('csc263').facts.length, 2);
    assert.ok(db.prepare("SELECT 1 FROM search_items WHERE kind = 'fact' AND ref_id = ?").get(exam), 'restored facts are searchable again');
    assert.equal((db.prepare('SELECT count(*) AS n FROM facts').get() as { n: number }).n, 3, 'nothing was deleted');
  });

  it('changes page title and aliases, archives and unarchives a page', () => {
    const { kb, db } = seed();
    const r = kb.editPage({ page: 'csc263', title: 'CSC263 Data Structures', aliases: ['자료구조', 'DS'], reason: 'full name' }, 'dashboard');
    assert.deepEqual([r.changed, r.page.slug, r.page.title, r.page.aliases], [true, 'csc263', 'CSC263 Data Structures', ['자료구조', 'DS']]);
    let c = lastChange(db);
    assert.deepEqual([c.actor, c.action, c.entity, c.detail.reason], ['dashboard', 'update', 'page', 'full name']);
    assert.equal(kb.findPage('DS')?.slug, 'csc263');
    assert.equal(kb.editPage({ page: 'csc263', title: 'CSC263 Data Structures', reason: 'same' }, 'dashboard').changed, false);

    const archived = kb.editPage({ page: 'heaps', archived: true, reason: 'merged' }, 'dashboard');
    assert.equal(archived.page.archived, true);
    c = lastChange(db);
    assert.deepEqual([c.actor, (c.detail.after as { archived: number }).archived, c.detail.reason], ['dashboard', 1, 'merged']);
    assert.equal(kb.editPage({ page: 'heaps', archived: false, reason: 'needed after all' }, 'dashboard').page.archived, false);
  });

  it('adds and removes links', () => {
    const { kb, db } = seed();
    const added = kb.editLink({ from: 'csc263', to: 'heaps', relation: 'uses', note: 'week 3', reason: 'course covers heaps' }, 'dashboard');
    assert.deepEqual(added, { changed: true, link: { source: 'csc263', target: 'heaps', relation: 'uses' } });
    let c = lastChange(db);
    assert.deepEqual([c.actor, c.action, c.entity, c.detail.from, c.detail.to, c.detail.note, c.detail.reason], ['dashboard', 'link', 'link', 'csc263', 'heaps', 'week 3', 'course covers heaps']);
    assert.equal(kb.editLink({ from: 'csc263', to: 'heaps', relation: 'uses', reason: 'again' }, 'dashboard').changed, false);
    const removed = kb.editLink({ from: 'heaps', to: 'csc263', relation: 'part_of', remove: true, reason: 'wrong direction' }, 'dashboard');
    assert.deepEqual(removed, { changed: true, removed: true });
    c = lastChange(db);
    assert.deepEqual([c.actor, c.action, c.detail.relation, c.detail.reason], ['dashboard', 'unlink', 'part_of', 'wrong direction']);
    assert.throws(() => kb.editLink({ from: 'heaps', to: 'csc263', relation: 'part_of', remove: true, reason: 'x' }, 'dashboard'), /No such link/);
  });

  it('validates every edit', () => {
    const { kb, db, score, exam } = seed();
    const before = changeCount(db);
    const t = (fn: () => unknown, re: RegExp) => assert.throws(fn, re);
    // a reason is required everywhere
    t(() => kb.editFact(score, { kind: 'exam' }, 'dashboard'), /reason is required/);
    t(() => kb.setFactArchived(score, { archived: true }, 'dashboard'), /reason is required/);
    t(() => kb.editPage({ page: 'csc263', title: 'X' }, 'dashboard'), /reason is required/);
    t(() => kb.editLink({ from: 'csc263', to: 'heaps', relation: 'uses' }, 'dashboard'), /reason is required/);
    t(() => kb.editFact(score, { kind: 'exam', reason: ' ' }, 'dashboard'), /reason/);
    t(() => kb.editFact(score, { kind: 'exam', reason: 'r'.repeat(301) }, 'dashboard'), /longer than 300/);
    // facts
    t(() => kb.editFact(score, { reason: 'r' }, 'dashboard'), /Nothing to change/);
    t(() => kb.editFact(score, { kind: 'grade', reason: 'r' }, 'dashboard'), /kind must be one of/);
    t(() => kb.editFact(score, { text: '', reason: 'r' }, 'dashboard'), /Nothing to change|text/);
    t(() => kb.editFact(score, { text: 'x'.repeat(1001), reason: 'r' }, 'dashboard'), /longer than 1000/);
    t(() => kb.editFact(score, { text: '기말 2026-12-16 09:00', reason: 'r' }, 'dashboard'), /already has an active fact/);
    t(() => kb.editFact(score, { kind: 'exam', status: 'active', reason: 'r' }, 'dashboard'), /Unexpected fields: status/);
    t(() => kb.editFact('00000000-0000-4000-8000-000000000000', { kind: 'exam', reason: 'r' }, 'dashboard'), /No fact/);
    t(() => kb.setFactArchived(score, { archived: 'yes', reason: 'r' }, 'dashboard'), /archived must be true or false/);
    // pages: named by slug only, never created, names stay unambiguous, owner pages stay
    t(() => kb.editPage({ page: 'CSC263', title: 'X', reason: 'r' }, 'dashboard'), /No page with slug/);
    t(() => kb.editPage({ page: 'new-page', title: 'New', reason: 'r' }, 'dashboard'), /No page with slug/);
    t(() => kb.editPage({ page: 'heaps', title: 'CSC263', reason: 'r' }, 'dashboard'), /already names the page/);
    t(() => kb.editPage({ page: 'heaps', aliases: ['자료구조'], reason: 'r' }, 'dashboard'), /already names the page/);
    t(() => kb.editPage({ page: 'me', archived: true, reason: 'r' }, 'dashboard'), /cannot be archived/);
    t(() => kb.editPage({ page: 'preferences', archived: true, reason: 'r' }, 'dashboard'), /cannot be archived/);
    t(() => kb.editPage({ page: 'heaps', type: 'course', reason: 'r' }, 'dashboard'), /Unexpected fields: type/);
    t(() => kb.editPage({ page: 'heaps', reason: 'r' }, 'dashboard'), /Nothing to change/);
    t(() => kb.editPage({ page: 'heaps', aliases: 'heap', reason: 'r' }, 'dashboard'), /aliases must be a list/);
    // links
    t(() => kb.editLink({ from: 'csc263', to: 'Heaps', relation: 'uses', reason: 'r' }, 'dashboard'), /No page with slug/);
    t(() => kb.editLink({ from: 'csc263', to: 'csc263', relation: 'uses', reason: 'r' }, 'dashboard'), /cannot link to itself/);
    t(() => kb.editLink({ from: 'csc263', to: 'heaps', relation: 'Uses Heaps', reason: 'r' }, 'dashboard'), /relation must be/);
    t(() => kb.editLink({ from: 'csc263', to: 'heaps', relation: 'done_together', reason: 'r' }, 'dashboard'), /computed/);
    t(() => kb.editLink({ from: 'csc263', to: 'heaps', reason: 'r' }, 'dashboard'), /relation is required/);
    assert.equal(changeCount(db), before, 'refused edits change nothing');
    // superseded and archived facts are not edited in place
    const r = kb.editFact(score, { text: 'Term Test 1: 12/15', reason: 'regrade' }, 'dashboard');
    t(() => kb.editFact(score, { kind: 'exam', reason: 'r' }, 'dashboard'), /replaced by a newer version/);
    t(() => kb.setFactArchived(score, { archived: true, reason: 'r' }, 'dashboard'), /replaced by a newer version/);
    kb.setFactArchived(exam, { archived: true, reason: 'r' }, 'dashboard');
    t(() => kb.editFact(exam, { kind: 'deadline', reason: 'r' }, 'dashboard'), /archived; unarchive/);
    kb.addFact({ page: 'csc263', text: '기말 2026-12-16 09:00' }, 'hermes');
    t(() => kb.setFactArchived(exam, { archived: false, reason: 'r' }, 'dashboard'), /already has an active fact/);
    assert.equal(kb.factDetail(r.fact.id).status, 'active');
  });
});

describe('API clients', () => {
  const keys = { broker: 'b'.repeat(40), dashboard: 'd'.repeat(40), school: 's'.repeat(40), operator: 'o'.repeat(40) };
  let base = '';
  let close = () => {};
  let ids: { score: string; exam: string } = { score: '', exam: '' };
  let db: DatabaseSync;
  before(async () => {
    const s = seed();
    ids = { score: s.score, exam: s.exam };
    db = s.db;
    const server = createApi(
      s.kb,
      [
        { name: 'hermes-broker', key: keys.broker },
        { name: 'dashboard', key: keys.dashboard },
        { name: 'school', key: keys.school },
        { name: 'operator', key: keys.operator },
      ],
      { info() {}, warn() {} },
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  after(() => close());
  const call = (key: string, path: string, body?: unknown) =>
    fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Knowledge-Key': key, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
  const sha = 'a'.repeat(64);
  const uuid = '00000000-0000-4000-8000-000000000000';

  it('lets the dashboard read the graph, a page and a fact, and edit through /edit/*', async () => {
    const g = (await (await call(keys.dashboard, '/graph/view?facts=1')).json()) as { pages: Array<{ slug: string }>; facts: Array<{ id: string; text: string }> };
    assert.ok(g.pages.some((p) => p.slug === 'csc263'));
    assert.equal(g.facts.length, 3);
    assert.equal((await call(keys.dashboard, '/graph/view?bogus=1')).status, 400);
    assert.equal((await call(keys.dashboard, '/page?ref=csc263')).status, 200);
    const fact = (await (await call(keys.dashboard, `/facts/${ids.score}`)).json()) as { text: string; status: string };
    assert.deepEqual([fact.text, fact.status], ['Term Test 1: 10/15', 'active']);
    assert.equal((await call(keys.dashboard, `/facts/${uuid}`)).status, 404);
    assert.equal((await call(keys.dashboard, '/status')).status, 200);

    const edit = await call(keys.dashboard, `/edit/facts/${ids.score}`, { kind: 'mistake', reason: 'lost point' });
    assert.equal(edit.status, 200);
    assert.deepEqual([lastChange(db).actor, lastChange(db).action, lastChange(db).detail.reason], ['dashboard', 'retype', 'lost point']);
    const archive = await call(keys.dashboard, `/edit/facts/${ids.exam}/archive`, { archived: true, reason: 'wrong' });
    assert.equal(((await archive.json()) as { fact: { status: string } }).fact.status, 'removed');
    assert.equal((await call(keys.dashboard, `/edit/facts/${ids.exam}/archive`, { archived: false, reason: 'right after all' })).status, 200);
    assert.equal(lastChange(db).action, 'restore');
    const page = await call(keys.dashboard, '/edit/pages', { page: 'heaps', aliases: ['힙'], reason: 'Korean name' });
    assert.deepEqual(((await page.json()) as { page: { aliases: string[] } }).page.aliases, ['힙']);
    assert.equal((await call(keys.dashboard, '/edit/links', { from: 'csc263', to: 'heaps', relation: 'uses', reason: 'covers' })).status, 200);
    assert.equal(lastChange(db).actor, 'dashboard');
    // validation errors come back as 4xx with a message
    const missing = await call(keys.dashboard, '/edit/pages', { page: 'heaps', title: 'Heap' });
    assert.equal(missing.status, 400);
    assert.match(((await missing.json()) as { message: string }).message, /reason is required/);
    assert.equal((await call(keys.dashboard, '/edit/pages', { page: 'heaps', title: 'CSC263', reason: 'r' })).status, 409);
    assert.equal((await call(keys.dashboard, '/edit/pages', { page: 'nope', title: 'x', reason: 'r' })).status, 404);
    assert.equal((await call(keys.dashboard, '/edit/links', `{"reason":"${'x'.repeat(70 * 1024)}"}`)).status, 413, 'dashboard bodies are small');
  });

  it('refuses the dashboard on raw, search, purge, import, operator and general write routes', async () => {
    const before = changeCount(db);
    const refused: Array<[string, unknown?]> = [
      ['/purge', { target: 'fact', id: ids.score, reason: 'x' }],
      ['/raw', { source: 'note', kind: 'owner-note', text: 'x' }],
      ['/raw'],
      [`/raw/${uuid}`],
      ['/raw/document', { file: 'a.pdf' }],
      ['/raw/file', {}],
      [`/raw/by-sha/${sha}`],
      ['/search?q=heap'],
      ['/recall?q=heap'],
      ['/timeline'],
      ['/profile'],
      ['/changes'],
      ['/graph'],
      ['/pages'],
      ['/pages', { title: 'New', type: 'topic' }],
      ['/facts'],
      ['/facts', { page: 'csc263', text: 'x' }],
      [`/facts/${ids.score}`, { remove: true }],
      ['/links', { from: 'csc263', to: 'heaps' }],
      ['/activities', { title: 'x' }],
    ];
    for (const [path, body] of refused) {
      const res = await call(keys.dashboard, path, body);
      assert.equal(res.status, 403, `${body === undefined ? 'GET' : 'POST'} ${path}`);
    }
    assert.equal(changeCount(db), before);
  });

  it('keeps the edit routes for the dashboard only, and other clients as they were', async () => {
    for (const key of [keys.broker, keys.operator, keys.school]) {
      assert.equal((await call(key, `/edit/facts/${ids.score}`, { kind: 'exam', reason: 'r' })).status, 403);
      assert.equal((await call(key, '/edit/pages', { page: 'heaps', title: 'X', reason: 'r' })).status, 403);
      assert.equal((await call(key, '/edit/links', { from: 'csc263', to: 'heaps', relation: 'uses', reason: 'r' })).status, 403);
    }
    // hermes-broker: unchanged (general routes, purge allowed; imports operator-only)
    assert.equal((await call(keys.broker, '/search?q=heap')).status, 200);
    assert.equal((await call(keys.broker, '/graph')).status, 200);
    assert.equal((await call(keys.broker, '/graph/view')).status, 200);
    assert.equal((await call(keys.broker, '/raw/file', {})).status, 403);
    const added = (await (await call(keys.broker, '/facts', { page: 'heaps', text: 'min-heap 정의' })).json()) as { id: string };
    assert.equal(lastChange(db).actor, 'hermes');
    assert.equal((await call(keys.broker, '/purge', { target: 'fact', id: added.id, reason: 'test' })).status, 200);
    // school: status and adding originals only
    assert.equal((await call(keys.school, '/status')).status, 200);
    assert.equal((await call(keys.school, '/raw', { source: 'school', kind: 'notice', text: 'x' })).status, 200);
    assert.equal((await call(keys.school, '/pages')).status, 403);
    assert.equal((await call(keys.school, '/graph/view')).status, 403);
    // operator: imports still allowed
    assert.equal((await call(keys.operator, `/raw/by-sha/${sha}`)).status, 404);
    assert.equal((await call(keys.operator, '/changes')).status, 200);
  });
});

describe('client keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-keys-'));
  const file = (name: string, value: string) => {
    const p = join(dir, name);
    writeFileSync(p, value);
    return p;
  };
  it('reads every client list and leaves out an optional client whose key file is missing', () => {
    const broker = file('broker', 'b'.repeat(40));
    const school = file('school', 's'.repeat(40));
    const { clients, skipped } = parseClients({
      KNOWLEDGE_CLIENTS: `hermes-broker=${broker}`,
      KNOWLEDGE_CLIENTS_SCHOOL: `school=${school}`,
      KNOWLEDGE_CLIENTS_DASHBOARD: `dashboard?=${join(dir, 'missing')}`,
      OTHER: 'x',
    });
    assert.deepEqual(clients.map((c) => c.name), ['hermes-broker', 'school']);
    assert.equal(clients[0].key, 'b'.repeat(40));
    assert.deepEqual(skipped.map((s) => s.name), ['dashboard']);
    assert.doesNotMatch(JSON.stringify(skipped), /bbbb|ssss/, 'no key in the warning');
    const dash = file('dash', `${'d'.repeat(40)}\n`);
    assert.deepEqual(parseClients({ KNOWLEDGE_CLIENTS: `hermes-broker=${broker}`, KNOWLEDGE_CLIENTS_DASHBOARD: `dashboard?=${dash}` }).clients.map((c) => c.name), [
      'hermes-broker',
      'dashboard',
    ]);
  });
  it('still stops on a missing required key, a short optional key or a bad entry', () => {
    assert.throws(() => parseClients({ KNOWLEDGE_CLIENTS: `hermes-broker=${join(dir, 'missing')}` }), /Cannot read the key for hermes-broker/);
    assert.throws(() => parseClients({ KNOWLEDGE_CLIENTS: `dashboard?=${file('short', 'abc')}` }), /at least 32 characters/);
    assert.throws(() => parseClients({ KNOWLEDGE_CLIENTS: 'Bad Name=/x' }), /Invalid KNOWLEDGE_CLIENTS entry/);
    assert.throws(() => parseClients({ KNOWLEDGE_CLIENTS: `dashboard?=${join(dir, 'missing')}` }), /at least one caller/);
  });
});
