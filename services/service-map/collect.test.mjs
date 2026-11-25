// node --test services/service-map/collect.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

import { GATEWAY_QUERY, parseGatewayRows, parseRequestLog } from './calls.mjs';
import { buildMap, parseInspectLines, REPO_ROOT } from './collect.mjs';
import { extractRules, parseBrokerRoutes, parseKnowledgeApi, parseNestController, prettyPath } from './rules.mjs';

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

// ---------------------------------------------------------------- stage 2: allowed operations

// Drift guard: these read the REAL source files. When a route is renamed, removed or written in a way
// the parser cannot read, these fail, so the map cannot silently drift from the code.
const real = extractRules(REPO_ROOT);
const opsOf = (from, to, by) => (real.rules.get(`${from}>${to}`) || []).filter((s) => !by || s.by === by).flatMap((s) => s.ops);
const namesOf = (from, to, by) => opsOf(from, to, by).map((o) => o.name);

test('real code: every parser reads its table', () => {
  assert.deepEqual(real.errors, []);
  assert.ok(real.brokerRoutes.length >= 60, `broker routes: ${real.brokerRoutes.length}`);
  for (const k of ['hermes>hermes-broker', 'hermes-broker>controller', 'hermes-broker>planner', 'hermes-broker>knowledge', 'hermes-broker>school', 'dashboard>knowledge', 'school>knowledge', 'hermes>llm-gateway', 'learning>llm-gateway', 'school>llm-gateway', 'dashboard>llm-gateway', 'dashboard>controller', 'claude-worker>controller', 'codex-worker>controller', 'github-publisher>controller', 'test-runner>controller', '*>notifier']) {
    assert.ok((real.rules.get(k) || []).some((s) => s.ops.length > 0), `no rules for ${k}`);
  }
});

test('real code: hermes-broker ROUTES', () => {
  const byName = new Map(real.brokerRoutes.map((r) => [r.name, r]));
  assert.deepEqual(byName.get('tasks.create'), { name: 'tasks.create', method: 'POST', path: '/tasks', target: 'controller' });
  assert.deepEqual(byName.get('tasks.get'), { name: 'tasks.get', method: 'GET', path: '/tasks/:id', target: 'controller' });
  assert.deepEqual(byName.get('planner.day'), { name: 'planner.day', method: 'GET', path: '/planner/day', target: 'planner' });
  assert.equal(byName.get('knowledge.search')?.target, 'knowledge');
  assert.equal(byName.get('school.updates')?.target, 'school');
  assert.equal(byName.get('auth.start')?.path, '/workers/{claude|codex}/auth/start');
  // The safety property the broker exists for: Hermes cannot approve, reject or publish.
  for (const r of real.brokerRoutes) assert.ok(!/approve|reject|publication/.test(r.path), `${r.name} ${r.path}`);
  // Caller-side sets show the path the callee sees (prefix stripped).
  assert.ok(opsOf('hermes-broker', 'planner', 'hermes-broker').some((o) => o.name === 'planner.day' && o.path === '/day'));
  assert.ok(namesOf('hermes', 'hermes-broker').includes('school.poll'));
});

test('real code: knowledge client allowlists', () => {
  assert.deepEqual(namesOf('school', 'knowledge').sort(), ['raw.add', 'status']);
  const dash = namesOf('dashboard', 'knowledge');
  assert.ok(dash.includes('edit.fact') && dash.includes('graph.view'));
  assert.ok(!dash.includes('purge') && !dash.includes('search') && !dash.includes('raw.list'));
  const broker = namesOf('hermes-broker', 'knowledge', 'knowledge');
  assert.ok(broker.includes('search') && broker.includes('raw.add'));
  assert.ok(!broker.some((n) => n.startsWith('edit.')), 'dashboard-only edits');
  assert.ok(!broker.includes('raw.file') && !broker.includes('raw.bySha'), 'operator-only imports');
});

test('real code: LLM gateway rights per caller', () => {
  const hermes = namesOf('hermes', 'llm-gateway');
  assert.ok(hermes.includes('chat.kelly') && hermes.includes('chat.private') && hermes.includes('control.paid'));
  assert.ok(namesOf('learning', 'llm-gateway').includes('chat.batch'));
  assert.ok(!namesOf('learning', 'llm-gateway').includes('control.paid'));
  assert.ok(!namesOf('school', 'llm-gateway').includes('chat.private'));
  const dash = namesOf('dashboard', 'llm-gateway');
  assert.ok(dash.includes('usage.series') && !dash.some((n) => n.startsWith('chat.')));
  assert.ok(!real.rules.has('operator>llm-gateway'), 'operator is not a service');
});

