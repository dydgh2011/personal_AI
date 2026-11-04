import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { AppConfig } from '../src/config/app-config.js';
import { createTestApp } from './app.js';
import { FakeGitHub } from './fake-github.js';
import { FakeClock, testConfig } from './helpers.js';

const BASE = '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d';
const HEAD = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const COMMANDS = [
  { name: 'whitespace', argv: ['git', 'diff', '--check', BASE, 'HEAD'], timeoutSeconds: 60 },
  { name: 'utf8', argv: ['sh', '-c', 'true'], timeoutSeconds: 30 },
];

function report(taskId: string) {
  return JSON.stringify({
    format: 'agent-worker/v1', taskId, agent: 'claude', outcome: 'completed', message: 'done', exitCode: 0,
    workspace: {
      projectId: 'hello-world', mode: 'write', path: `/workspace/.worktrees/${taskId}`, branch: `claude/task-${taskId}`,
      baseCommit: BASE, commit: HEAD, changedFiles: [{ status: 'A', path: 'NOTES.md' }],
      diff: {
        baseCommit: BASE, headCommit: HEAD, headTree: TREE, commitMessage: 'claude-worker: task (completed)', additions: 1, deletions: 0,
        files: [{ path: 'NOTES.md', status: 'A', additions: 1, deletions: 0, binary: false, sensitive: false }],
        patch: 'diff --git a/NOTES.md b/NOTES.md\n+notes\n', patchTruncated: false, omittedFiles: [],
      },
    },
    // what an agent claims about tests is never evidence
    tests: { passed: true, claimedBy: 'llm' },
  });
}

type Result = { name: string; argv: string[]; status: string; exitCode: number | null; signal: string | null; timedOut: boolean; durationMs: number; outputBytes: number; outputSha256: string; outputTail: string };
const ok = (c: (typeof COMMANDS)[number], over: Partial<Result> = {}): Result => ({
  name: c.name, argv: c.argv, status: 'passed', exitCode: 0, signal: null, timedOut: false, durationMs: 5, outputBytes: 0, outputSha256: 'e'.repeat(64), outputTail: '', ...over,
});

