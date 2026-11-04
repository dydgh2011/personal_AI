import { randomToken } from '../../test/helpers.js';
import { ConfigError, loadConfig } from './app-config.js';

function validEnv(): NodeJS.ProcessEnv {
  return {
    CONTROLLER_ADMIN_TOKEN: randomToken(),
    CONTROLLER_CLAUDE_WORKER_TOKEN: randomToken(),
    CONTROLLER_CODEX_WORKER_TOKEN: randomToken(),
  };
}

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(validEnv());
    expect(config.port).toBe(3000);
    expect(config.host).toBe('0.0.0.0');
    expect(config.leaseSeconds).toBe(900);
    expect(config.projectIds).toEqual([]);
    expect(config.workers.map((w) => w.agent)).toEqual(['claude', 'codex']);
  });

  it('parses project ids and status probes', () => {
    const config = loadConfig({
      ...validEnv(),
      CONTROLLER_PROJECT_IDS: 'sandbox, personal-ai',
      CONTROLLER_STATUS_PROBES: 'hermes=http://hermes:9119/',
    });
    expect(config.projectIds).toEqual(['sandbox', 'personal-ai']);
    expect(config.statusProbes).toEqual([{ name: 'hermes', url: 'http://hermes:9119/' }]);
  });

  it('requires every token', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ ...validEnv(), CONTROLLER_CODEX_WORKER_TOKEN: '' })).toThrow(
      /CONTROLLER_CODEX_WORKER_TOKEN is required/,
    );
  });

  it('rejects short tokens without echoing them', () => {
    const shortToken = 'short-secret-value';
    let message = '';
    try {
      loadConfig({ ...validEnv(), CONTROLLER_ADMIN_TOKEN: shortToken });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/CONTROLLER_ADMIN_TOKEN must be at least 32 characters/);
    expect(message).not.toContain(shortToken);
  });

  it('rejects reused tokens', () => {
    const env = validEnv();
    env.CONTROLLER_CLAUDE_WORKER_TOKEN = env.CONTROLLER_ADMIN_TOKEN;
    expect(() => loadConfig(env)).toThrow(/must all be different/);
  });

  it('configures the Hermes delegator only when its token is set', () => {
    expect(loadConfig(validEnv()).delegators).toEqual([]);
    expect(loadConfig(validEnv()).idempotencyWindowSeconds).toBe(600);
    const hermesToken = randomToken();
    expect(loadConfig({ ...validEnv(), CONTROLLER_HERMES_TOKEN: hermesToken }).delegators).toEqual([
      { clientId: 'hermes', token: hermesToken },
    ]);
    expect(() => loadConfig({ ...validEnv(), CONTROLLER_HERMES_TOKEN: 'short' })).toThrow(
      /CONTROLLER_HERMES_TOKEN must be at least 32 characters/,
    );
    const env = validEnv();
    expect(() => loadConfig({ ...env, CONTROLLER_HERMES_TOKEN: env.CONTROLLER_ADMIN_TOKEN })).toThrow(/must all be different/);
    expect(() => loadConfig({ ...validEnv(), CONTROLLER_IDEMPOTENCY_WINDOW_SECONDS: '0' })).toThrow(/IDEMPOTENCY/);
  });

  it('rejects path-like project ids and bad numbers', () => {
    expect(() => loadConfig({ ...validEnv(), CONTROLLER_PROJECT_IDS: '../etc' })).toThrow(/invalid project id/);
    expect(() => loadConfig({ ...validEnv(), CONTROLLER_LEASE_SECONDS: '5' })).toThrow(/LEASE_SECONDS/);
    expect(() => loadConfig({ ...validEnv(), PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...validEnv(), CONTROLLER_STATUS_PROBES: 'hermes=file:///etc/passwd' })).toThrow(
      /STATUS_PROBES/,
    );
  });
});
