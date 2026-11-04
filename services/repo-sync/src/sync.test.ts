import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { cachePath, syncRepository, validateUrl, type SyncOptions } from './sync.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

describe('repo-sync', () => {
  let dir: string;
  let upstream: string;
  let cache: string;
  let marker: string;
  let options: SyncOptions;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'repo-sync-'));
    upstream = join(dir, 'upstream');
    cache = join(dir, 'cache');
    marker = join(dir, 'PWNED');
    mkdirSync(cache);
    mkdirSync(upstream);
    git(upstream, 'init', '-q', '-b', 'main');
    // Hostile content: a filter and a hook script in the tree, a submodule, and a hook in the upstream's own .git.
    const evil = `#!/bin/sh\ntouch '${marker.replace(/\\/g, '/')}'\n`;
    writeFileSync(join(upstream, '.gitattributes'), '* filter=evil\n');
    writeFileSync(join(upstream, '.gitmodules'), '[submodule "x"]\n\tpath = x\n\turl = https://example.com/x.git\n');
    mkdirSync(join(upstream, 'hooks'));
    writeFileSync(join(upstream, 'hooks', 'post-checkout'), evil, { mode: 0o755 });
    writeFileSync(join(upstream, '.git', 'hooks', 'post-checkout'), evil, { mode: 0o755 });
    writeFileSync(join(upstream, 'README.md'), '# upstream\n');
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '-q', '-m', 'initial');
    git(upstream, 'tag', 'v1');
    options = {
      cacheRoot: cache,
      id: 'hello',
      url: pathToFileURL(upstream).href,
      branch: 'main',
      timeoutMs: 30_000,
      maxBytes: 50 * 1024 * 1024,
      maxCacheBytes: 200 * 1024 * 1024,
      maxFileBytes: 10 * 1024 * 1024,
      token: null,
      allowFileUrlsForTests: true,
    };
  });

  afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));

  it('accepts only credential-free https://github.com URLs', () => {
    assert.equal(validateUrl('https://github.com/octocat/Hello-World.git'), 'https://github.com/octocat/Hello-World.git');
    assert.equal(validateUrl('https://github.com/octocat/Hello-World'), 'https://github.com/octocat/Hello-World');
    for (const bad of [
      'https://user:token@github.com/a/b.git',
      'https://x-access-token@github.com/a/b.git',
      'http://github.com/a/b.git',
      'https://github.com.evil.com/a/b.git',
      'https://evil.com/a/b.git',
      'ssh://git@github.com/a/b.git',
      'git@github.com:a/b.git',
      'ext::sh -c touch% /tmp/x',
      'file:///etc',
      'https://github.com/a/b.git?x=1',
      'https://github.com/a/../../b',
      'https://github.com:8443/a/b.git',
    ]) {
      assert.throws(() => validateUrl(bad), /Only https:\/\/github.com/, bad);
    }
  });

  it('keeps cache paths inside the cache root', async () => {
    assert.equal(await cachePath(cache, 'hello'), join(await (await import('node:fs/promises')).realpath(cache), 'hello.git'));
    for (const bad of ['../hello', 'a/b', '..', '', 'Hello', '.git']) {
      await assert.rejects(cachePath(cache, bad), /Invalid project id/, bad);
    }
  });

  it('mirrors branches and tags into a bare repository without checking anything out or running hooks', async () => {
    const result = await syncRepository(options);
    assert.equal(result.created, true);
    assert.equal(result.headSha, git(upstream, 'rev-parse', 'HEAD'));
    assert.equal(result.refs, 2); // refs/heads/main + refs/tags/v1
    const path = result.path;
    assert.equal(git(path, 'rev-parse', '--is-bare-repository'), 'true');
    assert.equal(git(path, 'config', '--get', 'core.hooksPath'), '/dev/null');
    assert.equal(git(path, 'config', '--get', 'transfer.fsckObjects'), 'true');
    assert.ok(!readdirSync(path).includes('README.md'), 'no working tree');
    assert.ok(!existsSync(join(path, 'hooks', 'post-checkout')), 'upstream hooks are not transferred');
    assert.equal(existsSync(marker), false, 'no hook or filter ran');
  });

  it('fetches new commits, prunes deleted branches and reuses only its own repository', async () => {
    const first = await syncRepository(options);
    git(upstream, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(upstream, 'b.txt'), 'b');
    git(upstream, 'add', 'b.txt');
    git(upstream, 'commit', '-q', '-m', 'feature');
    git(upstream, 'checkout', '-q', 'main');
    writeFileSync(join(upstream, 'c.txt'), 'c');
    git(upstream, 'add', 'c.txt');
    git(upstream, 'commit', '-q', '-m', 'second');

    const second = await syncRepository(options);
    assert.equal(second.created, false);
    assert.notEqual(second.headSha, first.headSha);
    assert.equal(second.headSha, git(upstream, 'rev-parse', 'main'));
    assert.equal(second.refs, 3);

    git(upstream, 'branch', '-q', '-D', 'feature');
    assert.equal((await syncRepository(options)).refs, 2, 'deleted branch pruned');

    await assert.rejects(syncRepository({ ...options, url: pathToFileURL(join(dir, 'other')).href }), /Refusing to reuse/);
    mkdirSync(join(cache, 'plain.git'));
    await assert.rejects(syncRepository({ ...options, id: 'plain' }), /Refusing to reuse/);
  });

  it('fails clearly for a missing branch, an invalid branch name and an oversized repository', async () => {
    await assert.rejects(syncRepository({ ...options, branch: 'nope' }), /Branch nope does not exist/);
    await assert.rejects(syncRepository({ ...options, branch: '../main' }), /Invalid branch name/);
    await assert.rejects(syncRepository({ ...options, id: 'tiny', maxBytes: 10 }), /above the 10 byte limit/);
  });

  it('never accepts file:// remotes unless the test-only flag is set', async () => {
    await assert.rejects(syncRepository({ ...options, allowFileUrlsForTests: false }), /Only https:\/\/github.com/);
  });
});
