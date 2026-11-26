import { Chip, Empty, PageHeader, Panel } from '@/components/learning/parts';
import s from '@/components/learning/learning.module.css';
import { errorText, Flash, Unavailable } from '@/components/ui';
import { learning } from '@/lib/learning';
import { EVALUATION_STATUSES } from '@/lib/learning-types';
import { statusView, submissionHref, type LearningSearchParams } from '@/lib/learning-view';
import { requireSession } from '@/lib/server';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

export default async function EvaluationsPage({ searchParams }: { searchParams: LearningSearchParams }) {
  const [sp, , t] = await Promise.all([searchParams, requireSession(), getT()]);
  const k = t.learnEvaluations;
  const status = EVALUATION_STATUSES.find((state) => state === sp.status);

  try {
    const [{ items: evaluations }, { items: assignments }] = await Promise.all([
      learning.evaluations({ status }),
      learning.assignments(),
    ]);
    const queue = assignments.filter((a) => a.latestSubmissionId && (a.status === 'submitted' || a.status === 'evaluated'));

    return (
      <>
        <PageHeader title={k.title} actions={<a className={s.linkBtn} href="/learning/assignments">{k.assignments}</a>} />
        <Flash ok={sp.ok} error={sp.error} />

        <Panel title={k.toReview}>
          {queue.length ? (
            <div className={s.rows}>
              {queue.map((assignment) => (
                <div className={s.row} key={assignment.id}>
                  <div className={s.rowMain}>
                    <a className={s.rowTitle} href={submissionHref(assignment.id, assignment.latestSubmissionId!)}>{assignment.title}</a>
                    <span className={s.rowMeta}>{k.latestRevision(assignment.submissions)}</span>
                  </div>
                  <Chip t={t} status={assignment.status} />
                </div>
              ))}
            </div>
          ) : <Empty title={k.nothingWaiting} />}
        </Panel>

        <Panel title={k.recent}>
          <form method="get" className={s.inlineForm}>
            <label className={s.field}>{t.lf.status}
              <select name="status" defaultValue={status ?? ''}>
                <option value="">{t.learnAssignments.allStatuses}</option>
                {EVALUATION_STATUSES.map((state) => <option key={state} value={state}>{statusView(state, t).label}</option>)}
              </select>
            </label>
            <button type="submit">{t.common.filter}</button>
          </form>
          {evaluations.length ? (
            <div className={`${s.rows} ${s.sectionSpace}`}>
              {evaluations.map((ev) => (
                <div className={s.row} key={ev.id}>
                  <div className={s.rowMain}>
                    <a className={s.rowTitle} href={`/learning/evaluations/${ev.id}`}>{ev.assignmentTitle}</a>
                    <div className={s.rowMeta}>
                      <span>{k.revision(ev.revision)}</span>
                      <time dateTime={ev.createdAt}>{ev.createdAt.slice(0, 10)}</time>
                      {ev.totalScore !== null && <span>{ev.totalScore} / {ev.maxScore}</span>}
                      {ev.confidence !== null && <span>{k.confidence(Math.round(ev.confidence * 100))}</span>}
                    </div>
                  </div>
                  <div className={s.chips}>
                    <Chip tone={ev.evaluatorType === 'ai' ? 'info' : 'accent'}>{ev.evaluatorType === 'ai' ? t.learn.parts.aiOpinion : k.owner}</Chip>
                    <Chip t={t} status={ev.status === 'completed' ? ev.outcome : ev.status} />
                  </div>
                </div>
              ))}
            </div>
          ) : <div className={s.sectionSpace}><Empty title={k.noMatch} /></div>}
        </Panel>
      </>
    );
  } catch (error) {
    return <Unavailable t={t} what={t.learn.serviceWhat} reason={errorText(error, t)} />;
  }
}
