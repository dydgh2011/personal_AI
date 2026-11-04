import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module.js';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { TestValidationsModule } from '../test-validations/test-validations.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { WorkerPresence } from './worker-presence.js';
import { WorkersController } from './workers.controller.js';

@Module({
  imports: [ProjectsModule, ReviewsModule, TasksModule, TestValidationsModule],
  controllers: [WorkersController],
  providers: [WorkerPresence],
  exports: [WorkerPresence],
})
export class WorkersModule {}
