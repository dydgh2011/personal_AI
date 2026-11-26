import { Chip, Empty, LearningPostFields } from './parts';
import s from './learning.module.css';
import type { Gap, Skill } from '@/lib/learning-types';
import type { Dict } from '@/i18n';

type GapAction = 'accept' | 'dismiss' | 'addressed' | 'reopen';
const GAP_ACTIONS: Record<Gap['status'], Array<{ status: Gap['status']; label: GapAction }>> = {
  suggested: [{ status: 'open', label: 'accept' }, { status: 'dismissed', label: 'dismiss' }],
  open: [{ status: 'addressed', label: 'addressed' }, { status: 'dismissed', label: 'dismiss' }],
  addressed: [{ status: 'open', label: 'reopen' }],
  dismissed: [{ status: 'open', label: 'reopen' }],
};

export function GapList({ t, gaps, csrf, returnTo, skills }: {
  t: Dict;
  gaps: Gap[];
  csrf: string;
  returnTo: string;
  skills?: Skill[];
}) {
  const g = t.learn.gaps;
  if (!gaps.length) return <Empty title={g.none} />;
  const skillNames = new Map(skills?.map((skill) => [skill.id, skill.displayName]));

  return (
    <div className={s.rows}>
      {gaps.map((gap) => (
        <div className={s.row} id={`gap-${gap.id}`} key={gap.id}>
          <div className={s.rowMain}>
            <strong className={s.rowTitle}>{gap.title}</strong>
            {gap.description && <p className={s.prose}>{gap.description}</p>}
            <div className={s.rowMeta}>
              {gap.skillId && skillNames.has(gap.skillId) && (
                <a href={`/learning/skills/${gap.skillId}`}>{skillNames.get(gap.skillId)}</a>
              )}
              {gap.evaluationId ? (
                <a href={`/learning/evaluations/${gap.evaluationId}`}>{g.sourceEvaluation}</a>
              ) : <span>{g.ownerRecorded}</span>}
              <time dateTime={gap.updatedAt}>{gap.updatedAt.slice(0, 10)}</time>
            </div>
          </div>
          <div className={s.rowSide}>
            <Chip t={t} status={gap.status} />
            <form method="post" action={`/api/learning/gaps/${gap.id}/update`} className={s.inlineForm}>
              <LearningPostFields csrf={csrf} returnTo={returnTo} />
              {GAP_ACTIONS[gap.status].map((action) => (
                <button key={action.status} type="submit" name="status" value={action.status}>{g[action.label]}</button>
              ))}
            </form>
          </div>
        </div>
      ))}
    </div>
  );
}

export function GapForm({ t, csrf, returnTo, skillId, skills }: {
  t: Dict;
  csrf: string;
  returnTo: string;
  skillId?: string;
  skills?: Skill[];
}) {
  const g = t.learn.gaps;
  return (
    <form method="post" action="/api/learning/gaps/create" className={s.form}>
      <LearningPostFields csrf={csrf} returnTo={returnTo} />
      {skillId && <input type="hidden" name="skillId" value={skillId} />}
      <div className={s.fields}>
        <label className={s.field}>{g.title}<input name="title" maxLength={200} required /></label>
        {!skillId && Boolean(skills?.length) && (
          <label className={s.field}>{g.skillOptional}
            <select name="skillId" defaultValue="">
              <option value="">{g.chooseSkill}</option>
              {skills?.map((skill) => <option key={skill.id} value={skill.id}>{skill.displayName}</option>)}
            </select>
          </label>
        )}
        <label className={`${s.field} ${s.fieldWide}`}>{g.whatNeedsWork}<textarea name="description" rows={2} maxLength={2000} /></label>
      </div>
      <div className={s.formActions}><button type="submit" className="primary">{g.add}</button></div>
    </form>
  );
}
