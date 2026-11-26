import type { Dict } from '@/i18n';
import type { AgentInstructions, CommitAuthor, CommitStyle, CommitStyleAnalysis, CommitStyleMode, Project, Task } from './types';
import { parseReport } from './report';

/**
 * Project agent settings form (ROADMAP 11-13). The same limits as the controller, checked here only
 * to give a readable message early; the controller validates again and is the authority.
 */
export const PROJECT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const LIMITS = { authorName: 100, authorEmail: 254, styleGuide: 1000, rules: 4000, forbiddenPaths: 50, forbiddenPath: 200 } as const;

/** Labels and help texts are in the dictionaries (projects.modes). */
export const STYLE_MODES: CommitStyleMode[] = ['off', 'auto', 'manual'];

const TEXT = /^[^\x00-\x08\x0b-\x1f\x7f]*$/;
const AUTHOR_NAME = /^(?=.*\S)[^\x00-\x1f\x7f<>]+$/;
const AUTHOR_EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const PATH_PATTERN = /^(?!\s)(?!.*\s$)(?!\/)(?!\.\/)(?!.*\/\/)(?!(?:.*\/)?\.{1,2}(?:\/|$))[A-Za-z0-9._\-/*?@+~ ]+$/;

export interface SettingsPatch {
  commitAuthor: CommitAuthor | null;
  commitStyle: CommitStyle;
  agentInstructions: AgentInstructions;
}

const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.replace(/\r\n?/g, '\n') : '';
};

/** Form → controller PATCH body, or a message saying what to fix. */
export function parseSettingsForm(form: FormData, t: Dict): { patch: SettingsPatch } | { error: string } {
  const err = t.projects.err;
  const name = field(form, 'authorName').trim();
  const email = field(form, 'authorEmail').trim();
  let commitAuthor: CommitAuthor | null = null;
  if (name || email) {
    if (!name || !email) return { error: err.authorBoth };
    if (name.length > LIMITS.authorName || !AUTHOR_NAME.test(name)) return { error: err.authorName(LIMITS.authorName) };
    if (email.length > LIMITS.authorEmail || !AUTHOR_EMAIL.test(email)) return { error: err.authorEmail };
    commitAuthor = { name, email };
  }

  const mode = field(form, 'styleMode') as CommitStyleMode;
  if (!STYLE_MODES.includes(mode)) return { error: err.chooseMode };
  const guide = field(form, 'styleGuide').trim();
  if (guide.length > LIMITS.styleGuide || !TEXT.test(guide)) return { error: err.guide(LIMITS.styleGuide) };
  if (mode === 'manual' && !guide) return { error: err.manualNeedsGuide };

  const rules = field(form, 'rules').trim();
  if (rules.length > LIMITS.rules || !TEXT.test(rules)) return { error: err.rules(LIMITS.rules) };

  const forbiddenPaths = [...new Set(
    field(form, 'forbiddenPaths').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')),
  )];
  if (forbiddenPaths.length > LIMITS.forbiddenPaths) return { error: err.tooManyPaths(LIMITS.forbiddenPaths) };
  const bad = forbiddenPaths.find((p) => p.length > LIMITS.forbiddenPath || !PATH_PATTERN.test(p));
  if (bad !== undefined) {
    return { error: err.badPath(bad.slice(0, 60)) };
  }

  return { patch: { commitAuthor, commitStyle: { mode, guide: guide || null }, agentInstructions: { rules, forbiddenPaths } } };
}

/** Which settings a patch changes (names only: the audit log never holds the values). */
export function changedSettings(project: Project, patch: SettingsPatch): string[] {
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const changed: string[] = [];
  if (!same(project.commitAuthor, patch.commitAuthor)) changed.push('commitAuthor');
  if (!same(project.commitStyle ?? { mode: 'off', guide: null }, patch.commitStyle)) changed.push('commitStyle');
  if (!same(project.agentInstructions?.rules ?? '', patch.agentInstructions.rules)) changed.push('rules');
  if (!same(project.agentInstructions?.forbiddenPaths ?? [], patch.agentInstructions.forbiddenPaths)) changed.push('forbiddenPaths');
  return changed;
}

/** The newest worker report of this project that carries a commit-style analysis. */
export function latestStyleAnalysis(tasks: Task[]): { taskId: string; at: string; analysis: CommitStyleAnalysis } | null {
  for (const task of tasks) {
    const analysis = (parseReport(task.result) ?? parseReport(task.error))?.workspace?.commitStyle;
    if (analysis && typeof analysis.guide === 'string') return { taskId: task.id, at: task.completedAt ?? task.createdAt, analysis };
  }
  return null;
}

/** One-word summary for the project list. */
export function settingsSummary(p: Project, t: Dict): string {
  const x = t.projects.summary;
  const parts: string[] = [];
  if (p.commitStyle && p.commitStyle.mode !== 'off') parts.push(x.style(p.commitStyle.mode));
  if (p.agentInstructions?.rules) parts.push(x.rules);
  if (p.agentInstructions?.forbiddenPaths.length) parts.push(x.forbidden(p.agentInstructions.forbiddenPaths.length));
  if (p.commitAuthor) parts.push(x.author);
  return parts.join(' · ') || '-';
}
