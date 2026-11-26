import { Chip, Empty, PageHeader, Panel } from '@/components/learning/parts';
import s from '@/components/learning/learning.module.css';
import { CsrfField, errorText, Flash, Unavailable } from '@/components/ui';
import { since } from '@/lib/diff';
import { learning } from '@/lib/learning';
import { IDEA_PRIORITIES, IDEA_STATES, type Domain, type Idea } from '@/lib/learning-types';
import { requireSession } from '@/lib/server';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

/** Idea Inbox: capture, tag, search, edit, archive. Ideas never enter a roadmap or schedule on their own. */
export default async function IdeasPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [sp, session, t] = await Promise.all([searchParams, requireSession(), getT()]);
  const k = t.learnIdeas;
  const prio = (p: string) => t.learnOverview.priorities[p] ?? p;
  const q = one(sp.q)?.slice(0, 100);
  const state = IDEA_STATES.includes(one(sp.state) as Idea['state']) ? one(sp.state) : undefined;
  let ideas: Idea[] | null = null;
  let domains: Domain[] = [];
  let error: string | null = null;
  try {
    [ideas, domains] = await Promise.all([learning.ideas({ q, state }), learning.domains()]);
  } catch (e) {
    error = errorText(e, t);
  }
  const active = domains.filter((d) => d.status !== 'archived');
  const back = `/learning/ideas${q || state ? `?${new URLSearchParams(Object.entries({ q, state }).filter(([, v]) => v) as [string, string][])}` : ''}`;
  return (
    <>
      <PageHeader title={k.title} sub={k.sub} />
      <Flash ok={sp.ok} error={sp.error} />
      {error && <Unavailable t={t} what={t.learn.serviceWhat} reason={error} />}

      <Panel title={k.capture}>
        <form method="post" action="/api/learning/ideas/create" className={s.form}>
          <CsrfField token={session.csrf} />
          <input type="hidden" name="returnTo" value="/learning/ideas" />
          <div className={s.fields}>
            <label className={`${s.field} ${s.fieldWide}`}>{k.idea}<input name="text" required maxLength={2000} placeholder={k.placeholder} /></label>
            {active.length > 0 && (
              <label className={s.field}>{k.domains}<select name="domainIds" multiple size={Math.min(4, Math.max(2, active.length))}>{active.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select></label>
            )}
            <label className={s.field}>{t.lf.priority}<select name="priority" defaultValue="normal">{IDEA_PRIORITIES.map((p) => <option key={p} value={p}>{prio(p)}</option>)}</select></label>
          </div>
          <div className={s.formActions}><button type="submit" className="primary">{k.capture}</button></div>
        </form>
      </Panel>

      <form method="get" className={s.formActions} role="search">
        <label className={s.field} style={{ flex: '1 1 220px' }}>{k.search}<input name="q" defaultValue={q ?? ''} maxLength={100} /></label>
        <label className={s.field}>{k.state}<select name="state" defaultValue={state ?? ''}><option value="">{k.openNotArchived}</option>{IDEA_STATES.map((x) => <option key={x} value={x}>{k.states[x] ?? x}</option>)}</select></label>
        <button type="submit" style={{ alignSelf: 'flex-end' }}>{t.common.filter}</button>
      </form>

      {ideas && (
        <Panel title={k.count(ideas.length)} flush>
          {ideas.length ? (
            <div className={s.rows}>
              {ideas.map((i) => (
                <div key={i.id} className={s.row}>
                  <div className={s.rowMain}>
                    <span style={{ overflowWrap: 'anywhere' }}>{i.text}</span>
                    <div className={s.rowMeta}>
                      <span>{since(i.createdAt, t)} · {i.source}</span>
                      {i.domainIds.length > 0 && <span>{i.domainIds.map((d) => domains.find((x) => x.id === d)?.title ?? '?').join(', ')}</span>}
                      {i.projectIds.length > 0 && <span>{k.projects(i.projectIds.join(', '))}</span>}
                    </div>
                    <details>
                      <summary className={s.hint} style={{ cursor: 'pointer' }}>{k.edit}</summary>
                      <form method="post" action={`/api/learning/ideas/${i.id}/update`} className={s.form} style={{ marginTop: 8 }}>
                        <CsrfField token={session.csrf} />
                        <input type="hidden" name="returnTo" value={back} />
                        <input type="hidden" name="domainIds-present" value="1" />
                        <div className={s.fields}>
                          <label className={`${s.field} ${s.fieldWide}`}>{k.text}<input name="text" defaultValue={i.text} maxLength={2000} /></label>
                          <label className={s.field}>{k.domains}<select name="domainIds" multiple size={Math.min(4, Math.max(2, active.length))} defaultValue={i.domainIds}>{active.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select></label>
                          <label className={s.field}>{t.lf.priority}<select name="priority" defaultValue={i.priority}>{IDEA_PRIORITIES.map((p) => <option key={p} value={p}>{prio(p)}</option>)}</select></label>
                        </div>
                        <div className={s.formActions}><button type="submit">{t.lf.save}</button></div>
                      </form>
                    </details>
                  </div>
                  <div className={s.rowSide}>
                    {i.priority !== 'normal' && <Chip tone={i.priority === 'high' ? 'warn' : 'muted'}>{prio(i.priority)}</Chip>}
                    <form method="post" action={`/api/learning/ideas/${i.id}/update`} className={s.inlineForm}>
                      <CsrfField token={session.csrf} />
                      <input type="hidden" name="returnTo" value={back} />
                      <select name="state" defaultValue={i.state} aria-label={k.state}>{IDEA_STATES.map((x) => <option key={x} value={x}>{k.states[x] ?? x}</option>)}</select>
                      <button type="submit">{k.set}</button>
                    </form>
                  </div>
                </div>
              ))}
            </div>
          ) : <div style={{ padding: 16 }}><Empty title={k.noMatch} /></div>}
        </Panel>
      )}
    </>
  );
}
