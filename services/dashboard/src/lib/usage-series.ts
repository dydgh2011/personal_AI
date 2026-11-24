/**
 * Shapes of GET /usage/series (LLM gateway) and the pure transforms the AI usage page needs.
 * No server-only imports: unit tests and the chart components use these directly.
 */

export const OWNER_TIME_ZONE = 'America/Toronto';

export interface SeriesTotals {
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

export interface UsageSeries {
  timeZone: string;
  from: string;
  to: string;
  bucket: 'hour' | 'day';
  by: 'client' | 'alias' | 'model';
  generatedAt: string;
  buckets: Array<{ start: string; label: string; day: string; offsetMinutes: number }>;
  series: Array<{ key: string; values: SeriesTotals[] }>;
  totals: SeriesTotals;
  health: Array<{ calls: number; errors: number; rateLimited: number; otherErrors: number; p50Ms: number | null; p95Ms: number | null }>;
  pools: Array<{
    id: string;
    label: string;
    resetTimeZone: string;
    unit: 'tokens' | 'requests';
    limit: number | null;
    stopAt: number;
    days: Array<{ day: string; tokens: number; requests: number; usedShare: number }>;
  }>;
  paid: { dailyCapUsd: number; days: Array<{ day: string; spentUsd: number; calls: number; approved: boolean }> };
  kelly: {
    calls: number;
    promptTokens: number;
    cachedTokens: number;
    p50: number | null;
    p90: number | null;
    max: number | null;
    bins: Array<{ from: number; to: number | null; calls: number }>;
    messages: {
      estimated: boolean;
      gapSeconds: number;
      count: number;
      avgCallsPerMessage: number | null;
      distribution: Array<{ calls: string; messages: number }>;
    };
  };
}

// ---------- period picker

export const RANGES = ['today', '7d', '30d'] as const;
export type Range = (typeof RANGES)[number];
export const GROUPINGS = ['client', 'model', 'alias'] as const;
export type Grouping = (typeof GROUPINGS)[number];

export interface Period {
  range: Range;
  bucket: 'hour' | 'day';
  by: Grouping;
  from: string;
  to: string;
}

export function dayIn(timeZone: string, at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Read ?range=&bucket=&by= (anything unknown falls back to the default: 7 days, daily, by caller). */
export function resolvePeriod(params: Record<string, string | string[] | undefined>, now: Date): Period {
  const r = first(params.range);
  const range: Range = (RANGES as readonly string[]).includes(r ?? '') ? (r as Range) : '7d';
  const b = first(params.by);
  const by: Grouping = (GROUPINGS as readonly string[]).includes(b ?? '') ? (b as Grouping) : 'client';
  const to = dayIn(OWNER_TIME_ZONE, now);
  const days = range === 'today' ? 1 : range === '7d' ? 7 : 30;
  // Today is always hourly; 30 days is always daily; 7 days may be either.
  const bucket = range === 'today' ? 'hour' : range === '30d' ? 'day' : first(params.bucket) === 'hour' ? 'hour' : 'day';
  return { range, bucket, by, from: addDays(to, -(days - 1)), to };
}

export function periodHref(p: Pick<Period, 'range' | 'bucket' | 'by'>, change: Partial<Pick<Period, 'range' | 'bucket' | 'by'>>): string {
  const next = { ...p, ...change };
  const q = new URLSearchParams({ range: next.range, by: next.by });
  if (next.range === '7d' && next.bucket === 'hour') q.set('bucket', 'hour');
  return `/ai-usage?${q.toString()}`;
}

// ---------- formatting

export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1_000_000) return `${trim(n / 1_000_000, a >= 10_000_000 ? 1 : 2)}M`;
  if (a >= 10_000) return `${trim(n / 1000, 0)}K`;
  if (a >= 1000) return `${trim(n / 1000, 1)}K`;
  return String(Math.round(n));
}

