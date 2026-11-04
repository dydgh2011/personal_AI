import { spawn } from 'node:child_process';
import { createSign } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { GitHubAppConfig } from './config.js';
import { GitHubReadError, type GitHubReader, type GitHubWriter, type RemoteRepository } from './github.js';

/**
 * GitHub App authentication and API access (Phase E-2B).
 *
 * - The App is installed only on the repositories the owner selects; permissions Metadata: read,
 *   Contents: write, Pull requests: write.
 * - Each installation token is requested for exactly ONE repository (repository_ids) with only the
 *   permissions the call needs, cached in memory until 5 minutes before it expires, and never
 *   written to a log, a result, a git remote URL or an error message.
 * - The App is the pusher; commits keep their worker author and committer (POLICY B).
 */
export type Permissions = { metadata: 'read'; contents?: 'read' | 'write'; pull_requests?: 'read' | 'write' };
const READ: Permissions = { metadata: 'read', contents: 'read' };
const WRITE: Permissions = { metadata: 'read', contents: 'write', pull_requests: 'write' };

export class GitHubAppError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

/** RS256 JWT identifying the App (valid 9 minutes, backdated 60 s for clock skew). */
export function createAppJwt(appId: string, privateKeyPem: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  if (!/^\d+$/.test(appId)) throw new Error('GitHub App id must be numeric');
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKeyPem).toString('base64url');
  return `${unsigned}.${signature}`;
}

/** Removes a token (and its Basic-auth form) from text before it is logged or stored. */
export function redactToken(text: string, token: string): string {
  if (!token) return text;
  return text
    .split(token).join('[redacted]')
    .split(Buffer.from(`x-access-token:${token}`).toString('base64')).join('[redacted]');
}

