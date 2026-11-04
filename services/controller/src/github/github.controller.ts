import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { RequireRole } from '../auth/auth.decorators.js';
import { ProjectRepository } from '../projects/project.repository.js';
import { toHttpError } from '../projects/projects.service.js';
import { GitHubClient, OWNER_PATTERN, type GitHubRepository, type RateLimit } from './github-client.js';

export interface DiscoveryResponse {
  authMode: string;
  source: string;
  /** Always false: GitHub only returns what the current credentials may see. */
  complete: false;
  note: string;
  pages: number;
  truncated: boolean;
  rateLimit: RateLimit;
  repositories: Array<GitHubRepository & { registeredProjectId: string | null }>;
}

/** Repository discovery (read-only GitHub API). Admin only. */
@Controller('github')
@RequireRole('admin')
export class GitHubController {
  constructor(
    private readonly github: GitHubClient,
    private readonly projects: ProjectRepository,
  ) {}

  /**
   * - no parameters: repositories the configured credentials can access (owned,
   *   collaborator, organisation member); needs GITHUB_TOKEN_FILE
   * - `?owner=<user>`: that user's repositories (public only when anonymous)
   * - `?org=<org>`: that organisation's repositories (public only when anonymous)
   */
  @Get('repositories')
  async repositories(@Query('owner') owner?: string, @Query('org') org?: string): Promise<DiscoveryResponse> {
    if (owner && org) throw new BadRequestException('Use either owner or org, not both');
    if (!owner && !org && this.github.authMode === 'none') {
      throw new BadRequestException(
        'No GitHub credentials are configured: pass ?owner=<user> or ?org=<org> to list public repositories',
      );
    }
    for (const value of [owner, org]) {
      if (value !== undefined && !OWNER_PATTERN.test(value)) throw new BadRequestException('Invalid GitHub owner');
    }
    let source: string;
    let page;
    try {
      if (owner) {
        source = `users/${owner}`;
        page = await this.github.listUserRepositories(owner);
      } else if (org) {
        source = `orgs/${org}`;
        page = await this.github.listOrganizationRepositories(org);
      } else {
        source = 'user (authenticated)';
        page = await this.github.listAccessibleRepositories();
      }
    } catch (error) {
      throw toHttpError(error);
    }

    const registered = new Map(
      this.projects.list().filter((p) => p.githubRepositoryId !== null).map((p) => [p.githubRepositoryId, p.id]),
    );
    return {
      authMode: this.github.authMode,
      source,
      complete: false,
      note:
        this.github.authMode === 'none'
          ? 'Anonymous request: public repositories only. Private repositories need explicitly configured credentials.'
          : 'Only repositories these credentials (token scope or GitHub App installation) can access are listed.',
      pages: page.pages,
      truncated: page.truncated,
      rateLimit: page.rateLimit,
      repositories: page.repositories.map((r) => ({ ...r, registeredProjectId: registered.get(r.id) ?? null })),
    };
  }
}
