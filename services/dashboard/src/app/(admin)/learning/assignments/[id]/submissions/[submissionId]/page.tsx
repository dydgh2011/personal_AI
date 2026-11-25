import { notFound } from 'next/navigation';
import { Chip, CodeExecutionNotice, Empty, EvaluationSummary, LearningPostFields, Notice, PageHeader, Panel } from '@/components/learning/parts';
import s from '@/components/learning/learning.module.css';
import { errorText, Flash, Unavailable } from '@/components/ui';
import { learning, LearningError } from '@/lib/learning';
import type { AssignmentDetail, RubricVersion } from '@/lib/learning-types';
import { fileHref, formatBytes, LEARNING_UUID, submissionHref, type LearningSearchParams } from '@/lib/learning-view';
import { requireSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

function OwnerEvaluationForm({ rubric, submissionId, csrf, returnTo }: {
  rubric: RubricVersion;
  submissionId: string;
  csrf: string;
  returnTo: string;
}) {
  return (
    <form method="post" action={`/api/learning/submissions/${submissionId}/evaluate-owner`} className={s.form}>
      <LearningPostFields csrf={csrf} returnTo={returnTo} />
      {rubric.criteria.map((criterion) => (
        <fieldset className={s.criterionFields} key={criterion.key}>
          <legend>{criterion.title}</legend>
          <input type="hidden" name="criterion" value={criterion.key} />
          {criterion.description && <p className={s.formHint}>{criterion.description}</p>}
          <div className={s.fields}>
            <label className={s.field}>Score (0–{criterion.maxScore})
              <input name={`score:${criterion.key}`} type="number" min={0} max={criterion.maxScore} step={0.01} required />
            </label>
            <label className={s.field}>Rationale<input name={`note:${criterion.key}`} maxLength={2000} /></label>
          </div>
        </fieldset>
      ))}
      <label className={s.field}>Evidence checked<textarea name="evidenceNote" rows={2} maxLength={2000} /></label>
      <label className={s.field}>Feedback<textarea name="feedback" rows={3} maxLength={5000} /></label>
      <label className={s.field}>Confidence (0–100%)<input name="confidence" type="number" min={0} max={100} step={1} /></label>
      <label className={s.field}>Limitations (one per line)<textarea name="limitations" rows={2} maxLength={5000} /></label>
      <div className={s.formActions}><button type="submit" className="primary">Record evaluation</button></div>
    </form>
  );
}

export default async function SubmissionPage({ params, searchParams }: {
  params: Promise<{ id: string; submissionId: string }>;
  searchParams: LearningSearchParams;
}) {
  const [{ id, submissionId }, sp, session] = await Promise.all([params, searchParams, requireSession()]);
  if (!LEARNING_UUID.test(id) || !LEARNING_UUID.test(submissionId)) notFound();

  let detail: AssignmentDetail;
  try {
    detail = await learning.assignment(id);
  } catch (error) {
    if (error instanceof LearningError && error.status === 404) notFound();
    return <Unavailable what="Learning service" reason={errorText(error)} />;
  }
  const { assignment, definitions, codeExecution } = detail;
  const submission = detail.submissions.find((revision) => revision.id === submissionId);
  if (!submission) notFound();

  const definition = definitions.find((item) => item.version === submission.definitionVersion);
  const rubricId = definition?.rubricVersionId;
  const [historyResult, rubricResult, statusResult] = await Promise.allSettled([
    learning.submissionEvaluations(submissionId),
    rubricId ? learning.rubricVersion(rubricId) : null,
    learning.status(),
  ]);
  const evaluations = historyResult.status === 'fulfilled' ? historyResult.value : [];
  const rubric = rubricResult.status === 'fulfilled' ? rubricResult.value : null;
  const status = statusResult.status === 'fulfilled' ? statusResult.value : null;

  const here = submissionHref(id, submissionId);
  const latest = submission.id === assignment.latestSubmissionId;
  const running = evaluations.some((ev) => ev.status === 'pending');

  return (
    <>
      <PageHeader
        title={`Revision ${submission.revision}`}
        sub={definition?.title ?? assignment.title}
        crumbs={[
          { href: '/learning/assignments', label: 'Assignments' },
          { href: `/learning/assignments/${id}`, label: assignment.title },
        ]}
        actions={(
          <>
            <Chip>definition v{submission.definitionVersion}</Chip>
            {latest && <Chip tone="info">latest</Chip>}
            {rubric && <a className={s.linkBtn} href="#evaluation-tools">Evaluate</a>}
          </>
        )}
      />
      <Flash ok={sp.ok} error={sp.error} />
      <div className={s.split}>
        <div className={s.stack}>
          <Panel title="Submitted work" note={<time dateTime={submission.submittedAt}>{submission.submittedAt.slice(0, 10)}</time>}>
            {submission.body && <pre className={s.answer}>{submission.body}</pre>}
            {submission.note && <p className={`${s.prose} ${s.sectionSpace}`}>{submission.note}</p>}
            {submission.files.length > 0 && (
              <div className={s.files}>
                {submission.files.map((file) => (
                  <a className={s.file} key={file.id} href={fileHref(submissionId, file.id)} download>
                    <span className={s.fileName} title={file.name}>{file.name}</span>
                    <span className={s.meterLabel}>{formatBytes(file.size)}</span>
                    <span aria-hidden>↓</span>
                  </a>
                ))}
              </div>
            )}
          </Panel>
          {definition && (
            <details className={s.disclosure}>
              <summary>Assignment instructions · v{definition.version}</summary>
              <div className={s.disclosureBody}><p className={s.prose}>{definition.instructions}</p></div>
            </details>
          )}
          {definition?.kind === 'code' && <CodeExecutionNotice codeExecution={codeExecution} />}
          <Panel title="Evaluation history">
            {historyResult.status === 'rejected' ? <Unavailable what="Evaluation history" reason={errorText(historyResult.reason)} /> : (
              evaluations.length ? (
                <div className={s.stack}>
                  {evaluations.map((ev) => <EvaluationSummary key={ev.id} ev={ev} href={`/learning/evaluations/${ev.id}`} />)}
                </div>
              ) : <Empty title="No evaluations yet" />
            )}
          </Panel>
        </div>
        <div className={s.stack}>
          <Panel title="AI evaluation" id="evaluation-tools">
            {status?.ai.configured === false ? (
              <Notice tone="warn" title="AI is not configured">You can record your own evaluation below when a rubric is linked.</Notice>
            ) : !status ? (
              <Notice tone="warn" title="AI status unavailable">Reload to check whether AI evaluation is available.</Notice>
            ) : rubric && (
              <form method="post" action={`/api/learning/submissions/${submissionId}/evaluate-ai`} className={s.form}>
                <LearningPostFields csrf={session.csrf} returnTo={here} />
                <p className={s.formHint}>The provider reviews the answer and text attachments against the rubric. You decide the assignment outcome.</p>
                <div className={s.formActions}>
                  <button type="submit" disabled={running}>{running ? 'Evaluation running' : 'Request AI evaluation'}</button>
                </div>
              </form>
            )}
            {status?.ai.configured && !rubric && <p className={s.formHint}>AI evaluation requires the revision’s rubric.</p>}
          </Panel>

          <Panel title="Your evaluation" note={rubric ? `Rubric v${rubric.version} · pass at ${rubric.passingScore} / ${rubric.maxScore}` : undefined}>
            {rubric ? (
              <OwnerEvaluationForm rubric={rubric} submissionId={submissionId} csrf={session.csrf} returnTo={here} />
            ) : rubricResult.status === 'rejected' ? (
              <Unavailable what="Rubric version" reason={errorText(rubricResult.reason)} />
            ) : (
              <Empty title="This revision has no rubric">
                <a href={`/learning/assignments/${id}`}>Link a rubric to the assignment, then submit a new revision.</a>
              </Empty>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
