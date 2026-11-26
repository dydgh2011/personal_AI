import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createBroker, type Logger } from './broker.js';

const TOKEN = 'delegator-' + 'k'.repeat(40);
const BROKER_KEY = 'hermes-' + 'h'.repeat(40);
const TASK_ID = '3f1c2a54-0000-4000-8000-000000000000';
const config = {
  controllerUrl: 'http://127.0.0.1:9',
  token: TOKEN,
  submitPerMinute: 3,
  submitPerHour: 5,
  upstreamTimeoutMs: 2000,
  clientKey: BROKER_KEY,
};

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
    broker = createBroker({ ...config, controllerUrl: upstreamUrl }, logger, () => clock);
    base = await listen(broker);
  });

  afterEach(async () => {
    await new Promise((r) => broker.close(r));
    await new Promise((r) => upstream.close(r));
  });

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Broker-Key': BROKER_KEY, ...headers },
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

  it('passes a checked model and effort for one task, and changes defaults only with a checked body', async () => {
    for (const bad of [{ model: '--dangerously-skip-permissions' }, { model: 'a b' }, { model: null }, { effort: 'ultra' }, { effort: 7 }]) {
      assert.equal((await call('POST', '/tasks', { ...task, ...bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal(seen.length, 0);
    assert.equal((await call('POST', '/tasks', { ...task, model: 'opus', effort: 'high' })).status, 201);
    assert.deepEqual(JSON.parse(seen[0].body), { ...task, model: 'opus', effort: 'high' });
    assert.equal((await call('POST', '/tasks', task)).status, 201);
    assert.notEqual(seen[0].key, seen[1].key, 'a different model is a different request');

    assert.equal((await call('GET', '/agent-defaults')).status, 200);
    assert.equal((await call('POST', '/agent-defaults/codex', { model: 'gpt-6.1-sol', effort: 'xhigh' })).status, 200);
    assert.deepEqual(JSON.parse(seen.at(-1)!.body), { model: 'gpt-6.1-sol', effort: 'xhigh' });
    assert.equal((await call('POST', '/agent-defaults/claude', { model: null })).status, 200);
    assert.deepEqual(JSON.parse(seen.at(-1)!.body), { model: null });
    const before = seen.length;
    for (const bad of [{}, { model: '-x' }, { effort: 'ultra' }, { effort: 'low', agent: 'codex' }]) {
      assert.equal((await call('POST', '/agent-defaults/claude', bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await call('POST', '/agent-defaults/gemini', { effort: 'low' })).status, 404);
    assert.equal(seen.length, before);
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
      { ...config, planner: { url: plannerUrl, key: PLANNER_KEY }, plannerWritesPerMinute: 3 },
      { info: () => {}, warn: () => {} },
      () => clock,
    );
    const url = await listen(withPlanner);
    const send = (method: string, path: string, body?: unknown) =>
      fetch(url + path, { method, headers: { 'Content-Type': 'application/json', 'X-Broker-Key': BROKER_KEY }, body: body === undefined ? undefined : JSON.stringify(body) });
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
      // dry runs (overlap previews) do not count as writes; the new report/pace/agenda/schedule routes are forwarded
      for (let i = 0; i < 5; i++) {
        assert.equal((await send('POST', '/planner/events', { title: 'x', dryRun: true })).status, 200, `preview ${i}`);
      }
      assert.equal((await send('POST', '/planner/reports', { blockId: TASK_ID, status: 'done' })).status, 200);
      assert.equal((await send('POST', `/planner/todos/${TASK_ID}/schedule`, { date: '2026-11-27', start: '10:00', end: '11:00', dryRun: true })).status, 200);
      assert.equal((await send('GET', '/planner/pace?days=28')).status, 200);
      assert.equal((await send('GET', '/planner/agenda?days=30')).status, 200);
      assert.equal((await send('GET', '/planner/agenda?days=x')).status, 400);
      assert.equal(got.at(-1)!.url, '/agenda?days=30');
      assert.equal((await send('POST', '/planner/todos', { title: 'y', estimateMinutes: 30 })).status, 200);
      assert.equal((await send('POST', '/planner/todos', { title: 'z', estimateMinutes: 30 })).status, 200);
      assert.equal((await send('POST', '/planner/todos', { title: 'w', estimateMinutes: 30 })).status, 429, 'only the 3 real writes counted');
    } finally {
      await new Promise((r) => withPlanner.close(r));
      await new Promise((r) => planner.close(r));
    }
    assert.equal((await call('GET', '/planner/status')).status, 503, 'without a planner configured');
  });

  it('forwards knowledge routes with the knowledge key only, with large bodies and their own rate limit', async () => {
    const KNOWLEDGE_KEY = 'knowledge-' + 'q'.repeat(40);
    const got: Array<{ method: string; url: string; auth?: string; key?: string; planner?: string; size: number }> = [];
    const knowledge = createServer(async (req, res) => {
      let size = 0;
      for await (const chunk of req) size += (chunk as Buffer).length;
      got.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, key: req.headers['x-knowledge-key'] as string, planner: req.headers['x-planner-key'] as string, size });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, echo: KNOWLEDGE_KEY }));
    });
    const knowledgeUrl = await listen(knowledge);
    const broker = createBroker(
      { ...config, knowledge: { url: knowledgeUrl, key: KNOWLEDGE_KEY }, knowledgeWritesPerMinute: 2 },
      { info: () => {}, warn: () => {} },
      () => clock,
    );
    const url = await listen(broker);
    const send = (method: string, path: string, body?: unknown) =>
      fetch(url + path, { method, headers: { 'Content-Type': 'application/json', 'X-Broker-Key': BROKER_KEY }, body: body === undefined ? undefined : JSON.stringify(body) });
    try {
      const search = await send('GET', '/knowledge/search?q=%ED%97%AC%EC%8A%A4&kinds=fact&limit=5');
      assert.equal(search.status, 200);
      assert.ok(!(await search.text()).includes(KNOWLEDGE_KEY), 'the knowledge key is redacted from responses');
      const big = 'x'.repeat(200_000); // a document's text: larger than the planner's 64 KB limit
      assert.equal((await send('POST', '/knowledge/raw/document', { file: 'doc_0123456789ab_a.pdf', text: big })).status, 200);
      assert.equal((await send('GET', `/knowledge/raw/${TASK_ID}?offset=0&limit=8000`)).status, 200);
      assert.equal((await send('POST', `/knowledge/facts/${TASK_ID}`, { remove: true })).status, 200);
      assert.deepEqual(got.map((g) => [g.method, g.url]), [
        ['GET', '/search?q=%ED%97%AC%EC%8A%A4&kinds=fact&limit=5'],
        ['POST', '/raw/document'],
        ['GET', `/raw/${TASK_ID}?offset=0&limit=8000`],
        ['POST', `/facts/${TASK_ID}`],
      ]);
      assert.ok(got[1].size > 200_000);
      assert.ok(got.every((g) => g.key === KNOWLEDGE_KEY && g.auth === undefined && g.planner === undefined), 'knowledge key only');
      assert.equal((await send('POST', '/knowledge/pages', { title: 'x', type: 'topic' })).status, 429, 'knowledge writes are rate limited');
      clock += 61_000;
      for (const [method, path] of [['GET', '/knowledge/search?q=a&admin=1'], ['POST', '/knowledge/search'], ['GET', '/knowledge/raw/../k.db'], ['POST', '/knowledge/facts/not-a-uuid'], ['GET', '/knowledge/export'], ['GET', '/knowledge/graph?x=1'], ['POST', '/knowledge/raw/file'], ['GET', `/knowledge/raw/by-sha/${'a'.repeat(64)}`]]) {
        assert.ok([400, 404, 405].includes((await send(method, path)).status), `${method} ${path}`);
      }
      assert.equal(got.length, 4);
    } finally {
      await new Promise((r) => broker.close(r));
      await new Promise((r) => knowledge.close(r));
    }
    assert.equal((await call('GET', '/knowledge/status')).status, 503, 'without a knowledge store configured');
  });

  it('forwards only the read-only school routes, with the school key', async () => {
    const SCHOOL_KEY = 'school-' + 's'.repeat(40);
    const got: Array<{ method: string; url: string; key?: string; knowledge?: string }> = [];
    const school = createServer(async (req, res) => {
      for await (const _ of req) void _;
      got.push({ method: req.method!, url: req.url!, key: req.headers['x-school-key'] as string, knowledge: req.headers['x-knowledge-key'] as string });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const schoolUrl = await listen(school);
    const broker = createBroker(
      { ...config, school: { url: schoolUrl, key: SCHOOL_KEY } },
      { info: () => {}, warn: () => {} },
      () => clock,
    );
    const url = await listen(broker);
    const send = (method: string, path: string, body?: unknown) =>
      fetch(url + path, { method, headers: { 'Content-Type': 'application/json', 'X-Broker-Key': BROKER_KEY }, body: body === undefined ? undefined : JSON.stringify(body) });
    try {
      assert.equal((await send('GET', '/school/updates?days=3&service=piazza&important=1&limit=20')).status, 200);
      assert.equal((await send('GET', '/school/item?service=quercus&id=stream%3A1%3At')).status, 200);
      assert.equal((await send('POST', '/school/poll', {})).status, 200);
      assert.equal((await send('POST', '/school/settings/mail-rule', { match: '@ads.com', action: 'ignore' })).status, 200);
      assert.equal((await send('GET', '/school/updates?service=gmail')).status, 200);
      assert.equal((await send('GET', '/school/deadlines?all=1')).status, 200);
      assert.equal((await send('POST', '/school/deadlines/decide', { id: 'quercus:1', decision: 'dismissed' })).status, 200);
      assert.deepEqual(got.map((g) => [g.method, g.url]), [
        ['GET', '/updates?days=3&service=piazza&important=1&limit=20'],
        ['GET', '/item?service=quercus&id=stream%3A1%3At'],
        ['POST', '/poll'],
        ['POST', '/settings/mail-rule'],
        ['GET', '/updates?service=gmail'],
        ['GET', '/deadlines?all=1'],
        ['POST', '/deadlines/decide'],
      ]);
      assert.ok(got.every((g) => g.key === SCHOOL_KEY && g.knowledge === undefined));
      for (const [method, path] of [['GET', '/school/updates?service=acorn'], ['GET', '/school/updates?token=1'], ['POST', '/school/updates'], ['GET', '/school/secrets'], ['POST', '/school/login'], ['GET', '/school/deadlines?all=yes'], ['POST', '/school/deadlines']]) {
        assert.ok([400, 404, 405].includes((await send(method, path)).status), `${method} ${path}`);
      }
      assert.equal(got.length, 7);
    } finally {
      await new Promise((r) => broker.close(r));
      await new Promise((r) => school.close(r));
    }
    assert.equal((await call('GET', '/school/status')).status, 503, 'without a school service configured');
  });

  it('requires a valid, independent key to start and authenticates every proxied request', async () => {
    const logger = { info: () => {}, warn: () => {} };
    assert.throws(() => createBroker({ ...config, clientKey: '' }, logger), /key is required/);
    assert.throws(() => createBroker({ ...config, clientKey: TOKEN }, logger), /must differ/);
    assert.throws(() => createBroker({ ...config, learning: { url: base, key: BROKER_KEY } }, logger), /must differ/);
    const get = (headers: Record<string, string> = {}) => fetch(base + '/system/status', { headers }).then((r) => r.status);
    assert.equal(await get(), 401);
    assert.equal(await get({ 'X-Broker-Key': 'wrong' }), 401);
    const duplicateStatus = await new Promise((resolve, reject) => {
      const req = request(base + '/system/status', { headers: { 'X-Broker-Key': [BROKER_KEY, BROKER_KEY] } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject).end();
    });
    assert.equal(duplicateStatus, 401);
    assert.equal(seen.length, 0, 'rejected requests never reach the controller');
    assert.equal((await fetch(base + '/health')).status, 200);
    assert.equal(await get({ 'X-Broker-Key': BROKER_KEY }), 200);
    assert.equal(logs.at(-1)?.caller, 'hermes');
    assert.ok(!JSON.stringify(logs).includes(BROKER_KEY));
  });

  it('forwards learning queries and schedule proposals with only the scoped learning key', async () => {
    const LEARNING_KEY = 'learning-' + 'l'.repeat(40);
    const got: Array<{ method: string; url: string; body: string; key: string | undefined }> = [];
    const learning = createServer(async (req, res) => {
      assert.equal(req.headers.authorization, undefined);
      assert.equal(req.headers['x-broker-key'], undefined);
      assert.equal(req.headers['x-approver'], undefined);
      let body = '';
      for await (const chunk of req) body += chunk;
      got.push({ method: req.method!, url: req.url!, body, key: req.headers['x-learning-key'] as string | undefined });
      res.writeHead(req.method === 'POST' ? 201 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ proposal: { code: 'A', status: 'draft' }, echo: LEARNING_KEY }));
    });
    const proxy = createBroker(
      {
        ...config,
        learning: { url: await listen(learning), key: LEARNING_KEY },
        learningQueriesPerMinute: 5,
        learningProposalsPerMinute: 1,
      },
      { info: (msg, fields) => logs.push({ msg, ...fields }), warn: () => {} },
      () => clock,
    );
    const url = await listen(proxy);
    const send = (method: string, path: string, body?: unknown) => fetch(url + '/learning' + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Broker-Key': BROKER_KEY, 'X-Approver': 'owner' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    try {
      const queries = ['/domains', '/roadmaps', `/roadmaps/${TASK_ID}`, '/schedule/status', '/schedule?period=week&date=2026-11-24'];
      for (const path of queries) assert.equal((await send('GET', path)).status, 200, path);
      const proposal = await send('POST', '/schedule/propose', { date: '2026-11-24', period: 'week' });
      assert.equal(proposal.status, 201);
      assert.ok(!(await proposal.text()).includes(LEARNING_KEY), 'redacts the scoped key from responses');
      assert.deepEqual(got.map((entry) => [entry.method, entry.url]), [...queries.map((path) => ['GET', path]), ['POST', '/schedule/propose']]);
      assert.deepEqual(JSON.parse(got.at(-1)!.body), { date: '2026-11-24', period: 'week' });
      assert.ok(got.every((entry) => entry.key === LEARNING_KEY));
      assert.equal((await send('GET', '/schedule')).status, 429);
      assert.equal((await send('POST', '/schedule/propose', {})).status, 429);
      assert.ok(logs.some((log) => log.op === 'learning.schedule.propose' && log.caller === 'hermes' && log.status === 201));
      assert.ok(!JSON.stringify(logs).includes('2026-11-24'));
      assert.ok(!JSON.stringify(logs).includes(LEARNING_KEY));

      clock += 60_000;
      for (const [method, path, body, status] of [
        ['GET', '/schedule?date=2026-02-30', undefined, 400],
        ['GET', '/schedule?period=year', undefined, 400],
        ['GET', '/schedule?period=day&period=week', undefined, 400],
        ['GET', '/schedule?constructor=day', undefined, 400],
        ['GET', '/roadmaps/not-an-id', undefined, 404],
        ['GET', '/export', undefined, 404],
        ['POST', '/domains', {}, 405],
        ['POST', `/roadmaps/${TASK_ID}/proposals/generate`, {}, 404],
        ['POST', `/roadmaps/${TASK_ID}/proposals/${TASK_ID}/apply`, {}, 404],
        ['POST', '/schedule/confirm', {}, 404],
        ['POST', '/schedule/propose', { period: 'year' }, 400],
        ['POST', '/schedule/propose', { date: '2026-02-30' }, 400],
        ['POST', '/schedule/propose', { deadline: '2026-11-25' }, 400],
        ['POST', '/schedule/propose', { date: 'x'.repeat(1024) }, 413],
      ] as const) {
        assert.equal((await send(method, path, body)).status, status, path);
      }
      assert.equal(got.length, 6, 'invalid requests never reach the learning service');
      assert.equal((await send('GET', '/schedule')).status, 200, 'query limit resets');
      assert.equal((await send('POST', '/schedule/propose', {})).status, 201, 'proposal limit resets');
    } finally {
      await new Promise((resolve) => proxy.close(resolve));
      await new Promise((resolve) => learning.close(resolve));
    }
    assert.equal((await call('GET', '/learning/schedule/status')).status, 503);
  });
});
