/**
 * Knowledge graph page: shapes from the knowledge store (GET /graph/view, /page, /facts/:id) and the
 * pure helpers the page needs (selection in the URL, graph elements, search). No I/O here.
 */

export interface GraphPage {
  id: string;
  slug: string;
  title: string;
  type: string;
  aliases: string[];
  archived: boolean;
  counts: { facts: number; archivedFacts: number; activities: number };
  updatedAt: string;
}

export interface GraphFact {
  id: string;
  page: string;
  text: string;
  clipped: boolean;
  kind: string | null;
  status: string;
  observedOn: string | null;
  updatedAt: string;
}

export interface GraphView {
  include: { facts: boolean; archived: boolean; type: string | null };
  pages: GraphPage[];
  facts?: GraphFact[];
  links: Array<{ source: string; target: string; relation: string; note: string | null }>;
  doneTogether: Array<{ source: string; target: string; weight: number }>;
  totals: { pages: number; facts?: number };
  truncated: { pages: boolean; facts: boolean; doneTogether: boolean };
  vocab: { pageTypes: string[]; factKinds: string[] };
}

export interface PageDetail {
  page: { slug: string; title: string; type: string; summary: string; aliases: string[]; archived: boolean; updatedAt: string };
  facts: Array<{ id: string; text: string; kind: string | null; observedOn: string | null; source: unknown }>;
  links: Array<{ relation: string; to: { slug: string; title: string; type: string }; note: string | null }>;
  linkedFrom: Array<{ relation: string; from: { slug: string; title: string; type: string }; note: string | null }>;
}

export interface FactDetail {
  id: string;
  page: { slug: string; title: string };
  text: string;
  kind: string | null;
  status: string;
  observedOn: string | null;
  source: { rawId: string } | string | null;
  supersededBy: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type Selection = { kind: 'page'; slug: string } | { kind: 'fact'; id: string } | null;

const SLUG = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,99}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `sel=page:<slug>` or `sel=fact:<uuid>`; anything else is no selection. */
export function parseSelection(value: string | undefined | null): Selection {
  if (!value) return null;
  const i = value.indexOf(':');
  const kind = value.slice(0, i);
  const ref = value.slice(i + 1);
  if (kind === 'page' && SLUG.test(ref)) return { kind: 'page', slug: ref };
  if (kind === 'fact' && UUID.test(ref)) return { kind: 'fact', id: ref };
  return null;
}

export function selectionParam(s: Selection): string | null {
  if (!s) return null;
  return s.kind === 'page' ? `page:${s.slug}` : `fact:${s.id}`;
}

export function nodeIdOf(s: Selection): string | null {
  if (!s) return null;
  return s.kind === 'page' ? `p:${s.slug}` : `f:${s.id}`;
}

/** The page's own URL with the view options kept. Only /knowledge paths come out of here. */
export function knowledgeHref(opts: { facts: boolean; archived: boolean; sel?: Selection }, extra?: Record<string, string>): string {
  const q = new URLSearchParams();
  if (opts.facts) q.set('facts', '1');
  if (opts.archived) q.set('archived', '1');
  const sel = selectionParam(opts.sel ?? null);
  if (sel) q.set('sel', sel);
  for (const [k, v] of Object.entries(extra || {})) q.set(k, v);
  const s = q.toString();
  return s ? `/knowledge?${s}` : '/knowledge';
}

/** A return path from a form, accepted only when it stays on this page. */
export function safeReturn(value: unknown): string {
  return typeof value === 'string' && /^\/knowledge(\?[^\\\s]*)?$/.test(value) ? value : '/knowledge';
}

export interface ElementDef {
  group: 'nodes' | 'edges';
  data: Record<string, string | number | boolean | null>;
  classes?: string;
  position?: { x: number; y: number };
}

