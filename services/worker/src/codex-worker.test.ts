import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { WorkerConfig } from './config.js';
import { ControllerClient } from './controller-client.js';
import type { WorkerReport } from './executor.js';
import { silentLogger } from './logger.js';
import { CodexRunner } from './runners/codex-runner.js';
import { InstanceLock, WorkerState } from './state.js';
import { FakeController } from './testing/fake-controller.js';
import { FAKE_CODEX, tempDir, testConfig, waitFor } from './testing/helpers.js';
import { Worker } from './worker.js';
import { Workspace } from './workspace.js';

const isPosix = process.platform !== 'win32';

/** The shared worker code driven by CodexRunner against the fake controller and fake Codex CLI. */
describe('Codex worker (fake controller + fake Codex CLI)', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let controller: FakeController;
  let config: WorkerConfig;
  let worker: Worker | null;
  let running: Promise<void> | null;

  const start = (overrides: Partial<WorkerConfig> = {}) => {
    config = {
      ...testConfig(dir.path, {
        agent: 'codex',
        workerId: 'codex-worker',
        token: 'x'.repeat(40),
        controllerUrl: controller.url,
        agentCommand: [process.execPath, FAKE_CODEX],
      }),
      ...overrides,
    };
    worker = new Worker({
      config,
      client: new ControllerClient(config.controllerUrl, config.token, 2000),
      workspace: new Workspace(config),
      runner: new CodexRunner(config.agentCommand),
      state: new WorkerState(config.stateDir),
      lock: new InstanceLock(config.stateDir),
      logger: silentLogger,
    });
    running = worker.run();
    return running;
  };
  const statusOf = (id: string) => controller.tasks.get(id)!.status;
  const reportOf = (raw: string | null) => JSON.parse(raw!) as WorkerReport;
  const callsFor = (id: string, action: string) => controller.calls.filter((c) => c.includes(`${id}/${action}`)).length;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: join(config.workspaceRoot, 'sandbox'), encoding: 'utf8' });

  beforeEach(async () => {
    dir = await tempDir('codex-worker-');
    controller = new FakeController();
    await controller.start();
    worker = null;
    running = null;
  });

  afterEach(async () => {
    worker?.stop();
    await running?.catch(() => {});
    await controller.stop();
    await dir.cleanup();
  });

  it('polls while idle and never claims Claude tasks', async () => {
    const claudeTask = controller.addTask('claude', '@write x.txt=x');
    void start();
    await waitFor(() => controller.calls.filter((c) => c.endsWith('/claim')).length >= 3, 5000, 'idle polls');
    assert.equal(statusOf(claudeTask.id), 'queued');
    assert.equal(existsSync(join(config.workspaceRoot, '.worktrees', claudeTask.id)), false);
  });

  it('runs a task on its codex/ branch, closes stdin, parses JSONL and reports completed', async () => {
    const task = controller.addTask(
      'codex',
      'Create a page\n@command 0 ls -la\n@write index.html=<h1>Hello from Codex Worker</h1>\n@dump .agent-env.json',
    );
    void start();
    // fake-codex blocks until stdin reaches EOF, so completing at all proves stdin was closed.
    await waitFor(() => statusOf(task.id) === 'completed', 10_000, 'completion');

    const report = reportOf(controller.tasks.get(task.id)!.result);
    assert.equal(report.format, 'agent-worker/v1');
    assert.equal(report.agent, 'codex');
    assert.equal(report.workerId, 'codex-worker');
    assert.equal(report.outcome, 'completed');
    assert.equal(report.exitCode, 0);
    assert.equal(report.message, 'Done: 3 directive(s)');
    assert.equal(report.agentDetails.threadId, '0199a213-81c0-7800-8aa1-bbab2a035a53');
    assert.deepEqual(report.agentDetails.tokens, { input: 100, cachedInput: 40, output: 7, reasoningOutput: 2 });
    assert.deepEqual(report.agentDetails.commands, [{ command: 'ls -la', exitCode: 0, status: 'completed' }]);
    assert.equal((report.agentDetails.fileChanges as unknown[]).length, 1);
    assert.match(report.stderrTail, /Reading additional input from stdin/);

    // worktree + branch + commit, main checkout untouched
    const worktree = join(config.workspaceRoot, '.worktrees', task.id);
    assert.equal(report.workspace?.path, worktree);
    assert.equal(report.workspace?.branch, `codex/task-${task.id}`);
    assert.deepEqual(report.workspace?.changedFiles.map((f) => f.path).sort(), ['.agent-env.json', 'index.html']);
    assert.equal(readFileSync(join(worktree, 'index.html'), 'utf8'), '<h1>Hello from Codex Worker</h1>');
    assert.equal(existsSync(join(config.workspaceRoot, 'sandbox', 'index.html')), false, 'main checkout untouched');
    assert.match(git('log', '-1', '--format=%s %an', `codex/task-${task.id}`), /^codex-worker: task .* \(completed\) codex-worker/);
    assert.equal(git('rev-parse', report.workspace!.commit!).trim(), report.workspace!.commit);
    assert.equal(git('branch', '--show-current').trim(), 'main');
    assert.equal(git('remote').trim(), '', 'no remotes, nothing pushed');

    const dump = JSON.parse(readFileSync(join(worktree, '.agent-env.json'), 'utf8')) as { argv: string[]; envKeys: string[]; stdin: string };
    assert.ok(!dump.envKeys.includes('CONTROLLER_WORKER_TOKEN'));
    assert.ok(dump.stdin.includes('Create a page'), 'instruction delivered on stdin');
    assert.equal(dump.argv.at(-1), '-');
    assert.ok(!dump.argv.some((a) => a.includes('Create a page')), 'instruction not in argv');
    assert.ok(!dump.argv.some((a) => /dangerously|danger-full-access/.test(a)));
    assert.equal(dump.argv[dump.argv.indexOf('-C') + 1], worktree);
    assert.ok(existsSync(join(config.stateDir, 'reports', `${task.id}.json`)), 'local report kept');
  });

  it('completes despite damaged and unknown JSONL lines', async () => {
    const task = controller.addTask('codex', '@garbage\n@unknown\n@error-event\n@write ok.txt=ok');
    void start();
    await waitFor(() => statusOf(task.id) === 'completed', 10_000, 'completion');
    const details = reportOf(controller.tasks.get(task.id)!.result).agentDetails;
    assert.equal(details.malformedLines, 3);
    assert.deepEqual(details.unknownEvents, { 'thread.future_event': 1, 'item:hologram': 1 });
    assert.deepEqual(details.errors, ['Reconnecting... 1/5']);
  });

  it('keeps the final events when the output exceeds the capture limit', async () => {
    const task = controller.addTask('codex', '@big 300000\n@write big.txt=ok');
    void start({ maxOutputBytes: 64 * 1024 });
    await waitFor(() => statusOf(task.id) === 'completed', 10_000, 'completion');
    const report = reportOf(controller.tasks.get(task.id)!.result);
    assert.equal(report.stdoutTruncated, true);
    assert.equal(report.message, 'Done: 2 directive(s)');
  });

  it('reports failed for a failed turn, a non-zero exit, a missing turn or a missing answer', async () => {
    const cases = {
      turnFailed: controller.addTask('codex', '@write a.txt=a\n@turn-failed'),
      exit: controller.addTask('codex', '@exit 2'),
      noTurn: controller.addTask('codex', '@no-turn'),
      noFinal: controller.addTask('codex', '@no-final'),
    };
    void start();
    await waitFor(() => Object.values(cases).every((t) => statusOf(t.id) === 'failed'), 15_000, 'failures');
    const message = (t: { id: string }) => reportOf(controller.tasks.get(t.id)!.error).message;
    assert.match(message(cases.turnFailed), /turn failed: stream disconnected/);
    assert.equal(reportOf(controller.tasks.get(cases.turnFailed.id)!.error).exitCode, 1);
    assert.match(message(cases.exit), /exited with code 2/);
    assert.match(message(cases.noTurn), /before completing its turn/);
    assert.match(message(cases.noFinal), /without a final message/);
    for (const t of Object.values(cases)) assert.equal(callsFor(t.id, 'complete'), 0);
    // work done before the failure is kept on the branch
    assert.match(git('show', '--name-only', '--format=', `codex/task-${cases.turnFailed.id}`), /a\.txt/);
  });

  it('stops Codex and its child processes when cancellation is requested', async () => {
    const task = controller.addTask('codex', '@write partial.txt=half done\n@grandchild child.pid\n@sleep 30000');
    void start();
    const worktree = () => join(config.workspaceRoot, '.worktrees', task.id);
    await waitFor(() => existsSync(join(worktree(), 'child.pid')), 5000, 'agent running');
    const requestedAt = Date.now();
    controller.requestCancel(task.id);
    await waitFor(() => statusOf(task.id) === 'canceled', 10_000, 'cancel-ack');
    assert.ok(Date.now() - requestedAt < 5000, 'stopped promptly');
    assert.equal(callsFor(task.id, 'complete') + callsFor(task.id, 'fail'), 0);
    assert.match(git('show', '--name-only', '--format=', `codex/task-${task.id}`), /partial\.txt/);
    if (isPosix) {
      const pid = Number(readFileSync(join(worktree(), 'child.pid'), 'utf8'));
      await waitFor(() => !alive(pid), 5000, 'grandchild killed');
    }
  });

  it('kills Codex when it ignores SIGTERM past the grace period', async () => {
    const task = controller.addTask('codex', '@ignore-term\n@sleep 30000');
    void start();
    await waitFor(() => statusOf(task.id) === 'running', 5000, 'claim');
    controller.requestCancel(task.id);
    await waitFor(() => statusOf(task.id) === 'canceled', 10_000, 'cancel-ack after SIGKILL');
  });

  it('kills a task that exceeds its timeout and reports it as failed', async () => {
    const task = controller.addTask('codex', '@sleep 30000');
    void start({ taskTimeoutMs: 300 });
    await waitFor(() => statusOf(task.id) === 'failed', 10_000, 'timeout');
    const report = reportOf(controller.tasks.get(task.id)!.error);
    assert.equal(report.timedOut, true);
    assert.match(report.message, /Timed out/);
  });

  it('reports a task interrupted by a restart as failed and does not re-run it', async () => {
    const task = controller.addTask('codex', '@write never.txt=x');
    task.status = 'running';
    task.claimedBy = 'codex-worker';
    const state = new WorkerState(join(dir.path, 'state'));
    await state.init();
    await state.saveCurrentTask({ taskId: task.id, startedAt: new Date().toISOString(), workspace: null });

    void start();
    await waitFor(() => statusOf(task.id) === 'failed', 10_000, 'recovery report');
    assert.equal(reportOf(controller.tasks.get(task.id)!.error).outcome, 'interrupted');
    // The worker clears its state file after the report request returns, so wait for it.
    await waitFor(async () => (await state.readCurrentTask()) === null, 5000, 'state cleared');
    assert.equal(existsSync(join(config.workspaceRoot, '.worktrees', task.id)), false, 'not re-run');
    assert.equal(callsFor(task.id, 'heartbeat'), 0);
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
