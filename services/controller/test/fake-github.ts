import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRepo {
  id: number;
  full_name: string;
  private?: boolean;
  default_branch?: string;
  archived?: boolean;
  head?: string;
}

/** Minimal GitHub REST API stand-in: repos, branches, paginated user repo lists, rate limits. */
export class FakeGitHub {
  readonly repos = new Map<string, FakeRepo>();
  readonly requests: Array<{ path: string; authorization: string | undefined }> = [];
  /** Respond to the next N requests with a rate-limit error. */
  rateLimited = 0;
  retryAfterSeconds: number | null = null;
  pageSize = 2;
  url = '';
  private server: Server | null = null;

  add(repo: FakeRepo) {
    this.repos.set(repo.full_name.toLowerCase(), repo);
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, {
      'content-type': 'application/json',
      'x-ratelimit-limit': '60',
      'x-ratelimit-remaining': status === 403 && this.retryAfterSeconds === null ? '0' : '59',
      'x-ratelimit-reset': String(Math.floor(Date.UTC(2030, 0, 1) / 1000)),
      'x-ratelimit-resource': 'core',
      ...headers,
    });
    res.end(JSON.stringify(body));
  }

  private repoJson(r: FakeRepo) {
    const [owner, name] = r.full_name.split('/');
    return {
      id: r.id,
      name,
      full_name: r.full_name,
      owner: { login: owner },
      private: r.private ?? false,
      visibility: r.private ? 'private' : 'public',
      default_branch: r.default_branch ?? 'main',
      description: `${name} description`,
      fork: false,
      archived: r.archived ?? false,
      clone_url: `https://github.com/${r.full_name}.git`,
      html_url: `https://github.com/${r.full_name}`,
      updated_at: '2026-10-01T00:00:00Z',
      pushed_at: '2026-10-02T00:00:00Z',
    };
  }

  private handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, this.url);
    this.requests.push({ path: url.pathname + url.search, authorization: req.headers.authorization });
    if (this.rateLimited > 0) {
      this.rateLimited--;
      const headers: Record<string, string> = this.retryAfterSeconds !== null ? { 'retry-after': String(this.retryAfterSeconds) } : {};
      return this.json(res, 403, { message: 'API rate limit exceeded' }, headers);
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'repos' && parts.length >= 3) {
      const repo = this.repos.get(`${parts[1]}/${parts[2]}`.toLowerCase());
      // Private repositories are invisible without credentials, like on GitHub.
      if (!repo || (repo.private && !req.headers.authorization)) return this.json(res, 404, { message: 'Not Found' });
      if (parts.length === 3) return this.json(res, 200, this.repoJson(repo));
      if (parts[3] === 'branches' && decodeURIComponent(parts[4] ?? '') === (repo.default_branch ?? 'main')) {
        return this.json(res, 200, { name: parts[4], commit: { sha: repo.head ?? 'a'.repeat(40) } });
      }
      return this.json(res, 404, { message: 'Branch not found' });
    }
    if ((parts[0] === 'users' || parts[0] === 'orgs') && parts[2] === 'repos') {
      const owner = parts[1].toLowerCase();
      const all = [...this.repos.values()].filter(
        (r) => r.full_name.toLowerCase().startsWith(`${owner}/`) && (!r.private || req.headers.authorization),
      );
      return this.page(res, url, all);
    }
    if (url.pathname === '/user/repos') {
      if (!req.headers.authorization) return this.json(res, 401, { message: 'Requires authentication' });
      return this.page(res, url, [...this.repos.values()]);
    }
    return this.json(res, 404, { message: 'Not Found' });
  }

  private page(res: ServerResponse, url: URL, all: FakeRepo[]) {
    const page = Number(url.searchParams.get('page') ?? '1');
    const slice = all.slice((page - 1) * this.pageSize, page * this.pageSize);
    const headers: Record<string, string> = {};
    if (page * this.pageSize < all.length) {
      const next = new URL(url);
      next.searchParams.set('page', String(page + 1));
      headers.link = `<${next.toString()}>; rel="next", <${url.origin}${url.pathname}?page=99>; rel="last"`;
    }
    this.json(res, 200, slice.map((r) => this.repoJson(r)), headers);
  }
}
