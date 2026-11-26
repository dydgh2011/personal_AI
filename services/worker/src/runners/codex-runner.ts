import type { RunResult } from '../process-runner.js';
import type { WorkspaceMode } from '../workspace.js';
import { agentEnvironment, systemPrompt, type AgentInput, type AgentInvocation, type AgentOutcome, type AgentRunner } from './agent-runner.js';

export const PERMISSION_PROFILE = 'agent-worker';

/**
 * Codex permission profile (TOML inline table) for model-generated commands and
 * file edits. Enforced by bubblewrap + seccomp (verified against codex-cli 0.164.0):
 *
 * extends :workspace      keeps Codex's guards: .git, .codex, .agents inside the workspace stay read-only
 * :root = deny            nothing outside the listed paths is readable: no ~/.codex/auth.json,
 *                         no worker state, no main checkout, no other task's worktree
 * :minimal = read         system and runtime paths tools need (/usr, /bin, /etc, ...)
 * :tmpdir / :slash_tmp    deny: the task worktree is the only writable place
 * workspace roots         the cwd (the task worktree): write, or read for read-only projects
 * network disabled        commands run in their own network namespace
 */
export function permissionProfile(mode: WorkspaceMode): string {
  const access = mode === 'write' ? 'write' : 'read';
  return (
    `{extends=":workspace", ` +
    `filesystem={":root"="deny", ":minimal"="read", ":tmpdir"="deny", ":slash_tmp"="deny", ":workspace_roots"={"."="${access}"}}, ` +
    `network={enabled=false}}`
  );
}

/**
 * Features an unattended worker must not use: ChatGPT apps/connectors and plugins would reach
 * the user's other accounts, hooks run local commands, browser/computer use and image generation
 * are out of scope, and the app-server daemon would outlive the task's process group.
 */
const DISABLED_FEATURES = [
  'apps',
  'plugins',
  'remote_plugin',
  'hooks',
  'browser_use',
  'computer_use',
  'image_generation',
  'daemon_auto_start',
  'skill_mcp_dependency_install',
  'tool_suggest',
  'goals',
  'memories',
];

const UNATTENDED_PROMPT = [
  'You are running unattended as an automated worker. No human can answer questions or approve anything during this run.',
  'Work only inside the current working directory. Paths outside it, the network and git metadata are not available.',
  'Do not run git commands; the worker commits your changes to the task branch after you finish.',
  'If something blocks you, stop and explain what is missing in your final answer instead of asking.',
  'End with a short summary of what you changed (files and purpose) or found.',
].join(' ');

/**
 * `codex exec` with JSONL output and the agent-worker permission profile.
 *
 * Deliberately NOT used: --dangerously-bypass-approvals-and-sandbox, --sandbox danger-full-access,
 * --dangerously-bypass-hook-trust, and API-key auth (the ChatGPT login in ~/.codex is used; the
 * environment allowlist keeps OPENAI_API_KEY/CODEX_API_KEY away from the CLI).
 */
export class CodexRunner implements AgentRunner {
  readonly agent = 'codex' as const;

  constructor(
    private readonly command: readonly string[] = ['codex'],
    private readonly model: string | null = null,
  ) {}

  buildInvocation(input: AgentInput): AgentInvocation {
    const args = [
      ...this.command.slice(1),
      'exec',
      '--json',
      '--color', 'never',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '-c', `default_permissions="${PERMISSION_PROFILE}"`,
      '-c', `permissions.${PERMISSION_PROFILE}=${permissionProfile(input.mode)}`,
      '-c', 'approval_policy="never"',
      '-c', 'web_search="disabled"',
      '-c', 'check_for_update_on_startup=false',
      '-c', 'analytics.enabled=false',
      '-c', 'feedback.enabled=false',
      '-c', 'history.persistence="none"',
      ...DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
      '-C', input.cwd,
    ];
    const model = input.model ?? this.model;
    if (model) args.push('--model', model);
    // A checked keyword (run-options.ts), so it is safe inside the TOML string.
    if (input.effort) args.push('-c', `model_reasoning_effort="${input.effort}"`);
    // "-" = read the prompt from stdin, which runProcess closes after writing it.
    args.push('-');

    return {
      command: this.command[0],
      args,
      stdin: `${systemPrompt(UNATTENDED_PROMPT, input.projectPrompt)}\n\n--- Task ---\n${input.instruction}\n`,
      env: agentEnvironment({ NO_COLOR: '1' }),
    };
  }

