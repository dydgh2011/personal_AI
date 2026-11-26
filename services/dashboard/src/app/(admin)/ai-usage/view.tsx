import { Unavailable } from '@/components/ui';
import type { Dict } from '@/i18n';
import type { LlmUsage } from '@/lib/llm';
import {
  bucketLabels, bucketTick, colorStacks, compact, full, groupStacks, groupTable, pct, periodHref, slotColor, tokenKindStacks, usd,
  type Period, type UsageSeries,
} from '@/lib/usage-series';
import { ColumnChart, LineChart, type ChartSeries } from './charts';
import s from './usage.module.css';

/** Kelly prompt landmarks (ROADMAP §18): fixed cost of a turn and the compression threshold. */
export const KELLY_FIXED_FROM = 11_000;
export const KELLY_FIXED_TO = 14_000;
export const KELLY_COMPRESS_AT = 40_000;


function Seg<T extends string>({ items, current, href, disabled }: {
  items: Array<[T, string]>; current: T; href: (v: T) => string; disabled?: (v: T) => boolean;
}) {
  return (
    <span className={s.seg}>
      {items.map(([v, name]) =>
        v === current ? (
          <span key={v} className={s.on} aria-current="true">{name}</span>
        ) : disabled?.(v) ? (
          <span key={v} className={s.off} aria-disabled="true">{name}</span>
        ) : (
          <a key={v} href={href(v)}>{name}</a>
        ),
      )}
    </span>
  );
}

function Filters({ t, period }: { t: Dict; period: Period }) {
  const u = t.aiUsage;
  return (
    <nav className={s.filters} aria-label={u.filtersAria}>
      <span className={s.filterGroup}>
        <span className={s.filterName}>{u.period}</span>
        <Seg items={[['today', u.ranges.today], ['7d', u.ranges['7d']], ['30d', u.ranges['30d']]]} current={period.range}
          href={(range) => periodHref(period, { range, bucket: range === 'today' ? 'hour' : 'day' })} />
      </span>
      <span className={s.filterGroup}>
        <span className={s.filterName}>{u.bucket}</span>
        <Seg items={[['hour', u.hour], ['day', u.day]]} current={period.bucket} href={(bucket) => periodHref(period, { bucket })}
          disabled={(b) => (period.range === 'today' && b === 'day') || (period.range === '30d' && b === 'hour')} />
      </span>
      <span className={s.filterGroup}>
        <span className={s.filterName}>{u.by}</span>
        <Seg items={[['client', u.groupings.client], ['model', u.groupings.model], ['alias', u.groupings.alias]]} current={period.by}
          href={(by) => periodHref(period, { by })} />
      </span>
    </nav>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className={s.tile}>
      <div className={s.tileLabel}>{label}</div>
      <div className={s.tileValue}>{value}</div>
      {note && <div className={s.tileNote}>{note}</div>}
    </div>
  );
}

function Card({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className={s.card}>
      <h3 className={s.cardTitle}>{title}</h3>
      {note && <p className={s.cardNote}>{note}</p>}
      {children}
    </div>
  );
}

function Tiles({ tr, data }: { tr: Dict; data: UsageSeries }) {
  const u = tr.aiUsage.tiles;
  const n = (v: number) => full(v, tr.locale);
  const t = data.totals;
  const failRate = t.calls ? t.errors / t.calls : 0;
  return (
    <div className={s.tiles}>
      <Tile label={u.tokens} value={compact(t.promptTokens + t.completionTokens)}
        note={u.tokensNote(compact(t.promptTokens - t.cachedTokens), compact(t.cachedTokens), compact(t.completionTokens))} />
      <Tile label={u.calls} value={n(t.calls)} note={u.callsNote(n(t.errors), n(t.rateLimited), pct(failRate))} />
      <Tile label={u.paid} value={usd(t.costUsd)} note={u.paidNote(usd(t.listCostUsd))} />
      <Tile label={u.kelly} value={data.kelly.p50 === null ? '–' : compact(data.kelly.p50)}
        note={data.kelly.calls ? u.kellyNote(compact(data.kelly.p90 ?? 0), String(data.kelly.messages.avgCallsPerMessage ?? '–')) : u.noKelly} />
    </div>
  );
}

