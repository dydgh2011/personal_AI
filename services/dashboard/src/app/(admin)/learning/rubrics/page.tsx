import { RubricCriteriaFields } from '@/components/learning/client';
import { Chip, Empty, LearningPostFields, PageHeader, Panel } from '@/components/learning/parts';
import s from '@/components/learning/learning.module.css';
import { errorText, Flash, Unavailable } from '@/components/ui';
import { learning } from '@/lib/learning';
import type { LearningSearchParams } from '@/lib/learning-view';
import { requireSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

export default async function RubricsPage({ searchParams }: { searchParams: LearningSearchParams }) {
  const [sp, session] = await Promise.all([searchParams, requireSession()]);
  try {
    const rubrics = await learning.rubrics();

    return (
      <>
        <PageHeader title="Rubrics" crumbs={[{ href: '/learning/milestones', label: 'Milestones' }]} />
        <Flash ok={sp.ok} error={sp.error} />
        <div className={s.cols2}>
          <Panel title="Rubric library">
            {rubrics.length ? (
              <div className={s.rows}>
                {rubrics.map((rubric) => (
                  <div className={s.row} key={rubric.id}>
                    <div className={s.rowMain}>
                      <a className={s.rowTitle} href={`/learning/rubrics/${rubric.id}`}>{rubric.title}</a>
                      {rubric.latestVersion && (
                        <div className={s.rowMeta}>
                          <span>Version {rubric.latestVersion.version}</span>
                          <span>Pass at {rubric.latestVersion.passingScore} / {rubric.latestVersion.maxScore}</span>
                        </div>
                      )}
                    </div>
                    <Chip status={rubric.status} />
                  </div>
                ))}
              </div>
            ) : <Empty title="No rubrics yet" />}
          </Panel>

          <Panel title="Create a rubric">
            <form method="post" action="/api/learning/rubrics/create" className={s.form}>
              <LearningPostFields csrf={session.csrf} returnTo="/learning/rubrics" />
              <label className={s.field}>Title<input name="title" required maxLength={200} /></label>
              <RubricCriteriaFields />
              <label className={s.field}>Passing score<input type="number" name="passingScore" required min={0} step={0.01} /></label>
              <div className={s.formActions}><button type="submit" className="primary">Save rubric</button></div>
            </form>
          </Panel>
        </div>
      </>
    );
  } catch (error) {
    return <Unavailable what="Learning service" reason={errorText(error)} />;
  }
}
