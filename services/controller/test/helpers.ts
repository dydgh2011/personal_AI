import { randomBytes } from 'node:crypto';
import type { AppConfig } from '../src/config/app-config.js';

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    databasePath: ':memory:',
    adminToken: randomToken(),
    workers: [
      { agent: 'claude', workerId: 'claude-worker', token: randomToken() },
      { agent: 'codex', workerId: 'codex-worker', token: randomToken() },
    ],
    delegators: [{ clientId: 'hermes', token: randomToken() }],
    dashboardToken: randomToken(),
    publisherToken: randomToken(),
    testRunnerToken: randomToken(),
    publishEnabled: false,
    leaseSeconds: 900,
    leaseSweepSeconds: 0,
    projectIds: ['sandbox', 'personal-ai'],
    statusProbes: [],
    idempotencyWindowSeconds: 600,
    github: { apiUrl: 'http://127.0.0.1:9', tokenFile: null },
    ...overrides,
  };
}

/** Clock whose time only moves when the test says so. */
export class FakeClock {
  constructor(private current = new Date('2026-01-01T00:00:00.000Z')) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
