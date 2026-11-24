/**
 * Service map snapshot (services/service-map/collect.mjs, run on the host every minute) and the
 * pure logic the /services page needs: validation, layer layout, edge sides, per-service lookups.
 * No I/O here; reading the file is service-map-server.ts.
 */

export type FindingLevel = 'danger' | 'warn' | 'info';

export interface MapService {
  id: string;
  title: string;
  layer: string;
  description: string | null;
  image: string | null;
  networks: string[];
  internet: boolean;
  ports: Array<{ hostIp: string; published: string | null; target: number | null; protocol: string }>;
  volumes: Array<{ type: string; source: string | null; target: string; readOnly: boolean }>;
  secrets: string[];
  hardening: {
    readOnly: boolean;
    capDropAll: boolean;
    noNewPrivileges: boolean;
    memLimitMb: number | null;
    cpus: number | null;
    pidsLimit: number | null;
    healthcheck: boolean;
  };
  external: Array<{ name: string; purpose: string }>;
  status: { state: string; health: string | null; startedAt: string | null; restartCount: number; exitCode: number | null } | null;
}

export interface ServiceMapSnapshot {
  version: 1;
  generatedAt: string;
  project: string | null;
  composeFiles: string[];
  layers: Array<{ id: string; label: string }>;
  services: MapService[];
  networks: Array<{ id: string; internal: boolean; members: string[] }>;
  links: Array<{ from: string; to: string; via: string[]; networks: string[] }>;
  reachable: Array<{ a: string; b: string; networks: string[]; used: boolean }>;
  findings: Array<{ level: FindingLevel; code: string; services: string[]; message: string }>;
}

/** A snapshot older than this means the host collector stopped (it runs every minute). */
export const STALE_AFTER_SECONDS = 180;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isArr = Array.isArray;

/** Shape check of the parsed file; returns a reason when it is not a snapshot this page understands. */
export function checkSnapshot(value: unknown): { ok: true; snapshot: ServiceMapSnapshot } | { ok: false; reason: string } {
  if (!isObj(value)) return { ok: false, reason: 'not a JSON object' };
  if (value.version !== 1) return { ok: false, reason: `unsupported version ${String(value.version)}` };
  if (typeof value.generatedAt !== 'string' || Number.isNaN(Date.parse(value.generatedAt))) return { ok: false, reason: 'missing generatedAt' };
  for (const key of ['layers', 'services', 'networks', 'links', 'reachable', 'findings'] as const) {
    if (!isArr(value[key])) return { ok: false, reason: `missing ${key}` };
  }
  const services = value.services as unknown[];
  if (!services.every((s) => isObj(s) && typeof s.id === 'string' && isArr(s.networks) && isObj(s.hardening))) {
    return { ok: false, reason: 'malformed services' };
  }
  return { ok: true, snapshot: value as unknown as ServiceMapSnapshot };
}

export function ageSeconds(snapshot: Pick<ServiceMapSnapshot, 'generatedAt'>, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - Date.parse(snapshot.generatedAt)) / 1000));
}

export type Health = 'ok' | 'warn' | 'bad';

/** One word for a service's state, and how it should look. */
export function healthOf(s: MapService): { tone: Health; text: string } {
  const st = s.status;
  if (!st) return { tone: 'bad', text: '컨테이너 없음' };
  if (st.state !== 'running') return { tone: 'bad', text: st.state === 'exited' ? `멈춤 (종료 코드 ${st.exitCode ?? '?'})` : st.state };
  if (st.health === 'unhealthy') return { tone: 'bad', text: '헬스체크 실패' };
  if (st.health === 'starting') return { tone: 'warn', text: '시작 중' };
  if (st.health === 'healthy') return { tone: st.restartCount > 0 ? 'warn' : 'ok', text: st.restartCount > 0 ? `정상 · 재시작 ${st.restartCount}회` : '정상' };
  return { tone: st.restartCount > 0 ? 'warn' : 'ok', text: st.restartCount > 0 ? `실행 중 · 재시작 ${st.restartCount}회` : '실행 중 (헬스체크 없음)' };
}

// ---------------------------------------------------------------- layout

export const NODE_W = 232;
export const NODE_H = 118;
const GAP_X = 36;
const ROW_H = 230;
const BAND_PAD = 28;

