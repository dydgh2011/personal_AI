import { notFound } from 'next/navigation';
import { Chip, CodeExecutionNotice, Empty, EvaluationSummary, LearningPostFields, Notice, PageHeader, Panel } from '@/components/learning/parts';
import s from '@/components/learning/learning.module.css';
import { errorText, Flash, Unavailable } from '@/components/ui';
import { learning, LearningError } from '@/lib/learning';
import type { AssignmentDetail, RubricVersion } from '@/lib/learning-types';
import { fileHref, formatBytes, LEARNING_UUID, submissionHref, type LearningSearchParams } from '@/lib/learning-view';
import { requireSession } from '@/lib/server';
import { getT } from '@/i18n/server';
import type { Dict } from '@/i18n';

export const dynamic = 'force-dynamic';

function OwnerEvaluationForm({ t, rubric, submissionId, csrf, returnTo }: {
  t: Dict;
  rubric: RubricVersion;
  submissionId: string;
  csrf: string;
  returnTo: string;
}) {
  const k = t.learnSubmission;
  return (
    <form method="post" action={`/api/learning/submissions/${submissionId}/evaluate-owner`} className={s.form}>
      <LearningPostFields csrf={csrf} returnTo={returnTo} />
      {rubric.criteria.map((criterion) => (
        <fieldset className={s.criterionFields} key={criterion.key}>
          <legend>{criterion.title}</legend>
          <input type="hidden" name="criterion" value={criterion.key} />
          {criterion.description && <p className={s.formHint}>{criterion.description}</p>}
          <div className={s.fields}>
            <label className={s.field}>{k.score(criterion.maxScore)}
              <input name={`score:${criterion.key}`} type="number" min={0} max={criterion.maxScore} step={0.01} required />
            </label>
            <label className={s.field}>{k.rationale}<input name={`note:${criterion.key}`} maxLength={2000} /></label>
          </div>
        </fieldset>
      ))}
      <label className={s.field}>{k.evidenceChecked}<textarea name="evidenceNote" rows={2} maxLength={2000} /></label>
      <label className={s.field}>{k.feedback}<textarea name="feedback" rows={3} maxLength={5000} /></label>
      <label className={s.field}>{k.confidence}<input name="confidence" type="number" min={0} max={100} step={1} /></label>
      <label className={s.field}>{k.limitations}<textarea name="limitations" rows={2} maxLength={5000} /></label>
      <div className={s.formActions}><button type="submit" className="primary">{k.record}</button></div>
    </form>
  );
}

export default async function SubmissionPage({ params, searchParams }: {
  params: Promise<{ id: string; submissionId: string }>;
  searchParams: LearningSearchParams;
}) {
  const [{ id, submissionId }, sp, session, t] = await Promise.all([params, searchParams, requireSession(), getT()]);
  const k = t.learnSubmission;
  const a = t.learnAssignments;
  if (!LEARNING_UUID.test(id) || !LEARNING_UUID.test(submissionId)) notFound();

  let detail: AssignmentDetail;
  try {
    detail = await learning.assignment(id);
  } catch (error) {
    if (error instanceof LearningError && error.status === 404) notFound();
    return <Unavailable t={t} what={t.learn.serviceWhat} reason={errorText(error, t)} />;
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
        title={a.revision(submission.revision)}
        sub={definition?.title ?? assignment.title}
        crumbsLabel={t.common.breadcrumb}
        crumbs={[
          { href: '/learning/assignments', label: a.title },
          { href: `/learning/assignments/${id}`, label: assignment.title },
        ]}
        actions={(
          <>
            <Chip>{a.definition(submission.definitionVersion)}</Chip>
            {latest && <Chip tone="info">{a.latest}</Chip>}
            {rubric && <a className={s.linkBtn} href="#evaluation-tools">{k.evaluate}</a>}
          </>
        )}
      />
      <Flash ok={sp.ok} error={sp.error} />
      <div className={s.split}>
        <div className={s.stack}>
          <Panel title={k.submittedWork} note={<time dateTime={submission.submittedAt}>{submission.submittedAt.slice(0, 10)}</time>}>
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
              <summary>{k.instructionsV(definition.version)}</summary>
              <div className={s.disclosureBody}><p className={s.prose}>{definition.instructions}</p></div>
            </details>
          )}
          {definition?.kind === 'code' && <CodeExecutionNotice t={t} codeExecution={codeExecution} />}
          <Panel title={k.evaluationHistory}>
            {historyResult.status === 'rejected' ? <Unavailable t={t} what={k.evaluationHistory} reason={errorText(historyResult.reason, t)} /> : (
              evaluations.length ? (
                <div className={s.stack}>
                  {evaluations.map((ev) => <EvaluationSummary t={t} key={ev.id} ev={ev} href={`/learning/evaluations/${ev.id}`} />)}
                </div>
              ) : <Empty title={k.noEvaluations} />
            )}
          </Panel>
        </div>
        <div className={s.stack}>
          <Panel title={k.aiEvaluation} id="evaluation-tools">
            {status?.ai.configured === false ? (
              <Notice tone="warn" title={k.aiNotConfigured}>{k.aiNotConfiguredBody}</Notice>
            ) : !status ? (
              <Notice tone="warn" title={k.aiStatusUnavailable}>{k.aiStatusUnavailableBody}</Notice>
            ) : rubric && (
              <form method="post" action={`/api/learning/submissions/${submissionId}/evaluate-ai`} className={s.form}>
                <LearningPostFields csrf={session.csrf} returnTo={here} />
                <p className={s.formHint}>{k.aiNote}</p>
                <div className={s.formActions}>
                  <button type="submit" disabled={running}>{running ? k.running : k.requestAi}</button>
                </div>
              </form>
            )}
            {status?.ai.configured && !rubric && <p className={s.formHint}>{k.aiNeedsRubric}</p>}
          </Panel>

          <Panel title={k.yourEvaluation} note={rubric ? k.rubricNote(rubric.version, rubric.passingScore, rubric.maxScore) : undefined}>
            {rubric ? (
              <OwnerEvaluationForm t={t} rubric={rubric} submissionId={submissionId} csrf={session.csrf} returnTo={here} />
            ) : rubricResult.status === 'rejected' ? (
              <Unavailable t={t} what={k.rubricVersion} reason={errorText(rubricResult.reason, t)} />
            ) : (
              <Empty title={k.noRubric}>
                <a href={`/learning/assignments/${id}`}>{k.noRubricLink}</a>
              </Empty>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
