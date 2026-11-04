import type { GitHubCredentials } from './github-credentials.js';

/** Repository metadata normalised from the GitHub REST API (only what the registry needs). */
export interface GitHubRepository {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  visibility: 'public' | 'private' | 'internal';
  defaultBranch: string;
  description: string | null;
  fork: boolean;
  archived: boolean;
  /** HTTPS clone URL without credentials. */
  cloneUrl: string;
  htmlUrl: string;
  updatedAt: string | null;
  pushedAt: string | null;
  /** The caller's permissions, when the API reports them (authenticated requests only). */
  permissions: { admin: boolean; push: boolean; pull: boolean } | null;
}

export interface RateLimit {
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
  resource: string | null;
}

export interface RepositoryPage {
  repositories: GitHubRepository[];
  pages: number;
  /** true when maxPages stopped the listing before the last page. */
  truncated: boolean;
  rateLimit: RateLimit;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly rateLimit: RateLimit | null = null,
  ) {
    super(message);
  }
}
export class GitHubNotFoundError extends GitHubApiError {}
export class GitHubAuthError extends GitHubApiError {}
export class GitHubRateLimitError extends GitHubApiError {}

export interface GitHubClientOptions {
  baseUrl: string;
  credentials: GitHubCredentials;
  timeoutMs?: number;
  /** Wait at most this long for a rate-limit reset / Retry-After before failing (0 = never wait). */
  maxRateLimitWaitMs?: number;
  /** Safety cap for pagination (100 repositories per page). */
  maxPages?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
export const FULL_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH_PATTERN = /^(?!\/|.*(?:\.\.|\/\/|@\{|\\))[A-Za-z0-9._/-]{1,200}(?<![./])$/;

/**
 * Read-only GitHub REST API client (https://docs.github.com/rest). Handles
 * pagination through the Link header and primary/secondary rate limits.
 * Every method is a GET; nothing here can push, merge or create anything.
 */
export class GitHubClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastRateLimit: RateLimit = { limit: null, remaining: null, resetAt: null, resource: null };

  constructor(private readonly options: GitHubClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get authMode() {
    return this.options.credentials.mode;
  }

  get rateLimit(): RateLimit {
    return { ...this.lastRateLimit };
  }

  async getRepository(fullName: string): Promise<GitHubRepository> {
    assertFullName(fullName);
    const { body } = await this.get(`/repos/${fullName}`);
    return normaliseRepository(body);
  }

  /** Commit SHA at the tip of `branch`. */
  async getBranchHead(fullName: string, branch: string): Promise<string> {
    assertFullName(fullName);
    if (!BRANCH_PATTERN.test(branch)) throw new GitHubApiError(`Invalid branch name "${branch}"`, null);
    const { body } = await this.get(`/repos/${fullName}/branches/${encodeURIComponent(branch)}`);
    const sha = (body as { commit?: { sha?: unknown } })?.commit?.sha;
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new GitHubApiError('Unexpected branch response from GitHub', null);
    }
    return sha;
  }

  /**
   * Repositories the authenticated identity can access: owned, collaborator and
   * organisation-member repositories. Requires credentials. The result is only
   * what this token (or GitHub App installation) is allowed to see.
   */
  listAccessibleRepositories(): Promise<RepositoryPage> {
    if (this.options.credentials.mode === 'none') {
      throw new GitHubAuthError('Listing your own repositories needs GitHub credentials (GITHUB_TOKEN_FILE)', null);
    }
    return this.paginate('/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=100');
  }

  /** Public repositories of a user (anonymous) or every repository of that user the token can see. */
  listUserRepositories(owner: string): Promise<RepositoryPage> {
    assertOwner(owner);
    return this.paginate(`/users/${owner}/repos?type=owner&sort=updated&per_page=100`);
  }

  listOrganizationRepositories(org: string): Promise<RepositoryPage> {
    assertOwner(org);
    return this.paginate(`/orgs/${org}/repos?type=all&sort=updated&per_page=100`);
  }

  private async paginate(firstPath: string): Promise<RepositoryPage> {
    const maxPages = this.options.maxPages ?? 10;
    const repositories: GitHubRepository[] = [];
    let next: string | null = this.options.baseUrl.replace(/\/+$/, '') + firstPath;
    let pages = 0;
    while (next && pages < maxPages) {
      const { body, headers } = await this.get(next);
      if (!Array.isArray(body)) throw new GitHubApiError('Unexpected repository list response from GitHub', null);
      repositories.push(...body.map(normaliseRepository));
      pages++;
      next = nextLink(headers.get('link'), this.options.baseUrl);
    }
    return { repositories, pages, truncated: next !== null, rateLimit: this.rateLimit };
  }

  private async get(pathOrUrl: string, attempt = 0): Promise<{ body: unknown; headers: Headers }> {
    const base = this.options.baseUrl.replace(/\/+$/, '');
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : base + pathOrUrl;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'personal-ai-controller',
    };
    const authorization = await this.options.credentials.authorization();
    if (authorization) headers.Authorization = authorization;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
    } catch (error) {
      throw new GitHubApiError(`GitHub API unreachable: ${(error as Error).name}`, null);
    }
    this.lastRateLimit = readRateLimit(response.headers);
    const body = await response.json().catch(() => null);
    if (response.ok) return { body, headers: response.headers };

