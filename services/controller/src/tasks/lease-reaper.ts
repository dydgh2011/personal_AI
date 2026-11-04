import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { TasksService } from './tasks.service.js';

/**
 * Periodically fails tasks whose worker lease expired, so a crashed worker
 * cannot leave a task running forever. Runs once at startup too, which covers
 * leases that ran out while the controller itself was down.
 */
@Injectable()
export class LeaseReaper implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(LeaseReaper.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly tasks: TasksService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.leaseSweepSeconds === 0) return;
    await this.sweep();
    this.timer = setInterval(() => void this.sweep(), this.config.leaseSweepSeconds * 1000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(): Promise<number> {
    try {
      return (await this.tasks.expireLeases()).length;
    } catch (error) {
      this.logger.error(`Lease sweep failed: ${(error as Error).message}`);
      return 0;
    }
  }
}
