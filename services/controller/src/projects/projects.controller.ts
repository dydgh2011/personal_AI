import { Body, Controller, Get, Param, ParseBoolPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentActor, RequireRole } from '../auth/auth.decorators.js';
import type { TaskActor } from '../auth/principal.js';
import { CreateProjectDto, UpdateProjectDto } from './dto/project.dto.js';
import { ProjectIdPipe } from './project-id.pipe.js';
import type { DelegatorProjectView, Project } from './project.model.js';
import { ProjectsService, type ProjectStatus } from './projects.service.js';

/**
 * Project registry. Reads: admin (everything) and delegator (enabled projects,
 * reduced view). Writes: admin only.
 */
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  @RequireRole(['admin', 'delegator'])
  list(@CurrentActor() actor: TaskActor): { items: Array<Project | DelegatorProjectView> } {
    return { items: this.projects.list(actor) };
  }

  @Get(':id')
  @RequireRole(['admin', 'delegator'])
  get(@Param('id', ProjectIdPipe) id: string, @CurrentActor() actor: TaskActor): Project | DelegatorProjectView {
    return this.projects.get(id, actor);
  }

  /** `?refresh=true` bypasses the 60 s cache of the GitHub check. */
  @Get(':id/status')
  @RequireRole(['admin', 'delegator'])
  status(
    @Param('id', ProjectIdPipe) id: string,
    @CurrentActor() actor: TaskActor,
    @Query('refresh', new ParseBoolPipe({ optional: true })) refresh?: boolean,
  ): Promise<ProjectStatus> {
    return this.projects.status(id, actor, refresh ?? false);
  }

  @Post()
  @RequireRole('admin')
  create(@Body() dto: CreateProjectDto): Promise<Project> {
    return this.projects.create(dto);
  }

  @Patch(':id')
  @RequireRole('admin')
  update(@Param('id', ProjectIdPipe) id: string, @Body() dto: UpdateProjectDto): Project {
    return this.projects.update(id, dto);
  }
}
