import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApi } from './api.js';
import { openDatabase } from './db.js';
import { Knowledge } from './knowledge.js';

type Call = (method: string, path: string, body?: unknown) => Promise<{ ok: boolean; status: number; value: any }>;
type Step = { kind: string; ref: string; skip?: string; body?: Record<string, unknown> };
// The operator script (plain .mjs next to the service, run with node); loaded from dist/../scripts.
const script = (await import(new URL('../scripts/english-apply.mjs', import.meta.url).href)) as {
  parseArgs(argv: string[]): { file: string; apply: boolean; only: string | null; max: number };
  approved(doc: unknown, item: unknown): boolean;
  plan(doc: unknown, read: unknown, opts?: { only?: string }): Promise<Step[]>;
  reader(call: Call): unknown;
  applySteps(steps: Step[], call: Call): Promise<Array<{ ok: boolean; status: number }>>;
};

describe('english-apply (approved rename list through the normal API)', () => {
  const key = 'o'.repeat(40);
  let base = '';
  let close = () => {};
  let kb: Knowledge;
  const ids: Record<string, string> = {};
  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kb-en-'));
    kb = new Knowledge(openDatabase(join(dir, 'k.db')), { timeZone: 'America/Toronto', blobDir: join(dir, 'blobs'), documentsDir: null, embedder: null, now: () => new Date('2026-11-26T15:00:00Z') });
    kb.savePage({ title: '고유값과 대각화', type: 'topic', summary: '특성다항식의 근이 고유값', aliases: ['eigenvalues'] }, 'hermes');
    kb.savePage({ title: '용환이 형', type: 'person', summary: '이력서를 봐 주기로 한 형' }, 'hermes');
    ids.mistake = kb.addFact({ page: '고유값과 대각화', text: 'Test 1 5(c) 근거가 틀려 0/2.5', kind: 'mistake', observedOn: '2026-10-15' }, 'hermes').id;
    ids.moved = kb.addFact({ page: '고유값과 대각화', text: '옛 문장' }, 'hermes').id;
    const server = createApi(kb, [{ name: 'operator', key }], { info() {}, warn() {} });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  after(() => close());

  const call: Call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'X-Knowledge-Key': key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { ok: res.ok, status: res.status, value: await res.json() };
  };
  const doc = () => ({
    reason: 'Stored text in English (owner decision 2026-11-26)',
    approveAll: false,
    pages: [
      { slug: '고유값과-대각화', before: { title: '고유값과 대각화', summary: '특성다항식의 근이 고유값' }, after: { title: 'Eigenvalues and Diagonalization', summary: 'Eigenvalues are the roots of the characteristic polynomial' }, addAliases: ['고유값과 대각화'], approved: true },
      { slug: '용환이-형', before: { title: '용환이 형', summary: '이력서를 봐 주기로 한 형' }, after: { summary: 'An older friend who agreed to review the résumé' }, addAliases: ['Yonghwan'], approved: null },
    ],
    facts: [
      { id: ids.mistake, before: 'Test 1 5(c) 근거가 틀려 0/2.5', after: 'Test 1 5(c): wrong justification, 0/2.5', approved: true },
      { id: ids.moved, before: '다른 문장', after: 'Old sentence', approved: true },   // changed since the proposal
    ],
    activities: [],
  });

  it('parses arguments with a dry run by default', () => {
    assert.deepEqual(script.parseArgs(['p.json']), { file: 'p.json', apply: false, only: null, max: Infinity });
    assert.equal(script.parseArgs(['p.json', '--apply', '--only', 'facts']).apply, true);
    assert.throws(() => script.parseArgs([]), /proposal/);
    assert.throws(() => script.parseArgs(['p.json', '--only', 'raw']), /--only/);
    assert.equal(script.approved({ approveAll: true }, { approved: null }), true);
    assert.equal(script.approved({ approveAll: true }, { approved: false }), false);
    assert.equal(script.approved({ approveAll: false }, { approved: null }), false);
  });

  it('plans only approved, unchanged items and applies them with history kept', async () => {
    const before = kb.changes(200).length;
    const steps = await script.plan(doc(), script.reader(call));
    assert.deepEqual(steps.map((s) => [s.kind, s.skip ?? 'do']), [['page', 'do'], ['page', 'not approved'], ['fact', 'do'], ['fact', 'text changed since the proposal']]);
    assert.equal(kb.changes(200).length, before, 'planning changes nothing');
    const results = await script.applySteps(steps.filter((s) => !s.skip), call);
    assert.ok(results.every((r) => r.ok && r.status === 200));

    const page = kb.getPage('고유값과-대각화');
    assert.equal(page.page.slug, '고유값과-대각화');                    // slug kept
    assert.equal(page.page.title, 'Eigenvalues and Diagonalization');
    assert.deepEqual(page.page.aliases, ['eigenvalues', '고유값과 대각화']);  // old title is an alias
    assert.equal(kb.findPage('고유값과 대각화')?.slug, '고유값과-대각화');
    const fact = page.facts.find((f) => f.text.startsWith('Test 1'))!;
    assert.deepEqual([fact.text, fact.kind, fact.observedOn], ['Test 1 5(c): wrong justification, 0/2.5', 'mistake', '2026-10-15']);
    assert.equal(kb.factDetail(ids.mistake).status, 'superseded');      // the Korean fact stays in history
    const logged = kb.changes(200).slice(0, kb.changes(200).length - before);
    assert.deepEqual(logged.map((c) => [c.actor, c.action]).sort(), [['operator', 'supersede'], ['operator', 'update']]);
    assert.ok(logged.every((c) => /owner decision 2026-11-26/.test(JSON.stringify(c.detail))));

    const again = await script.plan(doc(), script.reader(call));                  // idempotent
    assert.deepEqual(again.map((s) => s.skip), ['already done', 'not approved', 'fact is superseded', 'text changed since the proposal']);
  });

  it('refuses a new title that already names another page', async () => {
    kb.savePage({ title: 'Linear Algebra', type: 'course' }, 'hermes');
    const steps = await script.plan({ approveAll: true, pages: [{ slug: '용환이-형', before: { title: '용환이 형' }, after: { title: 'Linear Algebra' } }] }, script.reader(call));
    assert.match(steps[0].skip ?? '', /already names linear-algebra/);
  });
});