function trim(n: number, digits: number): string {
  return n.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

export const full = (n: number) => Math.round(n).toLocaleString('en-US');

export function usd(n: number, digits = 4): string {
  return `$${n.toFixed(digits)}`;
}

export function ms(n: number | null): string {
  if (n === null) return '–';
  return n >= 1000 ? `${trim(n / 1000, 1)}s` : `${Math.round(n)}ms`;
}

export function pct(share: number): string {
  return `${trim(share * 100, share < 0.1 ? 1 : 0)}%`;
}

/**
 * Short axis label for a bucket: "11-24" for days; for hours "13" (the date at midnight), or over
 * several days only the date at each midnight (blank otherwise).
 */
export function bucketTick(label: string, bucket: 'hour' | 'day', multiDay = false): string {
  if (bucket === 'day') return label.slice(5);
  const [day, hour] = label.split(' ');
  if (hour === '00:00') return day.slice(5);
  return multiDay ? '' : hour.slice(0, 2);
}

// ---------- groups and token kinds

export const OTHER = '기타';
const MAX_GROUPS = 6;

const CLIENT_NAMES: Record<string, string> = {
  hermes: 'Kelly (hermes)', school: 'school', learning: 'learning', notifier: 'notifier', operator: 'operator', dashboard: 'dashboard',
};

export function groupLabel(by: Grouping, key: string): string {
  if (key === OTHER) return OTHER;
  if (by === 'client') return CLIENT_NAMES[key] ?? key;
  return key;
}

export interface Stack {
  key: string;
  label: string;
  values: number[];
}

const tokensOf = (t: SeriesTotals) => t.promptTokens + t.completionTokens;

/**
 * Total tokens per bucket for each group, biggest first (the gateway already sorts), with the
 * tail beyond six folded into "기타" so colors never cycle. Colors are assigned by the caller
 * from the group's rank in this fixed order.
 */
export function groupStacks(data: UsageSeries): Stack[] {
  const head = data.series.slice(0, MAX_GROUPS - (data.series.length > MAX_GROUPS ? 1 : 0));
  const tail = data.series.slice(head.length);
  const stacks = head.map((s) => ({ key: s.key, label: groupLabel(data.by, s.key), values: s.values.map(tokensOf) }));
  if (tail.length) {
    stacks.push({
      key: OTHER,
      label: `${OTHER} (${tail.length})`,
      values: data.buckets.map((_, i) => tail.reduce((a, s) => a + tokensOf(s.values[i]), 0)),
    });
  }
  return stacks;
}

/** Input split into uncached and cached (prompt_tokens already includes the cached part), plus output. */
export function tokenKindStacks(data: UsageSeries): Stack[] {
  const sum = (f: (t: SeriesTotals) => number) => data.buckets.map((_, i) => data.series.reduce((a, s) => a + f(s.values[i]), 0));
  return [
    { key: 'input', label: '입력 (캐시 제외)', values: sum((t) => t.promptTokens - t.cachedTokens) },
    { key: 'cached', label: '캐시된 입력', values: sum((t) => t.cachedTokens) },
    { key: 'output', label: '출력', values: sum((t) => t.completionTokens) },
  ];
}

/** Per-group totals for the table under the charts. */
export function groupTable(data: UsageSeries) {
  return data.series.map((s) => {
    const t = s.values.reduce(
      (a, v) => ({
        calls: a.calls + v.calls, errors: a.errors + v.errors, input: a.input + v.promptTokens - v.cachedTokens,
        cached: a.cached + v.cachedTokens, output: a.output + v.completionTokens, cost: a.cost + v.costUsd, list: a.list + v.listCostUsd,
      }),
      { calls: 0, errors: 0, input: 0, cached: 0, output: 0, cost: 0, list: 0 },
    );
    return { key: s.key, label: groupLabel(data.by, s.key), ...t };
  });
}

/** Per-day sums of the series, for checking against the daily table of GET /usage. */
export function dailySums(data: UsageSeries): Map<string, { calls: number; prompt: number; cached: number; completion: number }> {
  const out = new Map<string, { calls: number; prompt: number; cached: number; completion: number }>();
  data.buckets.forEach((b, i) => {
    const d = out.get(b.day) ?? { calls: 0, prompt: 0, cached: 0, completion: 0 };
    for (const s of data.series) {
      d.calls += s.values[i].calls;
      d.prompt += s.values[i].promptTokens;
      d.cached += s.values[i].cachedTokens;
      d.completion += s.values[i].completionTokens;
    }
    out.set(b.day, d);
  });
  return out;
}

/** "Nice" axis maximum and ticks (1, 2, 2.5, 5 × 10^n), at most `count` + 1 ticks. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

// ---------- colors (identity follows the entity, never its rank)

/** Known entities keep their slot in every period; unknown ones take the next free slot. */
const FIXED_SLOTS: Record<Grouping, Record<string, number>> = {
  client: { hermes: 1, school: 2, learning: 3, notifier: 4, operator: 5, dashboard: 6 },
  alias: { kelly: 1, 'kelly-aux': 2, batch: 3, private: 4 },
  model: {
    'openai-public/gpt-5.4-mini': 1, 'gemini/gemini-3.5-flash-lite': 2, 'groq/openai/gpt-oss-20b': 3,
    'openai-public/gpt-5.4-nano': 4, 'openai-private/gpt-5.4-nano': 5,
  },
};

/**
 * Colour slot (1–6, 0 = "기타" gray) per stack, and the stacks re-ordered by slot so only
 * neighbouring slots ever touch in a stack (the order the palette was validated in).
 */
export function colorStacks(by: Grouping, stacks: Stack[]): Array<Stack & { slot: number }> {
  const used = new Set<number>();
  const fixed = FIXED_SLOTS[by];
  const withSlot = stacks.map((st) => {
    const slot = st.key === OTHER ? 0 : (fixed[st.key] ?? -1);
    if (slot > 0) used.add(slot);
    return { ...st, slot };
  });
  for (const st of withSlot) {
    if (st.slot !== -1) continue;
    const free = [1, 2, 3, 4, 5, 6].find((n) => !used.has(n));
    st.slot = free ?? 0;
    if (free) used.add(free);
  }
  return withSlot.sort((a, b) => (a.slot || 99) - (b.slot || 99));
}

export const slotColor = (slot: number) => (slot > 0 ? `var(--viz-s${slot})` : 'var(--viz-other)');

/** Full bucket labels; the two 01:00 hours of the fall-back day get their zone name. */
export function bucketLabels(data: UsageSeries): string[] {
  const seen = new Map<string, number>();
  for (const b of data.buckets) seen.set(b.label, (seen.get(b.label) ?? 0) + 1);
  return data.buckets.map((b) => {
    if ((seen.get(b.label) ?? 0) < 2) return b.label;
    return `${b.label} ${b.offsetMinutes === -240 ? 'EDT' : b.offsetMinutes === -300 ? 'EST' : `UTC${b.offsetMinutes / 60}`}`;
  });
}
