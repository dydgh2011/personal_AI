import { readFileSync } from 'node:fs';

export type GitHubAuthMode = 'none' | 'token' | 'github_app';

/**
 * Source of the Authorization header for GitHub API calls. Kept behind an
 * interface so a GitHub App (short-lived installation tokens scoped to the
 * installed repositories) can replace the token file without touching callers.
 * Implementations must never expose the secret except through `authorization()`.
 */
export interface GitHubCredentials {
  readonly mode: GitHubAuthMode;
  /** Value for the Authorization header, or null for anonymous (public data only). */
  authorization(): Promise<string | null>;
}

/** Default: anonymous requests. Only public repositories are visible; 60 requests/hour. */
export class AnonymousCredentials implements GitHubCredentials {
  readonly mode = 'none' as const;
  async authorization(): Promise<string | null> {
    return null;
  }
}

/**
 * A token read from a file (GITHUB_TOKEN_FILE), e.g. a fine-grained personal access token
 * with read-only "Contents" and "Metadata" permissions on selected repositories.
 * Read once at startup; the value is never logged or returned by the API.
 */
export class TokenFileCredentials implements GitHubCredentials {
  readonly mode = 'token' as const;
  readonly #header: string;

  constructor(path: string) {
    let token: string;
    try {
      token = readFileSync(path, 'utf8').trim();
    } catch {
      throw new Error(`GITHUB_TOKEN_FILE is set but ${path} cannot be read`);
    }
    if (token.length < 20 || /\s/.test(token)) {
      throw new Error(`GITHUB_TOKEN_FILE ${path} does not contain a valid token`);
    }
    this.#header = `Bearer ${token}`;
  }

  async authorization(): Promise<string | null> {
    return this.#header;
  }

  /** Keeps the token out of accidental JSON/console output of this object. */
  toJSON() {
    return { mode: this.mode };
  }
}
