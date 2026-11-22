import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { WorkerAuthModule } from '../worker-auth/worker-auth.module.js';
import { WorkersModule } from '../workers/workers.module.js';
import { HealthController } from './health.controller.js';
import { SystemStatusService } from './system-status.service.js';

@Module({
  imports: [ProjectsModule, TasksModule, WorkersModule, WorkerAuthModule],
  controllers: [HealthController],
  providers: [SystemStatusService],
})
export class HealthModule {}
