import { Chip, Empty, LearningPostFields } from './parts';
import s from './learning.module.css';
import type { Gap, Skill } from '@/lib/learning-types';

const GAP_ACTIONS: Record<Gap['status'], Array<{ status: Gap['status']; label: string }>> = {
  suggested: [{ status: 'open', label: 'Accept' }, { status: 'dismissed', label: 'Dismiss' }],
  open: [{ status: 'addressed', label: 'Mark addressed' }, { status: 'dismissed', label: 'Dismiss' }],
  addressed: [{ status: 'open', label: 'Reopen' }],
  dismissed: [{ status: 'open', label: 'Reopen' }],
};

export function GapList({ gaps, csrf, returnTo, skills }: {
  gaps: Gap[];
  csrf: string;
  returnTo: string;
  skills?: Skill[];
}) {
  if (!gaps.length) return <Empty title="No gaps to show" />;
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
                <a href={`/learning/evaluations/${gap.evaluationId}`}>Source evaluation</a>
              ) : <span>Owner recorded</span>}
              <time dateTime={gap.updatedAt}>{gap.updatedAt.slice(0, 10)}</time>
            </div>
          </div>
          <div className={s.rowSide}>
            <Chip status={gap.status} />
            <form method="post" action={`/api/learning/gaps/${gap.id}/update`} className={s.inlineForm}>
              <LearningPostFields csrf={csrf} returnTo={returnTo} />
              {GAP_ACTIONS[gap.status].map((action) => (
                <button key={action.status} type="submit" name="status" value={action.status}>{action.label}</button>
              ))}
            </form>
          </div>
        </div>
      ))}
    </div>
  );
}

export function GapForm({ csrf, returnTo, skillId, skills }: {
  csrf: string;
  returnTo: string;
  skillId?: string;
  skills?: Skill[];
}) {
  return (
    <form method="post" action="/api/learning/gaps/create" className={s.form}>
      <LearningPostFields csrf={csrf} returnTo={returnTo} />
      {skillId && <input type="hidden" name="skillId" value={skillId} />}
      <div className={s.fields}>
        <label className={s.field}>Title<input name="title" maxLength={200} required /></label>
        {!skillId && Boolean(skills?.length) && (
          <label className={s.field}>Skill (optional)
            <select name="skillId" defaultValue="">
              <option value="">Choose a skill</option>
              {skills?.map((skill) => <option key={skill.id} value={skill.id}>{skill.displayName}</option>)}
            </select>
          </label>
        )}
        <label className={`${s.field} ${s.fieldWide}`}>What needs work?<textarea name="description" rows={2} maxLength={2000} /></label>
      </div>
      <div className={s.formActions}><button type="submit" className="primary">Add gap</button></div>
    </form>
  );
}
