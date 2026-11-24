import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ServiceMapView } from '@/app/(admin)/services/view';
import {
  ageSeconds,
  checkSnapshot,
  countFindings,
  dotSize,
  graphIdOf,
  healthOf,
  layoutMap,
  selectionOf,
  serviceGraph,
  SIZE_METRICS,
  sizeMetric,
  NODE_H,
  NODE_W,
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
    expect(SIZE_METRICS.map((m) => m.id)).toEqual(['links', 'memory']);
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
});
