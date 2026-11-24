import { Unavailable } from '@/components/ui';
import type { LlmUsage } from '@/lib/llm';
import {
  bucketLabels, bucketTick, colorStacks, compact, full, groupStacks, groupTable, pct, periodHref, slotColor, tokenKindStacks, usd,
  type Grouping, type Period, type UsageSeries,
} from '@/lib/usage-series';
import { ColumnChart, LineChart, type ChartSeries } from './charts';
import s from './usage.module.css';

/** Kelly prompt landmarks (ROADMAP §18): fixed cost of a turn and the compression threshold. */
export const KELLY_FIXED_FROM = 11_000;
export const KELLY_FIXED_TO = 14_000;
export const KELLY_COMPRESS_AT = 40_000;

const RANGE_NAMES = { today: '오늘', '7d': '7일', '30d': '30일' } as const;
const BY_NAMES: Record<Grouping, string> = { client: '호출자', model: '모델', alias: '용도' };

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

function Filters({ period }: { period: Period }) {
  return (
    <nav className={s.filters} aria-label="기간과 묶음">
      <span className={s.filterGroup}>
        <span className={s.filterName}>기간</span>
        <Seg items={[['today', RANGE_NAMES.today], ['7d', RANGE_NAMES['7d']], ['30d', RANGE_NAMES['30d']]]} current={period.range}
          href={(range) => periodHref(period, { range, bucket: range === 'today' ? 'hour' : 'day' })} />
      </span>
      <span className={s.filterGroup}>
        <span className={s.filterName}>단위</span>
        <Seg items={[['hour', '시간'], ['day', '일']]} current={period.bucket} href={(bucket) => periodHref(period, { bucket })}
          disabled={(b) => (period.range === 'today' && b === 'day') || (period.range === '30d' && b === 'hour')} />
      </span>
      <span className={s.filterGroup}>
        <span className={s.filterName}>묶음</span>
        <Seg items={[['client', BY_NAMES.client], ['model', BY_NAMES.model], ['alias', BY_NAMES.alias]]} current={period.by}
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

function Tiles({ data }: { data: UsageSeries }) {
  const t = data.totals;
  const failRate = t.calls ? t.errors / t.calls : 0;
  return (
    <div className={s.tiles}>
      <Tile label="토큰 합계" value={compact(t.promptTokens + t.completionTokens)}
        note={`입력 ${compact(t.promptTokens - t.cachedTokens)} · 캐시 ${compact(t.cachedTokens)} · 출력 ${compact(t.completionTokens)}`} />
      <Tile label="호출" value={full(t.calls)} note={`실패 ${full(t.errors)} (429: ${full(t.rateLimited)}) · ${pct(failRate)}`} />
      <Tile label="유료 지출" value={usd(t.costUsd)} note={`무료 호출까지 정가로 치면 ${usd(t.listCostUsd)}`} />
      <Tile label="Kelly 입력 크기 (중앙값)" value={data.kelly.p50 === null ? '–' : compact(data.kelly.p50)}
        note={data.kelly.calls ? `p90 ${compact(data.kelly.p90 ?? 0)} · 메시지당 호출 ≈ ${data.kelly.messages.avgCallsPerMessage ?? '–'} (추정)` : 'Kelly 호출 없음'} />
    </div>
  );
}

function TokenSection({ data }: { data: UsageSeries }) {
  const labels = bucketLabels(data);
  const ticks = data.buckets.map((b) => bucketTick(b.label, data.bucket, data.from !== data.to));
  const kindColors: Record<string, string> = { input: 'var(--viz-k-input)', cached: 'var(--viz-k-cached)', output: 'var(--viz-k-output)' };
  const kinds: ChartSeries[] = tokenKindStacks(data).map((k) => ({ ...k, color: kindColors[k.key] }));
  const groups = colorStacks(data.by, groupStacks(data));
  const groupSeries: ChartSeries[] = groups.map((g) => ({ key: g.key, label: g.label, color: slotColor(g.slot), values: g.values }));
  const slotOf = new Map(groups.map((g) => [g.key, g.slot]));
  const rows = groupTable(data);
  const unit = data.bucket === 'hour' ? '시간' : '일';
  return (
    <section className={s.section}>
      <h2>토큰</h2>
      <p className={s.sectionNote}>
        {unit} 단위 합계. 입력에는 캐시된 입력이 포함돼 있어서 그래프에서는 캐시 제외 입력과 캐시된 입력으로 나눠 쌓았어요. 실패한 호출은 토큰이 0으로 남아요.
      </p>
      <div className={s.cards2}>
        <Card title="입력 · 캐시 · 출력">
          <ColumnChart series={kinds} labels={labels} ticks={ticks} format="tokens" legendTotals tableCaption={unit} />
        </Card>
        <Card title={`${BY_NAMES[data.by]}별 토큰`} note="입력 + 출력">
          <ColumnChart series={groupSeries} labels={labels} ticks={ticks} format="tokens" legendTotals tableCaption={unit} />
        </Card>
      </div>
      <div className="table-wrap" style={{ marginTop: 12 }}>
        <table>
          <thead>
            <tr>
              <th>{BY_NAMES[data.by]}</th><th className={s.num}>호출</th><th className={s.num}>실패</th><th className={s.num}>입력 (캐시 제외)</th>
              <th className={s.num}>캐시된 입력</th><th className={s.num}>출력</th><th className={s.num}>유료</th><th className={s.num}>정가 환산</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const slot = slotOf.get(r.key) ?? 0;
              return (
                <tr key={r.key}>
                  <td><span className={s.keyCell}><span className={s.swatch} style={{ background: slotColor(slot) }} aria-hidden />{r.label}</span></td>
                  <td className={s.num}>{full(r.calls)}</td><td className={s.num}>{full(r.errors)}</td><td className={s.num}>{full(r.input)}</td>
                  <td className={s.num}>{full(r.cached)}</td><td className={s.num}>{full(r.output)}</td><td className={s.num}>{usd(r.cost)}</td>
                  <td className={`${s.num} muted`}>{usd(r.list)}</td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={8} className="muted">이 기간에는 호출이 없어요</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PoolSection({ data, usage }: { data: UsageSeries; usage: LlmUsage | null }) {
  return (
    <section className={s.section}>
      <h2>무료 한도</h2>
      <p className={s.sectionNote}>
        묶음별 하루 사용률. 게이트웨이는 선(멈추는 지점)에 닿기 전에 다음 경로로 넘어가요. 날짜는 묶음마다 공급자 기준(UTC 또는 태평양 시간)이라 토론토 날짜와 하루 어긋날 수 있어요.
      </p>
      <div className={s.cards3}>
        {data.pools.map((p) => {
          const now = usage?.pools.find((x) => x.id === p.id);
          const limitText = p.limit === null ? '' : `${compact(p.limit)} ${p.unit === 'tokens' ? '토큰' : '회'}/일`;
          return (
            <Card key={p.id} title={p.label} note={`${limitText} · ${pct(p.stopAt)}에서 멈춤 · ${p.resetTimeZone} 날짜`}>
              {now && (
                <>
                  <div className={s.meter} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(now.usedShare * 100)}
                    aria-label={`${p.label} 오늘 사용률`}>
                    <div className={`${s.meterFill} ${now.usedShare >= p.stopAt ? s.hot : ''}`} style={{ width: `${Math.min(100, now.usedShare * 100)}%` }} />
                    <div className={s.meterStop} style={{ left: `${p.stopAt * 100}%` }} />
                  </div>
                  <div className={s.tileNote}>
                    오늘({now.day}) <strong>{pct(now.usedShare)}</strong> · {p.unit === 'tokens' ? `${compact(now.tokens)} 토큰` : `${full(now.requests)}회`}
                  </div>
                </>
              )}
              <ColumnChart
                series={[{ key: p.id, label: '사용률', color: 'var(--viz-s1)', values: p.days.map((d) => d.usedShare) }]}
                labels={p.days.map((d) => `${d.day} (${p.resetTimeZone})`)} ticks={p.days.map((d) => d.day.slice(5))}
                format="pct" yFixed={1} height={150}
                refLines={[{ value: p.stopAt, label: `멈춤 ${pct(p.stopAt)}` }]} over={{ at: p.stopAt, label: '멈추는 지점 도달' }}
                tableCaption="날짜" empty="이 기간에는 쓰지 않았어요"
              />
            </Card>
          );
        })}
      </div>
    </section>
  );
}

function PaidSection({ data, usage }: { data: UsageSeries; usage: LlmUsage | null }) {
  const cap = data.paid.dailyCapUsd;
  return (
    <section className={s.section}>
      <h2>유료 (OpenAI Private)</h2>
      <p className={s.sectionNote}>
        토론토 날짜 기준 하루 지출과 상한 {usd(cap, 2)}. 무료가 모두 막힌 날 Discord <code>/ai-paid on</code>으로 승인해야 유료로 넘어가요(<code>private</code> 용도는 승인 없이 상한 안에서).
      </p>
      <div className={s.cards2}>
        <Card title="하루 지출" note={usage ? `오늘 ${usd(usage.paid.spentTodayUsd)} · ${usage.paid.approvedToday ? '오늘 승인됨' : '오늘 승인 안 함'} · 지금까지 ${usd(usage.totalSpentUsd)}` : undefined}>
          <ColumnChart
            series={[{ key: 'paid', label: '지출', color: 'var(--viz-s1)', values: data.paid.days.map((d) => d.spentUsd) }]}
            labels={data.paid.days.map((d) => d.day)} ticks={data.paid.days.map((d) => d.day.slice(5))}
            format="usd" yMin={cap * 1.1} height={170} refLines={[{ value: cap, label: `하루 상한 ${usd(cap, 2)}` }]}
            marks={{ on: data.paid.days.map((d) => d.approved), label: '승인한 날' }}
            tableCaption="날짜" empty="이 기간에는 유료 호출이 없어요"
          />
        </Card>
      </div>
    </section>
  );
}

function KellySection({ data }: { data: UsageSeries }) {
  const k = data.kelly;
  const bin = k.bins[0]?.to ?? 2000;
  const labels = k.bins.map((b) => (b.to === null ? `${compact(b.from)} 이상` : `${compact(b.from)}–${compact(b.to)}`));
  const ticks = k.bins.map((b) => (b.from % (bin * 5) === 0 ? compact(b.from) : ''));
  return (
    <section className={s.section}>
      <h2>Kelly 대화 크기</h2>
      <p className={s.sectionNote}>
        Kelly(<code>kelly</code> 용도) 성공 호출 하나에 들어간 입력 토큰. 지시문·도구 설명 같은 고정 비용이 약 1만 1천~1만 4천이고, 대화가 4만을 넘으면 압축해요.
      </p>
      <div className={s.cards2}>
        <Card title="호출당 입력 토큰" note={k.calls ? `${full(k.calls)}회 · 중앙값 ${compact(k.p50 ?? 0)} · p90 ${compact(k.p90 ?? 0)} · 최대 ${compact(k.max ?? 0)}` : undefined}>
          <ColumnChart
            series={[{ key: 'calls', label: '호출 수', color: 'var(--viz-s1)', values: k.bins.map((b) => b.calls) }]}
            labels={labels} ticks={ticks} format="count" height={190} tickAt="edge"
            bands={[{ from: KELLY_FIXED_FROM / bin, to: KELLY_FIXED_TO / bin, label: '고정 비용' }]}
            vLines={[{ at: KELLY_COMPRESS_AT / bin, label: `압축 ${compact(KELLY_COMPRESS_AT)}` }]}
            tableCaption="입력 토큰" empty="이 기간에는 Kelly 호출이 없어요"
          />
        </Card>
        <Card title="메시지 하나당 호출 수 (추정)"
          note={`메시지 ID가 기록되지 않아서, 호출 사이가 ${k.messages.gapSeconds}초 넘게 비면 새 메시지로 셌어요.${k.messages.count ? ` 메시지 ${full(k.messages.count)}개 · 평균 ${k.messages.avgCallsPerMessage}회` : ''}`}>
          <ColumnChart
            series={[{ key: 'messages', label: '메시지 수', color: 'var(--viz-s1)', values: k.messages.distribution.map((d) => d.messages) }]}
            labels={k.messages.distribution.map((d) => `호출 ${d.calls}회`)} ticks={k.messages.distribution.map((d) => d.calls)}
            format="count" height={190} tableCaption="메시지당 호출" empty="이 기간에는 Kelly 호출이 없어요"
          />
        </Card>
      </div>
    </section>
  );
}

function HealthSection({ data }: { data: UsageSeries }) {
  const labels = bucketLabels(data);
  const ticks = data.buckets.map((b) => bucketTick(b.label, data.bucket, data.from !== data.to));
  const unit = data.bucket === 'hour' ? '시간' : '일';
  return (
    <section className={s.section}>
      <h2>오류 · 지연 시간</h2>
      <p className={s.sectionNote}>실패한 시도(다음 경로로 넘어간 것 포함)와 성공한 호출의 응답 시간. 스트림은 끝까지 받은 시간이에요.</p>
      <div className={s.cards2}>
        <Card title="실패한 호출">
          <ColumnChart
            series={[
              { key: '429', label: '429 (한도)', color: 'var(--viz-warn)', values: data.health.map((h) => h.rateLimited) },
              { key: 'other', label: '그 밖의 오류', color: 'var(--viz-bad)', values: data.health.map((h) => h.otherErrors) },
            ]}
            labels={labels} ticks={ticks} format="count" legendTotals tableCaption={unit} empty="이 기간에는 실패가 없어요"
          />
        </Card>
        <Card title="응답 시간 (성공한 호출)">
          <LineChart
            series={[
              { key: 'p50', label: '중앙값 (p50)', color: 'var(--viz-s1)', values: data.health.map((h) => h.p50Ms) },
              { key: 'p95', label: '느린 쪽 (p95)', color: 'var(--viz-s2)', values: data.health.map((h) => h.p95Ms) },
            ]}
            labels={labels} ticks={ticks} format="ms" tableCaption={unit}
          />
        </Card>
      </div>
    </section>
  );
}

function GatewayTables({ usage }: { usage: LlmUsage }) {
  return (
    <>
      <section className={s.section}>
        <h2>경로</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>용도</th><th>쓰는 곳</th><th>순서</th></tr></thead>
            <tbody>
              {Object.entries(usage.aliases).map(([alias, a]) => (
                <tr key={alias}><td>{alias}</td><td>{a.description}</td><td>{a.routes.join(' → ')}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className={s.section}>
        <h2>일별 합계 (/usage)</h2>
        <details>
          <summary className="muted">용도·모델별 일별 표 펼치기</summary>
          <div className="table-wrap" style={{ marginTop: 6 }}>
            <table>
              <thead>
                <tr><th>날짜</th><th>용도</th><th>공급자 / 모델</th><th className={s.num}>호출 (성공)</th><th className={s.num}>입력 (캐시)</th><th className={s.num}>출력</th><th className={s.num}>유료</th><th className={s.num}>정가 환산</th></tr>
              </thead>
              <tbody>
                {usage.daily.map((d) => (
                  <tr key={`${d.day}-${d.alias}-${d.provider}-${d.model}`}>
                    <td>{d.day}</td><td>{d.alias}</td><td>{d.provider} / {d.model}</td><td className={s.num}>{d.calls} ({d.ok})</td>
                    <td className={s.num}>{compact(d.prompt_tokens)} ({compact(d.cached_tokens)})</td><td className={s.num}>{compact(d.completion_tokens)}</td>
                    <td className={s.num}>{usd(d.cost_usd)}</td><td className={`${s.num} muted`}>{usd(d.list_cost_usd)}</td>
                  </tr>
                ))}
                {usage.daily.length === 0 && <tr><td colSpan={8} className="muted">아직 호출이 없어요</td></tr>}
              </tbody>
            </table>
          </div>
        </details>
      </section>
      {usage.recentErrors.length > 0 && (
        <section className={s.section}>
          <h2>최근 오류 (다음 경로로 넘어간 것 포함)</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>시각 (UTC)</th><th>용도</th><th>경로</th><th>상태</th><th>오류</th></tr></thead>
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
export function UsageView({ period, series, usage, seriesError, usageError }: {
  period: Period; series: UsageSeries | null; usage: LlmUsage | null; seriesError: string | null; usageError: string | null;
}) {
  return (
    <div className={s.page}>
      <p className={s.sub}>
        {period.from === period.to ? period.from : `${period.from} ~ ${period.to}`} · 토론토 시간 · LLM 게이트웨이 기록 기준 (토큰 수만 기록, 대화 내용은 없음)
      </p>
      <Filters period={period} />
      {seriesError && <Unavailable what="LLM gateway (graphs)" reason={seriesError} />}
      {usageError && usageError !== seriesError && <Unavailable what="LLM gateway (today)" reason={usageError} />}
      {series && (
        <>
          <Tiles data={series} />
          <TokenSection data={series} />
          <PoolSection data={series} usage={usage} />
          <PaidSection data={series} usage={usage} />
          <KellySection data={series} />
          <HealthSection data={series} />
        </>
      )}
      {usage && <GatewayTables usage={usage} />}
    </div>
  );
}

