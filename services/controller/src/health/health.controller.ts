import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public, RequireRole } from '../auth/auth.decorators.js';
import { SystemStatusService, type SystemStatus } from './system-status.service.js';

@Controller()
export class HealthController {
  constructor(private readonly system: SystemStatusService) {}

  /** Unauthenticated liveness/readiness check used by Docker. Reveals nothing beyond "ok". */
  @Public()
  @Get('health')
  async health(): Promise<{ status: 'ok' }> {
    if (!(await this.system.isDatabaseHealthy())) {
      throw new ServiceUnavailableException({ status: 'error', message: 'Database unavailable' });
    }
    return { status: 'ok' };
  }

  /**
   * Overview for the dashboard and Hermes: versions, task counts, worker
   * liveness, registered project ids and service reachability. No tokens,
   * task contents or configuration secrets.
   */
  @RequireRole(['admin', 'delegator'])
  @Get('system/status')
  status(): Promise<SystemStatus> {
    return this.system.getStatus();
  }
}
