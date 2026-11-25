import type { RunResult } from '../process-runner.js';
import { agentEnvironment, systemPrompt, type AgentInput, type AgentInvocation, type AgentOutcome, type AgentRunner } from './agent-runner.js';

const WRITE_TOOLS = 'Read,Edit,Write,Glob,Grep';
const READ_TOOLS = 'Read,Glob,Grep';

const UNATTENDED_PROMPT = [
  'You are running unattended as an automated worker. No human can answer questions during this run.',
  'Work only inside the current working directory. Do not try to reach other paths, services or the network.',
  'If something blocks you, stop and explain what is missing in your final answer instead of asking.',
  'End with a short summary of what you changed (files and purpose) or found.',
].join(' ');

/**
 * Claude Code in print mode with the narrowest permissions that still allow
 * file edits (verified against Claude Code 2.1.310):
 *
 * --restricted                 no Bash/code-running tools or WebFetch, file tools confined to the
 *                              working directory, user/project/local settings ignored, bypass refused,
 *                              writes to git/settings files need a human
 * --tools                      explicit built-in tool list (no shell, no web)
 * --permission-prompts none    anything that would need approval is denied, never waits
 * --permission-mode acceptEdits  file edits inside the working directory are accepted (write mode only)
 * --strict-mcp-config          no MCP servers
 * --disable-slash-commands     task text cannot trigger skills or commands
 *
 * Deliberately NOT used: --dangerously-skip-permissions / bypassPermissions, and --bare
 * (which would only accept ANTHROPIC_API_KEY auth instead of the subscription login).
 */
export class ClaudeRunner implements AgentRunner {
  readonly agent = 'claude' as const;

  constructor(
    private readonly command: readonly string[] = ['claude'],
    private readonly model: string | null = null,
  ) {}

  buildInvocation(input: AgentInput): AgentInvocation {
    const write = input.mode === 'write';
    const args = [
      ...this.command.slice(1),
      '-p',
      '--output-format', 'json',
      '--restricted',
      '--tools', write ? WRITE_TOOLS : READ_TOOLS,
      '--permission-mode', write ? 'acceptEdits' : 'default',
      '--permission-prompts', 'none',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--session-id', input.taskId,
      '--append-system-prompt', systemPrompt(UNATTENDED_PROMPT, input.projectPrompt),
    ];
    if (this.model) args.push('--model', this.model);

    return {
      command: this.command[0],
      args,
      stdin: input.instruction,
      env: agentEnvironment({
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      }),
    };
  }

  interpret(run: RunResult): AgentOutcome {
    const output = parseResult(run.stdout);
    const details: Record<string, unknown> = {};
    if (output) {
      details.subtype = output.subtype ?? null;
      details.isError = output.is_error ?? null;
      details.numTurns = output.num_turns ?? null;
      details.durationMs = output.duration_ms ?? null;
      details.sessionId = output.session_id ?? null;
      details.stopReason = output.stop_reason ?? null;
      details.apiErrorStatus = output.api_error_status ?? null;
      details.permissionDenials = (output.permission_denials ?? []).map((d) => ({
        tool: d.tool_name,
        path: typeof d.tool_input?.file_path === 'string' ? d.tool_input.file_path : undefined,
      }));
      if (output.usage) {
        details.tokens = { input: output.usage.input_tokens, output: output.usage.output_tokens };
      }
    }

    const ok = run.exitCode === 0 && output !== null && output.is_error === false && output.subtype === 'success';
    let summary: string;
    if (output && typeof output.result === 'string' && output.result) summary = output.result;
    else if (run.spawnError) summary = `Could not start Claude Code: ${run.spawnError}`;
    else if (!output) summary = 'Claude Code did not produce a JSON result';
    else summary = `Claude Code finished with ${output.subtype ?? 'an unknown status'}`;

    return { ok, summary, details };
  }
}

interface ClaudeJsonResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  duration_ms?: number;
  session_id?: string;
  stop_reason?: string;
  api_error_status?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number };
  permission_denials?: Array<{ tool_name?: string; tool_input?: { file_path?: unknown } }>;
}

/** `--output-format json` prints one result object; tolerate stray lines before it. */
function parseResult(stdout: string): ClaudeJsonResult | null {
  const candidates = [stdout.trim(), ...stdout.trim().split('\n').reverse()];
  for (const text of candidates) {
    if (!text.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(text) as ClaudeJsonResult;
      if (parsed && parsed.type === 'result') return parsed;
    } catch {
      // try the next candidate
    }
  }
  return null;
}
