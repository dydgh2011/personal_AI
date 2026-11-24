import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  aliasesFromInput,
  knowledgeHref,
  nodeIdOf,
  parseSelection,
  safeReturn,
  searchNodes,
  toElements,
  type GraphView,
} from '@/lib/knowledge-graph';
import { MODULES } from '@/modules/registry';

const FACT = '0f6bcedf-922e-4889-aed2-f03384198482';

function view(): GraphView {
  return {
    include: { facts: true, archived: false, type: null },
    pages: [
      { id: '1', slug: 'me', title: '나', type: 'me', aliases: [], archived: false, counts: { facts: 4, archivedFacts: 0, activities: 0 }, updatedAt: '' },
      { id: '2', slug: 'sta256', title: 'STA256', type: 'course', aliases: ['통계'], archived: false, counts: { facts: 16, archivedFacts: 1, activities: 2 }, updatedAt: '' },
      { id: '3', slug: '정규분포-표준화', title: '정규분포 표준화', type: 'topic', aliases: [], archived: true, counts: { facts: 0, archivedFacts: 0, activities: 0 }, updatedAt: '' },
    ],
    facts: [
      { id: FACT, page: 'sta256', text: 'Term Test 1 (2026-10-17): 17/25, Q3(c) 변환 실수', clipped: false, kind: 'mistake', status: 'active', observedOn: null, updatedAt: '' },
      { id: 'x', page: 'missing-page', text: 'orphan', clipped: false, kind: null, status: 'active', observedOn: null, updatedAt: '' },
    ],
    links: [
      { source: 'sta256', target: '정규분포-표준화', relation: 'covers', note: null },
      { source: 'sta256', target: 'gone', relation: 'covers', note: null },
    ],
    doneTogether: [{ source: 'me', target: 'sta256', weight: 3 }],
    totals: { pages: 3, facts: 2 },
    truncated: { pages: false, facts: false, doneTogether: false },
    vocab: { pageTypes: ['me', 'course', 'topic'], factKinds: ['score', 'mistake'] },
  };
}

describe('knowledge graph helpers', () => {
  it('selection lives in the URL and is validated', () => {
    expect(parseSelection('page:sta256')).toEqual({ kind: 'page', slug: 'sta256' });
    expect(parseSelection('page:정규분포-표준화')).toEqual({ kind: 'page', slug: '정규분포-표준화' });
    expect(parseSelection(`fact:${FACT}`)).toEqual({ kind: 'fact', id: FACT });
    expect(parseSelection('fact:not-a-uuid')).toBeNull();
    expect(parseSelection('page:../etc')).toBeNull();
    expect(parseSelection('raw:abc')).toBeNull();
    expect(parseSelection(undefined)).toBeNull();
    expect(nodeIdOf({ kind: 'fact', id: FACT })).toBe(`f:${FACT}`);
  });

  it('builds page links that keep the view options', () => {
    expect(knowledgeHref({ facts: false, archived: false })).toBe('/knowledge');
    expect(knowledgeHref({ facts: true, archived: true, sel: { kind: 'page', slug: 'sta256' } })).toBe('/knowledge?facts=1&archived=1&sel=page%3Asta256');
  });

  it('accepts only same-page return paths', () => {
    expect(safeReturn('/knowledge?facts=1&sel=page%3Asta256')).toBe('/knowledge?facts=1&sel=page%3Asta256');
    expect(safeReturn('https://evil.example/knowledge')).toBe('/knowledge');
    expect(safeReturn('//evil.example')).toBe('/knowledge');
    expect(safeReturn('/tasks')).toBe('/knowledge');
    expect(safeReturn('/knowledge\\..')).toBe('/knowledge');
    expect(safeReturn(null)).toBe('/knowledge');
  });

  it('turns the view into graph elements, dropping dangling ones', () => {
    const els = toElements(view());
    const ids = els.map((e) => String(e.data.id));
    expect(ids).toContain('p:sta256');
    expect(ids).toContain(`f:${FACT}`);
    expect(ids).toContain(`pf:${FACT}`);
    expect(ids).toContain('l:sta256>정규분포-표준화:covers');
    expect(ids).toContain('t:me|sta256');
    expect(ids).not.toContain('f:x'); // its page is not in the view
    expect(ids.some((id) => id.includes('gone'))).toBe(false);
    const sta = els.find((e) => e.data.id === 'p:sta256')!;
    expect(sta.classes).toBe('page t-course');
    expect(Number(sta.data.size)).toBeGreaterThan(Number(els.find((e) => e.data.id === 'p:me')!.data.size));
    expect(els.find((e) => e.data.id === 'p:정규분포-표준화')!.classes).toContain('archived');
    expect(els.find((e) => e.data.id === `f:${FACT}`)!.classes).toBe('fact k-mistake');
  });

  it('searches titles, aliases and fact text', () => {
    const els = toElements(view());
    expect([...searchNodes(els, '통계')]).toEqual(['p:sta256']);
    expect([...searchNodes(els, '변환 실수')]).toEqual([`f:${FACT}`]);
    expect(searchNodes(els, '  ').size).toBe(0);
  });

  it('parses aliases from a comma list', () => {
    expect(aliasesFromInput(' 통계, STA , 통계,\n확률 ')).toEqual(['통계', 'STA', '확률']);
    expect(aliasesFromInput('')).toEqual([]);
  });

  it('is in the navigation', () => {
    expect(MODULES.find((m) => m.id === 'knowledge')).toMatchObject({ href: '/knowledge', permission: 'admin' });
  });
});

describe('knowledge client (dashboard key, server side)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dash-kb-'));
  const keyFile = join(dir, 'kb.key');
  let kb: typeof import('@/lib/knowledge');

  beforeAll(async () => {
    process.env.KNOWLEDGE_URL = 'http://knowledge.test:8092/';
    process.env.KNOWLEDGE_KEY_FILE = keyFile;
    kb = await import('@/lib/knowledge');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends the key header and the exact edit body', async () => {
    writeFileSync(keyFile, 'k'.repeat(40) + '\n');
    const fetch = vi.fn(async () => new Response(JSON.stringify({ changed: true, fact: { id: FACT } }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await kb.knowledge.editFact(FACT, { kind: null, reason: '종류 없음이 맞음' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://knowledge.test:8092/edit/facts/${FACT}`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Knowledge-Key']).toBe('k'.repeat(40));
    expect(JSON.parse(String(init.body))).toEqual({ kind: null, reason: '종류 없음이 맞음' });
    await kb.knowledge.graph({ facts: true, archived: false });
    expect((fetch.mock.calls[1] as unknown as [string])[0]).toBe('http://knowledge.test:8092/graph/view?facts=1&archived=0');
  });

  it('turns refusals and outages into readable errors', async () => {
    writeFileSync(keyFile, 'k'.repeat(40));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ statusCode: 409, code: 'conflict', message: 'alias used by csc207' }), { status: 409 })));
    await expect(kb.knowledge.editPage({ page: 'sta256', aliases: ['207'], reason: 'r' })).rejects.toMatchObject({ status: 409, code: 'conflict', message: 'alias used by csc207' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('getaddrinfo ENOTFOUND knowledge'); }));
    await expect(kb.knowledge.graph({ facts: false, archived: false })).rejects.toMatchObject({ status: 503, code: 'unreachable' });
  });

  it('says so when the key file is missing, without calling the store', async () => {
    rmSync(keyFile, { force: true });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(kb.knowledge.graph({ facts: false, archived: false })).rejects.toMatchObject({ status: 503, code: 'not_configured' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
