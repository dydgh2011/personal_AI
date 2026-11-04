import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigError, loadConfig, type PublisherConfig } from './config.js';
import { ControllerClient, ControllerError } from './controller-client.js';
import { AppGitHubReader, GitHubAppApi, GitHubAudit } from './github-app.js';
import { DisabledWriter, HttpGitHubReader, MockWriter, type GitHubReader, type GitHubWriter } from './github.js';
import { Journal } from './journal.js';
import { preflight, type PublicationJob } from './verify.js';

const log = (level: 'info' | 'warn' | 'error', message: string, extra: Record<string, unknown> = {}) =>
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, message, ...extra }) + '\n');

export interface HandlerDeps {
  config: PublisherConfig;
  github: GitHubReader;
  writer: GitHubWriter;
  journal: Journal;
  controller: Pick<ControllerClient, 'report'>;
  evidenceKey?: Buffer | null;
}

/**
 * Handles one claimed job. dry-run: preflight only. publish: preflight again (everything, including
 * the authorization), then push the verified commit object unchanged and open a draft PR - once.
 * Never throws for a bad job.
 */
export async function handle(job: PublicationJob, deps: HandlerDeps): Promise<{ status: string; report: Record<string, unknown> }> {
  const { publication } = job;
  const publish = publication.mode === 'publish';
  let status: 'ready' | 'failed' | 'pr_created';
  let report: Record<string, unknown>;
  let prepared: Awaited<ReturnType<typeof preflight>> | null = null;
  try {
    if (publish && job.review && (await deps.journal.publishedReview(job.review.id))) {
      // Already published by an earlier run (e.g. the controller lost the result): do not push again.
      const previous = (await deps.journal.entries()).filter((e) => e.reviewId === job.review!.id && e.outcome === 'published').at(-1)!;
      status = 'pr_created';
      report = { mode: 'publish', eligible: true, canPublish: true, reason: null, pushPerformed: false, pullRequestCreated: false, alreadyPublished: previous.publicationId, pullRequest: previous.pullRequest ?? null };
    } else {
      prepared = await preflight(job, deps, { keepRepo: publish });
      const r = prepared.report;
      report = r as unknown as Record<string, unknown>;
      if (!publish) {
        status = r.eligible ? 'ready' : 'failed';
      } else if (!r.canPublish) {
        status = 'failed';
      } else if (deps.config.publishBackend === 'disabled' || deps.writer instanceof DisabledWriter) {
        status = 'failed';
        r.canPublish = false;
        r.reason = r.reason ?? null;
        report = { ...r, reason: 'PUBLISH_DISABLED', reasons: [...r.reasons, 'PUBLISH_DISABLED'], blockers: [...r.blockers, 'PUBLISH_DISABLED: PUBLISHER_PUBLISH_BACKEND=disabled'] };
      } else {
        const fullName = r.target.repository!;
        const repositoryId = r.target.repositoryId!;
        await deps.writer.pushBranch({ fullName, repositoryId, branch: r.target.branch, headSha: r.target.headSha, repoDir: prepared.repoDir! });
        r.pushPerformed = true;
        const pr = await deps.writer.createPullRequest({ fullName, repositoryId, head: r.pullRequest!.head, base: r.pullRequest!.base, title: r.pullRequest!.title, body: r.pullRequest!.body, draft: true });
        r.pullRequestCreated = true;
        report = { ...r, pullRequestNumber: pr.number, pullRequestUrl: pr.url, backend: deps.config.publishBackend };
        status = 'pr_created';
        await deps.journal.append({ at: new Date().toISOString(), publicationId: publication.id, taskId: publication.taskId, reviewId: publication.reviewId, headSha: publication.headSha, mode: 'publish', outcome: 'published', blockers: [], reported: false, pullRequest: { number: pr.number, url: pr.url } });
      }
    }
  } catch (error) {
    status = 'failed';
    report = { format: 'personal-ai-publication/v1', mode: publication.mode, taskId: publication.taskId, eligible: false, canPublish: false, reason: 'PUBLISHER_ERROR', error: `publisher error: ${(error as Error).message.slice(0, 500)}`, pushPerformed: false, pullRequestCreated: false };
  } finally {
    await prepared?.cleanup();
  }
  const blockers = Array.isArray(report.blockers) ? (report.blockers as string[]) : [String(report.error ?? '')].filter(Boolean);
  const entry = { at: new Date().toISOString(), publicationId: publication.id, taskId: publication.taskId, reviewId: publication.reviewId, headSha: publication.headSha, mode: publish ? 'publish' as const : 'dry-run' as const, outcome: status === 'pr_created' ? 'pr_created' as const : status, blockers, reported: false };
  try {
    await deps.controller.report(publication.id, status, report);
    entry.reported = true;
  } catch (error) {
    log('error', 'could not report result', { publicationId: publication.id, error: (error as Error).message });
  }
  await deps.journal.append(entry);
  log('info', `${publication.mode} finished`, { publicationId: publication.id, taskId: publication.taskId, status, reason: report.reason ?? null });
  return { status, report };
}

export function buildDeps(config: PublisherConfig): HandlerDeps {
  const audit = new GitHubAudit(config.stateDir);
  let github: GitHubReader = new HttpGitHubReader(config.githubApiUrl);
  if (config.githubApp) {
    const api = new GitHubAppApi({ apiUrl: config.githubApiUrl, app: config.githubApp, allowedRepositories: config.allowedRepositories, audit });
    // Repository ids come from the job (registry); the reader is built per job in handle via ids map.
    github = new AppGitHubReader(api, (fullName) => repositoryIds.get(fullName.toLowerCase()) ?? null);
  }
  return {
    config,
    github,
    writer: config.publishBackend === 'mock' ? new MockWriter() : new DisabledWriter(),
    journal: new Journal(config.stateDir),
    controller: new ControllerClient(config.controllerUrl, config.tokenFile),
  };
}

/** fullName -> registry repository id, filled from each job (App reads address repositories by id). */
const repositoryIds = new Map<string, number>();

async function main(): Promise<void> {
  let config: PublisherConfig;
  try {
    config = loadConfig();
  } catch (error) {
    log('error', error instanceof ConfigError ? error.message : String(error));
    process.exit(2);
  }
  const deps = buildDeps(config);
  const controller = deps.controller as ControllerClient;
  await mkdir(config.workDir, { recursive: true });
  log('info', 'publisher started', {
    allowedRepositories: config.allowedRepositories, publishBackend: config.publishBackend, githubApp: config.githubApp ? 'configured' : 'not configured',
    policy: { tests: 'required', commitAuthor: config.commitAuthorPolicy },
  });

  const stop = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => stop.abort());
  let failures = 0;
  while (!stop.signal.aborted) {
    await writeFile(join(config.workDir, 'heartbeat'), new Date().toISOString()).catch(() => undefined);
    try {
      const job = await controller.claim();
      failures = 0;
      if (job) {
        if (job.project?.fullName && job.project.githubRepositoryId) repositoryIds.set(job.project.fullName.toLowerCase(), job.project.githubRepositoryId);
        await handle(job, deps);
        continue;
      }
    } catch (error) {
      failures++;
      if (failures === 1 || failures % 20 === 0) {
        log('warn', 'controller not available', { error: (error as Error).message, status: error instanceof ControllerError ? error.status : null });
      }
    }
    await sleep(Math.min(config.pollIntervalMs * Math.max(1, failures), 60_000), undefined, { signal: stop.signal }).catch(() => undefined);
  }
  log('info', 'publisher stopped');
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
