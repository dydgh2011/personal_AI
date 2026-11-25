import { Chip, Empty, PageHeader, Panel } from '@/components/learning/parts';
import s from '@/components/learning/learning.module.css';
import { errorText, Flash, Unavailable } from '@/components/ui';
import { learning } from '@/lib/learning';
import { EVALUATION_STATUSES } from '@/lib/learning-types';
import { statusView, submissionHref, type LearningSearchParams } from '@/lib/learning-view';
import { requireSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

export default async function EvaluationsPage({ searchParams }: { searchParams: LearningSearchParams }) {
  const [sp] = await Promise.all([searchParams, requireSession()]);
  const status = EVALUATION_STATUSES.find((state) => state === sp.status);

  try {
    const [{ items: evaluations }, { items: assignments }] = await Promise.all([
      learning.evaluations({ status }),
      learning.assignments(),
    ]);
    const queue = assignments.filter((a) => a.latestSubmissionId && (a.status === 'submitted' || a.status === 'evaluated'));

    return (
      <>
        <PageHeader title="Evaluations" actions={<a className={s.linkBtn} href="/learning/assignments">Assignments</a>} />
        <Flash ok={sp.ok} error={sp.error} />

        <Panel title="Submissions to review">
          {queue.length ? (
            <div className={s.rows}>
              {queue.map((assignment) => (
                <div className={s.row} key={assignment.id}>
                  <div className={s.rowMain}>
                    <a className={s.rowTitle} href={submissionHref(assignment.id, assignment.latestSubmissionId!)}>{assignment.title}</a>
                    <span className={s.rowMeta}>Latest submission · revision {assignment.submissions}</span>
                  </div>
                  <Chip status={assignment.status} />
                </div>
              ))}
            </div>
          ) : <Empty title="Nothing waiting for review" />}
        </Panel>

        <Panel title="Recent evaluations">
          <form method="get" className={s.inlineForm}>
            <label className={s.field}>Status
              <select name="status" defaultValue={status ?? ''}>
                <option value="">All statuses</option>
                {EVALUATION_STATUSES.map((state) => <option key={state} value={state}>{statusView(state).label}</option>)}
              </select>
            </label>
            <button type="submit">Filter</button>
          </form>
          {evaluations.length ? (
            <div className={`${s.rows} ${s.sectionSpace}`}>
              {evaluations.map((ev) => (
                <div className={s.row} key={ev.id}>
                  <div className={s.rowMain}>
                    <a className={s.rowTitle} href={`/learning/evaluations/${ev.id}`}>{ev.assignmentTitle}</a>
                    <div className={s.rowMeta}>
                      <span>Revision {ev.revision}</span>
                      <time dateTime={ev.createdAt}>{ev.createdAt.slice(0, 10)}</time>
                      {ev.totalScore !== null && <span>{ev.totalScore} / {ev.maxScore}</span>}
                      {ev.confidence !== null && <span>{Math.round(ev.confidence * 100)}% confidence</span>}
                    </div>
                  </div>
                  <div className={s.chips}>
                    <Chip tone={ev.evaluatorType === 'ai' ? 'info' : 'accent'}>{ev.evaluatorType === 'ai' ? 'AI opinion' : 'Owner'}</Chip>
                    <Chip status={ev.status === 'completed' ? ev.outcome : ev.status} />
                  </div>
                </div>
              ))}
            </div>
          ) : <div className={s.sectionSpace}><Empty title="No matching evaluations" /></div>}
        </Panel>
      </>
    );
  } catch (error) {
    return <Unavailable what="Learning service" reason={errorText(error)} />;
  }
}
