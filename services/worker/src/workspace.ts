import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROJECT_ID_PATTERN, type WorkerConfig } from './config.js';
import type { RegistryProject, Task } from './controller-client.js';
import { runProcess } from './process-runner.js';

/** A problem with the task's project or workspace. The task fails; the worker keeps running. */
export class WorkspaceError extends Error {}

export type WorkspaceMode = 'write' | 'read';

export interface PreparedWorkspace {
  projectId: string;
  mode: WorkspaceMode;
  /** Directory the agent runs in and is confined to. */
  cwd: string;
  /** Write mode only: the task's own branch and worktree. */
  branch: string | null;
  baseCommit: string | null;
  /** 'github': checked out from this worker's own clone of the repository cache. */
  source?: 'local' | 'github';
  /** Things about the checkout worth telling the user (symlinks neutralised, submodules skipped). */
  notes?: string[];
  taskId?: string;
}

export interface ChangedFile {
  status: string;
  path: string;
}

export interface WorkspaceSummary {
  projectId: string;
  mode: WorkspaceMode;
  path: string;
  branch: string | null;
  baseCommit: string | null;
  commit: string | null;
  changedFiles: ChangedFile[];
  source?: 'local' | 'github';
  notes?: string[];
  /** Review data for the task commit (write mode with a commit only). */
  diff?: TaskDiff;
  /** Git bundle written for the GitHub Publisher (GitHub projects with a commit, if configured). */
  artifact?: { bundleSha256: string; bundleBytes: number };
  artifactError?: string;
}

/**
 * <taskId>.json next to <taskId>.bundle in the artifact volume. The publisher trusts neither file:
 * it checks the bundle's commits against the approved SHAs and its own copy of the repository.
 */
export interface ArtifactManifest {
  format: 'personal-ai-artifact/v1';
  taskId: string;
  agent: string;
  projectId: string;
  branch: string;
  baseSha: string;
  headSha: string;
  bundle: string;
  bundleSha256: string;
  bundleBytes: number;
  createdAt: string;
}

export interface DiffFile {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  /** Path or content looks like a credential: its patch is never included. */
  sensitive: boolean;
}

export interface TaskDiff {
  baseCommit: string;
  headCommit: string;
  headTree: string;
  commitMessage: string;
  additions: number;
  deletions: number;
  files: DiffFile[];
  /** Unified diff of text files that are not sensitive, cut at MAX_PATCH_CHARS. */
  patch: string;
  patchTruncated: boolean;
  omittedFiles: string[];
}

const MAX_PATCH_CHARS = 200_000;
const SENSITIVE_PATH =
  /(^|\/)(\.env(\..*)?|\.npmrc|\.netrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|[^/]*\.(pem|key|p12|pfx|jks|keystore)|[^/]*(credential|secret|token)[^/]*)$/i;
const SENSITIVE_CONTENT =
  /(github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[abpr]-[A-Za-z0-9-]{10,})/;

const WORKTREES_DIR = '.worktrees';
/** This worker's own clones of GitHub projects: repos/<projectId>.git (bare, independent objects). */
const REPOS_DIR = 'repos';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GIT_IDENTITY = (workerId: string) => [
  '-c', `user.name=${workerId}`,
  '-c', `user.email=${workerId}@personal-ai.local`,
  // Repository hooks are code; never let a project's hooks run inside the worker.
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'commit.gpgsign=false',
];
/**
 * Settings for clones of untrusted repositories, stored in the clone's own config so every
 * later git command (worktree add, status, add, commit) uses them:
 * no hooks, symlinks checked out as plain files, no fsmonitor, objects verified on fetch,
 * submodules never fetched, and only the local file:// transport to the cache.
 */
const UNTRUSTED_REPO_CONFIG: Array<[string, string]> = [
  ['core.hooksPath', '/dev/null'],
  ['core.symlinks', 'false'],
  ['core.fsmonitor', 'false'],
  ['transfer.fsckObjects', 'true'],
  ['fetch.fsckObjects', 'true'],
  ['fetch.recurseSubmodules', 'false'],
  ['submodule.recurse', 'false'],
  ['protocol.allow', 'never'],
  ['protocol.file.allow', 'always'],
  ['gc.auto', '0'],
];

