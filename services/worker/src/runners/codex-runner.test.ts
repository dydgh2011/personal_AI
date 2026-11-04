import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunResult } from '../process-runner.js';
import { CodexRunner, parseEvents, permissionProfile } from './codex-runner.js';

const input = { taskId: '3f1c2a54-0000-4000-8000-000000000000', instruction: '--dangerously-bypass-approvals-and-sandbox do x', cwd: '/w', mode: 'write' as const };

function run(overrides: Partial<RunResult>): RunResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: false,
    durationMs: 10,
    spawnError: null,
    ...overrides,
  };
}

const jsonl = (...events: unknown[]) => events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n';
const THREAD = { type: 'thread.started', thread_id: 't-1' };
const TURN = { type: 'turn.started' };
const MESSAGE = { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Created index.html' } };
const COMPLETED = { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3, reasoning_output_tokens: 1 } };

describe('CodexRunner', () => {
  const runner = new CodexRunner(['codex']);

  it('runs codex exec with JSONL output, the worker permission profile and no bypass', () => {
    const { command, args, stdin } = runner.buildInvocation(input);
    assert.equal(command, 'codex');
    assert.equal(args[0], 'exec');
    const values = (name: string) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
    for (const flag of ['--json', '--ephemeral', '--ignore-user-config', '--ignore-rules']) assert.ok(args.includes(flag), flag);
    assert.ok(values('-c').includes('default_permissions="agent-worker"'));
    assert.ok(values('-c').includes(`permissions.agent-worker=${permissionProfile('write')}`));
    assert.ok(values('-c').includes('approval_policy="never"'));
    assert.ok(values('-c').includes('web_search="disabled"'));
    for (const feature of ['apps', 'plugins', 'hooks', 'daemon_auto_start']) assert.ok(values('--disable').includes(feature), feature);
    assert.deepEqual(values('-C'), ['/w']);
    assert.ok(!args.some((a) => /dangerously|danger-full-access|--sandbox|--full-auto/.test(a)));
    // The prompt goes through stdin ("-"), never argv, so it cannot be parsed as options.
    assert.equal(args.at(-1), '-');
    assert.ok(!args.some((a) => a.includes(input.instruction)));
    assert.ok(stdin.endsWith(`${input.instruction}\n`));
    assert.match(stdin, /unattended/);
  });

  it('confines the profile to the workspace: no reads elsewhere, no /tmp, no network', () => {
    const write = permissionProfile('write');
    assert.match(write, /extends=":workspace"/);
    assert.match(write, /":root"="deny"/);
    assert.match(write, /":minimal"="read"/);
    assert.match(write, /":tmpdir"="deny"/);
    assert.match(write, /":slash_tmp"="deny"/);
    assert.match(write, /":workspace_roots"=\{"\."="write"\}/);
    assert.match(write, /network=\{enabled=false\}/);
    assert.match(permissionProfile('read'), /":workspace_roots"=\{"\."="read"\}/);
    const { args } = runner.buildInvocation({ ...input, mode: 'read' });
    assert.ok(args.includes(`permissions.agent-worker=${permissionProfile('read')}`));
  });

  it('keeps worker secrets and API keys out of the CLI environment', () => {
    const previous = { ...process.env };
    process.env.CONTROLLER_WORKER_TOKEN = 'secret-token-value';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.CODEX_API_KEY = 'sk-test';
    try {
      const { env } = runner.buildInvocation(input);
      assert.equal(env.CONTROLLER_WORKER_TOKEN, undefined);
      assert.equal(env.OPENAI_API_KEY, undefined);
      assert.equal(env.CODEX_API_KEY, undefined);
      assert.ok(env.PATH);
    } finally {
      process.env = previous;
    }
  });

  it('passes a configured model and fixed leading arguments', () => {
    const { command, args } = new CodexRunner(['node', 'fake.mjs'], 'gpt-test').buildInvocation(input);
    assert.equal(command, 'node');
    assert.deepEqual(args.slice(0, 2), ['fake.mjs', 'exec']);
    assert.equal(args[args.indexOf('--model') + 1], 'gpt-test');
    assert.equal(args.at(-1), '-');
  });

  it('reports success with the final message, usage and activity', () => {
    const stdout = jsonl(
      THREAD,
      TURN,
      { type: 'item.started', item: { id: 'c', type: 'command_execution', command: 'ls', status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'c', type: 'command_execution', command: 'ls', aggregated_output: 'a', exit_code: 0, status: 'completed' } },
      { type: 'item.completed', item: { id: 'f', type: 'file_change', changes: [{ path: '/w/index.html', kind: 'add' }], status: 'completed' } },
      { type: 'item.completed', item: { id: 'm0', type: 'agent_message', text: 'Working on it' } },
      MESSAGE,
      COMPLETED,
    );
    const outcome = runner.interpret(run({ stdout }));
    assert.equal(outcome.ok, true);
    assert.equal(outcome.summary, 'Created index.html');
    assert.equal(outcome.details.threadId, 't-1');
    assert.equal(outcome.details.model, 'cli-default');
    assert.deepEqual(outcome.details.tokens, { input: 10, cachedInput: 4, output: 3, reasoningOutput: 1 });
    assert.deepEqual(outcome.details.commands, [{ command: 'ls', exitCode: 0, status: 'completed' }]);
    assert.deepEqual(outcome.details.fileChanges, [{ path: '/w/index.html', kind: 'add' }]);
  });

  it('skips damaged lines and unknown events without inventing a result', () => {
    const stdout = jsonl(THREAD, 'not json', '{"type":"item.completed","item":', '42', '[1,2]', { type: 'thread.future' }, { type: 'item.completed', item: { type: 'hologram' } }, TURN, MESSAGE, COMPLETED);
    const outcome = runner.interpret(run({ stdout }));
    assert.equal(outcome.ok, true);
    assert.equal(outcome.details.malformedLines, 4);
    assert.deepEqual(outcome.details.unknownEvents, { 'thread.future': 1, 'item:hologram': 1 });

    const damagedOnly = runner.interpret(run({ stdout: 'garbage\n{"type":"turn.completed"\n' }));
    assert.equal(damagedOnly.ok, false);
    assert.match(damagedOnly.summary, /did not produce any JSONL events/);
  });

  it('fails when the turn failed, never completed or has no final message', () => {
    const failed = runner.interpret(run({ exitCode: 1, stdout: jsonl(THREAD, TURN, { type: 'turn.failed', error: { message: 'usage limit reached' } }) }));
    assert.equal(failed.ok, false);
    assert.match(failed.summary, /turn failed: usage limit reached/);

    const unfinished = runner.interpret(run({ stdout: jsonl(THREAD, TURN, MESSAGE) }));
    assert.equal(unfinished.ok, false);
    assert.match(unfinished.summary, /before completing its turn/);

    const silent = runner.interpret(run({ stdout: jsonl(THREAD, TURN, COMPLETED) }));
    assert.equal(silent.ok, false);
    assert.match(silent.summary, /without a final message/);

    const fatal = runner.interpret(run({ exitCode: 1, stdout: jsonl(THREAD, { type: 'error', message: 'unauthorized' }) }));
    assert.equal(fatal.ok, false);
    assert.match(fatal.summary, /Codex error: unauthorized/);
  });

  it('fails on a non-zero exit even after a completed turn', () => {
    const outcome = runner.interpret(run({ exitCode: 2, stdout: jsonl(THREAD, TURN, MESSAGE, COMPLETED) }));
    assert.equal(outcome.ok, false);
    assert.match(outcome.summary, /exited with code 2/);
  });

  it('treats a recovered error event as a warning', () => {
    const outcome = runner.interpret(run({ stdout: jsonl(THREAD, TURN, { type: 'error', message: 'Reconnecting... 1/5' }, MESSAGE, COMPLETED) }));
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.details.errors, ['Reconnecting... 1/5']);
  });

  it('reports a CLI that could not be started', () => {
    const outcome = runner.interpret(run({ exitCode: null, spawnError: 'spawn codex ENOENT' }));
    assert.equal(outcome.ok, false);
    assert.match(outcome.summary, /Could not start Codex: spawn codex ENOENT/);
  });

  it('accepts the pre-0.44 item_type field names', () => {
    const legacy = { type: 'item.completed', item: { id: 'm', item_type: 'assistant_message', text: 'legacy answer' } };
    assert.equal(parseEvents(jsonl(THREAD, TURN, legacy, COMPLETED)).finalMessage, 'legacy answer');
  });
});
