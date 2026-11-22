import type { DatabaseSync } from 'node:sqlite';
import {
  buildAuthRequest,
  exchangeCode,
  googleAccount,
  GoogleError,
  refreshAccess,
  SCOPES,
  type GoogleAccount,
  type Fetch,
  type OAuthClient,
} from './google.js';

const PENDING_TTL_MS = 15 * 60_000;

export interface ConnectionStatus {
  configured: boolean;
  connected: boolean;
  connectedAt: string | null;
  /** The last refresh failed with invalid_grant: the owner must connect again. */
  needsReconnect: boolean;
  /** Connected with an older set of permissions: connect again to grant the current ones. */
  missingPermissions: boolean;
}

const hasAllScopes = (scope: string | null) => scope !== null && SCOPES.every((s) => scope.split(' ').includes(s));

/**
 * The Google connection: OAuth client config, pending sign-ins and the stored tokens.
 * Tokens live only in the planner DB; nothing here returns them.
 */
export class GoogleConnection {
  private needsReconnect = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly client: OAuthClient | null,
    readonly redirectUri: string,
    readonly timeZone: string,
    private readonly f: Fetch = fetch,
    private readonly now: () => number = Date.now,
    /** Test hook: use this account instead of Google's. */
    private readonly accountOverride: GoogleAccount | null = null,
  ) {}

  status(): ConnectionStatus {
    if (this.accountOverride) return { configured: true, connected: true, connectedAt: null, needsReconnect: false, missingPermissions: false };
    const row = this.db.prepare('SELECT connected_at, scope FROM google_auth WHERE id = 1').get() as
      | { connected_at: string; scope: string | null }
      | undefined;
    const missing = !!row && !hasAllScopes(row.scope);
    return {
      configured: this.client !== null,
      connected: !!row && !missing,
      connectedAt: row?.connected_at ?? null,
      needsReconnect: this.needsReconnect || missing,
      missingPermissions: missing,
    };
  }

  /** Starts a sign-in: returns the Google URL to open. The state/verifier wait 15 minutes. */
  start(): { authUrl: string; expiresAt: string } {
    if (!this.client) throw new GoogleError(503, 'The Google OAuth client file is not configured');
    const pending = buildAuthRequest(this.client, this.redirectUri);
    const expires = this.now() + PENDING_TTL_MS;
    this.db.prepare('DELETE FROM oauth_pending WHERE expires_at < ?').run(this.now());
    this.db.prepare('INSERT INTO oauth_pending (state, verifier, expires_at) VALUES (?, ?, ?)').run(pending.state, pending.verifier, expires);
    return { authUrl: pending.url, expiresAt: new Date(expires).toISOString() };
  }

  /** Completes a sign-in from the redirect. The state must match a pending, unexpired one. */
  async finish(state: string, code: string): Promise<void> {
    if (!this.client) throw new GoogleError(503, 'The Google OAuth client file is not configured');
    const row = this.db.prepare('SELECT verifier, expires_at FROM oauth_pending WHERE state = ?').get(state) as
      | { verifier: string; expires_at: number }
      | undefined;
    this.db.prepare('DELETE FROM oauth_pending WHERE state = ?').run(state);
    if (!row || row.expires_at < this.now()) throw new GoogleError(400, 'This sign-in link expired or was already used. Ask for a new one.');
    const tokens = await exchangeCode(this.client, code, row.verifier, this.redirectUri, this.f, this.now);
    if (!tokens.refreshToken) throw new GoogleError(502, 'Google returned no refresh token; remove the app at myaccount.google.com/permissions and connect again');
    // Google lets the owner untick permissions on the consent screen; all three are needed.
    if (!hasAllScopes(tokens.scope)) {
      throw new GoogleError(400, 'Not all calendar permissions were granted. Connect again and tick every calendar permission.');
    }
    this.db
      .prepare(
        `INSERT INTO google_auth (id, refresh_token, access_token, access_expires_at, scope, connected_at) VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET refresh_token = excluded.refresh_token, access_token = excluded.access_token,
           access_expires_at = excluded.access_expires_at, scope = excluded.scope, connected_at = excluded.connected_at`,
      )
      .run(tokens.refreshToken, tokens.accessToken, tokens.expiresAt, tokens.scope, new Date(this.now()).toISOString());
    this.needsReconnect = false;
  }

  /** The Google account, or null when not connected (with the current permissions). */
  account(): GoogleAccount | null {
    if (this.accountOverride) return this.accountOverride;
    if (!this.client || !this.status().connected) return null;
    return googleAccount(() => this.accessToken(), this.timeZone, this.f);
  }

  private async accessToken(): Promise<string> {
    const row = this.db.prepare('SELECT refresh_token, access_token, access_expires_at FROM google_auth WHERE id = 1').get() as
      | { refresh_token: string; access_token: string | null; access_expires_at: number | null }
      | undefined;
    if (!row) throw new GoogleError(409, 'Google Calendar is not connected');
    if (row.access_token && row.access_expires_at && row.access_expires_at - 60_000 > this.now()) return row.access_token;
    try {
      const tokens = await refreshAccess(this.client!, row.refresh_token, this.f, this.now);
      this.db
        .prepare('UPDATE google_auth SET access_token = ?, access_expires_at = ?, refresh_token = COALESCE(?, refresh_token) WHERE id = 1')
        .run(tokens.accessToken, tokens.expiresAt, tokens.refreshToken);
      return tokens.accessToken;
    } catch (error) {
      if (error instanceof GoogleError && error.reconnect) {
        // Revoked or expired grant: forget it so the status says "not connected" until the owner connects again.
        this.db.prepare('DELETE FROM google_auth WHERE id = 1').run();
        this.needsReconnect = true;
      }
      throw error;
    }
  }
}