test('real code: controller roles', () => {
  const key = (from) => opsOf(from, 'controller', 'controller').map((o) => `${o.method} ${o.path}`);
  assert.ok(key('claude-worker').includes('POST /internal/workers/claim'));
  assert.deepEqual(key('claude-worker'), key('codex-worker'));
  const delegator = key('hermes-broker');
  assert.ok(delegator.includes('POST /tasks') && delegator.includes('GET /system/status'));
  assert.ok(!delegator.includes('POST /tasks/:id/approve'), 'delegator cannot approve');
  assert.ok(!delegator.some((k) => k.includes('/internal/')), 'delegator has no worker routes');
  const admin = key('dashboard');
  assert.ok(admin.includes('POST /tasks/:id/approve') && admin.includes('POST /projects'));
  assert.ok(!admin.includes('GET /health'), 'public routes are not per-caller rules');
  assert.ok(key('github-publisher').includes('POST /internal/publisher/claim'));
});

test('real code: notifier event types', () => {
  const names = namesOf('*', 'notifier');
  assert.ok(names.includes('notify.task_finished') && names.includes('notify.school') && names.includes('notify.llm'));
});

test('parsers fail loudly instead of returning less', () => {
  assert.throws(() => parseBrokerRoutes('nothing here'), /ROUTES/);
  assert.throws(() => parseBrokerRoutes("const ROUTES: Route[] = [\n  { method: 'GET', pattern: SOMETHING, name: 'x' },\n];"), /cannot read route/);
  const knowledge = (clientRoutes) =>
    `const CLIENT_ROUTES: Record<string, ReadonlySet<string>> = {\n  school: new Set([${clientRoutes}]),\n};\nconst routes: Route[] = [\n    { method: 'GET', pattern: /^\\/status$/, name: 'status', handler: () => 1 },\n  ];`;
  assert.deepEqual(parseKnowledgeApi(knowledge("'status'")).allowedFor('school').map((o) => o.path), ['/status']);
  assert.throws(() => parseKnowledgeApi(knowledge("'status', 'gone'")), /unknown route gone/);
  const nest = "@Controller('x')\nexport class X {\n  @Get()\n  @Post('y')\n  run() {}\n}\n";
  assert.throws(() => parseNestController(nest, 'x.controller.ts'), /read 1 of 2 handlers/);
});

test('route regexes become readable paths', () => {
  assert.equal(prettyPath('^\\/system\\/status$'), '/system/status');
  assert.equal(prettyPath('^/tasks/${TASK_ID}/diff$'), '/tasks/:id/diff');
  assert.equal(prettyPath('^/edit/facts/(${UUID})/archive$'), '/edit/facts/:id/archive');
  assert.equal(prettyPath('^/projects/${PROJECT_ID}$'), '/projects/:project');
  assert.equal(prettyPath('^\\/raw\\/by-sha\\/([0-9a-f]{64})$'), '/raw/by-sha/:param');
  assert.equal(prettyPath('^/planner/proposals/[A-Z]{1,3}/edit$'), '/planner/proposals/:param/edit');
  assert.equal(prettyPath('^\\/workers\\/(claude|codex)\\/auth\\/start$'), '/workers/{claude|codex}/auth/start');
});

const fakeRules = {
  rules: new Map([
    ['web>api', [{ by: 'api', role: 'callee', source: 'api/src/routes.ts', ops: [{ name: 'items.list', method: 'GET', path: '/items' }, { name: 'items.add', method: 'POST', path: '/items' }] }]],
    ['*>api', [{ by: 'api', role: 'callee', source: 'api/src/health.ts', ops: [{ name: 'ping', method: 'GET', path: '/ping' }] }]],
  ]),
  errors: ['knowledge: services/knowledge/src/api.ts: "const routes" not found'],
};

