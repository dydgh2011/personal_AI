import type { AgentType } from '../config.js';
import type { RunResult } from '../process-runner.js';
import type { WorkspaceMode } from '../workspace.js';

export interface AgentInput {
  taskId: string;
  instruction: string;
  cwd: string;
  mode: WorkspaceMode;
  /**
   * The project's rules, forbidden paths and commit-style request (project-settings.ts), appended
   * after the runner's fixed unattended prompt. Empty when the project configures nothing.
   */
  projectPrompt?: string;
}

/** Fixed worker rules first; the project's part can only add to them. */
export function systemPrompt(base: string, projectPrompt: string | undefined): string {
  return projectPrompt ? `${base}\n\n${projectPrompt}` : base;
}

export interface AgentInvocation {
  command: string;
  args: string[];
  /** Sent on stdin, which is then closed. Keeps the prompt out of argv. */
  stdin: string;
  env: NodeJS.ProcessEnv;
}

export interface AgentOutcome {
  ok: boolean;
  /** The agent's final answer, or why it failed. */
  summary: string;
  /** Structured, agent-specific facts worth keeping (turns, denials, ...). No secrets. */
  details: Record<string, unknown>;
}

/**
 * Everything agent-specific about running a task. The executor, workspace,
 * polling and reporting code is shared; a Codex worker only needs another
 * implementation of this interface.
 */
export interface AgentRunner {
  readonly agent: AgentType;
  buildInvocation(input: AgentInput): AgentInvocation;
  interpret(result: RunResult): AgentOutcome;
}

/**
 * Environment for agent processes: an allowlist, so worker secrets
 * (CONTROLLER_WORKER_TOKEN) and API keys that would switch the CLI to
 * pay-per-use billing never reach the agent.
 */
export function agentEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // SystemRoot/TEMP only exist on Windows, where tests run; child processes need them there.
  for (const key of ['HOME', 'PATH', 'LANG', 'LC_ALL', 'TZ', 'USER', 'LOGNAME', 'TMPDIR', 'SystemRoot', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.LANG ??= 'C.UTF-8';
  return { ...env, ...extra };
}
