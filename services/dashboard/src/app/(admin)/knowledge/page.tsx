import { CsrfField, errorText, Flash, Unavailable } from '@/components/ui';
import { knowledge } from '@/lib/knowledge';
import {
  FACT_KIND_NAMES,
  knowledgeHref,
  nodeIdOf,
  PAGE_TYPE_NAMES,
  parseSelection,
  toElements,
  type FactDetail,
  type GraphView,
  type PageDetail,
  type Selection,
} from '@/lib/knowledge-graph';
import { requireSession } from '@/lib/server';
import { KnowledgeGraph } from './graph';
import s from './knowledge.module.css';

export const dynamic = 'force-dynamic';

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const PROTECTED = new Set(['me', 'preferences']);

/**
 * Knowledge graph: pages, facts and links of the knowledge store, drawn like an Obsidian graph,
 * with plain forms to fix what is wrong. Every edit needs a reason, goes through the store's
 * dashboard client (actor "dashboard" in its change log) and never deletes for good.
 */
export default async function KnowledgePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [sp, session] = await Promise.all([searchParams, requireSession()]);
  const facts = one(sp.facts) === '1';
  const archived = one(sp.archived) === '1';
  const sel = parseSelection(one(sp.sel));
  const opts = { facts, archived };

  let graph: GraphView | null = null;
  let graphError: string | null = null;
  let page: PageDetail | null = null;
  let fact: FactDetail | null = null;
  let detailError: string | null = null;
  const [g, d] = await Promise.allSettled([
    knowledge.graph(opts),
    sel?.kind === 'page' ? knowledge.page(sel.slug) : sel?.kind === 'fact' ? knowledge.fact(sel.id) : Promise.resolve(null),
  ]);
  if (g.status === 'fulfilled') graph = g.value;
  else graphError = errorText(g.reason);
  if (d.status === 'fulfilled') {
    if (sel?.kind === 'page') page = d.value as PageDetail;
    if (sel?.kind === 'fact') fact = d.value as FactDetail;
  } else detailError = errorText(d.reason);

  const elements = graph ? toElements(graph) : [];
  const here = knowledgeHref({ ...opts, sel });
  const relations = graph ? [...new Set(graph.links.map((l) => l.relation))].sort() : [];
  const usedTypes = graph ? [...new Set(graph.pages.map((p) => p.type))] : [];

  return (
    <div className={s.page}>
      <div className={s.header}>
        <h1>Knowledge</h1>
        <nav className={s.toggles} aria-label="보기">
          <a href={knowledgeHref({ ...opts, facts: !facts, sel: facts && sel?.kind === 'fact' ? null : sel })} aria-pressed={facts}>
            {facts ? '✓ ' : ''}사실도 점으로
          </a>
          <a href={knowledgeHref({ ...opts, archived: !archived, sel })} aria-pressed={archived}>
            {archived ? '✓ ' : ''}보관한 것 포함
          </a>
        </nav>
      </div>
      <Flash ok={sp.ok} error={sp.error} />
      {graphError && <Unavailable what="Knowledge store" reason={graphError} />}

      {graph && (
        <>
          <p className={`muted ${s.counts}`}>
            문서 {graph.pages.length}
            {graph.truncated.pages ? ` / ${graph.totals.pages}` : ''} · 연결 {graph.links.length} · 같이 한 활동 {graph.doneTogether.length}
            {graph.facts ? ` · 사실 ${graph.facts.length}${graph.truncated.facts ? ` / ${graph.totals.facts}` : ''}` : ''}
          </p>
          <div className={s.legend} aria-label="범례">
            {usedTypes.map((t) => (
              <span key={t} className={s.legendItem}>
                <i className={`${s.swatch} ${s['sw_' + t] ?? s.sw_other}`} />
                {PAGE_TYPE_NAMES[t] ?? t}
              </span>
            ))}
            {facts && (
              <span className={s.legendItem}>
                <i className={`${s.swatch} ${s.sw_fact}`} />
                사실
              </span>
            )}
            <span className={s.legendItem}><i className={s.lnLink} />직접 만든 연결</span>
            <span className={s.legendItem}><i className={s.lnTogether} />같은 활동에 함께 나옴</span>
          </div>
        </>
      )}

      <div className={s.layout}>
        {graph ? (
          <KnowledgeGraph elements={elements} selectedId={nodeIdOf(sel)} facts={facts} archived={archived} />
        ) : (
          <div className={s.graphWrap} />
        )}
        <aside className={s.panel} aria-live="polite">
          {detailError && <Unavailable what="선택한 항목" reason={detailError} />}
          {!sel && <Intro />}
          {page && <PagePanel detail={page} csrf={session.csrf} here={here} opts={opts} graph={graph} relations={relations} />}
          {fact && <FactPanel detail={fact} csrf={session.csrf} here={here} opts={opts} kinds={graph?.vocab.factKinds ?? Object.keys(FACT_KIND_NAMES)} />}
        </aside>
      </div>

      {graph && (
        <details className={s.listView}>
          <summary>목록으로 보기 ({graph.pages.length}개 문서)</summary>
          <table>
            <thead>
              <tr>
                <th>문서</th>
                <th>종류</th>
                <th>사실</th>
                <th>연결</th>
              </tr>
            </thead>
            <tbody>
              {graph.pages.map((p) => (
                <tr key={p.slug}>
                  <td>
                    <a href={knowledgeHref({ ...opts, sel: { kind: 'page', slug: p.slug } })}>{p.title}</a>
                    {p.archived && <span className="muted"> (보관)</span>}
                  </td>
                  <td>{PAGE_TYPE_NAMES[p.type] ?? p.type}</td>
                  <td>{p.counts.facts}</td>
                  <td>{graph.links.filter((l) => l.source === p.slug || l.target === p.slug).length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

function Intro() {
  return (
    <div>
      <h2>점을 눌러 보세요</h2>
      <p className="muted">큰 점은 문서(과목, 주제, 사람 등)이고 크기는 사실 수입니다. "사실도 점으로"를 켜면 사실이 문서 옆 작은 점으로 나옵니다.</p>
      <p className="muted">고칠 때는 이유를 꼭 적습니다. 모든 변경은 지식 저장소 변경 기록에 dashboard로 남고, 지우는 대신 보관합니다. Kelly는 바뀐 내용을 다음 답부터 씁니다.</p>
    </div>
  );
}

function Reason() {
  return (
    <label className={s.field}>
      이유 (기록에 남음)
      <input name="reason" required maxLength={300} placeholder="예: 점수 잘못 적힘" />
    </label>
  );
}

function PagePanel({
  detail,
  csrf,
  here,
  opts,
  graph,
  relations,
}: {
  detail: PageDetail;
  csrf: string;
  here: string;
  opts: { facts: boolean; archived: boolean };
  graph: GraphView | null;
  relations: string[];
}) {
  const p = detail.page;
  const sel = (x: Selection) => knowledgeHref({ ...opts, sel: x });
  const others = (graph?.pages ?? []).filter((o) => o.slug !== p.slug && !o.archived);
  return (
    <div>
      <h2>{p.title}</h2>
      <p className={s.subtle}>
        {PAGE_TYPE_NAMES[p.type] ?? p.type} · <code>{p.slug}</code>
        {p.archived && ' · 보관됨'}
      </p>
      {p.aliases.length > 0 && <p className={s.subtle}>다른 이름: {p.aliases.join(', ')}</p>}
      {p.summary && <p>{p.summary}</p>}

      <h3>사실 {detail.facts.length}</h3>
      {detail.facts.length ? (
        <ul className={s.factList}>
          {detail.facts.map((f) => (
            <li key={f.id}>
              <a href={sel({ kind: 'fact', id: f.id })}>{f.text}</a>
              {f.kind && <span className={s.kind}>{FACT_KIND_NAMES[f.kind] ?? f.kind}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">없음</p>
      )}

      <h3>연결</h3>
      {detail.links.length + detail.linkedFrom.length === 0 && <p className="muted">없음</p>}
      <ul className={s.linkList}>
        {detail.links.map((l) => (
          <li key={`o:${l.to.slug}:${l.relation}`}>
            → <a href={sel({ kind: 'page', slug: l.to.slug })}>{l.to.title}</a> <span className="muted">{l.relation}</span>
            <form method="post" action="/api/knowledge/links/edit" className={s.inline}>
              <CsrfField token={csrf} />
              <input type="hidden" name="returnTo" value={here} />
              <input type="hidden" name="from" value={p.slug} />
              <input type="hidden" name="to" value={l.to.slug} />
              <input type="hidden" name="relation" value={l.relation} />
              <input type="hidden" name="remove" value="true" />
              <input name="reason" required maxLength={300} placeholder="지우는 이유" aria-label="연결을 지우는 이유" />
              <button type="submit" className="danger">연결 삭제</button>
            </form>
          </li>
        ))}
        {detail.linkedFrom.map((l) => (
          <li key={`i:${l.from.slug}:${l.relation}`}>
            ← <a href={sel({ kind: 'page', slug: l.from.slug })}>{l.from.title}</a> <span className="muted">{l.relation}</span>
          </li>
        ))}
      </ul>

      <details className={s.editBox}>
        <summary>제목·다른 이름 고치기</summary>
        <form method="post" action="/api/knowledge/pages/edit">
          <CsrfField token={csrf} />
          <input type="hidden" name="returnTo" value={here} />
          <input type="hidden" name="page" value={p.slug} />
          <input type="hidden" name="original_title" value={p.title} />
          <input type="hidden" name="original_aliases" value={p.aliases.join(', ')} />
          <label className={s.field}>
            제목
            <input name="title" defaultValue={p.title} required maxLength={120} />
          </label>
          <label className={s.field}>
            다른 이름 (쉼표로 구분)
            <input name="aliases" defaultValue={p.aliases.join(', ')} maxLength={1000} />
          </label>
          <Reason />
          <button type="submit" className="primary">저장</button>
        </form>
      </details>

      <details className={s.editBox}>
        <summary>연결 추가</summary>
        <form method="post" action="/api/knowledge/links/edit">
          <CsrfField token={csrf} />
          <input type="hidden" name="returnTo" value={here} />
          <input type="hidden" name="from" value={p.slug} />
          <label className={s.field}>
            연결할 문서
            <select name="to" required defaultValue="">
              <option value="" disabled>
                고르세요
              </option>
              {others.map((o) => (
                <option key={o.slug} value={o.slug}>
                  {o.title} ({PAGE_TYPE_NAMES[o.type] ?? o.type})
                </option>
              ))}
            </select>
          </label>
          <label className={s.field}>
            관계 (예: related, part_of)
            <input name="relation" required maxLength={30} list="kg-relations" defaultValue="related" />
            <datalist id="kg-relations">
              {relations.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </label>
          <label className={s.field}>
            메모 (선택)
            <input name="note" maxLength={300} />
          </label>
          <Reason />
          <button type="submit" className="primary">연결 추가</button>
        </form>
      </details>

      {!PROTECTED.has(p.slug) && (
        <details className={s.editBox}>
          <summary>{p.archived ? '되살리기' : '보관하기'}</summary>
          <form method="post" action="/api/knowledge/pages/edit">
            <CsrfField token={csrf} />
            <input type="hidden" name="returnTo" value={here} />
            <input type="hidden" name="page" value={p.slug} />
            <input type="hidden" name="archived" value={p.archived ? 'false' : 'true'} />
            {!p.archived && <p className="muted">보관하면 그래프와 Kelly의 검색·답에서 빠집니다. 지우지는 않으며 "보관한 것 포함"에서 되살릴 수 있습니다.</p>}
            <Reason />
            <label className={s.check}>
              <input type="checkbox" name="confirmed" value="yes" required /> 확인했습니다
            </label>
            <button type="submit" className={p.archived ? 'primary' : 'danger'}>
              {p.archived ? '되살리기' : '보관하기'}
            </button>
          </form>
        </details>
      )}
    </div>
  );
}

function FactPanel({
  detail,
  csrf,
  here,
  opts,
  kinds,
}: {
  detail: FactDetail;
  csrf: string;
  here: string;
  opts: { facts: boolean; archived: boolean };
  kinds: string[];
}) {
  const f = detail;
  const old = f.status === 'superseded';
  return (
    <div>
      <h2>사실</h2>
      <p className={s.subtle}>
        <a href={knowledgeHref({ ...opts, sel: { kind: 'page', slug: f.page.slug } })}>{f.page.title}</a> ·{' '}
        {f.kind ? (FACT_KIND_NAMES[f.kind] ?? f.kind) : '종류 없음'} · {f.status === 'active' ? '사용 중' : f.status === 'removed' ? '보관됨' : '옛 버전'}
      </p>
      <p className={s.factText}>{f.text}</p>
      <dl className={s.dl}>
        {f.observedOn && (
          <>
            <dt>날짜</dt>
            <dd>{f.observedOn}</dd>
          </>
        )}
        <dt>출처</dt>
        <dd>{f.source == null ? '없음' : typeof f.source === 'string' ? f.source : `원본 ${f.source.rawId.slice(0, 8)}…`}</dd>
        <dt>만든 쪽</dt>
        <dd>{f.createdBy}</dd>
        <dt>바뀐 때</dt>
        <dd>{f.updatedAt.slice(0, 16).replace('T', ' ')}</dd>
      </dl>

      {old ? (
        <p className="muted">
          옛 버전이라 고칠 수 없습니다.{' '}
          {f.supersededBy && <a href={knowledgeHref({ ...opts, sel: { kind: 'fact', id: f.supersededBy } })}>새 버전 보기</a>}
        </p>
      ) : (
        <>
          {f.status === 'active' && (
            <details className={s.editBox} open>
              <summary>고치기</summary>
              <form method="post" action={`/api/knowledge/facts/${f.id}/edit`}>
                <CsrfField token={csrf} />
                <input type="hidden" name="returnTo" value={here} />
                <input type="hidden" name="original_text" value={f.text} />
                <input type="hidden" name="original_kind" value={f.kind ?? ''} />
                <label className={s.field}>
                  내용 (바꾸면 새 버전이 생기고 지금 것은 옛 버전으로 남음)
                  <textarea name="text" defaultValue={f.text} required maxLength={1000} rows={5} />
                </label>
                <label className={s.field}>
                  종류
                  <select name="kind" defaultValue={f.kind ?? ''}>
                    <option value="">없음</option>
                    {kinds.map((k) => (
                      <option key={k} value={k}>
                        {FACT_KIND_NAMES[k] ?? k}
                      </option>
                    ))}
                  </select>
                </label>
                <Reason />
                <button type="submit" className="primary">저장</button>
              </form>
            </details>
          )}
          <details className={s.editBox}>
            <summary>{f.status === 'removed' ? '되살리기' : '보관하기'}</summary>
            <form method="post" action={`/api/knowledge/facts/${f.id}/archive`}>
              <CsrfField token={csrf} />
              <input type="hidden" name="returnTo" value={here} />
              <input type="hidden" name="archived" value={f.status === 'removed' ? 'false' : 'true'} />
              {f.status !== 'removed' && <p className="muted">보관하면 Kelly의 검색·답에서 빠집니다. 지우지는 않습니다.</p>}
              <Reason />
              <button type="submit" className={f.status === 'removed' ? 'primary' : 'danger'}>
                {f.status === 'removed' ? '되살리기' : '보관하기'}
              </button>
            </form>
          </details>
        </>
      )}
    </div>
  );
}
