import { AutoRefresh } from '@/components/client';
import { errorText } from '@/components/ui';
import { llmUsage, llmUsageSeries, type LlmUsage } from '@/lib/llm';
import { requireSession } from '@/lib/server';
import { resolvePeriod, type UsageSeries } from '@/lib/usage-series';
import s from './usage.module.css';
import { UsageView } from './view';

export const dynamic = 'force-dynamic';

/**
 * Read-only AI usage graphs from the LLM gateway (GET /usage/series + GET /usage), fetched on the
 * server with the dashboard's gateway key. Period and grouping are plain GET links, so nothing here
 * changes state (paid fallback is switched on Discord: /ai-paid).
 */
export default async function AiUsage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [sp] = await Promise.all([searchParams, requireSession()]);
  const period = resolvePeriod(sp, new Date());
  const days = period.range === 'today' ? 1 : period.range === '7d' ? 7 : 30;
  const [seriesResult, usageResult] = await Promise.allSettled([
    llmUsageSeries({ from: period.from, to: period.to, bucket: period.bucket, by: period.by }),
    llmUsage(days),
  ]);
  const series: UsageSeries | null = seriesResult.status === 'fulfilled' ? seriesResult.value : null;
  const usage: LlmUsage | null = usageResult.status === 'fulfilled' ? usageResult.value : null;
  return (
    <>
      <div className={s.header}>
        <h1>AI usage</h1>
        <AutoRefresh seconds={60} />
      </div>
      <UsageView
        period={period}
        series={series}
        usage={usage}
        seriesError={seriesResult.status === 'rejected' ? errorText(seriesResult.reason) : null}
        usageError={usageResult.status === 'rejected' ? errorText(usageResult.reason) : null}
      />
    </>
  );
}
