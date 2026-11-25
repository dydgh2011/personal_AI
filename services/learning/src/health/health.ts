import { Controller, Get, Inject, Module, ServiceUnavailableException } from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import { CODE_EXECUTION, UPLOAD_LIMITS } from '../assignments/assignments.js';
import { Public } from '../auth/auth.js';
import { SQLITE_CONNECTION } from '../database/database.module.js';
import { MIGRATIONS } from '../database/migrations.js';
import { ProviderService } from '../provider/provider.js';

@Controller()
export class HealthController {
  constructor(@Inject(SQLITE_CONNECTION) private readonly db: Database, private readonly provider: ProviderService) {}

  /** Docker liveness/readiness. Reveals nothing beyond "ok". */
  @Public()
  @Get('health')
  health(): { status: 'ok' } {
    try {
      this.db.prepare('SELECT 1').get();
    } catch {
      throw new ServiceUnavailableException({ status: 'error' });
    }
    return { status: 'ok' };
  }

  /** Overview counts and AI usage for the dashboard (owner only). No content, no secrets. */
  @Get('status')
  status() {
    const count = (sql: string) => (this.db.prepare(sql).get() as { c: number }).c;
    return {
      schemaVersion: this.db.pragma('user_version', { simple: true }),
      supportedSchema: MIGRATIONS.length,
      counts: {
        domains: count("SELECT COUNT(*) AS c FROM domains WHERE status <> 'archived'"),
        ideasInbox: count("SELECT COUNT(*) AS c FROM ideas WHERE state = 'inbox'"),
        goals: count("SELECT COUNT(*) AS c FROM goals WHERE status = 'active'"),
        roadmaps: count("SELECT COUNT(*) AS c FROM roadmaps WHERE status = 'active'"),
        pendingProposals: count("SELECT COUNT(*) AS c FROM ai_proposals WHERE state = 'awaiting_user_approval'"),
        // L2
        milestones: count("SELECT COUNT(*) AS c FROM milestones WHERE status IN ('planned', 'active')"),
        assignmentsOpen: count("SELECT COUNT(*) AS c FROM assignments WHERE status IN ('available', 'revision_required')"),
        awaitingEvaluation: count("SELECT COUNT(*) AS c FROM assignments WHERE status = 'submitted'"),
        awaitingDecision: count("SELECT COUNT(*) AS c FROM assignments WHERE status = 'evaluated'"),
        assignmentsPassed: count("SELECT COUNT(*) AS c FROM assignments WHERE status = 'passed'"),
        evaluationsFailed: count("SELECT COUNT(*) AS c FROM evaluations WHERE status = 'failed'"),
        skills: count('SELECT COUNT(*) AS c FROM skills'),
        skillsVerified: count('SELECT COUNT(*) AS c FROM skill_mastery WHERE verified_level IS NOT NULL'),
        skillsSelfOnly: count('SELECT COUNT(*) AS c FROM skill_mastery WHERE self_level IS NOT NULL AND verified_level IS NULL'),
        gapsOpen: count("SELECT COUNT(*) AS c FROM gaps WHERE status = 'open'"),
        gapsSuggested: count("SELECT COUNT(*) AS c FROM gaps WHERE status = 'suggested'"),
      },
      ai: this.provider.usage(),
      codeExecution: CODE_EXECUTION,
      uploadLimits: UPLOAD_LIMITS,
    };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