/**
 * Layout under the workspace root (/workspace, private to this worker):
 *   <projectId>/                 local project repository (main checkout, never modified by tasks)
 *   repos/<projectId>.git        GitHub project: this worker's own bare clone of the repository cache
 *   .worktrees/<taskId>/         per-task git worktree on branch <agent>/task-<taskId>
 *
 * GitHub projects come only from the read-only cache /repo-cache/<projectId>.git that repo-sync
 * maintains; the worker never contacts GitHub and never uses a URL from a task.
 * Tasks never merge, push or delete anything; their changes stay on their branch.
 */
export class Workspace {
  private readonly root: string;

  constructor(private readonly config: WorkerConfig) {
    this.root = resolve(config.workspaceRoot);
  }

  /** Creates the sandbox repository on first start if it is missing. */
  async init(): Promise<void> {
    await mkdir(join(this.root, WORKTREES_DIR), { recursive: true });
    if (this.config.projects && !this.config.projects.includes('sandbox')) return;

    const dir = join(this.root, 'sandbox');
    if (await exists(join(dir, '.git'))) return;
    await mkdir(dir, { recursive: true });
    await this.git(dir, ['init', '-q', '-b', 'main']);
    await writeFile(
      join(dir, 'README.md'),
      '# sandbox\n\nScratch project for automated agent tasks. Each task works on its own branch.\n',
      { flag: 'wx' },
    ).catch(() => {});
    await this.git(dir, ['add', '-A']);
    await this.git(dir, [...GIT_IDENTITY(this.config.workerId), 'commit', '-q', '--allow-empty', '-m', 'Initialize sandbox']);
  }

  /**
   * `project` is the registry's entry for task.projectId (null if the registry does not list it
   * for this worker). Nothing from the task other than its project id and task id is used.
   */
  async prepare(task: Task, project: RegistryProject | null): Promise<PreparedWorkspace> {
    if (task.projectId === null) {
      throw new WorkspaceError('Task has no projectId; this worker only runs tasks in registered projects');
    }
    if (!PROJECT_ID_PATTERN.test(task.projectId)) {
      throw new WorkspaceError(`Invalid projectId "${task.projectId}"`);
    }
    if (!project || project.id !== task.projectId) {
      throw new WorkspaceError(`Project "${task.projectId}" is not enabled for ${this.config.agent} in the project registry`);
    }
    if (this.config.projects && !this.config.projects.includes(project.id)) {
      throw new WorkspaceError(`Project "${project.id}" is not enabled on this worker (WORKER_PROJECTS)`);
    }
    const writable =
      project.allowCodeChanges && (this.config.writableProjects === null || this.config.writableProjects.includes(project.id));

    return project.source === 'github'
      ? this.prepareGitHub(task, project, writable)
      : this.prepareLocal(task, project.id, writable);
  }

  private async prepareLocal(task: Task, projectId: string, writable: boolean): Promise<PreparedWorkspace> {
    const projectDir = await this.resolveProjectDir(projectId);
    const top = (await this.git(projectDir, ['rev-parse', '--show-toplevel']).catch(() => null))?.trim();
    if (!top || (await realpath(top)) !== projectDir) {
      throw new WorkspaceError(`Project "${projectId}" is not a git repository root`);
    }

    if (!writable) {
      return { projectId, mode: 'read', cwd: projectDir, branch: null, baseCommit: null, source: 'local' };
    }

    const worktree = await this.newWorktreePath(task.id);
    const branch = `${this.config.agent}/task-${task.id}`;
    const baseCommit = (await this.git(projectDir, ['rev-parse', 'HEAD'])).trim();
    await this.git(projectDir, ['worktree', 'add', '-q', '-b', branch, worktree, baseCommit]);
    return { projectId, mode: 'write', cwd: worktree, branch, baseCommit, source: 'local' };
  }

