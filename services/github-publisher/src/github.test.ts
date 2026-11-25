import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ConfigError, loadConfig } from './config.js';
import { createAppJwt, GitHubAppApi, GitHubAppWriter, GitHubAudit, redactToken } from './github-app.js';
import { DisabledWriter, HttpGitHubReader } from './github.js';
import { g } from './testkit.js';

const TOKEN = 'ghs_' + 'T0k3n'.repeat(8);

/**
 * Mock GitHub: REST API (installation tokens, branches, pulls) + smart-HTTP git (git http-backend)
 * that accepts only the installation token, like github.com does.
 */
class MockGitHub {
  server: Server | null = null;
  url = '';
  readonly requests: Array<{ method: string; path: string; auth: string | undefined; body: string }> = [];
  readonly gitAuth: Array<string | undefined> = [];
  tokensIssued = 0;
  failNext = 0;
  rateLimitNext = 0;
  expiresInMs = 60 * 60_000;
  pulls: Array<{ number: number; head: string; base: string; title: string; html_url: string }> = [];
  constructor(private readonly gitRoot: string) {}

  async start() {
    this.server = createServer((req, res) => {
      if (req.url!.includes('.git/')) return this.git(req, res);
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => this.api(req, res, body));
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop() {
    await new Promise((r) => this.server?.close(r));
  }

  private api(req: IncomingMessage, res: ServerResponse, body: string) {
    const path = req.url!;
    this.requests.push({ method: req.method!, path, auth: req.headers.authorization, body });
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(value));
    };
    if (this.failNext > 0) {
      this.failNext--;
      return json(502, { message: 'bad gateway' });
    }
    if (this.rateLimitNext > 0) {
      this.rateLimitNext--;
      return json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1) });
    }
    if (req.method === 'POST' && /^\/app\/installations\/7\/access_tokens$/.test(path)) {
      if (!req.headers.authorization?.startsWith('Bearer ey')) return json(401, { message: 'bad jwt' });
      this.tokensIssued++;
      return json(201, { token: TOKEN, expires_at: new Date(Date.now() + this.expiresInMs).toISOString() });
    }
    // Like GitHub: without credentials a private repository simply does not exist.
    if (!req.headers.authorization) return json(404, { message: 'Not Found' });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { message: 'Bad credentials' });
    const branch = /^\/repos\/owner\/hello\/branches\/(.+)$/.exec(path);
    if (req.method === 'GET' && branch) {
      const name = decodeURIComponent(branch[1]);
      try {
        const sha = execFileSync('git', ['rev-parse', '--verify', `refs/heads/${name}`], { cwd: join(this.gitRoot, 'owner', 'hello.git'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        return json(200, { name, commit: { sha } });
      } catch {
        return json(404, { message: 'Branch not found' });
      }
    }
    if (req.method === 'GET' && path.startsWith('/repos/owner/hello/pulls?')) {
      const head = new URL(path, 'http://x').searchParams.get('head')!.split(':')[1];
      return json(200, this.pulls.filter((p) => p.head === head));
    }
    if (req.method === 'POST' && path === '/repos/owner/hello/pulls') {
      const b = JSON.parse(body);
      const pr = { number: this.pulls.length + 1, head: b.head, base: b.base, title: b.title, draft: b.draft, html_url: `https://github.com/owner/hello/pull/${this.pulls.length + 1}` };
      this.pulls.push(pr);
      return json(201, pr);
    }
    json(404, { message: 'Not Found' });
  }

  private git(req: IncomingMessage, res: ServerResponse) {
    this.gitAuth.push(req.headers.authorization);
    if (req.headers.authorization !== `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GitHub"' });
      return res.end();
    }
    const url = new URL(req.url!, 'http://127.0.0.1');
    const child = spawn('git', ['http-backend'], {
      env: {
        ...process.env, GIT_PROJECT_ROOT: this.gitRoot, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'] ?? '', REMOTE_USER: 'x-access-token', REMOTE_ADDR: '127.0.0.1',
        ...(req.headers['content-length'] ? { CONTENT_LENGTH: req.headers['content-length'] } : {}),
        ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: req.headers['content-encoding'] } : {}),
        GIT_PROTOCOL: (req.headers['git-protocol'] as string) ?? '',
      },
    });
    req.pipe(child.stdin);
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('close', () => {
      const out = Buffer.concat(chunks);
      const split = out.indexOf('\r\n\r\n');
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of out.subarray(0, split).toString('utf8').split('\r\n')) {
        const [k, ...v] = line.split(':');
        if (k.toLowerCase() === 'status') status = Number(v.join(':').trim().split(' ')[0]);
        else if (k) headers[k] = v.join(':').trim();
      }
      res.writeHead(status, headers);
      res.end(out.subarray(split + 4));
    });
  }
}

describe('GitHub App (writer against a local git server)', () => {
  let dir: string;
  let mock: MockGitHub;
  let keyFile: string;
  let audit: GitHubAudit;
  let publicKey: string;
  const repo = { id: 42, fullName: 'owner/hello' };
  const api = (over: Partial<ConstructorParameters<typeof GitHubAppApi>[0]> = {}) => new GitHubAppApi({
    apiUrl: mock.url, app: { appId: '12345', installationId: 7, privateKeyFile: keyFile }, allowedRepositories: ['owner/hello'], audit, maxWaitMs: 5_000, ...over,
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gh-app-'));
    const { privateKey, publicKey: pub } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    keyFile = join(dir, 'app.pem');
    writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    publicKey = pub.export({ type: 'spki', format: 'pem' }).toString();
    audit = new GitHubAudit(join(dir, 'state'));
    mkdirSync(join(dir, 'remote', 'owner'), { recursive: true });
    mock = new MockGitHub(join(dir, 'remote'));
    await mock.start();
  });
  afterEach(async () => {
    await mock.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('signs App JWTs with the private key', () => {
    const jwt = createAppJwt('12345', readFileSync(keyFile, 'utf8'), 1_000_000);
    const [h, p, s] = jwt.split('.');
    assert.equal(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url')), true);
    assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url').toString()), { iat: 999_940, exp: 1_000_540, iss: '12345' });
  });

  it('issues tokens for one repository with minimal permissions, caches them and renews before expiry', async () => {
    let now = Date.now();
    const client = api({ now: () => now });
    await client.token(repo, { metadata: 'read', contents: 'read' });
    await client.token(repo, { metadata: 'read', contents: 'read' });
    assert.equal(mock.tokensIssued, 1, 'cached');
    const sent = JSON.parse(mock.requests[0].body);
    assert.deepEqual(sent, { repository_ids: [42], permissions: { metadata: 'read', contents: 'read' } });
    await client.token(repo, { metadata: 'read', contents: 'write', pull_requests: 'write' });
    assert.equal(mock.tokensIssued, 2, 'write permissions are a separate, explicit token');
    now += 56 * 60_000; // less than 5 minutes left
    await client.token(repo, { metadata: 'read', contents: 'read' });
    assert.equal(mock.tokensIssued, 3, 'renewed before expiry');
  });

  it('refuses repositories outside the allowlist before asking GitHub', async () => {
    await assert.rejects(api().token({ id: 9, fullName: 'someone/else' }, { metadata: 'read' }), (e: Error & { code?: string }) => e.code === 'REPOSITORY_NOT_ALLOWED');
    assert.equal(mock.requests.length, 0);
  });

  it('retries server errors and waits out rate limits', async () => {
    mock.failNext = 2;
    const res = await api().request('GET', '/repos/owner/hello/branches/main', repo);
    assert.equal(res.status, 404);
    mock.rateLimitNext = 1;
    const started = Date.now();
    await api().request('GET', '/repos/owner/hello/branches/main', repo);
    assert.ok(Date.now() - started >= 0);
    mock.rateLimitNext = 5;
    await assert.rejects(api({ maxWaitMs: 0 }).request('GET', '/repos/owner/hello/branches/main', repo), (e: Error & { code?: string }) => e.code === 'RATE_LIMITED');
  });

  it('pushes the existing commit object unchanged, opens one draft PR, and never leaks the token', async () => {
    // remote "GitHub" repository and the publisher's verification repository holding the approved commit
    const seed = join(dir, 'seed');
    mkdirSync(seed);
    g(seed, 'init', '-q');
    writeFileSync(join(seed, 'README.md'), '# hello\n');
    g(seed, 'add', '-A');
    g(seed, 'commit', '-q', '-m', 'initial');
    execFileSync('git', ['clone', '-q', '--bare', seed, join(dir, 'remote', 'owner', 'hello.git')]);
    execFileSync('git', ['config', 'http.receivepack', 'true'], { cwd: join(dir, 'remote', 'owner', 'hello.git') });
    g(seed, 'checkout', '-q', '-b', 'codex/task-x');
    writeFileSync(join(seed, 'NOTES.md'), 'notes\n');
    g(seed, 'add', '-A');
    g(seed, 'commit', '-q', '-m', 'codex-worker: task x (completed)');
    const head = g(seed, 'rev-parse', 'HEAD');
    const before = g(seed, 'cat-file', '-p', head);

    const client = api();
    const writer = new GitHubAppWriter({ api: client, gitBaseUrl: mock.url, audit });
    await writer.pushBranch({ fullName: 'owner/hello', repositoryId: 42, branch: 'personal-ai/x', headSha: head, repoDir: seed });
    const remote = join(dir, 'remote', 'owner', 'hello.git');
    assert.equal(g(remote, 'rev-parse', 'refs/heads/personal-ai/x'), head, 'the approved SHA itself');
    assert.equal(g(remote, 'cat-file', '-p', head), before, 'author, committer, message and tree unchanged');
    assert.equal(g(remote, 'log', '-1', '--format=%an <%ae> / %cn <%ce>', head), 'Owner Name <owner@example.com> / Owner Name <owner@example.com>');
    assert.equal(g(remote, 'rev-parse', 'refs/heads/main'), g(seed, 'rev-parse', 'HEAD~1'), 'default branch untouched');
    // idempotent: a second push of the same commit is a no-op; another commit on that branch is refused
    await writer.pushBranch({ fullName: 'owner/hello', repositoryId: 42, branch: 'personal-ai/x', headSha: head, repoDir: seed });
    await assert.rejects(writer.pushBranch({ fullName: 'owner/hello', repositoryId: 42, branch: 'personal-ai/x', headSha: g(seed, 'rev-parse', 'HEAD~1'), repoDir: seed }), (e: Error & { code?: string }) => e.code === 'TARGET_BRANCH_EXISTS');

    const pr1 = await writer.createPullRequest({ fullName: 'owner/hello', repositoryId: 42, head: 'personal-ai/x', base: 'main', title: 't', body: 'b', draft: true });
    const pr2 = await writer.createPullRequest({ fullName: 'owner/hello', repositoryId: 42, head: 'personal-ai/x', base: 'main', title: 't', body: 'b', draft: true });
    assert.equal(pr1.number, pr2.number);
    assert.equal(mock.pulls.length, 1);

    // the token only travelled in Authorization headers: not in the remote config, git config, URLs or audit
    assert.ok(mock.gitAuth.some((a) => a?.startsWith('Basic ')));
    assert.ok(mock.requests.every((r) => !r.path.includes(TOKEN)));
    assert.doesNotMatch(execFileSync('git', ['config', '--list', '--show-origin'], { cwd: seed, encoding: 'utf8' }), new RegExp(TOKEN));
    for (const f of readdirSync(join(dir, 'state'))) assert.doesNotMatch(readFileSync(join(dir, 'state', f), 'utf8'), new RegExp(TOKEN));
    assert.doesNotMatch(readFileSync(join(seed, '.git', 'config'), 'utf8'), /x-access-token|extraHeader/i);
    const auditLines = readFileSync(join(dir, 'state', 'github-audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(auditLines.some((l) => l.kind === 'token' && l.ok === true && l.repositoryId === 42));
    assert.ok(auditLines.some((l) => l.kind === 'push' && l.headSha === head));
    assert.equal(redactToken(`fatal: https://x-access-token:${TOKEN}@github.com`, TOKEN).includes(TOKEN), false);
  });

  it('the default writer cannot publish, and anonymous reads use GET only', async () => {
    await assert.rejects(new DisabledWriter().pushBranch(), /disabled/);
    await assert.rejects(new DisabledWriter().createPullRequest(), /disabled/);
    const reader = new HttpGitHubReader(mock.url);
    assert.equal(await reader.repository('owner/private'), null);
    assert.deepEqual(new Set(mock.requests.map((r) => r.method)), new Set(['GET']));
  });
});

