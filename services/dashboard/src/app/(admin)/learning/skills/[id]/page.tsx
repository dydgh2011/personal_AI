import { notFound } from 'next/navigation';
import { GapForm, GapList } from '@/components/learning/gaps';
import { Chip, Empty, LearningPostFields, LevelField, LevelScale, PageHeader, Panel } from '@/components/learning/parts';
import s from '@/components/learning/learning.module.css';
import { errorText, Flash, Unavailable } from '@/components/ui';
import { learning, LearningError } from '@/lib/learning';
import { LEARNING_UUID, levelLabel, type LearningSearchParams } from '@/lib/learning-view';
import { requireSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

export default async function SkillPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: LearningSearchParams;
}) {
  const [{ id }, sp, session] = await Promise.all([params, searchParams, requireSession()]);
  if (!LEARNING_UUID.test(id)) notFound();

  try {
    const { skill, history, gaps, milestones, freshDays } = await learning.skill(id);
    const { self, verified } = skill.mastery;
    const here = `/learning/skills/${id}`;

    return (
      <>
        <PageHeader title={skill.displayName} crumbs={[{ href: '/learning/skills', label: 'Skills & gaps' }]} />
        <Flash ok={sp.ok} error={sp.error} />

        <div className={s.split}>
          <div className={s.stack}>
            <Panel title="Mastery" note={`Verification is due for review after ${freshDays} days.`}>
              <LevelScale mastery={skill.mastery} />
              <div className={`${s.masteryColumns} ${s.sectionSpace}`}>
                <div className={s.stackSmall}>
                  {self && (
                    <>
                      <span className={s.hint}>Rated <time dateTime={self.at}>{self.at.slice(0, 10)}</time></span>
                      {self.note && <p className={s.prose}>{self.note}</p>}
                    </>
                  )}
                </div>
                <div className={s.stackSmall}>
                  {verified && (
                    <>
                      <span className={s.hint}>
                        Verified <time dateTime={verified.at}>{verified.at.slice(0, 10)}</time>
                        {verified.confidence !== null && ` · ${Math.round(verified.confidence * 100)}% confidence`}
                      </span>
                      <a href={`/learning/evaluations/${verified.evaluationId}`}>View supporting evidence</a>
                    </>
                  )}
                  <a href="/learning/evaluations?status=completed">Verify from a completed evaluation</a>
                </div>
              </div>
            </Panel>

            <Panel title="Update self-assessment">
              <form method="post" action={`/api/learning/skills/${id}/self`} className={s.form}>
                <LearningPostFields csrf={session.csrf} returnTo={here} />
                <div className={s.fields}>
                  <LevelField defaultValue={self?.level} />
                  <label className={s.field}>Note (optional)<textarea name="note" rows={2} maxLength={1000} defaultValue={self?.note ?? ''} /></label>
                </div>
                <div className={s.formActions}><button type="submit" className="primary">Save self-assessment</button></div>
              </form>
            </Panel>

            <Panel title="Mastery history">
              {history.length ? (
                <div className={s.rows}>
                  {history.map((event) => (
                    <div className={s.row} key={event.id}>
                      <div className={s.rowMain}>
                        <strong className={s.rowTitle}>{event.kind === 'self' ? 'Self-assessment' : 'Verified'} · {levelLabel(event.level)}</strong>
                        {event.note && <p className={s.prose}>{event.note}</p>}
                        <div className={s.rowMeta}>
                          <time dateTime={event.at}>{event.at.slice(0, 10)}</time>
                          {event.evaluationId && <a href={`/learning/evaluations/${event.evaluationId}`}>Supporting evaluation</a>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : <Empty title="No mastery history yet" />}
            </Panel>

            <Panel title="Milestones for this skill">
              {milestones.length ? (
                <div className={s.rows}>
                  {milestones.map((milestone) => (
                    <div className={s.row} key={milestone.id}>
                      <a className={s.rowTitle} href={`/learning/milestones/${milestone.id}`}>{milestone.title}</a>
                      <Chip status={milestone.status} />
                    </div>
                  ))}
                </div>
              ) : <Empty title="No linked milestones" />}
            </Panel>
          </div>

          <div className={s.stack}>
            <Panel title="Gaps" id="skill-gaps">
              <GapList gaps={gaps} csrf={session.csrf} returnTo={here} />
            </Panel>
            <Panel title="Record a gap">
              <GapForm csrf={session.csrf} returnTo={here} skillId={id} />
            </Panel>
          </div>
        </div>
      </>
    );
  } catch (error) {
    if (error instanceof LearningError && error.status === 404) notFound();
    return <Unavailable what="Learning service" reason={errorText(error)} />;
  }
}
