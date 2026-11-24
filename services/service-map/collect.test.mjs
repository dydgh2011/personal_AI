// node --test services/service-map
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMap, parseInspectLines } from './collect.mjs';

const SECRET = 'sk-test-0000-DO-NOT-LEAK';

const catalog = {
  LAYERS: [{ id: 'entry', label: '입구' }, { id: 'core', label: '핵심' }],
  SERVICES: {
    web: { title: 'Web', layer: 'entry', description: '화면', external: [{ name: 'Discord', purpose: '봇' }] },
    api: { title: 'API', layer: 'core', description: '백엔드' },
    ghost: { title: 'Ghost', layer: 'core', description: '없는 서비스' },
  },
};

function fixture() {
  return {
    name: 'demo',
    services: {
      web: {
        environment: { API_URL: 'http://api:3000', TOKEN: SECRET, HOOK: `https://discord.example/hook/${SECRET}` },
        networks: { front: null, 'app-internal': null },
        ports: [{ host_ip: '127.0.0.1', published: '8710', target: 3000, protocol: 'tcp' }],
        volumes: [{ type: 'bind', source: '/srv/demo/data/web', target: '/data', read_only: true }],
        secrets: [{ source: 'web_token', target: 'token' }],
        read_only: true,
        cap_drop: ['ALL'],
        security_opt: ['no-new-privileges:true'],
        mem_limit: '402653184',
        healthcheck: { test: ['CMD', 'true'] },
        build: { args: { NPM_TOKEN: SECRET } },
        command: ['node', `--secret=${SECRET}`],
      },
      api: {
        environment: ['DB_URL=http://db:5432', `PASSWORD=${SECRET}`],
        networks: { 'app-internal': null, 'api-egress': null },
        volumes: [{ type: 'volume', source: 'api-data', target: '/var/lib/api' }],
        read_only: true,
        cap_drop: ['ALL'],
      },
      worker: {
        environment: { API_URL: 'http://api:3000' },
        networks: { lonely: null },
        ports: [{ host_ip: '', published: '9000', target: 9000 }],
      },
      spare: { networks: { 'app-internal': null }, read_only: true, cap_drop: ['ALL'] },
    },
    networks: {
      front: {},
      'app-internal': { internal: true },
      'api-egress': {},
      lonely: { internal: true },
    },
  };
}

const containers = [
  { service: 'web', state: 'running', health: 'healthy', startedAt: '2026-11-24T00:00:00Z', restartCount: 0, exitCode: 0 },
  { service: 'api', state: 'exited', health: null, startedAt: null, restartCount: 2, exitCode: 1 },
  { service: 'api', state: 'running', health: 'unhealthy', startedAt: '2026-11-24T01:00:00Z', restartCount: 3, exitCode: 0 },
  { service: 'spare', state: 'running', health: null, startedAt: '2026-11-24T01:00:00Z', restartCount: 0, exitCode: 0 },
];

const build = () => buildMap({ config: fixture(), containers, catalog, project: 'demo', projectDir: '/srv/demo', composeFiles: ['/srv/demo/compose.yaml'], now: new Date('2026-11-24T02:00:00Z') });
const codes = (map, code) => map.findings.filter((f) => f.code === code);

test('no environment value, build arg or command reaches the snapshot', () => {
  const text = JSON.stringify(build());
  assert.ok(!text.includes(SECRET));
  assert.ok(!text.includes('discord.example'));
  assert.ok(!text.includes('http://'));
  assert.ok(!text.includes('/srv/demo'), 'host paths are made relative');
});

test('links come from URL variables that name another service', () => {
  const map = build();
  assert.deepEqual(map.links.map((l) => [l.from, l.to, l.via.join(','), l.networks.join(',')]), [
    ['web', 'api', 'API_URL', 'app-internal'],
    ['worker', 'api', 'API_URL', ''],
  ]);
  assert.equal(codes(map, 'link-unreachable').length, 1);
  assert.deepEqual(codes(map, 'link-unreachable')[0].services, ['worker', 'api']);
});

test('shared networks give reachable pairs; unused ones are reported', () => {
  const map = build();
  const pairs = map.reachable.map((r) => `${r.a}-${r.b}:${r.used}`);
  assert.deepEqual(pairs, ['api-spare:false', 'api-web:true', 'spare-web:false']);
  assert.equal(codes(map, 'reachable-unused').length, 2);
});

test('status prefers the running container and flags problems', () => {
  const map = build();
  const api = map.services.find((s) => s.id === 'api');
  assert.equal(api.status.state, 'running');
  assert.equal(api.status.restartCount, 3);
  assert.equal(map.services.find((s) => s.id === 'worker').status, null);
  assert.deepEqual(codes(map, 'unhealthy').map((f) => f.services[0]), ['api']);
  assert.deepEqual(codes(map, 'not-running').map((f) => f.services[0]), ['worker']);
});

test('hardening, internet access, ports and volumes', () => {
  const map = build();
  const web = map.services.find((s) => s.id === 'web');
  assert.equal(web.internet, true, 'front is not internal');
  assert.deepEqual(web.hardening, { readOnly: true, capDropAll: true, noNewPrivileges: true, memLimitMb: 384, cpus: null, pidsLimit: null, healthcheck: true });
  assert.deepEqual(web.volumes, [{ type: 'bind', source: './data/web', target: '/data', readOnly: true }]);
  assert.deepEqual(web.secrets, ['web_token']);
  assert.deepEqual(web.external, [{ name: 'Discord', purpose: '봇' }]);
  assert.equal(map.services.find((s) => s.id === 'spare').internet, false);
  assert.deepEqual(codes(map, 'port-exposed').map((f) => f.services[0]), ['worker']);
  assert.equal(map.findings[0].level, 'danger', 'most severe first');
});

test('catalog drift both ways', () => {
  const map = build();
  assert.deepEqual(codes(map, 'uncatalogued').map((f) => f.services[0]).sort(), ['spare', 'worker']);
  assert.deepEqual(codes(map, 'catalog-extra').map((f) => f.services[0]), ['ghost']);
});

test('network named internal without internal: true is flagged', () => {
  const config = fixture();
  config.networks['app-internal'] = {};
  const map = buildMap({ config, containers, catalog });
  assert.deepEqual(codes(map, 'internal-has-internet').map((f) => f.services.join(',')), ['api,spare,web']);
});

test('docker inspect lines parse', () => {
  const rows = parseInspectLines('web\trunning\thealthy\t2026-11-24T00:00:00Z\t0\t0\r\napi\texited\t\t\t2\t137\n');
  assert.deepEqual(rows[1], { service: 'api', state: 'exited', health: null, startedAt: null, restartCount: 2, exitCode: 137 });
});
