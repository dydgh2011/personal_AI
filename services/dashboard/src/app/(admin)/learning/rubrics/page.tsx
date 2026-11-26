import { RubricCriteriaFields } from '@/components/learning/client';
import { Chip, Empty, LearningPostFields, PageHeader, Panel } from '@/components/learning/parts';
import s from '@/components/learning/learning.module.css';
import { errorText, Flash, Unavailable } from '@/components/ui';
import { learning } from '@/lib/learning';
import type { LearningSearchParams } from '@/lib/learning-view';
import { requireSession } from '@/lib/server';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

export default async function RubricsPage({ searchParams }: { searchParams: LearningSearchParams }) {
  const [sp, session, t] = await Promise.all([searchParams, requireSession(), getT()]);
  const k = t.learnRubrics;
  try {
    const rubrics = await learning.rubrics();

    return (
      <>
        <PageHeader title={k.title} crumbsLabel={t.common.breadcrumb} crumbs={[{ href: '/learning/milestones', label: t.learnMilestones.title }]} />
        <Flash ok={sp.ok} error={sp.error} />
        <div className={s.cols2}>
          <Panel title={k.library}>
            {rubrics.length ? (
              <div className={s.rows}>
                {rubrics.map((rubric) => (
                  <div className={s.row} key={rubric.id}>
                    <div className={s.rowMain}>
                      <a className={s.rowTitle} href={`/learning/rubrics/${rubric.id}`}>{rubric.title}</a>
                      {rubric.latestVersion && (
                        <div className={s.rowMeta}>
                          <span>{k.version(rubric.latestVersion.version)}</span>
                          <span>{k.passAt(rubric.latestVersion.passingScore, rubric.latestVersion.maxScore)}</span>
                        </div>
                      )}
                    </div>
                    <Chip t={t} status={rubric.status} />
                  </div>
                ))}
              </div>
            ) : <Empty title={k.none} />}
          </Panel>

          <Panel title={k.create}>
            <form method="post" action="/api/learning/rubrics/create" className={s.form}>
              <LearningPostFields csrf={session.csrf} returnTo="/learning/rubrics" />
              <label className={s.field}>{t.lf.title}<input name="title" required maxLength={200} /></label>
              <RubricCriteriaFields />
              <label className={s.field}>{k.passingScore}<input type="number" name="passingScore" required min={0} step={0.01} /></label>
              <div className={s.formActions}><button type="submit" className="primary">{k.save}</button></div>
            </form>
          </Panel>
        </div>
      </>
    );
  } catch (error) {
    return <Unavailable t={t} what={t.learn.serviceWhat} reason={errorText(error, t)} />;
  }
}