/** Append-only audit of token issuance and API calls (no token values). */
export class GitHubAudit {
  constructor(private readonly stateDir: string) {}
  async record(entry: Record<string, unknown>): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    await appendFile(join(this.stateDir, 'github-audit.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
  }
}

export interface ApiOptions {
  apiUrl: string;
  app: GitHubAppConfig;
  allowedRepositories: string[];
  audit: GitHubAudit;
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Upper bound for waiting on a rate limit or Retry-After (ms). */
  maxWaitMs?: number;
}

/** Authenticated GitHub API for one App installation, restricted to allow-listed repositories. */
export class GitHubAppApi {
  private readonly cache = new Map<string, { token: string; expiresAt: number }>();
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ApiOptions) {
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** A token for one repository, from cache while it has more than 5 minutes left. */
  async token(repo: { id: number; fullName: string }, permissions: Permissions): Promise<string> {
    this.assertAllowed(repo.fullName);
    const key = `${repo.id}:${JSON.stringify(permissions)}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt - this.now() > 5 * 60_000) return cached.token;
    const pem = await readFile(this.options.app.privateKeyFile, 'utf8').catch(() => {
      throw new GitHubAppError('GitHub App private key is not readable', 'APP_KEY_MISSING');
    });
    const jwt = createAppJwt(this.options.app.appId, pem, Math.floor(this.now() / 1000));
    const res = await this.send('POST', `/app/installations/${this.options.app.installationId}/access_tokens`, jwt, { repository_ids: [repo.id], permissions });
    const body = res.body as { token?: unknown; expires_at?: unknown };
    if (res.status !== 201 || typeof body.token !== 'string' || typeof body.expires_at !== 'string') {
      await this.options.audit.record({ kind: 'token', repositoryId: repo.id, fullName: repo.fullName, permissions, status: res.status, ok: false });
      throw new GitHubAppError(`GitHub App token request failed (${res.status})`, 'APP_TOKEN_FAILED');
    }
    const expiresAt = Date.parse(body.expires_at);
    this.cache.set(key, { token: body.token, expiresAt });
    await this.options.audit.record({ kind: 'token', repositoryId: repo.id, fullName: repo.fullName, permissions, status: res.status, ok: true, expiresAt: body.expires_at });
    return body.token;
  }

  /** An authenticated call on behalf of one allow-listed repository. */
  async request(method: 'GET' | 'POST' | 'PATCH', path: string, repo: { id: number; fullName: string }, body?: unknown, write = false): Promise<{ status: number; body: unknown }> {
    const token = await this.token(repo, write ? WRITE : READ);
    const res = await this.send(method, path, token, body);
    await this.options.audit.record({ kind: 'request', method, path, repositoryId: repo.id, fullName: repo.fullName, status: res.status, attempts: res.attempts });
    return res;
  }

  assertAllowed(fullName: string): void {
    if (!this.options.allowedRepositories.includes(fullName.toLowerCase())) {
      throw new GitHubAppError(`${fullName} is not in PUBLISHER_ALLOWED_REPOSITORIES`, 'REPOSITORY_NOT_ALLOWED');
    }
  }

  /** Retries network errors and 5xx (3 attempts); waits out rate limits up to maxWaitMs. */
  private async send(method: string, path: string, bearer: string, body?: unknown): Promise<{ status: number; body: unknown; attempts: number }> {
    const maxWait = this.options.maxWaitMs ?? 60_000;
    let lastError = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(this.options.apiUrl + path, {
          method,
          headers: {
            Authorization: `Bearer ${bearer}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'personal-ai-publisher',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        lastError = (error as Error).name;
        await sleep(250 * attempt);
        continue;
      }
      const remaining = res.headers.get('x-ratelimit-remaining');
      const retryAfter = res.headers.get('retry-after');
      if (res.status === 429 || (res.status === 403 && (remaining === '0' || retryAfter))) {
        const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000;
        const wait = retryAfter ? Number(retryAfter) * 1000 : Math.max(0, reset - this.now());
        if (wait > maxWait || attempt === 3) throw new GitHubAppError(`GitHub rate limit (retry in ${Math.ceil(wait / 1000)}s)`, 'RATE_LIMITED');
        await sleep(wait);
        continue;
      }
      if (res.status >= 500 && attempt < 3) {
        lastError = `HTTP ${res.status}`;
        await sleep(250 * attempt);
        continue;
      }
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      return { status: res.status, body: parsed, attempts: attempt };
    }
    throw new GitHubAppError(`GitHub API unavailable (${lastError})`, 'GITHUB_UNAVAILABLE');
  }
}

/** Reads with an installation token: private repositories become verifiable. */
export class AppGitHubReader implements GitHubReader {
  constructor(private readonly api: GitHubAppApi, private readonly repositoryIds: (fullName: string) => number | null) {}

  async repository(fullName: string): Promise<RemoteRepository | null> {
    const id = this.repositoryIds(fullName);
    if (id === null) return null;
    const res = await this.api.request('GET', `/repositories/${id}`, { id, fullName });
    if (res.status === 404) return null;
    const r = res.body as { id?: unknown; full_name?: unknown; default_branch?: unknown; private?: unknown };
    if (res.status !== 200 || typeof r.id !== 'number' || typeof r.full_name !== 'string' || typeof r.default_branch !== 'string') {
      throw new GitHubReadError(`GitHub API answered ${res.status} for the repository`);
    }
    return { id: r.id, fullName: r.full_name, defaultBranch: r.default_branch, private: r.private === true };
  }

  async branchHead(fullName: string, branch: string): Promise<string | null> {
    const id = this.repositoryIds(fullName);
    if (id === null) return null;
    const res = await this.api.request('GET', `/repositories/${id}/branches/${encodeURIComponent(branch)}`, { id, fullName });
    if (res.status === 404) return null;
    const sha = (res.body as { commit?: { sha?: unknown } })?.commit?.sha;
    if (res.status !== 200 || typeof sha !== 'string') throw new GitHubReadError(`GitHub API answered ${res.status} for branch ${branch}`);
    return sha;
  }
}