test('rules attach to links; links without rules and parser errors are findings', () => {
  const map = buildMap({ config: fixture(), containers, catalog, rules: fakeRules });
  const web = map.links.find((l) => l.from === 'web');
  assert.deepEqual(web.allowed.map((s) => `${s.by}:${s.ops.map((o) => o.name).join(',')}`), ['api:items.list,items.add', 'api:ping']);
  const worker = map.links.find((l) => l.from === 'worker');
  assert.deepEqual(worker.allowed.map((s) => s.source), ['api/src/health.ts'], 'wildcard rules apply to every caller');
  assert.equal(codes(map, 'rules-extract-failed').length, 1);
  const noRules = buildMap({ config: fixture(), containers, catalog, rules: { rules: new Map(), errors: [] } });
  assert.deepEqual(codes(noRules, 'link-no-rules').map((f) => f.services.join('>')), ['web>api', 'worker>api']);
});

test('without rules or calls the snapshot keeps its stage-1 shape', () => {
  const map = build();
  assert.equal(map.version, 1);
  assert.ok(map.links.every((l) => !('allowed' in l) && !('calls' in l)));
  assert.ok(!('callWindow' in map));
});

// ---------------------------------------------------------------- stage 3: recent calls

test('request logs keep only client, op and status', () => {
  const log = [
    `2026-11-24T01:00:00.000000000Z {"ts":"2026-11-24T01:00:00Z","level":"info","msg":"request","method":"GET","path":"/knowledge/raw/${SECRET}","op":"knowledge.raw.get","status":200,"durationMs":4}`,
    '{"ts":"2026-11-24T01:00:01Z","level":"info","msg":"request","method":"GET","path":"/health","status":200}',
    '{"ts":"2026-11-22T01:00:00Z","level":"info","msg":"request","op":"old","status":200}',
    '{"ts":"2026-11-24T01:00:02Z","level":"warn","msg":"Unexpected broker error","error":"boom"}',
    'not json "request"',
    '{"ts":"2026-11-24T01:00:03Z","msg":"request","client":"school","op":"raw.add","status":403,"note":"x"}',
    `{"ts":"2026-11-24T01:00:04Z","msg":"request","client":"Bad Name ${SECRET}","op":"a b","status":"200"}`,
  ].join('\n');
  const rows = parseRequestLog(log, { sinceMs: Date.parse('2026-11-23T02:00:00Z') });
  assert.deepEqual(rows, [
    { client: null, op: 'knowledge.raw.get', status: 200 },
    { client: 'school', op: 'raw.add', status: 403 },
    { client: null, op: null, status: null },
  ]);
  assert.ok(!JSON.stringify(rows).includes(SECRET));
});

test('gateway rows are aggregates only', () => {
  const rows = parseGatewayRows('[{"client":"web","alias":"chat","outcome":"ok","n":3},{"client":"web","alias":"chat","outcome":"error","n":1},{"bad":1}]');
  assert.deepEqual(rows, [
    { client: 'web', alias: 'chat', outcome: 'ok', n: 3 },
    { client: 'web', alias: 'chat', outcome: 'error', n: 1 },
  ]);
  assert.throws(() => parseGatewayRows('{"x":1}'));
  assert.match(GATEWAY_QUERY, /readOnly: true/);
  assert.match(GATEWAY_QUERY, /SELECT client, alias, outcome, COUNT\(\*\)/);
  assert.doesNotMatch(GATEWAY_QUERY, /prompt|error\b|messages|INSERT|UPDATE|DELETE/i);
});

function brokerFixture() {
  const services = {
    hermes: { environment: { BROKER_URL: 'http://hermes-broker:8090', GW: 'http://llm-gateway:8094' }, networks: { a: null } },
    'hermes-broker': { environment: { CONTROLLER_URL: 'http://controller:3000', PLANNER_URL: 'http://planner:1', NOTIFIER_URL: 'http://notifier:1' }, networks: { a: null } },
    controller: { networks: { a: null } },
    planner: { environment: { NOTIFIER_URL: 'http://notifier:1' }, networks: { a: null } },
    notifier: { networks: { a: null } },
    'llm-gateway': { networks: { a: null } },
    dashboard: { environment: { GW: 'http://llm-gateway:8094' }, networks: { a: null } },
  };
  return { name: 'demo', services, networks: { a: { internal: true } } };
}

