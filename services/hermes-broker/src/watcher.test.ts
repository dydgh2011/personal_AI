import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Logger } from './broker.js';
import { createWatcher, toEvent, type Watcher } from './watcher.js';

const TOKEN = 'delegator-' + 'k'.repeat(40);
const NKEY = 'notifier-' + 'n'.repeat(40);
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-11-22T03:00:00Z');

const report = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    format: 'agent-worker/v1',
    outcome: 'completed',
    message: 'Created test.txt',
    durationMs: 12345,
    workspace: { path: '/workspace/.worktrees/abc', branch: 'claude/task-abc', commit: 'abcdef1234567', changedFiles: [{ status: 'A', path: 'test.txt' }] },
    ...over,
  });

describe('task watcher', () => {
  let controller: Server;
  let notifier: Server;
  let watcher: Watcher;
  let tasks: Array<Record<string, unknown>>;
  let received: Array<{ key: string; auth?: string; body: Record<string, unknown> }>;
  let notifierStatus: number;
  let listAuth: string | undefined;
  let auth: Array<Record<string, unknown>>;

  const listen = (s: Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

  beforeEach(async () => {
    tasks = [];
    auth = [];
    received = [];
    notifierStatus = 201;
    controller = createServer((req, res) => {
      listAuth = req.headers.authorization;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url === '/workers/auth' ? { items: auth } : { items: tasks, total: tasks.length }));
    });
    notifier = createServer(async (req, res) => {
      let body = '';
      for await (const c of req) body += c;
      received.push({ key: req.headers['x-notifier-key'] as string, body: JSON.parse(body) });
      res.writeHead(notifierStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(notifierStatus === 503 ? { retryAfterSeconds: 30 } : {}));
    });
    const logger: Logger = { info: () => {}, warn: () => {} };
    watcher = createWatcher(
      { controllerUrl: await listen(controller), token: TOKEN, notifierUrl: await listen(notifier), notifierKey: NKEY, intervalMs: 3_600_000, lookbackMs: 3_600_000, hostWorkspaces: 'D:\\personal_ai\\workspaces', timeoutMs: 2000 },
      logger,
      () => NOW,
    );
  });

  afterEach(async () => {
    watcher.stop();
    await new Promise((r) => controller.close(r));
    await new Promise((r) => notifier.close(r));
  });

  const t = (id: string, status: string, minutesAgo: number, extra: Record<string, unknown> = {}) => ({
    id, agent: 'claude', projectId: 'sandbox', status, result: null, error: null,
    updatedAt: new Date(NOW - minutesAgo * 60_000).toISOString(), completedAt: new Date(NOW - minutesAgo * 60_000).toISOString(), ...extra,
  });

  it('reports recently finished tasks once, oldest first, with the notifier key', async () => {
    tasks = [
      t(ID1, 'completed', 2, { result: report() }),
      t(ID2, 'failed', 5, { error: report({ outcome: 'failed', message: 'API Error: 401 OAuth access token has expired' }) }),
      t(ID3, 'running', 0, { completedAt: null }),
    ];
    await watcher.tick();
    assert.equal(listAuth, `Bearer ${TOKEN}`);
    assert.deepEqual(received.map((r) => r.body.key), [`task:${ID2}:failed`, `task:${ID1}:completed`]);
    assert.ok(received.every((r) => r.key === NKEY));
    await watcher.tick();
    assert.equal(received.length, 2, 'already reported tasks are not sent again');
  });

  it('announces a waiting login first, once, and then its result', async () => {
    const session = { id: ID3, status: 'waiting_user', loginUrl: 'https://claude.com/cai/oauth/authorize?x=1', userCode: null, needsCode: true,
      expiresAt: new Date(NOW + 600_000).toISOString(), message: null, updatedAt: new Date(NOW).toISOString() };
    auth = [{ agent: 'claude', loggedIn: false, session }, { agent: 'codex', loggedIn: true, session: null }];
    tasks = [t(ID1, 'completed', 2, { result: report() })];
    await watcher.tick();
    assert.deepEqual(received.map((r) => r.body.key), [`login:${ID3}:waiting`, `task:${ID1}:completed`]);
    assert.deepEqual(received[0].body.login, { agent: 'claude', sessionId: ID3, loginUrl: session.loginUrl, userCode: null, needsCode: true, expiresAt: session.expiresAt });
    await watcher.tick();
    assert.equal(received.length, 2);
    auth = [{ agent: 'claude', loggedIn: true, session: { ...session, status: 'succeeded', message: 'Login completed' } }];
    await watcher.tick();
    assert.equal(received.at(-1)!.body.key, `login:${ID3}:succeeded`);
    assert.equal(received.at(-1)!.body.type, 'login_result');
  });

  it('skips logins that already expired', async () => {
    auth = [{ agent: 'claude', session: { id: ID3, status: 'waiting_user', loginUrl: 'https://claude.com/x', userCode: null, needsCode: true,
      expiresAt: new Date(NOW - 1000).toISOString(), message: null, updatedAt: new Date(NOW - 900_000).toISOString() } }];
    await watcher.tick();
    assert.equal(received.length, 0);
  });

  it('ignores tasks that finished before the lookback window', async () => {
    tasks = [t(ID1, 'completed', 120, { result: report() })];
    await watcher.tick();
    assert.equal(received.length, 0);
  });

  it('retries on the next tick when the notifier could not deliver', async () => {
    tasks = [t(ID1, 'completed', 1, { result: report() })];
    notifierStatus = 502;
    await watcher.tick();
    notifierStatus = 201;
    await watcher.tick();
    assert.equal(received.length, 2);
    await watcher.tick();
    assert.equal(received.length, 2);
  });
});

describe('toEvent', () => {
  it('maps the worker report to the notifier event without inventing facts', () => {
    const e = toEvent(
      { id: ID1, agent: 'claude', projectId: 'sandbox', status: 'completed', result: report(), error: null, updatedAt: '', completedAt: null },
      'D:\\personal_ai\\workspaces',
    );
    assert.deepEqual(e, {
      id: ID1, agent: 'claude', projectId: 'sandbox', status: 'completed', success: true, summary: 'Created test.txt',
      changedFiles: [{ status: 'A', path: 'test.txt' }], branch: 'claude/task-abc', commit: 'abcdef1234567', durationSeconds: 12.3,
      hostPath: 'D:\\personal_ai\\workspaces\\claude\\.worktrees\\abc',
    });
  });

  it('passes plain-text errors (e.g. lease_expired) as the summary', () => {
    const e = toEvent({ id: ID1, agent: 'codex', projectId: null, status: 'failed', result: null, error: 'lease_expired: worker stopped', updatedAt: '', completedAt: null }, '');
    assert.equal(e.summary, 'lease_expired: worker stopped');
    assert.equal(e.success, false);
    assert.equal(e.hostPath, null);
  });
});
