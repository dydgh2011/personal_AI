/**
 * Default model and reasoning effort per coding worker (owner request 2026-11-25). Same rules as the
 * controller's tasks/run-settings.ts, checked here only to give a readable message early; the
 * controller validates again and is the authority.
 */
export const AGENTS = ['claude', 'codex'] as const;
export type Agent = (typeof AGENTS)[number];
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,79}$/;

/** Example names shown next to the model field (the CLI decides what exists). */
export const MODEL_HINTS: Record<Agent, string> = {
  claude: 'opus, sonnet, fable, claude-opus-5-5',
  codex: 'gpt-6.1-sol, gpt-6-sol, gpt-5.6-terra',
};

export interface DefaultsChange {
  agent: Agent;
  /** null = the CLI's own default. */
  model: string | null;
  effort: string | null;
}

/** Form → controller body. An empty field means "the CLI's own default". */
export function parseDefaultsForm(form: FormData): DefaultsChange | { error: string } {
  const agent = form.get('agent');
  if (typeof agent !== 'string' || !(AGENTS as readonly string[]).includes(agent)) return { error: 'Unknown worker' };
  const rawModel = form.get('model');
  const rawEffort = form.get('effort');
  const model = typeof rawModel === 'string' ? rawModel.trim() : '';
  const effort = typeof rawEffort === 'string' ? rawEffort.trim() : '';
  if (model && !MODEL_PATTERN.test(model)) {
    return { error: 'Model must be a model name or alias: letters, digits, . _ : - [ ], at most 80, not starting with "-".' };
  }
  if (effort && !(EFFORT_LEVELS as readonly string[]).includes(effort)) return { error: 'Unknown effort level' };
  return { agent: agent as Agent, model: model || null, effort: effort || null };
}

export const runLabel = (value: string | null | undefined) => value || 'CLI default';