const routes = [
  { name: 'tasks.create', method: 'POST', path: '/tasks', target: 'controller' },
  { name: 'planner.day', method: 'GET', path: '/planner/day', target: 'planner' },
];
const brokerRules = {
  rules: new Map([
    ['hermes>hermes-broker', [{ by: 'hermes-broker', role: 'callee', source: 'b', ops: routes.map(({ name, method, path }) => ({ name, method, path })) }]],
    ['hermes-broker>planner', [{ by: 'hermes-broker', role: 'caller', source: 'b', ops: [{ name: 'planner.day', method: 'GET', path: '/day' }] }]],
    ['hermes>llm-gateway', [{ by: 'llm-gateway', role: 'callee', source: 'g', ops: [{ name: 'chat.kelly', method: 'POST', path: '/v1/chat/completions' }] }]],
    ['dashboard>llm-gateway', [{ by: 'llm-gateway', role: 'callee', source: 'g', ops: [{ name: 'usage', method: 'GET', path: '/usage' }] }]],
    ['*>notifier', [{ by: 'notifier', role: 'callee', source: 'n', ops: [{ name: 'notify.plan', method: 'POST', path: '/notify' }] }]],
  ]),
  errors: [],
};
const r = (op, status, client = null) => ({ client, op, status });
const callData = (over = {}) => ({
  hours: 24,
  since: '2026-11-23T02:00:00.000Z',
  sources: [{ id: 'hermes-broker', ok: true }, { id: 'notifier', ok: true }, { id: 'llm-gateway', ok: true }, { id: 'planner', ok: false, error: '실행 중인 컨테이너 없음' }],
  broker: { routes, rows: [r('tasks.create', 202), r('tasks.create', 429), r('planner.day', 200), r('auth', 401), r(null, 404)] },
  callees: { notifier: [r(null, 200, 'planner'), r(null, 200, 'planner'), r(null, 400, 'hermes-broker'), r(null, 401, null)], planner: null },
  gateway: [{ client: 'hermes', alias: 'kelly', outcome: 'ok', n: 7 }, { client: 'hermes', alias: 'kelly', outcome: 'error', n: 2 }, { client: 'operator', alias: 'batch', outcome: 'ok', n: 5 }],
  ...over,
});

test('calls are counted per link and per operation', () => {
  const map = buildMap({ config: brokerFixture(), catalog, rules: brokerRules, calls: callData() });
  const calls = (from, to) => map.links.find((l) => l.from === from && l.to === to)?.calls;
  const entry = calls('hermes', 'hermes-broker');
  assert.equal(entry.total, 5);
  assert.equal(entry.failed, 3);
  assert.deepEqual(entry.ops.map((o) => `${o.name}:${o.total}/${o.failed}`), ['tasks.create:2/1', '(경로 없음):1/1', 'auth:1/1', 'planner.day:1/0']);
  assert.deepEqual(calls('hermes-broker', 'controller'), { total: 2, failed: 1, ops: [{ name: 'tasks.create', total: 2, failed: 1 }], source: 'hermes-broker 로그 (Kelly 요청 전달분)' });
  assert.equal(calls('hermes-broker', 'planner').total, 1);
  // Background calls of the broker are not in its request log: the notifier's log counts them.
  assert.deepEqual(calls('hermes-broker', 'notifier'), { total: 1, failed: 1, ops: [{ name: 'notify', total: 1, failed: 1 }], source: 'notifier 로그' });
  assert.equal(calls('planner', 'notifier').total, 2);
  assert.deepEqual(calls('hermes', 'llm-gateway').ops, [{ name: 'chat.kelly', total: 9, failed: 2 }]);
  assert.equal(calls('dashboard', 'llm-gateway'), undefined, 'the calls table has no /usage reads: not measured, not zero');
  assert.deepEqual(map.callWindow.sources.find((s) => s.id === 'planner'), { id: 'planner', ok: false, error: '실행 중인 컨테이너 없음' });
  assert.deepEqual(codes(map, 'calls-unavailable').map((f) => f.services[0]), ['planner']);
  assert.equal(codes(map, 'call-outside-rules').length, 0);
});

test('a successful call the code does not allow is flagged', () => {
  const map = buildMap({
    config: brokerFixture(),
    catalog,
    rules: brokerRules,
    calls: callData({ gateway: [{ client: 'hermes', alias: 'private', outcome: 'ok', n: 1 }, { client: 'hermes', alias: 'batch', outcome: 'error', n: 1 }] }),
  });
  assert.deepEqual(codes(map, 'call-outside-rules').map((f) => f.message.match(/\(([^)]*)\)/)[1]), ['chat.private']);
});
