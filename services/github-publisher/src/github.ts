/**
 * GitHub access of the publisher.
 *
 * Reads: anonymous GETs (public repositories) or, when a GitHub App is configured, installation-token
 * reads (github-app.ts). Writes: GitHubWriter. Phase E-2B ships the 'disabled' writer (default) and a
 * 'mock' writer for tests; the GitHub App writer exists but the configuration does not select it.
 */
export interface RemoteRepository {
  id: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export interface GitHubReader {
  repository(fullName: string): Promise<RemoteRepository | null>;
  /** Branch head, or null if the branch does not exist. */
  branchHead(fullName: string, branch: string): Promise<string | null>;
}

export class GitHubReadError extends Error {}

export class HttpGitHubReader implements GitHubReader {
  constructor(private readonly apiUrl: string, private readonly timeoutMs = 10_000) {}

  async repository(fullName: string): Promise<RemoteRepository | null> {
    const body = await this.get(`/repos/${encodePath(fullName)}`);
    if (body === null) return null;
    const r = body as { id?: unknown; full_name?: unknown; default_branch?: unknown; private?: unknown };
    if (typeof r.id !== 'number' || typeof r.full_name !== 'string' || typeof r.default_branch !== 'string') {
      throw new GitHubReadError('Unexpected repository response from GitHub');
    }
    return { id: r.id, fullName: r.full_name, defaultBranch: r.default_branch, private: r.private === true };
  }

  async branchHead(fullName: string, branch: string): Promise<string | null> {
    const body = await this.get(`/repos/${encodePath(fullName)}/branches/${encodeURIComponent(branch)}`);
    if (body === null) return null;
    const sha = (body as { commit?: { sha?: unknown } }).commit?.sha;
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) throw new GitHubReadError('Unexpected branch response from GitHub');
    return sha;
  }

  /** GET only. 404 means "absent or not visible to us" (a private repository without credentials). */
  private async get(path: string): Promise<unknown | null> {
    let res: Response;
    try {
      res = await fetch(this.apiUrl + path, {
        method: 'GET',
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'personal-ai-publisher' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new GitHubReadError(`GitHub API unreachable: ${(error as Error).name}`);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new GitHubReadError(`GitHub API answered ${res.status} for ${path}`);
    return res.json();
  }
}

/** Pushes an existing, verified commit object and opens a draft PR. Implementations must be idempotent. */
export interface GitHubWriter {
  pushBranch(input: { fullName: string; repositoryId: number; branch: string; headSha: string; repoDir: string }): Promise<void>;
  createPullRequest(input: { fullName: string; repositoryId: number; head: string; base: string; title: string; body: string; draft: boolean }): Promise<{ number: number; url: string }>;
}

/** The default: publishing is off. */
export class DisabledWriter implements GitHubWriter {
  async pushBranch(): Promise<void> {
    throw new Error('publishing is disabled (PUBLISHER_PUBLISH_BACKEND=disabled)');
  }

  async createPullRequest(): Promise<{ number: number; url: string }> {
    throw new Error('publishing is disabled (PUBLISHER_PUBLISH_BACKEND=disabled)');
  }
}

/** Records what would be pushed; used to exercise the publish path without GitHub. */
export class MockWriter implements GitHubWriter {
  readonly pushes: Array<{ fullName: string; branch: string; headSha: string }> = [];
  readonly pullRequests: Array<{ fullName: string; head: string; base: string; title: string; number: number }> = [];

  async pushBranch(input: { fullName: string; branch: string; headSha: string }): Promise<void> {
    const existing = this.pushes.find((p) => p.fullName === input.fullName && p.branch === input.branch);
    if (existing && existing.headSha !== input.headSha) throw new Error(`${input.branch} already exists at ${existing.headSha}`);
    if (!existing) this.pushes.push({ fullName: input.fullName, branch: input.branch, headSha: input.headSha });
  }

  async createPullRequest(input: { fullName: string; head: string; base: string; title: string }): Promise<{ number: number; url: string }> {
    let pr = this.pullRequests.find((p) => p.fullName === input.fullName && p.head === input.head);
    if (!pr) {
      pr = { ...input, number: this.pullRequests.length + 1 };
      this.pullRequests.push(pr);
    }
    return { number: pr.number, url: `mock://${input.fullName}/pull/${pr.number}` };
  }
}

function encodePath(fullName: string): string {
  return fullName.split('/').map(encodeURIComponent).join('/');
}
