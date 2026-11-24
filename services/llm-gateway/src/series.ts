import type { DatabaseSync } from 'node:sqlite';
import { POOLS } from './config.js';
import { dayIn, OWNER_TIME_ZONE } from './store.js';

/**
 * Read-only aggregates for the usage graphs (GET /usage/series). Everything here is a SUM,
 * COUNT or percentile over the `calls` table; no row, error text or message content leaves.
 * Day buckets are the owner's local days (America/Toronto, the same `local_day` column that
 * GET /usage groups by), so per-day totals here equal the daily table there.
 */

export type Bucket = 'hour' | 'day';
export type GroupBy = 'client' | 'alias' | 'model';

export const MAX_DAYS: Record<Bucket, number> = { hour: 31, day: 92 };
/** Kelly prompt-size histogram: 2k-wide bins up to 50k, then one open bin. */
export const KELLY_BIN = 2_000;
export const KELLY_BINS_TO = 50_000;
/** A new Kelly "message" starts when the next call begins this long after the previous one ended. */
export const TURN_GAP_MS = 20_000;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export class SeriesError extends Error {}

export interface Totals {
  calls: number;
  ok: number;
  errors: number;
  rateLimited: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  costUsd: number;
  listCostUsd: number;
}

export interface SeriesQuery {
  from: string;
  to: string;
  bucket: Bucket;
  by: GroupBy;
}

const zero = (): Totals => ({
  calls: 0, ok: 0, errors: 0, rateLimited: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, costUsd: 0, listCostUsd: 0,
});

/** Minutes the zone is ahead of UTC at that instant (Toronto: -300 in winter, -240 in summer). */
export function offsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((wall - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** The instant a local day starts in the zone (midnight never falls in a DST gap in Toronto). */
export function startOfDay(timeZone: string, day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d);
  let t = wall;
  for (let i = 0; i < 3; i++) t = wall - offsetMinutes(timeZone, new Date(t)) * 60_000;
  return new Date(t);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

function validDay(s: string): boolean {
  return DAY_RE.test(s) && addDays(s, 0) === s;
}

/** Parse and bound the query string. Defaults: the last 7 local days, by client, day buckets (hours for 1–2 days). */
export function parseSeriesQuery(q: URLSearchParams, at: Date): SeriesQuery {
  const today = dayIn(OWNER_TIME_ZONE, at);
  const to = q.get('to') ?? today;
  const from = q.get('from') ?? addDays(to, -6);
  if (!validDay(from) || !validDay(to)) throw new SeriesError('from and to must be dates like 2026-11-24');
  if (from > to) throw new SeriesError('from must not be after to');
  const span = daysBetween(from, to).length;
  const bucketRaw = q.get('bucket') ?? (span <= 2 ? 'hour' : 'day');
  if (bucketRaw !== 'hour' && bucketRaw !== 'day') throw new SeriesError('bucket must be hour or day');
  const byRaw = q.get('by') ?? 'client';
  if (byRaw !== 'client' && byRaw !== 'alias' && byRaw !== 'model') throw new SeriesError('by must be client, alias or model');
  if (span > MAX_DAYS[bucketRaw]) throw new SeriesError(`At most ${MAX_DAYS[bucketRaw]} days with ${bucketRaw} buckets`);
  return { from, to, bucket: bucketRaw, by: byRaw };
}

/** Linear-interpolated percentile of an ascending list. */
export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo));
}

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

const GROUP_SQL: Record<GroupBy, string> = {
  client: 'client',
  alias: 'alias',
  model: "provider || '/' || model",
};

interface BucketDef {
  /** UTC instant the bucket starts. */
  start: string;
  /** Owner-local label: "2026-11-24" or "2026-11-24 13:00". */
  label: string;
  /** Owner-local day the bucket belongs to. */
  day: string;
  /** Owner's UTC offset in minutes at the bucket start (tells the two 01:00 hours apart on the fall-back day). */
  offsetMinutes: number;
}

function buildBuckets(q: SeriesQuery): { buckets: BucketDef[]; index: (key: string) => number | undefined } {
  const tz = OWNER_TIME_ZONE;
  const days = daysBetween(q.from, q.to);
  if (q.bucket === 'day') {
    const buckets = days.map((day) => {
      const start = startOfDay(tz, day);
      return { start: start.toISOString(), label: day, day, offsetMinutes: offsetMinutes(tz, start) };
    });
    const pos = new Map(days.map((d, i) => [d, i]));
    return { buckets, index: (k) => pos.get(k) };
  }
  // Toronto offsets are whole hours, so each UTC hour is exactly one local hour.
  const begin = startOfDay(tz, q.from).getTime();
  const end = startOfDay(tz, addDays(q.to, 1)).getTime();
  const buckets: BucketDef[] = [];
  const pos = new Map<string, number>();
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' });
  for (let t = begin; t < end; t += 3_600_000) {
    const at = new Date(t);
    const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
    const day = `${p.year}-${p.month}-${p.day}`;
    pos.set(at.toISOString().slice(0, 13), buckets.length);
    buckets.push({ start: at.toISOString(), label: `${day} ${p.hour}:00`, day, offsetMinutes: offsetMinutes(tz, at) });
  }
  return { buckets, index: (k) => pos.get(k) };
}

