import { AnonymousCredentials, TokenFileCredentials } from './github-credentials.js';
import { GitHubClient, GitHubApiError, nextLink, normaliseRepository, stripCredentials } from './github-client.js';

describe('GitHub client helpers', () => {
  it('follows rel="next" only on the API origin', () => {
    const base = 'https://api.github.com';
    expect(nextLink('<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=5>; rel="last"', base))
      .toBe('https://api.github.com/user/repos?page=2');
    expect(nextLink('<https://evil.example/steal>; rel="next"', base)).toBeNull();
    expect(nextLink('<https://api.github.com/user/repos?page=1>; rel="prev"', base)).toBeNull();
    expect(nextLink(null, base)).toBeNull();
  });

  it('strips credentials from clone URLs', () => {
    expect(stripCredentials('https://x-access-token:ghs_secret@github.com/a/b.git')).toBe('https://github.com/a/b.git');
    expect(normaliseRepository({
      id: 1, full_name: 'a/b', owner: { login: 'a' }, clone_url: 'https://user:pw@github.com/a/b.git', private: true,
    })).toMatchObject({ cloneUrl: 'https://github.com/a/b.git', visibility: 'private', defaultBranch: 'main', permissions: null });
  });

  it('rejects malformed repository data and names', async () => {
    expect(() => normaliseRepository({ id: '1', full_name: 'a/b' })).toThrow(GitHubApiError);
    expect(() => normaliseRepository({ id: 1, full_name: '../../x', owner: { login: 'a' } })).toThrow(GitHubApiError);
    const client = new GitHubClient({ baseUrl: 'https://api.github.com', credentials: new AnonymousCredentials(), fetchImpl: () => { throw new Error('no network'); } });
    await expect(client.getRepository('a/../../etc')).rejects.toThrow(/Invalid repository name/);
    await expect(client.getBranchHead('a/b', '../x')).rejects.toThrow(/Invalid branch name/);
  });

  it('sends the token only as an Authorization header and never serialises it', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'ghc-'));
    const token = 'github_pat_' + 'Q'.repeat(30);
    writeFileSync(join(dir, 't'), token);
    const credentials = new TokenFileCredentials(join(dir, 't'));
    rmSync(dir, { recursive: true, force: true });
    expect(JSON.stringify(credentials)).not.toContain(token);
    const seen: Array<{ url: string; auth: string | null }> = [];
    const client = new GitHubClient({
      baseUrl: 'https://api.github.com',
      credentials,
      fetchImpl: async (url, init) => {
        seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
        return new Response(JSON.stringify({ id: 9, full_name: 'a/b', owner: { login: 'a' } }), { status: 200 });
      },
    });
    await client.getRepository('a/b');
    expect(seen).toEqual([{ url: 'https://api.github.com/repos/a/b', auth: `Bearer ${token}` }]);
  });
});
