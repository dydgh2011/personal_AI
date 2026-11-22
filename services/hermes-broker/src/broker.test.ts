import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createBroker, type Logger } from './broker.js';

const TOKEN = 'delegator-' + 'k'.repeat(40);
const TASK_ID = '3f1c2a54-0000-4000-8000-000000000000';

describe('hermes-broker', () => {
  let upstream: Server;
  let broker: Server;
  let base: string;
  let seen: Array<{ method: string; url: string; auth?: string; key?: string; body: string }>;
  let reply: (url: string) => { status: number; body: unknown; headers?: Record<string, string> };
  let logs: Array<Record<string, unknown>>;
  let clock: number;

  const listen = (s: Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

  beforeEach(async () => {
    seen = [];
    logs = [];
    clock = 1_000_000;
    reply = (url) => ({ status: url.startsWith('/tasks') && !url.includes('cancel') ? 201 : 200, body: { id: TASK_ID, echo: url } });
    upstream = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, key: req.headers['idempotency-key'] as string, body });
      const r = reply(req.url!);
      res.writeHead(r.status, { 'Content-Type': 'application/json', ...(r.headers ?? {}) });
      res.end(JSON.stringify(r.body));
    });
    const upstreamUrl = await listen(upstream);
    const logger: Logger = { info: (msg, f = {}) => logs.push({ msg, ...f }), warn: (msg, f = {}) => logs.push({ msg, ...f }) };
    broker = createBroker({ controllerUrl: upstreamUrl, token: TOKEN, submitPerMinute: 3, submitPerHour: 5, upstreamTimeoutMs: 2000, clientKey: null }, logger, () => clock);
    base = await listen(broker);
  });

  afterEach(async () => {
    await new Promise((r) => broker.close(r));
    await new Promise((r) => upstream.close(r));
  });

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  const task = { agent: 'claude', projectId: 'sandbox', instruction: 'Create index.html; $(rm -rf /)' };

  it('forwards the allowed operations with the delegator token, which the caller never sees', async () => {
    for (const [method, path] of [
      ['GET', '/system/status'],
      ['GET', '/projects'],
      ['GET', '/projects/sandbox'],
      ['GET', '/projects/sandbox/status?refresh=true'],
      ['GET', '/tasks?agent=codex&status=running&limit=10&offset=0'],
      ['GET', `/tasks/${TASK_ID}`],
      ['POST', `/tasks/${TASK_ID}/cancel`],
      ['GET', `/tasks/${TASK_ID}/diff`],
      ['GET', `/tasks/${TASK_ID}/review`],
    ]) {
      const res = await call(method, path);
      assert.ok(res.status < 300, `${method} ${path} -> ${res.status}`);
      assert.ok(!JSON.stringify(res.body).includes(TOKEN));
    }
    assert.ok(seen.every((s) => s.auth === `Bearer ${TOKEN}`));
    assert.deepEqual(seen.map((s) => s.url), [
      '/system/status', '/projects', '/projects/sandbox', '/projects/sandbox/status?refresh=true',
      '/tasks?agent=codex&status=running&limit=10&offset=0', `/tasks/${TASK_ID}`, `/tasks/${TASK_ID}/cancel`,
      `/tasks/${TASK_ID}/diff`, `/tasks/${TASK_ID}/review`,
    ]);
  });

  it('answers anything else itself without contacting the controller', async () => {
    const cases: Array<[string, string, number]> = [
      ['GET', '/internal/workers/claim', 404],
      ['POST', '/internal/workers/claim', 404],
      ['POST', '/projects', 405],
      ['PATCH', '/projects/sandbox', 405],
      ['GET', '/github/repositories', 404],
      ['GET', '/tasks/not-a-uuid', 404],
      ['GET', '/projects/../internal', 404],
      ['GET', '/tasks?limit=5000', 400],
      ['GET', '/tasks?createdBy=admin', 400],
      ['GET', '/tasks?agent=claude&agent=codex', 400],
      ['DELETE', `/tasks/${TASK_ID}`, 405],
      ['POST', `/tasks/${TASK_ID}/approve`, 404],
      ['POST', `/tasks/${TASK_ID}/reject`, 404],
    ];
    for (const [method, path, expected] of cases) {
      assert.equal((await call(method, path)).status, expected, `${method} ${path}`);
    }
    assert.equal(seen.length, 0);
  });

  it('validates new tasks strictly and adds an idempotency key derived from the content', async () => {
    assert.equal((await call('POST', '/tasks', { ...task, agent: 'gemini' })).status, 400);
    assert.equal((await call('POST', '/tasks', { ...task, projectId: '../etc' })).status, 400);
    assert.equal((await call('POST', '/tasks', { ...task, instruction: '  ' })).status, 400);
    assert.equal((await call('POST', '/tasks', { ...task, instruction: 'x'.repeat(20_001) })).status, 400);
    assert.equal((await call('POST', '/tasks', { ...task, createdBy: 'admin' })).status, 400);
    assert.equal((await call('POST', '/tasks', 'not json')).status, 400);
    assert.equal((await call('POST', '/tasks', [task])).status, 400);
    assert.equal((await call('POST', '/tasks', task, { 'Idempotency-Key': 'bad key!' })).status, 400);
    assert.equal((await call('POST', '/tasks', { instruction: 'x'.repeat(70_000) })).status, 413);
    assert.equal(seen.length, 0);

    assert.equal((await call('POST', '/tasks', task)).status, 201);
    assert.equal((await call('POST', '/tasks', task, { 'Idempotency-Key': 'hermes-auto-1234567890' })).status, 201);
    assert.match(seen[0].key!, /^broker-[0-9a-f]{40}$/);
    assert.equal(seen[1].key, 'hermes-auto-1234567890');
    assert.deepEqual(JSON.parse(seen[0].body), task);
  });

  it('passes the controller status and replay header through, and fails cleanly when it is down', async () => {
    reply = () => ({ status: 200, body: { id: TASK_ID }, headers: { 'Idempotent-Replayed': 'true' } });
    const replay = await call('POST', '/tasks', task);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('idempotent-replayed'), 'true');
    reply = () => ({ status: 400, body: { message: 'Unknown projectId "x"' } });
    assert.deepEqual((await call('POST', '/tasks', { ...task, projectId: 'x' })).body, { message: 'Unknown projectId "x"' });
    await new Promise((r) => upstream.close(r));
    const down = await call('GET', '/system/status');
    assert.equal(down.status, 502);
    assert.equal(down.body.message, 'Controller unreachable');
  });

  it('rate limits newly created tasks per minute and per hour; replays do not count', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/tasks', { ...task, instruction: `t${i}` })).status, 201);
    const limited = await call('POST', '/tasks', { ...task, instruction: 't3' });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.retryAfterSeconds, 60);
    clock += 61_000;
    for (let i = 3; i < 5; i++) assert.equal((await call('POST', '/tasks', { ...task, instruction: `t${i}` })).status, 201);
    const hourly = await call('POST', '/tasks', { ...task, instruction: 't5' });
    assert.equal(hourly.status, 429);
    assert.match(hourly.body.message, /per hour/);
    assert.equal(seen.length, 5);
    clock += 3_600_000;
    reply = () => ({ status: 200, body: { id: TASK_ID }, headers: { 'Idempotent-Replayed': 'true' } });
    for (let i = 0; i < 6; i++) assert.equal((await call('POST', '/tasks', task)).status, 200);
  });

  it('redacts the token if it ever appeared upstream, and audits without instruction text', async () => {
    reply = () => ({ status: 200, body: { leaked: TOKEN } });
    const res = await call('GET', '/system/status');
    assert.deepEqual(res.body, { leaked: '[redacted]' });
    reply = () => ({ status: 201, body: { id: TASK_ID } });
    await call('POST', '/tasks', task);
    const entry = logs.find((l) => l.op === 'tasks.create')!;
    assert.deepEqual(
      { status: entry.status, agent: entry.agent, projectId: entry.projectId, instructionChars: entry.instructionChars, taskId: entry.taskId },
      { status: 201, agent: 'claude', projectId: 'sandbox', instructionChars: task.instruction.length, taskId: TASK_ID },
    );
    assert.ok(!JSON.stringify(logs).includes('rm -rf'));
    assert.ok(!JSON.stringify(logs).includes(TOKEN));
  });

  it('relays worker login requests and codes, validating the code and never logging it', async () => {
    assert.equal((await call('GET', '/workers/auth')).status, 200);
    assert.equal((await call('POST', '/workers/claude/auth/start')).status, 200);
    const ok = await call('POST', '/workers/claude/auth/code', { code: 'AbC123_secret-code#state-xyz' });
    assert.equal(ok.status, 200);
    const forwarded = seen.at(-1)!;
    assert.equal(forwarded.url, '/workers/claude/auth/code');
    assert.deepEqual(JSON.parse(forwarded.body), { code: 'AbC123_secret-code#state-xyz' });
    assert.ok(!JSON.stringify(logs).includes('AbC123_secret-code'), 'the code is not in the audit log');

    const before = seen.length;
    assert.equal((await call('POST', '/workers/gemini/auth/code', { code: 'abcdefgh123' })).status, 404);
    assert.equal((await call('POST', '/workers/claude/auth/code', { code: 'has spaces in it' })).status, 400);
    assert.equal((await call('POST', '/workers/claude/auth/code', { code: 'abcdefgh123', extra: 1 })).status, 400);
    assert.equal((await call('GET', '/internal/workers/auth')).status, 404, 'worker endpoints are not reachable');
    assert.equal(seen.length, before);
  });

  it('forwards planner routes with the planner key only, and nothing else under /planner', async () => {
    const PLANNER_KEY = 'planner-' + 'p'.repeat(40);
    const got: Array<{ method: string; url: string; auth?: string; key?: string; body: string }> = [];
    const planner = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      got.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, key: req.headers['x-planner-key'] as string, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, echo: PLANNER_KEY }));
    });
    const plannerUrl = await listen(planner);
    const withPlanner = createBroker(
      { controllerUrl: 'http://127.0.0.1:9', token: TOKEN, submitPerMinute: 3, submitPerHour: 5, upstreamTimeoutMs: 2000, clientKey: null, planner: { url: plannerUrl, key: PLANNER_KEY }, plannerWritesPerMinute: 3 },
      { info: () => {}, warn: () => {} },
      () => clock,
    );
    const url = await listen(withPlanner);
    const send = (method: string, path: string, body?: unknown) =>
      fetch(url + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    try {
      const day = await send('GET', '/planner/day?date=2026-11-23');
      assert.equal(day.status, 200);
      assert.ok(!(await day.text()).includes(PLANNER_KEY), 'the planner key is redacted from responses');
      assert.equal((await send('POST', '/planner/todos', { title: '장보기', estimateMinutes: 30 })).status, 200);
      assert.equal((await send('POST', `/planner/blocks/${TASK_ID}/remove`)).status, 200);
      assert.equal((await send('POST', '/planner/events/abc123def_20261123T150000Z/update', { scope: 'this' })).status, 200);
      assert.deepEqual(got.map((g) => [g.method, g.url]), [
        ['GET', '/day?date=2026-11-23'],
        ['POST', '/todos'],
        ['POST', `/blocks/${TASK_ID}/remove`],
        ['POST', '/events/abc123def_20261123T150000Z/update'],
      ]);
      assert.ok(got.every((g) => g.key === PLANNER_KEY && g.auth === undefined), 'planner key only, never the controller token');
      assert.equal(got[2].body, '{}');
      assert.equal((await send('POST', '/planner/todos', { title: 'x', estimateMinutes: 30 })).status, 429, 'planner writes are rate limited');
      clock += 61_000;
      for (const [method, path] of [['GET', '/planner/day?date=../x'], ['POST', '/planner/day'], ['GET', '/planner/google_auth'], ['POST', '/planner/blocks/not-a-uuid/remove'], ['POST', '/planner/events/a%2Fb/remove'], ['POST', '/planner/proposals/a/apply'], ['POST', '/planner/import/apply']]) {
        assert.ok([400, 404, 405].includes((await send(method, path)).status), `${method} ${path}`);
      }
      assert.equal(got.length, 4);
    } finally {
      await new Promise((r) => withPlanner.close(r));
      await new Promise((r) => planner.close(r));
    }
    assert.equal((await call('GET', '/planner/status')).status, 503, 'without a planner configured');
  });

  it('requires the client key when configured, before forwarding anything', async () => {
    const key = 'k'.repeat(48);
    const keyed = createBroker({ controllerUrl: base, token: TOKEN, submitPerMinute: 3, submitPerHour: 5, upstreamTimeoutMs: 2000, clientKey: key }, { info: () => {}, warn: () => {} });
    const keyedBase = await listen(keyed);
    try {
      const get = (headers: Record<string, string> = {}) => fetch(keyedBase + '/system/status', { headers }).then((r) => r.status);
      const before = seen.length;
      assert.equal(await get(), 401);
      assert.equal(await get({ 'X-Broker-Key': 'wrong' }), 401);
      assert.equal(seen.length, before, 'rejected requests never reach the controller');
      assert.equal((await fetch(keyedBase + '/health')).status, 200);
      assert.equal(await get({ 'X-Broker-Key': key }), 200);
    } finally {
      await new Promise((r) => keyed.close(r));
    }
  });
});
