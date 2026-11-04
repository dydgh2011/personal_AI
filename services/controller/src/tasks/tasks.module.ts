import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module.js';
import { LeaseReaper } from './lease-reaper.js';
import { SqliteTaskRepository } from './sqlite-task.repository.js';
import { TaskRepository } from './task.repository.js';
import { TasksController } from './tasks.controller.js';
import { TasksService } from './tasks.service.js';

@Module({
  imports: [ProjectsModule],
  controllers: [TasksController],
  providers: [TasksService, LeaseReaper, { provide: TaskRepository, useClass: SqliteTaskRepository }],
  exports: [TasksService, TaskRepository, LeaseReaper],
})
export class TasksModule {}
