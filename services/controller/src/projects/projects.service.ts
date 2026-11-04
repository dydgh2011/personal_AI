import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  type OnModuleInit,
} from '@nestjs/common';
import type { TaskActor } from '../auth/principal.js';
import { Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import {
  GitHubApiError,
  GitHubAuthError,
  GitHubClient,
  GitHubNotFoundError,
  GitHubRateLimitError,
  type RateLimit,
} from '../github/github-client.js';
import { AGENT_TYPES, type AgentType } from '../tasks/task.model.js';
import type { CreateProjectDto, UpdateProjectDto } from './dto/project.dto.js';
import { delegatorView, workerView, type DelegatorProjectView, type Project, type WorkerProjectView } from './project.model.js';
import { DuplicateProjectError, ProjectRepository } from './project.repository.js';

const REMOTE_STATUS_TTL_MS = 60_000;

export interface RemoteStatus {
  checkedAt: string;
  reachable: boolean;
  error: string | null;
  defaultBranch: string | null;
  headSha: string | null;
  pushedAt: string | null;
  archived: boolean | null;
  visibility: string | null;
  /** Remote default-branch tip equals the commit last fetched into the repository cache. */
  cacheUpToDate: boolean | null;
  rateLimit: RateLimit | null;
}

export interface ProjectStatus {
  project: Project | DelegatorProjectView;
  acceptsTasks: boolean;
  tasks: Record<string, number>;
  sync: { status: string; lastFetchedAt: string | null; cachedHeadSha: string | null; lastSyncError: string | null };
  remote: RemoteStatus | null;
}

/**
 * Central project registry (SQLite `projects` table). The single place that
 * decides whether a task may run in a project and with which agent.
 *
 * Compatibility: ids in CONTROLLER_PROJECT_IDS are inserted at startup as
 * enabled local projects if they are missing; existing rows are never changed
 * by the environment, so an admin's PATCH is not undone by a restart.
 */
@Injectable()
export class ProjectsService implements OnModuleInit {
  private readonly logger = new Logger(ProjectsService.name);
  private readonly remoteCache = new Map<string, { at: number; status: RemoteStatus }>();

  constructor(
    private readonly repository: ProjectRepository,
    private readonly github: GitHubClient,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    const now = this.clock.now().toISOString();
    for (const id of this.config.projectIds) {
      const inserted = this.repository.createIfMissing({
        id,
        source: 'local',
        githubRepositoryId: null,
        fullName: null,
        remoteUrl: null,
        defaultBranch: 'main',
        visibility: null,
        allowedAgents: [...AGENT_TYPES],
        enabled: true,
        allowCodeChanges: true,
        authMode: 'none',
        description: 'Registered from CONTROLLER_PROJECT_IDS',
        syncStatus: 'not_synced',
        lastFetchedAt: null,
        cachedHeadSha: null,
        lastSyncError: null,
        testCommands: [],
        createdAt: now,
        updatedAt: now,
      });
      if (inserted) this.logger.log(`Project ${id} registered from CONTROLLER_PROJECT_IDS`);
    }
  }

  // ---- task gate --------------------------------------------------------------------

  /** Throws 400 unless the project exists, is enabled and allows this agent. */
  assertTaskAllowed(projectId: string, agent: AgentType): Project {
    const project = this.repository.findById(projectId);
    if (!project) throw new BadRequestException(`Unknown projectId "${projectId}"`);
    if (!project.enabled) throw new BadRequestException(`Project "${projectId}" is disabled`);
    if (!project.allowedAgents.includes(agent)) {
      throw new BadRequestException(`Agent ${agent} is not allowed in project "${projectId}"`);
    }
    return project;
  }

  enabledIds(): string[] {
    return this.repository.list().filter((p) => p.enabled).map((p) => p.id);
  }

  // ---- reads ------------------------------------------------------------------------

  list(actor: TaskActor): Array<Project | DelegatorProjectView> {
    const projects = this.repository.list();
    return actor.role === 'admin' ? projects : projects.filter((p) => p.enabled).map(delegatorView);
  }

  /** Delegators only see enabled projects; anything else is reported as missing. */
  get(id: string, actor: TaskActor): Project | DelegatorProjectView {
    const project = this.find(id, actor);
    return actor.role === 'admin' ? project : delegatorView(project);
  }

  /** Enabled projects this worker's agent may run tasks in. */
  forWorker(agent: AgentType): WorkerProjectView[] {
    return this.repository
      .list()
      .filter((p) => p.enabled && p.allowedAgents.includes(agent))
      .map(workerView);
  }

  async status(id: string, actor: TaskActor, refresh = false): Promise<ProjectStatus> {
    const project = this.find(id, actor);
    return {
      project: actor.role === 'admin' ? project : delegatorView(project),
      acceptsTasks: project.enabled,
      tasks: this.repository.taskCounts(id),
      sync: {
        status: project.syncStatus,
        lastFetchedAt: project.lastFetchedAt,
        cachedHeadSha: project.cachedHeadSha,
        lastSyncError: project.lastSyncError,
      },
      remote: project.source === 'github' ? await this.remoteStatus(project, refresh) : null,
    };
  }

  // ---- writes (admin) ---------------------------------------------------------------

  async create(dto: CreateProjectDto): Promise<Project> {
    const now = this.clock.now().toISOString();
    let project: Project = {
      id: dto.id,
      source: dto.source,
      githubRepositoryId: null,
      fullName: null,
      remoteUrl: null,
      defaultBranch: dto.defaultBranch ?? 'main',
      visibility: null,
      allowedAgents: dto.allowedAgents,
      enabled: dto.enabled ?? false,
      allowCodeChanges: dto.allowCodeChanges ?? false,
      authMode: 'none',
      description: dto.description ?? null,
      syncStatus: 'not_synced',
      lastFetchedAt: null,
      cachedHeadSha: null,
      lastSyncError: null,
      testCommands: [],
      createdAt: now,
      updatedAt: now,
    };

    if (dto.source === 'github') {
      if (!dto.fullName) throw new BadRequestException('fullName is required for GitHub projects');
      if (dto.defaultBranch !== undefined) {
        throw new BadRequestException('defaultBranch comes from GitHub for GitHub projects; change it later with PATCH');
      }
      const repo = await this.callGitHub(() => this.github.getRepository(dto.fullName!));
      if (repo.archived) this.logger.warn(`Registering archived repository ${repo.fullName}`);
      project = {
        ...project,
        githubRepositoryId: repo.id,
        fullName: repo.fullName,
        remoteUrl: repo.cloneUrl,
        defaultBranch: repo.defaultBranch,
        visibility: repo.visibility,
        authMode: this.github.authMode,
        description: dto.description ?? repo.description,
      };
    } else if (dto.fullName !== undefined) {
      throw new BadRequestException('fullName is only allowed for GitHub projects');
    }

    try {
      const created = this.repository.create(project);
      this.logger.log(`Project ${created.id} registered (${created.source}${created.fullName ? ` ${created.fullName}` : ''})`);
      return created;
    } catch (error) {
      if (error instanceof DuplicateProjectError) {
        throw new ConflictException(`Project already registered as "${error.message}"`);
      }
      throw error;
    }
  }

  update(id: string, dto: UpdateProjectDto): Project {
    if (!this.repository.findById(id)) throw new NotFoundException(`Project ${id} not found`);
    const patch = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined));
    if (Object.keys(patch).length === 0) throw new BadRequestException('Nothing to update');
    const updated = this.repository.update(id, { ...patch, updatedAt: this.clock.now().toISOString() });
    if (!updated) throw new NotFoundException(`Project ${id} not found`);
    this.remoteCache.delete(id);
    this.logger.log(`Project ${id} updated: ${Object.keys(patch).join(', ')}`);
    return updated;
  }

  // ---- helpers ----------------------------------------------------------------------

  private find(id: string, actor: TaskActor): Project {
    const project = this.repository.findById(id);
    if (!project || (actor.role !== 'admin' && !project.enabled)) throw new NotFoundException(`Project ${id} not found`);
    return project;
  }

  private async remoteStatus(project: Project, refresh: boolean): Promise<RemoteStatus> {
    const cached = this.remoteCache.get(project.id);
    if (!refresh && cached && Date.now() - cached.at < REMOTE_STATUS_TTL_MS) return cached.status;
    const checkedAt = this.clock.now().toISOString();
    let status: RemoteStatus;
    try {
      const repo = await this.github.getRepository(project.fullName!);
      const headSha = await this.github.getBranchHead(repo.fullName, repo.defaultBranch);
      status = {
        checkedAt,
        reachable: true,
        error: null,
        defaultBranch: repo.defaultBranch,
        headSha,
        pushedAt: repo.pushedAt,
        archived: repo.archived,
        visibility: repo.visibility,
        cacheUpToDate: project.cachedHeadSha ? project.cachedHeadSha === headSha : null,
        rateLimit: this.github.rateLimit,
      };
    } catch (error) {
      status = {
        checkedAt,
        reachable: false,
        error: error instanceof GitHubApiError ? error.message : 'GitHub check failed',
        defaultBranch: null,
        headSha: null,
        pushedAt: null,
        archived: null,
        visibility: null,
        cacheUpToDate: null,
        rateLimit: this.github.rateLimit,
      };
    }
    this.remoteCache.set(project.id, { at: Date.now(), status });
    return status;
  }

  private async callGitHub<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw toHttpError(error);
    }
  }
}

/** Maps GitHub adapter errors to HTTP errors without leaking request details. */
export function toHttpError(error: unknown): HttpException {
  if (error instanceof GitHubRateLimitError) {
    return new HttpException({ statusCode: 429, message: error.message, rateLimit: error.rateLimit }, HttpStatus.TOO_MANY_REQUESTS);
  }
  if (error instanceof GitHubNotFoundError) return new NotFoundException(error.message);
  if (error instanceof GitHubAuthError) return new BadGatewayException(error.message);
  if (error instanceof GitHubApiError) {
    return error.status === null ? new ServiceUnavailableException(error.message) : new BadGatewayException(error.message);
  }
  return new BadGatewayException('GitHub request failed');
}
