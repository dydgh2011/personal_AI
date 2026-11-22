import { Module, type DynamicModule } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { CommonModule } from './common/common.module.js';
import type { AppConfig } from './config/app-config.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { PublicationsModule } from './publications/publications.module.js';
import { TestValidationsModule } from './test-validations/test-validations.module.js';
import { TasksModule } from './tasks/tasks.module.js';
import { WorkerAuthModule } from './worker-auth/worker-auth.module.js';
import { WorkersModule } from './workers/workers.module.js';

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
        AuthModule,
        TasksModule,
        WorkersModule,
        WorkerAuthModule,
        HealthModule,
        PublicationsModule,
        TestValidationsModule,
      ],
    };
  }
}
