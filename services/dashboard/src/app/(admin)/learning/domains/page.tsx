import { Chip, Empty, Meter, PageHeader, Panel } from '@/components/learning/parts';
import s from '@/components/learning/learning.module.css';
import { CsrfField, errorText, Flash, Unavailable } from '@/components/ui';
import { since } from '@/lib/diff';
import { learning } from '@/lib/learning';
import { DOMAIN_STATUSES, GOAL_STATUSES, type Domain, type Goal, type Milestone, type Roadmap } from '@/lib/learning-types';
import { deadlineState, LEVELS, levelLabel, statusView, todayIso } from '@/lib/learning-view';
import { requireSession } from '@/lib/server';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

const RETURN = '/learning/domains';

/** Domains (nested), goals with the owner's fixed deadline, and roadmaps with weighted milestone progress. */
export default async function DomainsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [sp, session, t] = await Promise.all([searchParams, requireSession(), getT()]);
  const k = t.learnDomains;
  const f = t.lf;
  const statusLabel = (x: string) => statusView(x, t).label;
  let domains: Domain[];
  let goals: Goal[];
  let roadmaps: Roadmap[];
  try {
    [domains, goals, roadmaps] = await Promise.all([learning.domains(), learning.goals(), learning.roadmaps()]);
  } catch (e) {
    return <><PageHeader title={k.title} /><Unavailable t={t} what={t.learn.serviceWhat} reason={errorText(e, t)} /></>;
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
    const total = live.reduce((sum, m) => sum + m.weight, 0);
    const done = live.filter((m) => m.status === 'completed').reduce((sum, m) => sum + m.weight, 0);
    return { total, done, count: live.length };
  };

  return (
    <>
      <PageHeader title={k.title} sub={k.sub} />
      <Flash ok={sp.ok} error={sp.error} />

      <Panel title={k.domains} note={k.domainsNote(active.length, DOMAIN_STATUSES.map(statusLabel).join(', '))} flush>
        {ordered.length ? (
          <div className={s.rows}>
            {ordered.map(({ d, depth }) => (
              <div key={d.id} className={s.row}>
                <div className={s.rowMain} style={{ paddingLeft: depth * 18 }}>
                  <span className={s.rowTitle}>{depth > 0 && <span className={s.muted} aria-hidden>└ </span>}{d.title}</span>
                  <div className={s.rowMeta}>
                    <span>{k.priorityN(d.priority)}</span>
                    {d.description && <span>{d.description}</span>}
                    <span>{k.goalCount(goals.filter((g) => g.domainId === d.id).length)}</span>
                  </div>
                </div>
                <div className={s.rowSide}>
                  <Chip t={t} status={d.status} />
                  <form method="post" action={`/api/learning/domains/${d.id}/update`} className={s.inlineForm}>
                    <CsrfField token={session.csrf} />
                    <input type="hidden" name="returnTo" value={RETURN} />
                    <select name="status" defaultValue={d.status} aria-label={f.statusOf(d.title)}>{DOMAIN_STATUSES.map((x) => <option key={x} value={x}>{statusLabel(x)}</option>)}</select>
                    <select name="priority" defaultValue={String(d.priority)} aria-label={f.priorityOf(d.title)}>{[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>P{p}</option>)}</select>
                    <button type="submit">{f.save}</button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        ) : <div style={{ padding: 16 }}><Empty title={k.noDomains}>{k.noDomainsBody}</Empty></div>}
      </Panel>
      <details className={s.disclosure} open={domains.length === 0}>
        <summary>{k.newDomain}</summary>
        <div className={s.disclosureBody}>
          <form method="post" action="/api/learning/domains/create" className={s.form}>
            <CsrfField token={session.csrf} />
            <input type="hidden" name="returnTo" value={RETURN} />
            <div className={s.fields}>
              <label className={s.field}>{f.title}<input name="title" required maxLength={120} /></label>
              <label className={s.field}>{k.parent}<select name="parentId" defaultValue=""><option value="">{k.topLevel}</option>{active.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select></label>
              <label className={s.field}>{f.status}<select name="status" defaultValue="exploring">{DOMAIN_STATUSES.filter((x) => x !== 'archived').map((x) => <option key={x} value={x}>{statusLabel(x)}</option>)}</select></label>
              <label className={s.field}>{f.priority}<select name="priority" defaultValue="3">{[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>P{p}</option>)}</select></label>
              <label className={`${s.field} ${s.fieldWide}`}>{f.description}<input name="description" maxLength={2000} /></label>
            </div>
            <div className={s.formActions}><button type="submit" className="primary">{k.addDomain}</button></div>
          </form>
        </div>
      </details>

      <Panel title={k.goals} note={k.goalsNote} flush>
        {goals.length ? (
          <div className={s.rows}>
            {goals.map((g) => {
              const dl = deadlineState(g.constraints.deadline, today, t);
              return (
                <div key={g.id} className={s.row}>
                  <div className={s.rowMain}>
                    <span className={s.rowTitle}>{g.title}</span>
                    <div className={s.rowMeta}>
                      <span>{domainTitle.get(g.domainId) ?? '?'}</span>
                      {g.targetLevel !== null && <span>{k.targetLevel(g.targetLevel, t.learn.levels[g.targetLevel]?.label ?? '?')}</span>}
                      {g.constraints.weeklyMinutes ? <span>{f.minPerWeek(g.constraints.weeklyMinutes)}</span> : null}
                      {g.target && <span>{g.target}</span>}
                    </div>
                  </div>
                  <div className={s.rowSide}>
                    {g.constraints.deadline && <Chip tone={dl?.tone ?? 'muted'} title={k.yourFixedDeadline}>{g.constraints.deadline} · {dl?.label}</Chip>}
                    <Chip t={t} status={g.status} />
                    <form method="post" action={`/api/learning/goals/${g.id}/update`} className={s.inlineForm}>
                      <CsrfField token={session.csrf} />
                      <input type="hidden" name="returnTo" value={RETURN} />
                      <select name="status" defaultValue={g.status} aria-label={f.statusOf(g.title)}>{GOAL_STATUSES.map((x) => <option key={x} value={x}>{statusLabel(x)}</option>)}</select>
                      <button type="submit">{f.save}</button>
                    </form>
                  </div>
                </div>
              );
            })}
          </div>
        ) : <div style={{ padding: 16 }}><Empty title={k.noGoals}>{active.length ? k.addGoalHint : k.createDomainFirst}</Empty></div>}
      </Panel>
      {active.length > 0 && (
        <details className={s.disclosure} open={goals.length === 0}>
          <summary>{k.newGoal}</summary>
          <div className={s.disclosureBody}>
            <form method="post" action="/api/learning/goals/create" className={s.form}>
              <CsrfField token={session.csrf} />
              <input type="hidden" name="returnTo" value={RETURN} />
              <div className={s.fields}>
                <label className={s.field}>{f.title}<input name="title" required maxLength={200} /></label>
                <label className={s.field}>{f.domain}<select name="domainId" required>{active.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select></label>
                <label className={s.field}>{k.targetLevelField}<select name="targetLevel" defaultValue="2">{LEVELS.map((l) => <option key={l} value={l}>{levelLabel(l, t)}</option>)}</select></label>
                <label className={s.field}>{k.weeklyMinutes}<input name="weeklyMinutes" type="number" min={0} max={10080} inputMode="numeric" /></label>
                <label className={s.field}>{k.deadlineFixed}<input name="deadline" type="date" /></label>
                <label className={s.field}>{k.equipment}<input name="equipment" maxLength={1000} /></label>
                <label className={`${s.field} ${s.fieldWide}`}>{k.priorKnowledge}<input name="priorKnowledge" maxLength={2000} /></label>
                <label className={`${s.field} ${s.fieldWide}`}>{k.target}<input name="target" maxLength={2000} /></label>
              </div>
              <div className={s.formActions}><button type="submit" className="primary">{k.addGoal}</button></div>
            </form>
          </div>
        </details>
      )}

      <Panel id="roadmaps" title={k.roadmaps} note={k.roadmapsNote} flush>
        {roadmaps.length ? (
          <div className={s.rows}>
            {roadmaps.map((r) => {
              const p = progress(r.id);
              return (
                <div key={r.id} className={s.row}>
                  <div className={s.rowMain}>
                    <a className={s.rowTitle} href={`/learning/roadmaps/${r.id}`}>{r.title}</a>
                    <div className={s.rowMeta}><span>{k.goalOf(goalTitle.get(r.goalId) ?? '?')}</span><span>{f.updated(since(r.updatedAt, t))}</span></div>
                    {p.total > 0 ? <Meter t={t} value={p.done} max={p.total} tone="ok" label={k.progress(Math.round((p.done / p.total) * 100), p.count)} /> : <span className={s.hint}>{k.progressNa}</span>}
                  </div>
                  <div className={s.rowSide}>
                    {r.currentVersion ? <Chip tone="ok">v{r.currentVersion}</Chip> : <Chip tone="warn">{k.noVersion}</Chip>}
                    {r.status === 'archived' && <Chip t={t} status="archived" />}
                  </div>
                </div>
              );
            })}
          </div>
        ) : <div style={{ padding: 16 }}><Empty title={k.noRoadmaps}>{goals.length ? k.createRoadmapHint : k.createGoalFirst}</Empty></div>}
      </Panel>
      {goals.length > 0 && (
        <details className={s.disclosure} open={roadmaps.length === 0}>
          <summary>{k.newRoadmap}</summary>
          <div className={s.disclosureBody}>
            <form method="post" action="/api/learning/roadmaps/create" className={s.form}>
              <CsrfField token={session.csrf} />
              <input type="hidden" name="returnTo" value={RETURN} />
              <div className={s.fields}>
                <label className={s.field}>{f.title}<input name="title" required maxLength={200} /></label>
                <label className={s.field}>{f.goal}<select name="goalId" required>{goals.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}</select></label>
              </div>
              <div className={s.formActions}><button type="submit" className="primary">{k.createRoadmap}</button></div>
            </form>
          </div>
        </details>
      )}
    </>
  );
}
