import { Chip, Empty, Meter, PageHeader, Panel } from '@/components/learning/parts';
import s from '@/components/learning/learning.module.css';
import { CsrfField, errorText, Flash, Unavailable } from '@/components/ui';
import { learning } from '@/lib/learning';
import type { Milestone, RoadmapNode, Roadmap, Rubric, Skill } from '@/lib/learning-types';
import { deadlineState, todayIso } from '@/lib/learning-view';
import { requireSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

/** All milestones by roadmap, with weighted progress, deadlines (fixed vs suggested) and assignment counts. */
export default async function MilestonesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [sp, session] = await Promise.all([searchParams, requireSession()]);
  const focus = one(sp.roadmapId);
  const showArchived = one(sp.archived) === '1';
  let roadmaps: Roadmap[];
  let milestones: Milestone[];
  let rubrics: Rubric[];
  let skills: Skill[];
  try {
    [roadmaps, { items: milestones }, rubrics, { items: skills }] = await Promise.all([learning.roadmaps(), learning.milestones(), learning.rubrics(), learning.skills()]);
  } catch (e) {
    return <><PageHeader title="Milestones" /><Unavailable what="Learning service" reason={errorText(e)} /></>;
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
        title="Milestones"
        sub="Checkpoints on a roadmap. Each has a rubric, assignments and two deadlines kept apart: yours (fixed) and any AI / planner suggestion."
        actions={<><a className={s.linkBtn} href="/learning/assignments">Assignments</a><a className={s.linkBtn} href="/learning/rubrics">Rubrics ({rubrics.length})</a><a className={`${s.linkBtn} ${s.linkPrimary}`} href="#new">+ Milestone</a></>}
      />
      <Flash ok={sp.ok} error={sp.error} />

      {groups.length === 0 && <Empty title="No milestones yet">{roadmaps.length ? 'Add the first milestone below.' : 'Create a roadmap first (Domains & goals).'}</Empty>}
      {groups.map(({ roadmap, items }) => {
        const live = items.filter((m) => m.status !== 'archived');
        const total = live.reduce((t, m) => t + m.weight, 0);
        const done = live.filter((m) => m.status === 'completed').reduce((t, m) => t + m.weight, 0);
        return (
          <Panel key={roadmap.id} flush title={<a href={`/learning/roadmaps/${roadmap.id}`}>{roadmap.title}</a>}
            note={total > 0 ? undefined : 'Progress: N/A (no weighted milestones)'}
            actions={total > 0 ? <div style={{ minWidth: 200 }}><Meter value={done} max={total} tone="ok" label={`${Math.round((done / total) * 100)}%`} /></div> : undefined}>
            {items.length ? (
              <div className={s.rows}>
                {items.map((m) => {
                  const dl = deadlineState(m.deadline.fixed, today);
                  return (
                    <div key={m.id} className={s.row}>
                      <div className={s.rowMain}>
                        <a className={s.rowTitle} href={`/learning/milestones/${m.id}`}>{m.title}</a>
                        <div className={s.rowMeta}>
                          <span>{m.assignments.passed}/{m.assignments.total} assignments passed</span>
                          {m.assignments.open > 0 && <span>{m.assignments.open} in progress</span>}
                          <span>weight {m.weight}</span>
                          {m.rubricVersionId ? <span>rubric ✓</span> : <span>no rubric</span>}
                          {m.skillIds.length > 0 && <span>{m.skillIds.length} skill(s)</span>}
                        </div>
                      </div>
                      <div className={s.rowSide}>
                        {m.deadline.fixed ? <Chip tone={m.status === 'completed' ? 'muted' : (dl?.tone ?? 'muted')} title="Your fixed deadline">{m.deadline.fixed}{m.status !== 'completed' && dl ? ` · ${dl.label}` : ''}</Chip> : <Chip tone="muted">no deadline</Chip>}
                        {m.deadline.suggested && <Chip tone="warn" title={m.deadline.suggestedReason ?? 'Suggested, not applied'}>suggested {m.deadline.suggested}</Chip>}
                        <Chip status={m.status} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : <p className={s.hint} style={{ padding: '0 16px 12px' }}>No milestones on this roadmap yet.</p>}
          </Panel>
        );
      })}
      {archivedCount > 0 && <a href={showArchived ? '/learning/milestones' : '/learning/milestones?archived=1'} className={s.hint}>{showArchived ? 'Hide' : 'Show'} {archivedCount} archived milestone(s)</a>}

      {roadmaps.length > 0 && (
        <details className={s.disclosure} id="new" open={Boolean(selected) || milestones.length === 0}>
          <summary>New milestone</summary>
          <div className={s.disclosureBody}>
            {!selected && (
              <form method="get" action="/learning/milestones#new" className={s.formActions} style={{ marginBottom: 10 }}>
                <label className={s.field} style={{ flex: '1 1 240px' }}>Pick the roadmap first (to link a roadmap node)
                  <select name="roadmapId" defaultValue="">{roadmaps.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</select>
                </label>
                <button type="submit" style={{ alignSelf: 'flex-end' }}>Choose</button>
              </form>
            )}
            <form method="post" action="/api/learning/milestones/create" className={s.form}>
              <CsrfField token={session.csrf} />
              <input type="hidden" name="returnTo" value={selected ? `/learning/milestones?roadmapId=${selected.id}` : '/learning/milestones'} />
              <div className={s.fields}>
                <label className={s.field}>Roadmap
                  <select name="roadmapId" required defaultValue={selected?.id}>{roadmaps.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</select>
                </label>
                <label className={s.field}>Title<input name="title" required maxLength={200} placeholder="e.g. Derivatives basics" /></label>
                {nodes.length > 0 && (
                  <label className={s.field}>Roadmap node (optional)
                    <select name="nodeKey" defaultValue=""><option value="">(none)</option>{nodes.map((n) => <option key={n.key} value={n.key}>{n.type} · {n.title}</option>)}</select>
                  </label>
                )}
                <label className={s.field}>Rubric
                  <select name="rubricVersionId" defaultValue=""><option value="">(none yet)</option>{activeRubrics.map((r) => <option key={r.id} value={r.latestVersion!.id}>{r.title} · v{r.latestVersion!.version}</option>)}</select>
                </label>
                <label className={s.field}>Your deadline (fixed)<input name="fixedDeadline" type="date" /></label>
                <label className={s.field}>Weight<input name="weight" type="number" min={0} max={100} defaultValue={1} inputMode="numeric" /></label>
                <label className={s.field}>Status<select name="status" defaultValue="active"><option>planned</option><option>active</option></select></label>
                {skills.length > 0 && (
                  <label className={s.field}>Skills trained
                    <select name="skillIds" multiple size={Math.min(5, Math.max(2, skills.length))}>{skills.map((k) => <option key={k.id} value={k.id}>{k.displayName}</option>)}</select>
                  </label>
                )}
                <label className={`${s.field} ${s.fieldWide}`}>Passing criteria (in words)<textarea name="passingCriteria" rows={2} maxLength={4000} placeholder="What must be true to call this done" /></label>
                <label className={`${s.field} ${s.fieldWide}`}>Description<textarea name="description" rows={2} maxLength={4000} /></label>
              </div>
              {activeRubrics.length === 0 && <p className={s.hint} style={{ margin: 0 }}>No rubric yet. Evaluations need one; <a href="/learning/rubrics">create a rubric</a> first or link it later.</p>}
              <div className={s.formActions}><button type="submit" className="primary">Create milestone</button></div>
            </form>
          </div>
        </details>
      )}
    </>
  );
}
