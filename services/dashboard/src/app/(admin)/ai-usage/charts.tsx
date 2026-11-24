'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { compact, full, ms, niceTicks, pct, usd } from '@/lib/usage-series';
import s from './usage.module.css';

/**
 * Small hand-drawn SVG charts for the AI usage page (no chart library). Props are plain data so
 * the server page can pass them; the browser only adds hover / keyboard read-outs and measures
 * its width. Every chart has a "표로 보기" table with the same numbers.
 */

export type Format = 'tokens' | 'usd' | 'count' | 'pct' | 'ms';

const FORMAT: Record<Format, { axis: (n: number) => string; value: (n: number) => string }> = {
  tokens: { axis: compact, value: full },
  usd: { axis: (n) => (n === 0 ? '$0' : usd(n, n >= 0.1 ? 2 : 3)), value: (n) => usd(n) },
  count: { axis: compact, value: full },
  pct: { axis: pct, value: pct },
  ms: { axis: (n) => (n === 0 ? '0' : ms(n)), value: (n) => ms(n) },
};

export interface ChartSeries {
  key: string;
  label: string;
  /** A CSS color, normally var(--…) from usage.module.css. */
  color: string;
  values: Array<number | null>;
}

interface Frame {
  /** Axis label per category (may be ""). */
  ticks: string[];
  /** Full label per category for the read-out and the table. */
  labels: string[];
  format: Format;
  height?: number;
  /** Smallest y maximum (so a cap or a 100% line is always in view). */
  yMin?: number;
  /** Fixed y maximum (e.g. 1 = 100% for shares). */
  yFixed?: number;
  /** Axis labels under the category centre (default) or on its left edge (histogram bin edges). */
  tickAt?: 'center' | 'edge';
  refLines?: Array<{ value: number; label: string }>;
  /** Shaded x ranges and vertical lines, in category units (0 = left edge of the first category). */
  bands?: Array<{ from: number; to: number; label: string }>;
  vLines?: Array<{ at: number; label: string }>;
  empty?: string;
  tableCaption: string;
}

const M = { top: 14, right: 10, bottom: 22, left: 46 };
const GAP = 2;

function useWidth(initial = 640) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

function Legend({ series, totals, format }: { series: ChartSeries[]; totals?: boolean; format: Format }) {
  if (series.length < 2) return null;
  return (
    <ul className={s.legend}>
      {series.map((x) => (
        <li key={x.key}>
          <span className={s.swatch} style={{ background: x.color }} aria-hidden />
          {x.label}
          {totals && <span className={s.legendValue}>{FORMAT[format].axis(x.values.reduce<number>((a, v) => a + (v ?? 0), 0))}</span>}
        </li>
      ))}
    </ul>
  );
}

