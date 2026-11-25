import { notFound } from 'next/navigation';
import { FilePicker } from '@/components/learning/client';
import { Chip, CodeExecutionNotice, Empty, LearningPostFields, Notice, PageHeader, Panel } from '@/components/learning/parts';
import s from '@/components/learning/learning.module.css';
import { errorText, Flash, Unavailable } from '@/components/ui';
import { learning, LearningError } from '@/lib/learning';
import { ASSIGNMENT_KINDS, type Assignment } from '@/lib/learning-types';
import { LEARNING_UUID, statusView, submissionHref, type LearningSearchParams } from '@/lib/learning-view';
import { requireSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

const SUBMISSION_STATUSES = new Set<Assignment['status']>(['available', 'submitted', 'evaluated', 'revision_required']);
const STATUS_CHANGES: Record<Assignment['status'], Assignment['status'][]> = {
  planned: ['available', 'archived'],
  available: ['planned', 'archived'],
  submitted: ['archived'],
  evaluated: ['archived'],
  passed: ['archived'],
  revision_required: ['archived'],
  archived: ['planned'],
};

export default async function AssignmentPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: LearningSearchParams;
}) {
  const [{ id }, sp, session] = await Promise.all([params, searchParams, requireSession()]);
  if (!LEARNING_UUID.test(id)) notFound();

  try {
    const [{ assignment, submissions, definitions, codeExecution, uploadLimits }, rubrics] = await Promise.all([
      learning.assignment(id),
      learning.rubrics(),
    ]);
    const here = `/learning/assignments/${id}`;
    const canSubmit = SUBMISSION_STATUSES.has(assignment.status);
    const rubricOptions = rubrics.filter((r) => r.latestVersion && (r.status === 'active' || r.latestVersion.id === assignment.rubricVersionId));
    const pinnedRubric = assignment.rubricVersionId;
    const missingPinnedOption = pinnedRubric && !rubricOptions.some((r) => r.latestVersion?.id === pinnedRubric);

    return (
      <>
        <PageHeader
          title={assignment.title}
          crumbs={[
            { href: '/learning/assignments', label: 'Assignments' },
            { href: `/learning/milestones/${assignment.milestoneId}`, label: 'Milestone' },
          ]}
          actions={<><Chip status={assignment.status} /><Chip>{assignment.kind} · definition v{assignment.definitionVersion}</Chip></>}
        />
        <Flash ok={sp.ok} error={sp.error} />

        <div className={s.split}>
          <div className={s.stack}>
            <Panel title="Instructions">
              <p className={s.prose}>{assignment.instructions}</p>
              {assignment.kind === 'code' && <div className={s.sectionSpace}><CodeExecutionNotice codeExecution={codeExecution} /></div>}
            </Panel>

            {canSubmit && (
              <Panel title={submissions.length ? 'Submit a new revision' : 'Submit your work'} note="Each submission is saved in your revision history.">
                <form method="post" encType="multipart/form-data" action={`/api/learning/assignments/${id}/submit`} className={s.form}>
                  <LearningPostFields csrf={session.csrf} returnTo={here} />
                  {!pinnedRubric && (
                    <Notice tone="warn" title="Rubric required for evaluation">
                      Link a rubric in Edit assignment before submitting if you want to evaluate this revision.
                    </Notice>
                  )}
                  <label className={s.field}>Answer
                    <textarea name="body" rows={7} maxLength={uploadLimits.maxBodyChars} />
                  </label>
                  <FilePicker
                    accept={uploadLimits.extensions.map((ext) => '.' + ext).join(',')}
                    limits={uploadLimits}
                    required={assignment.kind === 'file' || assignment.kind === 'photo'}
                  />
                  {assignment.kind === 'photo' && <p className={s.formHint}>Include a PNG, JPEG, GIF or WebP image.</p>}
                  <label className={s.field}>Revision note (optional)<textarea name="note" rows={2} maxLength={2000} /></label>
                  <div className={s.formActions}><button type="submit" className="primary">Save submission</button></div>
                </form>
              </Panel>
            )}

            <details className={s.disclosure} open={!pinnedRubric || assignment.status === 'planned'}>
              <summary>Edit assignment</summary>
              <div className={s.disclosureBody}>
                <form method="post" action={`/api/learning/assignments/${id}/update`} className={s.form}>
                  <LearningPostFields csrf={session.csrf} returnTo={here} />
                  <div className={s.fields}>
                    <label className={`${s.field} ${s.fieldWide}`}>Title<input name="title" defaultValue={assignment.title} maxLength={200} required /></label>
                    <label className={s.field}>Kind
                      <select name="kind" defaultValue={assignment.kind}>
                        {ASSIGNMENT_KINDS.map((kind) => <option key={kind}>{kind}</option>)}
                      </select>
                    </label>
                    <label className={s.field}>Status
                      <select name="status" defaultValue={assignment.status}>
                        {[assignment.status, ...STATUS_CHANGES[assignment.status]].map((status) => (
                          <option key={status} value={status}>{statusView(status).label}</option>
                        ))}
                      </select>
                    </label>
                    <label className={`${s.field} ${s.fieldWide}`}>Rubric
                      <select name="rubricVersionId" defaultValue={pinnedRubric ?? ''}>
                        <option value="">No rubric</option>
                        {missingPinnedOption && <option value={pinnedRubric}>Keep the linked rubric version</option>}
                        {rubricOptions.map((r) => <option key={r.id} value={r.latestVersion!.id}>{r.title} · v{r.latestVersion!.version}</option>)}
                      </select>
                      <a href="/learning/rubrics">Manage rubrics</a>
                    </label>
                    <label className={`${s.field} ${s.fieldWide}`}>Instructions
                      <textarea name="instructions" defaultValue={assignment.instructions} rows={6} maxLength={20000} required />
                    </label>
                  </div>
                  <p className={s.formHint}>Evaluations use the rubric linked when the revision was submitted.</p>
                  <div className={s.formActions}><button type="submit" className="primary">Save assignment</button></div>
                </form>
              </div>
            </details>
          </div>

          <div className={s.stack}>
            <Panel title="Submission history">
              {submissions.length ? (
                <div className={s.rows}>
                  {submissions.map((submission) => (
                    <div className={s.row} key={submission.id}>
                      <div className={s.rowMain}>
                        <a className={s.rowTitle} href={submissionHref(id, submission.id)}>Revision {submission.revision}</a>
                        <div className={s.rowMeta}>
                          <time dateTime={submission.submittedAt}>{submission.submittedAt.slice(0, 10)}</time>
                          <span>definition v{submission.definitionVersion}</span>
                          <span>{submission.files.length} attachment(s)</span>
                        </div>
                      </div>
                      {submission.id === assignment.latestSubmissionId && <Chip tone="info">latest</Chip>}
                    </div>
                  ))}
                </div>
              ) : <Empty title="No submissions yet" />}
            </Panel>

            {assignment.decisionEvaluationId && (
              <Panel title="Assignment decision">
                <div className={s.chips}>
                  <Chip status={assignment.status} />
                  <a href={`/learning/evaluations/${assignment.decisionEvaluationId}`}>Review the supporting evaluation</a>
                </div>
              </Panel>
            )}

            {definitions.length > 1 && (
              <Panel title="Definition history">
                <div className={s.stack}>
                  {definitions.map((definition) => (
                    <details key={definition.version} className={s.disclosure}>
                      <summary>v{definition.version} · {definition.title}</summary>
                      <div className={s.disclosureBody}><p className={s.prose}>{definition.instructions}</p></div>
                    </details>
                  ))}
                </div>
              </Panel>
            )}
          </div>
        </div>
      </>
    );
  } catch (error) {
    if (error instanceof LearningError && error.status === 404) notFound();
    return <Unavailable what="Learning service" reason={errorText(error)} />;
  }
}
