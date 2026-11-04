import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkerConfig } from '../config.js';

export const FAKE_CLAUDE = fileURLToPath(new URL('../../test-fixtures/fake-claude.mjs', import.meta.url));
export const FAKE_CODEX = fileURLToPath(new URL('../../test-fixtures/fake-codex.mjs', import.meta.url));

export async function tempDir(prefix: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return { path, cleanup: () => rm(path, { recursive: true, force: true, maxRetries: 5 }) };
}

export function testConfig(root: string, overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    agent: 'claude',
    workerId: 'claude-worker',
    controllerUrl: 'http://127.0.0.1:1',
    token: 'c'.repeat(40),
    workspaceRoot: join(root, 'workspace'),
    stateDir: join(root, 'state'),
    projects: null,
    writableProjects: null,
    repoCacheRoot: join(root, 'repo-cache'),
    maxRepoBytes: 100 * 1024 * 1024,
    artifactRoot: null,
    pollIntervalMs: 50,
    heartbeatIntervalMs: 100,
    taskTimeoutMs: 20_000,
    maxOutputBytes: 1024 * 1024,
    killGraceMs: 500,
    agentCommand: [process.execPath, FAKE_CLAUDE],
    model: null,
    ...overrides,
  };
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/**
 * Builds <cacheRoot>/<id>.git the way repo-sync does (bare, branches + tags) from an upstream
 * repository with hostile content: a filter in .gitattributes and hooks configured upstream and
 * in the cache, a symlink to /etc/passwd and a submodule entry. `rewrite()` replaces the history
 * (like a force push picked up by the next sync) and returns the new head.
 */
export async function makeCacheRepo(cacheRoot: string, id: string, marker: string) {
  const { execFileSync } = await import('node:child_process');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
  const upstream = join(cacheRoot, '..', `${id}-upstream`);
  const path = join(cacheRoot, `${id}.git`);
  mkdirSync(upstream, { recursive: true });
  mkdirSync(cacheRoot, { recursive: true });
  const posixMarker = marker.split('\\').join('/');
  const evil = `#!/bin/sh\ntouch '${posixMarker}'\n`;
  git(upstream, 'init', '-q', '-b', 'main');
  git(upstream, 'config', 'filter.evil.smudge', `sh -c "touch '${posixMarker}'"`);
  writeFileSync(join(upstream, '.git', 'hooks', 'post-checkout'), evil, { mode: 0o755 });
  writeFileSync(join(upstream, 'README.md'), `# ${id}\n`);
  writeFileSync(join(upstream, '.gitattributes'), '*.txt filter=evil\n');
  writeFileSync(join(upstream, '.gitmodules'), '[submodule "vendor"]\n\tpath = vendor\n\turl = https://example.com/vendor.git\n');
  git(upstream, 'add', 'README.md', '.gitattributes', '.gitmodules');
  // symlink and submodule entries written straight into the index, so this works on Windows too
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: upstream, input: '/etc/passwd', encoding: 'utf8' }).trim();
  git(upstream, 'update-index', '--add', '--cacheinfo', `120000,${blob},link`);
  git(upstream, 'update-index', '--add', '--cacheinfo', `160000,${'e'.repeat(40)},vendor`);
  git(upstream, 'commit', '-q', '-m', 'initial');
  git(upstream, 'tag', 'v1');
  git(cacheRoot, 'init', '-q', '--bare', path);
  writeFileSync(join(path, 'hooks', 'post-checkout'), evil, { mode: 0o755 });
  git(path, 'fetch', '-q', upstream, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*');
  git(path, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  return {
    path,
    head: git(path, 'rev-parse', 'refs/heads/main'),
    rewrite: async () => {
      git(upstream, 'checkout', '-q', '--orphan', 'replaced');
      writeFileSync(join(upstream, 'README.md'), `# ${id} (rewritten)\n`);
      git(upstream, 'add', '-A');
      git(upstream, 'commit', '-q', '-m', 'rewritten history');
      git(upstream, 'branch', '-q', '-M', 'main');
      git(path, 'fetch', '-q', '--force', '--prune', upstream, '+refs/heads/*:refs/heads/*');
      return git(path, 'rev-parse', 'refs/heads/main');
    },
  };
}
