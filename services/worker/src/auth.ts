import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { AgentType } from './config.js';
import type { Logger } from './logger.js';
import { agentEnvironment } from './runners/agent-runner.js';

/**
 * Keeps the agent CLI's subscription login alive without anyone opening a terminal.
 *
 * Before claiming a task the worker asks the CLI whether it is logged in. If not, it does not
 * claim (tasks stay queued instead of failing) and starts the CLI's own login flow, reporting
 * the login URL to the controller; the owner gets it on Discord. Claude prints a code after the
 * owner signs in, which travels back Discord → Hermes → broker → controller → here and is typed
 * into the same login process. Codex uses a device code the owner types on the website, so
 * nothing travels back. Tokens are written by the CLI into its own home directory as usual.
 */

export interface LoginInfo {
  loginUrl: string;
  userCode: string | null;
  needsCode: boolean;
}

export interface LoginProcess {
  /** Resolves once the CLI printed its login URL. */
  info: Promise<LoginInfo>;
  sendCode(code: string): void;
  /** Resolves when the login process exits. */
  done: Promise<{ exitCode: number | null; output: string }>;
  kill(): void;
}

export interface AuthBackend {
  isLoggedIn(): Promise<boolean>;
  startLogin(): LoginProcess;
}

export interface AuthReport {
  loggedIn: boolean;
  session?: {
    id: string;
    status: 'waiting_user' | 'verifying' | 'succeeded' | 'failed' | 'expired';
    loginUrl?: string | null;
    userCode?: string | null;
    needsCode?: boolean;
    expiresAt?: string | null;
    message?: string | null;
  } | null;
}

export interface AuthChannel {
  reportAuth(report: AuthReport): Promise<{ requested: boolean; code: string | null }>;
}

export interface AuthManagerOptions {
  /** How long a "logged in" answer is trusted before asking the CLI again. */
  statusCacheMs: number;
  /** How long one login session waits for the owner. */
  sessionTimeoutMs: number;
  /** Poll interval while a session waits. */
  pollMs: number;
  /** After this many failed/expired sessions in a row, wait `cooldownMs` unless a login is requested. */
  maxAttempts: number;
  cooldownMs: number;
}

export const DEFAULT_AUTH_OPTIONS: AuthManagerOptions = {
  statusCacheMs: 60_000,
  sessionTimeoutMs: 15 * 60_000,
  pollMs: 3_000,
  maxAttempts: 2,
  cooldownMs: 6 * 3600_000,
};

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

function clean(text: string): string {
  return text.replace(ANSI, '');
}

/** Short, URL-free description of how a login ended (no codes, no state parameters). */
function summarize(output: string): string {
  const lines = clean(output)
    .split('\n')
    .map((l) => l.replace(/https?:\/\/\S+/g, '<url>').trim())
    .filter(Boolean);
  return lines.slice(-3).join(' / ').slice(0, 400) || 'no output';
}

function runQuiet(command: string, args: string[], timeoutMs = 20_000): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: agentEnvironment({ NO_COLOR: '1' }), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const add = (d: Buffer) => {
      if (output.length < 64_000) output += d.toString('utf8');
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ exitCode: null, output });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, output });
    });
  });
}