export interface WriterOptions {
  api: GitHubAppApi;
  /** https://github.com in production; a local smart-HTTP server in tests. */
  gitBaseUrl: string;
  audit: GitHubAudit;
}

/**
 * Pushes the approved commit object as it is (no commit, amend or rebase happens here) to a new
 * branch, and opens a draft pull request. Never force-pushes; never touches the default branch.
 */
export class GitHubAppWriter implements GitHubWriter {
  constructor(private readonly options: WriterOptions) {}

  async pushBranch(input: { fullName: string; repositoryId: number; branch: string; headSha: string; repoDir: string }): Promise<void> {
    const repo = { id: input.repositoryId, fullName: input.fullName };
    const existing = await this.branchHead(repo, input.branch);
    if (existing === input.headSha) return; // already published: idempotent
    if (existing !== null) throw new GitHubAppError(`${input.branch} already exists at ${existing}`, 'TARGET_BRANCH_EXISTS');
    const token = await this.options.api.token(repo, WRITE);
    const url = `${this.options.gitBaseUrl}/${input.fullName}.git`;
    const header = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    // Credentials only via the environment of this one git process, scoped to the remote's origin.
    const result = await run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', 'push', '--no-verify', '--porcelain', url, `${input.headSha}:refs/heads/${input.branch}`], input.repoDir, {
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${new URL(url).origin}/.extraHeader`, GIT_CONFIG_VALUE_0: header,
    });
    await this.options.audit.record({ kind: 'push', fullName: input.fullName, repositoryId: input.repositoryId, branch: input.branch, headSha: input.headSha, exitCode: result.code });
    if (result.code !== 0) throw new GitHubAppError(`git push failed: ${redactToken(result.stderr, token).slice(-400)}`, 'PUSH_FAILED');
    const after = await this.branchHead(repo, input.branch);
    if (after !== input.headSha) throw new GitHubAppError(`${input.branch} is at ${after}, not the approved ${input.headSha}`, 'PUSH_MISMATCH');
  }

  async createPullRequest(input: { fullName: string; repositoryId: number; head: string; base: string; title: string; body: string; draft: boolean }): Promise<{ number: number; url: string }> {
    const repo = { id: input.repositoryId, fullName: input.fullName };
    const owner = input.fullName.split('/')[0];
    const open = await this.options.api.request('GET', `/repos/${input.fullName}/pulls?state=open&head=${encodeURIComponent(`${owner}:${input.head}`)}`, repo);
    const found = Array.isArray(open.body) ? (open.body as Array<{ number: number; html_url: string }>)[0] : undefined;
    if (found) return { number: found.number, url: found.html_url }; // idempotent
    const res = await this.options.api.request('POST', `/repos/${input.fullName}/pulls`, repo, { title: input.title, head: input.head, base: input.base, body: input.body, draft: input.draft }, true);
    const pr = res.body as { number?: unknown; html_url?: unknown };
    if (res.status !== 201 || typeof pr.number !== 'number' || typeof pr.html_url !== 'string') throw new GitHubAppError(`pull request creation failed (${res.status})`, 'PR_FAILED');
    return { number: pr.number, url: pr.html_url };
  }

  private async branchHead(repo: { id: number; fullName: string }, branch: string): Promise<string | null> {
    const res = await this.options.api.request('GET', `/repos/${repo.fullName}/branches/${encodeURIComponent(branch)}`, repo);
    if (res.status === 404) return null;
    const sha = (res.body as { commit?: { sha?: unknown } })?.commit?.sha;
    return typeof sha === 'string' ? sha : null;
  }
}

function run(cmd: string, args: string[], cwd: string, extraEnv: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH, HOME: '/tmp', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', ...extraEnv },
      timeout: 300_000,
    });
    let stderr = '';
    child.stderr!.on('data', (d: Buffer) => (stderr += d.toString('utf8')).length);
    child.once('error', () => resolve({ code: null, stderr: 'git could not be started' }));
    child.once('close', (code) => resolve({ code, stderr }));
  });
}
