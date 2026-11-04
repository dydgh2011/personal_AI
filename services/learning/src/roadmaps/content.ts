import { createHash } from 'node:crypto';

/**
 * A roadmap version's content. Node keys are stable across versions of one roadmap, so versions
 * can be diffed. An edge `from -> to` means "from is a prerequisite of to".
 */
export const NODE_TYPES = ['stage', 'topic', 'skill', 'milestone'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export interface RoadmapResource {
  title: string;
  url: string | null;
  /** user / imported: from the owner or a source; ai_suggested: unverified, may not exist. */
  provenance: 'user' | 'imported' | 'ai_suggested';
}

export interface RoadmapNode {
  key: string;
  type: NodeType;
  title: string;
  description: string | null;
  estimateMinutes: number | null;
  parentKey: string | null;
  /** Canonical skill name; several nodes (and roadmaps) can point at one shared skill. */
  skill: string | null;
  resources: RoadmapResource[];
}

export interface RoadmapContent {
  nodes: RoadmapNode[];
  edges: Array<{ from: string; to: string }>;
}

export interface ValidationResult {
  ok: boolean;
  content: RoadmapContent | null;
  errors: string[];
  /** Set when the prerequisite graph has a cycle (one cycle, as a key path). */
  cycle: string[] | null;
}

const KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const LIMITS = { nodes: 500, edges: 2000, title: 200, description: 2000, skill: 100, resources: 10, minutes: 100_000 };

/** Validates untrusted content (owner edit, AI output, import) and returns a normalized copy. */
export function validateContent(raw: unknown): ValidationResult {
  const errors: string[] = [];
  const fail = (cycle: string[] | null = null): ValidationResult => ({ ok: false, content: null, errors, cycle });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('content must be an object with nodes and edges');
    return fail();
  }
  const { nodes: rawNodes, edges: rawEdges } = raw as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) errors.push('nodes must be a non-empty array');
  if (rawEdges !== undefined && !Array.isArray(rawEdges)) errors.push('edges must be an array');
  if (errors.length) return fail();
  if ((rawNodes as unknown[]).length > LIMITS.nodes) errors.push(`at most ${LIMITS.nodes} nodes`);
  if (((rawEdges as unknown[]) ?? []).length > LIMITS.edges) errors.push(`at most ${LIMITS.edges} edges`);
  if (errors.length) return fail();

  const nodes: RoadmapNode[] = [];
  const keys = new Set<string>();
  (rawNodes as unknown[]).forEach((n, i) => {
    const at = `nodes[${i}]`;
    if (!n || typeof n !== 'object') return errors.push(`${at} must be an object`);
    const o = n as Record<string, unknown>;
    const key = typeof o.key === 'string' ? o.key : '';
    if (!KEY.test(key)) errors.push(`${at}.key must match ${KEY}`);
    else if (keys.has(key)) errors.push(`${at}.key "${key}" is duplicated`);
    keys.add(key);
    if (!NODE_TYPES.includes(o.type as NodeType)) errors.push(`${at}.type must be one of ${NODE_TYPES.join(', ')}`);
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    if (!title || title.length > LIMITS.title) errors.push(`${at}.title must be 1-${LIMITS.title} characters`);
    const description = o.description === undefined || o.description === null ? null : String(o.description);
    if (description && description.length > LIMITS.description) errors.push(`${at}.description is too long`);
    const est = o.estimateMinutes === undefined || o.estimateMinutes === null ? null : o.estimateMinutes;
    if (est !== null && (!Number.isInteger(est) || (est as number) < 0 || (est as number) > LIMITS.minutes)) errors.push(`${at}.estimateMinutes must be an integer 0-${LIMITS.minutes}`);
    const parentKey = o.parentKey === undefined || o.parentKey === null || o.parentKey === '' ? null : String(o.parentKey);
    const skill = o.skill === undefined || o.skill === null || o.skill === '' ? null : String(o.skill).trim();
    if (skill && skill.length > LIMITS.skill) errors.push(`${at}.skill is too long`);
    const resources: RoadmapResource[] = [];
    if (o.resources !== undefined && o.resources !== null) {
      if (!Array.isArray(o.resources) || o.resources.length > LIMITS.resources) errors.push(`${at}.resources must be an array of at most ${LIMITS.resources}`);
      else o.resources.forEach((r, j) => {
        const ro = (r ?? {}) as Record<string, unknown>;
        const rt = typeof ro.title === 'string' ? ro.title.trim() : '';
        const url = ro.url === undefined || ro.url === null || ro.url === '' ? null : String(ro.url);
        const provenance = ro.provenance;
        if (!rt || rt.length > LIMITS.title) errors.push(`${at}.resources[${j}].title must be 1-${LIMITS.title} characters`);
        if (url && !/^https?:\/\/[^\s]{1,500}$/.test(url)) errors.push(`${at}.resources[${j}].url must be an http(s) URL`);
        if (provenance !== 'user' && provenance !== 'imported' && provenance !== 'ai_suggested') errors.push(`${at}.resources[${j}].provenance must be user, imported or ai_suggested`);
        resources.push({ title: rt, url, provenance: provenance as RoadmapResource['provenance'] });
      });
    }
    nodes.push({ key, type: o.type as NodeType, title, description, estimateMinutes: est as number | null, parentKey, skill, resources });
  });
  for (const n of nodes) {
    if (n.parentKey !== null && !keys.has(n.parentKey)) errors.push(`node "${n.key}": parentKey "${n.parentKey}" does not exist`);
    if (n.parentKey === n.key) errors.push(`node "${n.key}" cannot be its own parent`);
  }
  // hierarchy (parentKey) must be a tree
  const parentOf = new Map(nodes.map((n) => [n.key, n.parentKey]));
  for (const n of nodes) {
    const seen = new Set<string>();
    let cursor: string | null = n.key;
    while (cursor) {
      if (seen.has(cursor)) {
        errors.push(`hierarchy cycle through "${n.key}"`);
        break;
      }
      seen.add(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
  }

  const edges: Array<{ from: string; to: string }> = [];
  const pairs = new Set<string>();
  ((rawEdges as unknown[]) ?? []).forEach((e, i) => {
    const o = (e ?? {}) as Record<string, unknown>;
    const from = typeof o.from === 'string' ? o.from : '';
    const to = typeof o.to === 'string' ? o.to : '';
    if (!keys.has(from) || !keys.has(to)) return errors.push(`edges[${i}] must connect existing node keys`);
    if (from === to) return errors.push(`edges[${i}]: "${from}" cannot be its own prerequisite`);
    const pair = `${from}>${to}`;
    if (pairs.has(pair)) return errors.push(`edges[${i}] duplicates ${from} -> ${to}`);
    pairs.add(pair);
    edges.push({ from, to });
  });
  if (errors.length) return fail();

  const cycle = findCycle(nodes.map((n) => n.key), edges);
  if (cycle) {
    errors.push(`prerequisite cycle: ${cycle.join(' -> ')}`);
    return fail(cycle);
  }
  return { ok: true, content: normalize({ nodes, edges }), errors: [], cycle: null };
}

/** One cycle of the prerequisite graph (direct or indirect), or null if it is a DAG. */
export function findCycle(keys: string[], edges: Array<{ from: string; to: string }>): string[] | null {
  const next = new Map<string, string[]>(keys.map((k) => [k, []]));
  for (const e of edges) next.get(e.from)!.push(e.to);
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (k: string): string[] | null => {
    state.set(k, 1);
    stack.push(k);
    for (const n of next.get(k) ?? []) {
      if (state.get(n) === 1) return [...stack.slice(stack.indexOf(n)), n];
      if (!state.get(n)) {
        const found = visit(n);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(k, 2);
    return null;
  };
  for (const k of keys) {
    if (!state.get(k)) {
      const found = visit(k);
      if (found) return found;
    }
  }
  return null;
}

/** Canonical order and field order, so equal content always hashes the same. */
export function normalize(c: RoadmapContent): RoadmapContent {
  return {
    nodes: [...c.nodes].sort((a, b) => a.key.localeCompare(b.key)).map((n) => ({
      key: n.key, type: n.type, title: n.title, description: n.description, estimateMinutes: n.estimateMinutes,
      parentKey: n.parentKey, skill: n.skill, resources: n.resources.map((r) => ({ title: r.title, url: r.url, provenance: r.provenance })),
    })),
    edges: [...c.edges].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)).map((e) => ({ from: e.from, to: e.to })),
  };
}

export function contentHash(c: RoadmapContent): string {
  return createHash('sha256').update(JSON.stringify(normalize(c))).digest('hex');
}

export interface RoadmapDiff {
  nodes: {
    added: Array<{ key: string; title: string; type: NodeType }>;
    removed: Array<{ key: string; title: string; type: NodeType }>;
    changed: Array<{ key: string; fields: Array<{ field: string; from: unknown; to: unknown }> }>;
  };
  edges: { added: Array<{ from: string; to: string }>; removed: Array<{ from: string; to: string }> };
  nodeCount: { from: number; to: number };
  estimateMinutes: { from: number; to: number };
  unchanged: boolean;
}

export function diffContent(base: RoadmapContent | null, next: RoadmapContent): RoadmapDiff {
  const before = new Map((base?.nodes ?? []).map((n) => [n.key, n]));
  const after = new Map(next.nodes.map((n) => [n.key, n]));
  const diff: RoadmapDiff = {
    nodes: { added: [], removed: [], changed: [] },
    edges: { added: [], removed: [] },
    nodeCount: { from: before.size, to: after.size },
    estimateMinutes: { from: sumMinutes(base), to: sumMinutes(next) },
    unchanged: false,
  };
  for (const [key, n] of after) {
    const old = before.get(key);
    if (!old) diff.nodes.added.push({ key, title: n.title, type: n.type });
    else {
      const fields = (['type', 'title', 'description', 'estimateMinutes', 'parentKey', 'skill', 'resources'] as const)
        .filter((f) => JSON.stringify(old[f]) !== JSON.stringify(n[f]))
        .map((f) => ({ field: f, from: old[f], to: n[f] }));
      if (fields.length) diff.nodes.changed.push({ key, fields });
    }
  }
  for (const [key, n] of before) if (!after.has(key)) diff.nodes.removed.push({ key, title: n.title, type: n.type });
  const edgeKey = (e: { from: string; to: string }) => `${e.from}>${e.to}`;
  const beforeEdges = new Set((base?.edges ?? []).map(edgeKey));
  const afterEdges = new Set(next.edges.map(edgeKey));
  diff.edges.added = next.edges.filter((e) => !beforeEdges.has(edgeKey(e)));
  diff.edges.removed = (base?.edges ?? []).filter((e) => !afterEdges.has(edgeKey(e)));
  diff.unchanged = !diff.nodes.added.length && !diff.nodes.removed.length && !diff.nodes.changed.length && !diff.edges.added.length && !diff.edges.removed.length;
  return diff;
}

function sumMinutes(c: RoadmapContent | null): number {
  return (c?.nodes ?? []).reduce((s, n) => s + (n.estimateMinutes ?? 0), 0);
}

/** "React Hooks" / "react  hooks" -> "react hooks": the shared-skill identity. */
export function canonicalSkill(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}
