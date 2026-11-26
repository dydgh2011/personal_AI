'use client';

import type { StylesheetJson } from 'cytoscape';
import { useMemo, useState, type ReactNode } from 'react';
import { CytoGraph, type StyleRules } from '@/components/graph/CytoGraph';
import g from '@/components/graph/graph.module.css';
import type { Dict } from '@/i18n';
import { useT } from '@/i18n/client';
import { fmtDateTime } from '@/i18n/format';
import {
  countsMatch,
  countFindings,
  findingsFor,
  graphIdOf,
  healthOf,
  opGroups,
  selectionOf,
  serviceGraph,
  SIZE_METRICS,
  sizeMetric,
  unlistedCalls,
  type CallWindow,
  type FindingLevel,
  type LinkCalls,
  type LinkRuleSet,
  type MapLink,
  type OpRow,
  type MapSelection,
  type MapService,
  type ServiceMapSnapshot,
} from '@/lib/service-map';
import s from './services.module.css';

const LAYER_SLOTS = ['--viz-s1', '--viz-s2', '--viz-s3', '--viz-s4'];
const LAYER_DOTS = [g.s1, g.s2, g.s3, g.s4];

const rules: StyleRules = (css) => {
  const panel2 = css('--panel-2', '#1c212a');
  const muted = css('--muted', '#8b95a5');
  const warn = css('--warn', '#e5b454');
  const bad = css('--bad', '#ef6b6b');
  const other = css('--viz-other', '#6b7280');
  return [
    { selector: 'node.svc', style: { width: 'data(size)', height: 'data(size)', 'font-size': 12 } },
    ...LAYER_SLOTS.map((v, i) => ({ selector: `node.layer-${i}`, style: { 'background-color': css(v, other) } })),
    { selector: 'node.st-warn', style: { 'border-color': warn, 'border-width': 3 } },
    { selector: 'node.st-bad', style: { 'border-color': bad, 'border-width': 3 } },
    { selector: 'node.down', style: { opacity: 0.45 } },
    { selector: 'node.ext', style: { shape: 'diamond', width: 16, height: 16, 'background-color': other, 'font-size': 11, color: muted } },
    { selector: 'node.net', style: { shape: 'round-rectangle', width: 14, height: 10, 'background-color': panel2, 'border-color': muted, 'border-width': 1, 'font-size': 10, color: muted, 'min-zoomed-font-size': 9 } },
    { selector: 'node.net-open', style: { 'border-style': 'dashed' } },
    {
      selector: 'edge.call',
      style: { width: 'data(width)', 'line-color': muted, 'target-arrow-shape': 'triangle', 'target-arrow-color': muted, 'arrow-scale': 0.9, opacity: 0.85 },
    },
    { selector: 'edge.call.quiet', style: { opacity: 0.45 } },
    { selector: 'edge.broken', style: { 'line-color': bad, 'target-arrow-color': bad, 'line-style': 'dashed' } },
    { selector: 'edge.reach', style: { 'line-style': 'dashed', 'line-color': muted, width: 1.2, opacity: 0.7 } },
    { selector: 'edge.out', style: { 'line-style': 'dotted', 'line-color': muted, width: 1.4, opacity: 0.8 } },
    { selector: 'edge.member', style: { 'line-color': muted, width: 0.8, opacity: 0.45 } },
    { selector: 'node.svc.selected', style: { 'border-width': 4 } },
    { selector: 'edge.call.near, edge.call.selected', style: { opacity: 1 } },
  ] as StylesheetJson;
};

