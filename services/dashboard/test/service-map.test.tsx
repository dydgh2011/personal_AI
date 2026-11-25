import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LinkPanel, ServiceMapView } from '@/app/(admin)/services/view';
import {
  ageSeconds,
  allowedOpsOf,
  callsOf,
  checkSnapshot,
  countsMatch,
  countFindings,
  dotSize,
  graphIdOf,
  healthOf,
  layoutMap,
  linkWidth,
  opGroups,
  selectionOf,
  serviceGraph,
  SIZE_METRICS,
  sizeMetric,
  unlistedCalls,
  NODE_H,
  NODE_W,
  type LinkRuleSet,
  type MapLink,
  type MapService,
  type ServiceMapSnapshot,
} from '@/lib/service-map';
import { readServiceMap } from '@/lib/service-map-server';
import { MODULES } from '@/modules/registry';

function svc(id: string, layer: string, extra: Partial<MapService> = {}): MapService {
  return {
    id,
    title: id.toUpperCase(),
    layer,
    description: `${id} 설명`,
    image: null,
    networks: ['net'],
    internet: false,
    ports: [],
    volumes: [],
    secrets: [],
    hardening: { readOnly: true, capDropAll: true, noNewPrivileges: true, memLimitMb: 128, cpus: 1, pidsLimit: 64, healthcheck: true },
    external: [],
    status: { state: 'running', health: 'healthy', startedAt: '2026-11-24T10:00:00Z', restartCount: 0, exitCode: 0 },
    ...extra,
  };
}

function snapshot(): ServiceMapSnapshot {
  return {
    version: 1,
    generatedAt: '2026-11-24T12:00:00Z',
    project: 'demo',
    composeFiles: ['compose.yaml'],
    layers: [
      { id: 'entry', label: '입구' },
      { id: 'core', label: '핵심' },
    ],
    services: [
      svc('web', 'entry', { ports: [{ hostIp: '127.0.0.1', published: '8710', target: 3000, protocol: 'tcp' }], internet: true }),
      svc('bot', 'entry'),
      svc('zeta', 'core'),
      svc('api', 'core', { status: { state: 'running', health: 'unhealthy', startedAt: null, restartCount: 2, exitCode: 0 } }),
      svc('db', 'core', { status: null }),
      svc('stray', 'nowhere', { hardening: { readOnly: false, capDropAll: false, noNewPrivileges: false, memLimitMb: null, cpus: null, pidsLimit: null, healthcheck: false } }),
    ],
    networks: [{ id: 'net', internal: true, members: ['api', 'bot', 'db', 'stray', 'web', 'zeta'] }],
    links: [
      { from: 'web', to: 'api', via: ['API_URL'], networks: ['net'] },
      { from: 'bot', to: 'zeta', via: ['ZETA_URL'], networks: ['net'] },
      { from: 'api', to: 'db', via: ['DB_URL'], networks: [] },
    ],
    reachable: [{ a: 'bot', b: 'web', networks: ['net'], used: false }],
    findings: [
      { level: 'warn', code: 'unhealthy', services: ['api'], message: 'api: 헬스체크 unhealthy.' },
      { level: 'warn', code: 'link-unreachable', services: ['api', 'db'], message: 'api → db: 같은 네트워크가 없다.' },
      { level: 'info', code: 'reachable-unused', services: ['bot', 'web'], message: 'bot ↔ web' },
    ],
  };
}