export interface Placed {
  id: string;
  x: number;
  y: number;
  row: number;
}

export interface MapLayout {
  nodes: Placed[];
  bands: Array<{ id: string; label: string; x: number; y: number; width: number; height: number }>;
  width: number;
}

/**
 * Layers become rows (in the snapshot's layer order); services of unknown layers go to the last
 * row. Within a row, a few barycenter sweeps over the links put connected services above each
 * other, which keeps lines short and crossings few. Deterministic: same snapshot, same picture.
 */
export function layoutMap(snapshot: Pick<ServiceMapSnapshot, 'layers' | 'services' | 'links'>): MapLayout {
  const layerIds = snapshot.layers.map((l) => l.id);
  const rowOf = (layer: string) => {
    const i = layerIds.indexOf(layer);
    return i < 0 ? Math.max(layerIds.length - 1, 0) : i;
  };
  const rowCount = Math.max(layerIds.length, 1);
  const rows: string[][] = Array.from({ length: rowCount }, () => []);
  for (const s of [...snapshot.services].sort((a, b) => a.id.localeCompare(b.id))) rows[rowOf(s.layer)].push(s.id);

  const neighbours = new Map<string, Set<string>>();
  for (const l of snapshot.links) {
    if (!neighbours.has(l.from)) neighbours.set(l.from, new Set());
    if (!neighbours.has(l.to)) neighbours.set(l.to, new Set());
    neighbours.get(l.from)!.add(l.to);
    neighbours.get(l.to)!.add(l.from);
  }
  const position = new Map<string, number>();
  const center = (row: string[]) => row.forEach((id, i) => position.set(id, i - (row.length - 1) / 2));
  rows.forEach(center);
  const sweep = (order: number[]) => {
    for (const r of order) {
      const row = rows[r];
      const score = new Map<string, number>();
      row.forEach((id, i) => {
        const others = [...(neighbours.get(id) || [])].filter((n) => position.has(n) && !row.includes(n));
        score.set(id, others.length ? others.reduce((sum, n) => sum + position.get(n)!, 0) / others.length : position.get(id)! + i * 1e-6);
      });
      row.sort((a, b) => score.get(a)! - score.get(b)! || a.localeCompare(b));
      center(row);
    }
  };
  const down = rows.map((_, i) => i);
  for (let k = 0; k < 4; k++) {
    sweep(down.slice(1));
    sweep(down.slice(0, -1).reverse());
  }

  const widest = Math.max(...rows.map((r) => r.length), 1);
  const width = widest * NODE_W + (widest - 1) * GAP_X;
  const nodes: Placed[] = [];
  rows.forEach((row, r) => {
    const rowWidth = row.length * NODE_W + Math.max(row.length - 1, 0) * GAP_X;
    const x0 = (width - rowWidth) / 2;
    row.forEach((id, i) => nodes.push({ id, row: r, x: x0 + i * (NODE_W + GAP_X), y: r * ROW_H }));
  });
  const bands = snapshot.layers.map((l, r) => ({
    id: `band:${l.id}`,
    label: l.label,
    x: -BAND_PAD,
    y: r * ROW_H - BAND_PAD - 18,
    width: width + BAND_PAD * 2,
    height: NODE_H + BAND_PAD * 2 + 18,
  }));
  return { nodes, bands, width };
}

// ---------------------------------------------------------------- graph view (Cytoscape)

/**
 * What a service's dot size shows. Add an entry to add a view (later: work done, AI calls); the
 * page lists them in this order and the first is the default. `value` null = no data (smallest dot).
 */
export const SIZE_METRICS: Array<{ id: string; label: string; note: string; value: (s: MapService, snap: ServiceMapSnapshot) => number | null }> = [
  {
    id: 'links',
    label: '연결 수',
    note: '부르거나 불리는 연결이 많을수록 큼',
    value: (s, snap) => snap.links.filter((l) => l.from === s.id || l.to === s.id).length,
  },
  {
    id: 'memory',
    label: '메모리 한도',
    note: 'Compose mem_limit이 클수록 큼',
    value: (s) => s.hardening.memLimitMb,
  },
];

