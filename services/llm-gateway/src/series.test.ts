import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { CLIENT_RIGHTS } from './config.js';
import { createGateway } from './gateway.js';
import { offsetMinutes, startOfDay } from './series.js';
import { type CallRecord, Store } from './store.js';

const KEYS = { dashboard: 'd'.repeat(40), learning: 'l'.repeat(40), hermes: 'h'.repeat(40) };
let dir: string;
let store: Store;
let gateway: Server;
let base = '';
let clock: Date;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'llm-series-'));
  store = new Store(join(dir, 'gw.db'));
  clock = new Date('2026-11-24T17:00:00Z'); // 12:00 in Toronto (EST)
  gateway = createGateway({
    clients: (Object.keys(KEYS) as Array<keyof typeof KEYS>).map((name) => ({ name, key: KEYS[name], ...CLIENT_RIGHTS[name] })),
    providerKeys: {},
    store,
    logger: { info: () => {}, warn: () => {} },
    notify: async () => {},
    paidDailyCapUsd: 0.3,
    headersTimeoutMs: 5000,
    idleTimeoutMs: 5000,
    maxRetryWaitMs: 20_000,
    now: () => clock,
    fetchImpl: async () => {
      throw new Error('no upstream in these tests');
    },
  });
  await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => gateway.close(() => r()));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function get(path: string, key: string = KEYS.dashboard): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${key}` } });
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text), text };
}

function call(at: string, over: Partial<CallRecord> = {}): void {
  store.record({
    at: new Date(at), client: 'hermes', alias: 'kelly', provider: 'openai-public', model: 'gpt-5.4-mini', pool: 'openai-shared-small',
    paid: false, status: 200, outcome: 'ok', promptTokens: 1000, cachedTokens: 200, completionTokens: 50, costUsd: 0, listCostUsd: 0.001,
    latencyMs: 800, error: null, ...over,
  });
}

describe('GET /usage/series: access and validation', () => {
  it('needs the usage right and a valid range', async () => {
    assert.equal((await get('/usage/series', KEYS.learning)).status, 403);
    assert.equal((await get('/usage/series', 'x'.repeat(40))).status, 401);
    for (const q of [
      'from=2026-11-31&to=2026-12-01', 'from=yesterday', 'from=2026-11-24&to=2026-11-20', 'bucket=week', 'by=provider',
      'from=2026-08-01&to=2026-11-24', 'from=2026-10-01&to=2026-11-24&bucket=hour',
    ]) {
      const r = await get(`/usage/series?${q}`);
      assert.equal(r.status, 400, q);
      assert.equal(r.json.error.code, 'invalid_request');
    }
    assert.equal((await get('/usage/series?from=2026-08-25&to=2026-11-24')).status, 200); // 92 days
  });

  it('defaults to the last 7 owner days in day buckets, by client', async () => {
    const r = await get('/usage/series');
    assert.equal(r.status, 200);
    assert.equal(r.json.from, '2026-11-18');
    assert.equal(r.json.to, '2026-11-24');
    assert.equal(r.json.bucket, 'day');
    assert.equal(r.json.by, 'client');
    assert.equal(r.json.timeZone, 'America/Toronto');
    assert.equal(r.json.buckets.length, 7);
    const today = await get('/usage/series?from=2026-11-24&to=2026-11-24');
    assert.equal(today.json.bucket, 'hour');
    assert.equal(today.json.buckets.length, 24);
  });
});

describe('GET /usage/series: empty range', () => {
  it('returns zero-filled buckets and no series', async () => {
    const { json } = await get('/usage/series?from=2026-11-20&to=2026-11-22');
    assert.deepEqual(json.buckets.map((b: any) => b.label), ['2026-11-20', '2026-11-21', '2026-11-22']);
    assert.deepEqual(json.series, []);
    assert.equal(json.totals.calls, 0);
    assert.equal(json.totals.promptTokens, 0);
    assert.equal(json.health.length, 3);
    assert.deepEqual(json.health[0], { calls: 0, errors: 0, rateLimited: 0, otherErrors: 0, p50Ms: null, p95Ms: null });
    assert.equal(json.paid.days.length, 3);
    assert.ok(json.paid.days.every((d: any) => d.spentUsd === 0 && d.approved === false));
    assert.equal(json.pools.length, 3);
    assert.ok(json.pools.every((p: any) => p.days.length === 3 && p.days.every((d: any) => d.usedShare === 0)));
    assert.equal(json.kelly.calls, 0);
    assert.equal(json.kelly.p50, null);
    assert.equal(json.kelly.messages.avgCallsPerMessage, null);
    assert.equal(json.kelly.bins.reduce((a: number, b: any) => a + b.calls, 0), 0);
  });
});

describe('GET /usage/series: bucket edges in America/Toronto', () => {
  it('puts calls on either side of local midnight into the right day and hour', async () => {
    call('2026-11-23T04:59:59.000Z'); // 2026-11-22 23:59:59 EST
    call('2026-11-23T05:00:00.000Z', { promptTokens: 2000 }); // 2026-11-23 00:00:00 EST
    const day = await get('/usage/series?from=2026-11-22&to=2026-11-23&bucket=day');
    const v = day.json.series[0].values;
    assert.equal(v[0].promptTokens, 1000);
    assert.equal(v[1].promptTokens, 2000);
    assert.equal(day.json.buckets[1].start, '2026-11-23T05:00:00.000Z');

    const hour = await get('/usage/series?from=2026-11-22&to=2026-11-23&bucket=hour');
    assert.equal(hour.json.buckets.length, 48);
    assert.equal(hour.json.buckets[0].start, '2026-11-22T05:00:00.000Z');
    assert.equal(hour.json.buckets[23].label, '2026-11-22 23:00');
    assert.equal(hour.json.buckets[24].label, '2026-11-23 00:00');
    const hv = hour.json.series[0].values;
    assert.equal(hv[23].promptTokens, 1000);
    assert.equal(hv[24].promptTokens, 2000);
    assert.equal(hv.reduce((a: number, x: any) => a + x.calls, 0), 2);
  });

  it('has 25 hours on the fall-back day and 23 on the spring-forward day', async () => {
    call('2026-11-01T05:30:00.000Z'); // first 01:30 (EDT, -4)
    call('2026-11-01T06:30:00.000Z'); // second 01:30 (EST, -5)
    const fall = await get('/usage/series?from=2026-11-01&to=2026-11-01&bucket=hour');
    assert.equal(fall.json.buckets.length, 25);
    const ones = fall.json.buckets.filter((b: any) => b.label === '2026-11-01 01:00');
    assert.deepEqual(ones.map((b: any) => b.offsetMinutes), [-240, -300]);
    const counts = fall.json.series[0].values.map((x: any) => x.calls);
    assert.equal(counts[1], 1);
    assert.equal(counts[2], 1);

    const spring = await get('/usage/series?from=2026-03-08&to=2026-03-08&bucket=hour');
    assert.equal(spring.json.buckets.length, 23);
    assert.ok(!spring.json.buckets.some((b: any) => b.label === '2026-03-08 02:00'));
  });

  it('finds local midnight across DST', () => {
    assert.equal(startOfDay('America/Toronto', '2026-07-01').toISOString(), '2026-07-01T04:00:00.000Z');
    assert.equal(startOfDay('America/Toronto', '2026-12-01').toISOString(), '2026-12-01T05:00:00.000Z');
    assert.equal(startOfDay('America/Toronto', '2026-11-01').toISOString(), '2026-11-01T04:00:00.000Z');
    assert.equal(offsetMinutes('America/Toronto', new Date('2026-11-01T06:30:00Z')), -300);
  });
});

describe('GET /usage/series: totals agree with GET /usage', () => {
  it('series sums per day equal the daily table, for every grouping and bucket size', async () => {
    const mix: Array<[string, Partial<CallRecord>]> = [
      ['2026-11-18T13:00:00Z', { client: 'hermes', alias: 'kelly', promptTokens: 12_000, cachedTokens: 9_000, completionTokens: 300 }],
      ['2026-11-19T03:30:00Z', { client: 'school', alias: 'kelly-aux', provider: 'groq', model: 'openai/gpt-oss-20b', pool: 'groq-gpt-oss-20b', promptTokens: 4_000, cachedTokens: 0, completionTokens: 120, listCostUsd: 0 }],
      ['2026-11-19T04:59:00Z', { client: 'learning', alias: 'batch', provider: 'gemini', model: 'gemini-3.5-flash-lite', pool: 'gemini-flash-lite', promptTokens: 8_000, cachedTokens: 0, completionTokens: 2_000, listCostUsd: 0 }],
      ['2026-11-20T15:00:00Z', { client: 'hermes', alias: 'kelly', provider: 'openai-private', model: 'gpt-5.4-nano', pool: null, paid: true, costUsd: 0.0123, listCostUsd: 0.0123, promptTokens: 14_000, cachedTokens: 0, completionTokens: 900 }],
      ['2026-11-20T15:01:00Z', { client: 'hermes', alias: 'kelly', status: 429, outcome: 'error', promptTokens: 0, cachedTokens: 0, completionTokens: 0, listCostUsd: 0, error: '429: Rate limit reached for org-abc' }],
      ['2026-11-22T22:00:00Z', { client: 'notifier', alias: 'kelly-aux', provider: 'groq', model: 'openai/gpt-oss-20b', pool: 'groq-gpt-oss-20b', status: 0, outcome: 'error', promptTokens: 0, cachedTokens: 0, completionTokens: 0, listCostUsd: 0, error: 'network: boom' }],
      ['2026-11-24T16:00:00Z', { client: 'hermes', alias: 'kelly', promptTokens: 41_000, cachedTokens: 30_000, completionTokens: 700, listCostUsd: 0.0105 }],
    ];
    for (const [at, over] of mix) call(at, over);

    const daily = (await get('/usage?days=7')).json.daily as Array<Record<string, any>>;
    const want = new Map<string, number[]>();
    for (const d of daily) {
      const w = want.get(d.day) ?? [0, 0, 0, 0, 0, 0];
      [d.calls, d.ok, d.prompt_tokens, d.cached_tokens, d.completion_tokens, d.cost_usd].forEach((x: number, i: number) => (w[i] += Number(x)));
      want.set(d.day, w);
    }
    assert.equal(want.size, 4); // 11-18 (three calls, two of them late evening in Toronto), 11-20, 11-22, 11-24

    for (const by of ['client', 'alias', 'model']) {
      for (const bucket of ['day', 'hour']) {
        const { json } = await get(`/usage/series?from=2026-11-18&to=2026-11-24&bucket=${bucket}&by=${by}`);
        const got = new Map<string, number[]>();
        json.buckets.forEach((b: any, i: number) => {
          for (const s of json.series) {
            const v = s.values[i];
            if (!v.calls) continue;
            const g = got.get(b.day) ?? [0, 0, 0, 0, 0, 0];
            [v.calls, v.ok, v.promptTokens, v.cachedTokens, v.completionTokens, v.costUsd].forEach((x: number, k: number) => (g[k] += x));
            got.set(b.day, g);
          }
        });
        for (const [day, w] of want) {
          const g = got.get(day)!;
          assert.ok(g, `${by}/${bucket} missing ${day}`);
          assert.deepEqual(g.slice(0, 5), w.slice(0, 5), `${by}/${bucket} ${day}`);
          assert.ok(Math.abs(g[5] - w[5]) < 1e-6, `${by}/${bucket} cost ${day}`);
        }
        assert.equal(json.totals.calls, 7);
        assert.equal(json.totals.errors, 2);
        assert.equal(json.totals.rateLimited, 1);
      }
    }
    const byModel = (await get('/usage/series?from=2026-11-18&to=2026-11-24&by=model')).json;
    assert.deepEqual(byModel.series.map((s: any) => s.key).sort(), [
      'gemini/gemini-3.5-flash-lite', 'groq/openai/gpt-oss-20b', 'openai-private/gpt-5.4-nano', 'openai-public/gpt-5.4-mini',
    ]);
  });

  it('never returns error text or raw rows', async () => {
    call('2026-11-24T15:00:00Z', { status: 500, outcome: 'error', error: '500: upstream said SECRET-ish detail', promptTokens: 0, cachedTokens: 0, completionTokens: 0 });
    const { text, json } = await get('/usage/series?from=2026-11-24&to=2026-11-24');
    assert.ok(!text.includes('SECRET-ish'));
    assert.ok(!text.includes('"error":'));
    assert.equal(json.health.reduce((a: number, h: any) => a + h.otherErrors, 0), 1);
  });
});

describe('GET /usage/series: pools, paid, Kelly', () => {
  it('reports pool share per pool day, paid spend with approvals, and the Kelly prompt-size picture', async () => {
    // Pool: 1.0M ok tokens on UTC day 2026-11-23 of the OpenAI shared pool (limit 2.5M).
    call('2026-11-23T12:00:00Z', { promptTokens: 900_000, cachedTokens: 0, completionTokens: 100_000 });
    // Paid on 11-23, approved that day.
    call('2026-11-23T13:00:00Z', { provider: 'openai-private', model: 'gpt-5.4-nano', pool: null, paid: true, costUsd: 0.25, listCostUsd: 0.25, promptTokens: 12_000 });
    store.setApproval(new Date('2026-11-23T12:30:00Z'), true, 'hermes');
    // One Kelly message = three calls close together; a later message = one call.
    call('2026-11-24T14:00:00Z', { promptTokens: 11_500, latencyMs: 2_000 });
    call('2026-11-24T14:00:05Z', { promptTokens: 12_400, latencyMs: 3_000 });
    call('2026-11-24T14:00:12Z', { promptTokens: 13_900, latencyMs: 4_000 });
    call('2026-11-24T16:00:00Z', { promptTokens: 55_000, latencyMs: 9_000 });
    call('2026-11-24T16:00:01Z', { alias: 'kelly-aux', promptTokens: 3_000 }); // not Kelly
    call('2026-11-24T16:30:00Z', { status: 429, outcome: 'error', promptTokens: 0, cachedTokens: 0, completionTokens: 0 }); // failed: not counted

    const { json } = await get('/usage/series?from=2026-11-23&to=2026-11-24');
    const openai = json.pools.find((p: any) => p.id === 'openai-shared-small');
    assert.equal(openai.stopAt, 0.8);
    assert.equal(openai.unit, 'tokens');
    // Toronto 11-24 noon is still UTC 11-24, so the pool range ends at 11-24.
    const d23 = openai.days.find((d: any) => d.day === '2026-11-23');
    assert.equal(d23.tokens, 1_000_000); // the paid call is in no pool
    assert.equal(d23.usedShare, 0.4);

    assert.deepEqual(json.paid.days.map((d: any) => [d.day, d.spentUsd, d.approved]), [['2026-11-23', 0.25, true], ['2026-11-24', 0, false]]);
    assert.equal(json.paid.dailyCapUsd, 0.3);

    const k = json.kelly;
    assert.equal(k.calls, 6); // 11-23 big pool call + paid call + four on 11-24
    const bin = (n: number) => k.bins.find((b: any) => b.from <= n && (b.to === null || n < b.to)).calls;
    assert.equal(bin(12_000), 3); // 12,000 (paid), 12,400, 13,900 in the 12k–14k bin
    assert.equal(bin(11_500), 1);
    assert.equal(bin(55_000), 2); // the open 50k+ bin holds 55,000 and 900,000
    assert.equal(k.bins[k.bins.length - 1].to, null);
    assert.ok(k.bins.some((b: any) => b.from === 40_000));
    assert.equal(k.max, 900_000);
    assert.equal(k.messages.estimated, true);
    assert.deepEqual(k.messages.distribution.map((d: any) => d.messages), [3, 0, 1, 0, 0, 0]);
    assert.equal(k.messages.count, 4);
  });

  it('extends pool days to the pool’s own "tomorrow" in the Toronto evening', async () => {
    clock = new Date('2026-11-25T03:00:00Z'); // 22:00 on 11-24 in Toronto, already 11-25 in UTC
    call('2026-11-25T02:00:00Z', { promptTokens: 5_000, cachedTokens: 0, completionTokens: 0 });
    const { json } = await get('/usage/series?from=2026-11-24&to=2026-11-24');
    const openai = json.pools.find((p: any) => p.id === 'openai-shared-small');
    assert.deepEqual(openai.days.map((d: any) => d.day), ['2026-11-24', '2026-11-25']);
    assert.equal(openai.days[1].tokens, 5_000);
    const gemini = json.pools.find((p: any) => p.id === 'gemini-flash-lite'); // Pacific day is still 11-24
    assert.deepEqual(gemini.days.map((d: any) => d.day), ['2026-11-24']);
  });
});
