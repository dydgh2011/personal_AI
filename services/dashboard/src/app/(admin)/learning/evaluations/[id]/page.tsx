import { notFound } from 'next/navigation';
import { Chip, EvaluationSummary, EvidenceList, LearningPostFields, LevelField, PageHeader, Panel } from '@/components/learning/parts';
import s from '@/components/learning/learning.module.css';
import { errorText, Flash, Unavailable } from '@/components/ui';
import { learning, LearningError } from '@/lib/learning';
import type { AssignmentDetail, EvaluationDetail, Skill } from '@/lib/learning-types';
import { LEARNING_UUID, levelLabel, submissionHref, type LearningSearchParams } from '@/lib/learning-view';
import { requireSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

export default async function EvaluationPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: LearningSearchParams;
}) {
  const [{ id }, sp, session] = await Promise.all([params, searchParams, requireSession()]);
  if (!LEARNING_UUID.test(id)) notFound();

  let ev: EvaluationDetail;
  let detail: AssignmentDetail;
  try {
    ev = await learning.evaluation(id);
    detail = await learning.assignment(ev.assignmentId);
  } catch (error) {
    if (error instanceof LearningError && error.status === 404) notFound();
    return <Unavailable what="Learning service" reason={errorText(error)} />;
  }

  const { assignment, submissions } = detail;
  const submission = submissions.find((item) => item.id === ev.submissionId);
  const revision = submissionHref(assignment.id, ev.submissionId);
  const here = `/learning/evaluations/${id}`;
  const canDecide = ev.status === 'completed' && assignment.status === 'evaluated' && assignment.latestSubmissionId === ev.submissionId;
  const hasGrounds = ev.status === 'completed' && Boolean(ev.rubricVersionId) && ev.evidence.length > 0;

  let relatedSkills: Skill[] = [];
  let skillError: unknown;
  if (hasGrounds) {
    try {
      const [milestone, { items: skills }] = await Promise.all([learning.milestone(assignment.milestoneId), learning.skills()]);
      const linkedSkills = new Set(milestone.skillIds);
      relatedSkills = skills.filter((skill) => linkedSkills.has(skill.id));
    } catch (error) {
      skillError = error;
    }
  }

  return (
    <>
      <PageHeader
        title={ev.assignmentTitle}
        sub={`Evaluation of revision ${ev.revision}`}
        crumbs={[{ href: '/learning/evaluations', label: 'Evaluations' }, { href: revision, label: `Revision ${ev.revision}` }]}
        actions={<a className={s.linkBtn} href={revision}>View submission</a>}
      />
      <Flash ok={sp.ok} error={sp.error} />

      <div className={s.split}>
        <div className={s.stack}>
          <Panel title="Result" note={<time dateTime={ev.createdAt}>{ev.createdAt.slice(0, 10)}</time>}>
            <EvaluationSummary ev={ev} />
          </Panel>
          {ev.status === 'completed' && (
            <Panel title="Evidence"><EvidenceList evidence={ev.evidence} files={submission?.files} /></Panel>
          )}
          {(Boolean(ev.suggestions.gaps?.length) || Boolean(ev.suggestions.levels?.length)) && (
            <Panel title="Suggested follow-up">
              <div className={s.rows}>
                {ev.suggestions.gaps?.map((gap) => (
                  <div className={s.row} key={gap.gapId ?? gap.title}>
                    <div className={s.rowMain}>
                      <span className={s.rowTitle}>{gap.title}</span>
                      {gap.description && <p className={s.prose}>{gap.description}</p>}
                    </div>
                                        <a href="/learning/skills#skill-gaps">View gaps</a>
                  </div>
                ))}
                {ev.suggestions.levels?.map((suggestion) => (
                  <div className={s.row} key={suggestion.skill}>
                    <div className={s.rowMain}>
                      <span className={s.rowTitle}>{suggestion.skill} · {levelLabel(suggestion.level)}</span>
                      {suggestion.rationale && <p className={s.prose}>{suggestion.rationale}</p>}
                    </div>
                    <Chip tone="warn">AI level suggestion</Chip>
                  </div>
                ))}
              </div>
            </Panel>
          )}
        </div>

        <div className={s.stack}>
          <Panel title="Assignment decision" note={canDecide ? 'Record your decision using this evaluation of the latest revision.' : undefined}>
            {canDecide ? (
              <form method="post" action={`/api/learning/assignments/${assignment.id}/decide`} className={s.form}>
                <LearningPostFields csrf={session.csrf} returnTo={here} />
                <input type="hidden" name="evaluationId" value={id} />
                <label className={s.field}>Decision
                  <select name="decision" defaultValue="" required>
                    <option value="" disabled>Choose a decision</option>
                    {hasGrounds && <option value="passed">Mark as passed</option>}
                    <option value="revision_required">Request a revision</option>
                  </select>
                </label>
                <label className={s.check}><input type="checkbox" name="confirmed" value="yes" required /> I confirm this decision.</label>
                <div className={s.formActions}><button type="submit" className="primary">Save decision</button></div>
              </form>
            ) : (
              <div className={s.chips}>
                <Chip status={assignment.status} />
                {assignment.decisionEvaluationId === id ? <span>This evaluation supports the recorded decision.</span> : (
                  <a href={`/learning/assignments/${assignment.id}`}>View assignment status</a>
                )}
              </div>
            )}
          </Panel>

          {skillError ? <Unavailable what="Linked skills" reason={errorText(skillError)} /> : relatedSkills.length > 0 && (
            <Panel title="Verify a skill level" note="Choose a level based on the evidence you reviewed.">
              <div className={s.stack}>
                {relatedSkills.map((skill) => (
                  <details className={s.disclosure} key={skill.id}>
                    <summary>{skill.displayName}</summary>
                    <div className={s.disclosureBody}>
                      <form method="post" action={`/api/learning/skills/${skill.id}/verify`} className={s.form}>
                        <LearningPostFields csrf={session.csrf} returnTo={here} />
                        <input type="hidden" name="evaluationId" value={id} />
                        <LevelField />
                        <label className={s.field}>Note (optional)<textarea name="note" rows={2} maxLength={1000} /></label>
                        <label className={s.check}><input type="checkbox" name="confirmed" value="yes" required /> I have reviewed the evidence for this skill.</label>
                        <div className={s.formActions}>
                          <button type="submit" className="primary">Record verified level</button>
                          <a href={`/learning/skills/${skill.id}`}>View skill</a>
                        </div>
                      </form>
                    </div>
                  </details>
                ))}
              </div>
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}
