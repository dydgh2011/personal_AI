import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { classify, exportRepositories, scrub, syncRepository, type SyncOptions } from './sync.js';

const TOKEN = 'github_pat_' + 'A1b2C3'.repeat(8);
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

/**
 * Smart-HTTP git server (git http-backend as CGI) that behaves like GitHub for a private repository:
 * 401 without the right Basic credentials, 404 once access is revoked.
 */
class PrivateGitServer {
  server: Server | null = null;
  url = '';
  revoked = false;
  readonly authHeaders: Array<string | null> = [];
  constructor(private readonly root: string, private readonly token: string) {}

  async start() {
    const expected = `Basic ${Buffer.from(`x-access-token:${this.token}`).toString('base64')}`;
    this.server = createServer((req, res) => {
      const auth = req.headers.authorization ?? null;
      this.authHeaders.push(auth);
      if (auth !== expected) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GitHub"' });
        return res.end();
      }
      if (this.revoked) {
        res.writeHead(404);
        return res.end('Repository not found.');
      }
      const url = new URL(req.url!, 'http://127.0.0.1');
      const child = spawn('git', ['http-backend'], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: this.root,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: req.method,
          CONTENT_TYPE: req.headers['content-type'] ?? '',
          ...(req.headers['content-length'] ? { CONTENT_LENGTH: req.headers['content-length'] } : {}),
          ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: req.headers['content-encoding'] } : {}),
          GIT_PROTOCOL: (req.headers['git-protocol'] as string) ?? '',
          REMOTE_ADDR: '127.0.0.1',
        },
      });
      req.pipe(child.stdin);
      const chunks: Buffer[] = [];
      child.stdout.on('data', (c: Buffer) => chunks.push(c));
      child.on('close', () => {
        const out = Buffer.concat(chunks);
        const split = out.indexOf('\r\n\r\n');
        const head = out.subarray(0, split).toString('utf8');
        const headers: Record<string, string> = {};
        let status = 200;
        for (const line of head.split('\r\n')) {
          const [k, ...v] = line.split(':');
          if (k.toLowerCase() === 'status') status = Number(v.join(':').trim().split(' ')[0]);
          else if (k) headers[k] = v.join(':').trim();
        }
        res.writeHead(status, headers);
        res.end(out.subarray(split + 4));
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}/private.git`;
  }

  async stop() {
    await new Promise((r) => this.server?.close(r));
  }
}

describe('repo-sync: private repositories', () => {
  let dir: string;
  let cache: string;
  let server: PrivateGitServer;
  let options: SyncOptions;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'repo-private-'));
    const upstream = join(dir, 'work');
    const served = join(dir, 'served');
    cache = join(dir, 'cache');
    for (const d of [upstream, served, cache]) mkdirSync(d);
    git(upstream, 'init', '-q', '-b', 'main');
    writeFileSync(join(upstream, 'secret.txt'), 'private content\n');
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '-q', '-m', 'private');
    git(served, 'clone', '-q', '--bare', upstream, 'private.git');
    server = new PrivateGitServer(served, TOKEN);
    await server.start();
    options = {
      cacheRoot: cache, id: 'secret', url: server.url, branch: 'main', token: TOKEN, timeoutMs: 30_000,
      maxBytes: 50 * 1024 * 1024, maxCacheBytes: 200 * 1024 * 1024, maxFileBytes: 10 * 1024 * 1024, allowLocalHttpForTests: true,
    };
  });

  afterEach(async () => {
    await server.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('mirrors with the token sent only as an Authorization header, never stored', async () => {
    const result = await syncRepository(options);
    assert.equal(result.authenticated, true);
    assert.match(result.headSha, /^[0-9a-f]{40}$/);
    assert.ok(server.authHeaders.includes(`Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`));
    const config = readFileSync(join(result.path, 'config'), 'utf8');
    assert.ok(!config.includes(TOKEN) && !/extraheader|Authorization/i.test(config), 'token not in the repository config');
    assert.equal(git(result.path, 'config', '--get', 'remote.origin.url'), server.url, 'no credentials in the remote URL');
    assert.ok(!JSON.stringify(result).includes(TOKEN));
    // fetch again (update) works the same way
    assert.equal((await syncRepository(options)).created, false);
  });

  it('fails without a token instead of falling back to anonymous access', async () => {
    await assert.rejects(syncRepository({ ...options, token: null }), (e: Error & { code?: string }) => e.code === 'auth_required');
    assert.equal(git(join(cache, 'secret.git'), 'for-each-ref').length, 0, 'nothing was fetched');
  });

  it('reports an expired or wrong token as auth_failed without leaking it', async () => {
    const wrong = 'github_pat_' + 'Z9'.repeat(30);
    await assert.rejects(syncRepository({ ...options, token: wrong }), (e: Error & { code?: string }) => {
      assert.equal(e.code, 'auth_failed');
      assert.ok(!e.message.includes(wrong));
      assert.ok(!e.message.includes(Buffer.from(`x-access-token:${wrong}`).toString('base64')));
      return true;
    });
    await assert.rejects(syncRepository({ ...options, token: 'short' }), /does not contain a valid token/);
  });

  it('keeps the previous mirror when access is revoked and reports not_found_or_no_access', async () => {
    const first = await syncRepository(options);
    server.revoked = true;
    await assert.rejects(syncRepository(options), (e: Error & { code?: string }) => e.code === 'not_found_or_no_access');
    assert.equal(git(first.path, 'rev-parse', 'refs/heads/main'), first.headSha, 'existing refs and commits are untouched');
  });

  it('enforces file and total cache limits', async () => {
    await assert.rejects(syncRepository({ ...options, maxFileBytes: 4 }), (e: Error & { code?: string }) => e.code === 'limit_exceeded');
    await assert.rejects(syncRepository({ ...options, id: 'second', maxCacheBytes: 10 }), /already uses/);
  });

  it('classifies and scrubs git errors', () => {
    assert.equal(classify('fatal: Authentication failed for http://x', true), 'auth_failed');
    assert.equal(classify("fatal: could not read Username for 'https://github.com': terminal prompts disabled", false), 'auth_required');
    assert.equal(classify('remote: Repository not found.', true), 'not_found_or_no_access');
    const text = `https://x-access-token:${TOKEN}@github.com/a/b Authorization: Basic abc123 ghp_${'q'.repeat(36)} ${TOKEN}`;
    const out = scrub(text, TOKEN);
    assert.ok(!out.includes(TOKEN) && !out.includes('abc123') && !out.includes('ghp_q'), out);
  });
});