describe('configuration', () => {
  const base = { CONTROLLER_URL: 'http://controller:3000' };
  it('keeps the owner policies fixed', () => {
    const c = loadConfig(base);
    assert.equal(c.requireReportedTests, true);
    assert.equal(c.commitAuthorPolicy, 'owner');
    assert.equal(c.publishBackend, 'disabled');
    assert.throws(() => loadConfig({ ...base, PUBLISHER_REQUIRE_REPORTED_TESTS: 'false' }), (e: Error) => e instanceof ConfigError && /POLICY A is fixed/.test(e.message));
    assert.throws(() => loadConfig({ ...base, PUBLISHER_COMMIT_AUTHOR_POLICY: 'preserve_worker' }), /must be owner/);
  });
  it('publishes for real only through a configured GitHub App, never with personal access tokens', () => {
    assert.throws(() => loadConfig({ ...base, PUBLISHER_PUBLISH_BACKEND: 'github' }), /needs the GitHub App/);
    const app = { PUBLISHER_GITHUB_APP_ID: '1', PUBLISHER_GITHUB_APP_INSTALLATION_ID: '2', PUBLISHER_GITHUB_APP_KEY_FILE: '/run/secrets/k' };
    assert.equal(loadConfig({ ...base, ...app, PUBLISHER_PUBLISH_BACKEND: 'github' }).publishBackend, 'github');
    assert.equal(loadConfig({ ...base, ...app, PUBLISHER_PUBLISH_BACKEND: 'github' }).gitBaseUrl, 'https://github.com');
    assert.throws(() => loadConfig({ ...base, PUBLISHER_PUBLISH_BACKEND: 'live' }), /disabled, mock or github/);
    assert.equal(loadConfig({ ...base, PUBLISHER_PUBLISH_BACKEND: 'mock' }).publishBackend, 'mock');
    assert.throws(() => loadConfig({ ...base, GITHUB_TOKEN: 'x' }), /only uses GitHub App installation tokens/);
    assert.throws(() => loadConfig({ ...base, PUBLISHER_MODE: 'publish' }), /PUBLISHER_PUBLISH_BACKEND/);
  });
  it('loads GitHub App settings only completely', () => {
    assert.deepEqual(loadConfig({ ...base, PUBLISHER_GITHUB_APP_ID: '1', PUBLISHER_GITHUB_APP_INSTALLATION_ID: '2', PUBLISHER_GITHUB_APP_KEY_FILE: '/run/secrets/k' }).githubApp,
      { appId: '1', installationId: 2, privateKeyFile: '/run/secrets/k' });
    assert.throws(() => loadConfig({ ...base, PUBLISHER_GITHUB_APP_ID: '1' }), /INSTALLATION_ID/);
  });
});
