import { Injectable } from '@nestjs/common';
import type { WorkerPrincipal } from '../auth/principal.js';
import { Clock } from '../common/clock.js';

/**
 * Remembers when each worker last called the controller. In-memory only: it
 * resets on restart and is meant for status display, not for recovery
 * decisions (those must use the persisted task lease).
 */
@Injectable()
export class WorkerPresence {
  private readonly lastSeen = new Map<string, string>();

  constructor(private readonly clock: Clock) {}

  touch(worker: WorkerPrincipal): void {
    this.lastSeen.set(worker.workerId, this.clock.now().toISOString());
  }

  lastSeenAt(workerId: string): string | null {
    return this.lastSeen.get(workerId) ?? null;
  }
}
