import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AuthManager, claudeBackend, codexBackend, type AuthReport } from './auth.js';
import type { Logger } from './logger.js';

const FAKE = resolve(fileURLToPath(new URL('../test-fixtures/fake-login.mjs', import.meta.url)));
const logger: Logger = { info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;
const fast = { statusCacheMs: 60_000, sessionTimeoutMs: 3_000, pollMs: 20, maxAttempts: 2, cooldownMs: 3_600_000 };

/** Controller stand-in: records reports, hands out a code once the URL has been reported. */
class FakeChannel {
  reports: AuthReport[] = [];
  code: string | null = null;
  requested = false;
  async reportAuth(r: AuthReport) {
    this.reports.push(JSON.parse(JSON.stringify(r)));
    const code = r.session?.status === 'waiting_user' ? this.code : null;
    if (code) this.code = null;
    return { requested: this.requested, code };
  }
  statuses() {
    return this.reports.filter((r) => r.session).map((r) => r.session!.status).filter((s, i, a) => a[i - 1] !== s);
  }
}

describe('AuthManager', () => {
  let state: string;
  let channel: FakeChannel;
  const signal = new AbortController().signal;

  beforeEach(() => {
    // The fake CLI keeps its login state in $HOME/.fake-login; each test gets a fresh HOME.
    // (node --test runs every test file in its own process, so this does not leak.)
    process.env.HOME = mkdtempSync(join(tmpdir(), 'auth-home-'));
    state = join(process.env.HOME, '.fake-login');
    channel = new FakeChannel();
  });

  it('lets a logged-in worker claim without starting a login', async () => {
    writeFileSync(state, 'in');
    const m = new AuthManager('claude', claudeBackendFor(), channel, logger, fast);
    assert.equal(await m.ready(signal), true);
    assert.deepEqual(channel.reports, [{ loggedIn: true }]);
  });

  it('claude: reports the URL, types the code it gets back, and reports success', async () => {
    channel.code = 'good-code-123';
    const m = new AuthManager('claude', claudeBackendFor(), channel, logger, fast);
    assert.equal(await m.ready(signal), true);
    const waiting = channel.reports.find((r) => r.session?.status === 'waiting_user')!.session!;
    assert.equal(waiting.needsCode, true);
    assert.match(waiting.loginUrl!, /^https:\/\/claude\.com\/cai\/oauth\/authorize/);
    // "verifying" is set by the controller when it hands out the code; the fake CLI exits at once.
    assert.deepEqual(channel.statuses().filter((s) => s !== 'verifying'), ['waiting_user', 'succeeded']);
    assert.equal(channel.reports.at(-1)!.loggedIn, true);
  });

  it('claude: a wrong code fails the session; the next poll starts a fresh one', async () => {
    channel.code = 'wrong-code-999';
    const m = new AuthManager('claude', claudeBackendFor(), channel, logger, fast);
    assert.equal(await m.ready(signal), false);
    const failed = channel.reports.at(-1)!.session!;
    assert.equal(failed.status, 'failed');
    assert.doesNotMatch(failed.message!, /https?:/, 'no URLs (state parameters) in messages');
    channel.code = 'good-code-123';
    assert.equal(await m.ready(signal), true);
  });

  it('codex: reports the device URL and one-time code; nothing travels back', async () => {
    const m = new AuthManager('codex', codexBackendFor(), channel, logger, fast);
    assert.equal(await m.ready(signal), true);
    const waiting = channel.reports.find((r) => r.session?.status === 'waiting_user')!.session!;
    assert.deepEqual([waiting.loginUrl, waiting.userCode, waiting.needsCode], ['https://auth.openai.com/codex/device', 'ABCD-EFGHI', false]);
    assert.equal(channel.statuses().at(-1), 'succeeded');
  });

  it('codex: the CLI timing out counts as an expired link, not a failure', async () => {
    writeFileSync(state, 'timeout');
    const m = new AuthManager('codex', codexBackendFor(), channel, logger, fast);
    assert.equal(await m.ready(signal), false);
    assert.equal(channel.reports.at(-1)!.session!.status, 'expired');
  });

  it('expires an unanswered session and then backs off until a login is requested', async () => {
    const m = new AuthManager('claude', claudeBackendFor(), channel, logger, { ...fast, sessionTimeoutMs: 150, maxAttempts: 1 });
    assert.equal(await m.ready(signal), false);
    assert.equal(channel.reports.at(-1)!.session!.status, 'expired');
    const before = channel.reports.length;
    assert.equal(await m.ready(signal), false);
    assert.equal(channel.reports.length, before + 1, 'cooldown: only a status report, no new session');
    channel.requested = true;
    channel.code = 'good-code-123';
    assert.equal(await m.ready(signal), true, 'a requested login runs despite the cooldown');
  });
});

// Backends that run the fake CLI script through node.
function claudeBackendFor() {
  return wrap(claudeBackend);
}
function codexBackendFor() {
  return wrap(codexBackend);
}
function wrap(make: (cmd: string) => ReturnType<typeof claudeBackend>) {
  // The backends take one executable, like the real CLIs: a launcher for `node fake-login.mjs <args>`.
  // POSIX only (the suite runs in the Linux build image).
  const dir = mkdtempSync(join(tmpdir(), 'fakecli-'));
  const launcher = join(dir, 'fake');
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  return make(launcher);
}