function TableView({ caption, labels, series, format, extra }: {
  caption: string; labels: string[]; series: ChartSeries[]; format: Format; extra?: { title: string; values: string[] };
}) {
  return (
    <details className={s.tableView}>
      <summary>표로 보기</summary>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{caption}</th>
              {series.map((x) => <th key={x.key} className={s.num}>{x.label}</th>)}
              {series.length > 1 && <th className={s.num}>합계</th>}
              {extra && <th>{extra.title}</th>}
            </tr>
          </thead>
          <tbody>
            {labels.map((l, i) => (
              <tr key={`${l}-${i}`}>
                <td>{l}</td>
                {series.map((x) => <td key={x.key} className={s.num}>{x.values[i] === null ? '–' : FORMAT[format].value(x.values[i] ?? 0)}</td>)}
                {series.length > 1 && <td className={s.num}>{FORMAT[format].value(series.reduce((a, x) => a + (x.values[i] ?? 0), 0))}</td>}
                {extra && <td>{extra.values[i]}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Beside the hovered column (right of it when there is room, else left), never on top of it. */
function Tooltip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  const w = 200;
  const right = x + 14;
  const left = right + w <= width ? right : Math.max(0, x - 14 - w);
  return (
    <div className={s.tooltip} style={{ left, width: w }} role="status" aria-live="polite">
      {children}
    </div>
  );
}

function keyNav(n: number, active: number | null, set: (i: number | null) => void) {
  return (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const d = e.key === 'ArrowRight' ? 1 : -1;
      set(active === null ? (d > 0 ? 0 : n - 1) : Math.min(n - 1, Math.max(0, active + d)));
    } else if (e.key === 'Escape') set(null);
  };
}

function Axes({ width, height, bottom, yMax, ticks, format, labels, band, tickAt, refLines, bands, vLines }: {
  width: number; height: number; bottom: number; yMax: number; ticks: number[]; format: Format; labels: string[]; band: number;
  tickAt: Frame['tickAt']; refLines: Frame['refLines']; bands: Frame['bands']; vLines: Frame['vLines'];
}) {
  const plotH = height - M.top - bottom;
  const y = (v: number) => M.top + plotH - (v / yMax) * plotH;
  const x = (u: number) => M.left + u * band;
  // Show every k-th non-empty label so they stay ~48px apart (blank labels never count).
  const filled = labels.map((l, i) => (l ? i : -1)).filter((i) => i >= 0);
  const k = Math.max(1, Math.ceil((filled.length * 48) / Math.max(1, width - M.left - M.right)));
  const shown = new Set(filled.filter((_, j) => j % k === 0));
  return (
    <g>
      {(bands ?? []).map((b) => (
        <g key={`band-${b.label}`}>
          <rect x={x(b.from)} y={M.top} width={Math.max(1, x(b.to) - x(b.from))} height={plotH} className={s.band} />
          <text x={x(b.from) + 3} y={M.top + 10} className={s.annotation}>{b.label}</text>
        </g>
      ))}
      {ticks.map((t) => (
        <g key={t}>
          <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} className={t === 0 ? s.baseline : s.grid} />
          <text x={M.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className={s.tick}>{FORMAT[format].axis(t)}</text>
        </g>
      ))}
      {labels.map((l, i) =>
        shown.has(i) ? (
          <text key={`x-${i}`} x={x(tickAt === 'edge' ? i : i + 0.5)} y={height - 6} textAnchor="middle" className={s.tick}>{l}</text>
        ) : null,
      )}
      {(refLines ?? []).map((r) => (
        <g key={`ref-${r.label}`}>
          <line x1={M.left} x2={width - M.right} y1={y(r.value)} y2={y(r.value)} className={s.refLine} />
          <text x={width - M.right} y={y(r.value) - 4} textAnchor="end" className={s.annotation}>{r.label}</text>
        </g>
      ))}
      {(vLines ?? []).map((v) => (
        <g key={`v-${v.label}`}>
          <line x1={x(v.at)} x2={x(v.at)} y1={M.top} y2={M.top + plotH} className={s.refLine} />
          <text x={x(v.at) + 4} y={M.top + 22} className={s.annotation}>{v.label}</text>
        </g>
      ))}
    </g>
  );
}

/** Column path with a 4px rounded top (square at the baseline). */
function column(x: number, y: number, w: number, h: number, round: boolean): string {
  const r = round ? Math.min(4, w / 2, h) : 0;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** Stacked (or single) columns. `marks` puts a dot under chosen categories (e.g. approved days). */
export function ColumnChart(props: Frame & {
  series: ChartSeries[];
  legendTotals?: boolean;
  /** Single series only: values at or above this are drawn in the warning color. */
  over?: { at: number; label: string };
  marks?: { on: boolean[]; label: string };
}) {
  const { ref, width } = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const n = props.labels.length;
  const bottom = M.bottom + (props.marks ? 12 : 0);
  const height = (props.height ?? 200) + (props.marks ? 12 : 0);
  const plotH = height - M.top - bottom;
  const band = (width - M.left - M.right) / Math.max(n, 1);
  const totals = props.labels.map((_, i) => props.series.reduce((a, x) => a + (x.values[i] ?? 0), 0));
  const dataMax = Math.max(0, ...totals, ...(props.refLines ?? []).map((r) => r.value * 1.08));
  const ticks = props.yFixed ? niceTicks(props.yFixed) : niceTicks(Math.max(dataMax, props.yMin ?? 0));
  const yMax = ticks[ticks.length - 1] || 1;
  const barW = Math.max(1, Math.min(24, band * (band > 8 ? 0.68 : 0.8)));
  const gap = barW >= 6 ? GAP : 0;
  const isEmpty = totals.every((t) => t === 0);
  const fmt = FORMAT[props.format];
  const reachedOver = !!props.over && props.series[0]?.values.some((v) => (v ?? 0) >= props.over!.at);
  const anyMark = !!props.marks?.on.some(Boolean);

  return (
    <div className={s.chart}>
      <Legend series={props.series} totals={props.legendTotals} format={props.format} />
      <div ref={ref} className={s.plot} onPointerLeave={() => setActive(null)}>
        <svg
          width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" tabIndex={0}
          aria-label={`${props.tableCaption}별 막대 그래프. 좌우 화살표로 값을 읽을 수 있어요.`}
          onKeyDown={keyNav(n, active, setActive)} onBlur={() => setActive(null)}
        >
          <Axes width={width} height={height} bottom={bottom} yMax={yMax} ticks={ticks} format={props.format} labels={props.ticks} band={band}
            tickAt={props.tickAt} refLines={props.refLines} bands={props.bands} vLines={props.vLines} />
          {props.labels.map((_, i) => {
            const cx = M.left + i * band + (band - barW) / 2;
            let base = M.top + plotH;
            const top = props.series.reduce((last, x, k) => ((x.values[i] ?? 0) > 0 ? k : last), -1);
            return (
              <g key={i} className={active !== null && active !== i ? s.dim : undefined}>
                {props.series.map((x, k) => {
                  const v = x.values[i] ?? 0;
                  if (v <= 0) return null;
                  const h = (Math.min(v, yMax) / yMax) * plotH;
                  base -= h;
                  // The 2px surface gap sits above every segment except the top one.
                  const cut = k === top ? 0 : Math.min(gap, h / 2);
                  const drawH = Math.max(k === top ? 1 : 0, h - cut);
                  const fill = props.over && v >= props.over.at ? 'var(--viz-warn)' : x.color;
                  return <path key={x.key} d={column(cx, base + h - drawH, barW, drawH, k === top && barW >= 8)} fill={fill} />;
                })}
                {props.marks?.on[i] && <circle cx={cx + barW / 2} cy={M.top + plotH + 10} r={4} className={s.mark} />}
                <rect x={M.left + i * band} y={M.top} width={band} height={plotH + 4} fill="transparent" onPointerEnter={() => setActive(i)}
                  onPointerDown={() => setActive(i)} />
              </g>
            );
          })}
        </svg>
        {isEmpty && <div className={s.empty}>{props.empty ?? '이 기간에는 기록이 없어요'}</div>}
        {active !== null && !isEmpty && (
          <Tooltip x={M.left + (active + 0.5) * band} width={width}>
            <div className={s.ttTitle}>{props.labels[active]}</div>
            {props.series.length > 1 && (
              <div className={s.ttRow}><strong>{fmt.value(totals[active])}</strong><span>합계</span></div>
            )}
            {props.series.map((x) => (
              <div key={x.key} className={s.ttRow}>
                <span className={s.ttKey} style={{ background: x.color }} aria-hidden />
                <strong>{fmt.value(x.values[active] ?? 0)}</strong>
                <span>{x.label}</span>
              </div>
            ))}
            {props.over && (props.series[0]?.values[active] ?? 0) >= props.over.at && <div className={s.ttNote}>{props.over.label}</div>}
            {props.marks?.on[active] && <div className={s.ttNote}>● {props.marks.label}</div>}
          </Tooltip>
        )}
      </div>
      {(anyMark || reachedOver) && (
        <ul className={s.legend}>
          {reachedOver && props.over && <li><span className={s.swatch} style={{ background: 'var(--viz-warn)' }} aria-hidden />{props.over.label}</li>}
          {anyMark && <li><span className={s.dot} aria-hidden />{props.marks!.label}</li>}
        </ul>
      )}
      <TableView caption={props.tableCaption} labels={props.labels} series={props.series} format={props.format}
        extra={props.marks ? { title: props.marks.label, values: props.marks.on.map((v) => (v ? '✓' : '')) } : undefined} />
    </div>
  );
}

/** Lines over the same categories (gaps where a value is null), with a crosshair read-out. */
export function LineChart(props: Frame & { series: ChartSeries[] }) {
  const { ref, width } = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const n = props.labels.length;
  const height = props.height ?? 180;
  const plotH = height - M.top - M.bottom;
  const band = (width - M.left - M.right) / Math.max(n, 1);
  const all = props.series.flatMap((x) => x.values.filter((v): v is number => v !== null));
  const ticks = niceTicks(Math.max(0, ...all, props.yMin ?? 0));
  const yMax = ticks[ticks.length - 1] || 1;
  const y = (v: number) => M.top + plotH - (v / yMax) * plotH;
  const x = (i: number) => M.left + (i + 0.5) * band;
  const isEmpty = all.length === 0;
  const fmt = FORMAT[props.format];

  const path = (values: Array<number | null>) => {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  /** Points with no neighbour would be invisible as a line: draw them as dots. */
  const lonely = (values: Array<number | null>) =>
    values.map((v, i) => (v !== null && (values[i - 1] ?? null) === null && (values[i + 1] ?? null) === null ? i : -1)).filter((i) => i >= 0);

  return (
    <div className={s.chart}>
      <Legend series={props.series} format={props.format} />
      <div ref={ref} className={s.plot} onPointerLeave={() => setActive(null)}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const i = Math.floor((e.clientX - r.left - M.left) / band);
          setActive(i >= 0 && i < n ? i : null);
        }}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" tabIndex={0}
          aria-label={`${props.tableCaption}별 선 그래프. 좌우 화살표로 값을 읽을 수 있어요.`}
          onKeyDown={keyNav(n, active, setActive)} onBlur={() => setActive(null)}>
          <Axes width={width} height={height} bottom={M.bottom} yMax={yMax} ticks={ticks} format={props.format} labels={props.ticks} band={band}
            tickAt={props.tickAt} refLines={props.refLines} bands={props.bands} vLines={props.vLines} />
          {active !== null && <line x1={x(active)} x2={x(active)} y1={M.top} y2={M.top + plotH} className={s.crosshair} />}
          {props.series.map((sr) => (
            <g key={sr.key}>
              <path d={path(sr.values)} fill="none" stroke={sr.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {lonely(sr.values).map((i) => <circle key={i} cx={x(i)} cy={y(sr.values[i]!)} r={4} fill={sr.color} className={s.ring} />)}
              {active !== null && sr.values[active] !== null && (
                <circle cx={x(active)} cy={y(sr.values[active]!)} r={4} fill={sr.color} className={s.ring} />
              )}
            </g>
          ))}
        </svg>
        {isEmpty && <div className={s.empty}>{props.empty ?? '이 기간에는 기록이 없어요'}</div>}
        {active !== null && !isEmpty && (
          <Tooltip x={x(active)} width={width}>
            <div className={s.ttTitle}>{props.labels[active]}</div>
            {props.series.map((sr) => (
              <div key={sr.key} className={s.ttRow}>
                <span className={s.ttLine} style={{ background: sr.color }} aria-hidden />
                <strong>{sr.values[active] === null ? '–' : fmt.value(sr.values[active]!)}</strong>
                <span>{sr.label}</span>
              </div>
            ))}
          </Tooltip>
        )}
      </div>
      <TableView caption={props.tableCaption} labels={props.labels} series={props.series} format={props.format} />
    </div>
  );
}
