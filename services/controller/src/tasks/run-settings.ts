import type { AgentType } from './task.model.js';

/**
 * Model and reasoning effort for a coding task (owner request 2026-11-25): each agent has a default
 * the owner can change, and a single task can ask for something else. A task stores the values it was
 * created with, so changing a default never changes queued or finished tasks.
 *
 * Effort levels both CLIs accept (Claude Code `--effort`, Codex `model_reasoning_effort`, checked
 * against Claude Code 2.1.330 and codex-cli 0.171.0). Codex's "ultra" (automatic task delegation) is
 * left out on purpose: an unattended worker must not start sub-agents of its own.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * A model name or CLI alias ("opus", "claude-opus-5-5", "gpt-6.1-sol", "sonnet[1m]"). It is passed as
 * one argv element after `--model`; it can never start with "-", so it is never read as an option.
 * Whether the model exists is the CLI's (and the account's) decision.
 */
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,79}$/;
export const MODEL_MAX_LENGTH = 80;

export interface RunSettings {
  /** null = the CLI's own default. */
  model: string | null;
  effort: EffortLevel | null;
}

export interface AgentDefaults extends RunSettings {
  agent: AgentType;
  /** null until the owner sets a default for the first time. */
  updatedAt: string | null;
  updatedBy: string | null;
}

export function isEffort(value: unknown): value is EffortLevel {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value);
}