describe('repo-sync: per-agent exports', () => {
  let dir: string;
  let cache: string;
  let exports: { claude: string; codex: string };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'repo-export-'));
    cache = join(dir, 'cache');
    exports = { claude: join(dir, 'exports', 'claude'), codex: join(dir, 'exports', 'codex') };
    for (const d of [cache, exports.claude, exports.codex]) mkdirSync(d, { recursive: true });
    for (const id of ['alpha', 'beta']) {
      const work = join(dir, `${id}-work`);
      mkdirSync(work);
      git(work, 'init', '-q', '-b', 'main');
      writeFileSync(join(work, `${id}.txt`), id);
      git(work, 'add', '-A');
      git(work, 'commit', '-q', '-m', id);
      git(cache, 'init', '-q', '--bare', `${id}.git`);
      git(join(cache, `${id}.git`), 'fetch', '-q', work, '+refs/heads/*:refs/heads/*');
      git(join(cache, `${id}.git`), 'symbolic-ref', 'HEAD', 'refs/heads/main');
    }
  });

  afterEach(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));

  const run = (agent: 'claude' | 'codex', projects: string[]) =>
    exportRepositories({ cacheRoot: cache, exportRoot: exports[agent], projects, timeoutMs: 30_000 });

  it('exposes to each agent exactly the projects it may use, as independent copies', async () => {
    const claude = await run('claude', ['alpha', 'beta']);
    const codex = await run('codex', ['alpha']);
    assert.deepEqual(claude.exported.map((e) => e.id), ['alpha', 'beta']);
    assert.deepEqual(codex.exported.map((e) => e.id), ['alpha']);
    assert.equal(existsSync(join(exports.codex, 'beta.git')), false, 'codex volume never contains beta');
    assert.equal(existsSync(join(exports.claude, 'alpha.git', 'objects', 'info', 'alternates')), false);
    assert.equal(git(join(exports.claude, 'beta.git'), 'rev-parse', 'HEAD'), git(join(cache, 'beta.git'), 'rev-parse', 'HEAD'));
    // an independent copy survives the cache repository disappearing
    await rm(join(cache, 'alpha.git'), { recursive: true, force: true });
    assert.equal(git(join(exports.codex, 'alpha.git'), 'cat-file', '-t', 'HEAD'), 'commit');
  });

  it('removes repositories when access is revoked or the project is disabled', async () => {
    await run('claude', ['alpha', 'beta']);
    writeFileSync(join(exports.claude, 'stray.txt'), 'x');
    const revoked = await run('claude', ['alpha']);
    assert.deepEqual(revoked.removed.sort(), ['beta.git', 'stray.txt']);
    assert.equal(existsSync(join(exports.claude, 'beta.git')), false);
    const none = await run('claude', []);
    assert.deepEqual(none.removed, ['alpha.git']);
  });

  it('records which upstream repository an export is a copy of', async () => {
    git(join(cache, 'alpha.git'), 'config', 'remote.origin.url', 'https://github.com/owner/alpha.git');
    await run('claude', ['alpha', 'beta']);
    assert.equal(git(join(exports.claude, 'alpha.git'), 'config', '--get', 'personal-ai.upstream'), 'https://github.com/owner/alpha.git');
    // no upstream configured in the cache: no marker (the publisher then refuses the project)
    assert.throws(() => git(join(exports.claude, 'beta.git'), 'config', '--get', 'personal-ai.upstream'));
  });

  it('reports projects missing from the cache and rejects invalid ids', async () => {
    const result = await run('codex', ['alpha', 'gamma']);
    assert.deepEqual(result.errors.map((e) => e.id), ['gamma']);
    await assert.rejects(run('codex', ['../etc']), /Invalid project id/);
  });
});
