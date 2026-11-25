import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { PublisherConfig } from './config.js';
import { Journal } from './journal.js';
import { baseConfig, COMMANDS, fakeGitHub, FakeGitHub, fixture, g, KEY, makeJob, OWNER, type Fixture, type Over } from './testkit.js';
import { hasAgentTrace, verifyPublication } from './verify.js';

describe('preflight gate', () => {
  let root: string;
  let f: Fixture;
  let config: PublisherConfig;
  let github: FakeGitHub;
  const run = (over: Over = {}, cfg = config) => verifyPublication(makeJob(f, over), { config: cfg, github, evidenceKey: KEY });
  const failed = (r: Awaited<ReturnType<typeof run>>) => r.checks.filter((c) => !c.ok).map((c) => c.id);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'publisher-'));
    f = fixture(root);
    config = baseConfig(root, f);
    github = fakeGitHub(f);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('7. everything satisfied: eligible and publishable, nothing written, owner author kept', async () => {
    const r = await run();
    assert.deepEqual(failed(r), []);
    assert.equal(r.eligible, true);
    assert.equal(r.canPublish, true);
    assert.equal(r.reason, null);
    assert.equal(r.gitVerified, true);
    assert.deepEqual(r.policy, { tests: 'required', commitAuthor: 'owner' });
    assert.deepEqual(r.author, { name: OWNER.name, email: OWNER.email, committerName: OWNER.name, committerEmail: OWNER.email, message: f.message });
    assert.equal(r.tests.signatureValid, true);
    assert.deepEqual(r.tests.commands.map((c) => c.exitCode), [0, 0]);
    assert.equal(r.pushPerformed, false);
    assert.equal(r.pullRequestCreated, false);
    assert.equal(r.pullRequest?.draft, true);
    // The pull request reads as the owner's own: no agent, worker, task or tool names.
    assert.equal(r.pullRequest!.title, 'Add notes');
    assert.equal(hasAgentTrace(`${r.pullRequest!.title}\n${r.pullRequest!.body}`), false);
    assert.doesNotMatch(`${r.pullRequest!.title}\n${r.pullRequest!.body}`, /codex|claude|worker|agent|task/i);
    assert.equal(g(f.upstream, 'for-each-ref', '--format=%(refname)'), 'refs/heads/main');
    // checks are listed in preflight order
    assert.deepEqual(r.checks.map((c) => c.id).slice(0, 2), ['task_completed', 'review_approved']);
    assert.equal(r.checks.at(-1)!.id, 'publish_authorization');
  });

  it('6. approved and tested but not authorized for publishing: eligible, PUBLISH_APPROVAL_REQUIRED', async () => {
    const r = await run({ authorization: 'none' });
    assert.equal(r.eligible, true);
    assert.equal(r.canPublish, false);
    assert.equal(r.reason, 'PUBLISH_APPROVAL_REQUIRED');
    for (const auth of [{ status: 'expired' }, { expiresAt: new Date(Date.now() - 1000).toISOString() }, { headSha: 'd'.repeat(40) }, { testValidationId: 'other' }, { repositoryId: 7 }, { reviewId: 'r-0' }]) {
      const res = await run({ authorization: auth });
      assert.equal(res.reason, 'PUBLISH_APPROVAL_REQUIRED', JSON.stringify(auth));
    }
  });

  it('1-3. POLICY A: missing, failed, interrupted or skipped tests block publishing', async () => {
    const cases: Array<[Over['tests'], string]> = [
      [null, 'TEST_REPORT_MISSING'],
      [{ status: 'pending' }, 'TEST_REPORT_MISSING'],
      [{ status: 'failed', results: [{ ...COMMANDS[0], status: 'passed', exitCode: 0, timedOut: false }, { ...COMMANDS[1], status: 'failed', exitCode: 1, timedOut: false }] }, 'TEST_FAILED'],
      [{ status: 'aborted', results: [{ ...COMMANDS[0], status: 'passed', exitCode: 0, timedOut: false }, { ...COMMANDS[1], status: 'aborted', exitCode: null, timedOut: true }] }, 'TEST_ABORTED'],
      [{ status: 'skipped', results: [{ ...COMMANDS[0], status: 'passed', exitCode: 0, timedOut: false }, { ...COMMANDS[1], status: 'skipped', exitCode: null, timedOut: false }] }, 'TEST_SKIPPED'],
    ];
    for (const [tests, code] of cases) {
      const r = await run({ tests });
      assert.equal(r.reason, code, JSON.stringify(tests));
      assert.equal(r.eligible, false);
      assert.equal(r.canPublish, false);
    }
    // no approved commands configured (e.g. a "documentation only" project): not exempt
    assert.equal((await run({ project: { testCommands: [] } })).reason, 'TEST_REPORT_MISSING');
  });

  it('POLICY A: results the runner did not sign, or that were altered, are not evidence', async () => {
    assert.equal((await run({ tests: { key: randomBytes(32) } })).reason, 'TEST_EVIDENCE_INVALID');           // forged signature
    assert.equal((await run({ tests: { tamper: true, status: 'failed', results: [{ ...COMMANDS[0], status: 'failed', exitCode: 1, timedOut: false }, { ...COMMANDS[1], status: 'passed', exitCode: 0, timedOut: false }] } })).reason, 'TEST_EVIDENCE_INVALID');
    assert.equal((await run({ tests: { evidence: { status: 'failed' } } })).reason, 'TEST_EVIDENCE_INVALID'); // stored status differs from evidence
    // claims of passing tests in the worker report (the LLM's own statement) change nothing
    const claimed = await run({ tests: null, reported: { tests: { passed: true, summary: 'All tests pass!' } } });
    assert.equal(claimed.reason, 'TEST_REPORT_MISSING');
    assert.ok(claimed.warnings.some((w) => w.startsWith('agent_test_claims_ignored')));
    const noKey = await verifyPublication(makeJob(f), { config, github, evidenceKey: null });
    assert.equal(noKey.reason, 'TEST_EVIDENCE_INVALID');
  });

  it('5. POLICY A: a test run of another commit, or with other commands, does not count', async () => {
    assert.equal((await run({ tests: { commitSha: 'd'.repeat(40) } })).reason, 'TEST_COMMIT_MISMATCH');
    assert.equal((await run({ tests: { evidence: { treeSha: 'd'.repeat(40) } } })).reason, 'TEST_COMMIT_MISMATCH');
    assert.equal((await run({ project: { testCommands: [COMMANDS[0]] } })).reason, 'TEST_COMMANDS_CHANGED');
  });

  it('4. review not approved (tests passing) is blocked first', async () => {
    for (const review of [{ status: 'awaiting_approval' }, { status: 'rejected' }, { status: 'invalidated' }]) {
      const r = await run({ review });
      assert.equal(r.reason, 'REVIEW_NOT_APPROVED');
      assert.equal(r.canPublish, false);
    }
    assert.equal((await run({ review: null })).reason, 'REVIEW_NOT_APPROVED');
    assert.equal((await run({ task: { status: 'running' } })).reason, 'TASK_NOT_COMPLETED');
  });

  it('9. the commit changed after approval: COMMIT_MISMATCH / FILES_MISMATCH', async () => {
    writeFileSync(join(f.worker, 'extra.txt'), 'unreviewed\n');
    g(f.worker, 'add', '-A');
    g(f.worker, 'commit', '-q', '-m', 'unreviewed change');
    f.writeArtifact();
    const r = await run();
    assert.equal(r.reason, 'COMMIT_MISMATCH');
    assert.ok(r.reasons.includes('FILES_MISMATCH'));
    assert.equal(r.canPublish, false);
  });

  it('tree and file list must match what was approved', async () => {
    assert.equal((await run({ review: { headTree: 'f'.repeat(40) } })).reason, 'TREE_MISMATCH');
    const files = await run({ reported: { files: [{ path: 'README.md', status: 'M', binary: false, sensitive: false }] } });
    assert.equal(files.reason, 'FILES_MISMATCH');
    assert.match(files.blockers[0], /not shown at approval: \[A NOTES.md\]/);
  });

  it('10. remote default branch moved: REMOTE_BASE_CHANGED (no rebase, no merge)', async () => {
    github.branches.set('owner/hello#main', 'd'.repeat(40));
    const r = await run();
    assert.equal(r.reason, 'REMOTE_BASE_CHANGED');
    assert.equal(r.gitVerified, true);
    assert.match(r.blockers[0], /review it again/);
  });

  it('11. repositories outside the allowlist or not matching the registry are refused', async () => {
    assert.equal((await run({}, { ...config, allowedRepositories: [] })).reason, 'REPOSITORY_NOT_ALLOWED');
    assert.equal((await run({ project: { enabled: false } })).reason, 'REPOSITORY_NOT_ALLOWED');
    // a registry URL that does not match also fails the trusted-copy identity check (step 5, earlier)
    assert.ok((await run({ project: { remoteUrl: 'https://github.com/evil/hello.git' } })).reasons.includes('REPOSITORY_NOT_ALLOWED'));
    github.repos.set('owner/hello', { id: 7, fullName: 'owner/hello', defaultBranch: 'main', private: false });
    assert.equal((await run()).reason, 'REMOTE_REPOSITORY_MISMATCH');
    github.repos.clear();
    assert.equal((await run({ project: { visibility: 'private' } })).reason, 'REMOTE_REPOSITORY_MISMATCH');
  });

  it('objects from another repository and damaged artifacts are refused', async () => {
    const other = join(root, 'other');
    mkdirSync(other);
    g(other, 'init', '-q');
    writeFileSync(join(other, 'a.txt'), 'a');
    g(other, 'add', '-A');
    g(other, 'commit', '-q', '-m', 'other base');
    const otherBase = g(other, 'rev-parse', 'HEAD');
    g(other, 'checkout', '-q', '-b', f.branch);
    writeFileSync(join(other, 'NOTES.md'), 'x');
    g(other, 'add', '-A');
    g(other, 'commit', '-q', '-m', 'evil');
    const otherHead = g(other, 'rev-parse', 'HEAD');
    f.writeArtifact(other, `refs/heads/${f.branch}`, otherBase, { baseSha: otherBase, headSha: otherHead });
    const r = await run({ headSha: otherHead, review: { baseSha: otherBase, headTree: g(other, 'rev-parse', 'HEAD^{tree}') }, reported: { baseSha: otherBase } });
    assert.ok(r.reasons.includes('BASE_INVALID'));
    assert.ok(r.reasons.includes('ARTIFACT_INVALID'));
    assert.equal(r.gitVerified, false);

    f.writeArtifact();
    const bundle = join(f.artifacts, `${f.taskId}.bundle`);
    const data = readFileSync(bundle);
    data[data.length - 5] ^= 0xff;
    writeFileSync(bundle, data);
    assert.equal((await run()).reason, 'ARTIFACT_INVALID');
    unlinkSync(join(f.artifacts, `${f.taskId}.json`));
    assert.match((await run()).blockers.join('\n'), /artifact missing/);
  });

  it('incomplete reviews (truncated, sensitive, binary, no patch) are refused', async () => {
    for (const reported of [{ patchTruncated: true, omittedFiles: ['NOTES.md'] }, { files: [{ path: 'NOTES.md', status: 'A', binary: false, sensitive: true }], omittedFiles: ['NOTES.md'] }, { patchRecorded: false }]) {
      assert.equal((await run({ reported })).reason, 'REVIEW_INCOMPLETE');
    }
  });

  it('existing target branch is reported (duplicate publication)', async () => {
    github.branches.set(`owner/hello#personal-ai/${f.taskId}`, f.head);
    const r = await run();
    assert.equal(r.reason, 'TARGET_BRANCH_EXISTS');
    // in publish mode the same branch at the approved head is the idempotent re-run
    const p = await verifyPublication(makeJob(f, { mode: 'publish' }), { config, github, evidenceKey: KEY });
    assert.equal(p.reason, null);
  });

  it('journals runs and remembers them after a restart', async () => {
    const first = new Journal(config.stateDir);
    await first.append({ at: 'x', publicationId: 'p1', taskId: f.taskId, reviewId: 'r-1', headSha: f.head, mode: 'dry-run', outcome: 'ready', blockers: [], reported: true });
    const reopened = new Journal(config.stateDir);
    assert.equal((await reopened.entries()).length, 1);
    assert.equal(await reopened.publishedReview('r-1'), false, 'a dry-run is not a publication');
  });
});