describe('service map snapshot', () => {
  it('accepts a snapshot and rejects other shapes', () => {
    expect(checkSnapshot(snapshot()).ok).toBe(true);
    expect(checkSnapshot(null)).toEqual({ ok: false, reason: 'not a JSON object' });
    expect(checkSnapshot({ ...snapshot(), version: 2 })).toMatchObject({ ok: false });
    expect(checkSnapshot({ ...snapshot(), services: [{ id: 'x' }] })).toEqual({ ok: false, reason: 'malformed services' });
    expect(checkSnapshot({ ...snapshot(), links: undefined })).toEqual({ ok: false, reason: 'missing links' });
  });

  it('reads the file: ok, missing, invalid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-map-'));
    const good = join(dir, 'map.json');
    writeFileSync(good, JSON.stringify(snapshot()));
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"version": 1, ');
    expect((await readServiceMap(good)).ok).toBe(true);
    expect(await readServiceMap(join(dir, 'none.json'))).toMatchObject({ ok: false, code: 'missing' });
    expect(await readServiceMap(bad)).toMatchObject({ ok: false, code: 'invalid', message: 'not valid JSON' });
  });

  it('age, health words and finding counts', () => {
    expect(ageSeconds(snapshot(), new Date('2026-11-24T12:03:30Z'))).toBe(210);
    const byId = new Map(snapshot().services.map((x) => [x.id, x]));
    expect(healthOf(byId.get('web')!)).toEqual({ tone: 'ok', text: '정상' });
    expect(healthOf(byId.get('api')!)).toEqual({ tone: 'bad', text: '헬스체크 실패' });
    expect(healthOf(byId.get('db')!)).toEqual({ tone: 'bad', text: '컨테이너 없음' });
    expect(countFindings(snapshot())).toEqual({ danger: 0, warn: 2, info: 1 });
  });

  it('lays services out by layer, without overlaps, the same way every time', () => {
    const a = layoutMap(snapshot());
    expect(layoutMap(snapshot())).toEqual(a);
    const row = (id: string) => a.nodes.find((n) => n.id === id)!.row;
    expect([row('web'), row('bot'), row('api'), row('db'), row('zeta')]).toEqual([0, 0, 1, 1, 1]);
    expect(row('stray')).toBe(1); // unknown layer goes to the last row
    for (const p of a.nodes) {
      for (const q of a.nodes) {
        if (p === q) continue;
        const apart = Math.abs(p.x - q.x) >= NODE_W || Math.abs(p.y - q.y) >= NODE_H;
        expect(apart, `${p.id} overlaps ${q.id}`).toBe(true);
      }
    }
    // barycenter: web calls api and bot calls zeta, so their columns keep the same order.
    const x = (id: string) => a.nodes.find((n) => n.id === id)!.x;
    expect(Math.sign(x('web') - x('bot'))).toBe(Math.sign(x('api') - x('zeta')));
    expect(a.bands.map((b) => b.label)).toEqual(['입구', '핵심']);
  });

  it('graph: services sized by the chosen view, status rings, calls and broken calls', () => {
    const snap = snapshot();
    snap.services[0].external = [{ name: 'Discord', purpose: '봇' }];
    snap.services[1].external = [{ name: 'Discord', purpose: '알림' }];
    const base = { sizeBy: 'links', reach: false, external: true, networks: false, network: '', layout: 'force' as const };
    const els = serviceGraph(snap, base);
    const node = (id: string) => els.find((e) => e.data.id === id)!;
    // links: api has 2 (web→api, api→db), the most; db 1; stray 0
    expect(node('s:api').data.size).toBe(dotSize(2, 2));
    expect(Number(node('s:api').data.size)).toBeGreaterThan(Number(node('s:db').data.size));
    expect(node('s:stray').data.size).toBe(dotSize(0, 2));
    expect(node('s:api').data.label).toBe('API !');
    expect(node('s:api').classes).toContain('st-bad');
    expect(node('s:db').classes).toContain('down');
    expect(node('s:web').classes).toContain('layer-0');
    expect(node('s:stray').classes).toContain('layer-other');
    expect(node('l:api>db').classes).toContain('broken');
    // one diamond per outside service, joined to every user
    expect(els.filter((e) => String(e.data.id).startsWith('x:'))).toHaveLength(1);
    expect(els.filter((e) => String(e.data.id).startsWith('xe:')).map((e) => e.data.source).sort()).toEqual(['s:bot', 's:web']);
    // memory view: same elements, sizes by mem_limit, missing value = smallest
    const mem = serviceGraph(snap, { ...base, sizeBy: 'memory' });
    expect(mem.map((e) => e.data.id)).toEqual(els.map((e) => e.data.id));
    expect(mem.find((e) => e.data.id === 's:stray')!.data.size).toBe(14);
    expect(mem.find((e) => e.data.id === 's:web')!.data.size).toBe(dotSize(128, 128));
    expect(sizeMetric('nope').id).toBe('links');
    expect(SIZE_METRICS.map((m) => m.id)).toEqual(['links', 'memory', 'calls-in', 'calls-out', 'allowed-ops']);
    // a stage-1 snapshot has no counts: every call view is "no data" and lines keep the plain width
    const old = serviceGraph(snap, { ...base, sizeBy: 'calls-in' });
    expect(old.filter((e) => String(e.data.id).startsWith('s:')).every((e) => e.data.size === 14)).toBe(true);
    expect(old.filter((e) => String(e.data.id).startsWith('l:')).every((e) => e.data.width === 1.8)).toBe(true);
  });

  it('graph: toggles and the network filter', () => {
    const snap = snapshot();
    const base = { sizeBy: 'links', reach: false, external: false, networks: false, network: '', layout: 'force' as const };
    const ids = (o: Partial<typeof base>) => serviceGraph(snap, { ...base, ...o }).map((e) => String(e.data.id));
    expect(ids({}).some((i) => i.startsWith('r:'))).toBe(false);
    expect(ids({ reach: true })).toContain('r:bot|web');
    expect(ids({ networks: true })).toContain('n:net');
    expect(ids({ networks: true }).filter((i) => i.startsWith('ne:net|'))).toHaveLength(6);
    snap.networks.push({ id: 'side', internal: false, members: ['web'] });
    const filtered = serviceGraph(snap, { ...base, network: 'side', networks: true });
    expect(filtered.find((e) => e.data.id === 's:web')!.classes).not.toContain('dim');
    expect(filtered.find((e) => e.data.id === 's:api')!.classes).toContain('dim');
    expect(filtered.find((e) => e.data.id === 'l:web>api')!.classes).toContain('dim');
    expect(filtered.find((e) => e.data.id === 'n:side')!.data.label).toBe('side ↗');
    expect(filtered.find((e) => e.data.id === 'n:net')!.classes).toContain('dim');
  });

  it('graph: layer layout gives every node a position, force leaves them to the layout', () => {
    const snap = snapshot();
    snap.services[0].external = [{ name: 'Discord', purpose: '봇' }];
    const o = { sizeBy: 'links', reach: false, external: true, networks: true, network: '', layout: 'preset' as const };
    const preset = serviceGraph(snap, o).filter((e) => e.group === 'nodes');
    expect(preset.every((e) => e.position)).toBe(true);
    expect(serviceGraph(snap, { ...o, layout: 'force' }).some((e) => e.position)).toBe(false);
  });

  it('selection ids round-trip between the graph and the panel', () => {
    const cases = [
      { kind: 'service', id: 'hermes-broker' },
      { kind: 'external', name: '학교 사이트·메일' },
      { kind: 'network', id: 'knowledge-dashboard' },
      { kind: 'link', from: 'hermes', to: 'hermes-broker' },
      { kind: 'reach', a: 'claude-worker', b: 'codex-worker' },
    ] as const;
    for (const sel of cases) expect(selectionOf(graphIdOf(sel))).toEqual(sel);
    expect(selectionOf('xe:hermes>Discord')).toEqual({ kind: 'external', name: 'Discord' });
    expect(selectionOf('ne:net|web')).toEqual({ kind: 'network', id: 'net' });
    expect(selectionOf(null)).toBeNull();
  });

  it('renders the summary, controls and findings on the server', () => {
    const html = renderToStaticMarkup(<ServiceMapView snapshot={snapshot()} ageSeconds={42} />);
    expect(html).toContain('서비스 <b>6</b>');
    expect(html).toContain('닿기만 하는 길 (1)');
    expect(html).toContain('부르는데 닿지 않는 연결');
    expect(html).toContain('수집 42초 전');
    expect(html).toContain('점을 눌러 보세요');
    expect(html).toContain('점 크기 = 연결 수');
  });

  it('is in the navigation', () => {
    expect(MODULES.find((m) => m.id === 'services')).toMatchObject({ href: '/services', permission: 'admin' });
  });
  // ---------------------------------------------------------------- stages 2 and 3

  const brokerSet: LinkRuleSet = {
    by: 'api',
    role: 'callee',
    source: 'services/api/src/routes.ts',
    ops: [
      { name: 'items.list', method: 'GET', path: '/items' },
      { name: 'items.add', method: 'POST', path: '/items' },
      { name: 'items.get', method: 'GET', path: '/items/:id' },
      { name: 'users.list', method: 'GET', path: '/users' },
      { name: 'users.add', method: 'POST', path: '/users' },
      { name: 'users.get', method: 'GET', path: '/users/:id' },
      { name: 'jobs.run', method: 'POST', path: '/jobs' },
      { name: 'jobs.list', method: 'GET', path: '/jobs' },
      { name: 'status', method: 'GET', path: '/status' },
    ],
  };

  function staged(): ServiceMapSnapshot {
    const snap = snapshot();
    snap.links[0] = {
      ...snap.links[0],
      allowed: [brokerSet],
      calls: {
        total: 40,
        failed: 3,
        source: 'api 로그',
        ops: [
          { name: 'items.list', total: 30, failed: 0 },
          { name: 'items.add', total: 6, failed: 1 },
          { name: 'auth', total: 2, failed: 2 },
          { name: 'status', total: 2, failed: 0 },
        ],
      },
    };
    snap.links[1] = { ...snap.links[1], allowed: [], calls: { total: 0, failed: 0, source: 'zeta 로그', ops: [] } };
    snap.callWindow = { hours: 24, since: '2026-11-23T12:00:00Z', sources: [{ id: 'api', ok: true }, { id: 'gateway', ok: false, error: 'x' }] };
    return snap;
  }

  it('snapshot: new link fields are kept when well formed and dropped when not', () => {
    const good = checkSnapshot(JSON.parse(JSON.stringify(staged())));
    expect(good.ok && good.snapshot.links[0].allowed?.[0].ops).toHaveLength(9);
    expect(good.ok && good.snapshot.links[0].calls?.total).toBe(40);
    expect(good.ok && good.snapshot.callWindow?.hours).toBe(24);
    const bad = JSON.parse(JSON.stringify(staged()));
    bad.links[0].allowed = [{ by: 'api', role: 'boss', source: 'x', ops: [] }];
    bad.links[0].calls = { total: '40' };
    bad.callWindow = { hours: 24 };
    const checked = checkSnapshot(bad);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect('allowed' in checked.snapshot.links[0]).toBe(false);
    expect('calls' in checked.snapshot.links[0]).toBe(false);
    expect(checked.snapshot.callWindow).toBeUndefined();
    // stage-1 snapshots still pass untouched
    expect(checkSnapshot(JSON.parse(JSON.stringify(snapshot())))).toEqual({ ok: true, snapshot: snapshot() });
  });

  it('graph: line width follows recent calls; size views count calls and allowed operations', () => {
    expect(linkWidth(null, 10)).toBe(1.8);
    expect(linkWidth(0, 10)).toBe(1);
    expect(linkWidth(10, 10)).toBe(7);
    expect(linkWidth(1, 100)).toBeLessThan(linkWidth(50, 100));
    const snap = staged();
    const els = serviceGraph(snap, { sizeBy: 'calls-in', reach: false, external: false, networks: false, network: '', layout: 'force' });
    const el = (id: string) => els.find((e) => e.data.id === id)!;
    expect(el('l:web>api').data.width).toBe(7);
    expect(el('l:web>api').data.calls).toBe(40);
    expect(el('l:bot>zeta').data.width).toBe(1);
    expect(el('l:bot>zeta').classes).toContain('quiet');
    expect(el('l:api>db').data.width).toBe(1.8);
    expect(el('s:api').data.size).toBe(dotSize(40, 40));
    expect(el('s:zeta').data.metric).toBe(0);
    expect(el('s:db').data.metric).toBeNull();
    expect(callsOf(snap, 'web', 'out')).toBe(40);
    expect(callsOf(snap, 'api', 'out')).toBeNull();
    expect(allowedOpsOf(snap, 'api')).toBe(9);
    expect(allowedOpsOf(snap, 'zeta')).toBeNull();
    expect(sizeMetric('calls-in').label).toBe('최근 24시간 받은 호출');
  });

  it('operations are grouped by area with their counts; unlisted calls are kept apart', () => {
    const snap = staged();
    const groups = opGroups(brokerSet, snap.links[0].calls);
    expect(groups.map((gr) => `${gr.key}:${gr.ops.length}:${gr.total}`)).toEqual(['items:3:36', 'jobs:2:0', 'status:1:2', 'users:3:0']);
    expect(groups[0].ops.map((o) => `${o.name}=${o.total}/${o.failed}`)).toEqual(['items.list=30/0', 'items.add=6/1', 'items.get=0/0']);
    // short lists stay in one group
    const short = { ...brokerSet, ops: brokerSet.ops.slice(0, 3) };
    expect(opGroups(short, undefined)).toEqual([{ key: '', total: null, ops: expect.any(Array) }]);
    expect(opGroups(short, undefined)[0].ops.every((o) => o.total === null)).toBe(true);
    // counts under other names (e.g. a caller-side log) are not spread over the callee's names
    const other = { total: 5, failed: 0, source: 'x', ops: [{ name: 'api.items.list', total: 5, failed: 0 }] };
    expect(countsMatch(brokerSet, other)).toBe(false);
    expect(opGroups(brokerSet, other).every((gr) => gr.total === null)).toBe(true);
    expect(unlistedCalls(snap.links[0]).map((o) => o.name)).toEqual(['auth']);
    expect(unlistedCalls({ ...snap.links[0], calls: other })).toEqual([]);
  });

  it('link panel: allowed commands, counts and honest gaps', () => {
    const snap = staged();
    const render = (link: MapLink, w: ServiceMapSnapshot['callWindow'] | null = snap.callWindow ?? null) =>
      renderToStaticMarkup(<LinkPanel link={link} window={w ?? undefined} name={(id) => id.toUpperCase()} go={(id) => <span>{id.toUpperCase()}</span>} />);
    const html = render(snap.links[0]);
    expect(html).toContain('최근 24시간');
    expect(html).toContain('<b>40회</b>');
    expect(html).toContain('실패 3');
    expect(html).toContain('API의 허용 목록');
    expect(html).toContain('services/api/src/routes.ts');
    expect(html).toContain('/items/:id');
    expect(html).toContain('items.list');
    expect(html).toContain('목록 밖 기록');
    expect(html).not.toContain('다음 단계에서');
    expect(render(snap.links[1])).toContain('코드에서 읽지 못했습니다');
    const old = render(snapshot().links[0], null);
    expect(old).toContain('이 스냅샷에는 허용 명령이 없습니다');
    expect(old).not.toContain('최근 24시간');
    expect(render(snapshot().links[2])).toContain('측정 안 함');
  });

  it('summary shows recent calls and says when a source could not be read', () => {
    const html = renderToStaticMarkup(<ServiceMapView snapshot={staged()} ageSeconds={5} />);
    expect(html).toContain('최근 24시간 호출 <b>40</b>');
    expect(html).toContain('일부 못 읽음');
    expect(html).toContain('굵기 = 최근 24시간 호출 수');
    expect(html).toContain('최근 24시간 받은 호출');
    expect(renderToStaticMarkup(<ServiceMapView snapshot={snapshot()} ageSeconds={5} />)).not.toContain('최근 24시간 호출');
  });
});
