import { Module } from '@nestjs/common';
import { GitHubController } from '../github/github.controller.js';
import { GitHubModule } from '../github/github.module.js';
import { ProjectRepository } from './project.repository.js';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';

@Module({
  imports: [GitHubModule],
  controllers: [ProjectsController, GitHubController],
  providers: [ProjectRepository, ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
