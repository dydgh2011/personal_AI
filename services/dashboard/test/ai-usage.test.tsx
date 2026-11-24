import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { UsageView } from '@/app/(admin)/ai-usage/view';
import type { LlmUsage } from '@/lib/llm';
import {
  bucketLabels, colorStacks, compact, dailySums, groupStacks, niceTicks, OTHER, periodHref, resolvePeriod, tokenKindStacks,
  type SeriesTotals, type UsageSeries,
} from '@/lib/usage-series';

const dir = mkdtempSync(join(tmpdir(), 'dash-llm-'));
const keyFile = join(dir, 'llm.key');
let llm: typeof import('@/lib/llm');

beforeAll(async () => {
  process.env.LLM_GATEWAY_URL = 'http://llm-gateway.test:8094/';
  process.env.LLM_GATEWAY_KEY_FILE = keyFile;
  llm = await import('@/lib/llm');
});
afterEach(() => vi.unstubAllGlobals());

const T = (o: Partial<SeriesTotals> = {}): SeriesTotals => ({
  calls: 0, ok: 0, errors: 0, rateLimited: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, costUsd: 0, listCostUsd: 0, ...o,
});

function emptySeries(over: Partial<UsageSeries> = {}): UsageSeries {
  const days = ['2026-11-22', '2026-11-23', '2026-11-24'];
  return {
    timeZone: 'America/Toronto', from: days[0], to: days[2], bucket: 'day', by: 'client', generatedAt: '2026-11-24T17:00:00.000Z',
    buckets: days.map((day) => ({ start: `${day}T05:00:00.000Z`, label: day, day, offsetMinutes: -300 })),
    series: [], totals: T(),
    health: days.map(() => ({ calls: 0, errors: 0, rateLimited: 0, otherErrors: 0, p50Ms: null, p95Ms: null })),
    pools: [{ id: 'openai-shared-small', label: 'OpenAI 무료', resetTimeZone: 'UTC', unit: 'tokens', limit: 2_500_000, stopAt: 0.8,
      days: days.map((day) => ({ day, tokens: 0, requests: 0, usedShare: 0 })) }],
    paid: { dailyCapUsd: 0.3, days: days.map((day) => ({ day, spentUsd: 0, calls: 0, approved: false })) },
    kelly: {
      calls: 0, promptTokens: 0, cachedTokens: 0, p50: null, p90: null, max: null,
      bins: [...Array.from({ length: 25 }, (_, i) => ({ from: i * 2000, to: i * 2000 + 2000, calls: 0 })), { from: 50_000, to: null, calls: 0 }],
      messages: { estimated: true, gapSeconds: 20, count: 0, avgCallsPerMessage: null, distribution: ['1', '2', '3', '4', '5', '6+'].map((calls) => ({ calls, messages: 0 })) },
    },
    ...over,
  };
}

function fullSeries(): UsageSeries {
  const base = emptySeries();
  const series = [
    { key: 'hermes', values: [T({ calls: 3, ok: 3, promptTokens: 36_000, cachedTokens: 20_000, completionTokens: 900 }), T(), T({ calls: 1, ok: 0, errors: 1, rateLimited: 1 })] },
    { key: 'school', values: [T(), T({ calls: 2, ok: 2, promptTokens: 8_000, completionTokens: 200 }), T()] },
    { key: '<script>x</script>', values: [T(), T(), T({ calls: 1, ok: 1, promptTokens: 100, completionTokens: 10, costUsd: 0.01 })] },
  ];
  return {
    ...base, series,
    totals: T({ calls: 7, ok: 6, errors: 1, rateLimited: 1, promptTokens: 44_100, cachedTokens: 20_000, completionTokens: 1110, costUsd: 0.01 }),
    health: [
      { calls: 3, errors: 0, rateLimited: 0, otherErrors: 0, p50Ms: 1200, p95Ms: 3000 },
      { calls: 2, errors: 0, rateLimited: 0, otherErrors: 0, p50Ms: 800, p95Ms: 900 },
      { calls: 2, errors: 1, rateLimited: 1, otherErrors: 0, p50Ms: 500, p95Ms: 500 },
    ],
    paid: { dailyCapUsd: 0.3, days: base.paid.days.map((d, i) => ({ ...d, spentUsd: i === 2 ? 0.01 : 0, approved: i === 2 })) },
    kelly: { ...base.kelly, calls: 3, p50: 12_000, p90: 13_000, max: 13_500, bins: base.kelly.bins.map((b) => (b.from === 12_000 ? { ...b, calls: 3 } : b)),
      messages: { ...base.kelly.messages, count: 1, avgCallsPerMessage: 3, distribution: base.kelly.messages.distribution.map((d) => (d.calls === '3' ? { ...d, messages: 1 } : d)) } },
  };
}

