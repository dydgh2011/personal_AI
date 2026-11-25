import { Chip, Empty, PageHeader, Panel } from '@/components/learning/parts';
import s from '@/components/learning/learning.module.css';
import { errorText, Flash, Unavailable } from '@/components/ui';
import { learning } from '@/lib/learning';
import { ASSIGNMENT_STATUSES } from '@/lib/learning-types';
import { statusView, type LearningSearchParams } from '@/lib/learning-view';
import { requireSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

export default async function AssignmentsPage({ searchParams }: { searchParams: LearningSearchParams }) {
  const [sp] = await Promise.all([searchParams, requireSession()]);
  const status = ASSIGNMENT_STATUSES.find((state) => state === sp.status);
  try {
    const [{ items }, { items: milestones }] = await Promise.all([
      learning.assignments({ status }),
      learning.milestones(),
    ]);
    const milestoneTitles = new Map(milestones.map((m) => [m.id, m.title]));

    return (
      <>
        <PageHeader title="Assignments" crumbs={[{ href: '/learning/milestones', label: 'Milestones' }]} />
        <Flash ok={sp.ok} error={sp.error} />
        <Panel title="Assignments by status">
          <form method="get" className={s.inlineForm}>
            <label className={s.field}>Status
              <select name="status" defaultValue={status ?? ''}>
                <option value="">All statuses</option>
                {ASSIGNMENT_STATUSES.map((state) => <option key={state} value={state}>{statusView(state).label}</option>)}
              </select>
            </label>
            <button type="submit">Filter</button>
          </form>
          {items.length ? (
            <div className={`${s.rows} ${s.sectionSpace}`}>
              {items.map((assignment) => (
                <div className={s.row} key={assignment.id}>
                  <div className={s.rowMain}>
                    <a className={s.rowTitle} href={`/learning/assignments/${assignment.id}`}>{assignment.title}</a>
                    <div className={s.rowMeta}>
                      <a href={`/learning/milestones/${assignment.milestoneId}`}>{milestoneTitles.get(assignment.milestoneId) ?? 'Milestone'}</a>
                      <span>{assignment.kind}</span>
                      <span>{assignment.submissions} submission(s)</span>
                    </div>
                  </div>
                  <Chip status={assignment.status} />
                </div>
              ))}
            </div>
          ) : (
            <div className={s.sectionSpace}><Empty title="No matching assignments"><a href="/learning/milestones">Manage assignments from their milestones</a></Empty></div>
          )}
        </Panel>
      </>
    );
  } catch (error) {
    return <Unavailable what="Learning service" reason={errorText(error)} />;
  }
}
