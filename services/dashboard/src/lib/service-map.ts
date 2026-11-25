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

/** One operation a caller may use on a link (stage 2), read from the service's own code. */
export interface LinkOp {
  name: string;
  method: string;
  path: string;
}

/**
 * One list of allowed operations. `role` says who enforces it: 'callee' = the called service checks
 * this caller; 'caller' = the calling service only forwards these (hermes-broker's ROUTES).
 */
export interface LinkRuleSet {
  by: string;
  role: 'callee' | 'caller';
  source: string;
  ops: LinkOp[];
}

/** Calls seen on a link in the window (stage 3). Absent = not measured; total 0 = measured, none. */
export interface LinkCalls {
  total: number;
  failed: number;
  ops: Array<{ name: string; total: number; failed: number }>;
  source: string;
}

export interface CallWindow {
  hours: number;
  since: string;
  sources: Array<{ id: string; ok: boolean; error?: string }>;
}

export interface MapLink {
  from: string;
  to: string;
  via: string[];
  networks: string[];
  /** Stage 2; absent in older snapshots. */
  allowed?: LinkRuleSet[];
  /** Stage 3; absent in older snapshots and on links no source can see. */
  calls?: LinkCalls;
}
export interface ServiceMapSnapshot {
  version: 1;
  generatedAt: string;
  project: string | null;
  composeFiles: string[];
  layers: Array<{ id: string; label: string }>;
  services: MapService[];
  networks: Array<{ id: string; internal: boolean; members: string[] }>;
  links: MapLink[];
  reachable: Array<{ a: string; b: string; networks: string[]; used: boolean }>;
  findings: Array<{ level: FindingLevel; code: string; services: string[]; message: string }>;
  /** Stage 3: the window the link counts cover and which sources could be read. Absent in older snapshots. */
  callWindow?: CallWindow;
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
  const snapshot = value as unknown as ServiceMapSnapshot;
  // Stage 2/3 fields are optional: drop any that are malformed instead of refusing the whole map.
  for (const l of snapshot.links) {
    const link = l as unknown as Record<string, unknown>;
    if ('allowed' in link && !validAllowed(link.allowed)) delete link.allowed;
    if ('calls' in link && !validCalls(link.calls)) delete link.calls;
  }
  if ('callWindow' in snapshot && !validWindow(snapshot.callWindow)) delete snapshot.callWindow;
  return { ok: true, snapshot };
}
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isStr = (v: unknown): v is string => typeof v === 'string';

function validAllowed(v: unknown): boolean {
  return (
    isArr(v) &&
    v.every(
      (set) =>
        isObj(set) &&
        isStr(set.by) &&
        (set.role === 'callee' || set.role === 'caller') &&
        isStr(set.source) &&
        isArr(set.ops) &&
        set.ops.every((o) => isObj(o) && isStr(o.name) && isStr(o.method) && isStr(o.path)),
    )
  );
}

function validCalls(v: unknown): boolean {
  return isObj(v) && isNum(v.total) && isNum(v.failed) && isStr(v.source) && isArr(v.ops) && v.ops.every((o) => isObj(o) && isStr(o.name) && isNum(o.total) && isNum(o.failed));
}

function validWindow(v: unknown): boolean {
  return isObj(v) && isNum(v.hours) && isStr(v.since) && isArr(v.sources) && v.sources.every((s) => isObj(s) && isStr(s.id) && typeof s.ok === 'boolean');
}

// ---------------------------------------------------------------- allowed operations and calls

/** Edge width for a link's recent calls: not measured = the plain width, none = thin, busiest = 7. */
export function linkWidth(total: number | null, max: number): number {
  if (total === null) return 1.8;
  if (total <= 0 || !(max > 0)) return 1;
  return Math.round((1.4 + 5.6 * Math.sqrt(Math.min(total, max) / max)) * 10) / 10;
}

/** Calls into or out of a service in the window; null when none of those links was measured. */
export function callsOf(snap: Pick<ServiceMapSnapshot, 'links'>, id: string, dir: 'in' | 'out'): number | null {
  const measured = snap.links.filter((l) => (dir === 'in' ? l.to : l.from) === id && l.calls);
  return measured.length ? measured.reduce((n, l) => n + (l.calls?.total ?? 0), 0) : null;
}

/** Distinct operations other services may ask this one for (lists it enforces itself); null = unknown. */
export function allowedOpsOf(snap: Pick<ServiceMapSnapshot, 'links'>, id: string): number | null {
  const sets = snap.links.filter((l) => l.to === id).flatMap((l) => l.allowed ?? []).filter((set) => set.by === id);
  if (!sets.length) return null;
  return new Set(sets.flatMap((set) => set.ops.map((o) => `${o.method} ${o.path}`))).size;
}