    const message = typeof (body as { message?: unknown })?.message === 'string' ? (body as { message: string }).message : '';
    const limited =
      response.status === 429 ||
      (response.status === 403 && (this.lastRateLimit.remaining === 0 || response.headers.has('retry-after') || /rate limit/i.test(message)));
    if (limited) {
      const waitMs = rateLimitWaitMs(response.headers, this.lastRateLimit);
      if (attempt === 0 && waitMs !== null && waitMs <= (this.options.maxRateLimitWaitMs ?? 0)) {
        await this.sleep(waitMs);
        return this.get(pathOrUrl, attempt + 1);
      }
      throw new GitHubRateLimitError(
        `GitHub API rate limit reached${this.lastRateLimit.resetAt ? `; resets at ${this.lastRateLimit.resetAt}` : ''}`,
        response.status,
        this.rateLimit,
      );
    }
    if (response.status === 401) throw new GitHubAuthError('GitHub rejected the configured credentials', 401);
    if (response.status === 404) {
      throw new GitHubNotFoundError(
        'Not found on GitHub, or not visible with the current credentials (private repositories need explicit authentication)',
        404,
      );
    }
    if (response.status === 403) throw new GitHubAuthError('GitHub denied access with the current credentials', 403);
    throw new GitHubApiError(`GitHub API error ${response.status}`, response.status);
  }
}

function assertFullName(fullName: string) {
  if (!FULL_NAME_PATTERN.test(fullName)) throw new GitHubApiError(`Invalid repository name "${fullName}"`, null);
}

function assertOwner(owner: string) {
  if (!OWNER_PATTERN.test(owner)) throw new GitHubApiError(`Invalid GitHub owner "${owner}"`, null);
}

/** Follows rel="next" only to the configured API host (never to a URL of the response's choosing elsewhere). */
export function nextLink(header: string | null, baseUrl: string): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part.trim());
    if (match && match[2].split(/\s+/).includes('next')) {
      const url = new URL(match[1]);
      return url.origin === new URL(baseUrl).origin ? url.toString() : null;
    }
  }
  return null;
}

function readRateLimit(headers: Headers): RateLimit {
  const num = (name: string) => {
    const value = headers.get(name);
    return value !== null && /^\d+$/.test(value) ? Number(value) : null;
  };
  const reset = num('x-ratelimit-reset');
  return {
    limit: num('x-ratelimit-limit'),
    remaining: num('x-ratelimit-remaining'),
    resetAt: reset !== null ? new Date(reset * 1000).toISOString() : null,
    resource: headers.get('x-ratelimit-resource'),
  };
}

function rateLimitWaitMs(headers: Headers, rateLimit: RateLimit): number | null {
  const retryAfter = headers.get('retry-after');
  if (retryAfter && /^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
  if (rateLimit.remaining === 0 && rateLimit.resetAt) return Math.max(0, Date.parse(rateLimit.resetAt) - Date.now());
  return null;
}

export function normaliseRepository(raw: unknown): GitHubRepository {
  const r = raw as Record<string, unknown>;
  const owner = (r.owner as { login?: unknown } | undefined)?.login;
  const fullName = r.full_name;
  if (typeof r.id !== 'number' || typeof fullName !== 'string' || !FULL_NAME_PATTERN.test(fullName) || typeof owner !== 'string') {
    throw new GitHubApiError('Unexpected repository data from GitHub', null);
  }
  const cloneUrl = typeof r.clone_url === 'string' ? r.clone_url : `https://github.com/${fullName}.git`;
  const visibility = r.visibility === 'private' || r.visibility === 'internal' ? r.visibility : r.private === true ? 'private' : 'public';
  const perms = r.permissions as Record<string, unknown> | undefined;
  return {
    id: r.id,
    fullName,
    owner,
    name: typeof r.name === 'string' ? r.name : fullName.split('/')[1],
    private: r.private === true,
    visibility,
    defaultBranch: typeof r.default_branch === 'string' ? r.default_branch : 'main',
    description: typeof r.description === 'string' ? r.description : null,
    fork: r.fork === true,
    archived: r.archived === true,
    cloneUrl: stripCredentials(cloneUrl),
    htmlUrl: typeof r.html_url === 'string' ? r.html_url : `https://github.com/${fullName}`,
    updatedAt: typeof r.updated_at === 'string' ? r.updated_at : null,
    pushedAt: typeof r.pushed_at === 'string' ? r.pushed_at : null,
    permissions: perms
      ? { admin: perms.admin === true, push: perms.push === true, pull: perms.pull === true }
      : null,
  };
}

/** Remote URLs are stored and shown without any user:password@ part. */
export function stripCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url;
  }
}