  /**
   * GitHub project: verify the cache, bring this worker's own clone up to date from it, and check
   * out the registry's commit (`cachedHeadSha`) in a new worktree. The clone receives copies of the
   * objects over the file:// transport (no hardlinks, no alternates), so later changes to the cache,
   * including a forced update or gc there, cannot affect commits made in this worker.
   */
  private async prepareGitHub(task: Task, project: RegistryProject, writable: boolean): Promise<PreparedWorkspace> {
    const sha = project.cachedHeadSha;
    if (project.syncStatus !== 'synced' || !sha || !SHA_PATTERN.test(sha)) {
      throw new WorkspaceError(
        `Project "${project.id}" has not been synced into the repository cache (syncStatus=${project.syncStatus}); run repo-sync first`,
      );
    }
    const cache = await this.resolveCache(project.id);
    const repo = await this.ensureClone(project.id, cache);
    await this.git(repo, ['fetch', '-q', '--no-tags', '--no-recurse-submodules', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
    if (!(await this.hasCommit(repo, sha))) {
      throw new WorkspaceError(`The repository cache for "${project.id}" does not contain the registry commit ${sha}; sync again`);
    }

    const notes = await this.inspectTree(repo, sha);
    const worktree = await this.newWorktreePath(task.id);
    if (!writable) {
      await this.git(repo, ['worktree', 'add', '-q', '--detach', worktree, sha]);
      return { projectId: project.id, mode: 'read', cwd: worktree, branch: null, baseCommit: sha, source: 'github', notes };
    }
    const branch = `${this.config.agent}/task-${task.id}`;
    await this.git(repo, ['worktree', 'add', '-q', '-b', branch, worktree, sha]);
    const head = (await this.git(worktree, ['rev-parse', 'HEAD'])).trim();
    if (head !== sha) throw new WorkspaceError(`Checked out ${head} instead of ${sha}`);
    return { projectId: project.id, mode: 'write', cwd: worktree, branch, baseCommit: sha, source: 'github', notes, taskId: task.id };
  }

  /** /repo-cache/<id>.git: must resolve inside the cache root, be a bare repository and respect the size limit. */
  private async resolveCache(projectId: string): Promise<string> {
    let cacheRoot: string;
    let cache: string;
    try {
      cacheRoot = await realpath(this.config.repoCacheRoot);
      cache = await realpath(join(cacheRoot, `${projectId}.git`));
    } catch {
      throw new WorkspaceError(`Project "${projectId}" is not in the repository cache; run repo-sync first`);
    }
    if (!cache.startsWith(cacheRoot + sep)) throw new WorkspaceError(`Cache for "${projectId}" resolves outside the cache root`);
    const bare = (await this.git(cache, ['rev-parse', '--is-bare-repository']).catch(() => '')).trim();
    if (bare !== 'true') throw new WorkspaceError(`Cache for "${projectId}" is not a bare repository`);
    const size = await directorySize(cache);
    if (size > this.config.maxRepoBytes) {
      throw new WorkspaceError(`Cache for "${projectId}" is ${size} bytes, above the ${this.config.maxRepoBytes} byte limit`);
    }
    return cache;
  }

  /** This worker's bare clone repos/<id>.git with origin = the cache. Created on first use, never reused for another origin. */
  private async ensureClone(projectId: string, cache: string): Promise<string> {
    const repo = join(this.root, REPOS_DIR, `${projectId}.git`);
    const origin = pathToFileURL(cache).href;
    if (await exists(repo)) {
      const current = (await this.git(repo, ['config', '--get', 'remote.origin.url']).catch(() => '')).trim();
      if (current !== origin) throw new WorkspaceError(`${repo} exists but is not this worker's clone of the cache`);
    } else {
      await mkdir(repo, { recursive: true });
      await this.git(repo, ['init', '-q', '--bare']);
      await this.git(repo, ['remote', 'add', 'origin', origin]);
    }
    for (const [key, value] of UNTRUSTED_REPO_CONFIG) await this.git(repo, ['config', key, value]);
    // Remote branches go to refs/remotes/origin/*, so a fetch can never move or delete task branches.
    await this.git(repo, ['config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
    return repo;
  }

  /** Reports symlinks (checked out as plain files) and submodules (not initialised). */
  private async inspectTree(repo: string, sha: string): Promise<string[]> {
    const listing = await this.git(repo, ['ls-tree', '-r', '--full-tree', sha]);
    let symlinks = 0;
    let submodules = 0;
    for (const line of listing.split('\n')) {
      if (line.startsWith('120000 ')) symlinks++;
      else if (line.startsWith('160000 ')) submodules++;
    }
    const notes: string[] = [];
    if (symlinks) notes.push(`${symlinks} symlink(s) checked out as plain files (core.symlinks=false)`);
    if (submodules) notes.push(`${submodules} submodule(s) not initialised`);
    return notes;
  }

  private async hasCommit(repo: string, sha: string): Promise<boolean> {
    return this.git(repo, ['cat-file', '-e', `${sha}^{commit}`]).then(() => true, () => false);
  }

  private async newWorktreePath(taskId: string): Promise<string> {
    const worktree = this.worktreePath(taskId);
    if (await exists(worktree)) {
      // Never reuse or overwrite: this task already ran here once.
      throw new WorkspaceError(`Worktree for task ${taskId} already exists; refusing to run the task twice`);
    }
    return worktree;
  }

  /** Commits whatever the agent left in the worktree onto the task branch, whatever the outcome. */
  async finalize(prepared: PreparedWorkspace, message: string): Promise<WorkspaceSummary> {
    const summary: WorkspaceSummary = {
      projectId: prepared.projectId,
      mode: prepared.mode,
      path: prepared.cwd,
      branch: prepared.branch,
      baseCommit: prepared.baseCommit,
      commit: null,
      changedFiles: [],
      source: prepared.source,
      notes: prepared.notes,
    };
    if (prepared.mode !== 'write' || !prepared.baseCommit) return summary;

    await this.git(prepared.cwd, ['add', '-A']);
    const pending = (await this.git(prepared.cwd, ['status', '--porcelain'])).trim();
    if (pending) {
      await this.git(prepared.cwd, [...GIT_IDENTITY(this.config.workerId), 'commit', '-q', '--no-verify', '-m', message]);
    }
    const head = (await this.git(prepared.cwd, ['rev-parse', 'HEAD'])).trim();
    if (head !== prepared.baseCommit) {
      summary.commit = head;
      const diff = await this.git(prepared.cwd, ['diff', '--name-status', '--no-renames', prepared.baseCommit, head]);
      summary.changedFiles = diff
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [status, ...path] = line.split('\t');
          return { status, path: path.join('\t') };
        });
      summary.diff = await this.diffDetails(prepared.cwd, prepared.baseCommit, head, summary.changedFiles);
      if (prepared.source === 'github' && prepared.taskId && prepared.branch && this.config.artifactRoot) {
        // A failed export does not fail the task; `export-artifact` can write it again later.
        try {
          const manifest = await this.exportArtifact(prepared.cwd, prepared.taskId, prepared.projectId, prepared.branch, prepared.baseCommit, head);
          summary.artifact = { bundleSha256: manifest.bundleSha256, bundleBytes: manifest.bundleBytes };
        } catch (error) {
          summary.artifactError = (error as Error).message;
        }
      }
    }
    return summary;
  }

  /**
   * Writes <taskId>.bundle (exactly the commits base..branch, base as prerequisite) and its manifest
   * into the artifact volume. The branch must still point at `headSha`. Files are renamed into place,
   * manifest last, so a reader never sees a half-written pair.
   */
  async exportArtifact(repoCwd: string, taskId: string, projectId: string, branch: string, baseSha: string, headSha: string): Promise<ArtifactManifest> {
    const root = this.config.artifactRoot;
    if (!root) throw new WorkspaceError('WORKER_ARTIFACT_DIR is not configured');
    if (!TASK_ID_PATTERN.test(taskId) || !PROJECT_ID_PATTERN.test(projectId) || !SHA_PATTERN.test(baseSha) || !SHA_PATTERN.test(headSha)) {
      throw new WorkspaceError('Invalid artifact parameters');
    }
    if (branch !== `${this.config.agent}/task-${taskId}`) throw new WorkspaceError(`Unexpected task branch ${branch}`);
    const tip = (await this.git(repoCwd, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])).trim();
    if (tip !== headSha) throw new WorkspaceError(`Branch ${branch} is at ${tip}, not ${headSha}`);
    if (baseSha === headSha) throw new WorkspaceError('The task made no commit');
    await this.git(repoCwd, ['merge-base', '--is-ancestor', baseSha, headSha]);

    await mkdir(root, { recursive: true });
    // Owner-only: the publisher reads as the same user; the test runner's sandbox user must not.
    await chmod(root, 0o700);
    const bundle = `${taskId}.bundle`;
    const tmpBundle = join(root, `.${bundle}.tmp`);
    await rm(tmpBundle, { force: true });
    await this.git(repoCwd, ['bundle', 'create', '-q', tmpBundle, `refs/heads/${branch}`, `^${baseSha}`]);
    await chmod(tmpBundle, 0o600);
    const data = await readFile(tmpBundle);
    const manifest: ArtifactManifest = {
      format: 'personal-ai-artifact/v1',
      taskId,
      agent: this.config.agent,
      projectId,
      branch,
      baseSha,
      headSha,
      bundle,
      bundleSha256: createHash('sha256').update(data).digest('hex'),
      bundleBytes: data.length,
      createdAt: new Date().toISOString(),
    };
    await rename(tmpBundle, join(root, bundle));
    const tmpManifest = join(root, `.${taskId}.json.tmp`);
    await writeFile(tmpManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(tmpManifest, join(root, `${taskId}.json`));
    return manifest;
  }

  async branchHead(repoCwd: string, branch: string): Promise<string> {
    return (await this.git(repoCwd, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])).trim();
  }

  /** This worker's clone of a GitHub project (for `export-artifact`). */
  githubRepoPath(projectId: string): string {
    if (!PROJECT_ID_PATTERN.test(projectId)) throw new WorkspaceError(`Invalid projectId "${projectId}"`);
    return join(this.root, REPOS_DIR, `${projectId}.git`);
  }

  /**
   * What a reviewer needs to approve exactly this commit: per-file line counts, the commit message
   * and a bounded patch. Binary files and files that look like credentials are listed without content.
   */
  private async diffDetails(cwd: string, base: string, head: string, changed: ChangedFile[]): Promise<TaskDiff> {
    const status = new Map(changed.map((c) => [c.path, c.status]));
    const numstat = await this.git(cwd, ['diff', '--numstat', '--no-renames', '--no-ext-diff', base, head]);
    const raw = await this.git(cwd, ['diff', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', base, head]);
    const sections = new Map<string, string>();
    for (const part of raw.split(/^(?=diff --git )/m)) {
      const path = /^diff --git a\/(.+?) b\//.exec(part)?.[1];
      if (path) sections.set(path, part);
    }
    const files: DiffFile[] = numstat.split('\n').filter(Boolean).map((line) => {
      const [add, del, ...rest] = line.split('\t');
      const path = rest.join('\t');
      const binary = add === '-' && del === '-';
      const added = (sections.get(path) ?? '').split('\n').filter((l) => l.startsWith('+')).join('\n');
      return {
        path,
        status: status.get(path) ?? 'M',
        additions: binary ? null : Number(add),
        deletions: binary ? null : Number(del),
        binary,
        sensitive: SENSITIVE_PATH.test(path) || SENSITIVE_CONTENT.test(added),
      };
    });
    let patch = '';
    let patchTruncated = false;
    const omittedFiles: string[] = [];
    for (const file of files) {
      if (file.binary || file.sensitive) {
        omittedFiles.push(file.path);
        continue;
      }
      const section = sections.get(file.path) ?? '';
      if (patch.length + section.length > MAX_PATCH_CHARS) {
        patchTruncated = true;
        omittedFiles.push(file.path);
        continue;
      }
      patch += section;
    }
    return {
      baseCommit: base,
      headCommit: head,
      headTree: (await this.git(cwd, ['rev-parse', `${head}^{tree}`])).trim(),
      commitMessage: (await this.git(cwd, ['log', '-1', '--format=%B', head])).trim().slice(0, 4000),
      additions: files.reduce((n, f) => n + (f.additions ?? 0), 0),
      deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
      files,
      patch,
      patchTruncated,
      omittedFiles,
    };
  }

  worktreePath(taskId: string): string {
    return join(this.root, WORKTREES_DIR, taskId);
  }

  /** Maps a local project id to its directory, refusing anything that could leave the workspace root. */
  async resolveProjectDir(projectId: string): Promise<string> {
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      throw new WorkspaceError(`Invalid projectId "${projectId}"`);
    }
    const candidate = join(this.root, projectId);
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      throw new WorkspaceError(`Project "${projectId}" does not exist in the workspace`);
    }
    const rootReal = await realpath(this.root);
    const rel = relative(rootReal, real);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new WorkspaceError(`Project "${projectId}" resolves outside the workspace`);
    }
    if (!(await stat(real)).isDirectory()) {
      throw new WorkspaceError(`Project "${projectId}" is not a directory`);
    }
    return real;
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const result = await runProcess('git', args, {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        SystemRoot: process.env.SystemRoot,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        // The worker's git only ever talks to the local repository cache.
        GIT_ALLOW_PROTOCOL: 'file',
        GIT_LFS_SKIP_SMUDGE: '1',
        LANG: 'C.UTF-8',
      },
      timeoutMs: 300_000,
      maxStdoutBytes: 16 * 1024 * 1024,
      maxStderrBytes: 64 * 1024,
      killGraceMs: 2000,
    });
    if (result.exitCode !== 0) {
      throw new WorkspaceError(`git ${args.filter((a) => !a.includes('=')).slice(0, 3).join(' ')} failed: ${(result.spawnError ?? result.stderr).trim().slice(0, 500)}`);
    }
    return result.stdout;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function directorySize(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else if (entry.isFile()) total += (await stat(full)).size;
  }
  return total;
}
