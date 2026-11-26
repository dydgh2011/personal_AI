import { Chip, Empty, PageHeader, Panel } from '@/components/learning/parts';
import s from '@/components/learning/learning.module.css';
import { errorText, Flash, Unavailable } from '@/components/ui';
import { learning } from '@/lib/learning';
import { ASSIGNMENT_STATUSES } from '@/lib/learning-types';
import { statusView, type LearningSearchParams } from '@/lib/learning-view';
import { requireSession } from '@/lib/server';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

export default async function AssignmentsPage({ searchParams }: { searchParams: LearningSearchParams }) {
  const [sp, , t] = await Promise.all([searchParams, requireSession(), getT()]);
  const k = t.learnAssignments;
  const status = ASSIGNMENT_STATUSES.find((state) => state === sp.status);
  try {
    const [{ items }, { items: milestones }] = await Promise.all([
      learning.assignments({ status }),
      learning.milestones(),
    ]);
    const milestoneTitles = new Map(milestones.map((m) => [m.id, m.title]));

    return (
      <>
        <PageHeader title={k.title} crumbsLabel={t.common.breadcrumb} crumbs={[{ href: '/learning/milestones', label: t.learnMilestones.title }]} />
        <Flash ok={sp.ok} error={sp.error} />
        <Panel title={k.byStatus}>
          <form method="get" className={s.inlineForm}>
            <label className={s.field}>{t.lf.status}
              <select name="status" defaultValue={status ?? ''}>
                <option value="">{k.allStatuses}</option>
                {ASSIGNMENT_STATUSES.map((state) => <option key={state} value={state}>{statusView(state, t).label}</option>)}
              </select>
            </label>
            <button type="submit">{t.common.filter}</button>
          </form>
          {items.length ? (
            <div className={`${s.rows} ${s.sectionSpace}`}>
              {items.map((assignment) => (
                <div className={s.row} key={assignment.id}>
                  <div className={s.rowMain}>
                    <a className={s.rowTitle} href={`/learning/assignments/${assignment.id}`}>{assignment.title}</a>
                    <div className={s.rowMeta}>
                      <a href={`/learning/milestones/${assignment.milestoneId}`}>{milestoneTitles.get(assignment.milestoneId) ?? k.milestone}</a>
                      <span>{t.lf.kindName[assignment.kind] ?? assignment.kind}</span>
                      <span>{k.submissions(assignment.submissions)}</span>
                    </div>
                  </div>
                  <Chip t={t} status={assignment.status} />
                </div>
              ))}
            </div>
          ) : (
            <div className={s.sectionSpace}><Empty title={k.noMatch}><a href="/learning/milestones">{k.manageFromMilestones}</a></Empty></div>
          )}
        </Panel>
      </>
    );
  } catch (error) {
    return <Unavailable t={t} what={t.learn.serviceWhat} reason={errorText(error, t)} />;
  }
}