function startCli(command: string, args: string[], parse: (out: string) => LoginInfo | null): LoginProcess {
  const child = spawn(command, args, { env: agentEnvironment({ NO_COLOR: '1' }), stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  let resolveInfo!: (i: LoginInfo) => void;
  let rejectInfo!: (e: Error) => void;
  let settled = false;
  const info = new Promise<LoginInfo>((res, rej) => {
    resolveInfo = res;
    rejectInfo = rej;
  });
  info.catch(() => {});
  const onData = (d: Buffer) => {
    if (output.length < 64_000) output += d.toString('utf8');
    if (!settled) {
      const parsed = parse(clean(output));
      if (parsed) {
        settled = true;
        resolveInfo(parsed);
      }
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const done = new Promise<{ exitCode: number | null; output: string }>((resolve) => {
    child.on('error', (e) => {
      if (!settled) {
        settled = true;
        rejectInfo(new Error(`Could not start ${command}: ${e.message}`));
      }
      resolve({ exitCode: null, output });
    });
    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        rejectInfo(new Error(`${command} exited before printing a login URL: ${summarize(output)}`));
      }
      resolve({ exitCode: code, output });
    });
  });
  return {
    info,
    done,
    sendCode: (code) => {
      child.stdin.write(`${code}\n`);
    },
    kill: () => {
      child.kill('SIGTERM');
    },
  };
}

export function claudeBackend(command: string): AuthBackend {
  return {
    async isLoggedIn() {
      const r = await runQuiet(command, ['auth', 'status']);
      try {
        const json = JSON.parse(clean(r.output).slice(clean(r.output).indexOf('{'))) as { loggedIn?: unknown };
        return json.loggedIn === true;
      } catch {
        return false;
      }
    },
    startLogin: () =>
      startCli(command, ['auth', 'login', '--claudeai'], (out) => {
        const url = /(https:\/\/(?:claude\.com|claude\.ai|platform\.claude\.com|console\.anthropic\.com)\/\S+)/.exec(out)?.[1];
        return url && /Paste code/i.test(out) ? { loginUrl: url, userCode: null, needsCode: true } : null;
      }),
  };
}

export function codexBackend(command: string): AuthBackend {
  return {
    async isLoggedIn() {
      const r = await runQuiet(command, ['login', 'status']);
      return r.exitCode === 0 && /logged in/i.test(r.output) && !/not logged in/i.test(r.output);
    },
    startLogin: () =>
      startCli(command, ['login', '--device-auth'], (out) => {
        const url = /(https:\/\/auth\.openai\.com\/\S+)/.exec(out)?.[1];
        const after = out.slice(out.search(/one-time code/i));
        const code = /\b([A-Z0-9]{4,6}-[A-Z0-9]{4,6})\b/.exec(after)?.[1];
        return url && code ? { loginUrl: url, userCode: code, needsCode: false } : null;
      }),
  };
}

export class AuthManager {
  private checkedAt = 0;
  private loggedIn = false;
  private failures = 0;
  private cooldownUntil = 0;

  constructor(
    private readonly agent: AgentType,
    private readonly backend: AuthBackend,
    private readonly channel: AuthChannel,
    private readonly logger: Logger,
    private readonly options: AuthManagerOptions = DEFAULT_AUTH_OPTIONS,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void> = defaultSleep,
  ) {}

  /** Forget the cached status (e.g. after a task failed with an authentication error). */
  invalidate(): void {
    this.checkedAt = 0;
  }

  /**
   * True when the CLI is logged in and the worker may claim a task. Otherwise runs (at most) one
   * login session and returns false; the caller polls again.
   */
  async ready(signal: AbortSignal): Promise<boolean> {
    if (this.loggedIn && this.now() - this.checkedAt < this.options.statusCacheMs) return true;
    this.loggedIn = await this.backend.isLoggedIn();
    this.checkedAt = this.now();
    const { requested } = await this.channel.reportAuth({ loggedIn: this.loggedIn });
    if (this.loggedIn) {
      this.failures = 0;
      return true;
    }
    if (!requested && this.now() < this.cooldownUntil) return false;
    await this.runSession(signal);
    return this.loggedIn;
  }

  private async runSession(signal: AbortSignal): Promise<void> {
    const id = randomUUID();
    const proc = this.backend.startLogin();
    let info: LoginInfo;
    try {
      info = await withTimeout(proc.info, 30_000, 'The login command did not print a URL in time');
    } catch (error) {
      proc.kill();
      await this.finish(id, 'failed', (error as Error).message);
      return;
    }
    const expiresAt = new Date(this.now() + this.options.sessionTimeoutMs).toISOString();
    const waiting = { id, status: 'waiting_user' as const, loginUrl: info.loginUrl, userCode: info.userCode, needsCode: info.needsCode, expiresAt };
    this.logger.info('Login required: waiting for the owner', { agent: this.agent, sessionId: id, needsCode: info.needsCode });

    let exited: { exitCode: number | null; output: string } | null = null;
    void proc.done.then((r) => (exited = r));
    const deadline = this.now() + this.options.sessionTimeoutMs;
    let codeSent = false;
    while (!exited && !signal.aborted && this.now() < deadline) {
      try {
        const reply = await this.channel.reportAuth({ loggedIn: false, session: codeSent ? { ...waiting, status: 'verifying' } : waiting });
        if (reply.code && info.needsCode && !codeSent) {
          proc.sendCode(reply.code);
          codeSent = true;
          this.logger.info('Login code received; verifying', { agent: this.agent, sessionId: id });
        }
      } catch (error) {
        this.logger.warn('Could not report login state', { agent: this.agent, error: (error as Error).message });
      }
      await this.sleep(this.options.pollMs, signal);
    }
    if (!exited) {
      proc.kill();
      await Promise.race([proc.done, new Promise((r) => setTimeout(r, 5000))]);
      await this.finish(id, 'expired', signal.aborted ? 'The worker is shutting down' : 'Nobody completed the login in time');
      return;
    }
    const result = exited as { exitCode: number | null; output: string };
    this.loggedIn = await this.backend.isLoggedIn();
    this.checkedAt = this.now();
    if (this.loggedIn) {
      this.failures = 0;
      this.cooldownUntil = 0;
      await this.report({ loggedIn: true, session: { id, status: 'succeeded', message: 'Login completed' } });
      this.logger.info('Login completed', { agent: this.agent, sessionId: id });
    } else {
      // The CLI gave up waiting for the owner (e.g. Codex "device auth timed out"): that is an expired link, not an error.
      const status = /timed out|expired/i.test(result.output) ? 'expired' : 'failed';
      await this.finish(id, status, `Login did not complete (exit ${result.exitCode}): ${summarize(result.output)}`);
    }
  }

  private async finish(id: string, status: 'failed' | 'expired', message: string): Promise<void> {
    this.failures += 1;
    if (this.failures >= this.options.maxAttempts) this.cooldownUntil = this.now() + this.options.cooldownMs;
    this.logger.warn(`Login ${status}`, { agent: this.agent, sessionId: id, failures: this.failures, message });
    await this.report({ loggedIn: false, session: { id, status, message } });
  }

  private async report(report: AuthReport): Promise<void> {
    try {
      await this.channel.reportAuth(report);
    } catch (error) {
      this.logger.warn('Could not report login state', { agent: this.agent, error: (error as Error).message });
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
