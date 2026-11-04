import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditModule } from './audit/audit.js';
import { AuthGuard } from './auth/auth.js';
import { CommonModule } from './common/common.module.js';
import type { AppConfig } from './config/app-config.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { DomainsModule } from './domains/domains.js';
import { ExportModule } from './export/export.js';
import { GoalsModule } from './goals/goals.js';
import { HealthModule } from './health/health.js';
import { IdeasModule } from './ideas/ideas.js';
import { ProviderModule } from './provider/provider.js';
import { RoadmapsModule } from './roadmaps/roadmaps.js';

@Module({})
export class AppModule {
  /** Configuration is loaded and validated by the caller, so tests can pass their own. */
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        CommonModule,
        DatabaseModule,
        AuditModule,
        ProviderModule,
        DomainsModule,
        IdeasModule,
        GoalsModule,
        RoadmapsModule,
        ExportModule,
        HealthModule,
      ],
      providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
    };
  }
}
