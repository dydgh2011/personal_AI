import { ConflictException, Injectable } from '@nestjs/common';
import { Clock } from '../common/clock.js';
import { AGENT_TYPES, type AgentType } from '../tasks/task.model.js';

/**
 * Login state of the coding-agent CLIs (Claude Code / Codex subscription logins).
 *
 * When a worker finds its CLI logged out it starts a login itself and reports the session here:
 * the login URL (and, for device-code logins, the one-time code to type there). The broker's
 * watcher turns that into a Discord message. If the CLI needs a code back (Claude), the owner
 * sends it to Hermes, which submits it here; the worker picks it up exactly once and feeds it to
 * its own login process. No credential ever leaves the worker: the code is a one-time PKCE
 * authorization code that only that worker's running login process can redeem.
 *
 * Kept in memory on purpose: sessions live minutes, and the worker re-reports its state on every
 * poll, so a controller restart only loses the transient state for one poll interval.
 */
export const AUTH_SESSION_STATUSES = ['waiting_user', 'code_submitted', 'verifying', 'succeeded', 'failed', 'expired'] as const;
export type AuthSessionStatus = (typeof AUTH_SESSION_STATUSES)[number];
export const ACTIVE_STATUSES: readonly AuthSessionStatus[] = ['waiting_user', 'code_submitted', 'verifying'];

export interface AuthSession {
  id: string;
  status: AuthSessionStatus;
  loginUrl: string | null;
  userCode: string | null;
  needsCode: boolean;
  expiresAt: string | null;
  message: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentAuthView {
  agent: AgentType;
  /** null until the worker has reported at least once since the controller started. */
  loggedIn: boolean | null;
  checkedAt: string | null;
  /** A login was asked for (Hermes action "login_start") and the worker has not started it yet. */
  requested: boolean;
  session: AuthSession | null;
}

export interface WorkerAuthReport {
  loggedIn: boolean;
  session?: {
    id: string;
    status: AuthSessionStatus;
    loginUrl?: string | null;
    userCode?: string | null;
    needsCode?: boolean;
    expiresAt?: string | null;
    message?: string | null;
  } | null;
}

interface AgentState extends AgentAuthView {
  /** Submitted authorization code, handed to the worker once and then forgotten. */
  code: string | null;
}

@Injectable()
export class WorkerAuthService {
  private readonly states = new Map<AgentType, AgentState>(
    AGENT_TYPES.map((agent) => [agent, { agent, loggedIn: null, checkedAt: null, requested: false, session: null, code: null }]),
  );

  constructor(private readonly clock: Clock) {}

  list(): AgentAuthView[] {
    return AGENT_TYPES.map((agent) => this.view(agent));
  }

  /**
   * Worker report + poll in one call. Returns whether a login was requested and, once, the code
   * submitted for the worker's current session.
   */
  report(agent: AgentType, report: WorkerAuthReport): { requested: boolean; code: string | null } {
    const state = this.states.get(agent)!;
    const now = this.clock.now().toISOString();
    state.loggedIn = report.loggedIn;
    state.checkedAt = now;
    const incoming = report.session ?? null;
    if (incoming) {
      const known = state.session?.id === incoming.id ? state.session : null;
      if (!known) {
        // A new login session: whatever was submitted for an older one is void.
        state.code = null;
        state.requested = false;
      }
      // The controller owns the code_submitted/verifying steps; a worker re-reporting "waiting_user"
      // for the same session must not roll them back.
      const status =
        known && incoming.status === 'waiting_user' && (known.status === 'code_submitted' || known.status === 'verifying')
          ? known.status
          : incoming.status;
      state.session = {
        id: incoming.id,
        status,
        loginUrl: incoming.loginUrl ?? known?.loginUrl ?? null,
        userCode: incoming.userCode ?? known?.userCode ?? null,
        needsCode: incoming.needsCode ?? known?.needsCode ?? false,
        expiresAt: incoming.expiresAt ?? known?.expiresAt ?? null,
        message: incoming.message ?? null,
        createdAt: known?.createdAt ?? now,
        updatedAt: known && known.status === status && known.message === (incoming.message ?? null) ? known.updatedAt : now,
      };
      if (!ACTIVE_STATUSES.includes(status)) state.code = null;
    }
    let code: string | null = null;
    if (state.session && state.session.status === 'code_submitted' && state.code) {
      code = state.code;
      state.code = null;
      state.session = { ...state.session, status: 'verifying', updatedAt: now };
    }
    return { requested: state.requested, code };
  }

  /** Hermes/admin: ask the worker to start a login now (e.g. after an expired session). */
  requestLogin(agent: AgentType): AgentAuthView {
    const state = this.states.get(agent)!;
    if (state.session && ACTIVE_STATUSES.includes(state.session.status)) {
      throw new ConflictException(`A ${agent} login is already in progress (${state.session.status})`);
    }
    state.requested = true;
    return this.view(agent);
  }

  /** Hermes/admin: the code shown after signing in at the login URL. */
  submitCode(agent: AgentType, code: string, sessionId?: string): AgentAuthView {
    const state = this.states.get(agent)!;
    const session = state.session;
    if (!session || session.status !== 'waiting_user') {
      throw new ConflictException(`No ${agent} login is waiting for a code${session ? ` (current: ${session.status})` : ''}`);
    }
    if (!session.needsCode) throw new ConflictException(`The ${agent} login completes on the website; no code needs to be sent back`);
    if (sessionId && sessionId !== session.id) throw new ConflictException('That login session is no longer current');
    state.code = code;
    state.session = { ...session, status: 'code_submitted', updatedAt: this.clock.now().toISOString() };
    return this.view(agent);
  }

  private view(agent: AgentType): AgentAuthView {
    const { code: _code, ...view } = this.states.get(agent)!;
    return { ...view, session: view.session ? { ...view.session } : null };
  }
}
