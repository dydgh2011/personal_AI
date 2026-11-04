import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunResult } from '../process-runner.js';
import { ClaudeRunner } from './claude-runner.js';

const input = { taskId: '3f1c2a54-0000-4000-8000-000000000000', instruction: '--dangerously-skip-permissions do x', cwd: '/w', mode: 'write' as const };

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

describe('ClaudeRunner', () => {
  const runner = new ClaudeRunner(['claude']);

  it('uses print mode with restricted, explicit permissions', () => {
    const { command, args } = runner.buildInvocation(input);
    assert.equal(command, 'claude');
    const flag = (name: string) => args[args.indexOf(name) + 1];
    assert.ok(args.includes('-p'));
    assert.ok(args.includes('--restricted'));
    assert.ok(args.includes('--strict-mcp-config'));
    assert.ok(args.includes('--disable-slash-commands'));
    assert.equal(flag('--output-format'), 'json');
    assert.equal(flag('--tools'), 'Read,Edit,Write,Glob,Grep');
    assert.equal(flag('--permission-mode'), 'acceptEdits');
    assert.equal(flag('--permission-prompts'), 'none');
    assert.equal(flag('--session-id'), input.taskId);
  });

  it('never enables permission bypass or API-key-only mode', () => {
    for (const mode of ['write', 'read'] as const) {
      const { args } = runner.buildInvocation({ ...input, mode });
      for (const forbidden of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', 'bypassPermissions', '--bare']) {
        assert.ok(!args.includes(forbidden), `${forbidden} must not be used`);
      }
    }
  });

  it('gives read-only projects no editing tools', () => {
    const { args } = runner.buildInvocation({ ...input, mode: 'read' });
    assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'default');
  });

  it('sends the instruction on stdin, never as an argument', () => {
    const invocation = runner.buildInvocation(input);
    assert.equal(invocation.stdin, input.instruction);
    assert.ok(!invocation.args.includes(input.instruction));
  });

  it('strips worker secrets and API keys from the environment', () => {
    process.env.CONTROLLER_WORKER_TOKEN = 'secret-worker-token';
    process.env.ANTHROPIC_API_KEY = 'sk-should-not-pass';
    try {
      const { env } = runner.buildInvocation(input);
      assert.equal(env.CONTROLLER_WORKER_TOKEN, undefined);
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
      assert.equal(env.DISABLE_AUTOUPDATER, '1');
      assert.ok(env.PATH);
    } finally {
      delete process.env.CONTROLLER_WORKER_TOKEN;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('interprets a successful JSON result', () => {
    const stdout = JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: 'Created index.html', num_turns: 3,
      session_id: 's', permission_denials: [{ tool_name: 'Write', tool_input: { file_path: '/tmp/x', content: 'secret' } }],
    });
    const outcome = runner.interpret(run({ stdout }));
    assert.equal(outcome.ok, true);
    assert.equal(outcome.summary, 'Created index.html');
    assert.deepEqual(outcome.details.permissionDenials, [{ tool: 'Write', path: '/tmp/x' }]);
  });

  it('treats errors, non-zero exits and unparseable output as failures', () => {
    const error = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true });
    assert.equal(runner.interpret(run({ stdout: error })).ok, false);
    const success = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' });
    assert.equal(runner.interpret(run({ stdout: success, exitCode: 1 })).ok, false);
    const garbage = runner.interpret(run({ stdout: 'not json' }));
    assert.equal(garbage.ok, false);
    assert.match(garbage.summary, /did not produce a JSON result/);
    assert.match(runner.interpret(run({ exitCode: null, spawnError: 'spawn claude ENOENT' })).summary, /ENOENT/);
  });
});
