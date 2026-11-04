import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, type PublisherConfig } from './config.js';
import type { GitHubReader, RemoteRepository } from './github.js';
import type { PublicationJob } from './verify.js';

/** Test fixtures shared by the publisher tests (removed from the runtime image). */
export const KEY = randomBytes(32);
export const COMMANDS = [
  { name: 'whitespace', argv: ['sh', '-c', 'git diff --check "$BASE_SHA" HEAD'], timeoutSeconds: 60 },
  { name: 'utf8', argv: ['sh', '-c', 'true'], timeoutSeconds: 30 },
];

export const g = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=codex-worker', '-c', 'user.email=codex-worker@personal-ai.local', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();

export class FakeGitHub implements GitHubReader {
  repos = new Map<string, RemoteRepository>();
  branches = new Map<string, string>();
  async repository(fullName: string) {
    return this.repos.get(fullName.toLowerCase()) ?? null;
  }
  async branchHead(fullName: string, branch: string) {
    return this.branches.get(`${fullName.toLowerCase()}#${branch}`) ?? null;
  }
}

/** A GitHub-like upstream, the repo-sync export of it, and a worker clone with one task commit. */
export function fixture(root: string, commit: { author?: string; email?: string; message?: string } = {}) {
  const upstream = join(root, 'upstream.git');
  const seed = join(root, 'seed');
  mkdirSync(seed);
  g(seed, 'init', '-q');
  writeFileSync(join(seed, 'README.md'), '# hello\n');
  g(seed, 'add', '-A');
  g(seed, 'commit', '-q', '-m', 'initial');
  g(root, 'clone', '-q', '--bare', seed, upstream);
  const base = g(upstream, 'rev-parse', 'refs/heads/main');

  const exportRoot = join(root, 'exports');
  mkdirSync(exportRoot);
  g(root, 'clone', '-q', '--bare', upstream, join(exportRoot, 'hello.git'));
  g(join(exportRoot, 'hello.git'), 'config', 'personal-ai.upstream', 'https://github.com/owner/hello.git');

  const taskId = randomUUID();
  const branch = `codex/task-${taskId}`;
  const worker = join(root, 'worker');
  g(root, 'clone', '-q', upstream, worker);
  g(worker, 'checkout', '-q', '-b', branch, base);
  writeFileSync(join(worker, 'NOTES.md'), '# Notes\n<script>alert(1)</script>\n');
  g(worker, 'add', '-A');
  const message = commit.message ?? `codex-worker: task ${taskId} (completed)\n\nAdd notes`;
  execFileSync('git', ['-c', `user.name=${commit.author ?? 'codex-worker'}`, '-c', `user.email=${commit.email ?? 'codex-worker@personal-ai.local'}`, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message], { cwd: worker });
  const head = g(worker, 'rev-parse', 'HEAD');
  const tree = g(worker, 'rev-parse', 'HEAD^{tree}');

  const artifacts = join(root, 'artifacts', 'codex');
  mkdirSync(artifacts, { recursive: true });
  const writeArtifact = (repo = worker, ref = `refs/heads/${branch}`, exclude = base, manifest: Record<string, unknown> = {}) => {
    const file = join(artifacts, `${taskId}.bundle`);
    g(repo, 'bundle', 'create', '-q', file, ref, `^${exclude}`);
    const data = readFileSync(file);
    writeFileSync(join(artifacts, `${taskId}.json`), JSON.stringify({
      format: 'personal-ai-artifact/v1', taskId, agent: 'codex', projectId: 'hello', branch, baseSha: base, headSha: head,
      bundle: `${taskId}.bundle`, bundleSha256: createHash('sha256').update(data).digest('hex'), bundleBytes: data.length, createdAt: 'x',
      ...manifest,
    }));
  };
  writeArtifact();
  return { root, upstream, exportRoot, artifacts, worker, taskId, branch, base, head, tree, message: message.trim(), writeArtifact };
}

export type Fixture = ReturnType<typeof fixture>;
export type Over = {
  review?: Partial<NonNullable<PublicationJob['review']>> | null;
  reported?: Partial<NonNullable<PublicationJob['reported']>>;
  project?: Partial<NonNullable<PublicationJob['project']>>;
  task?: Partial<PublicationJob['task']>;
  headSha?: string;
  tests?: { status?: string; results?: Array<Record<string, unknown>>; evidence?: Record<string, unknown>; key?: Buffer; commitSha?: string; tamper?: boolean } | null;
  authorization?: Partial<NonNullable<PublicationJob['authorization']>> | null | 'none';
  mode?: 'dry-run' | 'publish';
};

