'use client';

import type { StylesheetJson } from 'cytoscape';
import { useMemo, useState } from 'react';
import { CytoGraph, type StyleRules } from '@/components/graph/CytoGraph';
import g from '@/components/graph/graph.module.css';
import {
  countFindings,
  FINDING_TITLES,
  findingsFor,
  graphIdOf,
  healthOf,
  selectionOf,
  serviceGraph,
  SIZE_METRICS,
  sizeMetric,
  type FindingLevel,
  type MapSelection,
  type MapService,
  type ServiceMapSnapshot,
} from '@/lib/service-map';
import s from './services.module.css';

const LEVEL_NAMES: Record<FindingLevel, string> = { danger: '위험', warn: '경고', info: '정보' };
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
      style: { width: 1.8, 'line-color': muted, 'target-arrow-shape': 'triangle', 'target-arrow-color': muted, 'arrow-scale': 0.9, opacity: 0.85 },
    },
    { selector: 'edge.broken', style: { 'line-color': bad, 'target-arrow-color': bad, 'line-style': 'dashed' } },
    { selector: 'edge.reach', style: { 'line-style': 'dashed', 'line-color': muted, width: 1.2, opacity: 0.7 } },
    { selector: 'edge.out', style: { 'line-style': 'dotted', 'line-color': muted, width: 1.4, opacity: 0.8 } },
    { selector: 'edge.member', style: { 'line-color': muted, width: 0.8, opacity: 0.45 } },
    { selector: 'node.svc.selected', style: { 'border-width': 4 } },
    { selector: 'edge.call.near, edge.call.selected', style: { opacity: 1 } },
  ] as StylesheetJson;
};

