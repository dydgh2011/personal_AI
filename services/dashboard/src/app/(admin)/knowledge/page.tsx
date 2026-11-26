import { CsrfField, errorText, Flash, Unavailable } from '@/components/ui';
import { knowledge } from '@/lib/knowledge';
import {
  knowledgeHref,
  nodeIdOf,
  parseSelection,
  toElements,
  type FactDetail,
  type GraphView,
  type PageDetail,
  type Selection,
} from '@/lib/knowledge-graph';
import { requireSession } from '@/lib/server';
import type { Dict } from '@/i18n';
import { getT } from '@/i18n/server';
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
  const [sp, session, t] = await Promise.all([searchParams, requireSession(), getT()]);
  const k = t.kg;
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
  else graphError = errorText(g.reason, t);
  if (d.status === 'fulfilled') {
    if (sel?.kind === 'page') page = d.value as PageDetail;
    if (sel?.kind === 'fact') fact = d.value as FactDetail;
  } else detailError = errorText(d.reason, t);

  const elements = graph ? toElements(graph) : [];
  const here = knowledgeHref({ ...opts, sel });
  const relations = graph ? [...new Set(graph.links.map((l) => l.relation))].sort() : [];
  const usedTypes = graph ? [...new Set(graph.pages.map((p) => p.type))] : [];

  return (
    <div className={s.page}>
      <div className={s.header}>
        <h1>{k.title}</h1>
        <nav className={s.toggles} aria-label={k.viewAria}>
          <a href={knowledgeHref({ ...opts, facts: !facts, sel: facts && sel?.kind === 'fact' ? null : sel })} aria-pressed={facts}>
            {facts ? '✓ ' : ''}{k.factsAsDots}
          </a>
          <a href={knowledgeHref({ ...opts, archived: !archived, sel })} aria-pressed={archived}>
            {archived ? '✓ ' : ''}{k.includeArchived}
          </a>
        </nav>
      </div>
      <Flash ok={sp.ok} error={sp.error} />
      {graphError && <Unavailable t={t} what={k.storeWhat} reason={graphError} />}

      {graph && (
        <>
          <p className={`muted ${s.counts}`}>
            {k.counts(`${graph.pages.length}${graph.truncated.pages ? ` / ${graph.totals.pages}` : ''}`, graph.links.length, graph.doneTogether.length)}
            {graph.facts ? k.factCount(`${graph.facts.length}${graph.truncated.facts ? ` / ${graph.totals.facts}` : ''}`) : ''}
          </p>
          <div className={s.legend} aria-label={k.legendAria}>
            {usedTypes.map((type) => (
              <span key={type} className={s.legendItem}>
                <i className={`${s.swatch} ${s['sw_' + type] ?? s.sw_other}`} />
                {k.pageTypes[type] ?? type}
              </span>
            ))}
            {facts && (
              <span className={s.legendItem}>
                <i className={`${s.swatch} ${s.sw_fact}`} />
                {k.fact}
              </span>
            )}
            <span className={s.legendItem}><i className={s.lnLink} />{k.directLink}</span>
            <span className={s.legendItem}><i className={s.lnTogether} />{k.together}</span>
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
          {detailError && <Unavailable t={t} what={k.selectedWhat} reason={detailError} />}
          {!sel && <Intro t={t} />}
          {page && <PagePanel t={t} detail={page} csrf={session.csrf} here={here} opts={opts} graph={graph} relations={relations} />}
          {fact && <FactPanel t={t} detail={fact} csrf={session.csrf} here={here} opts={opts} kinds={graph?.vocab.factKinds ?? Object.keys(k.factKinds)} />}
        </aside>
      </div>

      {graph && (
        <details className={s.listView}>
          <summary>{k.listView(graph.pages.length)}</summary>
          <table>
            <thead>
              <tr>
                <th>{k.page}</th>
                <th>{k.type}</th>
                <th>{k.facts}</th>
                <th>{k.links}</th>
              </tr>
            </thead>
            <tbody>
              {graph.pages.map((p) => (
                <tr key={p.slug}>
                  <td>
                    <a href={knowledgeHref({ ...opts, sel: { kind: 'page', slug: p.slug } })}>{p.title}</a>
                    {p.archived && <span className="muted">{k.archivedMark}</span>}
                  </td>
                  <td>{k.pageTypes[p.type] ?? p.type}</td>
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

function Intro({ t }: { t: Dict }) {
  return (
    <div>
      <h2>{t.kg.introTitle}</h2>
      <p className="muted">{t.kg.intro1}</p>
      <p className="muted">{t.kg.intro2}</p>
    </div>
  );
}

function Reason({ t }: { t: Dict }) {
  return (
    <label className={s.field}>
      {t.kg.reason}
      <input name="reason" required maxLength={300} placeholder={t.kg.reasonPlaceholder} />
    </label>
  );
}

function PagePanel({
  t,
  detail,
  csrf,
  here,
  opts,
  graph,
  relations,
}: {
  t: Dict;
  detail: PageDetail;
  csrf: string;
  here: string;
  opts: { facts: boolean; archived: boolean };
  graph: GraphView | null;
  relations: string[];
}) {
  const p = detail.page;
  const k = t.kg;
  const sel = (x: Selection) => knowledgeHref({ ...opts, sel: x });
  const others = (graph?.pages ?? []).filter((o) => o.slug !== p.slug && !o.archived);
  return (
    <div>
      <h2>{p.title}</h2>
      <p className={s.subtle}>
        {k.pageTypes[p.type] ?? p.type} · <code>{p.slug}</code>
        {p.archived && k.archivedSuffix}
      </p>
      {p.aliases.length > 0 && <p className={s.subtle}>{k.aliases(p.aliases.join(', '))}</p>}
      {p.summary && <p>{p.summary}</p>}

      <h3>{k.factsN(detail.facts.length)}</h3>
      {detail.facts.length ? (
        <ul className={s.factList}>
          {detail.facts.map((f) => (
            <li key={f.id}>
              <a href={sel({ kind: 'fact', id: f.id })}>{f.text}</a>
              {f.kind && <span className={s.kind}>{k.factKinds[f.kind] ?? f.kind}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{k.none}</p>
      )}

      <h3>{k.links}</h3>
      {detail.links.length + detail.linkedFrom.length === 0 && <p className="muted">{k.none}</p>}
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
              <input name="reason" required maxLength={300} placeholder={k.removeReason} aria-label={k.removeReasonAria} />
              <button type="submit" className="danger">{k.removeLink}</button>
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
        <summary>{k.editTitle}</summary>
        <form method="post" action="/api/knowledge/pages/edit">
          <CsrfField token={csrf} />
          <input type="hidden" name="returnTo" value={here} />
          <input type="hidden" name="page" value={p.slug} />
          <input type="hidden" name="original_title" value={p.title} />
          <input type="hidden" name="original_aliases" value={p.aliases.join(', ')} />
          <label className={s.field}>
            {k.titleField}
            <input name="title" defaultValue={p.title} required maxLength={120} />
          </label>
          <label className={s.field}>
            {k.aliasesField}
            <input name="aliases" defaultValue={p.aliases.join(', ')} maxLength={1000} />
          </label>
          <Reason t={t} />
          <button type="submit" className="primary">{k.save}</button>
        </form>
      </details>

      <details className={s.editBox}>
        <summary>{k.addLink}</summary>
        <form method="post" action="/api/knowledge/links/edit">
          <CsrfField token={csrf} />
          <input type="hidden" name="returnTo" value={here} />
          <input type="hidden" name="from" value={p.slug} />
          <label className={s.field}>
            {k.linkTo}
            <select name="to" required defaultValue="">
              <option value="" disabled>
                {k.choose}
              </option>
              {others.map((o) => (
                <option key={o.slug} value={o.slug}>
                  {o.title} ({k.pageTypes[o.type] ?? o.type})
                </option>
              ))}
            </select>
          </label>
          <label className={s.field}>
            {k.relation}
            <input name="relation" required maxLength={30} list="kg-relations" defaultValue="related" />
            <datalist id="kg-relations">
              {relations.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </label>
          <label className={s.field}>
            {k.noteOptional}
            <input name="note" maxLength={300} />
          </label>
          <Reason t={t} />
          <button type="submit" className="primary">{k.addLink}</button>
        </form>
      </details>

      {!PROTECTED.has(p.slug) && (
        <details className={s.editBox}>
          <summary>{p.archived ? k.restore : k.archive}</summary>
          <form method="post" action="/api/knowledge/pages/edit">
            <CsrfField token={csrf} />
            <input type="hidden" name="returnTo" value={here} />
            <input type="hidden" name="page" value={p.slug} />
            <input type="hidden" name="archived" value={p.archived ? 'false' : 'true'} />
            {!p.archived && <p className="muted">{k.archivePageNote}</p>}
            <Reason t={t} />
            <label className={s.check}>
              <input type="checkbox" name="confirmed" value="yes" required /> {k.confirmed}
            </label>
            <button type="submit" className={p.archived ? 'primary' : 'danger'}>
              {p.archived ? k.restore : k.archive}
            </button>
          </form>
        </details>
      )}
    </div>
  );
}

function FactPanel({
  t,
  detail,
  csrf,
  here,
  opts,
  kinds,
}: {
  t: Dict;
  detail: FactDetail;
  csrf: string;
  here: string;
  opts: { facts: boolean; archived: boolean };
  kinds: string[];
}) {
  const f = detail;
  const old = f.status === 'superseded';
  const k = t.kg;
  return (
    <div>
      <h2>{k.fact}</h2>
      <p className={s.subtle}>
        <a href={knowledgeHref({ ...opts, sel: { kind: 'page', slug: f.page.slug } })}>{f.page.title}</a> ·{' '}
        {f.kind ? (k.factKinds[f.kind] ?? f.kind) : k.noKind} · {f.status === 'active' ? k.statusActive : f.status === 'removed' ? k.statusRemoved : k.statusOld}
      </p>
      <p className={s.factText}>{f.text}</p>
      <dl className={s.dl}>
        {f.observedOn && (
          <>
            <dt>{k.date}</dt>
            <dd>{f.observedOn}</dd>
          </>
        )}
        <dt>{k.source}</dt>
        <dd>{f.source == null ? k.none : typeof f.source === 'string' ? f.source : k.raw(f.source.rawId.slice(0, 8))}</dd>
        <dt>{k.createdBy}</dt>
        <dd>{f.createdBy}</dd>
        <dt>{k.updated}</dt>
        <dd>{f.updatedAt.slice(0, 16).replace('T', ' ')}</dd>
      </dl>

      {old ? (
        <p className="muted">
          {k.oldVersion}{' '}
          {f.supersededBy && <a href={knowledgeHref({ ...opts, sel: { kind: 'fact', id: f.supersededBy } })}>{k.newVersion}</a>}
        </p>
      ) : (
        <>
          {f.status === 'active' && (
            <details className={s.editBox} open>
              <summary>{k.edit}</summary>
              <form method="post" action={`/api/knowledge/facts/${f.id}/edit`}>
                <CsrfField token={csrf} />
                <input type="hidden" name="returnTo" value={here} />
                <input type="hidden" name="original_text" value={f.text} />
                <input type="hidden" name="original_kind" value={f.kind ?? ''} />
                <label className={s.field}>
                  {k.textField}
                  <textarea name="text" defaultValue={f.text} required maxLength={1000} rows={5} />
                </label>
                <label className={s.field}>
                  {k.kind}
                  <select name="kind" defaultValue={f.kind ?? ''}>
                    <option value="">{k.none}</option>
                    {kinds.map((kind) => (
                      <option key={kind} value={kind}>
                        {k.factKinds[kind] ?? kind}
                      </option>
                    ))}
                  </select>
                </label>
                <Reason t={t} />
                <button type="submit" className="primary">{k.save}</button>
              </form>
            </details>
          )}
          <details className={s.editBox}>
            <summary>{f.status === 'removed' ? k.restore : k.archive}</summary>
            <form method="post" action={`/api/knowledge/facts/${f.id}/archive`}>
              <CsrfField token={csrf} />
              <input type="hidden" name="returnTo" value={here} />
              <input type="hidden" name="archived" value={f.status === 'removed' ? 'false' : 'true'} />
              {f.status !== 'removed' && <p className="muted">{k.archiveFactNote}</p>}
              <Reason t={t} />
              <button type="submit" className={f.status === 'removed' ? 'primary' : 'danger'}>
                {f.status === 'removed' ? k.restore : k.archive}
              </button>
            </form>
          </details>
        </>
      )}
    </div>
  );
}