/** A runner-signed passing test run of the commit, unless overridden. */
export function testRun(f: Fixture, over: NonNullable<Over['tests']> = {}): NonNullable<PublicationJob['testValidation']> {
  const id = randomUUID();
  const results = over.results ?? COMMANDS.map((c) => ({ name: c.name, argv: c.argv, status: 'passed', exitCode: 0, signal: null, timedOut: false, durationMs: 3, outputBytes: 0, outputSha256: 'e'.repeat(64), outputTail: '' }));
  const status = over.status ?? 'passed';
  const commitSha = over.commitSha ?? f.head;
  const evidence = JSON.stringify({ format: 'personal-ai-test-evidence/v1', validationId: id, taskId: f.taskId, projectId: 'hello', agent: 'codex', baseSha: f.base, commitSha, treeSha: f.tree, commands: COMMANDS, results, status, error: null, ...over.evidence });
  const stored = over.tamper ? evidence.replace('"exitCode":1', '"exitCode":0') : evidence;
  return {
    id, taskId: f.taskId, projectId: 'hello', commitSha, status, commands: COMMANDS, results: results as never, completedAt: 'x',
    evidence: stored, evidenceHash: createHash('sha256').update(stored).digest('hex'),
    evidenceSignature: createHmac('sha256', over.key ?? KEY).update(evidence).digest('hex'),
  };
}

export function makeJob(f: Fixture, over: Over = {}): PublicationJob {
  const reviewId = 'r-1';
  const headSha = over.headSha ?? f.head;
  const pubId = randomUUID();
  const tv = over.tests === null ? null : testRun(f, over.tests ?? {});
  const mode = over.mode ?? 'dry-run';
  const authId = randomUUID();
  const authorization = over.authorization === 'none' ? null : {
    id: authId, taskId: f.taskId, reviewId, repositoryId: 42, headSha, testValidationId: tv?.id ?? 'none',
    status: mode === 'publish' ? 'used' : 'active', expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    usedAt: mode === 'publish' ? new Date().toISOString() : null, publicationId: mode === 'publish' ? pubId : null,
    authorizedBy: 'dashboard:owner', authorizedAt: new Date().toISOString(), ...(over.authorization ?? {}),
  };
  return {
    publication: { id: pubId, taskId: f.taskId, reviewId, headSha, mode, requestedBy: 'dashboard:owner', authorizationId: mode === 'publish' ? authId : null },
    task: { id: f.taskId, status: 'completed', agent: 'codex', projectId: 'hello', ...over.task },
    review: over.review === null ? null : {
      id: reviewId, status: 'approved', baseSha: f.base, headSha, headTree: f.tree, decidedBy: 'dashboard:owner', decidedAt: '2026-10-25T00:00:00Z', projectId: 'hello', ...over.review,
    },
    latestReview: { id: reviewId },
    reported: {
      baseSha: f.base, headSha, headTree: f.tree, commitMessage: f.message,
      files: [{ path: 'NOTES.md', status: 'A', binary: false, sensitive: false }],
      patchRecorded: true, patchTruncated: false, omittedFiles: [], tests: null, branch: f.branch, ...over.reported,
    },
    project: {
      id: 'hello', source: 'github', fullName: 'owner/hello', remoteUrl: 'https://github.com/owner/hello.git', defaultBranch: 'main',
      visibility: 'public', githubRepositoryId: 42, enabled: true, allowCodeChanges: true, testCommands: COMMANDS, ...over.project,
    },
    testValidation: tv,
    authorization: authorization as PublicationJob['authorization'],
  };
}

export function baseConfig(root: string, f: Fixture): PublisherConfig {
  return {
    ...loadConfig({ CONTROLLER_URL: 'http://controller:3000', PUBLISHER_ALLOWED_REPOSITORIES: 'owner/hello' }),
    artifactRoots: { codex: f.artifacts, claude: join(root, 'artifacts', 'claude') },
    exportRoot: f.exportRoot,
    workDir: join(root, 'work'),
    stateDir: join(root, 'state'),
  };
}

export function fakeGitHub(f: Fixture) {
  const github = new FakeGitHub();
  github.repos.set('owner/hello', { id: 42, fullName: 'owner/hello', defaultBranch: 'main', private: false });
  github.branches.set('owner/hello#main', f.base);
  return github;
}