const usage: LlmUsage = {
  localDay: '2026-11-24',
  pools: [{ id: 'openai-shared-small', label: 'OpenAI 무료', day: '2026-11-24', resetTimeZone: 'UTC', tokens: 2_100_000, requests: 40, tokensPerDay: 2_500_000, requestsPerDay: null, stopAt: 0.8, usedShare: 0.84 }],
  paid: { approvedToday: true, approvedAt: '2026-11-24T15:00:00Z', spentTodayUsd: 0.01, dailyCapUsd: 0.3 },
  totalSpentUsd: 0.5,
  aliases: { kelly: { description: 'Kelly 대화', routes: ['openai-public/gpt-5.4-mini'] } },
  daily: [],
  recentErrors: [{ at: '2026-11-24T15:01:00.000Z', client: 'hermes', alias: 'kelly', provider: 'openai-public', model: 'gpt-5.4-mini', status: 429, error: '<b>rate</b>' }],
};

describe('period picker', () => {
  const now = new Date('2026-11-25T03:00:00Z'); // 22:00 on 11-24 in Toronto

  it('uses Toronto days and safe defaults', () => {
    expect(resolvePeriod({}, now)).toEqual({ range: '7d', bucket: 'day', by: 'client', from: '2026-11-18', to: '2026-11-24' });
    expect(resolvePeriod({ range: 'today', bucket: 'day' }, now)).toMatchObject({ bucket: 'hour', from: '2026-11-24', to: '2026-11-24' });
    expect(resolvePeriod({ range: '30d', bucket: 'hour', by: 'model' }, now)).toMatchObject({ bucket: 'day', by: 'model', from: '2026-10-26' });
    expect(resolvePeriod({ range: '7d', bucket: 'hour' }, now)).toMatchObject({ bucket: 'hour' });
    expect(resolvePeriod({ range: ['999d'], by: 'provider\'"' }, now)).toMatchObject({ range: '7d', by: 'client' });
  });

  it('builds plain GET links', () => {
    const p = resolvePeriod({ range: '7d', bucket: 'hour', by: 'alias' }, now);
    expect(periodHref(p, { by: 'model' })).toBe('/ai-usage?range=7d&by=model&bucket=hour');
    expect(periodHref(p, { range: '30d', bucket: 'day' })).toBe('/ai-usage?range=30d&by=alias');
  });
});

describe('series transforms', () => {
  it('splits input into uncached and cached and keeps totals', () => {
    const data = fullSeries();
    const kinds = tokenKindStacks(data);
    const sum = (k: string) => kinds.find((x) => x.key === k)!.values.reduce((a, b) => a + b, 0);
    expect(sum('input') + sum('cached')).toBe(data.totals.promptTokens);
    expect(sum('cached')).toBe(data.totals.cachedTokens);
    expect(sum('output')).toBe(data.totals.completionTokens);
    const groups = groupStacks(data);
    expect(groups.flatMap((g) => g.values).reduce((a, b) => a + b, 0)).toBe(data.totals.promptTokens + data.totals.completionTokens);
  });

  it('per-day sums match the /usage daily table', () => {
    const sums = dailySums(fullSeries());
    expect(sums.get('2026-11-22')).toEqual({ calls: 3, prompt: 36_000, cached: 20_000, completion: 900 });
    expect(sums.get('2026-11-24')).toEqual({ calls: 2, prompt: 100, cached: 0, completion: 10 });
  });

  it('folds more than six groups into 기타 and keeps each entity on its own color', () => {
    const data = emptySeries({
      series: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((key, i) => ({ key, values: [T({ promptTokens: 100 - i }), T(), T()] })),
    });
    const stacks = groupStacks(data);
    expect(stacks).toHaveLength(6);
    expect(stacks[5]).toMatchObject({ key: OTHER, label: `${OTHER} (3)`, values: [95 + 94 + 93, 0, 0] });

    const a = colorStacks('client', [{ key: 'school', label: 's', values: [] }, { key: 'hermes', label: 'h', values: [] }]);
    const b = colorStacks('client', [{ key: 'hermes', label: 'h', values: [] }, { key: 'notifier', label: 'n', values: [] }, { key: 'school', label: 's', values: [] }]);
    expect(a.map((x) => [x.key, x.slot])).toEqual([['hermes', 1], ['school', 2]]);
    expect(b.map((x) => [x.key, x.slot])).toEqual([['hermes', 1], ['school', 2], ['notifier', 4]]);
    const unknown = colorStacks('model', [{ key: 'new/model', label: 'n', values: [] }, { key: 'openai-public/gpt-5.4-mini', label: 'm', values: [] }]);
    expect(unknown.map((x) => x.slot)).toEqual([1, 2]);
  });

  it('labels the doubled 01:00 hour on the fall-back day', () => {
    const data = emptySeries({
      bucket: 'hour',
      buckets: [
        { start: '2026-11-01T05:00:00.000Z', label: '2026-11-01 01:00', day: '2026-11-01', offsetMinutes: -240 },
        { start: '2026-11-01T06:00:00.000Z', label: '2026-11-01 01:00', day: '2026-11-01', offsetMinutes: -300 },
        { start: '2026-11-01T07:00:00.000Z', label: '2026-11-01 02:00', day: '2026-11-01', offsetMinutes: -300 },
      ],
    });
    expect(bucketLabels(data)).toEqual(['2026-11-01 01:00 EDT', '2026-11-01 01:00 EST', '2026-11-01 02:00']);
  });

  it('formats and ticks', () => {
    expect([compact(950), compact(1500), compact(12_345), compact(2_500_000)]).toEqual(['950', '1.5K', '12K', '2.5M']);
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(0.33)).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
    expect(niceTicks(13_500)).toEqual([0, 5000, 10_000, 15_000]);
  });
});

