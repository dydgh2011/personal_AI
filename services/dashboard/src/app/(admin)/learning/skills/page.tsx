import { GapForm, GapList } from '@/components/learning/gaps';
import { Chip, Empty, LearningPostFields, LevelScale, PageHeader, Panel } from '@/components/learning/parts';
import s from '@/components/learning/learning.module.css';
import { errorText, Flash, Unavailable } from '@/components/ui';
import { learning } from '@/lib/learning';
import { GAP_STATUSES } from '@/lib/learning-types';
import { ageText, statusView, type LearningSearchParams } from '@/lib/learning-view';
import { requireSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

export default async function SkillsPage({ searchParams }: { searchParams: LearningSearchParams }) {
  const [sp, session] = await Promise.all([searchParams, requireSession()]);
  const status = GAP_STATUSES.find((state) => state === sp.status);
  const here = status ? `/learning/skills?status=${status}` : '/learning/skills';

  try {
    const [{ items: skills }, gaps] = await Promise.all([learning.skills(), learning.gaps({ status })]);

    return (
      <>
        <PageHeader title="Skills & gaps" actions={<a className={s.linkBtn} href="#skill-gaps">View gaps</a>} />
        <Flash ok={sp.ok} error={sp.error} />
        <div className={s.split}>
          <Panel title="Skill profile">
            {skills.length ? (
              <div className={s.rows}>
                {skills.map((skill) => (
                  <div className={s.row} key={skill.id}>
                    <div className={s.rowMain}>
                      <a className={s.rowTitle} href={`/learning/skills/${skill.id}`}>{skill.displayName}</a>
                      <LevelScale mastery={skill.mastery} />
                      {skill.mastery.verified && (
                        <a className={s.hint} href={`/learning/evaluations/${skill.mastery.verified.evaluationId}`}>
                          Verified {ageText(skill.mastery.verified.ageDays)} · View evidence
                        </a>
                      )}
                    </div>
                    {skill.openGaps > 0 && <Chip tone="warn">{skill.openGaps} open gap(s)</Chip>}
                  </div>
                ))}
              </div>
            ) : <Empty title="No skills yet">Add a skill to start tracking mastery.</Empty>}

            <form method="post" action="/api/learning/skills/create" className={`${s.form} ${s.sectionSpace}`}>
              <LearningPostFields csrf={session.csrf} returnTo={here} />
              <label className={s.field}>New skill<input name="name" maxLength={100} required /></label>
              <div className={s.formActions}><button type="submit" className="primary">Add skill</button></div>
            </form>
          </Panel>

          <div className={s.stack}>
            <Panel title="Gaps" id="skill-gaps">
              <form method="get" action="/learning/skills#skill-gaps" className={s.inlineForm}>
                <label className={s.field}>Status
                  <select name="status" defaultValue={status ?? ''}>
                    <option value="">Open and suggested</option>
                    {GAP_STATUSES.map((state) => <option key={state} value={state}>{statusView(state).label}</option>)}
                  </select>
                </label>
                <button type="submit">Filter</button>
              </form>
              <div className={s.sectionSpace}>
                <GapList gaps={gaps} csrf={session.csrf} returnTo={here} skills={skills} />
              </div>
            </Panel>

            <Panel title="Record a gap">
              <GapForm csrf={session.csrf} returnTo={here} skills={skills} />
            </Panel>
          </div>
        </div>
      </>
    );
  } catch (error) {
    return <Unavailable what="Learning service" reason={errorText(error)} />;
  }
}
