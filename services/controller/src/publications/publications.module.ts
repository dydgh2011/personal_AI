import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module.js';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { TestValidationsModule } from '../test-validations/test-validations.module.js';
import { PublicationsController, PublisherController } from './publications.controller.js';
import { PublicationsService } from './publications.service.js';

@Module({
  imports: [TasksModule, ReviewsModule, ProjectsModule, TestValidationsModule],
  controllers: [PublicationsController, PublisherController],
  providers: [PublicationsService],
})
export class PublicationsModule {}
