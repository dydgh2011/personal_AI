import { Controller, Get, Inject, Module, ServiceUnavailableException } from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import { Public } from '../auth/auth.js';
import { SQLITE_CONNECTION } from '../database/database.module.js';
import { MIGRATIONS } from '../database/migrations.js';
import { ProviderService } from '../provider/provider.js';

@Controller()
export class HealthController {
  constructor(@Inject(SQLITE_CONNECTION) private readonly db: Database, private readonly provider: ProviderService) {}

  /** Docker liveness/readiness. Reveals nothing beyond "ok". */
  @Public()
  @Get('health')
  health(): { status: 'ok' } {
    try {
      this.db.prepare('SELECT 1').get();
    } catch {
      throw new ServiceUnavailableException({ status: 'error' });
    }
    return { status: 'ok' };
  }

  /** Overview counts and AI usage for the dashboard (owner only). No content, no secrets. */
  @Get('status')
  status() {
    const count = (sql: string) => (this.db.prepare(sql).get() as { c: number }).c;
    return {
      schemaVersion: this.db.pragma('user_version', { simple: true }),
      supportedSchema: MIGRATIONS.length,
      counts: {
        domains: count("SELECT COUNT(*) AS c FROM domains WHERE status <> 'archived'"),
        ideasInbox: count("SELECT COUNT(*) AS c FROM ideas WHERE state = 'inbox'"),
        goals: count("SELECT COUNT(*) AS c FROM goals WHERE status = 'active'"),
        roadmaps: count("SELECT COUNT(*) AS c FROM roadmaps WHERE status = 'active'"),
        pendingProposals: count("SELECT COUNT(*) AS c FROM ai_proposals WHERE state = 'awaiting_user_approval'"),
      },
      ai: this.provider.usage(),
    };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
