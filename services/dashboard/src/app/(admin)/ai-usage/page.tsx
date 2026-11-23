import { AutoRefresh } from '@/components/client';
import { Badge, Card, errorText, Unavailable } from '@/components/ui';
import { llmUsage, type LlmUsage } from '@/lib/llm';
import { requireSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
const usd = (n: number) => `$${n.toFixed(4)}`;

/** Read-only view of the LLM gateway: free quotas today, paid spend, daily totals. Paid is switched on Discord (/ai-paid). */
export default async function AiUsage() {
  await requireSession();
  let usage: LlmUsage | null = null;
  let error: string | null = null;
  try {
    usage = await llmUsage(14);
  } catch (e) {
    error = errorText(e);
  }
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>AI usage</h1>
        <AutoRefresh seconds={30} />
      </div>
      {error && <Unavailable what="LLM gateway" reason={error} />}
      {usage && (
        <>
          <div className="grid">
            {usage.pools.map((p) => (
              <Card key={p.id} title={p.label}>
                <div className="big">{Math.round(p.usedShare * 100)}%</div>
                <div className="muted">
                  {p.tokensPerDay !== null ? `${tokens(p.tokens)} / ${tokens(p.tokensPerDay)} tokens` : `${p.requests} / ${p.requestsPerDay} requests`}
                  {' · '}stops at {Math.round(p.stopAt * 100)}% · day {p.day} ({p.resetTimeZone})
                </div>
              </Card>
            ))}
            <Card title="Paid (OpenAI Private)">
              <Badge value={usage.paid.approvedToday ? 'approved today' : 'off'} />
              <div className="muted">
                today {usd(usage.paid.spentTodayUsd)} / cap ${usage.paid.dailyCapUsd.toFixed(2)} · total {usd(usage.totalSpentUsd)}
              </div>
              <div className="muted">Switch on Discord: /ai-paid on · off</div>
            </Card>
          </div>

          <div className="section">
            <h2>Routes</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Alias</th><th>Use</th><th>Order</th></tr>
                </thead>
                <tbody>
                  {Object.entries(usage.aliases).map(([alias, a]) => (
                    <tr key={alias}><td>{alias}</td><td>{a.description}</td><td>{a.routes.join(' → ')}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="section">
            <h2>Last 14 days</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Day</th><th>Alias</th><th>Provider / model</th><th>Calls (ok)</th><th>Prompt (cached)</th><th>Output</th><th>Paid</th><th>List price</th></tr>
                </thead>
                <tbody>
                  {usage.daily.map((d) => (
                    <tr key={`${d.day}-${d.alias}-${d.provider}-${d.model}`}>
                      <td>{d.day}</td><td>{d.alias}</td><td>{d.provider} / {d.model}</td><td>{d.calls} ({d.ok})</td>
                      <td>{tokens(d.prompt_tokens)} ({tokens(d.cached_tokens)})</td><td>{tokens(d.completion_tokens)}</td>
                      <td>{usd(d.cost_usd)}</td><td className="muted">{usd(d.list_cost_usd)}</td>
                    </tr>
                  ))}
                  {usage.daily.length === 0 && <tr><td colSpan={8} className="muted">No calls yet</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          {usage.recentErrors.length > 0 && (
            <div className="section">
              <h2>Recent errors (fallbacks)</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>When</th><th>Alias</th><th>Route</th><th>Status</th><th>Error</th></tr>
                  </thead>
                  <tbody>
                    {usage.recentErrors.map((e) => (
                      <tr key={`${e.at}-${e.provider}`}>
                        <td>{e.at.replace('T', ' ').slice(0, 19)}</td><td>{e.alias}</td><td>{e.provider} / {e.model}</td><td>{e.status}</td>
                        <td className="muted">{(e.error ?? '').slice(0, 160)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