export function ServiceMapView({ snapshot, ageSeconds }: { snapshot: ServiceMapSnapshot; ageSeconds: number }) {
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
  const unused = snapshot.reachable.filter((r) => !r.used).length;
  const pick = (sel: MapSelection) => setSelection(sel);

  return (
    <div className={`${g.palette} ${s.stack}`}>
      <section className={s.summary} aria-label="요약">
        <span>
          서비스 <b>{snapshot.services.length}</b> · 실행 중 <b>{snapshot.services.filter((x) => x.status?.state === 'running').length}</b>
        </span>
        <span>
          연결 <b>{snapshot.links.length}</b> · 네트워크 <b>{snapshot.networks.length}</b>
        </span>
        <span className={s.levels}>
          {(['danger', 'warn', 'info'] as FindingLevel[]).map((lv) => (
            <span key={lv} className={`${s.level} ${s['lv_' + lv]}`}>
              {LEVEL_NAMES[lv]} {counts[lv]}
            </span>
          ))}
        </span>
        <span className="muted">수집 {ago(ageSeconds)}</span>
      </section>

      <div className={s.controls}>
        <label className={s.control}>
          <span>점 크기</span>
          <select value={sizeBy} onChange={(e) => setSizeBy(e.target.value)}>
            {SIZE_METRICS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className={s.control}>
          <span>네트워크</span>
          <select value={network} onChange={(e) => setNetwork(e.target.value)}>
            <option value="">전체</option>
            {snapshot.networks.map((n) => (
              <option key={n.id} value={n.id}>
                {n.id} ({n.members.length}){n.internal ? ' · 내부 전용' : ' · 인터넷 가능'}
              </option>
            ))}
          </select>
        </label>
        <label className={s.control}>
          <input type="checkbox" checked={external} onChange={(e) => setExternal(e.target.checked)} />
          <span>바깥 연결</span>
        </label>
        <label className={s.control}>
          <input type="checkbox" checked={reach} onChange={(e) => setReach(e.target.checked)} />
          <span>닿기만 하는 길 ({unused})</span>
        </label>
        <label className={s.control}>
          <input type="checkbox" checked={networks} onChange={(e) => setNetworks(e.target.checked)} />
          <span>네트워크 점</span>
        </label>
        <span className={s.segment} role="group" aria-label="배치">
          <button type="button" aria-pressed={layout === 'force'} onClick={() => setLayout('force')}>
            자유 배치
          </button>
          <button type="button" aria-pressed={layout === 'preset'} onClick={() => setLayout('preset')}>
            층별 정렬
          </button>
        </span>
      </div>

      <div className={g.legend} aria-label="범례">
        {snapshot.layers.slice(0, 4).map((l, i) => (
          <span key={l.id} className={g.legendItem}>
            <i className={`${g.dot} ${LAYER_DOTS[i]}`} />
            {l.label}
          </span>
        ))}
        {external && (
          <span className={g.legendItem}>
            <i className={g.diamond} />
            바깥
          </span>
        )}
        {networks && (
          <span className={g.legendItem}>
            <i className={g.square} />
            네트워크 (↗ 인터넷 가능)
          </span>
        )}
        <span className={g.legendItem}><i className={g.line} />부름</span>
        {reach && <span className={g.legendItem}><i className={g.dashed} />닿기만 함</span>}
        {external && <span className={g.legendItem}><i className={g.dotted} />바깥으로</span>}
        <span className={g.legendItem}><i className={g.broken} />부르는데 못 닿음</span>
        <span className={g.legendItem}><i className={g.ring} />주의 (이름 옆 !)</span>
        <span className={g.legendItem}>점 크기 = {metric.label} ({metric.note})</span>
      </div>

      <div className={s.layout}>
        <CytoGraph
          elements={elements}
          rules={rules}
          layout={layout}
          selectedId={graphIdOf(selection)}
          onSelect={(id) => pick(selectionOf(id))}
          searchPlaceholder="서비스, 설명, 네트워크, 바깥 연결 검색"
          label="서비스 지도: 점은 서비스, 화살표는 부르는 연결입니다. 아래 목록에서도 같은 내용을 볼 수 있습니다."
        />
        <aside className={s.panel} aria-live="polite">
          <Details snapshot={snapshot} selection={selection} byId={byId} onSelect={pick} onNetwork={setNetwork} metricLabel={metric.label} metricOf={(x) => metric.value(x, snapshot)} />
        </aside>
      </div>

      <Findings snapshot={snapshot} onSelect={(id) => pick({ kind: 'service', id })} />

      <details className={s.listView}>
        <summary>목록으로 보기 ({snapshot.services.length}개 서비스)</summary>
        <table>
          <thead>
            <tr>
              <th>서비스</th>
              <th>층</th>
              <th>상태</th>
              <th>{metric.label}</th>
              <th>인터넷</th>
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
                <td>{healthOf(x).text}</td>
                <td>{metric.value(x, snapshot) ?? '-'}</td>
                <td>{x.internet ? '가능' : '내부 전용'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function ago(seconds: number): string {
  if (seconds < 90) return `${seconds}초 전`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}분 전`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}시간 전`;
  return `${Math.round(seconds / 86400)}일 전`;
}

function Details({
  snapshot,
  selection,
  byId,
  onSelect,
  onNetwork,
  metricLabel,
  metricOf,
}: {
  snapshot: ServiceMapSnapshot;
  selection: MapSelection;
  byId: Map<string, MapService>;
  onSelect: (s: MapSelection) => void;
  onNetwork: (n: string) => void;
  metricLabel: string;
  metricOf: (s: MapService) => number | null;
}) {
  const name = (id: string) => byId.get(id)?.title || id;
  const go = (id: string) => (
    <button type="button" className={s.linkButton} onClick={() => onSelect({ kind: 'service', id })}>
      {name(id)}
    </button>
  );

  if (!selection) {
    return (
      <div className={s.empty}>
        <h2>점을 눌러 보세요</h2>
        <p className="muted">서비스를 누르면 설명, 상태, 네트워크, 포트, 볼륨, 잠금 설정, 연결이 여기에 나옵니다. 선, 바깥 연결(마름모), 네트워크(사각형)도 누를 수 있습니다.</p>
        <p className="muted">화살표는 설정에 상대 서비스 주소가 있어 실제로 부르는 연결입니다. 같은 네트워크라 닿기만 하는 길은 위 체크박스로 켭니다.</p>
      </div>
    );
  }

  if (selection.kind === 'link') {
    const l = snapshot.links.find((x) => x.from === selection.from && x.to === selection.to);
    if (!l) return null;
    return (
      <div>
        <h2>
          {go(l.from)} → {go(l.to)}
        </h2>
        <dl className={s.dl}>
          <dt>설정</dt>
          <dd>{l.via.map((v) => <code key={v}>{v}</code>)}</dd>
          <dt>지나는 네트워크</dt>
          <dd>{l.networks.length ? l.networks.map((n) => <code key={n}>{n}</code>) : <span className={s.bad}>없음: 부르는데 닿지 않습니다</span>}</dd>
        </dl>
        <p className="muted">허용된 명령 목록은 다음 단계에서 이 자리에 붙습니다(hermes-broker ROUTES, 게이트웨이 별칭).</p>
      </div>
    );
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
          <dt>같이 있는 네트워크</dt>
          <dd>{r.networks.map((n) => <code key={n}>{n}</code>)}</dd>
        </dl>
        <p className="muted">서로 닿을 수는 있지만 어느 쪽 설정에도 상대 주소가 없습니다. 쓰지 않는 길이라면 네트워크를 나눠 줄일 수 있는 권한입니다.</p>
      </div>
    );
  }

  if (selection.kind === 'external') {
    const users = snapshot.services.filter((x) => x.external.some((e) => e.name === selection.name));
    return (
      <div>
        <h2>{selection.name}</h2>
        <p className={s.subtle}>바깥 서비스 (이 스택 밖, 인터넷이나 이 PC)</p>
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
        <p className={s.subtle}>{n.internal ? '내부 전용: 인터넷으로 나갈 수 없음' : '인터넷으로 나갈 수 있음'}</p>
        <ul className={s.plainList}>
          {n.members.map((m) => (
            <li key={m}>{go(m)}</li>
          ))}
        </ul>
        <button type="button" onClick={() => onNetwork(n.id)}>
          이 네트워크만 강조
        </button>
      </div>
    );
  }

  const svc = byId.get(selection.id);
  if (!svc) return null;
  const health = healthOf(svc);
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
        <dt>상태</dt>
        <dd>
          <span className={`${s.dot} ${s[health.tone]}`} aria-hidden="true" /> {health.text}
          {started && !Number.isNaN(started.getTime()) && (
            <span className="muted"> · {started.toLocaleString('ko-KR', { timeZone: 'America/Toronto', dateStyle: 'short', timeStyle: 'short' })} 시작</span>
          )}
        </dd>
        <dt>{metricLabel}</dt>
        <dd>{metricOf(svc) ?? '-'}</dd>
        <dt>네트워크</dt>
        <dd>
          {svc.networks.map((n) => {
            const net = snapshot.networks.find((x) => x.id === n);
            return (
              <button key={n} type="button" className={s.chip} onClick={() => onNetwork(n)} title="이 네트워크만 강조">
                {n}
                {net && !net.internal ? ' ↗' : ''}
              </button>
            );
          })}
          <div className="muted">{svc.internet ? '인터넷으로 나갈 수 있음(↗ 네트워크)' : '내부 전용: 인터넷으로 나갈 수 없음'}</div>
        </dd>
        <dt>포트</dt>
        <dd>
          {svc.ports.length
            ? svc.ports.map((p) => (
                <code key={`${p.hostIp}:${p.published}`} className={p.hostIp === '127.0.0.1' ? '' : s.bad}>
                  {p.hostIp}:{p.published} → {p.target}
                </code>
              ))
            : '없음'}
        </dd>
        <dt>볼륨</dt>
        <dd>
          {svc.volumes.length
            ? svc.volumes.map((v) => (
                <div key={v.target}>
                  <code>{v.source ?? v.type}</code> → <code>{v.target}</code> {v.readOnly ? <span className="muted">읽기 전용</span> : null}
                </div>
              ))
            : '없음'}
        </dd>
        <dt>비밀(이름만)</dt>
        <dd>{svc.secrets.length ? svc.secrets.map((x) => <code key={x}>{x}</code>) : '없음'}</dd>
        <dt>잠금</dt>
        <dd>
          <ul className={s.checks}>
            <li className={h.readOnly ? s.yes : s.no}>루트 파일 시스템 읽기 전용</li>
            <li className={h.capDropAll ? s.yes : s.no}>리눅스 권한(capabilities) 모두 버림</li>
            <li className={h.noNewPrivileges ? s.yes : s.no}>권한 상승 막음(no-new-privileges)</li>
            <li className={h.healthcheck ? s.yes : s.no}>헬스체크</li>
          </ul>
          <span className="muted">
            메모리 {h.memLimitMb ?? '-'}MB · CPU {h.cpus ?? '-'} · 프로세스 {h.pidsLimit ?? '-'}
          </span>
        </dd>
        <dt>바깥 연결</dt>
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
            : '없음'}
        </dd>
        <dt>부르는 곳</dt>
        <dd>{out.length ? out.map((l) => <div key={l.to}>{go(l.to)} <span className="muted">({l.via.join(', ')})</span></div>) : '없음'}</dd>
        <dt>부르는 쪽</dt>
        <dd>{inn.length ? inn.map((l) => <div key={l.from}>{go(l.from)}</div>) : '없음'}</dd>
      </dl>

      {found.length > 0 && (
        <>
          <h3>점검 결과</h3>
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

function Findings({ snapshot, onSelect }: { snapshot: ServiceMapSnapshot; onSelect: (id: string) => void }) {
  const groups = new Map<string, typeof snapshot.findings>();
  for (const f of snapshot.findings) {
    if (!groups.has(f.code)) groups.set(f.code, []);
    groups.get(f.code)!.push(f);
  }
  if (groups.size === 0) return <p className="muted">점검 결과: 문제 없음</p>;
  return (
    <section className={s.findings}>
      <h2>점검 결과</h2>
      {[...groups.entries()].map(([code, list]) => (
        <details key={code} className={s.findingGroup} open={list[0].level !== 'info'}>
          <summary>
            <span className={`${s.level} ${s['lv_' + list[0].level]}`}>{LEVEL_NAMES[list[0].level]}</span> {FINDING_TITLES[code] || code}{' '}
            <span className="muted">({list.length})</span>
          </summary>
          <ul>
            {list.map((f) => (
              <li key={f.message}>
                {f.message}{' '}
                {f.services.slice(0, 2).map((id) => (
                  <button key={id} type="button" className={s.linkButton} onClick={() => onSelect(id)}>
                    {id} 보기
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