describe('AI usage page', () => {
  const period = resolvePeriod({}, new Date('2026-11-24T17:00:00Z'));

  it('renders an empty period without breaking', () => {
    const html = renderToStaticMarkup(<UsageView period={period} series={emptySeries()} usage={null} seriesError={null} usageError={null} />);
    expect(html).toContain('이 기간에는 호출이 없어요');
    expect(html).toContain('이 기간에는 유료 호출이 없어요');
    expect(html).toContain('이 기간에는 Kelly 호출이 없어요');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('Infinity');
  });

  it('keeps the filters and says so when the gateway is down', () => {
    const html = renderToStaticMarkup(
      <UsageView period={period} series={null} usage={null} seriesError="LLM gateway unreachable" usageError="LLM gateway unreachable" />,
    );
    expect(html).toContain('LLM gateway (graphs) unavailable: LLM gateway unreachable');
    expect(html.match(/unavailable/g)).toHaveLength(1);
    expect(html).toContain('href="/ai-usage?range=30d&amp;by=client"');
    expect(html).not.toContain('<svg');
  });

  it('draws every section, marks the landmarks and escapes names from the gateway', () => {
    const html = renderToStaticMarkup(<UsageView period={period} series={fullSeries()} usage={usage} seriesError={null} usageError={null} />);
    for (const t of ['입력 · 캐시 · 출력', '호출자별 토큰', '무료 한도', '하루 상한 $0.30', '승인한 날', '고정 비용', '압축 40K', '메시지 하나당 호출 수', '429 (한도)', '중앙값 (p50)', '표로 보기']) {
      expect(html).toContain(t);
    }
    expect(html).toContain('멈춤 80%');
    expect(html).toContain('오늘(2026-11-24) <strong>84%</strong>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>x');
    expect(html).toContain('&lt;b&gt;rate&lt;/b&gt;');
    expect(html).not.toContain('NaN');
    expect((html.match(/<svg/g) ?? []).length).toBe(8);
  });
});

describe('gateway client', () => {
  it('fails closed without the key and never calls out', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(llm.llmUsageSeries({ from: '2026-11-18', to: '2026-11-24', bucket: 'day', by: 'client' })).rejects.toThrow('LLM gateway key is not configured');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('asks /usage/series server-side with the bearer key', async () => {
    writeFileSync(keyFile, 'k'.repeat(40) + '\n');
    const fetch = vi.fn(async () => new Response(JSON.stringify(emptySeries()), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const data = await llm.llmUsageSeries({ from: '2026-11-18', to: '2026-11-24', bucket: 'day', by: 'model' });
    expect(data.buckets).toHaveLength(3);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://llm-gateway.test:8094/usage/series?from=2026-11-18&to=2026-11-24&bucket=day&by=model');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ' + 'k'.repeat(40));
  });

  it('reports an old gateway, an error status and an unreachable gateway plainly', async () => {
    writeFileSync(keyFile, 'k'.repeat(40));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{}}', { status: 404 })));
    await expect(llm.llmUsageSeries({ from: '2026-11-24', to: '2026-11-24', bucket: 'hour', by: 'client' })).rejects.toThrow('LLM gateway answered 404');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })));
    await expect(llm.llmUsageSeries({ from: '2026-11-24', to: '2026-11-24', bucket: 'hour', by: 'client' })).rejects.toThrow('unexpected answer');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('getaddrinfo ENOTFOUND llm-gateway'); }));
    await expect(llm.llmUsage(7)).rejects.toThrow('LLM gateway unreachable');
  });
});
