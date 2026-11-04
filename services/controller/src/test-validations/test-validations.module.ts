import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module.js';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { TestRunnerController, TestValidationsController } from './test-validations.controller.js';
import { TestValidationsService } from './test-validations.service.js';

@Module({
  imports: [TasksModule, ReviewsModule, ProjectsModule],
  controllers: [TestValidationsController, TestRunnerController],
  providers: [TestValidationsService],
  exports: [TestValidationsService],
})
export class TestValidationsModule {}
