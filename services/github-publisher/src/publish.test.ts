import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { PublisherConfig } from './config.js';
import { DisabledWriter, MockWriter } from './github.js';
import { Journal } from './journal.js';
import { handle } from './main.js';
import { baseConfig, fakeGitHub, fixture, g, KEY, makeJob, type FakeGitHub, type Fixture } from './testkit.js';

describe('publish requests (mock backend)', () => {
  let root: string;
  let f: Fixture;
  let config: PublisherConfig;
  let github: FakeGitHub;
  let writer: MockWriter;
  let journal: Journal;
  const reports: Array<{ id: string; status: string; report: Record<string, unknown> }> = [];
  const controller = { report: async (id: string, status: string, report: Record<string, unknown>) => void reports.push({ id, status, report }) };
  const deps = (over: Partial<Parameters<typeof handle>[1]> = {}) => ({ config, github, writer, journal, controller, evidenceKey: KEY, ...over });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'publish-'));
    f = fixture(root);
    config = { ...baseConfig(root, f), publishBackend: 'mock' };
    github = fakeGitHub(f);
    writer = new MockWriter();
    journal = new Journal(config.stateDir);
    reports.length = 0;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('publishes the approved commit once: same SHA, draft PR, AI provenance, journal', async () => {
    const job = makeJob(f, { mode: 'publish' });
    const { status, report } = await handle(job, deps());
    assert.equal(status, 'pr_created', JSON.stringify(report.blockers));
    assert.deepEqual(writer.pushes, [{ fullName: 'owner/hello', branch: `personal-ai/${f.taskId}`, headSha: f.head }]);
    assert.equal(writer.pullRequests.length, 1);
    assert.equal(report.pushPerformed, true);
    assert.equal(report.pullRequestCreated, true);
    assert.match(String((report.pullRequest as { body: string }).body), /created by an AI coding agent/);
    assert.equal(await journal.publishedReview('r-1'), true);
    // the worker's commit is untouched (no amend / rebase happened)
    assert.equal(g(f.worker, 'rev-parse', f.branch), f.head);

    // a duplicate request (e.g. after a restart) does not push or open anything again
    const again = await handle(makeJob(f, { mode: 'publish' }), deps({ journal: new Journal(config.stateDir) }));
    assert.equal(again.status, 'pr_created');
    assert.equal(again.report.alreadyPublished, job.publication.id);
    assert.equal(writer.pushes.length, 1);
    assert.equal(writer.pullRequests.length, 1);
  });

  it('refuses to publish without the separate publish authorization, or with an unusable one', async () => {
    for (const authorization of ['none', { status: 'active' }, { publicationId: 'other' }, { usedAt: new Date(Date.now() + 3600_000).toISOString() }] as const) {
      const { status, report } = await handle(makeJob(f, { mode: 'publish', authorization: authorization as never }), deps());
      assert.equal(status, 'failed');
      assert.equal(report.reason, 'PUBLISH_APPROVAL_REQUIRED', JSON.stringify(authorization));
    }
    assert.equal(writer.pushes.length, 0);
  });

  it('refuses commits without passing tests even with an authorization', async () => {
    const { status, report } = await handle(makeJob(f, { mode: 'publish', tests: null }), deps());
    assert.equal(status, 'failed');
    assert.equal(report.reason, 'TEST_REPORT_MISSING');
    assert.equal(writer.pushes.length, 0);
  });

  it('stays disabled with the default backend', async () => {
    const { status, report } = await handle(makeJob(f, { mode: 'publish' }), deps({ config: { ...config, publishBackend: 'disabled' }, writer: new DisabledWriter() as never }));
    assert.equal(status, 'failed');
    assert.equal(report.reason, 'PUBLISH_DISABLED');
    assert.equal(report.pushPerformed, false);
  });

  it('a dry-run never pushes, even when everything passes', async () => {
    const { status, report } = await handle(makeJob(f), deps());
    assert.equal(status, 'ready');
    assert.equal(report.canPublish, true);
    assert.equal(writer.pushes.length, 0);
    assert.equal(reports.at(-1)!.status, 'ready');
  });
});