export interface SeriesOptions {
  paidDailyCapUsd: number;
  now: Date;
}

export function usageSeries(db: DatabaseSync, q: SeriesQuery, opts: SeriesOptions) {
  const { buckets, index } = buildBuckets(q);
  const bucketSql = q.bucket === 'day' ? 'local_day' : 'substr(at, 1, 13)';
  const groupSql = GROUP_SQL[q.by];
  const range = [q.from, q.to] as const;

  // --- tokens, calls, errors and cost per bucket and group
  const rows = db
    .prepare(
      `SELECT ${bucketSql} AS b, ${groupSql} AS g, COUNT(*) AS calls,
              SUM(CASE WHEN outcome = 'ok' THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS errors,
              SUM(CASE WHEN status = 429 THEN 1 ELSE 0 END) AS rate_limited,
              SUM(prompt_tokens) AS prompt, SUM(cached_tokens) AS cached, SUM(completion_tokens) AS completion,
              SUM(cost_usd) AS cost, SUM(list_cost_usd) AS list_cost
         FROM calls WHERE local_day BETWEEN ? AND ? GROUP BY 1, 2`,
    )
    .all(...range) as Array<Record<string, number | string>>;

  const byGroup = new Map<string, Totals[]>();
  const totals = zero();
  const perBucket = buckets.map(() => zero());
  for (const r of rows) {
    const i = index(String(r.b));
    if (i === undefined) continue;
    const g = String(r.g);
    if (!byGroup.has(g)) byGroup.set(g, buckets.map(() => zero()));
    const add = (t: Totals) => {
      t.calls += Number(r.calls);
      t.ok += Number(r.ok);
      t.errors += Number(r.errors);
      t.rateLimited += Number(r.rate_limited);
      t.promptTokens += Number(r.prompt);
      t.cachedTokens += Number(r.cached);
      t.completionTokens += Number(r.completion);
      t.costUsd += Number(r.cost);
      t.listCostUsd += Number(r.list_cost);
    };
    add(byGroup.get(g)![i]);
    add(perBucket[i]);
    add(totals);
  }
  const tidy = (t: Totals): Totals => ({ ...t, costUsd: round(t.costUsd, 6), listCostUsd: round(t.listCostUsd, 6) });
  const series = [...byGroup.entries()]
    .map(([key, values]) => {
      const sum = values.reduce((a, v) => a + v.promptTokens + v.completionTokens, 0);
      const calls = values.reduce((a, v) => a + v.calls, 0);
      return { key, tokens: sum, calls, values: values.map(tidy) };
    })
    .sort((a, b) => b.tokens - a.tokens || b.calls - a.calls || a.key.localeCompare(b.key))
    .map(({ key, values }) => ({ key, values }));

  // --- latency of successful calls per bucket (percentiles only)
  const lat = db
    .prepare(`SELECT ${bucketSql} AS b, latency_ms AS ms FROM calls WHERE local_day BETWEEN ? AND ? AND outcome = 'ok' AND status = 200`)
    .all(...range) as Array<{ b: string; ms: number }>;
  const latLists = buckets.map(() => [] as number[]);
  for (const r of lat) {
    const i = index(String(r.b));
    if (i !== undefined) latLists[i].push(Number(r.ms));
  }
  const health = perBucket.map((t, i) => {
    const sorted = latLists[i].sort((a, b) => a - b);
    return {
      calls: t.calls, errors: t.errors, rateLimited: t.rateLimited,
      otherErrors: t.errors - Math.min(t.errors, t.rateLimited),
      p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95),
    };
  });

  // --- free pools: share of each pool's own daily limit per pool day (UTC / Pacific days)
  const today = dayIn(OWNER_TIME_ZONE, opts.now);
  const pools = Object.values(POOLS).map((p) => {
    const poolToday = dayIn(p.resetTimeZone, opts.now);
    // The pool's day can already be "tomorrow" while it is evening in Toronto.
    const poolTo = q.to >= today && poolToday > q.to ? poolToday : q.to;
    const used = db
      .prepare(
        `SELECT pool_day AS day, COALESCE(SUM(CASE WHEN outcome = 'ok' THEN prompt_tokens + completion_tokens ELSE 0 END), 0) AS tokens,
                COUNT(*) AS requests
           FROM calls WHERE pool = ? AND status > 0 AND pool_day BETWEEN ? AND ? GROUP BY 1`,
      )
      .all(p.id, q.from, poolTo) as Array<{ day: string; tokens: number; requests: number }>;
    const byDay = new Map(used.map((u) => [u.day, u]));
    return {
      id: p.id, label: p.label, resetTimeZone: p.resetTimeZone, unit: p.tokensPerDay !== null ? 'tokens' : 'requests',
      limit: p.tokensPerDay ?? p.requestsPerDay, stopAt: p.stopAt,
      days: daysBetween(q.from, poolTo).map((day) => {
        const u = byDay.get(day);
        const tokens = Number(u?.tokens ?? 0);
        const requests = Number(u?.requests ?? 0);
        const share = p.tokensPerDay !== null ? tokens / p.tokensPerDay : requests / (p.requestsPerDay ?? 1);
        return { day, tokens, requests, usedShare: round(share, 4) };
      }),
    };
  });

  // --- paid: spend per owner day against the cap, and the days the owner allowed paid fallback
  const spend = db
    .prepare(`SELECT local_day AS day, SUM(cost_usd) AS usd, COUNT(*) AS calls FROM calls WHERE paid = 1 AND local_day BETWEEN ? AND ? GROUP BY 1`)
    .all(...range) as Array<{ day: string; usd: number; calls: number }>;
  const approvals = db.prepare(`SELECT day, enabled FROM approvals WHERE day BETWEEN ? AND ?`).all(...range) as Array<{ day: string; enabled: number }>;
  const spendByDay = new Map(spend.map((s) => [s.day, s]));
  const approved = new Map(approvals.map((a) => [a.day, a.enabled === 1]));
  const paid = {
    dailyCapUsd: opts.paidDailyCapUsd,
    days: daysBetween(q.from, q.to).map((day) => ({
      day,
      spentUsd: round(Number(spendByDay.get(day)?.usd ?? 0), 6),
      calls: Number(spendByDay.get(day)?.calls ?? 0),
      approved: approved.get(day) ?? false,
    })),
  };

  // --- Kelly: prompt size of each successful call, and calls per message (estimated from time gaps)
  const kellyRows = db
    .prepare(
      `SELECT client, at, latency_ms AS ms, prompt_tokens AS prompt, cached_tokens AS cached
         FROM calls WHERE alias = 'kelly' AND outcome = 'ok' AND local_day BETWEEN ? AND ? ORDER BY client, at, id`,
    )
    .all(...range) as Array<{ client: string; at: string; ms: number; prompt: number; cached: number }>;
  const bins: Array<{ from: number; to: number | null; calls: number }> = [];
  for (let f = 0; f < KELLY_BINS_TO; f += KELLY_BIN) bins.push({ from: f, to: f + KELLY_BIN, calls: 0 });
  bins.push({ from: KELLY_BINS_TO, to: null, calls: 0 });
  const prompts: number[] = [];
  let cachedSum = 0;
  const turnSizes: number[] = [];
  let lastClient = '';
  let lastEnd = -Infinity;
  for (const r of kellyRows) {
    const prompt = Number(r.prompt);
    prompts.push(prompt);
    cachedSum += Number(r.cached);
    bins[Math.min(Math.floor(prompt / KELLY_BIN), bins.length - 1)].calls++;
    const end = Date.parse(r.at);
    const start = end - Number(r.ms);
    if (r.client !== lastClient || start - lastEnd > TURN_GAP_MS) turnSizes.push(1);
    else turnSizes[turnSizes.length - 1]++;
    lastClient = r.client;
    lastEnd = Math.max(lastEnd, end);
  }
  prompts.sort((a, b) => a - b);
  const perMessage = [1, 2, 3, 4, 5, 6].map((n) => ({
    calls: n === 6 ? '6+' : String(n),
    messages: turnSizes.filter((s) => (n === 6 ? s >= 6 : s === n)).length,
  }));
  const kelly = {
    calls: prompts.length,
    promptTokens: prompts.reduce((a, b) => a + b, 0),
    cachedTokens: cachedSum,
    p50: percentile(prompts, 0.5),
    p90: percentile(prompts, 0.9),
    max: prompts.length ? prompts[prompts.length - 1] : null,
    bins,
    messages: {
      estimated: true,
      gapSeconds: TURN_GAP_MS / 1000,
      count: turnSizes.length,
      avgCallsPerMessage: turnSizes.length ? round(prompts.length / turnSizes.length, 2) : null,
      distribution: perMessage,
    },
  };

  return {
    timeZone: OWNER_TIME_ZONE,
    from: q.from,
    to: q.to,
    bucket: q.bucket,
    by: q.by,
    generatedAt: opts.now.toISOString(),
    buckets,
    series,
    totals: tidy(totals),
    health,
    pools,
    paid,
    kelly,
  };
}