export function ServiceMapView({ snapshot, ageSeconds }: { snapshot: ServiceMapSnapshot; ageSeconds: number }) {
  const t = useT();
  const k = t.svc;
  const count = (n: number) => n.toLocaleString(t.locale);
  const [selection, setSelection] = useState<MapSelection>(null);
  const [network, setNetwork] = useState('');
  const [sizeBy, setSizeBy] = useState(SIZE_METRICS[0].id);
  const [reach, setReach] = useState(false);
  const [external, setExternal] = useState(true);
  const [networks, setNetworks] = useState(false);
  const [layout, setLayout] = useState<'force' | 'preset'>('force');

  const byId = useMemo(() => new Map(snapshot.services.map((x) => [x.id, x])), [snapshot]);
  const counts = useMemo(() => countFindings(snapshot), [snapshot]);
  const elements = useMemo(
    () => serviceGraph(snapshot, { sizeBy, reach, external, networks, network, layout }),
    [snapshot, sizeBy, reach, external, networks, network, layout],
  );
  const metric = sizeMetric(sizeBy);
  const metricText = k.metrics[metric.id] ?? { label: metric.id, note: '' };
  const unused = snapshot.reachable.filter((r) => !r.used).length;
  const w = snapshot.callWindow;
  const recent = w ? snapshot.links.reduce((n, l) => n + (l.calls?.total ?? 0), 0) : null;
  const missing = w ? w.sources.filter((x) => !x.ok).map((x) => x.id) : [];
  const pick = (sel: MapSelection) => setSelection(sel);

  return (
    <div className={`${g.palette} ${s.stack}`}>
      <section className={s.summary} aria-label={k.summaryAria}>
        <span>
          {k.services} <b>{snapshot.services.length}</b> · {k.running} <b>{snapshot.services.filter((x) => x.status?.state === 'running').length}</b>
        </span>
        <span>
          {k.links} <b>{snapshot.links.length}</b> · {k.networks} <b>{snapshot.networks.length}</b>
        </span>
        {w && recent !== null && (
          <span title={missing.length ? k.unreadSources(missing.join(', ')) : undefined}>
            {k.recentCalls(w.hours)} <b>{count(recent)}</b>
            {missing.length > 0 && <span className="muted">{k.partlyUnread}</span>}
          </span>
        )}
        <span className={s.levels}>
          {(['danger', 'warn', 'info'] as FindingLevel[]).map((lv) => (
            <span key={lv} className={`${s.level} ${s['lv_' + lv]}`}>
              {k.levels[lv]} {counts[lv]}
            </span>
          ))}
        </span>
        <span className="muted">{k.collected(ago(ageSeconds, t))}</span>
      </section>

      <div className={s.controls}>
        <label className={s.control}>
          <span>{k.dotSize}</span>
          <select value={sizeBy} onChange={(e) => setSizeBy(e.target.value)}>
            {SIZE_METRICS.map((m) => (
              <option key={m.id} value={m.id}>
                {k.metrics[m.id]?.label ?? m.id}
              </option>
            ))}
          </select>
        </label>
        <label className={s.control}>
          <span>{k.network}</span>
          <select value={network} onChange={(e) => setNetwork(e.target.value)}>
            <option value="">{k.all}</option>
            {snapshot.networks.map((n) => (
              <option key={n.id} value={n.id}>
                {n.id} ({n.members.length}){n.internal ? k.internalOnly : k.internetOk}
              </option>
            ))}
          </select>
        </label>
        <label className={s.control}>
          <input type="checkbox" checked={external} onChange={(e) => setExternal(e.target.checked)} />
          <span>{k.external}</span>
        </label>
        <label className={s.control}>
          <input type="checkbox" checked={reach} onChange={(e) => setReach(e.target.checked)} />
          <span>{k.reachOnly(unused)}</span>
        </label>
        <label className={s.control}>
          <input type="checkbox" checked={networks} onChange={(e) => setNetworks(e.target.checked)} />
          <span>{k.networkDots}</span>
        </label>
        <span className={s.segment} role="group" aria-label={k.layoutAria}>
          <button type="button" aria-pressed={layout === 'force'} onClick={() => setLayout('force')}>
            {k.free}
          </button>
          <button type="button" aria-pressed={layout === 'preset'} onClick={() => setLayout('preset')}>
            {k.layered}
          </button>
        </span>
      </div>

      <div className={g.legend} aria-label={k.legendAria}>
        {snapshot.layers.slice(0, 4).map((l, i) => (
          <span key={l.id} className={g.legendItem}>
            <i className={`${g.dot} ${LAYER_DOTS[i]}`} />
            {l.label}
          </span>
        ))}
        {external && (
          <span className={g.legendItem}>
            <i className={g.diamond} />
            {k.outside}
          </span>
        )}
        {networks && (
          <span className={g.legendItem}>
            <i className={g.square} />
            {k.networkLegend}
          </span>
        )}
        <span className={g.legendItem}><i className={g.line} />{k.calls}{w ? k.callsWidth(w.hours) : ''}</span>
        {reach && <span className={g.legendItem}><i className={g.dashed} />{k.reachLegend}</span>}
        {external && <span className={g.legendItem}><i className={g.dotted} />{k.outward}</span>}
        <span className={g.legendItem}><i className={g.broken} />{k.broken}</span>
        <span className={g.legendItem}><i className={g.ring} />{k.attention}</span>
        <span className={g.legendItem}>{k.sizeLegend(metricText.label, metricText.note)}</span>
      </div>

      <div className={s.layout}>
        <CytoGraph
          elements={elements}
          rules={rules}
          layout={layout}
          selectedId={graphIdOf(selection)}
          onSelect={(id) => pick(selectionOf(id))}
          searchPlaceholder={k.searchPlaceholder}
          label={k.graphLabel}
        />
        <aside className={s.panel} aria-live="polite">
          <Details t={t} snapshot={snapshot} selection={selection} byId={byId} onSelect={pick} onNetwork={setNetwork} metricLabel={metricText.label} metricOf={(x) => metric.value(x, snapshot)} />
        </aside>
      </div>

      <Findings t={t} snapshot={snapshot} onSelect={(id) => pick({ kind: 'service', id })} />

      <details className={s.listView}>
        <summary>{k.listView(snapshot.services.length)}</summary>
        <table>
          <thead>
            <tr>
              <th>{k.service}</th>
              <th>{k.layer}</th>
              <th>{k.status}</th>
              <th>{metricText.label}</th>
              <th>{k.internet}</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.services.map((x) => (
              <tr key={x.id}>
                <td>
                  <button type="button" className={s.linkButton} onClick={() => pick({ kind: 'service', id: x.id })}>
                    {x.title}
                  </button>
                </td>
                <td>{snapshot.layers.find((l) => l.id === x.layer)?.label ?? x.layer}</td>
                <td>{healthOf(x, t).text}</td>
                <td>{metric.value(x, snapshot) ?? '-'}</td>
                <td>{x.internet ? k.yes : k.internalShort}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function ago(seconds: number, t: Dict): string {
  const a = t.svc.ago;
  if (seconds < 90) return a.s(seconds);
  if (seconds < 5400) return a.m(Math.round(seconds / 60));
  if (seconds < 172800) return a.h(Math.round(seconds / 3600));
  return a.d(Math.round(seconds / 86400));
}

function Details({
  t,
  snapshot,
  selection,
  byId,
  onSelect,
  onNetwork,
  metricLabel,
  metricOf,
}: {
  t: Dict;
  snapshot: ServiceMapSnapshot;
  selection: MapSelection;
  byId: Map<string, MapService>;
  onSelect: (s: MapSelection) => void;
  onNetwork: (n: string) => void;
  metricLabel: string;
  metricOf: (s: MapService) => number | null;
}) {
  const k = t.svc;
  const name = (id: string) => byId.get(id)?.title || id;
  const go = (id: string) => (
    <button type="button" className={s.linkButton} onClick={() => onSelect({ kind: 'service', id })}>
      {name(id)}
    </button>
  );

  if (!selection) {
    return (
      <div className={s.empty}>
        <h2>{k.introTitle}</h2>
        <p className="muted">{k.intro1}</p>
        <p className="muted">{k.intro2}</p>
      </div>
    );
  }

  if (selection.kind === 'link') {
    const l = snapshot.links.find((x) => x.from === selection.from && x.to === selection.to);
    if (!l) return null;
    return <LinkPanel t={t} link={l} window={snapshot.callWindow} name={name} go={go} />;
  }

  if (selection.kind === 'reach') {
    const r = snapshot.reachable.find((x) => x.a === selection.a && x.b === selection.b);
    if (!r) return null;
    return (
      <div>
        <h2>
          {go(r.a)} ↔ {go(r.b)}
        </h2>
        <dl className={s.dl}>
          <dt>{k.sharedNetworks}</dt>
          <dd>{r.networks.map((n) => <code key={n}>{n}</code>)}</dd>
        </dl>
        <p className="muted">{k.reachNote}</p>
      </div>
    );
  }

  if (selection.kind === 'external') {
    const users = snapshot.services.filter((x) => x.external.some((e) => e.name === selection.name));
    return (
      <div>
        <h2>{selection.name}</h2>
        <p className={s.subtle}>{k.externalSub}</p>
        <ul className={s.plainList}>
          {users.map((u) => (
            <li key={u.id}>
              {go(u.id)} <span className="muted">{u.external.find((e) => e.name === selection.name)?.purpose}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (selection.kind === 'network') {
    const n = snapshot.networks.find((x) => x.id === selection.id);
    if (!n) return null;
    return (
      <div>
        <h2>{n.id}</h2>
        <p className={s.subtle}>{n.internal ? k.netInternal : k.netInternet}</p>
        <ul className={s.plainList}>
          {n.members.map((m) => (
            <li key={m}>{go(m)}</li>
          ))}
        </ul>
        <button type="button" onClick={() => onNetwork(n.id)}>
          {k.highlight}
        </button>
      </div>
    );
  }

  const svc = byId.get(selection.id);
  if (!svc) return null;
  const health = healthOf(svc, t);
  const out = snapshot.links.filter((l) => l.from === svc.id);
  const inn = snapshot.links.filter((l) => l.to === svc.id);
  const found = findingsFor(snapshot, svc.id);
  const h = svc.hardening;
  const started = svc.status?.startedAt ? new Date(svc.status.startedAt) : null;
  return (
    <div>
      <h2>{svc.title}</h2>
      <p className={s.subtle}>
        <code>{svc.id}</code>
        {svc.image && <> · {svc.image}</>}
      </p>
      {svc.description && <p>{svc.description}</p>}

      <dl className={s.dl}>
        <dt>{k.status}</dt>
        <dd>
          <span className={`${s.dot} ${s[health.tone]}`} aria-hidden="true" /> {health.text}
          {started && !Number.isNaN(started.getTime()) && (
            <span className="muted">{k.started(fmtDateTime(t, started, { timeZone: 'America/Toronto', dateStyle: 'short', timeStyle: 'short' }))}</span>
          )}
        </dd>
        <dt>{metricLabel}</dt>
        <dd>{metricOf(svc) ?? '-'}</dd>
        <dt>{k.network}</dt>
        <dd>
          {svc.networks.map((n) => {
            const net = snapshot.networks.find((x) => x.id === n);
            return (
              <button key={n} type="button" className={s.chip} onClick={() => onNetwork(n)} title={k.highlight}>
                {n}
                {net && !net.internal ? ' ↗' : ''}
              </button>
            );
          })}
          <div className="muted">{svc.internet ? k.svcInternet : k.netInternal}</div>
        </dd>
        <dt>{k.ports}</dt>
        <dd>
          {svc.ports.length
            ? svc.ports.map((p) => (
                <code key={`${p.hostIp}:${p.published}`} className={p.hostIp === '127.0.0.1' ? '' : s.bad}>
                  {p.hostIp}:{p.published} → {p.target}
                </code>
              ))
            : k.none}
        </dd>
        <dt>{k.volumes}</dt>
        <dd>
          {svc.volumes.length
            ? svc.volumes.map((v) => (
                <div key={v.target}>
                  <code>{v.source ?? v.type}</code> → <code>{v.target}</code> {v.readOnly ? <span className="muted">{k.readOnly}</span> : null}
                </div>
              ))
            : k.none}
        </dd>
        <dt>{k.secrets}</dt>
        <dd>{svc.secrets.length ? svc.secrets.map((x) => <code key={x}>{x}</code>) : k.none}</dd>
        <dt>{k.lockdown}</dt>
        <dd>
          <ul className={s.checks}>
            <li className={h.readOnly ? s.yes : s.no}>{k.roRoot}</li>
            <li className={h.capDropAll ? s.yes : s.no}>{k.capDrop}</li>
            <li className={h.noNewPrivileges ? s.yes : s.no}>{k.noNewPriv}</li>
            <li className={h.healthcheck ? s.yes : s.no}>{k.healthcheck}</li>
          </ul>
          <span className="muted">
            {k.limits(String(h.memLimitMb ?? '-'), String(h.cpus ?? '-'), String(h.pidsLimit ?? '-'))}
          </span>
        </dd>
        <dt>{k.external}</dt>
        <dd>
          {svc.external.length
            ? svc.external.map((e) => (
                <div key={e.name}>
                  <button type="button" className={s.linkButton} onClick={() => onSelect({ kind: 'external', name: e.name })}>
                    {e.name}
                  </button>{' '}
                  <span className="muted">{e.purpose}</span>
                </div>
              ))
            : k.none}
        </dd>
        <dt>{k.callsTo}</dt>
        <dd>
          {out.length
            ? out.map((l) => (
                <div key={l.to}>
                  {go(l.to)} <span className="muted">({l.via.join(', ')}){callsText(l, snapshot.callWindow, t)}</span>
                </div>
              ))
            : k.none}
        </dd>
        <dt>{k.callsFrom}</dt>
        <dd>
          {inn.length
            ? inn.map((l) => (
                <div key={l.from}>
                  {go(l.from)} <span className="muted">{callsText(l, snapshot.callWindow, t)}</span>
                </div>
              ))
            : k.none}
        </dd>
      </dl>

      {found.length > 0 && (
        <>
          <h3>{k.findings}</h3>
          <ul className={s.findingList}>
            {found.map((f) => (
              <li key={f.code + f.message} className={s['lv_' + f.level]}>
                {f.message}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function callsText(l: MapLink, w: CallWindow | undefined, t: Dict): string {
  if (!w || !l.calls) return '';
  const count = (n: number) => n.toLocaleString(t.locale);
  return t.svc.callsText(w.hours, count(l.calls.total), l.calls.failed ? count(l.calls.failed) : null);
}

/** One link: its config, recent calls and the operations the code allows on it. Exported for tests. */
export function LinkPanel({
  t,
  link: l,
  window: w,
  name,
  go,
}: {
  t: Dict;
  link: MapLink;
  window: CallWindow | undefined;
  name: (id: string) => string;
  go: (id: string) => ReactNode;
}) {
  const unlisted = unlistedCalls(l);
  const k = t.svc;
  const count = (n: number) => n.toLocaleString(t.locale);
  return (
    <div>
      <h2>
        {go(l.from)} → {go(l.to)}
      </h2>
      <dl className={s.dl}>
        <dt>{k.config}</dt>
        <dd>{l.via.map((v) => <code key={v}>{v}</code>)}</dd>
        <dt>{k.viaNetworks}</dt>
        <dd>{l.networks.length ? l.networks.map((n) => <code key={n}>{n}</code>) : <span className={s.bad}>{k.noNetwork}</span>}</dd>
        {w && (
          <>
            <dt>{k.recentHours(w.hours)}</dt>
            <dd>
              {l.calls ? (
                <>
                  <b>{k.times(count(l.calls.total))}</b>
                  {l.calls.failed > 0 && <span className={s.failed}>{k.failedN(count(l.calls.failed))}</span>}
                  <div className="muted">{k.source(l.calls.source)}</div>
                </>
              ) : (
                <span className="muted">{k.notMeasured}</span>
              )}
            </dd>
          </>
        )}
      </dl>

      <h3>{k.allowed}</h3>
      {l.allowed === undefined ? (
        <p className="muted">{k.noRulesInSnapshot}</p>
      ) : l.allowed.length === 0 ? (
        <p className="muted">{k.rulesNotRead}</p>
      ) : (
        l.allowed.map((set) => <RuleSet t={t} key={`${set.by}:${set.role}:${set.source}`} set={set} calls={l.calls} name={name} />)
      )}

      {unlisted.length > 0 && (
        <>
          <h3>{k.unlisted}</h3>
          <p className={s.subtle}>{k.unlistedNote}</p>
          <ul className={s.opList}>
            {unlisted.map((o) => (
              <li key={o.name} className={s.opRow}>
                <span className={s.opMain}>
                  <code>{o.name}</code>
                </span>
                <span className={s.opCount}>
                  {count(o.total)}
                  {o.failed > 0 && <span className={s.failed}>{k.failedParen(count(o.failed))}</span>}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function RuleSet({ t, set, calls, name }: { t: Dict; set: LinkRuleSet; calls: LinkCalls | undefined; name: (id: string) => string }) {
  const k = t.svc;
  const count = (n: number) => n.toLocaleString(t.locale);
  const groups = opGroups(set, calls);
  const perOp = countsMatch(set, calls);
  return (
    <section className={s.ruleSet}>
      <div className={s.ruleHead}>
        <b>{set.role === 'callee' ? k.calleeList(name(set.by)) : k.forwardList(name(set.by))}</b>
        <span className="muted">{k.opCount(set.ops.length)}</span>
      </div>
      <p className={s.subtle}>
        {set.role === 'callee' ? k.calleeNote : k.forwardNote} <code>{set.source}</code>
        {calls && !perOp && <>{k.totalsOnly}</>}
      </p>
      {groups.length === 1 ? (
        <OpList t={t} ops={groups[0].ops} />
      ) : (
        groups.map((gr) => (
          <details key={gr.key} className={s.opGroup}>
            <summary>
              <code>{gr.key}</code> <span className="muted">{k.groupCount(gr.ops.length)}</span>
              {gr.total !== null && <span className={s.opCount}>{k.times(count(gr.total))}</span>}
            </summary>
            <OpList t={t} ops={gr.ops} />
          </details>
        ))
      )}
    </section>
  );
}

function OpList({ t, ops }: { t: Dict; ops: OpRow[] }) {
  const count = (n: number) => n.toLocaleString(t.locale);
  return (
    <ul className={s.opList}>
      {ops.map((o) => (
        <li key={`${o.method} ${o.path} ${o.name}`} className={`${s.opRow}${o.total === 0 ? ` ${s.opIdle}` : ''}`}>
          <span className={s.method} data-method={o.method}>
            {o.method}
          </span>
          <span className={s.opMain}>
            <code>{o.path}</code>
            {o.name !== `${o.method} ${o.path}` && <span className={s.opName}>{o.name}</span>}
          </span>
          {o.total !== null && (
            <span className={s.opCount} title={t.svc.recentCallsTitle}>
              {count(o.total)}
              {o.failed > 0 && <span className={s.failed}>{t.svc.failedParen(count(o.failed))}</span>}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function Findings({ t, snapshot, onSelect }: { t: Dict; snapshot: ServiceMapSnapshot; onSelect: (id: string) => void }) {
  const k = t.svc;
  const groups = new Map<string, typeof snapshot.findings>();
  for (const f of snapshot.findings) {
    if (!groups.has(f.code)) groups.set(f.code, []);
    groups.get(f.code)!.push(f);
  }
  if (groups.size === 0) return <p className="muted">{k.noFindings}</p>;
  return (
    <section className={s.findings}>
      <h2>{k.findings}</h2>
      {[...groups.entries()].map(([code, list]) => (
        <details key={code} className={s.findingGroup} open={list[0].level !== 'info'}>
          <summary>
            <span className={`${s.level} ${s['lv_' + list[0].level]}`}>{k.levels[list[0].level]}</span> {k.findingTitles[code] || code}{' '}
            <span className="muted">({list.length})</span>
          </summary>
          <ul>
            {list.map((f) => (
              <li key={f.message}>
                {f.message}{' '}
                {f.services.slice(0, 2).map((id) => (
                  <button key={id} type="button" className={s.linkButton} onClick={() => onSelect(id)}>
                    {k.viewService(id)}
                  </button>
                ))}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </section>
  );
}
