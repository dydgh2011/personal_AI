import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { formatLoginRequired, formatLoginResult, formatTaskFinished, parseLoginRequired, parseLoginResult, parseTaskFinished } from './format.js';
import { createNotifier, type Logger, type PostResult } from './notifier.js';
import { FileStore, MemoryStore } from './store.js';

const KEY = 'broker-key-' + 'x'.repeat(40);
const WEBHOOK = 'https://discord.com/api/webhooks/123456789/secret-webhook-token-value';
const TASK_ID = '5fd7c36e-ae62-472f-9696-3330a9250853';
const USER = '607593613769179141';

const task = (over: Record<string, unknown> = {}) => ({
  id: TASK_ID,
  agent: 'claude',
  projectId: 'sandbox',
  status: 'completed',
  success: true,
  summary: 'Created hello.html',
  changedFiles: [{ status: 'A', path: 'hello.html' }],
  branch: `claude/task-${TASK_ID}`,
  commit: 'abcdef1234567',
  durationSeconds: 12.3,
  hostPath: 'D:\\personal_ai\\workspaces\\claude\\.worktrees\\x',
  ...over,
});

describe('notifier', () => {
  let server: Server;
  let base: string;
  let posts: Array<{ url: string; body: { content: string; allowed_mentions: unknown } }>;
  let reply: () => PostResult | Promise<PostResult>;
  let logs: Array<Record<string, unknown>>;
  let clock: number;

  beforeEach(async () => {
    posts = [];
    logs = [];
    clock = 1_000_000;
    reply = () => ({ status: 200 });
    const logger: Logger = { info: (msg, f = {}) => logs.push({ msg, ...f }), warn: (msg, f = {}) => logs.push({ msg, ...f }) };
    server = createNotifier(
      { webhookUrl: WEBHOOK, mentionUserId: USER, clients: [{ name: 'hermes-broker', key: KEY }], perMinute: 3, upstreamTimeoutMs: 2000, dashboardUrl: 'http://127.0.0.1:8710' },
      new MemoryStore(),
      logger,
      async (url, body) => {
        posts.push({ url, body: body as never });
        return reply();
      },
      () => clock,
    );
    base = await new Promise<string>((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  const notify = async (body: unknown, key = KEY) => {
    const res = await fetch(`${base}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Notifier-Key': key },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('delivers a task_finished event once, mentioning only the owner', async () => {
    const first = await notify({ type: 'task_finished', key: `task:${TASK_ID}:completed`, task: task() });
    assert.equal(first.status, 201);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, WEBHOOK);
    assert.deepEqual(posts[0].body.allowed_mentions, { parse: [], users: [USER] });
    assert.match(posts[0].body.content, new RegExp(`^<@${USER}> \\*\\*✅ 작업 완료\\*\\*`));
    assert.match(posts[0].body.content, /변경 파일 \(1\): A hello\.html/);
    assert.match(posts[0].body.content, new RegExp(`검토: http://127.0.0.1:8710/tasks/${TASK_ID}`));

    const again = await notify({ type: 'task_finished', key: `task:${TASK_ID}:completed`, task: task() });
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(posts.length, 1, 'a repeated event is not posted twice');
  });

  it('rejects callers without the key and never logs the webhook URL', async () => {
    assert.equal((await notify({ type: 'task_finished', key: 'k-12345678', task: task() }, 'wrong-key')).status, 401);
    assert.equal((await fetch(`${base}/notify`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal(posts.length, 0);
    await notify({ type: 'task_finished', key: 'k-12345678', task: task() });
    assert.ok(!JSON.stringify(logs).includes('secret-webhook-token-value'));
  });

  it('accepts only typed events: no free text, no unknown fields', async () => {
    for (const body of [
      { type: 'message', key: 'k-12345678', content: '@everyone hi' },
      { type: 'login_required', key: 'k-12345678', login: { agent: 'claude', sessionId: '33333333-3333-4333-8333-333333333333', loginUrl: 'https://evil.example/x', userCode: null, needsCode: true, expiresAt: null } },
      { type: 'task_finished', key: 'k-12345678', task: task(), content: 'extra' },
      { type: 'task_finished', key: 'k-12345678', task: task({ text: 'x' }) },
      { type: 'task_finished', key: 'k-12345678', task: task({ id: 'not-a-uuid' }) },
      { type: 'task_finished', key: 'k-12345678', task: task({ status: 'running' }) },
      { type: 'task_finished', key: 'bad key with spaces', task: task() },
    ]) {
      assert.equal((await notify(body)).status, 400, JSON.stringify(body));
    }
    assert.equal(posts.length, 0);
  });

  it('reports Discord failures to the caller and does not mark the event as sent', async () => {
    reply = () => ({ status: 500 });
    assert.equal((await notify({ type: 'task_finished', key: 'k-retry-1', task: task() })).status, 502);
    reply = () => ({ status: 429, retryAfterSeconds: 7 });
    const limited = await notify({ type: 'task_finished', key: 'k-retry-1', task: task() });
    assert.equal(limited.status, 503);
    assert.equal(limited.body.retryAfterSeconds, 7);
    reply = () => ({ status: 204 });
    assert.equal((await notify({ type: 'task_finished', key: 'k-retry-1', task: task() })).status, 201, 'retry succeeds later');
  });

  it('caps messages per minute', async () => {
    for (let i = 0; i < 3; i++) assert.equal((await notify({ type: 'task_finished', key: `k-cap-${i}0000`, task: task() })).status, 201);
    assert.equal((await notify({ type: 'task_finished', key: 'k-cap-30000', task: task() })).status, 429);
    clock += 61_000;
    assert.equal((await notify({ type: 'task_finished', key: 'k-cap-30000', task: task() })).status, 201);
  });
});

describe('templates', () => {
  it('explains failures and flags expired logins', () => {
    const t = parseTaskFinished(task({ status: 'failed', success: false, changedFiles: [], summary: 'Failed to authenticate. API Error: 401 OAuth access token has expired.' }));
    const text = formatTaskFinished(t, null, 'http://127.0.0.1:8710');
    assert.match(text, /^\*\*❌ 작업 실패\*\*/);
    assert.match(text, /내용: Failed to authenticate/);
    assert.match(text, /로그인이 만료/);
    assert.doesNotMatch(text, /검토:/);
  });

  it('neutralises code-span breakouts and stays within the Discord limit', () => {
    const t = parseTaskFinished(task({ summary: '```x``` '.repeat(500), changedFiles: Array.from({ length: 50 }, (_, i) => ({ status: 'M', path: `f${i}` })) }));
    const text = formatTaskFinished(t, USER, 'http://127.0.0.1:8710');
    assert.ok(text.length <= 2000);
    assert.ok(!text.includes('```'));
    assert.match(text, /외 40개/);
  });
});

describe('login messages', () => {
  const SID = '33333333-3333-4333-8333-333333333333';
  it('claude: link plus how to send the code back', () => {
    const l = parseLoginRequired({ agent: 'claude', sessionId: SID, loginUrl: 'https://claude.com/cai/oauth/authorize?code=true&state=x', userCode: null, needsCode: true, expiresAt: '2026-11-22T03:00:00Z' });
    const text = formatLoginRequired(l, USER);
    assert.match(text, /🔑 Claude Worker 로그인이 필요해요/);
    assert.match(text, /<https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true&state=x>/);
    assert.match(text, /@Kelly claude 로그인 코드/);
  });
  it('codex: device code, nothing to send back', () => {
    const text = formatLoginRequired(parseLoginRequired({ agent: 'codex', sessionId: SID, loginUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGHI', needsCode: false, expiresAt: null }), null);
    assert.match(text, /\*\*ABCD-EFGHI\*\*/);
    assert.match(text, /따로 보낼 것은 없어요/);
  });
  it('only links the CLIs\' own sign-in pages', () => {
    for (const loginUrl of ['https://evil.example/login', 'http://claude.com/x', 'https://claude.com.evil.io/x', 'https://claude.com/x y']) {
      assert.throws(() => parseLoginRequired({ agent: 'claude', sessionId: SID, loginUrl, userCode: null, needsCode: true, expiresAt: null }), /sign-in URL/);
    }
  });
  it('reports results', () => {
    assert.match(formatLoginResult(parseLoginResult({ agent: 'claude', sessionId: SID, status: 'succeeded', message: null }), null), /로그인 완료/);
    assert.match(formatLoginResult(parseLoginResult({ agent: 'codex', sessionId: SID, status: 'expired', message: 'Nobody completed the login in time' }), null), /시간이 지났어요/);
  });
});

describe('FileStore', () => {
  it('survives a restart', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'notifier-')), 'sent.json');
    const a = new FileStore(file);
    a.add('hermes-broker:k1', Date.now());
    assert.ok(new FileStore(file).has('hermes-broker:k1'));
    assert.ok(readFileSync(file, 'utf8').includes('k1'));
  });
});