export interface OpRow extends LinkOp {
  /** Calls in the window; null when this link's counts use other names (or were not measured). */
  total: number | null;
  failed: number;
}

export interface OpGroup {
  key: string;
  ops: OpRow[];
  total: number | null;
}

/** Whether a link's counts are named like this list's operations (so they can be shown per operation). */
export function countsMatch(set: LinkRuleSet, calls: LinkCalls | undefined): calls is LinkCalls {
  if (!calls) return false;
  const names = new Set(set.ops.map((o) => o.name));
  return calls.total === 0 || calls.ops.some((o) => names.has(o.name));
}

const groupKey = (o: LinkOp) => (o.name.includes('.') && !o.name.includes(' ') ? o.name.split('.')[0] : (o.path.split('/').filter(Boolean)[0] ?? '/'));

/**
 * A list's operations with their counts, grouped by area (`knowledge.*`, `planner.*`, `/tasks`…) when
 * the list is long. Busiest first inside a group; groups in name order.
 */
export function opGroups(set: LinkRuleSet, calls?: LinkCalls): OpGroup[] {
  const counted = countsMatch(set, calls);
  const byName = new Map((counted ? calls.ops : []).map((o) => [o.name, o]));
  const rows: OpRow[] = set.ops.map((o) => ({ ...o, total: counted ? (byName.get(o.name)?.total ?? 0) : null, failed: byName.get(o.name)?.failed ?? 0 }));
  const sortRows = (list: OpRow[]) => list.sort((a, b) => (b.total ?? 0) - (a.total ?? 0) || a.name.localeCompare(b.name) || a.method.localeCompare(b.method));
  const sum = (list: OpRow[]) => (counted ? list.reduce((n, r) => n + (r.total ?? 0), 0) : null);
  const keys = new Set(rows.map(groupKey));
  if (rows.length <= 8 || keys.size < 2) return [{ key: '', ops: sortRows(rows), total: sum(rows) }];
  return [...keys]
    .sort((a, b) => a.localeCompare(b))
    .map((key) => {
      const ops = sortRows(rows.filter((r) => groupKey(r) === key));
      return { key, ops, total: sum(ops) };
    });
}

/** Recorded operations that no list on the link names (refused before routing, bad key, …). */
export function unlistedCalls(link: MapLink): LinkCalls['ops'] {
  const calls = link.calls;
  if (!calls || !link.allowed?.length) return [];
  const matching = link.allowed.filter((set) => countsMatch(set, calls));
  if (!matching.length) return [];
  const names = new Set(matching.flatMap((set) => set.ops.map((o) => o.name)));
  return calls.ops.filter((o) => !names.has(o.name));
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
  {
    id: 'calls-in',
    label: '최근 24시간 받은 호출',
    note: '다른 서비스가 부른 횟수가 많을수록 큼 (로그·게이트웨이 기록, 측정 안 된 곳은 가장 작게)',
    value: (s, snap) => callsOf(snap, s.id, 'in'),
  },
  {
    id: 'calls-out',
    label: '최근 24시간 보낸 호출',
    note: '다른 서비스를 부른 횟수가 많을수록 큼 (측정 안 된 곳은 가장 작게)',
    value: (s, snap) => callsOf(snap, s.id, 'out'),
  },
  {
    id: 'allowed-ops',
    label: '허용된 명령 수',
    note: '다른 서비스가 쓸 수 있는 명령이 많을수록 큼 (코드에서 읽음)',
    value: (s, snap) => allowedOpsOf(snap, s.id),
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

  const maxCalls = Math.max(0, ...snap.links.map((l) => l.calls?.total ?? 0));
  for (const l of snap.links) {
    const dim = Boolean(o.network) && !l.networks.includes(o.network);
    const quiet = l.calls !== undefined && l.calls.total === 0;
    out.push({
      group: 'edges',
      data: { id: `l:${l.from}>${l.to}`, source: `s:${l.from}`, target: `s:${l.to}`, width: linkWidth(l.calls?.total ?? null, maxCalls), calls: l.calls?.total ?? null },
      classes: ['call', l.networks.length === 0 ? 'broken' : '', quiet ? 'quiet' : '', l.calls?.failed ? 'failing' : '', dim ? 'dim' : ''].filter(Boolean).join(' '),
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
  'rules-extract-failed': '코드에서 허용 명령을 읽지 못함',
  'link-no-rules': '허용 명령을 모르는 연결',
  'call-outside-rules': '허용 목록 밖의 성공한 호출',
  'calls-unavailable': '호출 수를 못 읽은 곳',
};
