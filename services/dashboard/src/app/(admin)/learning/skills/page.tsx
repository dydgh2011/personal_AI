import { GapForm, GapList } from '@/components/learning/gaps';
import { Chip, Empty, LearningPostFields, LevelScale, PageHeader, Panel } from '@/components/learning/parts';
import s from '@/components/learning/learning.module.css';
import { errorText, Flash, Unavailable } from '@/components/ui';
import { learning } from '@/lib/learning';
import { GAP_STATUSES } from '@/lib/learning-types';
import { ageText, statusView, type LearningSearchParams } from '@/lib/learning-view';
import { requireSession } from '@/lib/server';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

export default async function SkillsPage({ searchParams }: { searchParams: LearningSearchParams }) {
  const [sp, session, t] = await Promise.all([searchParams, requireSession(), getT()]);
  const k = t.learnSkills;
  const status = GAP_STATUSES.find((state) => state === sp.status);
  const here = status ? `/learning/skills?status=${status}` : '/learning/skills';

  try {
    const [{ items: skills }, gaps] = await Promise.all([learning.skills(), learning.gaps({ status })]);

    return (
      <>
        <PageHeader title={k.title} actions={<a className={s.linkBtn} href="#skill-gaps">{k.viewGaps}</a>} />
        <Flash ok={sp.ok} error={sp.error} />
        <div className={s.split}>
          <Panel title={k.profile}>
            {skills.length ? (
              <div className={s.rows}>
                {skills.map((skill) => (
                  <div className={s.row} key={skill.id}>
                    <div className={s.rowMain}>
                      <a className={s.rowTitle} href={`/learning/skills/${skill.id}`}>{skill.displayName}</a>
                      <LevelScale t={t} mastery={skill.mastery} />
                      {skill.mastery.verified && (
                        <a className={s.hint} href={`/learning/evaluations/${skill.mastery.verified.evaluationId}`}>
                          {k.verifiedAgo(ageText(skill.mastery.verified.ageDays, t))}
                        </a>
                      )}
                    </div>
                    {skill.openGaps > 0 && <Chip tone="warn">{k.openGaps(skill.openGaps)}</Chip>}
                  </div>
                ))}
              </div>
            ) : <Empty title={k.none}>{k.noneBody}</Empty>}

            <form method="post" action="/api/learning/skills/create" className={`${s.form} ${s.sectionSpace}`}>
              <LearningPostFields csrf={session.csrf} returnTo={here} />
              <label className={s.field}>{k.newSkill}<input name="name" maxLength={100} required /></label>
              <div className={s.formActions}><button type="submit" className="primary">{k.addSkill}</button></div>
            </form>
          </Panel>

          <div className={s.stack}>
            <Panel title={k.gaps} id="skill-gaps">
              <form method="get" action="/learning/skills#skill-gaps" className={s.inlineForm}>
                <label className={s.field}>{t.lf.status}
                  <select name="status" defaultValue={status ?? ''}>
                    <option value="">{k.openAndSuggested}</option>
                    {GAP_STATUSES.map((state) => <option key={state} value={state}>{statusView(state, t).label}</option>)}
                  </select>
                </label>
                <button type="submit">{t.common.filter}</button>
              </form>
              <div className={s.sectionSpace}>
                <GapList t={t} gaps={gaps} csrf={session.csrf} returnTo={here} skills={skills} />
              </div>
            </Panel>

            <Panel title={k.recordGap}>
              <GapForm t={t} csrf={session.csrf} returnTo={here} skills={skills} />
            </Panel>
          </div>
        </div>
      </>
    );
  } catch (error) {
    return <Unavailable t={t} what={t.learn.serviceWhat} reason={errorText(error, t)} />;
  }
}