export function sizeMetric(id: string | null | undefined) {
  return SIZE_METRICS.find((m) => m.id === id) ?? SIZE_METRICS[0];
}

/** Dot diameter for a value against the largest one (area grows with the value). */
export function dotSize(value: number | null, max: number): number {
  if (value === null || !(max > 0)) return 14;
  return Math.round(18 + 30 * Math.sqrt(Math.max(value, 0) / max));
}

export interface ServiceGraphOptions {
  sizeBy: string;
  reach: boolean;
  external: boolean;
  networks: boolean;
  network: string;
  layout: 'force' | 'preset';
}

export interface ServiceGraphElement {
  group: 'nodes' | 'edges';
  data: Record<string, string | number | boolean | null>;
  classes?: string;
  position?: { x: number; y: number };
}

const EXT_GAP = 90;

/**
 * Services as dots (color = layer, size = chosen metric, ring + "!" when not healthy), calls as
 * arrows, unused reachable pairs as dashed lines, outside services as diamonds with dotted lines,
 * networks as small squares joined to their members. A network filter dims what is not on it.
 */
export function serviceGraph(snap: ServiceMapSnapshot, o: ServiceGraphOptions): ServiceGraphElement[] {
  const metric = sizeMetric(o.sizeBy);
  const values = new Map(snap.services.map((s) => [s.id, metric.value(s, snap)]));
  const max = Math.max(0, ...[...values.values()].map((v) => v ?? 0));
  const layerIndex = new Map(snap.layers.map((l, i) => [l.id, i]));
  const members = new Set(o.network ? snap.networks.find((n) => n.id === o.network)?.members ?? [] : []);
  const dimSvc = (id: string) => Boolean(o.network) && !members.has(id);
  const placed = o.layout === 'preset' ? layoutMap(snap) : null;
  const pos = new Map(placed?.nodes.map((n) => [n.id, { x: Math.round(n.x + NODE_W / 2), y: Math.round(n.y + NODE_H / 2) }]) ?? []);
  const out: ServiceGraphElement[] = [];

  for (const s of snap.services) {
    const h = healthOf(s);
    const li = layerIndex.get(s.layer);
    const value = values.get(s.id) ?? null;
    out.push({
      group: 'nodes',
      data: {
        id: `s:${s.id}`,
        label: h.tone === 'ok' ? s.title : `${s.title} !`,
        size: dotSize(value, max),
        metric: value,
        search: [s.id, s.title, s.description ?? '', ...s.networks, ...s.external.map((e) => e.name)].join(' ').toLowerCase(),
      },
      classes: ['svc', li === undefined || li > 3 ? 'layer-other' : `layer-${li}`, `st-${h.tone}`, s.status?.state === 'running' ? '' : 'down', dimSvc(s.id) ? 'dim' : '']
        .filter(Boolean)
        .join(' '),
      ...(pos.has(s.id) ? { position: pos.get(s.id) } : {}),
    });
  }

  for (const l of snap.links) {
    const dim = Boolean(o.network) && !l.networks.includes(o.network);
    out.push({
      group: 'edges',
      data: { id: `l:${l.from}>${l.to}`, source: `s:${l.from}`, target: `s:${l.to}` },
      classes: ['call', l.networks.length === 0 ? 'broken' : '', dim ? 'dim' : ''].filter(Boolean).join(' '),
    });
  }

  if (o.reach) {
    for (const r of snap.reachable) {
      if (r.used) continue;
      const dim = Boolean(o.network) && !r.networks.includes(o.network);
      out.push({ group: 'edges', data: { id: `r:${r.a}|${r.b}`, source: `s:${r.a}`, target: `s:${r.b}` }, classes: `reach${dim ? ' dim' : ''}` });
    }
  }

  if (o.external) {
    const users = new Map<string, string[]>();
    for (const s of snap.services) for (const e of s.external) users.set(e.name, [...(users.get(e.name) ?? []), s.id]);
    const names = [...users.keys()].sort((a, b) => a.localeCompare(b));
    const right = (placed?.width ?? 0) + 200;
    names.forEach((name, i) => {
      const who = users.get(name)!;
      out.push({
        group: 'nodes',
        data: { id: `x:${name}`, label: name, search: `${name} ${who.join(' ')}`.toLowerCase() },
        classes: `ext${o.network ? ' dim' : ''}`,
        ...(placed ? { position: { x: right, y: i * EXT_GAP } } : {}),
      });
      for (const id of who) {
        out.push({ group: 'edges', data: { id: `xe:${id}>${name}`, source: `s:${id}`, target: `x:${name}` }, classes: `out${dimSvc(id) ? ' dim' : ''}` });
      }
    });
  }

  if (o.networks) {
    const bottom = placed ? Math.max(...placed.nodes.map((n) => n.y)) + NODE_H + 160 : 0;
    snap.networks.forEach((n, i) => {
      const dim = Boolean(o.network) && n.id !== o.network;
      out.push({
        group: 'nodes',
        data: { id: `n:${n.id}`, label: n.internal ? n.id : `${n.id} ↗`, search: `${n.id} ${n.members.join(' ')}`.toLowerCase() },
        classes: `net${n.internal ? '' : ' net-open'}${dim ? ' dim' : ''}`,
        ...(placed ? { position: { x: i * 150, y: bottom + (i % 2) * 50 } } : {}),
      });
      for (const m of n.members) {
        out.push({ group: 'edges', data: { id: `ne:${n.id}|${m}`, source: `n:${n.id}`, target: `s:${m}` }, classes: `member short${dim ? ' dim' : ''}` });
      }
    });
  }
  return out;
}