describe('Publishing policy (Phase E-2B): test evidence, publish authorization, publish request', () => {
  let dir: string;
  let github: FakeGitHub;
  let config: AppConfig;
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let clock: FakeClock;
  let admin: Record<string, string>;
  let dashboard: Record<string, string>;
  let hermes: Record<string, string>;
  let claude: Record<string, string>;
  let runner: Record<string, string>;
  let publisher: Record<string, string>;

  const boot = async (overrides: Partial<AppConfig> = {}) => {
    config = testConfig({ databasePath: join(dir, 'controller.db'), github: { apiUrl: github.url, tokenFile: null }, ...overrides });
    admin = { Authorization: `Bearer ${config.adminToken}` };
    dashboard = { Authorization: `Bearer ${config.dashboardToken}`, 'X-Approver': 'owner' };
    hermes = { Authorization: `Bearer ${config.delegators[0].token}` };
    claude = { Authorization: `Bearer ${config.workers[0].token}` };
    runner = { Authorization: `Bearer ${config.testRunnerToken}` };
    publisher = { Authorization: `Bearer ${config.publisherToken}` };
    app = await createTestApp(config, clock);
    await app.listen(0, '127.0.0.1');
    http = request(app.getHttpServer());
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'policy-'));
    clock = new FakeClock();
    github = new FakeGitHub();
    github.add({ id: 1296269, full_name: 'octocat/Hello-World', default_branch: 'master', head: BASE });
    await github.start();
    await boot();
    await http.post('/projects').set(admin).send({ id: 'hello-world', source: 'github', fullName: 'octocat/Hello-World', allowedAgents: ['claude'] }).expect(201);
    await http.patch('/projects/hello-world').set(admin).send({ enabled: true, allowCodeChanges: true, syncStatus: 'synced', cachedHeadSha: BASE }).expect(200);
  });

  afterEach(async () => {
    await app.close();
    await github.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const setCommands = (commands = COMMANDS) => http.patch('/projects/hello-world').set(admin).send({ testCommands: commands }).expect(200);
  const completedTask = async () => {
    const task = (await http.post('/tasks').set(admin).send({ agent: 'claude', projectId: 'hello-world', instruction: 'add notes' }).expect(201)).body;
    await http.post('/internal/workers/claim').set(claude).expect(200);
    await http.post(`/internal/tasks/${task.id}/complete`).set(claude).send({ result: report(task.id) }).expect(200);
    return task.id as string;
  };
  /** Plays the test runner: claim the next run and report `results` with matching evidence. */
  const runTests = async (results: (job: any) => Result[], status?: string, evidenceOverride: Record<string, unknown> = {}) => {
    const job = (await http.post('/internal/test-runner/claim').set(runner).expect(200)).body.job;
    const res = results(job);
    const derived = status ?? (res.every((r) => r.status === 'passed') && res.length === COMMANDS.length ? 'passed' : res.some((r) => r.status === 'skipped') ? 'skipped' : res.some((r) => r.timedOut) ? 'aborted' : 'failed');
    const evidence = JSON.stringify({ format: 'personal-ai-test-evidence/v1', validationId: job.validation.id, taskId: job.task.id, projectId: job.task.projectId, commitSha: job.commitSha, treeSha: TREE, status: derived, results: res, ...evidenceOverride });
    const body = { status: derived, results: res, evidence, evidenceHash: createHash('sha256').update(evidence).digest('hex'), evidenceSignature: 'f'.repeat(64) };
    return { job, done: (await http.post(`/internal/test-runner/validations/${job.validation.id}/result`).set(runner).send(body).expect(200)).body };
  };
  const approve = (id: string) => http.post(`/tasks/${id}/approve`).set(dashboard).send({ headSha: HEAD }).expect(200);
  const eligibleDryRun = async (id: string, testValidationId: string, eligible = true) => {
    const pub = (await http.post(`/tasks/${id}/publication/dry-run`).set(dashboard).send({ headSha: HEAD }).expect(202)).body;
    await http.post('/internal/publisher/claim').set(publisher).expect(200);
    await http.post(`/internal/publisher/publications/${pub.id}/result`).set(publisher)
      .send({ status: eligible ? 'ready' : 'failed', report: { eligible, canPublish: false, reason: eligible ? 'PUBLISH_APPROVAL_REQUIRED' : 'TEST_FAILED', testValidationId } }).expect(200);
    return pub.id as string;
  };
  const authorize = (id: string, dryRunId: string, key = 'auth-key-0001') =>
    http.post(`/tasks/${id}/publication/authorize`).set(dashboard).send({ headSha: HEAD, dryRunId, idempotencyKey: key });

  it('keeps test commands admin-only and validated', async () => {
    expect((await http.patch('/projects/hello-world').set(hermes).send({ testCommands: COMMANDS })).status).toBe(403);
    expect((await http.patch('/projects/hello-world').set(claude).send({ testCommands: COMMANDS })).status).toBe(403);
    expect((await http.patch('/projects/hello-world').set(runner).send({ testCommands: COMMANDS })).status).toBe(403);
    expect((await http.patch('/projects/hello-world').set(admin).send({ testCommands: [{ name: 'BAD NAME', argv: ['x'], timeoutSeconds: 1 }] })).status).toBe(400);
    expect((await http.patch('/projects/hello-world').set(admin).send({ testCommands: [{ name: 'x', argv: [], timeoutSeconds: 1 }] })).status).toBe(400);
    expect((await http.patch('/projects/hello-world').set(admin).send({ testCommands: [{ name: 'x', argv: ['a'], timeoutSeconds: 99999 }] })).status).toBe(400);
    const project = (await setCommands()).body;
    expect(project.testCommands).toEqual(COMMANDS);
  });

  it('queues a test run when a task completes, and never trusts what the agent said about tests', async () => {
    const none = await completedTask();
    expect((await http.get(`/tasks/${none}/tests`).set(admin)).body.items).toEqual([]); // no commands configured -> nothing queued
    expect((await http.post(`/tasks/${none}/tests`).set(dashboard).send({ headSha: HEAD })).body.code).toBe('TEST_COMMANDS_NOT_CONFIGURED');

    await setCommands();
    const id = await completedTask();
    const [queued] = (await http.get(`/tasks/${id}/tests`).set(admin)).body.items;
    expect(queued).toMatchObject({ status: 'pending', commitSha: HEAD, baseSha: BASE, commands: COMMANDS, requestedBy: 'controller:auto' });
    expect((await http.post(`/tasks/${id}/tests`).set(dashboard).send({ headSha: HEAD })).body.code).toBe('TEST_ALREADY_RUNNING');
    expect((await http.post(`/tasks/${id}/tests`).set(dashboard).send({ headSha: 'd'.repeat(40) })).body.code).toBe('TEST_COMMIT_MISMATCH');

    const { job, done } = await runTests((j) => COMMANDS.map((c) => ok(c)));
    expect(job).toMatchObject({ commitSha: HEAD, baseSha: BASE, headTree: TREE, task: { id, projectId: 'hello-world' } });
    expect(done).toMatchObject({ status: 'passed', commitSha: HEAD, error: null });
  });

  it('never lets a run be reported better than its process results', async () => {
    await setCommands();
    const runs: Array<[(j: any) => Result[], string | undefined, Record<string, unknown>, string]> = [
      [() => [ok(COMMANDS[0]), ok(COMMANDS[1], { exitCode: 1 })], 'passed', {}, 'failed'],               // claims passed, exit code 1
      [() => [ok(COMMANDS[0])], 'passed', {}, 'aborted'],                                                // one command missing
      [() => [ok(COMMANDS[0]), ok(COMMANDS[1], { status: 'aborted', exitCode: null, timedOut: true })], undefined, {}, 'aborted'],
      [() => [ok(COMMANDS[0]), ok(COMMANDS[1], { status: 'skipped', exitCode: null })], undefined, {}, 'skipped'],
      [() => [ok(COMMANDS[0]), ok({ ...COMMANDS[1], argv: ['sh', '-c', 'exit 0 # not approved'] })], 'passed', {}, 'failed'],   // other command
      [() => COMMANDS.map((c) => ok(c)), undefined, { commitSha: 'd'.repeat(40) }, 'failed'],          // evidence for another commit
    ];
    for (const [results, claimed, evidence, expected] of runs) {
      const id = await completedTask();
      const { done } = await runTests(results, claimed, evidence);
      expect({ id, status: done.status }).toEqual({ id, status: expected });
    }
  });

  it('refuses publish authorization unless tests passed on this commit with the current commands', async () => {
    await setCommands();
    const id = await completedTask();
    await approve(id);
    // still pending
    expect((await authorize(id, '00000000-0000-4000-8000-000000000000')).body.code).toBe('TEST_REPORT_MISSING');
    const { done } = await runTests(() => [ok(COMMANDS[0]), ok(COMMANDS[1], { exitCode: 2, status: 'failed' })]);
    expect(done.status).toBe('failed');
    expect((await authorize(id, '00000000-0000-4000-8000-000000000000')).body.code).toBe('TEST_FAILED');

    await http.post(`/tasks/${id}/tests`).set(dashboard).send({ headSha: HEAD }).expect(202);
    const passed = (await runTests(() => COMMANDS.map((c) => ok(c)))).done;
    expect(passed.status).toBe('passed');
    // without an eligible dry-run for this test run
    expect((await authorize(id, '00000000-0000-4000-8000-000000000000')).body.code).toBe('DRY_RUN_REQUIRED');
    const notEligible = await eligibleDryRun(id, passed.id, false);
    expect((await authorize(id, notEligible)).body.code).toBe('DRY_RUN_REQUIRED');
    const dryRun = await eligibleDryRun(id, passed.id);

    // admin changes the commands: the old run no longer counts
    await setCommands([COMMANDS[0]]);
    expect((await authorize(id, dryRun)).body.code).toBe('TEST_COMMANDS_CHANGED');
    await setCommands();

    const auth = (await authorize(id, dryRun).expect(201)).body;
    expect(auth).toMatchObject({ status: 'active', headSha: HEAD, testValidationId: passed.id, dryRunId: dryRun, repositoryId: 1296269, authorizedBy: 'dashboard:owner' });
    expect((await authorize(id, dryRun).expect(201)).body.id).toBe(auth.id); // same idempotency key: same authorization
    expect((await authorize(id, dryRun, 'auth-key-0002')).body.code).toBe('PUBLISH_ALREADY_AUTHORIZED');
    // nobody but an admin can authorize
    for (const as of [hermes, claude, runner, publisher]) {
      expect((await http.post(`/tasks/${id}/publication/authorize`).set(as).send({ headSha: HEAD, dryRunId: dryRun, idempotencyKey: 'auth-key-0003' })).status).toBe(403);
    }
    // a later dry-run sees the active authorization
    await http.post(`/tasks/${id}/publication/dry-run`).set(dashboard).send({ headSha: HEAD }).expect(202);
    const job = (await http.post('/internal/publisher/claim').set(publisher).expect(200)).body.job;
    expect(job.authorization).toMatchObject({ id: auth.id, status: 'active' });
    expect(job.testValidation).toMatchObject({ id: passed.id, status: 'passed', evidenceHash: expect.any(String) });
    expect(job.project.testCommands).toEqual(COMMANDS);
  });

  it('refuses authorization for unapproved reviews and wrong commits', async () => {
    await setCommands();
    const id = await completedTask();
    const passed = (await runTests(() => COMMANDS.map((c) => ok(c)))).done;
    expect((await authorize(id, '00000000-0000-4000-8000-000000000000')).body.code).toBe('REVIEW_NOT_APPROVED');
    await approve(id);
    expect((await http.post(`/tasks/${id}/publication/authorize`).set(dashboard).send({ headSha: 'd'.repeat(40), dryRunId: '00000000-0000-4000-8000-000000000000', idempotencyKey: 'auth-key-0001' })).body.code).toBe('COMMIT_MISMATCH');
    expect(passed.status).toBe('passed');
  });

  it('keeps publishing disabled by default', async () => {
    await setCommands();
    const id = await completedTask();
    await approve(id);
    const passed = (await runTests(() => COMMANDS.map((c) => ok(c)))).done;
    const auth = (await authorize(id, await eligibleDryRun(id, passed.id)).expect(201)).body;
    const res = await http.post(`/tasks/${id}/publication/publish`).set(dashboard).send({ authorizationId: auth.id, idempotencyKey: 'publish-0001' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PUBLISH_DISABLED');
    expect((await http.get(`/tasks/${id}/publication`).set(admin)).body).toMatchObject({ publishEnabled: false, authorization: { status: 'active' } });
  });

  it('publishes at most once per review, idempotently (publishing enabled, publisher played by the test)', async () => {
    await app.close();
    await boot({ publishEnabled: true });
    await setCommands();
    const id = await completedTask();
    await approve(id);
    const passed = (await runTests(() => COMMANDS.map((c) => ok(c)))).done;
    const auth = (await authorize(id, await eligibleDryRun(id, passed.id)).expect(201)).body;

    const first = (await http.post(`/tasks/${id}/publication/publish`).set(dashboard).send({ authorizationId: auth.id, idempotencyKey: 'publish-0001' }).expect(202)).body;
    const again = (await http.post(`/tasks/${id}/publication/publish`).set(dashboard).send({ authorizationId: auth.id, idempotencyKey: 'publish-0001' }).expect(202)).body;
    expect(again.id).toBe(first.id);
    expect((await http.post(`/tasks/${id}/publication/publish`).set(dashboard).send({ authorizationId: auth.id, idempotencyKey: 'publish-0002' })).body.code).toBe('PUBLISH_APPROVAL_REQUIRED');

    const job = (await http.post('/internal/publisher/claim').set(publisher).expect(200)).body.job;
    expect(job.publication).toMatchObject({ id: first.id, mode: 'publish', authorizationId: auth.id });
    expect(job.authorization).toMatchObject({ id: auth.id, status: 'used', publicationId: first.id });
    // a dry-run status is not a publish result
    expect((await http.post(`/internal/publisher/publications/${first.id}/result`).set(publisher).send({ status: 'ready', report: {} })).body.code).toBe('INVALID_RESULT');
    await http.post(`/internal/publisher/publications/${first.id}/result`).set(publisher).send({ status: 'pr_created', report: { pullRequestCreated: true } }).expect(200);
    expect((await http.get(`/tasks/${id}/publication`).set(admin)).body.state).toBe('pr_created');

    // a second authorization cannot lead to a second publication
    const dry2 = await eligibleDryRun(id, passed.id);
    const auth2 = (await authorize(id, dry2, 'auth-key-0009').expect(201)).body;
    expect((await http.post(`/tasks/${id}/publication/publish`).set(dashboard).send({ authorizationId: auth2.id, idempotencyKey: 'publish-0003' })).body.code).toBe('ALREADY_PUBLISHED');
  });

  it('expires publish authorizations', async () => {
    await app.close();
    await boot({ publishEnabled: true });
    await setCommands();
    const id = await completedTask();
    await approve(id);
    const passed = (await runTests(() => COMMANDS.map((c) => ok(c)))).done;
    const auth = (await authorize(id, await eligibleDryRun(id, passed.id)).expect(201)).body;
    clock.advance(31 * 60_000);
    expect((await http.post(`/tasks/${id}/publication/publish`).set(dashboard).send({ authorizationId: auth.id, idempotencyKey: 'publish-0001' })).body.code).toBe('PUBLISH_APPROVAL_REQUIRED');
    expect((await http.get(`/tasks/${id}/publication`).set(admin)).body.authorization.status).toBe('expired');
  });

  it('keeps the test runner to its own API', async () => {
    await setCommands();
    const id = await completedTask();
    for (const path of ['/tasks', `/tasks/${id}`, `/tasks/${id}/diff`, `/tasks/${id}/tests`, '/projects', '/reviews']) {
      expect((await http.get(path).set(runner)).status).toBe(403);
    }
    expect((await http.post('/internal/workers/claim').set(runner)).status).toBe(403);
    expect((await http.post('/internal/publisher/claim').set(runner)).status).toBe(403);
    for (const as of [admin, hermes, claude, publisher]) expect((await http.post('/internal/test-runner/claim').set(as)).status).toBe(403);
    for (const as of [hermes, claude, runner, publisher]) expect((await http.post(`/tasks/${id}/tests`).set(as).send({ headSha: HEAD })).status).toBe(403);
  });
});
