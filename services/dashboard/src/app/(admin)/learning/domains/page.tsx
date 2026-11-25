import { Chip, Empty, Meter, PageHeader, Panel } from '@/components/learning/parts';
import s from '@/components/learning/learning.module.css';
import { CsrfField, errorText, Flash, Unavailable } from '@/components/ui';
import { since } from '@/lib/diff';
import { learning } from '@/lib/learning';
import { DOMAIN_STATUSES, GOAL_STATUSES, type Domain, type Goal, type Milestone, type Roadmap } from '@/lib/learning-types';
import { deadlineState, LEVELS, todayIso } from '@/lib/learning-view';
import { requireSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

const RETURN = '/learning/domains';

/** Domains (nested), goals with the owner's fixed deadline, and roadmaps with weighted milestone progress. */
export default async function DomainsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [sp, session] = await Promise.all([searchParams, requireSession()]);
  let domains: Domain[];
  let goals: Goal[];
  let roadmaps: Roadmap[];
  try {
    [domains, goals, roadmaps] = await Promise.all([learning.domains(), learning.goals(), learning.roadmaps()]);
  } catch (e) {
    return <><PageHeader title="Domains & goals" /><Unavailable what="Learning service" reason={errorText(e)} /></>;
  }
  const milestones: Milestone[] = await learning.milestones().then((r) => r.items, () => []);
  const today = todayIso(new Date(), process.env.TZ || undefined);
  const active = domains.filter((d) => d.status !== 'archived');
  const domainTitle = new Map(domains.map((d) => [d.id, d.title]));
  const goalTitle = new Map(goals.map((g) => [g.id, g.title]));

  // parents first, children indented under them
  const ordered: Array<{ d: Domain; depth: number }> = [];
  const place = (parent: string | null, depth: number) => {
    for (const d of domains.filter((x) => x.parentId === parent).sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title))) {
      ordered.push({ d, depth });
      if (depth < 6) place(d.id, depth + 1);
    }
  };
  place(null, 0);
  for (const d of domains) if (!ordered.some((o) => o.d.id === d.id)) ordered.push({ d, depth: 0 });

  const progress = (roadmapId: string) => {
    const live = milestones.filter((m) => m.roadmapId === roadmapId && m.status !== 'archived');
    const total = live.reduce((t, m) => t + m.weight, 0);
    const done = live.filter((m) => m.status === 'completed').reduce((t, m) => t + m.weight, 0);
    return { total, done, count: live.length };
  };

  return (
    <>
      <PageHeader title="Domains & goals" sub="What you study (domains), what you want from it (goals) and how you get there (versioned roadmaps)." />
      <Flash ok={sp.ok} error={sp.error} />

      <Panel title="Domains" note={`${active.length} active · statuses: ${DOMAIN_STATUSES.join(', ')}. Archived instead of deleted.`} flush>
        {ordered.length ? (
          <div className={s.rows}>
            {ordered.map(({ d, depth }) => (
              <div key={d.id} className={s.row}>
                <div className={s.rowMain} style={{ paddingLeft: depth * 18 }}>
                  <span className={s.rowTitle}>{depth > 0 && <span className={s.muted} aria-hidden>└ </span>}{d.title}</span>
                  <div className={s.rowMeta}>
                    <span>priority {d.priority}</span>
                    {d.description && <span>{d.description}</span>}
                    <span>{goals.filter((g) => g.domainId === d.id).length} goal(s)</span>
                  </div>
                </div>
                <div className={s.rowSide}>
                  <Chip status={d.status} />
                  <form method="post" action={`/api/learning/domains/${d.id}/update`} className={s.inlineForm}>
                    <CsrfField token={session.csrf} />
                    <input type="hidden" name="returnTo" value={RETURN} />
                    <select name="status" defaultValue={d.status} aria-label={`Status of ${d.title}`}>{DOMAIN_STATUSES.map((x) => <option key={x}>{x}</option>)}</select>
                    <select name="priority" defaultValue={String(d.priority)} aria-label={`Priority of ${d.title}`}>{[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>P{p}</option>)}</select>
                    <button type="submit">Save</button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        ) : <div style={{ padding: 16 }}><Empty title="No domains yet">Start with a broad area such as “Math” or “Frontend”.</Empty></div>}
      </Panel>
      <details className={s.disclosure} open={domains.length === 0}>
        <summary>New domain</summary>
        <div className={s.disclosureBody}>
          <form method="post" action="/api/learning/domains/create" className={s.form}>
            <CsrfField token={session.csrf} />
            <input type="hidden" name="returnTo" value={RETURN} />
            <div className={s.fields}>
              <label className={s.field}>Title<input name="title" required maxLength={120} /></label>
              <label className={s.field}>Parent<select name="parentId" defaultValue=""><option value="">(top level)</option>{active.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select></label>
              <label className={s.field}>Status<select name="status" defaultValue="exploring">{DOMAIN_STATUSES.filter((x) => x !== 'archived').map((x) => <option key={x}>{x}</option>)}</select></label>
              <label className={s.field}>Priority<select name="priority" defaultValue="3">{[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>P{p}</option>)}</select></label>
              <label className={`${s.field} ${s.fieldWide}`}>Description<input name="description" maxLength={2000} /></label>
            </div>
            <div className={s.formActions}><button type="submit" className="primary">Add domain</button></div>
          </form>
        </div>
      </details>

      <Panel title="Goals" note="The deadline on a goal is yours and fixed: AI drafts and planners never change it." flush>
        {goals.length ? (
          <div className={s.rows}>
            {goals.map((g) => {
              const dl = deadlineState(g.constraints.deadline, today);
              return (
                <div key={g.id} className={s.row}>
                  <div className={s.rowMain}>
                    <span className={s.rowTitle}>{g.title}</span>
                    <div className={s.rowMeta}>
                      <span>{domainTitle.get(g.domainId) ?? '?'}</span>
                      {g.targetLevel !== null && <span>target level {g.targetLevel} · {LEVELS[g.targetLevel]?.label}</span>}
                      {g.constraints.weeklyMinutes ? <span>{g.constraints.weeklyMinutes} min / week</span> : null}
                      {g.target && <span>{g.target}</span>}
                    </div>
                  </div>
                  <div className={s.rowSide}>
                    {g.constraints.deadline && <Chip tone={dl?.tone ?? 'muted'} title="Your fixed deadline">{g.constraints.deadline} · {dl?.label}</Chip>}
                    <Chip status={g.status} />
                    <form method="post" action={`/api/learning/goals/${g.id}/update`} className={s.inlineForm}>
                      <CsrfField token={session.csrf} />
                      <input type="hidden" name="returnTo" value={RETURN} />
                      <select name="status" defaultValue={g.status} aria-label={`Status of ${g.title}`}>{GOAL_STATUSES.map((x) => <option key={x}>{x}</option>)}</select>
                      <button type="submit">Save</button>
                    </form>
                  </div>
                </div>
              );
            })}
          </div>
        ) : <div style={{ padding: 16 }}><Empty title="No goals yet">{active.length ? 'Add a goal to one of your domains.' : 'Create a domain first.'}</Empty></div>}
      </Panel>
      {active.length > 0 && (
        <details className={s.disclosure} open={goals.length === 0}>
          <summary>New goal</summary>
          <div className={s.disclosureBody}>
            <form method="post" action="/api/learning/goals/create" className={s.form}>
              <CsrfField token={session.csrf} />
              <input type="hidden" name="returnTo" value={RETURN} />
              <div className={s.fields}>
                <label className={s.field}>Title<input name="title" required maxLength={200} /></label>
                <label className={s.field}>Domain<select name="domainId" required>{active.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select></label>
                <label className={s.field}>Target level<select name="targetLevel" defaultValue="2">{LEVELS.map((l) => <option key={l.level} value={l.level}>{l.level} · {l.label}</option>)}</select></label>
                <label className={s.field}>Weekly minutes<input name="weeklyMinutes" type="number" min={0} max={10080} inputMode="numeric" /></label>
                <label className={s.field}>Deadline (fixed)<input name="deadline" type="date" /></label>
                <label className={s.field}>Equipment<input name="equipment" maxLength={1000} /></label>
                <label className={`${s.field} ${s.fieldWide}`}>What you already know<input name="priorKnowledge" maxLength={2000} /></label>
                <label className={`${s.field} ${s.fieldWide}`}>Target (what “done” means)<input name="target" maxLength={2000} /></label>
              </div>
              <div className={s.formActions}><button type="submit" className="primary">Add goal</button></div>
            </form>
          </div>
        </details>
      )}

      <Panel id="roadmaps" title="Roadmaps" note="Every change is a proposal you approve; approved versions never change." flush>
        {roadmaps.length ? (
          <div className={s.rows}>
            {roadmaps.map((r) => {
              const p = progress(r.id);
              return (
                <div key={r.id} className={s.row}>
                  <div className={s.rowMain}>
                    <a className={s.rowTitle} href={`/learning/roadmaps/${r.id}`}>{r.title}</a>
                    <div className={s.rowMeta}><span>goal: {goalTitle.get(r.goalId) ?? '?'}</span><span>updated {since(r.updatedAt)}</span></div>
                    {p.total > 0 ? <Meter value={p.done} max={p.total} tone="ok" label={`${Math.round((p.done / p.total) * 100)}% · ${p.count} milestone(s)`} /> : <span className={s.hint}>progress: N/A (no weighted milestones)</span>}
                  </div>
                  <div className={s.rowSide}>
                    {r.currentVersion ? <Chip tone="ok">v{r.currentVersion}</Chip> : <Chip tone="warn">no version yet</Chip>}
                    {r.status === 'archived' && <Chip status="archived" />}
                  </div>
                </div>
              );
            })}
          </div>
        ) : <div style={{ padding: 16 }}><Empty title="No roadmaps yet">{goals.length ? 'Create a roadmap for a goal.' : 'Create a goal first.'}</Empty></div>}
      </Panel>
      {goals.length > 0 && (
        <details className={s.disclosure} open={roadmaps.length === 0}>
          <summary>New roadmap</summary>
          <div className={s.disclosureBody}>
            <form method="post" action="/api/learning/roadmaps/create" className={s.form}>
              <CsrfField token={session.csrf} />
              <input type="hidden" name="returnTo" value={RETURN} />
              <div className={s.fields}>
                <label className={s.field}>Title<input name="title" required maxLength={200} /></label>
                <label className={s.field}>Goal<select name="goalId" required>{goals.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}</select></label>
              </div>
              <div className={s.formActions}><button type="submit" className="primary">Create roadmap</button></div>
            </form>
          </div>
        </details>
      )}
    </>
  );
}
