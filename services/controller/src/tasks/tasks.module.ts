import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module.js';
import { AgentDefaultsController } from './agent-defaults.controller.js';
import { AgentDefaultsService } from './agent-defaults.service.js';
import { LeaseReaper } from './lease-reaper.js';
import { SqliteTaskRepository } from './sqlite-task.repository.js';
import { TaskRepository } from './task.repository.js';
import { TasksController } from './tasks.controller.js';
import { TasksService } from './tasks.service.js';

@Module({
  imports: [ProjectsModule],
  controllers: [TasksController, AgentDefaultsController],
  providers: [TasksService, AgentDefaultsService, LeaseReaper, { provide: TaskRepository, useClass: SqliteTaskRepository }],
  exports: [TasksService, AgentDefaultsService, TaskRepository, LeaseReaper],
})
export class TasksModule {}