  interpret(run: RunResult): AgentOutcome {
    const events = parseEvents(run.stdout);
    const ok =
      run.exitCode === 0 &&
      run.spawnError === null &&
      events.turnsCompleted > 0 &&
      events.turnFailure === null &&
      events.finalMessage !== null;

    let summary: string;
    if (ok) summary = events.finalMessage!;
    else if (run.spawnError) summary = `Could not start Codex: ${run.spawnError}`;
    else if (events.turnFailure) summary = `Codex turn failed: ${events.turnFailure}`;
    else if (events.errors.length > 0) summary = `Codex error: ${events.errors[events.errors.length - 1]}`;
    else if (events.events === 0) summary = 'Codex did not produce any JSONL events';
    else if (events.turnsCompleted === 0) summary = 'Codex exited before completing its turn';
    else if (events.finalMessage === null) summary = 'Codex completed without a final message';
    else summary = `Codex exited with code ${run.exitCode ?? `signal ${run.signal}`}: ${events.finalMessage}`;

    return {
      ok,
      summary,
      details: {
        threadId: events.threadId,
        turnsCompleted: events.turnsCompleted,
        turnFailure: events.turnFailure,
        tokens: events.usage,
        commands: events.commands,
        fileChanges: events.fileChanges,
        errors: events.errors,
        events: events.events,
        malformedLines: events.malformedLines,
        unknownEvents: events.unknownEvents,
      },
    };
  }
}

const MAX_LIST = 50;
const MAX_TEXT = 500;

interface CommandSummary {
  command: string;
  exitCode: number | null;
  status: string | null;
}

interface FileChangeSummary {
  path: string;
  kind: string | null;
}

interface ParsedEvents {
  threadId: string | null;
  events: number;
  turnsCompleted: number;
  turnFailure: string | null;
  finalMessage: string | null;
  usage: { input: number; cachedInput: number; output: number; reasoningOutput: number } | null;
  commands: CommandSummary[];
  fileChanges: FileChangeSummary[];
  errors: string[];
  malformedLines: number;
  unknownEvents: Record<string, number>;
}

/**
 * Reads `codex exec --json` output line by line. Lines that are not JSON or
 * not objects are counted and skipped; unknown event and item types are
 * counted, never fatal. Success still requires a completed turn and a final
 * agent message, so a damaged stream can only ever lead to a failure.
 */
export function parseEvents(stdout: string): ParsedEvents {
  const parsed: ParsedEvents = {
    threadId: null,
    events: 0,
    turnsCompleted: 0,
    turnFailure: null,
    finalMessage: null,
    usage: null,
    commands: [],
    fileChanges: [],
    errors: [],
    malformedLines: 0,
    unknownEvents: {},
  };
  const unknown = (kind: string) => {
    parsed.unknownEvents[kind] = (parsed.unknownEvents[kind] ?? 0) + 1;
  };

  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      parsed.malformedLines++;
      continue;
    }
    if (!isObject(event) || typeof event.type !== 'string') {
      parsed.malformedLines++;
      continue;
    }
    parsed.events++;

    switch (event.type) {
      case 'thread.started':
        if (typeof event.thread_id === 'string') parsed.threadId = event.thread_id;
        break;
      case 'turn.started':
        break;
      case 'turn.completed': {
        parsed.turnsCompleted++;
        const usage = isObject(event.usage) ? event.usage : {};
        const total = (parsed.usage ??= { input: 0, cachedInput: 0, output: 0, reasoningOutput: 0 });
        total.input += num(usage.input_tokens);
        total.cachedInput += num(usage.cached_input_tokens);
        total.output += num(usage.output_tokens);
        total.reasoningOutput += num(usage.reasoning_output_tokens);
        break;
      }
      case 'turn.failed':
        parsed.turnFailure = clip(errorMessage(event.error) ?? 'unknown error');
        break;
      case 'error':
        pushCapped(parsed.errors, clip(errorMessage(event) ?? 'unknown error'));
        break;
      case 'item.started':
      case 'item.updated':
        break;
      case 'item.completed':
        if (isObject(event.item)) readItem(event.item, parsed, unknown);
        else parsed.malformedLines++;
        break;
      default:
        unknown(event.type);
    }
  }
  return parsed;
}

function readItem(item: Record<string, unknown>, parsed: ParsedEvents, unknown: (kind: string) => void) {
  // Codex < 0.44 used item_type / assistant_message.
  const type = typeof item.type === 'string' ? item.type : typeof item.item_type === 'string' ? item.item_type : null;
  switch (type) {
    case 'agent_message':
    case 'assistant_message':
      if (typeof item.text === 'string' && item.text.trim()) parsed.finalMessage = item.text;
      break;
    case 'command_execution':
      pushCapped(parsed.commands, {
        command: clip(typeof item.command === 'string' ? item.command : String(item.command ?? '')),
        exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
        status: typeof item.status === 'string' ? item.status : null,
      });
      break;
    case 'file_change':
      for (const change of Array.isArray(item.changes) ? item.changes : []) {
        if (isObject(change) && typeof change.path === 'string') {
          pushCapped(parsed.fileChanges, { path: clip(change.path), kind: typeof change.kind === 'string' ? change.kind : null });
        }
      }
      break;
    case 'error':
      pushCapped(parsed.errors, clip(typeof item.message === 'string' ? item.message : 'unknown error'));
      break;
    case 'reasoning':
    case 'todo_list':
    case 'mcp_tool_call':
    case 'web_search':
      break;
    default:
      unknown(`item:${type ?? 'untyped'}`);
  }
}

function errorMessage(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (isObject(value) && typeof value.message === 'string') return value.message;
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

function pushCapped<T>(list: T[], value: T) {
  if (list.length < MAX_LIST) list.push(value);
}