/** Deterministic start positions: pages on a circle, facts near their page (the force layout starts here). */
export function withStartPositions(elements: ElementDef[]): ElementDef[] {
  const pages = elements.filter((e) => e.group === 'nodes' && e.data.kind === 'page');
  const at = new Map<string, { x: number; y: number }>();
  const r = 120 + pages.length * 18;
  pages.forEach((p, i) => {
    const a = (2 * Math.PI * i) / Math.max(pages.length, 1);
    at.set(String(p.data.id), { x: Math.round(Math.cos(a) * r), y: Math.round(Math.sin(a) * r) });
  });
  const owner = new Map<string, string>();
  for (const e of elements) if (e.group === 'edges' && String(e.data.id).startsWith('pf:')) owner.set(String(e.data.target), String(e.data.source));
  let k = 0;
  return elements.map((e) => {
    if (e.group !== 'nodes') return e;
    const id = String(e.data.id);
    let pos = at.get(id);
    if (!pos) {
      const base = at.get(owner.get(id) || '') || { x: 0, y: 0 };
      const a = k++ * 2.399963;
      pos = { x: Math.round(base.x + Math.cos(a) * 40), y: Math.round(base.y + Math.sin(a) * 40) };
    }
    return { ...e, position: pos };
  });
}

function short(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Cytoscape elements: pages (size by fact count), facts as small satellites of their page,
 * hand-made links (with relation), and pages that appear in the same activities (weight).
 */
export function toElements(view: GraphView): ElementDef[] {
  const out: ElementDef[] = [];
  const known = new Set(view.pages.map((p) => p.slug));
  for (const p of view.pages) {
    out.push({
      group: 'nodes',
      data: {
        id: `p:${p.slug}`,
        label: p.title,
        kind: 'page',
        type: p.type,
        size: Math.round(22 + Math.sqrt(p.counts.facts) * 7),
        search: [p.title, p.slug, ...p.aliases].join(' ').toLowerCase(),
      },
      classes: `page t-${p.type}${p.archived ? ' archived' : ''}`,
    });
  }
  for (const f of view.facts || []) {
    if (!known.has(f.page)) continue;
    out.push({
      group: 'nodes',
      data: { id: `f:${f.id}`, label: short(f.text, 28), kind: 'fact', factKind: f.kind, search: f.text.toLowerCase() },
      classes: `fact k-${f.kind ?? 'none'}${f.status === 'removed' ? ' archived' : ''}`,
    });
    out.push({ group: 'edges', data: { id: `pf:${f.id}`, source: `p:${f.page}`, target: `f:${f.id}` }, classes: 'own short' });
  }
  for (const l of view.links) {
    if (!known.has(l.source) || !known.has(l.target)) continue;
    out.push({
      group: 'edges',
      data: { id: `l:${l.source}>${l.target}:${l.relation}`, source: `p:${l.source}`, target: `p:${l.target}`, label: l.relation },
      classes: 'link',
    });
  }
  for (const t of view.doneTogether) {
    if (!known.has(t.source) || !known.has(t.target)) continue;
    out.push({
      group: 'edges',
      data: { id: `t:${t.source}|${t.target}`, source: `p:${t.source}`, target: `p:${t.target}`, weight: t.weight },
      classes: 'together',
    });
  }
  return out;
}

/** Node ids whose title, slug, alias or fact text contains every word of the query. */
export function searchNodes(elements: ElementDef[], query: string): Set<string> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = new Set<string>();
  if (!words.length) return hits;
  for (const e of elements) {
    if (e.group !== 'nodes') continue;
    const hay = String(e.data.search || '');
    if (words.every((w) => hay.includes(w))) hits.add(String(e.data.id));
  }
  return hits;
}

/** Names shown for page types and fact kinds (the store's vocabulary). */
export const PAGE_TYPE_NAMES: Record<string, string> = {
  me: '나',
  course: '과목',
  topic: '주제',
  goal: '목표',
  project: '프로젝트',
  person: '사람',
  habit: '습관',
  place: '장소',
  org: '조직',
  other: '기타',
};

export const FACT_KIND_NAMES: Record<string, string> = {
  score: '점수',
  mistake: '실수',
  exam: '시험',
  deadline: '마감',
  grading: '배점',
  resource: '자료',
  habit: '습관',
  preference: '선호',
  other: '기타',
};

export function aliasesFromInput(value: string): string[] {
  return [...new Set(value.split(/[,\n]/).map((a) => a.trim()).filter(Boolean))];
}
