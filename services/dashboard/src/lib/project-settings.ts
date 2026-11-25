import type { AgentInstructions, CommitAuthor, CommitStyle, CommitStyleAnalysis, CommitStyleMode, Project, Task } from './types';
import { parseReport } from './report';

/**
 * Project agent settings form (ROADMAP 11-13). The same limits as the controller, checked here only
 * to give a readable message early; the controller validates again and is the authority.
 */
export const PROJECT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export const LIMITS = { authorName: 100, authorEmail: 254, styleGuide: 1000, rules: 4000, forbiddenPaths: 50, forbiddenPath: 200 } as const;

export const STYLE_MODES: Array<{ value: CommitStyleMode; label: string; help: string }> = [
  { value: 'off', label: 'Off', help: 'Workers use their fixed commit message (no change).' },
  { value: 'auto', label: 'Auto (from history)', help: 'The worker reads recent commit subjects of the project (read-only) and asks the agent to match them.' },
  { value: 'manual', label: 'Manual', help: 'The agent follows the guide you write below.' },
];

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
export function parseSettingsForm(form: FormData): { patch: SettingsPatch } | { error: string } {
  const name = field(form, 'authorName').trim();
  const email = field(form, 'authorEmail').trim();
  let commitAuthor: CommitAuthor | null = null;
  if (name || email) {
    if (!name || !email) return { error: 'Commit author needs both a name and an e-mail (or leave both empty).' };
    if (name.length > LIMITS.authorName || !AUTHOR_NAME.test(name)) return { error: `Author name: one line, at most ${LIMITS.authorName} characters, no < or >.` };
    if (email.length > LIMITS.authorEmail || !AUTHOR_EMAIL.test(email)) return { error: 'Author e-mail is not a valid address.' };
    commitAuthor = { name, email };
  }

  const mode = field(form, 'styleMode') as CommitStyleMode;
  if (!STYLE_MODES.some((m) => m.value === mode)) return { error: 'Choose a commit style mode.' };
  const guide = field(form, 'styleGuide').trim();
  if (guide.length > LIMITS.styleGuide || !TEXT.test(guide)) return { error: `Commit style guide: at most ${LIMITS.styleGuide} characters, no control characters.` };
  if (mode === 'manual' && !guide) return { error: 'Manual commit style needs a guide.' };

  const rules = field(form, 'rules').trim();
  if (rules.length > LIMITS.rules || !TEXT.test(rules)) return { error: `Coding rules: at most ${LIMITS.rules} characters, no control characters.` };

  const forbiddenPaths = [...new Set(
    field(form, 'forbiddenPaths').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')),
  )];
  if (forbiddenPaths.length > LIMITS.forbiddenPaths) return { error: `At most ${LIMITS.forbiddenPaths} forbidden paths.` };
  const bad = forbiddenPaths.find((p) => p.length > LIMITS.forbiddenPath || !PATH_PATTERN.test(p));
  if (bad !== undefined) {
    return { error: `Forbidden path "${bad.slice(0, 60)}" is not a relative path pattern (no leading "/", no "." or ".." parts, no backslashes).` };
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
export function settingsSummary(p: Project): string {
  const parts: string[] = [];
  if (p.commitStyle && p.commitStyle.mode !== 'off') parts.push(`style ${p.commitStyle.mode}`);
  if (p.agentInstructions?.rules) parts.push('rules');
  if (p.agentInstructions?.forbiddenPaths.length) parts.push(`${p.agentInstructions.forbiddenPaths.length} forbidden`);
  if (p.commitAuthor) parts.push('author (stored)');
  return parts.join(' · ') || '-';
}
