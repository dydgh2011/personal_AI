import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { RegistryProject, Task } from './controller-client.js';
import { localProject } from './testing/fake-controller.js';
import { makeCacheRepo, tempDir, testConfig } from './testing/helpers.js';
import { Workspace, WorkspaceError } from './workspace.js';

const task = (projectId: string | null, id = crypto.randomUUID()): Task => ({
  id, agent: 'claude', projectId, instruction: 'x', status: 'running', claimedBy: 'claude-worker', leaseExpiresAt: null, attempt: 1,
});
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const view = ({ allowedAgents: _a, enabled: _e, ...p }: ReturnType<typeof localProject>): RegistryProject => p;
const sandbox = view(localProject('sandbox'));
const docs = view(localProject('docs', { allowCodeChanges: false }));

describe('Workspace', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let workspace: Workspace;
  let root: string;
  let config: ReturnType<typeof testConfig>;

  beforeEach(async () => {
    dir = await tempDir('workspace-');
    config = testConfig(dir.path);
    root = config.workspaceRoot;
    workspace = new Workspace(config);
    await workspace.init();
  });

  afterEach(() => dir.cleanup());

  it('creates the sandbox repository once', async () => {
    assert.equal(git(join(root, 'sandbox'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    await workspace.init();
    assert.equal(git(join(root, 'sandbox'), 'rev-list', '--count', 'HEAD'), '1');
  });

  it('rejects missing, unregistered, restricted and path-like projects', async () => {
    const rejects = (projectId: string | null, project: RegistryProject | null, pattern: RegExp, ws = workspace) =>
      assert.rejects(ws.prepare(task(projectId), project), (e: Error) => e instanceof WorkspaceError && pattern.test(e.message));
    await rejects(null, null, /no projectId/);
    await rejects('../etc', null, /Invalid projectId/);
    await rejects('SANDBOX', null, /Invalid projectId/);
    await rejects('other', null, /not enabled for claude in the project registry/);
    await rejects('sandbox', docs, /not enabled for claude in the project registry/, workspace); // registry entry for another id
    await rejects('docs', docs, /does not exist/);
    await mkdir(join(root, 'docs'));
    await rejects('docs', docs, /not a git repository root/);
    // WORKER_PROJECTS still restricts on top of the registry
    const restricted = new Workspace({ ...config, projects: ['docs'] });
    await rejects('sandbox', sandbox, /not enabled on this worker \(WORKER_PROJECTS\)/, restricted);
  });

  it('refuses a project that is a symlink out of the workspace', { skip: process.platform === 'win32' }, async () => {
    const outside = join(dir.path, 'outside');
    await mkdir(outside);
    git(outside, 'init', '-q');
    await symlink(outside, join(root, 'docs'));
    await assert.rejects(workspace.prepare(task('docs'), docs), /outside the workspace/);
  });

  it('runs writable tasks in their own worktree and commits changes on the task branch only', async () => {
    const t = task('sandbox');
    const prepared = await workspace.prepare(t, sandbox);
    assert.equal(prepared.mode, 'write');
    assert.equal(prepared.branch, `claude/task-${t.id}`);
    assert.equal(prepared.cwd, workspace.worktreePath(t.id));

    await writeFile(join(prepared.cwd, 'index.html'), '<h1>hi</h1>');
    const summary = await workspace.finalize(prepared, 'task commit');
    assert.ok(summary.commit);
    assert.deepEqual(summary.changedFiles, [{ status: 'A', path: 'index.html' }]);
    assert.equal(git(prepared.cwd, 'log', '-1', '--format=%an'), 'claude-worker');

    // main checkout and main branch are untouched; the branch is kept
    assert.equal(existsSync(join(root, 'sandbox', 'index.html')), false);
    assert.equal(git(join(root, 'sandbox'), 'rev-list', '--count', 'main'), '1');
    assert.equal(git(join(root, 'sandbox'), 'branch', '--list', `claude/task-${t.id}`).replace('+', '').trim(), `claude/task-${t.id}`);
  });

  it('does not commit when nothing changed', async () => {
    const prepared = await workspace.prepare(task('sandbox'), sandbox);
    const summary = await workspace.finalize(prepared, 'nothing');
    assert.equal(summary.commit, null);
    assert.deepEqual(summary.changedFiles, []);
  });

  it('never runs the same task twice', async () => {
    const t = task('sandbox');
    await workspace.prepare(t, sandbox);
    await assert.rejects(workspace.prepare(t, sandbox), /refusing to run the task twice/);
  });

  it('does not run repository hooks when committing', async () => {
    const hook = join(root, 'sandbox', '.git', 'hooks', 'pre-commit');
    const marker = join(dir.path, 'hook-ran');
    await writeFile(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    const prepared = await workspace.prepare(task('sandbox'), sandbox);
    await writeFile(join(prepared.cwd, 'a.txt'), 'a');
    await workspace.finalize(prepared, 'commit');
    assert.equal(existsSync(marker), false);
  });

  it('runs projects without allowCodeChanges read-only in place, also when WORKER_WRITABLE_PROJECTS says otherwise', async () => {
    await mkdir(join(root, 'docs'));
    git(join(root, 'docs'), 'init', '-q');
    const prepared = await workspace.prepare(task('docs'), docs);
    assert.equal(prepared.mode, 'read');
    assert.equal(prepared.branch, null);
    assert.equal((await workspace.finalize(prepared, 'n/a')).commit, null);
    const restricted = new Workspace({ ...config, writableProjects: [] });
    assert.equal((await restricted.prepare(task('sandbox'), sandbox)).mode, 'read');
  });

  describe('GitHub projects from the repository cache', () => {
    let cache: Awaited<ReturnType<typeof makeCacheRepo>>;
    let project: RegistryProject;
    let marker: string;

    beforeEach(async () => {
      marker = join(dir.path, 'PWNED');
      cache = await makeCacheRepo(config.repoCacheRoot, 'hello', marker);
      project = { id: 'hello', source: 'github', defaultBranch: 'main', allowCodeChanges: true, cachedHeadSha: cache.head, syncStatus: 'synced' };
    });

    it('checks out the registry commit in a worktree of an independent clone and commits on the task branch', async () => {
      const t = task('hello');
      const prepared = await workspace.prepare(t, project);
      assert.equal(prepared.mode, 'write');
      assert.equal(prepared.source, 'github');
      assert.equal(prepared.baseCommit, cache.head);
      assert.equal(git(prepared.cwd, 'rev-parse', 'HEAD'), cache.head);
      assert.equal(readFileSync(join(prepared.cwd, 'README.md'), 'utf8'), '# hello\n');

      // hostile content is inert: no hook ran on checkout, the symlink is a plain file, the submodule is empty
      assert.equal(existsSync(marker), false, 'no hook or filter ran');
      assert.equal(readFileSync(join(prepared.cwd, 'link'), 'utf8'), '/etc/passwd', 'symlink checked out as a plain file');
      assert.deepEqual(prepared.notes, ['1 symlink(s) checked out as plain files (core.symlinks=false)', '1 submodule(s) not initialised']);

      await writeFile(join(prepared.cwd, 'CHANGELOG.md'), 'change\n');
      const summary = await workspace.finalize(prepared, 'task commit');
      assert.deepEqual(summary.changedFiles, [{ status: 'A', path: 'CHANGELOG.md' }]);
      assert.equal(existsSync(marker), false, 'no hook ran on commit');

      const clone = join(root, 'repos', 'hello.git');
      assert.equal(existsSync(join(clone, 'objects', 'info', 'alternates')), false, 'no alternates: objects are copied');
      assert.equal(git(clone, 'rev-parse', `claude/task-${t.id}`), summary.commit);
      assert.equal(git(clone, 'rev-parse', 'refs/remotes/origin/main'), cache.head);
      assert.equal(git(cache.path, 'rev-parse', 'refs/heads/main'), cache.head, 'cache untouched');
      assert.equal(git(cache.path, 'for-each-ref', '--format=%(refname)').includes('task-'), false, 'nothing written to the cache');
    });

    it('exports exactly the task commits as a git bundle for the publisher', async () => {
      const artifacts = join(dir.path, 'artifacts');
      const ws = new Workspace({ ...config, artifactRoot: artifacts });
      const t = task('hello');
      const prepared = await ws.prepare(t, project);
      await writeFile(join(prepared.cwd, 'CHANGELOG.md'), 'change\n');
      const summary = await ws.finalize(prepared, 'task commit');
      assert.equal(summary.artifactError, undefined);

      const manifest = JSON.parse(readFileSync(join(artifacts, `${t.id}.json`), 'utf8'));
      const bundle = readFileSync(join(artifacts, `${t.id}.bundle`));
      assert.deepEqual(
        { format: manifest.format, taskId: manifest.taskId, agent: manifest.agent, projectId: manifest.projectId, branch: manifest.branch, baseSha: manifest.baseSha, headSha: manifest.headSha },
        { format: 'personal-ai-artifact/v1', taskId: t.id, agent: 'claude', projectId: 'hello', branch: `claude/task-${t.id}`, baseSha: cache.head, headSha: summary.commit },
      );
      assert.equal(manifest.bundleSha256, createHash('sha256').update(bundle).digest('hex'));
      assert.deepEqual(summary.artifact, { bundleSha256: manifest.bundleSha256, bundleBytes: bundle.length });

      // the bundle needs the base (from the cache) and carries only the task branch
      const verifier = join(dir.path, 'verify.git');
      git(dir.path, 'init', '-q', '--bare', verifier);
      assert.throws(() => git(verifier, 'bundle', 'verify', join(artifacts, `${t.id}.bundle`)), /lacks|prerequisite|missing/i);
      git(verifier, 'fetch', '-q', cache.path, 'refs/heads/main:refs/heads/main');
      git(verifier, 'bundle', 'verify', '-q', join(artifacts, `${t.id}.bundle`));
      assert.equal(git(verifier, 'bundle', 'list-heads', join(artifacts, `${t.id}.bundle`)), `${summary.commit} refs/heads/claude/task-${t.id}`);

      // export-artifact refuses a branch that no longer points at the given head, and other tasks' branches
      const repo = ws.githubRepoPath('hello');
      await assert.rejects(ws.exportArtifact(repo, t.id, 'hello', `claude/task-${t.id}`, cache.head, cache.head), /no commit|is at/);
      await assert.rejects(ws.exportArtifact(repo, t.id, 'hello', 'main', cache.head, summary.commit!), /Unexpected task branch/);
      assert.equal(await ws.branchHead(repo, `claude/task-${t.id}`), summary.commit);
    });

    it('keeps task commits intact when the cache is rewritten and garbage-collected afterwards', async () => {
      const t = task('hello');
      const prepared = await workspace.prepare(t, project);
      await writeFile(join(prepared.cwd, 'a.txt'), 'a');
      const { commit } = await workspace.finalize(prepared, 'task commit');

      // repo-sync later sees a force-pushed history and the old objects disappear from the cache
      const replaced = await cache.rewrite();
      git(cache.path, 'reflog', 'expire', '--expire=now', '--all');
      git(cache.path, 'gc', '-q', '--prune=now');

      const clone = join(root, 'repos', 'hello.git');
      assert.equal(git(clone, 'cat-file', '-t', commit!), 'commit');
      assert.equal(git(clone, 'fsck', '--no-dangling', '--no-progress'), '');
      // the next task fetches the new history without touching the old task branch
      const next = await workspace.prepare(task('hello'), { ...project, cachedHeadSha: replaced });
      assert.equal(next.baseCommit, replaced);
      assert.equal(git(clone, 'rev-parse', `claude/task-${t.id}`), commit);
    });

    it('refuses unsynced projects, a commit missing from the cache, an oversized cache and a missing cache', async () => {
      await assert.rejects(workspace.prepare(task('hello'), { ...project, syncStatus: 'not_synced' }), /has not been synced/);
      await assert.rejects(workspace.prepare(task('hello'), { ...project, cachedHeadSha: null }), /has not been synced/);
      await assert.rejects(workspace.prepare(task('hello'), { ...project, cachedHeadSha: 'f'.repeat(40) }), /does not contain the registry commit/);
      await assert.rejects(new Workspace({ ...config, maxRepoBytes: 1024 }).prepare(task('hello'), project), /byte limit/);
      await assert.rejects(workspace.prepare(task('other'), { ...project, id: 'other' }), /not in the repository cache/);
    });

    it('checks out read-only projects detached, without a branch or commit', async () => {
      const prepared = await workspace.prepare(task('hello'), { ...project, allowCodeChanges: false });
      assert.equal(prepared.mode, 'read');
      assert.equal(prepared.branch, null);
      assert.equal(git(prepared.cwd, 'rev-parse', 'HEAD'), cache.head);
      await writeFile(join(prepared.cwd, 'x.txt'), 'x');
      assert.equal((await workspace.finalize(prepared, 'n/a')).commit, null);
    });

    it('refuses a cache entry that is not a bare repository or escapes the cache root', async () => {
      await mkdir(join(config.repoCacheRoot, 'plain.git'));
      await assert.rejects(workspace.prepare(task('plain'), { ...project, id: 'plain' }), /not a bare repository/);
      if (process.platform !== 'win32') {
        await symlink(dir.path, join(config.repoCacheRoot, 'outside.git'));
        await assert.rejects(workspace.prepare(task('outside'), { ...project, id: 'outside' }), /outside the cache root|not a bare/);
      }
    });
  });
});

describe('Workspace review diff', () => {
  let dir: Awaited<ReturnType<typeof tempDir>>;
  let workspace: Workspace;

  beforeEach(async () => {
    dir = await tempDir('workspace-diff-');
    workspace = new Workspace(testConfig(dir.path));
    await workspace.init();
  });

  afterEach(() => dir.cleanup());

  it('records counts, commit message and a patch without binary or sensitive content', async () => {
    const prepared = await workspace.prepare(task('sandbox'), view(localProject('sandbox')));
    await writeFile(join(prepared.cwd, 'README.md'), '# sandbox\n\nchanged\n');
    await writeFile(join(prepared.cwd, 'app.js'), 'console.log(1);\nconsole.log(2);\n');
    await writeFile(join(prepared.cwd, '.env'), 'PASSWORD=hunter2\n');
    await writeFile(join(prepared.cwd, 'config.js'), `const key = "ghp_${'a'.repeat(36)}";\n`);
    await writeFile(join(prepared.cwd, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 3]));
    const { diff, commit } = await workspace.finalize(prepared, 'Add files\n\nbody line');
    assert.ok(diff);
    assert.equal(diff.headCommit, commit);
    assert.equal(diff.baseCommit, prepared.baseCommit);
    assert.match(diff.headTree, /^[0-9a-f]{40}$/);
    assert.equal(diff.commitMessage, 'Add files\n\nbody line');
    const byPath = Object.fromEntries(diff.files.map((f) => [f.path, f]));
    assert.deepEqual([byPath['app.js'].additions, byPath['app.js'].deletions, byPath['app.js'].status], [2, 0, 'A']);
    assert.equal(byPath['logo.png'].binary, true);
    assert.equal(byPath['.env'].sensitive, true);
    assert.equal(byPath['config.js'].sensitive, true, 'secret-looking content');
    assert.match(diff.patch, /console\.log\(2\)/);
    assert.ok(!diff.patch.includes('hunter2') && !diff.patch.includes('ghp_') && !diff.patch.includes('logo.png'));
    assert.deepEqual(diff.omittedFiles.sort(), ['.env', 'config.js', 'logo.png']);
    assert.equal(diff.patchTruncated, false);
  });

  it('cuts large patches and lists the files left out', async () => {
    const prepared = await workspace.prepare(task('sandbox'), view(localProject('sandbox')));
    await writeFile(join(prepared.cwd, 'a.txt'), 'x\n'.repeat(60_000));
    await writeFile(join(prepared.cwd, 'b.txt'), 'y\n'.repeat(60_000));
    const { diff } = await workspace.finalize(prepared, 'big');
    assert.equal(diff?.patchTruncated, true);
    assert.ok(diff!.patch.length <= 200_000);
    assert.equal(diff!.omittedFiles.length, 1);
    assert.equal(diff!.additions, 120_000);
  });
});
