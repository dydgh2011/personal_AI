/**
 * Model and reasoning effort a task asks for (the controller resolves the owner's default when the
 * task is created). Checked again here before anything reaches a CLI argument: the controller is
 * trusted, but argv is the last place a bad value could do harm. Same rules as the controller's
 * tasks/run-settings.ts.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Never starts with "-", so it cannot be read as an option after `--model`. */
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,79}$/;

export interface RunOptions {
  /** null = the worker's WORKER_MODEL, else the CLI default. */
  model: string | null;
  /** null = the CLI default. */
  effort: EffortLevel | null;
}

export class RunOptionsError extends Error {}

export function runOptions(task: { model?: unknown; effort?: unknown }): RunOptions {
  const model = task.model ?? null;
  const effort = task.effort ?? null;
  if (model !== null && (typeof model !== 'string' || !MODEL_PATTERN.test(model))) {
    throw new RunOptionsError('Task has an invalid model name; not started');
  }
  if (effort !== null && !(EFFORT_LEVELS as readonly unknown[]).includes(effort)) {
    throw new RunOptionsError('Task has an invalid effort level; not started');
  }
  return { model: model as string | null, effort: effort as EffortLevel | null };
}

/** For the task report: what the agent was (or would have been) started with; invalid values are not echoed. */
export function reportedRun(task: { model?: unknown; effort?: unknown }, workerModel: string | null): { model: string | null; effort: string | null } {
  try {
    const options = runOptions(task);
    return { model: options.model ?? workerModel, effort: options.effort };
  } catch {
    return { model: null, effort: null };
  }
}
