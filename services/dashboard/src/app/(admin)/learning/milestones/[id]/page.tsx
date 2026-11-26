import { notFound } from 'next/navigation';
import { Chip, DeadlinePair, Empty, Meter, PageHeader, Panel } from '@/components/learning/parts';
import s from '@/components/learning/learning.module.css';
import { CsrfField, errorText, Flash, Unavailable } from '@/components/ui';
import { since } from '@/lib/diff';
import { learning, LearningError } from '@/lib/learning';
import { ASSIGNMENT_KINDS, MILESTONE_STATUSES, type Assignment, type Milestone, type Roadmap, type Rubric, type RubricVersion, type Skill } from '@/lib/learning-types';
import { statusView, todayIso } from '@/lib/learning-view';
import { requireSession } from '@/lib/server';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export default async function MilestonePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, sp, session, t] = await Promise.all([params, searchParams, requireSession(), getT()]);
  const k = t.learnMilestones;
  const f = t.lf;
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
    return <Unavailable t={t} what={t.learn.serviceWhat} reason={errorText(e, t)} />;
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
        crumbsLabel={t.common.breadcrumb}
        crumbs={[{ href: '/learning/milestones', label: k.title }, { href: `/learning/roadmaps/${m.roadmapId}`, label: roadmap?.title ?? k.roadmap }]}
        title={m.title}
        sub={m.description ?? undefined}
        actions={<><Chip t={t} status={m.status} /><Chip tone="muted">{k.weightChip(m.weight)}</Chip></>}
      />
      <Flash ok={sp.ok} error={sp.error} />

      <div className={s.split}>
        <div className={s.stack}>
          <Panel title={k.deadlines} note={k.deadlinesNote}>
            <DeadlinePair t={t} deadline={m.deadline} today={today} />
            <div className={s.cols2} style={{ marginTop: 12 }}>
              <form method="post" action={`/api/learning/milestones/${id}/update`} className={s.formActions}>
                <CsrfField token={session.csrf} />
                <input type="hidden" name="returnTo" value={here} />
                <label className={s.field} style={{ flex: '1 1 160px' }}>{k.setDeadline}<input name="fixedDeadline" type="date" defaultValue={m.deadline.fixed ?? ''} /></label>
                <button type="submit" style={{ alignSelf: 'flex-end' }}>{f.save}</button>
              </form>
              {m.deadline.suggested && (
                <div className={s.form}>
                  <form method="post" action={`/api/learning/milestones/${id}/accept-deadline`} className={s.form}>
                    <CsrfField token={session.csrf} />
                    <input type="hidden" name="returnTo" value={here} />
                    <input type="hidden" name="date" value={m.deadline.suggested} />
                    <label className={s.check}><input type="checkbox" name="confirmed" value="yes" required /> {k.makeFixed(m.deadline.suggested, m.deadline.fixed)}</label>
                    <div className={s.formActions}><button type="submit">{k.acceptSuggestion}</button></div>
                  </form>
                  <form method="post" action={`/api/learning/milestones/${id}/dismiss-deadline`}>
                    <CsrfField token={session.csrf} />
                    <input type="hidden" name="returnTo" value={here} />
                    <button type="submit" className="danger">{k.dismissSuggestion}</button>
                  </form>
                </div>
              )}
            </div>
            {m.deadline.fixedSetBy && <p className={s.hint} style={{ margin: '8px 0 0' }}>{k.fixedBy(m.deadline.fixedSetBy, since(m.deadline.fixedSetAt, t))}</p>}
          </Panel>

          <Panel title={k.assignments} note={k.assignmentsNote(m.assignments.passed, m.assignments.total)} flush>
            {assignments.length ? (
              <div className={s.rows}>
                {assignments.map((a) => (
                  <div key={a.id} className={s.row}>
                    <div className={s.rowMain}>
                      <a className={s.rowTitle} href={`/learning/assignments/${a.id}`}>{a.title}</a>
                      <div className={s.rowMeta}><span>{f.kindName[a.kind] ?? a.kind} · {f.kindHint[a.kind]}</span><span>{k.submissions(a.submissions)}</span><span>{k.definition(a.definitionVersion)}</span></div>
                    </div>
                    <div className={s.rowSide}><Chip t={t} status={a.status} /></div>
                  </div>
                ))}
              </div>
            ) : <div style={{ padding: 16 }}><Empty title={k.noAssignments}>{k.noAssignmentsBody}</Empty></div>}
          </Panel>
          {!closed && (
            <details className={s.disclosure} open={assignments.length === 0}>
              <summary>{k.newAssignment}</summary>
              <div className={s.disclosureBody}>
                <form method="post" action="/api/learning/assignments/create" className={s.form}>
                  <CsrfField token={session.csrf} />
                  <input type="hidden" name="returnTo" value={here} />
                  <input type="hidden" name="milestoneId" value={id} />
                  <div className={s.fields}>
                    <label className={s.field}>{f.title}<input name="title" required maxLength={200} /></label>
                    <label className={s.field}>{k.kind}<select name="kind" defaultValue="text">{ASSIGNMENT_KINDS.map((x) => <option key={x} value={x}>{f.kindName[x] ?? x} · {f.kindHint[x]}</option>)}</select></label>
                    <label className={s.field}>{k.rubric}
                      <select name="rubricVersionId" defaultValue={m.rubricVersionId ?? ''}><option value="">{k.milestoneDefault}</option>{rubricOptions.map((r) => <option key={r.id} value={r.latestVersion!.id}>{r.title} · v{r.latestVersion!.version}</option>)}</select>
                    </label>
                    <label className={s.field}>{f.status}<select name="status" defaultValue="available"><option value="available">{k.openNow}</option><option value="planned">{k.plannedNotOpen}</option></select></label>
                    <label className={`${s.field} ${s.fieldWide}`}>{k.instructions}<textarea name="instructions" required rows={5} maxLength={20000} placeholder={k.instructionsPlaceholder} /></label>
                  </div>
                  <div className={s.formActions}><button type="submit" className="primary">{k.addAssignment}</button></div>
                </form>
              </div>
            </details>
          )}
        </div>

        <div className={s.stack}>
          <Panel title={k.rubric} note={rubric ? k.rubricNote(rubricTitle ?? k.rubric, rubric.version, rubric.passingScore, rubric.maxScore) : undefined} actions={<a href="/learning/rubrics">{k.rubricsLink}</a>}>
            {rubric ? (
              <div className={s.rows}>
                {rubric.criteria.map((c) => (
                  <div key={c.key} className={s.row}>
                    <div className={s.rowMain}><span className={s.rowTitle}>{c.title}</span>{c.description && <span className={s.rowMeta}>{c.description}</span>}</div>
                    <span className={s.meterLabel}>{k.maxScore(c.maxScore)}</span>
                  </div>
                ))}
              </div>
            ) : <Empty title={k.noRubricTitle}>{k.noRubricBody}</Empty>}
          </Panel>

          <Panel title={k.details}>
            <dl className={s.kv}>
              <dt>{k.passingCriteria}</dt><dd className={s.prose}>{m.passingCriteria ?? '—'}</dd>
              <dt>{k.roadmapNode}</dt><dd className={s.mono}>{m.nodeKey ?? '—'}</dd>
              <dt>{k.skillsTrained}</dt>
              <dd>{m.skillIds.length ? <span className={s.chips}>{m.skillIds.map((sk) => <a key={sk} href={`/learning/skills/${sk}`}><Chip tone="info">{skillName.get(sk) ?? k.skill}</Chip></a>)}</span> : '—'}</dd>
              <dt>{k.progress}</dt><dd><Meter t={t} value={m.assignments.passed} max={Math.max(1, m.assignments.total)} tone="ok" label={`${m.assignments.passed}/${m.assignments.total}`} /></dd>
            </dl>
          </Panel>

          {canComplete && (
            <form method="post" action={`/api/learning/milestones/${id}/update`} className={s.panel}>
              <CsrfField token={session.csrf} />
              <input type="hidden" name="returnTo" value={here} />
              <input type="hidden" name="status" value="completed" />
              <p style={{ marginTop: 0 }}>{k.allPassed}</p>
              <button type="submit" className="approve">{k.complete}</button>
            </form>
          )}

          <details className={s.disclosure}>
            <summary>{k.edit}</summary>
            <div className={s.disclosureBody}>
              <form method="post" action={`/api/learning/milestones/${id}/update`} className={s.form}>
                <CsrfField token={session.csrf} />
                <input type="hidden" name="returnTo" value={here} />
                <input type="hidden" name="skillIds-present" value="1" />
                <div className={s.fields}>
                  <label className={`${s.field} ${s.fieldWide}`}>{f.title}<input name="title" defaultValue={m.title} maxLength={200} /></label>
                  <label className={s.field}>{k.rubric}
                    <select name="rubricVersionId" defaultValue={m.rubricVersionId ?? ''}><option value="">{k.none2}</option>{rubricOptions.map((r) => <option key={r.id} value={r.latestVersion!.id}>{r.title} · v{r.latestVersion!.version}</option>)}
                      {rubric && !rubricOptions.some((r) => r.latestVersion!.id === rubric.id) && <option value={rubric.id}>{rubricTitle} · v{rubric.version} {k.older}</option>}</select>
                  </label>
                  <label className={s.field}>{k.weightField}<input name="weight" type="number" min={0} max={100} defaultValue={m.weight} /></label>
                  <label className={s.field}>{f.status}<select name="status" defaultValue={m.status}>{MILESTONE_STATUSES.filter((x) => x !== 'completed' || m.status === 'completed' || canComplete).map((x) => <option key={x} value={x}>{statusView(x, t).label}</option>)}</select></label>
                  {skills.length > 0 && (
                    <label className={s.field}>{k.skillsTrained}<select name="skillIds" multiple size={Math.min(5, Math.max(2, skills.length))} defaultValue={m.skillIds}>{skills.map((sk) => <option key={sk.id} value={sk.id}>{sk.displayName}</option>)}</select></label>
                  )}
                  <label className={`${s.field} ${s.fieldWide}`}>{k.passingCriteria}<textarea name="passingCriteria" rows={3} maxLength={4000} defaultValue={m.passingCriteria ?? ''} /></label>
                  <label className={`${s.field} ${s.fieldWide}`}>{f.description}<textarea name="description" rows={2} maxLength={4000} defaultValue={m.description ?? ''} /></label>
                </div>
                <p className={s.hint} style={{ margin: 0 }}>{k.rubricChangeNote}</p>
                <div className={s.formActions}><button type="submit" className="primary">{k.save}</button></div>
              </form>
            </div>
          </details>
        </div>
      </div>
    </>
  );
}
