import { Inject, Injectable } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import type { Principal } from './principal.js';

interface TokenEntry {
  digest: Buffer;
  principal: Principal;
}

/**
 * Maps bearer tokens to principals. Only SHA-256 digests are kept in memory
 * after startup, and comparisons are constant-time.
 */
@Injectable()
export class TokenRegistry {
  private readonly entries: readonly TokenEntry[];

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.entries = [
      { digest: digest(config.adminToken), principal: { role: 'admin', name: 'admin' } },
      ...(config.dashboardToken ? [{ digest: digest(config.dashboardToken), principal: { role: 'admin', name: 'dashboard' } as const }] : []),
      ...(config.publisherToken ? [{ digest: digest(config.publisherToken), principal: { role: 'publisher', publisherId: 'github-publisher' } as const }] : []),
      ...(config.testRunnerToken ? [{ digest: digest(config.testRunnerToken), principal: { role: 'test-runner', runnerId: 'test-runner' } as const }] : []),
      ...config.workers.map((worker) => ({
        digest: digest(worker.token),
        principal: { role: 'worker', agent: worker.agent, workerId: worker.workerId } as const,
      })),
      ...config.delegators.map((delegator) => ({
        digest: digest(delegator.token),
        principal: { role: 'delegator', clientId: delegator.clientId } as const,
      })),
    ];
  }

  resolve(token: string): Principal | null {
    const candidate = digest(token);
    let match: Principal | null = null;
    // Check every entry so timing does not reveal which one matched.
    for (const entry of this.entries) {
      if (timingSafeEqual(entry.digest, candidate)) match = entry.principal;
    }
    return match;
  }
}

function digest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