function TokenSection({ t, data }: { t: Dict; data: UsageSeries }) {
  const u = t.aiUsage.tokens;
  const n = (v: number) => full(v, t.locale);
  const byName = t.aiUsage.groupings[data.by] ?? data.by;
  const labels = bucketLabels(data);
  const ticks = data.buckets.map((b) => bucketTick(b.label, data.bucket, data.from !== data.to));
  const kindColors: Record<string, string> = { input: 'var(--viz-k-input)', cached: 'var(--viz-k-cached)', output: 'var(--viz-k-output)' };
  const kinds: ChartSeries[] = tokenKindStacks(data, t).map((k) => ({ ...k, color: kindColors[k.key] }));
  const groups = colorStacks(data.by, groupStacks(data, t));
  const groupSeries: ChartSeries[] = groups.map((g) => ({ key: g.key, label: g.label, color: slotColor(g.slot), values: g.values }));
  const slotOf = new Map(groups.map((g) => [g.key, g.slot]));
  const rows = groupTable(data, t);
  const unit = data.bucket === 'hour' ? t.aiUsage.hour : t.aiUsage.day;
  return (
    <section className={s.section}>
      <h2>{u.title}</h2>
      <p className={s.sectionNote}>{u.note(unit)}</p>
      <div className={s.cards2}>
        <Card title={u.kindsCard}>
          <ColumnChart series={kinds} labels={labels} ticks={ticks} format="tokens" legendTotals tableCaption={unit} />
        </Card>
        <Card title={u.byCard(byName)} note={u.byCardNote}>
          <ColumnChart series={groupSeries} labels={labels} ticks={ticks} format="tokens" legendTotals tableCaption={unit} />
        </Card>
      </div>
      <div className="table-wrap" style={{ marginTop: 12 }}>
        <table>
          <thead>
            <tr>
              <th>{byName}</th><th className={s.num}>{u.calls}</th><th className={s.num}>{u.errors}</th><th className={s.num}>{u.input}</th>
              <th className={s.num}>{u.cached}</th><th className={s.num}>{u.output}</th><th className={s.num}>{u.paid}</th><th className={s.num}>{u.list}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const slot = slotOf.get(r.key) ?? 0;
              return (
                <tr key={r.key}>
                  <td><span className={s.keyCell}><span className={s.swatch} style={{ background: slotColor(slot) }} aria-hidden />{r.label}</span></td>
                  <td className={s.num}>{n(r.calls)}</td><td className={s.num}>{n(r.errors)}</td><td className={s.num}>{n(r.input)}</td>
                  <td className={s.num}>{n(r.cached)}</td><td className={s.num}>{n(r.output)}</td><td className={s.num}>{usd(r.cost)}</td>
                  <td className={`${s.num} muted`}>{usd(r.list)}</td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={8} className="muted">{u.none}</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PoolSection({ t, data, usage }: { t: Dict; data: UsageSeries; usage: LlmUsage | null }) {
  const u = t.aiUsage.pools;
  return (
    <section className={s.section}>
      <h2>{u.title}</h2>
      <p className={s.sectionNote}>{u.note}</p>
      <div className={s.cards3}>
        {data.pools.map((p) => {
          const now = usage?.pools.find((x) => x.id === p.id);
          const limitText = p.limit === null ? '' : u.limit(compact(p.limit), p.unit === 'tokens');
          return (
            <Card key={p.id} title={p.label} note={u.cardNote(limitText, pct(p.stopAt), p.resetTimeZone)}>
              {now && (
                <>
                  <div className={s.meter} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(now.usedShare * 100)}
                    aria-label={u.todayAria(p.label)}>
                    <div className={`${s.meterFill} ${now.usedShare >= p.stopAt ? s.hot : ''}`} style={{ width: `${Math.min(100, now.usedShare * 100)}%` }} />
                    <div className={s.meterStop} style={{ left: `${p.stopAt * 100}%` }} />
                  </div>
                  <div className={s.tileNote}>
                    {u.today(now.day)} <strong>{pct(now.usedShare)}</strong> · {p.unit === 'tokens' ? u.tokens(compact(now.tokens)) : u.requests(full(now.requests, t.locale))}
                  </div>
                </>
              )}
              <ColumnChart
                series={[{ key: p.id, label: u.share, color: 'var(--viz-s1)', values: p.days.map((d) => d.usedShare) }]}
                labels={p.days.map((d) => `${d.day} (${p.resetTimeZone})`)} ticks={p.days.map((d) => d.day.slice(5))}
                format="pct" yFixed={1} height={150}
                refLines={[{ value: p.stopAt, label: u.stop(pct(p.stopAt)) }]} over={{ at: p.stopAt, label: u.reached }}
                tableCaption={u.date} empty={u.unused}
              />
            </Card>
          );
        })}
      </div>
    </section>
  );
}

function PaidSection({ t, data, usage }: { t: Dict; data: UsageSeries; usage: LlmUsage | null }) {
  const u = t.aiUsage.paid;
  const cap = data.paid.dailyCapUsd;
  return (
    <section className={s.section}>
      <h2>{u.title}</h2>
      <p className={s.sectionNote}>
        {u.noteBefore(usd(cap, 2))}<code>/ai-paid on</code>{u.noteMiddle}<code>private</code>{u.noteAfter}
      </p>
      <div className={s.cards2}>
        <Card title={u.daily} note={usage ? u.dailyNote(usd(usage.paid.spentTodayUsd), usage.paid.approvedToday, usd(usage.totalSpentUsd)) : undefined}>
          <ColumnChart
            series={[{ key: 'paid', label: u.spent, color: 'var(--viz-s1)', values: data.paid.days.map((d) => d.spentUsd) }]}
            labels={data.paid.days.map((d) => d.day)} ticks={data.paid.days.map((d) => d.day.slice(5))}
            format="usd" yMin={cap * 1.1} height={170} refLines={[{ value: cap, label: u.cap(usd(cap, 2)) }]}
            marks={{ on: data.paid.days.map((d) => d.approved), label: u.approvedDays }}
            tableCaption={u.date} empty={u.none}
          />
        </Card>
      </div>
    </section>
  );
}

function KellySection({ t, data }: { t: Dict; data: UsageSeries }) {
  const u = t.aiUsage.kelly;
  const n = (v: number) => full(v, t.locale);
  const k = data.kelly;
  const bin = k.bins[0]?.to ?? 2000;
  const labels = k.bins.map((b) => (b.to === null ? u.over(compact(b.from)) : `${compact(b.from)}–${compact(b.to)}`));
  const ticks = k.bins.map((b) => (b.from % (bin * 5) === 0 ? compact(b.from) : ''));
  return (
    <section className={s.section}>
      <h2>{u.title}</h2>
      <p className={s.sectionNote}>{u.noteBefore}<code>kelly</code>{u.noteAfter}</p>
      <div className={s.cards2}>
        <Card title={u.perCall} note={k.calls ? u.perCallNote(n(k.calls), compact(k.p50 ?? 0), compact(k.p90 ?? 0), compact(k.max ?? 0)) : undefined}>
          <ColumnChart
            series={[{ key: 'calls', label: u.callCount, color: 'var(--viz-s1)', values: k.bins.map((b) => b.calls) }]}
            labels={labels} ticks={ticks} format="count" height={190} tickAt="edge"
            bands={[{ from: KELLY_FIXED_FROM / bin, to: KELLY_FIXED_TO / bin, label: u.fixedCost }]}
            vLines={[{ at: KELLY_COMPRESS_AT / bin, label: u.compress(compact(KELLY_COMPRESS_AT)) }]}
            tableCaption={u.inputTokens} empty={u.none}
          />
        </Card>
        <Card title={u.perMessage}
          note={u.perMessageNote(k.messages.gapSeconds, k.messages.count ? u.perMessageExtra(n(k.messages.count), String(k.messages.avgCallsPerMessage)) : '')}>
          <ColumnChart
            series={[{ key: 'messages', label: u.messageCount, color: 'var(--viz-s1)', values: k.messages.distribution.map((d) => d.messages) }]}
            labels={k.messages.distribution.map((d) => u.callsN(d.calls))} ticks={k.messages.distribution.map((d) => d.calls)}
            format="count" height={190} tableCaption={u.callsPerMessage} empty={u.none}
          />
        </Card>
      </div>
    </section>
  );
}

function HealthSection({ t, data }: { t: Dict; data: UsageSeries }) {
  const u = t.aiUsage.health;
  const labels = bucketLabels(data);
  const ticks = data.buckets.map((b) => bucketTick(b.label, data.bucket, data.from !== data.to));
  const unit = data.bucket === 'hour' ? t.aiUsage.hour : t.aiUsage.day;
  return (
    <section className={s.section}>
      <h2>{u.title}</h2>
      <p className={s.sectionNote}>{u.note}</p>
      <div className={s.cards2}>
        <Card title={u.failed}>
          <ColumnChart
            series={[
              { key: '429', label: u.rateLimited, color: 'var(--viz-warn)', values: data.health.map((h) => h.rateLimited) },
              { key: 'other', label: u.otherErrors, color: 'var(--viz-bad)', values: data.health.map((h) => h.otherErrors) },
            ]}
            labels={labels} ticks={ticks} format="count" legendTotals tableCaption={unit} empty={u.noFailures}
          />
        </Card>
        <Card title={u.latency}>
          <LineChart
            series={[
              { key: 'p50', label: u.p50, color: 'var(--viz-s1)', values: data.health.map((h) => h.p50Ms) },
              { key: 'p95', label: u.p95, color: 'var(--viz-s2)', values: data.health.map((h) => h.p95Ms) },
            ]}
            labels={labels} ticks={ticks} format="ms" tableCaption={unit}
          />
        </Card>
      </div>
    </section>
  );
}

function GatewayTables({ t, usage }: { t: Dict; usage: LlmUsage }) {
  const u = t.aiUsage.gateway;
  return (
    <>
      <section className={s.section}>
        <h2>{u.routes}</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>{u.alias}</th><th>{u.usedBy}</th><th>{u.order}</th></tr></thead>
            <tbody>
              {Object.entries(usage.aliases).map(([alias, a]) => (
                <tr key={alias}><td>{alias}</td><td>{a.description}</td><td>{a.routes.join(' → ')}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className={s.section}>
        <h2>{u.daily}</h2>
        <details>
          <summary className="muted">{u.expand}</summary>
          <div className="table-wrap" style={{ marginTop: 6 }}>
            <table>
              <thead>
                <tr><th>{u.date}</th><th>{u.alias}</th><th>{u.providerModel}</th><th className={s.num}>{u.callsOk}</th><th className={s.num}>{u.inputCached}</th><th className={s.num}>{u.output}</th><th className={s.num}>{u.paid}</th><th className={s.num}>{u.list}</th></tr>
              </thead>
              <tbody>
                {usage.daily.map((d) => (
                  <tr key={`${d.day}-${d.alias}-${d.provider}-${d.model}`}>
                    <td>{d.day}</td><td>{d.alias}</td><td>{d.provider} / {d.model}</td><td className={s.num}>{d.calls} ({d.ok})</td>
                    <td className={s.num}>{compact(d.prompt_tokens)} ({compact(d.cached_tokens)})</td><td className={s.num}>{compact(d.completion_tokens)}</td>
                    <td className={s.num}>{usd(d.cost_usd)}</td><td className={`${s.num} muted`}>{usd(d.list_cost_usd)}</td>
                  </tr>
                ))}
                {usage.daily.length === 0 && <tr><td colSpan={8} className="muted">{u.noCalls}</td></tr>}
              </tbody>
            </table>
          </div>
        </details>
      </section>
      {usage.recentErrors.length > 0 && (
        <section className={s.section}>
          <h2>{u.recentErrors}</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>{u.timeUtc}</th><th>{u.alias}</th><th>{u.route}</th><th>{u.status}</th><th>{u.error}</th></tr></thead>
              <tbody>
                {usage.recentErrors.map((e, i) => (
                  <tr key={`${e.at}-${e.provider}-${i}`}>
                    <td>{e.at.replace('T', ' ').slice(0, 19)}</td><td>{e.alias}</td><td>{e.provider} / {e.model}</td><td>{e.status}</td>
                    <td className="muted">{(e.error ?? '').slice(0, 160)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

/** The whole page body; the page fetches, this only renders (so it can be tested without a gateway). */
export function UsageView({ t, period, series, usage, seriesError, usageError }: {
  t: Dict; period: Period; series: UsageSeries | null; usage: LlmUsage | null; seriesError: string | null; usageError: string | null;
}) {
  return (
    <div className={s.page}>
      <p className={s.sub}>
        {t.aiUsage.sub(period.from === period.to ? period.from : `${period.from} ~ ${period.to}`)}
      </p>
      <Filters t={t} period={period} />
      {seriesError && <Unavailable t={t} what={t.aiUsage.graphsWhat} reason={seriesError} />}
      {usageError && usageError !== seriesError && <Unavailable t={t} what={t.aiUsage.todayWhat} reason={usageError} />}
      {series && (
        <>
          <Tiles tr={t} data={series} />
          <TokenSection t={t} data={series} />
          <PoolSection t={t} data={series} usage={usage} />
          <PaidSection t={t} data={series} usage={usage} />
          <KellySection t={t} data={series} />
          <HealthSection t={t} data={series} />
        </>
      )}
      {usage && <GatewayTables t={t} usage={usage} />}
    </div>
  );
}

