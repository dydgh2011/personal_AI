import { notFound } from 'next/navigation';
import { Chip, DeadlinePair, Empty, Meter, PageHeader, Panel } from '@/components/learning/parts';
import s from '@/components/learning/learning.module.css';
import { CsrfField, errorText, Flash, Unavailable } from '@/components/ui';
import { since } from '@/lib/diff';
import { learning, LearningError } from '@/lib/learning';
import { ASSIGNMENT_KINDS, MILESTONE_STATUSES, type Assignment, type Milestone, type Roadmap, type Rubric, type RubricVersion, type Skill } from '@/lib/learning-types';
import { todayIso } from '@/lib/learning-view';
import { requireSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const KIND_HINT: Record<Assignment['kind'], string> = {
  text: 'written answer',
  file: 'upload a document',
  code: 'source code (read, never run)',
  photo: 'photo of work (PNG/JPEG/GIF/WebP)',
  experiment: 'experiment write-up and data',
};

export default async function MilestonePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, sp, session] = await Promise.all([params, searchParams, requireSession()]);
  if (!UUID.test(id)) notFound();
  let m: Milestone;
  let assignments: Assignment[];
  let roadmap: Roadmap | undefined;
  let rubrics: Rubric[];
  let skills: Skill[];
  try {
    m = await learning.milestone(id);
    const [a, r, rb, sk] = await Promise.all([learning.assignments({ milestoneId: id }), learning.roadmap(m.roadmapId), learning.rubrics(), learning.skills()]);
    assignments = a.items;
    roadmap = r.roadmap;
    rubrics = rb;
    skills = sk.items;
  } catch (e) {
    if (e instanceof LearningError && e.status === 404) notFound();
    return <Unavailable what="Learning service" reason={errorText(e)} />;
  }
  const rubric: RubricVersion | null = m.rubricVersionId ? await learning.rubricVersion(m.rubricVersionId).catch(() => null) : null;
  const rubricTitle = rubric ? rubrics.find((r) => r.id === rubric.rubricId)?.title : null;
  const today = todayIso(new Date(), process.env.TZ || undefined);
  const here = `/learning/milestones/${id}`;
  const skillName = new Map(skills.map((k) => [k.id, k.displayName]));
  const live = assignments.filter((a) => a.status !== 'archived');
  const canComplete = live.length > 0 && live.every((a) => a.status === 'passed') && m.status !== 'completed';
  const closed = m.status === 'completed' || m.status === 'archived';
  const rubricOptions = rubrics.filter((r) => r.latestVersion && (r.status === 'active' || r.latestVersion.id === m.rubricVersionId));

  return (
    <>
      <PageHeader
        crumbs={[{ href: '/learning/milestones', label: 'Milestones' }, { href: `/learning/roadmaps/${m.roadmapId}`, label: roadmap?.title ?? 'Roadmap' }]}
        title={m.title}
        sub={m.description ?? undefined}
        actions={<><Chip status={m.status} /><Chip tone="muted">weight {m.weight}</Chip></>}
      />
      <Flash ok={sp.ok} error={sp.error} />

      <div className={s.split}>
        <div className={s.stack}>
          <Panel title="Deadlines" note="Your fixed deadline only changes when you change it. Suggestions are stored next to it and applied only if you accept them.">
            <DeadlinePair deadline={m.deadline} today={today} />
            <div className={s.cols2} style={{ marginTop: 12 }}>
              <form method="post" action={`/api/learning/milestones/${id}/update`} className={s.formActions}>
                <CsrfField token={session.csrf} />
                <input type="hidden" name="returnTo" value={here} />
                <label className={s.field} style={{ flex: '1 1 160px' }}>Set your deadline<input name="fixedDeadline" type="date" defaultValue={m.deadline.fixed ?? ''} /></label>
                <button type="submit" style={{ alignSelf: 'flex-end' }}>Save</button>
              </form>
              {m.deadline.suggested && (
                <div className={s.form}>
                  <form method="post" action={`/api/learning/milestones/${id}/accept-deadline`} className={s.form}>
                    <CsrfField token={session.csrf} />
                    <input type="hidden" name="returnTo" value={here} />
                    <input type="hidden" name="date" value={m.deadline.suggested} />
                    <label className={s.check}><input type="checkbox" name="confirmed" value="yes" required /> Make {m.deadline.suggested} my fixed deadline{m.deadline.fixed ? ` (instead of ${m.deadline.fixed})` : ''}.</label>
                    <div className={s.formActions}><button type="submit">Accept suggestion</button></div>
                  </form>
                  <form method="post" action={`/api/learning/milestones/${id}/dismiss-deadline`}>
                    <CsrfField token={session.csrf} />
                    <input type="hidden" name="returnTo" value={here} />
                    <button type="submit" className="danger">Dismiss suggestion</button>
                  </form>
                </div>
              )}
            </div>
            {m.deadline.fixedSetBy && <p className={s.hint} style={{ margin: '8px 0 0' }}>Fixed by {m.deadline.fixedSetBy} {since(m.deadline.fixedSetAt)}.</p>}
          </Panel>

          <Panel title="Assignments" note={`${m.assignments.passed} of ${m.assignments.total} passed. The milestone can be completed when every assignment has passed.`} flush>
            {assignments.length ? (
              <div className={s.rows}>
                {assignments.map((a) => (
                  <div key={a.id} className={s.row}>
                    <div className={s.rowMain}>
                      <a className={s.rowTitle} href={`/learning/assignments/${a.id}`}>{a.title}</a>
                      <div className={s.rowMeta}><span>{a.kind} · {KIND_HINT[a.kind]}</span><span>{a.submissions} submission(s)</span><span>definition v{a.definitionVersion}</span></div>
                    </div>
                    <div className={s.rowSide}><Chip status={a.status} /></div>
                  </div>
                ))}
              </div>
            ) : <div style={{ padding: 16 }}><Empty title="No assignments yet">Add one below: a task you submit and get evaluated on.</Empty></div>}
          </Panel>
          {!closed && (
            <details className={s.disclosure} open={assignments.length === 0}>
              <summary>New assignment</summary>
              <div className={s.disclosureBody}>
                <form method="post" action="/api/learning/assignments/create" className={s.form}>
                  <CsrfField token={session.csrf} />
                  <input type="hidden" name="returnTo" value={here} />
                  <input type="hidden" name="milestoneId" value={id} />
                  <div className={s.fields}>
                    <label className={s.field}>Title<input name="title" required maxLength={200} /></label>
                    <label className={s.field}>Kind<select name="kind" defaultValue="text">{ASSIGNMENT_KINDS.map((k) => <option key={k} value={k}>{k} · {KIND_HINT[k]}</option>)}</select></label>
                    <label className={s.field}>Rubric
                      <select name="rubricVersionId" defaultValue={m.rubricVersionId ?? ''}><option value="">(milestone default)</option>{rubricOptions.map((r) => <option key={r.id} value={r.latestVersion!.id}>{r.title} · v{r.latestVersion!.version}</option>)}</select>
                    </label>
                    <label className={s.field}>Status<select name="status" defaultValue="available"><option value="available">open now</option><option value="planned">planned (not open yet)</option></select></label>
                    <label className={`${s.field} ${s.fieldWide}`}>Instructions<textarea name="instructions" required rows={5} maxLength={20000} placeholder="What to do and what to hand in" /></label>
                  </div>
                  <div className={s.formActions}><button type="submit" className="primary">Add assignment</button></div>
                </form>
              </div>
            </details>
          )}
        </div>

        <div className={s.stack}>
          <Panel title="Rubric" note={rubric ? `${rubricTitle ?? 'Rubric'} · v${rubric.version} · pass at ${rubric.passingScore} / ${rubric.maxScore}` : undefined} actions={<a href="/learning/rubrics">Rubrics →</a>}>
            {rubric ? (
              <div className={s.rows}>
                {rubric.criteria.map((c) => (
                  <div key={c.key} className={s.row}>
                    <div className={s.rowMain}><span className={s.rowTitle}>{c.title}</span>{c.description && <span className={s.rowMeta}>{c.description}</span>}</div>
                    <span className={s.meterLabel}>max {c.maxScore}</span>
                  </div>
                ))}
              </div>
            ) : <Empty title="No rubric">Evaluations (yours or AI) need a rubric. Link one below.</Empty>}
          </Panel>

          <Panel title="Details">
            <dl className={s.kv}>
              <dt>Passing criteria</dt><dd className={s.prose}>{m.passingCriteria ?? '—'}</dd>
              <dt>Roadmap node</dt><dd className={s.mono}>{m.nodeKey ?? '—'}</dd>
              <dt>Skills trained</dt>
              <dd>{m.skillIds.length ? <span className={s.chips}>{m.skillIds.map((k) => <a key={k} href={`/learning/skills/${k}`}><Chip tone="info">{skillName.get(k) ?? 'skill'}</Chip></a>)}</span> : '—'}</dd>
              <dt>Progress</dt><dd><Meter value={m.assignments.passed} max={Math.max(1, m.assignments.total)} tone="ok" label={`${m.assignments.passed}/${m.assignments.total}`} /></dd>
            </dl>
          </Panel>

          {canComplete && (
            <form method="post" action={`/api/learning/milestones/${id}/update`} className={s.panel}>
              <CsrfField token={session.csrf} />
              <input type="hidden" name="returnTo" value={here} />
              <input type="hidden" name="status" value="completed" />
              <p style={{ marginTop: 0 }}>Every assignment has passed.</p>
              <button type="submit" className="approve">Complete milestone</button>
            </form>
          )}

          <details className={s.disclosure}>
            <summary>Edit milestone</summary>
            <div className={s.disclosureBody}>
              <form method="post" action={`/api/learning/milestones/${id}/update`} className={s.form}>
                <CsrfField token={session.csrf} />
                <input type="hidden" name="returnTo" value={here} />
                <input type="hidden" name="skillIds-present" value="1" />
                <div className={s.fields}>
                  <label className={`${s.field} ${s.fieldWide}`}>Title<input name="title" defaultValue={m.title} maxLength={200} /></label>
                  <label className={s.field}>Rubric
                    <select name="rubricVersionId" defaultValue={m.rubricVersionId ?? ''}><option value="">(none)</option>{rubricOptions.map((r) => <option key={r.id} value={r.latestVersion!.id}>{r.title} · v{r.latestVersion!.version}</option>)}
                      {rubric && !rubricOptions.some((r) => r.latestVersion!.id === rubric.id) && <option value={rubric.id}>{rubricTitle} · v{rubric.version} (older)</option>}</select>
                  </label>
                  <label className={s.field}>Weight<input name="weight" type="number" min={0} max={100} defaultValue={m.weight} /></label>
                  <label className={s.field}>Status<select name="status" defaultValue={m.status}>{MILESTONE_STATUSES.filter((x) => x !== 'completed' || m.status === 'completed' || canComplete).map((x) => <option key={x}>{x}</option>)}</select></label>
                  {skills.length > 0 && (
                    <label className={s.field}>Skills trained<select name="skillIds" multiple size={Math.min(5, Math.max(2, skills.length))} defaultValue={m.skillIds}>{skills.map((k) => <option key={k.id} value={k.id}>{k.displayName}</option>)}</select></label>
                  )}
                  <label className={`${s.field} ${s.fieldWide}`}>Passing criteria<textarea name="passingCriteria" rows={3} maxLength={4000} defaultValue={m.passingCriteria ?? ''} /></label>
                  <label className={`${s.field} ${s.fieldWide}`}>Description<textarea name="description" rows={2} maxLength={4000} defaultValue={m.description ?? ''} /></label>
                </div>
                <p className={s.hint} style={{ margin: 0 }}>Changing the rubric affects new assignments only; existing assignments and evaluations keep the version they were made with.</p>
                <div className={s.formActions}><button type="submit" className="primary">Save milestone</button></div>
              </form>
            </div>
          </details>
        </div>
      </div>
    </>
  );
}
