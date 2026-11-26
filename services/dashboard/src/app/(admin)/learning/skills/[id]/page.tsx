import { notFound } from 'next/navigation';
import { GapForm, GapList } from '@/components/learning/gaps';
import { Chip, Empty, LearningPostFields, LevelField, LevelScale, PageHeader, Panel } from '@/components/learning/parts';
import s from '@/components/learning/learning.module.css';
import { errorText, Flash, Unavailable } from '@/components/ui';
import { learning, LearningError } from '@/lib/learning';
import { LEARNING_UUID, levelLabel, type LearningSearchParams } from '@/lib/learning-view';
import { requireSession } from '@/lib/server';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

export default async function SkillPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: LearningSearchParams;
}) {
  const [{ id }, sp, session, t] = await Promise.all([params, searchParams, requireSession(), getT()]);
  const k = t.learnSkills;
  if (!LEARNING_UUID.test(id)) notFound();

  try {
    const { skill, history, gaps, milestones, freshDays } = await learning.skill(id);
    const { self, verified } = skill.mastery;
    const here = `/learning/skills/${id}`;

    return (
      <>
        <PageHeader title={skill.displayName} crumbsLabel={t.common.breadcrumb} crumbs={[{ href: '/learning/skills', label: k.title }]} />
        <Flash ok={sp.ok} error={sp.error} />

        <div className={s.split}>
          <div className={s.stack}>
            <Panel title={k.mastery} note={k.freshNote(freshDays)}>
              <LevelScale t={t} mastery={skill.mastery} />
              <div className={`${s.masteryColumns} ${s.sectionSpace}`}>
                <div className={s.stackSmall}>
                  {self && (
                    <>
                      <span className={s.hint}>{k.rated} <time dateTime={self.at}>{self.at.slice(0, 10)}</time></span>
                      {self.note && <p className={s.prose}>{self.note}</p>}
                    </>
                  )}
                </div>
                <div className={s.stackSmall}>
                  {verified && (
                    <>
                      <span className={s.hint}>
                        {k.verified} <time dateTime={verified.at}>{verified.at.slice(0, 10)}</time>
                        {verified.confidence !== null && k.confidence(Math.round(verified.confidence * 100))}
                      </span>
                      <a href={`/learning/evaluations/${verified.evaluationId}`}>{k.supportingEvidence}</a>
                    </>
                  )}
                  <a href="/learning/evaluations?status=completed">{k.verifyFromEvaluation}</a>
                </div>
              </div>
            </Panel>

            <Panel title={k.updateSelf}>
              <form method="post" action={`/api/learning/skills/${id}/self`} className={s.form}>
                <LearningPostFields csrf={session.csrf} returnTo={here} />
                <div className={s.fields}>
                  <LevelField t={t} defaultValue={self?.level} />
                  <label className={s.field}>{k.noteOptional}<textarea name="note" rows={2} maxLength={1000} defaultValue={self?.note ?? ''} /></label>
                </div>
                <div className={s.formActions}><button type="submit" className="primary">{k.saveSelf}</button></div>
              </form>
            </Panel>

            <Panel title={k.history}>
              {history.length ? (
                <div className={s.rows}>
                  {history.map((event) => (
                    <div className={s.row} key={event.id}>
                      <div className={s.rowMain}>
                        <strong className={s.rowTitle}>{event.kind === 'self' ? t.learn.parts.selfAssessment : t.learn.parts.verified} · {levelLabel(event.level, t)}</strong>
                        {event.note && <p className={s.prose}>{event.note}</p>}
                        <div className={s.rowMeta}>
                          <time dateTime={event.at}>{event.at.slice(0, 10)}</time>
                          {event.evaluationId && <a href={`/learning/evaluations/${event.evaluationId}`}>{k.supportingEvaluation}</a>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : <Empty title={k.noHistory} />}
            </Panel>

            <Panel title={k.milestones}>
              {milestones.length ? (
                <div className={s.rows}>
                  {milestones.map((milestone) => (
                    <div className={s.row} key={milestone.id}>
                      <a className={s.rowTitle} href={`/learning/milestones/${milestone.id}`}>{milestone.title}</a>
                      <Chip t={t} status={milestone.status} />
                    </div>
                  ))}
                </div>
              ) : <Empty title={k.noMilestones} />}
            </Panel>
          </div>

          <div className={s.stack}>
            <Panel title={k.gaps} id="skill-gaps">
              <GapList t={t} gaps={gaps} csrf={session.csrf} returnTo={here} />
            </Panel>
            <Panel title={k.recordGap}>
              <GapForm t={t} csrf={session.csrf} returnTo={here} skillId={id} />
            </Panel>
          </div>
        </div>
      </>
    );
  } catch (error) {
    if (error instanceof LearningError && error.status === 404) notFound();
    return <Unavailable t={t} what={t.learn.serviceWhat} reason={errorText(error, t)} />;
  }
}
