import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { ReviewListController, ReviewsController } from './reviews.controller.js';
import { ReviewsService } from './reviews.service.js';

@Module({
  imports: [TasksModule, ProjectsModule],
  controllers: [ReviewsController, ReviewListController],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
