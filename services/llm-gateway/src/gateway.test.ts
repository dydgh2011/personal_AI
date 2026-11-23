import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { CLIENT_RIGHTS, type ProviderId } from './config.js';
import { createGateway, type LlmEvent } from './gateway.js';
import { DUMMY_SIGNATURE, redact } from './shape.js';
import { Store } from './store.js';

type Reply = { status: number; body?: unknown; stream?: string[]; headers?: Record<string, string> };
const queues: Partial<Record<ProviderId, Reply[]>> = {};
const seen: Array<{ provider: string; body: Record<string, unknown>; auth: string }> = [];

function ok(content = 'hi', usage = { prompt_tokens: 100, completion_tokens: 10 }): Reply {
  return { status: 200, body: { choices: [{ message: { role: 'assistant', content } }], usage } };
}

let upstream: Server;
let upstreamUrl = '';

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

before(async () => {
  upstream = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const provider = req.url!.split('/')[1] as ProviderId;
    const body = await readBody(req);
    seen.push({ provider, body, auth: String(req.headers.authorization) });
    const reply = queues[provider]?.shift() ?? ok();
    if (reply.stream) {
      res.writeHead(reply.status, { 'Content-Type': 'text/event-stream', ...(reply.headers ?? {}) });
      for (const chunk of reply.stream) res.write(chunk);
      res.end();
      return;
    }
    res.writeHead(reply.status, { 'Content-Type': 'application/json', ...(reply.headers ?? {}) });
    res.end(JSON.stringify(reply.body ?? {}));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
after(() => upstream.close());

const KEYS = { hermes: 'h'.repeat(40), learning: 'l'.repeat(40), dashboard: 'd'.repeat(40) };
let dir: string;
let store: Store;
let gateway: Server;
let base = '';
let events: LlmEvent[];
let clock: Date;

beforeEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway.close(() => r()));
  if (store) store.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), 'llm-gateway-'));
  store = new Store(join(dir, 'gw.db'));
  events = [];
  clock = new Date('2026-11-22T18:00:00Z');
  for (const k of Object.keys(queues)) delete queues[k as ProviderId];
  seen.length = 0;
  gateway = createGateway({
    clients: (Object.keys(KEYS) as Array<keyof typeof KEYS>).map((name) => ({ name, key: KEYS[name], ...CLIENT_RIGHTS[name] })),
    providerKeys: { 'openai-public': 'pub-key', 'openai-private': 'priv-key', gemini: 'gem-key', groq: 'groq-key' },
    store,
    logger: { info: () => {}, warn: () => {} },
    notify: async (e) => {
      events.push(e);
    },
    paidDailyCapUsd: 0.3,
    headersTimeoutMs: 5000,
    idleTimeoutMs: 5000,
    maxRetryWaitMs: 20_000,
    now: () => clock,
    sleep: async () => {},
    baseUrls: {
      'openai-public': `${upstreamUrl}/openai-public`,
      'openai-private': `${upstreamUrl}/openai-private`,
      gemini: `${upstreamUrl}/gemini`,
      groq: `${upstreamUrl}/groq`,
    },
  });
  await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((r) => gateway.close(() => r()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function chat(body: Record<string, unknown>, key = KEYS.hermes): Promise<{ status: number; json: any; text: string; route: string | null }> {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // stream
  }
  return { status: res.status, json, text, route: res.headers.get('x-gateway-route') };
}

const hello = { messages: [{ role: 'user', content: '안녕' }] };

function fillPool(pool: string, provider: ProviderId, model: string, tokens: number, requests = 1) {
  for (let i = 0; i < requests; i++) {
    store.record({
      at: clock, client: 'hermes', alias: 'kelly', provider, model, pool, paid: false, status: 200, outcome: 'ok',
      promptTokens: i === 0 ? tokens : 0, cachedTokens: 0, completionTokens: 0, costUsd: 0, listCostUsd: 0, latencyMs: 1, error: null,
    });
  }
}

describe('auth and aliases', () => {
  it('rejects missing and wrong keys, and aliases the caller may not use', async () => {
    assert.equal((await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await chat({ model: 'kelly', ...hello }, 'x'.repeat(40))).status, 401);
    const r = await chat({ model: 'kelly', ...hello }, KEYS.learning);
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, 'alias_not_allowed');
    assert.equal((await chat({ model: 'gpt-5.4-mini', ...hello })).status, 400);
    assert.equal(seen.length, 0);
  });

  it('lists only the caller aliases', async () => {
    const res = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${KEYS.learning}` } });
    const json = (await res.json()) as { data: Array<{ id: string }> };
    assert.deepEqual(json.data.map((m) => m.id), ['batch', 'kelly-aux']);
  });
});

describe('routing', () => {
  it('sends kelly to the OpenAI public project first and records the usage', async () => {
    const r = await chat({ model: 'kelly', ...hello, store: true, metadata: { a: 1 } });
    assert.equal(r.status, 200);
    assert.equal(r.route, 'openai-public/gpt-5.4-mini');
    assert.equal(seen[0].provider, 'openai-public');
    assert.equal(seen[0].auth, 'Bearer pub-key');
    assert.equal(seen[0].body.model, 'gpt-5.4-mini');
    assert.equal('store' in seen[0].body, false);
    assert.equal('metadata' in seen[0].body, false);
    assert.equal(store.poolUsage('openai-shared-small', clock).tokens, 110);
  });

  it('turns reasoning off for OpenAI tool calls (chat completions rejects both together)', async () => {
    const tools = [{ type: 'function', function: { name: 't', parameters: { type: 'object', properties: {} } } }];
    await chat({ model: 'kelly', ...hello, tools, reasoning_effort: 'medium' });
    assert.equal(seen[0].body.reasoning_effort, 'none');
    await chat({ model: 'kelly', ...hello, reasoning_effort: 'medium' });
    assert.equal(seen[1].body.reasoning_effort, 'medium');
  });

  it('switches to Gemini at 80% of the OpenAI free tokens and tells the owner once', async () => {
    fillPool('openai-shared-small', 'openai-public', 'gpt-5.4-mini', 1_999_000);
    const r1 = await chat({ model: 'kelly', ...hello });
    const r2 = await chat({ model: 'kelly', ...hello });
    assert.equal(r1.route, 'gemini/gemini-3.5-flash-lite');
    assert.equal(r2.route, 'gemini/gemini-3.5-flash-lite');
    assert.equal(events.filter((e) => e.kind === 'free_switch').length, 1);
    // the OpenAI day starts again at 00:00 UTC
    clock = new Date('2026-11-23T00:30:00Z');
    assert.equal((await chat({ model: 'kelly', ...hello })).route, 'openai-public/gpt-5.4-mini');
  });

  it('waits once for a short Gemini 429, falls back on a long one', async () => {
    fillPool('openai-shared-small', 'openai-public', 'gpt-5.4-mini', 2_400_000);
    queues.gemini = [{ status: 429, body: { error: { details: [{ retryDelay: '5s' }] } } }, ok('second try')];
    const r = await chat({ model: 'kelly', ...hello });
    assert.equal(r.status, 200);
    assert.equal(r.json.choices[0].message.content, 'second try');

    queues.gemini = [{ status: 429, headers: { 'retry-after': '3600' }, body: {} }];
    store.setApproval(clock, true, 'hermes');
    const r2 = await chat({ model: 'kelly', ...hello });
    assert.equal(r2.route, 'openai-private/gpt-5.4-nano');
  });

  it('never uses the paid route without approval, asks once, then follows the approval and the daily cap', async () => {
    fillPool('openai-shared-small', 'openai-public', 'gpt-5.4-mini', 2_400_000);
    fillPool('gemini-flash-lite', 'gemini', 'gemini-3.5-flash-lite', 0, 481);
    const r1 = await chat({ model: 'kelly', ...hello });
    assert.equal(r1.status, 429);
    assert.equal(r1.json.error.code, 'free_quota_exhausted');
    await chat({ model: 'kelly', ...hello });
    assert.equal(events.filter((e) => e.kind === 'paid_needed').length, 1);
    assert.equal(seen.filter((s) => s.provider === 'openai-private').length, 0);

    const ctl = await fetch(`${base}/control/paid`, { method: 'POST', headers: { Authorization: `Bearer ${KEYS.hermes}` }, body: JSON.stringify({ enable: true }) });
    assert.equal(ctl.status, 200);
    queues['openai-private'] = [ok('paid', { prompt_tokens: 1_000_000, completion_tokens: 0 })];
    const r2 = await chat({ model: 'kelly', ...hello });
    assert.equal(r2.route, 'openai-private/gpt-5.4-nano');
    assert.ok(Math.abs(store.paidSpend(clock) - 0.2) < 1e-9);

    queues['openai-private'] = [ok('paid', { prompt_tokens: 1_000_000, completion_tokens: 0 })];
    await chat({ model: 'kelly', ...hello }); // 0.4 > 0.3 cap afterwards
    const r3 = await chat({ model: 'kelly', ...hello });
    assert.equal(r3.status, 429);
    assert.equal(r3.json.error.code, 'paid_daily_cap');
    assert.equal(events.filter((e) => e.kind === 'paid_cap').length, 1);

    // approval ends with the owner's day
    clock = new Date('2026-11-23T06:00:00Z');
    assert.equal(store.approval(clock).enabled, false);
  });

  it('skips Groq for prompts over its per-minute size and gives Gemini thought signatures', async () => {
    const big = { model: 'kelly-aux', messages: [{ role: 'user', content: 'x'.repeat(30_000) }] };
    const r = await chat(big);
    assert.equal(r.route, 'gemini/gemini-3.5-flash-lite');
    const history = {
      model: 'kelly-aux',
      messages: [
        { role: 'user', content: 'time?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }], reasoning_content: 'x' },
        { role: 'tool', tool_call_id: 'c1', content: '14:05' },
      ],
    };
    queues.groq = [{ status: 503, body: {} }];
    await chat(history);
    const toGemini = seen.filter((s) => s.provider === 'gemini').at(-1)!.body as any;
    assert.equal(toGemini.messages[1].tool_calls[0].extra_content.google.thought_signature, DUMMY_SIGNATURE);
    assert.equal('reasoning_content' in toGemini.messages[1], false);
    const toGroq = seen.filter((s) => s.provider === 'groq').at(-1)!.body as any;
    assert.equal('extra_content' in toGroq.messages[1].tool_calls[0], false);
  });

  it('private alias goes to the private project without approval but within the cap', async () => {
    const r = await chat({ model: 'private', messages: [{ role: 'user', content: 'my key sk-proj-abcdefghijklmnopqrstuvwxyz123' }] });
    assert.equal(r.route, 'openai-private/gpt-5.4-nano');
    // private: sent as is (the owner chose it); other aliases: redacted
    assert.match(JSON.stringify(seen[0].body), /sk-proj-abcdef/);
    await chat({ model: 'kelly', messages: [{ role: 'user', content: 'my key sk-proj-abcdefghijklmnopqrstuvwxyz123' }] });
    assert.doesNotMatch(JSON.stringify(seen[1].body), /sk-proj-abcdef/);
  });
});

describe('streaming', () => {
  it('passes chunks through and counts the usage chunk', async () => {
    queues['openai-public'] = [{
      status: 200,
      stream: [
        'data: {"choices":[{"delta":{"content":"안"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"녕"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":500,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":300}}}\n\n',
        'data: [DONE]\n\n',
      ],
    }];
    const r = await chat({ model: 'kelly', ...hello, stream: true });
    assert.equal(r.status, 200);
    assert.match(r.text, /안/);
    assert.match(r.text, /\[DONE\]/);
    assert.equal((seen[0].body.stream_options as any).include_usage, true);
    assert.equal(store.poolUsage('openai-shared-small', clock).tokens, 507);
  });
});

describe('usage and control rights', () => {
  it('shows usage to allowed callers only and lets only control callers approve', async () => {
    await chat({ model: 'kelly', ...hello });
    const u = await fetch(`${base}/usage`, { headers: { Authorization: `Bearer ${KEYS.dashboard}` } });
    assert.equal(u.status, 200);
    const json = (await u.json()) as any;
    assert.equal(json.pools[0].tokens, 110);
    assert.equal((await fetch(`${base}/usage`, { headers: { Authorization: `Bearer ${KEYS.learning}` } })).status, 403);
    const ctl = await fetch(`${base}/control/paid`, { method: 'POST', headers: { Authorization: `Bearer ${KEYS.dashboard}` }, body: '{"enable":true}' });
    assert.equal(ctl.status, 403);
  });
});

describe('redaction', () => {
  it('hides keys, passwords and card numbers but not ids', () => {
    const r = redact('키 AIzaSyA1234567890abcdefghijklmnopqrstu 비밀번호: hunter2 카드 4111 1111 1111 1111 디스코드 123456789012345678');
    assert.match(r.text, /\[redacted:api-key\]/);
    assert.match(r.text, /비밀번호: \[redacted:password\]/);
    assert.match(r.text, /\[redacted:card-number\]/);
    assert.match(r.text, /123456789012345678/);
    assert.equal(r.hits, 3);
  });
});
