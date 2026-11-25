import { Chip, Empty, PageHeader, Panel } from '@/components/learning/parts';
import s from '@/components/learning/learning.module.css';
import { CsrfField, errorText, Flash, Unavailable } from '@/components/ui';
import { since } from '@/lib/diff';
import { learning } from '@/lib/learning';
import { IDEA_PRIORITIES, IDEA_STATES, type Domain, type Idea } from '@/lib/learning-types';
import { requireSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

/** Idea Inbox: capture, tag, search, edit, archive. Ideas never enter a roadmap or schedule on their own. */
export default async function IdeasPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [sp, session] = await Promise.all([searchParams, requireSession()]);
  const q = one(sp.q)?.slice(0, 100);
  const state = IDEA_STATES.includes(one(sp.state) as Idea['state']) ? one(sp.state) : undefined;
  let ideas: Idea[] | null = null;
  let domains: Domain[] = [];
  let error: string | null = null;
  try {
    [ideas, domains] = await Promise.all([learning.ideas({ q, state }), learning.domains()]);
  } catch (e) {
    error = errorText(e);
  }
  const active = domains.filter((d) => d.status !== 'archived');
  const back = `/learning/ideas${q || state ? `?${new URLSearchParams(Object.entries({ q, state }).filter(([, v]) => v) as [string, string][])}` : ''}`;
  return (
    <>
      <PageHeader title="Idea inbox" sub="Capture anything worth learning. Ideas stay here until you turn them into goals yourself." />
      <Flash ok={sp.ok} error={sp.error} />
      {error && <Unavailable what="Learning service" reason={error} />}

      <Panel title="Capture">
        <form method="post" action="/api/learning/ideas/create" className={s.form}>
          <CsrfField token={session.csrf} />
          <input type="hidden" name="returnTo" value="/learning/ideas" />
          <div className={s.fields}>
            <label className={`${s.field} ${s.fieldWide}`}>Idea<input name="text" required maxLength={2000} placeholder="e.g. Learn how GPUs schedule warps" /></label>
            {active.length > 0 && (
              <label className={s.field}>Domains<select name="domainIds" multiple size={Math.min(4, Math.max(2, active.length))}>{active.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select></label>
            )}
            <label className={s.field}>Priority<select name="priority" defaultValue="normal">{IDEA_PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></label>
          </div>
          <div className={s.formActions}><button type="submit" className="primary">Capture</button></div>
        </form>
      </Panel>

      <form method="get" className={s.formActions} role="search">
        <label className={s.field} style={{ flex: '1 1 220px' }}>Search<input name="q" defaultValue={q ?? ''} maxLength={100} /></label>
        <label className={s.field}>State<select name="state" defaultValue={state ?? ''}><option value="">open (not archived)</option>{IDEA_STATES.map((x) => <option key={x}>{x}</option>)}</select></label>
        <button type="submit" style={{ alignSelf: 'flex-end' }}>Filter</button>
      </form>

      {ideas && (
        <Panel title={`${ideas.length} idea(s)`} flush>
          {ideas.length ? (
            <div className={s.rows}>
              {ideas.map((i) => (
                <div key={i.id} className={s.row}>
                  <div className={s.rowMain}>
                    <span style={{ overflowWrap: 'anywhere' }}>{i.text}</span>
                    <div className={s.rowMeta}>
                      <span>{since(i.createdAt)} · {i.source}</span>
                      {i.domainIds.length > 0 && <span>{i.domainIds.map((d) => domains.find((x) => x.id === d)?.title ?? '?').join(', ')}</span>}
                      {i.projectIds.length > 0 && <span>projects: {i.projectIds.join(', ')}</span>}
                    </div>
                    <details>
                      <summary className={s.hint} style={{ cursor: 'pointer' }}>Edit</summary>
                      <form method="post" action={`/api/learning/ideas/${i.id}/update`} className={s.form} style={{ marginTop: 8 }}>
                        <CsrfField token={session.csrf} />
                        <input type="hidden" name="returnTo" value={back} />
                        <input type="hidden" name="domainIds-present" value="1" />
                        <div className={s.fields}>
                          <label className={`${s.field} ${s.fieldWide}`}>Text<input name="text" defaultValue={i.text} maxLength={2000} /></label>
                          <label className={s.field}>Domains<select name="domainIds" multiple size={Math.min(4, Math.max(2, active.length))} defaultValue={i.domainIds}>{active.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select></label>
                          <label className={s.field}>Priority<select name="priority" defaultValue={i.priority}>{IDEA_PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></label>
                        </div>
                        <div className={s.formActions}><button type="submit">Save</button></div>
                      </form>
                    </details>
                  </div>
                  <div className={s.rowSide}>
                    {i.priority !== 'normal' && <Chip tone={i.priority === 'high' ? 'warn' : 'muted'}>{i.priority}</Chip>}
                    <form method="post" action={`/api/learning/ideas/${i.id}/update`} className={s.inlineForm}>
                      <CsrfField token={session.csrf} />
                      <input type="hidden" name="returnTo" value={back} />
                      <select name="state" defaultValue={i.state} aria-label="State">{IDEA_STATES.map((x) => <option key={x}>{x}</option>)}</select>
                      <button type="submit">Set</button>
                    </form>
                  </div>
                </div>
              ))}
            </div>
          ) : <div style={{ padding: 16 }}><Empty title="No ideas match" /></div>}
        </Panel>
      )}
    </>
  );
}
