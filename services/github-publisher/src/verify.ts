import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { copyFile, mkdir, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { PublisherConfig } from './config.js';
import { git, gitOk } from './git.js';
import { GitHubReadError, type GitHubReader } from './github.js';

const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

type TestCommand = { name: string; argv: string[]; timeoutSeconds: number };
type CommandResult = { name: string; argv: string[]; status: string; exitCode: number | null; timedOut: boolean };

/** The controller's publication job (see controller publications.service.ts). Treated as claims to verify. */
export interface PublicationJob {
  publication: { id: string; taskId: string; reviewId: string; headSha: string; mode: string; requestedBy: string; authorizationId?: string | null };
  task: { id: string; status: string; agent: string; projectId: string | null };
  review: { id: string; status: string; baseSha: string; headSha: string; headTree: string | null; decidedBy: string | null; decidedAt: string | null; projectId: string } | null;
  latestReview: { id: string } | null;
  reported: {
    baseSha: string; headSha: string; headTree: string | null; commitMessage: string | null;
    files: Array<{ path: string; status: string; binary: boolean; sensitive: boolean }>;
    patchRecorded: boolean; patchTruncated: boolean; omittedFiles: string[]; tests: unknown | null; branch: string | null;
  } | null;
  project: {
    id: string; source: string; fullName: string | null; remoteUrl: string | null; defaultBranch: string;
    visibility: string | null; githubRepositoryId: number | null; enabled: boolean; allowCodeChanges: boolean;
    testCommands?: TestCommand[];
  } | null;
  testValidation?: {
    id: string; taskId: string; projectId: string; commitSha: string; status: string; commands: TestCommand[];
    results: CommandResult[] | null; evidence: string | null; evidenceHash: string | null; evidenceSignature: string | null; completedAt: string | null;
  } | null;
  authorization?: {
    id: string; taskId: string; reviewId: string; repositoryId: number; headSha: string; testValidationId: string;
    status: string; expiresAt: string; usedAt: string | null; publicationId: string | null; authorizedBy: string; authorizedAt: string;
  } | null;
}

/** Structured reason codes (shared vocabulary with the controller's 409 codes). */
export type ReasonCode =
  | 'TASK_NOT_COMPLETED' | 'REVIEW_NOT_APPROVED' | 'ARTIFACT_INVALID' | 'COMMIT_MISMATCH' | 'TREE_MISMATCH' | 'BASE_INVALID'
  | 'FILES_MISMATCH' | 'REVIEW_INCOMPLETE' | 'AUTHOR_CHANGED' | 'TEST_REPORT_MISSING' | 'TEST_EVIDENCE_INVALID' | 'TEST_FAILED'
  | 'TEST_SKIPPED' | 'TEST_ABORTED' | 'TEST_COMMANDS_CHANGED' | 'TEST_COMMIT_MISMATCH' | 'REPOSITORY_NOT_ALLOWED'
  | 'REMOTE_REPOSITORY_MISMATCH' | 'REMOTE_BASE_CHANGED' | 'TARGET_BRANCH_EXISTS' | 'PUBLISH_APPROVAL_REQUIRED';

export interface Check {
  id: string;
  ok: boolean;
  /** Set when the check failed. */
  code?: ReasonCode;
  detail: string;
}

/**
 * Preflight order (the spec's 12 steps). The first failing check in this order is the reason.
 * Checks of one step share its position.
 */
const ORDER: Record<string, number> = {
  task_completed: 1, review_approved: 2,
  artifact: 3, bundle: 3, head_matches: 3,
  tree_matches: 4,
  trusted_repository: 5, base_in_repository: 5, base_is_ancestor: 5, linear_history: 5,
  files_match: 6, review_complete: 6, author_preserved: 6,
  test_evidence: 7, tests_passed: 8, test_commit: 9,
  target_allowed: 10, target_branch: 10, remote_repository: 10,
  base_current: 11, target_branch_free: 11,
  publish_authorization: 12,
};

const GIT_CHECKS = ['artifact', 'bundle', 'head_matches', 'tree_matches', 'trusted_repository', 'base_in_repository', 'base_is_ancestor', 'linear_history', 'files_match', 'author_preserved'];

export interface PublicationReport {
  format: 'personal-ai-publication/v1';
  mode: 'dry-run' | 'publish';
  publicationId: string;
  taskId: string;
  reviewId: string | null;
  reviewStatus: string | null;
  projectId: string | null;
  agent: string;
  policy: { tests: 'required'; commitAuthor: 'preserve_worker' };
  /** Every git-object check passed (artifact, SHAs, tree, ancestry, files, author). */
  gitVerified: boolean;
  /** Every check passed except the separate publish approval. */
  eligible: boolean;
  /** eligible and a valid publish authorization exists. */
  canPublish: boolean;
  /** First failing reason in preflight order (null when canPublish). */
  reason: ReasonCode | null;
  reasons: ReasonCode[];
  checks: Check[];
  blockers: string[];
  warnings: string[];
  testValidationId: string | null;
  tests: { status: string | null; commitSha: string | null; commands: Array<{ name: string; argv: string[]; exitCode: number | null; status: string }>; evidenceHash: string | null; signatureValid: boolean };
  author: { name: string; email: string; committerName: string; committerEmail: string; message: string } | null;
  authorizationId: string | null;
  target: { repository: string | null; repositoryId: number | null; baseBranch: string | null; branch: string; baseSha: string | null; headSha: string; headTree: string | null };
  commits: Array<{ sha: string; parents: number; subject: string; author: string; committer: string }>;
  files: Array<{ status: string; path: string }>;
  pullRequest: { title: string; body: string; head: string; base: string; draft: true } | null;
  pushPerformed: boolean;
  pullRequestCreated: boolean;
  verifiedAt: string;
}

export interface VerifyDeps {
  config: PublisherConfig;
  github: GitHubReader;
  now?: () => Date;
  /** Overrides reading config.testEvidenceKeyFile (tests). */
  evidenceKey?: Buffer | null;
}

export interface Preflight {
  report: PublicationReport;
  /** Verification repository holding the verified commit (only with keepRepo and gitVerified). */
  repoDir: string | null;
  cleanup: () => Promise<void>;
}

export async function verifyPublication(job: PublicationJob, deps: VerifyDeps): Promise<PublicationReport> {
  const result = await preflight(job, deps);
  await result.cleanup();
  return result.report;
}

/**
 * Independently verifies one approved commit and the publishing policies. Nothing the worker, the
 * dashboard or the controller reported is taken as fact: the commit comes from the worker's bundle,
 * the base from the publisher's own read-only copy, the remote state from GitHub, and the test
 * result from the runner's signed evidence. Any failed check blocks publishing.
 */
export async function preflight(job: PublicationJob, deps: VerifyDeps, options: { keepRepo?: boolean } = {}): Promise<Preflight> {
  const { config } = deps;
  const now = deps.now ?? (() => new Date());
  const checks: Check[] = [];
  const warnings: string[] = [];
  const add = (id: string, ok: boolean, detail: string, code?: ReasonCode) => {
    checks.push({ id, ok, detail, ...(ok ? {} : { code: code ?? 'COMMIT_MISMATCH' }) });
    return ok;
  };
  const taskId = job.publication.taskId;
  const review = job.review;
  const reported = job.reported;
  const project = job.project;
  const approvedHead = job.publication.headSha;
  const targetBranch = `${config.branchPrefix}${taskId}`;
  const agent = job.task.agent;
  const mode = job.publication.mode === 'publish' ? 'publish' : 'dry-run';
  const work = join(config.workDir, job.publication.id);
  const repo = join(work, 'verify.git');
  let keepRepo = false;

  const report: PublicationReport = {
    format: 'personal-ai-publication/v1', mode, publicationId: job.publication.id, taskId, reviewId: review?.id ?? null,
    reviewStatus: review?.status ?? null, projectId: job.task.projectId, agent,
    policy: { tests: 'required', commitAuthor: 'preserve_worker' },
    gitVerified: false, eligible: false, canPublish: false, reason: null, reasons: [], checks, blockers: [], warnings,
    testValidationId: job.testValidation?.id ?? null,
    tests: { status: job.testValidation?.status ?? null, commitSha: job.testValidation?.commitSha ?? null, commands: [], evidenceHash: job.testValidation?.evidenceHash ?? null, signatureValid: false },
    author: null, authorizationId: job.authorization?.id ?? null,
    target: { repository: project?.fullName ?? null, repositoryId: project?.githubRepositoryId ?? null, baseBranch: project?.defaultBranch ?? null, branch: targetBranch, baseSha: review?.baseSha ?? null, headSha: approvedHead, headTree: review?.headTree ?? null },
    commits: [], files: [], pullRequest: null, pushPerformed: false, pullRequestCreated: false, verifiedAt: now().toISOString(),
  };
  const finish = (): Preflight => {
    checks.sort((a, b) => (ORDER[a.id] ?? 99) - (ORDER[b.id] ?? 99));
    const failed = checks.filter((c) => !c.ok);
    report.reasons = [...new Set(failed.map((c) => c.code!))];
    report.reason = report.reasons[0] ?? null;
    report.blockers = failed.map((c) => `${c.code}: ${c.detail}`);
    report.gitVerified = GIT_CHECKS.every((id) => checks.some((c) => c.id === id && c.ok));
    report.eligible = report.gitVerified && failed.every((c) => c.id === 'publish_authorization');
    report.canPublish = report.eligible && failed.length === 0;
    if (report.eligible) report.pullRequest = pullRequestPlan(job, report);
    keepRepo = !!options.keepRepo && report.gitVerified;
    return { report, repoDir: keepRepo ? repo : null, cleanup: () => rm(work, { recursive: true, force: true }).catch(() => undefined) };
  };

  // ---- 1-2. task and approval state (the controller's records, re-checked here)
  if (!UUID.test(taskId) || job.task.id !== taskId) {
    add('task_completed', false, 'malformed job', 'TASK_NOT_COMPLETED');
    return finish();
  }
  add('task_completed', job.task.status === 'completed', `task is ${job.task.status}`, 'TASK_NOT_COMPLETED');
  const approved = !!review && review.status === 'approved' && review.id === job.publication.reviewId && review.headSha === approvedHead &&
    SHA.test(review.baseSha) && SHA.test(review.headSha) && job.latestReview?.id === review.id;
  add('review_approved', approved, !review ? 'no review'
    : review.status !== 'approved' ? `review is ${review.status}`
    : job.latestReview?.id !== review.id ? 'a newer review exists for this task'
    : review.headSha !== approvedHead ? 'approved head differs from the requested head' : `approved by ${review.decidedBy} at ${review.decidedAt}`, 'REVIEW_NOT_APPROVED');
  if (!approved || !review) return finish();
  const base = review.baseSha;

  // ---- 6 (part). what the reviewer saw must be complete (nothing hidden from the approval)
  const shown = reported && reported.headSha === review.headSha && reported.baseSha === review.baseSha ? reported : null;
  const gaps: string[] = [];
  if (!shown) gaps.push('the worker report does not describe the approved commit');
  else {
    if (!shown.patchRecorded) gaps.push('no patch was recorded (task predates diff capture)');
    if (shown.patchTruncated) gaps.push('the patch shown was truncated');
    const binary = shown.files.filter((f) => f.binary).map((f) => f.path);
    const sensitive = shown.files.filter((f) => f.sensitive).map((f) => f.path);
    if (binary.length) gaps.push(`binary files were not shown: ${binary.join(', ')}`);
    if (sensitive.length) gaps.push(`sensitive files were hidden: ${sensitive.join(', ')}`);
    const omitted = shown.omittedFiles.filter((p) => !binary.includes(p) && !sensitive.includes(p));
    if (omitted.length) gaps.push(`patch omitted for: ${omitted.join(', ')}`);
    if (!shown.headTree) gaps.push('no tree SHA was recorded');
  }
  add('review_complete', gaps.length === 0, gaps.length ? gaps.join('; ') : 'every changed line was shown to the reviewer', 'REVIEW_INCOMPLETE');
  if (shown && shown.tests !== null && shown.tests !== undefined) {
    warnings.push('agent_test_claims_ignored: test results stated in the worker report are not evidence; only the test runner counts');
  }

  // ---- 7-9. POLICY A: signed test evidence for exactly this commit
  await verifyTests(job, deps, add, report);

  // ---- 10. target repository and branch allowed
  const fullName = project?.fullName ?? null;
  const allowed = !!project && project.id === job.task.projectId && project.id === review.projectId && project.source === 'github' &&
    !!fullName && project.enabled && project.allowCodeChanges && config.allowedRepositories.includes(fullName.toLowerCase()) &&
    project.remoteUrl === `https://github.com/${fullName}.git`;
  add('target_allowed', allowed, !project ? 'project not found in the registry'
    : project.source !== 'github' || !fullName ? 'not a GitHub project'
    : !project.enabled ? 'project is disabled'
    : !project.allowCodeChanges ? 'project does not allow code changes'
    : !config.allowedRepositories.includes(fullName.toLowerCase()) ? `${fullName} is not in PUBLISHER_ALLOWED_REPOSITORIES`
    : project.remoteUrl !== `https://github.com/${fullName}.git` ? 'registry remote URL does not match the repository name'
    : `${fullName} is allowed`, 'REPOSITORY_NOT_ALLOWED');
  const branchOk = targetBranch.startsWith(config.branchPrefix) && targetBranch !== project?.defaultBranch;
  add('target_branch', branchOk, branchOk ? `${targetBranch} (new branch; ${project?.defaultBranch} is never pushed to)` : 'invalid target branch', 'REPOSITORY_NOT_ALLOWED');

  // ---- 12. the separate publish approval
  verifyAuthorization(job, report, add, now());

  if (!project || !PROJECT_ID.test(project.id) || !(agent in config.artifactRoots)) {
    add('artifact', false, `no artifact location for agent ${agent}`, 'ARTIFACT_INVALID');
    return finish();
  }

  // ---- 3-6. git objects, in a scratch repository
  await rm(work, { recursive: true, force: true });
  const home = join(work, 'home');
  await mkdir(home, { recursive: true });
  try {
    await verifyGit(job, deps, { base, approvedHead, agent, work, repo, home, shown }, add, report);
  } catch (error) {
    add('artifact', false, `verification error: ${(error as Error).message.slice(0, 300)}`, 'ARTIFACT_INVALID');
  }

  // ---- 10-11. remote repository identity and state (GitHub, read-only)
  try {
    const remote = await deps.github.repository(fullName!);
    const identity = !!remote && remote.id === project.githubRepositoryId && remote.fullName.toLowerCase() === fullName!.toLowerCase() &&
      remote.defaultBranch === project.defaultBranch;
    add('remote_repository', identity, !remote ? `${fullName} is not visible (private repositories need the GitHub App)`
      : remote.id !== project.githubRepositoryId ? `GitHub repository id ${remote.id} is not the registered ${project.githubRepositoryId}`
      : remote.defaultBranch !== project.defaultBranch ? `default branch is now ${remote.defaultBranch}, registered ${project.defaultBranch}`
      : `${remote.fullName} (id ${remote.id})`, 'REMOTE_REPOSITORY_MISMATCH');
    if (remote) {
      const current = await deps.github.branchHead(fullName!, project.defaultBranch);
      add('base_current', current === base, current === base ? `${project.defaultBranch} is still at the approved base`
        : `${project.defaultBranch} moved to ${current ?? '(missing)'}; approved base was ${base}. Run the task again on the new base and review it again (no automatic rebase or merge).`, 'REMOTE_BASE_CHANGED');
      const existing = await deps.github.branchHead(fullName!, targetBranch);
      // In publish mode an existing branch at exactly the approved head is the idempotent re-run.
      const free = existing === null || (mode === 'publish' && existing === approvedHead);
      add('target_branch_free', free, existing === null ? `${targetBranch} does not exist yet`
        : existing === approvedHead ? `${targetBranch} already points at the approved head (already published)` : `${targetBranch} already exists at ${existing}`, 'TARGET_BRANCH_EXISTS');
    }
  } catch (error) {
    add('remote_repository', false, error instanceof GitHubReadError ? error.message : `GitHub check failed: ${(error as Error).message}`, 'REMOTE_REPOSITORY_MISMATCH');
  }
  return finish();
}

async function verifyTests(job: PublicationJob, deps: VerifyDeps, add: (id: string, ok: boolean, detail: string, code?: ReasonCode) => boolean, report: PublicationReport) {
  const tv = job.testValidation ?? null;
  const approvedHead = job.publication.headSha;
  const configured = job.project?.testCommands ?? [];
  if (configured.length === 0) {
    add('test_evidence', false, 'no approved test commands are configured for this project (documentation changes need a docs check too)', 'TEST_REPORT_MISSING');
    return;
  }
  if (!tv || tv.status === 'pending' || tv.status === 'running') {
    add('test_evidence', false, tv ? `the test run for this commit is still ${tv.status}` : 'no test run result is linked to this commit', 'TEST_REPORT_MISSING');
    return;
  }
  let key = deps.evidenceKey ?? null;
  if (deps.evidenceKey === undefined) {
    const hex = (await readFile(deps.config.testEvidenceKeyFile, 'utf8').catch(() => '')).trim();
    key = /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null;
  }
  const text = tv.evidence ?? '';
  const hashOk = !!tv.evidenceHash && createHash('sha256').update(text).digest('hex') === tv.evidenceHash;
  let signatureOk = false;
  if (key && hashOk && tv.evidenceSignature && /^[0-9a-f]{64}$/.test(tv.evidenceSignature)) {
    const want = createHmac('sha256', key).update(text).digest();
    signatureOk = timingSafeEqual(want, Buffer.from(tv.evidenceSignature, 'hex'));
  }
  let evidence: { validationId?: unknown; taskId?: unknown; projectId?: unknown; commitSha?: unknown; treeSha?: unknown; status?: unknown; commands?: TestCommand[]; results?: CommandResult[] } | null = null;
  if (signatureOk) {
    try {
      evidence = JSON.parse(text);
    } catch {
      evidence = null;
    }
  }
  const consistent = !!evidence && evidence.validationId === tv.id && evidence.taskId === job.task.id && evidence.status === tv.status &&
    Array.isArray(evidence.results) && Array.isArray(evidence.commands);
  report.tests.signatureValid = signatureOk;
  if (!add('test_evidence', consistent, !key ? 'the test evidence key is not available to the publisher'
    : !hashOk ? 'evidence hash does not match (record altered or missing)'
    : !signatureOk ? 'evidence signature is invalid (not produced by the test runner)'
    : !consistent ? 'evidence does not match the stored test run' : `signed by the test runner (run ${tv.id.slice(0, 8)})`, 'TEST_EVIDENCE_INVALID')) return;

  const commands = evidence!.commands!;
  const results = evidence!.results!;
  report.tests.commands = results.map((r) => ({ name: r.name, argv: r.argv, exitCode: r.exitCode, status: r.status }));
  report.tests.commitSha = String(evidence!.commitSha);
  const status = recompute(commands, results);
  const sameCommands = JSON.stringify(commands) === JSON.stringify(configured);
  add('tests_passed', status === 'passed' && sameCommands,
    !sameCommands ? 'the project test commands changed since this run; run the tests again'
    : status === 'passed' ? `${results.length} command(s), all exit code 0` : `test run ${status}: ${results.map((r) => `${r.name}=${r.exitCode ?? r.status}`).join(', ')}`,
    !sameCommands ? 'TEST_COMMANDS_CHANGED' : status === 'skipped' ? 'TEST_SKIPPED' : status === 'aborted' ? 'TEST_ABORTED' : 'TEST_FAILED');
  const treeOk = !job.review?.headTree || evidence!.treeSha === job.review.headTree;
  add('test_commit', evidence!.commitSha === approvedHead && tv.commitSha === approvedHead && treeOk && evidence!.projectId === job.task.projectId,
    evidence!.commitSha !== approvedHead || tv.commitSha !== approvedHead ? `tests ran on ${String(evidence!.commitSha)}, not the approved ${approvedHead}`
    : !treeOk ? `tests ran on tree ${String(evidence!.treeSha)}, not the approved tree` : 'tests ran on the approved commit and tree', 'TEST_COMMIT_MISMATCH');
}

/** Same precedence as runner and controller: aborted > failed > skipped > passed. */
function recompute(commands: TestCommand[], results: CommandResult[]): 'passed' | 'failed' | 'skipped' | 'aborted' {
  if (results.length !== commands.length) return 'aborted';
  if (!results.every((r, i) => r.name === commands[i].name && JSON.stringify(r.argv) === JSON.stringify(commands[i].argv))) return 'failed';
  const ran = results.filter((r) => r.status !== 'skipped');
  if (ran.some((r) => r.status === 'aborted' || r.timedOut || r.exitCode === null)) return 'aborted';
  if (ran.some((r) => r.status !== 'passed' || r.exitCode !== 0)) return 'failed';
  return ran.length === results.length ? 'passed' : 'skipped';
}

function verifyAuthorization(job: PublicationJob, report: PublicationReport, add: (id: string, ok: boolean, detail: string, code?: ReasonCode) => boolean, now: Date) {
  const auth = job.authorization ?? null;
  const publish = job.publication.mode === 'publish';
  const problems: string[] = [];
  if (!auth) problems.push('no publish authorization (review approval does not authorize publishing)');
  else {
    if (publish && (auth.status !== 'used' || auth.publicationId !== job.publication.id || job.publication.authorizationId !== auth.id)) problems.push('the authorization does not belong to this publication');
    if (!publish && auth.status !== 'active') problems.push(`authorization is ${auth.status}`);
    const at = publish && auth.usedAt ? Date.parse(auth.usedAt) : now.getTime();
    if (Date.parse(auth.expiresAt) <= at) problems.push('authorization expired');
    if (auth.headSha !== job.publication.headSha || auth.reviewId !== job.review?.id || auth.taskId !== job.task.id) problems.push('authorization is for another commit or review');
    if (auth.testValidationId !== (job.testValidation?.id ?? null)) problems.push('authorization was given for another test run');
    if (auth.repositoryId !== job.project?.githubRepositoryId) problems.push('authorization is for another repository');
  }
  add('publish_authorization', problems.length === 0, problems.length ? problems.join('; ') : `authorized by ${auth!.authorizedBy} at ${auth!.authorizedAt}`, 'PUBLISH_APPROVAL_REQUIRED');
}

async function verifyGit(
  job: PublicationJob, deps: VerifyDeps,
  ctx: { base: string; approvedHead: string; agent: string; work: string; repo: string; home: string; shown: PublicationJob['reported'] },
  add: (id: string, ok: boolean, detail: string, code?: ReasonCode) => boolean, report: PublicationReport,
): Promise<void> {
  const { config } = deps;
  const { base, approvedHead, agent, work, repo, home, shown } = ctx;
  const project = job.project!;
  const review = job.review!;
  const taskId = job.publication.taskId;
  const bundle = await loadArtifact(job, config, agent, base, approvedHead, work, add);
  if (!bundle) return;

  const trusted = await trustedRepository(config.exportRoot, project.id, project.remoteUrl, home);
  if (!add('trusted_repository', trusted.ok, trusted.detail, 'BASE_INVALID') || !trusted.path) return;

  await git(['init', '-q', '--bare', repo], work, home);
  for (const [k, v] of [['transfer.fsckObjects', 'true'], ['fetch.fsckObjects', 'true'], ['gc.auto', '0'], ['core.hooksPath', '/dev/null']]) {
    await git(['config', k, v], repo, home);
  }
  await writeFile(join(repo, 'objects', 'info', 'alternates'), `${join(trusted.path, 'objects')}\n`);
  await git(['fetch', '-q', '--no-tags', trusted.path, `+refs/heads/${project.defaultBranch}:refs/trusted/default`], repo, home).catch(() => undefined);
  const baseKnown = await gitOk(['cat-file', '-e', `${base}^{commit}`], repo, home);
  const baseOnDefault = baseKnown && (await gitOk(['merge-base', '--is-ancestor', base, 'refs/trusted/default'], repo, home));
  add('base_in_repository', baseOnDefault, !baseKnown ? `approved base ${base} is not a commit of ${project.fullName}`
    : !baseOnDefault ? `approved base ${base} is not on ${project.defaultBranch} of ${project.fullName}` : `base is on ${project.defaultBranch} of ${project.fullName}`, 'BASE_INVALID');

  const expectedRef = `refs/heads/${agent}/task-${taskId}`;
  let bundleOk = false;
  let bundleDetail = '';
  try {
    await git(['bundle', 'verify', bundle], repo, home);
    const lines = (await git(['bundle', 'list-heads', bundle], repo, home)).trim().split('\n').filter(Boolean);
    bundleOk = lines.length === 1 && lines[0].split(' ')[1] === expectedRef;
    bundleDetail = bundleOk ? `contains only ${expectedRef}` : `unexpected refs in bundle: ${lines.map((l) => l.split(' ')[1]).join(', ')}`;
  } catch (error) {
    bundleDetail = /lacks|prerequisite|missing/i.test((error as Error).message)
      ? 'bundle needs commits this repository does not have (objects of another repository or another base)'
      : `bundle is unreadable: ${(error as Error).message.slice(0, 200)}`;
  }
  if (!add('bundle', bundleOk, bundleDetail, 'ARTIFACT_INVALID')) return;
  await git(['fetch', '-q', '--no-tags', bundle, `${expectedRef}:refs/publisher/head`], repo, home);

  const head = (await git(['rev-parse', '--verify', 'refs/publisher/head^{commit}'], repo, home)).trim();
  add('head_matches', head === approvedHead, head === approvedHead ? `head ${head}` : `artifact head ${head} is not the approved ${approvedHead}`, 'COMMIT_MISMATCH');
  const tree = (await git(['rev-parse', `${head}^{tree}`], repo, home)).trim();
  add('tree_matches', !!review.headTree && tree === review.headTree, review.headTree ? (tree === review.headTree ? `tree ${tree}` : `tree ${tree} is not the approved ${review.headTree}`) : 'no approved tree to compare', 'TREE_MISMATCH');
  const ancestor = await gitOk(['merge-base', '--is-ancestor', base, head], repo, home);
  if (!add('base_is_ancestor', ancestor, ancestor ? 'base is an ancestor of head' : 'approved base is not an ancestor of the head', 'BASE_INVALID')) return;

  const log = (await git(['log', '--format=%H%x00%P%x00%s%x00%an <%ae>%x00%cn <%ce>', `${base}..${head}`], repo, home)).trim();
  report.commits = log.split('\n').filter(Boolean).map((line) => {
    const [sha, parents, subject, author, committer] = line.split('\0');
    return { sha, parents: parents.split(' ').filter(Boolean).length, subject: subject.slice(0, 200), author, committer };
  }).reverse();
  const boundary = (await git(['rev-list', '--boundary', head, `^${base}`], repo, home)).split('\n').filter((l) => l.startsWith('-')).map((l) => l.slice(1));
  const linear = report.commits.length > 0 && report.commits.every((c) => c.parents === 1) && boundary.length === 1 && boundary[0] === base;
  add('linear_history', linear, linear ? `${report.commits.length} commit(s) directly on top of base` : 'history between base and head is not a simple chain on top of base', 'BASE_INVALID');

  const nameStatus = (await git(['diff', '--name-status', '--no-renames', '-z', base, head], repo, home)).split('\0');
  for (let i = 0; i + 1 < nameStatus.length; i += 2) report.files.push({ status: nameStatus[i], path: nameStatus[i + 1] });
  const actual = new Set(report.files.map((f) => `${f.status}\t${f.path}`));
  const approvedFiles = new Set((shown?.files ?? []).map((f) => `${f.status}\t${f.path}`));
  const extra = [...actual].filter((f) => !approvedFiles.has(f)).map((f) => f.replace('\t', ' '));
  const missing = [...approvedFiles].filter((f) => !actual.has(f)).map((f) => f.replace('\t', ' '));
  add('files_match', !!shown && extra.length === 0 && missing.length === 0, !shown ? 'no approved file list'
    : extra.length || missing.length ? `not shown at approval: [${extra.join(', ')}]; shown but not in the commit: [${missing.join(', ')}]`
    : `${actual.size} file(s), same as approved`, 'FILES_MISMATCH');

  // POLICY B: every commit keeps the worker identity; the head keeps its message. Read from the
  // commit objects themselves (the published SHA is this SHA, so nothing can be rewritten later).
  const identity = { name: `${agent}-worker`, email: `${agent}-worker@personal-ai.local` };
  const people = (await git(['log', '--format=%an%x00%ae%x00%cn%x00%ce', `${base}..${head}`], repo, home)).trim().split('\n').filter(Boolean).map((l) => l.split('\0'));
  const message = (await git(['log', '-1', '--format=%B', head], repo, home)).trim();
  const [an, ae, cn, ce] = people[0] ?? ['', '', '', ''];
  report.author = { name: an, email: ae, committerName: cn, committerEmail: ce, message: message.slice(0, 4000) };
  const sameIdentity = people.length > 0 && people.every(([a, b, c, d]) => a === identity.name && b === identity.email && c === identity.name && d === identity.email);
  const sameMessage = !!shown?.commitMessage && message.slice(0, 4000) === shown.commitMessage.trim();
  add('author_preserved', sameIdentity && sameMessage, !sameIdentity ? `author/committer is not the ${agent} worker identity (${an} <${ae}>, committer ${cn} <${ce}>)`
    : !sameMessage ? 'commit message differs from the one recorded at review time' : `${an} <${ae}>, committed by ${cn} <${ce}>; message unchanged`, 'AUTHOR_CHANGED');
}

/** Copies the bundle out of the worker's volume (so it cannot change under us) and checks the manifest. */
async function loadArtifact(
  job: PublicationJob, config: PublisherConfig, agent: string, base: string, head: string, work: string,
  add: (id: string, ok: boolean, detail: string, code?: ReasonCode) => boolean,
): Promise<string | null> {
  const taskId = job.publication.taskId;
  const root = config.artifactRoots[agent];
  const fail = (detail: string) => (add('artifact', false, detail, 'ARTIFACT_INVALID'), null);
  let manifest: Record<string, unknown>;
  try {
    const file = join(root, `${taskId}.json`);
    if ((await stat(file)).size > 64 * 1024) return fail('manifest too large');
    manifest = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    return fail((error as NodeJS.ErrnoException).code === 'ENOENT'
      ? `artifact missing for task ${taskId} (run export-artifact in the ${agent} worker)` : 'manifest unreadable');
  }
  const expected: Record<string, unknown> = {
    format: 'personal-ai-artifact/v1', taskId, agent, projectId: job.task.projectId, branch: `${agent}/task-${taskId}`,
    baseSha: base, headSha: head, bundle: `${taskId}.bundle`,
  };
  const mismatch = Object.keys(expected).filter((k) => manifest[k] !== expected[k]);
  if (mismatch.length) return fail(`manifest does not describe the approved commit (${mismatch.join(', ')})`);

  const source = join(root, `${taskId}.bundle`);
  const copy = join(work, 'artifact.bundle');
  try {
    const real = await realpath(source);
    const rootReal = await realpath(root);
    if (!real.startsWith(rootReal + sep)) return fail('bundle path leaves the artifact volume');
    const size = (await stat(real)).size;
    if (size > config.maxBundleBytes) return fail(`bundle is ${size} bytes, above the limit`);
    await copyFile(real, copy);
  } catch {
    return fail(`bundle missing for task ${taskId}`);
  }
  const digest = createHash('sha256').update(await readFile(copy)).digest('hex');
  if (digest !== manifest.bundleSha256) return fail('bundle checksum does not match its manifest (damaged or replaced)');
  add('artifact', true, `bundle sha256 ${digest.slice(0, 16)}…, ${(await stat(copy)).size} bytes`);
  return copy;
}

/** The repo-sync export copy for the project; must be a bare repository of the registered remote. */
async function trustedRepository(exportRoot: string, projectId: string, remoteUrl: string | null, home: string): Promise<{ ok: boolean; detail: string; path?: string }> {
  let path: string;
  try {
    const rootReal = await realpath(exportRoot);
    path = await realpath(join(exportRoot, `${projectId}.git`));
    if (!path.startsWith(rootReal + sep)) return { ok: false, detail: 'trusted copy resolves outside the export volume' };
  } catch {
    return { ok: false, detail: `no trusted copy of ${projectId} in the publisher export (run provision-exports)` };
  }
  const handle = await open(join(path, 'HEAD')).catch(() => null);
  await handle?.close();
  if (!handle) return { ok: false, detail: 'trusted copy is not a bare repository' };
  const upstream = (await git(['config', '--get', 'personal-ai.upstream'], path, home).catch(() => '')).trim();
  if (!remoteUrl || upstream !== remoteUrl) return { ok: false, detail: `trusted copy is of ${upstream || 'an unknown repository'}, not ${remoteUrl}` };
  return { ok: true, detail: `repo-sync copy of ${upstream}`, path };
}

function pullRequestPlan(job: PublicationJob, report: PublicationReport): PublicationReport['pullRequest'] {
  const review = job.review!;
  const firstLine = (job.reported?.commitMessage ?? '').split('\n').map((l) => l.trim()).find((l) => l && !/^(claude|codex)-worker: task /.test(l)) ?? '';
  const title = `[personal-ai/${job.task.agent}] ${firstLine || `task ${job.task.id.slice(0, 8)}`}`.slice(0, 120);
  const body = [
    'Prepared by the Personal AI OS GitHub Publisher. **Draft - created by an AI coding agent.**',
    '',
    `- Agent: ${job.task.agent} (task \`${job.task.id}\`)`,
    `- Code review approved by: ${review.decidedBy} at ${review.decidedAt} (review \`${review.id}\`)`,
    `- Publish authorized by: ${job.authorization?.authorizedBy ?? '(pending)'}${job.authorization ? ` at ${job.authorization.authorizedAt}` : ''}`,
    `- Tests: run \`${report.testValidationId}\` on \`${report.tests.commitSha}\`: ${report.tests.commands.map((c) => `${c.name} exit ${c.exitCode}`).join(', ')} (evidence sha256 \`${report.tests.evidenceHash}\`)`,
    `- Base: \`${review.baseSha}\` (${report.target.baseBranch})`,
    `- Head: \`${review.headSha}\`, tree \`${review.headTree}\` (published unchanged)`,
    `- Commit author/committer: ${report.author ? `${report.author.name} <${report.author.email}>` : 'unknown'} (worker identity, preserved); pushed by the GitHub App`,
    '',
    'Files:',
    ...report.files.map((f) => `- ${f.status} \`${f.path}\``),
  ].join('\n');
  return { title, body, head: report.target.branch, base: report.target.baseBranch ?? '', draft: true };
}
