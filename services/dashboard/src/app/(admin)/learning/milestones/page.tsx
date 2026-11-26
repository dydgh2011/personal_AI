import { Chip, Empty, Meter, PageHeader, Panel } from '@/components/learning/parts';
import s from '@/components/learning/learning.module.css';
import { CsrfField, errorText, Flash, Unavailable } from '@/components/ui';
import { learning } from '@/lib/learning';
import type { Milestone, RoadmapNode, Roadmap, Rubric, Skill } from '@/lib/learning-types';
import { deadlineState, statusView, todayIso } from '@/lib/learning-view';
import { requireSession } from '@/lib/server';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

/** All milestones by roadmap, with weighted progress, deadlines (fixed vs suggested) and assignment counts. */
export default async function MilestonesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [sp, session, t] = await Promise.all([searchParams, requireSession(), getT()]);
  const k = t.learnMilestones;
  const f = t.lf;
  const focus = one(sp.roadmapId);
  const showArchived = one(sp.archived) === '1';
  let roadmaps: Roadmap[];
  let milestones: Milestone[];
  let rubrics: Rubric[];
  let skills: Skill[];
  try {
    [roadmaps, { items: milestones }, rubrics, { items: skills }] = await Promise.all([learning.roadmaps(), learning.milestones(), learning.rubrics(), learning.skills()]);
  } catch (e) {
    return <><PageHeader title={k.title} /><Unavailable t={t} what={t.learn.serviceWhat} reason={errorText(e, t)} /></>;
  }
  const selected = focus && UUID.test(focus) ? roadmaps.find((r) => r.id === focus) : undefined;
  const nodes: RoadmapNode[] = selected?.currentVersionId ? await learning.roadmap(selected.id).then((d) => d.current?.content.nodes ?? [], () => []) : [];
  const today = todayIso(new Date(), process.env.TZ || undefined);
  const activeRubrics = rubrics.filter((r) => r.status === 'active' && r.latestVersion);
  const visible = milestones.filter((m) => showArchived || m.status !== 'archived');
  const groups = roadmaps.map((r) => ({ roadmap: r, items: visible.filter((m) => m.roadmapId === r.id) })).filter((g) => g.items.length > 0 || g.roadmap.id === selected?.id);
  const archivedCount = milestones.filter((m) => m.status === 'archived').length;

  return (
    <>
      <PageHeader
        title={k.title}
        sub={k.sub}
        actions={<><a className={s.linkBtn} href="/learning/assignments">{k.assignments}</a><a className={s.linkBtn} href="/learning/rubrics">{k.rubrics(rubrics.length)}</a><a className={`${s.linkBtn} ${s.linkPrimary}`} href="#new">{k.newShort}</a></>}
      />
      <Flash ok={sp.ok} error={sp.error} />

      {groups.length === 0 && <Empty title={k.none}>{roadmaps.length ? k.addFirst : k.createRoadmapFirst}</Empty>}
      {groups.map(({ roadmap, items }) => {
        const live = items.filter((m) => m.status !== 'archived');
        const total = live.reduce((sum, m) => sum + m.weight, 0);
        const done = live.filter((m) => m.status === 'completed').reduce((sum, m) => sum + m.weight, 0);
        return (
          <Panel key={roadmap.id} flush title={<a href={`/learning/roadmaps/${roadmap.id}`}>{roadmap.title}</a>}
            note={total > 0 ? undefined : k.progressNa}
            actions={total > 0 ? <div style={{ minWidth: 200 }}><Meter t={t} value={done} max={total} tone="ok" label={`${Math.round((done / total) * 100)}%`} /></div> : undefined}>
            {items.length ? (
              <div className={s.rows}>
                {items.map((m) => {
                  const dl = deadlineState(m.deadline.fixed, today, t);
                  return (
                    <div key={m.id} className={s.row}>
                      <div className={s.rowMain}>
                        <a className={s.rowTitle} href={`/learning/milestones/${m.id}`}>{m.title}</a>
                        <div className={s.rowMeta}>
                          <span>{k.passed(m.assignments.passed, m.assignments.total)}</span>
                          {m.assignments.open > 0 && <span>{k.inProgress(m.assignments.open)}</span>}
                          <span>{k.weight(m.weight)}</span>
                          {m.rubricVersionId ? <span>{k.rubricSet}</span> : <span>{k.noRubric}</span>}
                          {m.skillIds.length > 0 && <span>{k.skills(m.skillIds.length)}</span>}
                        </div>
                      </div>
                      <div className={s.rowSide}>
                        {m.deadline.fixed ? <Chip tone={m.status === 'completed' ? 'muted' : (dl?.tone ?? 'muted')} title={k.yourFixedDeadline}>{m.deadline.fixed}{m.status !== 'completed' && dl ? ` · ${dl.label}` : ''}</Chip> : <Chip tone="muted">{k.noDeadline}</Chip>}
                        {m.deadline.suggested && <Chip tone="warn" title={m.deadline.suggestedReason ?? k.suggestedNotApplied}>{k.suggested(m.deadline.suggested)}</Chip>}
                        <Chip t={t} status={m.status} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : <p className={s.hint} style={{ padding: '0 16px 12px' }}>{k.noneOnRoadmap}</p>}
          </Panel>
        );
      })}
      {archivedCount > 0 && <a href={showArchived ? '/learning/milestones' : '/learning/milestones?archived=1'} className={s.hint}>{k.toggleArchived(showArchived, archivedCount)}</a>}

      {roadmaps.length > 0 && (
        <details className={s.disclosure} id="new" open={Boolean(selected) || milestones.length === 0}>
          <summary>{k.newMilestone}</summary>
          <div className={s.disclosureBody}>
            {!selected && (
              <form method="get" action="/learning/milestones#new" className={s.formActions} style={{ marginBottom: 10 }}>
                <label className={s.field} style={{ flex: '1 1 240px' }}>{k.pickRoadmap}
                  <select name="roadmapId" defaultValue="">{roadmaps.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</select>
                </label>
                <button type="submit" style={{ alignSelf: 'flex-end' }}>{k.choose}</button>
              </form>
            )}
            <form method="post" action="/api/learning/milestones/create" className={s.form}>
              <CsrfField token={session.csrf} />
              <input type="hidden" name="returnTo" value={selected ? `/learning/milestones?roadmapId=${selected.id}` : '/learning/milestones'} />
              <div className={s.fields}>
                <label className={s.field}>{k.roadmap}
                  <select name="roadmapId" required defaultValue={selected?.id}>{roadmaps.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</select>
                </label>
                <label className={s.field}>{f.title}<input name="title" required maxLength={200} placeholder={k.titlePlaceholder} /></label>
                {nodes.length > 0 && (
                  <label className={s.field}>{k.roadmapNode}
                    <select name="nodeKey" defaultValue=""><option value="">{k.none2}</option>{nodes.map((n) => <option key={n.key} value={n.key}>{t.learn.tree.nodeType[n.type] ?? n.type} · {n.title}</option>)}</select>
                  </label>
                )}
                <label className={s.field}>{k.rubric}
                  <select name="rubricVersionId" defaultValue=""><option value="">{k.noneYet}</option>{activeRubrics.map((r) => <option key={r.id} value={r.latestVersion!.id}>{r.title} · v{r.latestVersion!.version}</option>)}</select>
                </label>
                <label className={s.field}>{k.yourDeadlineFixed}<input name="fixedDeadline" type="date" /></label>
                <label className={s.field}>{k.weightField}<input name="weight" type="number" min={0} max={100} defaultValue={1} inputMode="numeric" /></label>
                <label className={s.field}>{f.status}<select name="status" defaultValue="active"><option value="planned">{statusView('planned', t).label}</option><option value="active">{statusView('active', t).label}</option></select></label>
                {skills.length > 0 && (
                  <label className={s.field}>{k.skillsTrained}
                    <select name="skillIds" multiple size={Math.min(5, Math.max(2, skills.length))}>{skills.map((k) => <option key={k.id} value={k.id}>{k.displayName}</option>)}</select>
                  </label>
                )}
                <label className={`${s.field} ${s.fieldWide}`}>{k.passingCriteriaWords}<textarea name="passingCriteria" rows={2} maxLength={4000} placeholder={k.passingPlaceholder} /></label>
                <label className={`${s.field} ${s.fieldWide}`}>{f.description}<textarea name="description" rows={2} maxLength={4000} /></label>
              </div>
              {activeRubrics.length === 0 && <p className={s.hint} style={{ margin: 0 }}>{k.noRubricHint}<a href="/learning/rubrics">{k.createRubric}</a>{k.noRubricHintEnd}</p>}
              <div className={s.formActions}><button type="submit" className="primary">{k.create}</button></div>
            </form>
          </div>
        </details>
      )}
    </>
  );
}