/** Node / edge id from the graph back to what it stands for. */
export type MapSelection =
  | { kind: 'service'; id: string }
  | { kind: 'external'; name: string }
  | { kind: 'network'; id: string }
  | { kind: 'link'; from: string; to: string }
  | { kind: 'reach'; a: string; b: string }
  | null;

export function selectionOf(graphId: string | null): MapSelection {
  if (!graphId) return null;
  const i = graphId.indexOf(':');
  const kind = graphId.slice(0, i);
  const rest = graphId.slice(i + 1);
  if (kind === 's') return { kind: 'service', id: rest };
  if (kind === 'x') return { kind: 'external', name: rest };
  if (kind === 'n') return { kind: 'network', id: rest };
  if (kind === 'l') {
    const [from, to] = rest.split('>');
    return from && to ? { kind: 'link', from, to } : null;
  }
  if (kind === 'r') {
    const [a, b] = rest.split('|');
    return a && b ? { kind: 'reach', a, b } : null;
  }
  if (kind === 'xe') {
    const name = rest.slice(rest.indexOf('>') + 1);
    return { kind: 'external', name };
  }
  if (kind === 'ne') return { kind: 'network', id: rest.slice(0, rest.indexOf('|')) };
  return null;
}

export function graphIdOf(sel: MapSelection): string | null {
  if (!sel) return null;
  switch (sel.kind) {
    case 'service':
      return `s:${sel.id}`;
    case 'external':
      return `x:${sel.name}`;
    case 'network':
      return `n:${sel.id}`;
    case 'link':
      return `l:${sel.from}>${sel.to}`;
    case 'reach':
      return `r:${sel.a}|${sel.b}`;
  }
}

// ---------------------------------------------------------------- lookups

export function findingsFor(snapshot: Pick<ServiceMapSnapshot, 'findings'>, id: string) {
  return snapshot.findings.filter((f) => f.services.includes(id));
}

export function countFindings(snapshot: Pick<ServiceMapSnapshot, 'findings'>): Record<FindingLevel, number> {
  const out: Record<FindingLevel, number> = { danger: 0, warn: 0, info: 0 };
  for (const f of snapshot.findings) if (f.level in out) out[f.level] += 1;
  return out;
}

export const FINDING_TITLES: Record<string, string> = {
  'port-exposed': '127.0.0.1 밖에 열린 포트',
  'not-running': '멈춘 서비스',
  unhealthy: '헬스체크 실패',
  'link-unreachable': '부르는데 닿지 않는 연결',
  'internal-has-internet': '인터넷이 열린 내부망',
  'reachable-unused': '닿지만 쓰지 않는 길',
  'writable-root': '쓰기 가능한 루트 파일 시스템',
  'caps-kept': '남겨 둔 capabilities',
  uncatalogued: '설명 없는 서비스',
  'catalog-extra': 'Compose에 없는 설명',
};