describe('POLICY B: commits only as the owner, no agent trace', () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('8. a commit whose author or committer is not the project commit author is refused', async () => {
    root = mkdtempSync(join(tmpdir(), 'publisher-author-'));
    const f = fixture(root, { author: 'Some User', email: 'user@example.com' });
    const r = await verifyPublication(makeJob(f), { config: baseConfig(root, f), github: fakeGitHub(f), evidenceKey: KEY });
    assert.equal(r.reason, 'AUTHOR_CHANGED');
    assert.match(r.blockers[0], /Some User <user@example.com>/);
    assert.equal(r.canPublish, false);
  });

  it('a project without a commit author cannot be published', async () => {
    root = mkdtempSync(join(tmpdir(), 'publisher-noauthor-'));
    const f = fixture(root);
    const r = await verifyPublication(makeJob(f, { project: { commitAuthor: null } }), { config: baseConfig(root, f), github: fakeGitHub(f), evidenceKey: KEY });
    assert.equal(r.reason, 'AUTHOR_CHANGED');
    assert.match(r.blockers.join('\n'), /no commit author is set/);
  });

  it('the old worker identity is refused', async () => {
    root = mkdtempSync(join(tmpdir(), 'publisher-worker-'));
    const f = fixture(root, { author: 'codex-worker', email: 'codex-worker@personal-ai.local' });
    const r = await verifyPublication(makeJob(f), { config: baseConfig(root, f), github: fakeGitHub(f), evidenceKey: KEY });
    assert.equal(r.canPublish, false);
    assert.ok(r.reasons.includes('AUTHOR_CHANGED'));
    assert.ok(r.reasons.includes('AGENT_TRACE'));
  });

  for (const trace of [
    'Add notes\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
    'Add notes\n\nCo-authored-by: Someone Else <s@example.com>',
    'Add notes\n\n\u{1F916} Generated with [Claude Code](https://claude.com/claude-code)',
    'codex-worker: task 123 (completed)\n\nAdd notes',
  ]) {
    it(`a commit message with an agent trace is refused: ${JSON.stringify(trace.split('\n').at(-1))}`, async () => {
      root = mkdtempSync(join(tmpdir(), 'publisher-trace-'));
      const f = fixture(root, { message: trace });
      const r = await verifyPublication(makeJob(f), { config: baseConfig(root, f), github: fakeGitHub(f), evidenceKey: KEY });
      assert.equal(r.reason, 'AGENT_TRACE');
      assert.equal(r.canPublish, false);
    });
  }

  it('ordinary words are not traces', () => {
    assert.equal(hasAgentTrace('Fix the Gemini provider timeout'), false);
    assert.equal(hasAgentTrace('Add OpenAI-compatible endpoint docs'), false);
  });

  it('a commit message different from the reviewed one is refused', async () => {
    root = mkdtempSync(join(tmpdir(), 'publisher-message-'));
    const f = fixture(root);
    const job = makeJob(f, { reported: { commitMessage: 'something else' } });
    const r = await verifyPublication(job, { config: baseConfig(root, f), github: fakeGitHub(f), evidenceKey: KEY });
    assert.equal(r.reason, 'AUTHOR_CHANGED');
  });
});
