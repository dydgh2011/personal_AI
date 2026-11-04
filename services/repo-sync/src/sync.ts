import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// Git (including Git for Windows) treats this path as the null device.
const DEV_NULL = '/dev/null';

/** Same rule as the controller: project ids are opaque keys, never paths. */
export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const GITHUB_URL_PATTERN = /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}?(?:\.git)?$/;
const LOCAL_HTTP_PATTERN = /^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9._/-]+$/;
export const BRANCH_PATTERN = /^(?![-/])(?!.*(?:\.\.|\/\/|@\{|\\))[A-Za-z0-9._/-]{1,200}(?<![./])$/;
export const AGENTS = ['claude', 'codex'] as const;
/** Export volumes: one per coding agent, plus the GitHub Publisher's (projects it may verify). */
export const EXPORT_TARGETS = [...AGENTS, 'publisher'] as const;

export type SyncErrorCode =
  | 'invalid'
  | 'auth_required'
  | 'auth_failed'
  | 'not_found_or_no_access'
  | 'limit_exceeded'
  | 'conflict'
  | 'git_failed';

export class SyncError extends Error {
  constructor(
    message: string,
    readonly code: SyncErrorCode = 'invalid',
  ) {
    super(message);
  }
}

export interface SyncOptions {
  /** Directory holding one bare repository per project: <root>/<id>.git */
  cacheRoot: string;
  id: string;
  url: string;
  branch: string;
  /**
   * Read-only GitHub token (fine-grained PAT) for private repositories, or null for anonymous.
   * Sent only as an HTTP Authorization header through git's environment-based config
   * (never in the URL, argv, the repository config or logs).
   */
  token: string | null;
  timeoutMs: number;
  /** This repository's cache size limit. */
  maxBytes: number;
  /** Limit for all repositories in the cache together. */
  maxCacheBytes: number;
  /** Largest single file (blob) allowed in the repository. */
  maxFileBytes: number;
  git?: string;
  /** Tests only: accept file:// or http://127.0.0.1 remotes. Never reachable from the CLI. */
  allowFileUrlsForTests?: boolean;
  allowLocalHttpForTests?: boolean;
}

export interface SyncResult {
  id: string;
  url: string;
  path: string;
  branch: string;
  headSha: string;
  created: boolean;
  refs: number;
  sizeBytes: number;
  cacheBytes: number;
  largestFileBytes: number;
  authenticated: boolean;
  durationMs: number;
  fetchedAt: string;
}

export function validateUrl(url: string, options: Pick<SyncOptions, 'allowFileUrlsForTests' | 'allowLocalHttpForTests'> = {}): string {
  if (options.allowFileUrlsForTests && url.startsWith('file://')) return url;
  if (options.allowLocalHttpForTests && LOCAL_HTTP_PATTERN.test(url)) return url;
  if (!GITHUB_URL_PATTERN.test(url)) {
    throw new SyncError('Only https://github.com/<owner>/<repo> URLs without credentials are allowed');
  }
  return url;
}

/** <root>/<id>.git, resolved, and guaranteed to stay inside the root. */
export async function cachePath(cacheRoot: string, id: string): Promise<string> {
  if (!PROJECT_ID_PATTERN.test(id)) throw new SyncError(`Invalid project id "${id}"`);
  const root = await realpath(cacheRoot).catch(() => {
    throw new SyncError(`Cache root ${cacheRoot} does not exist`);
  });
  const path = join(root, `${id}.git`);
  if (!path.startsWith(root + sep)) throw new SyncError('Cache path escapes the cache root');
  return path;
}

/** Settings every cache and export repository carries (the content is untrusted). */
function hardenedConfig(allowFile: boolean, allowHttp: boolean): Array<[string, string]> {
  return [
    ['core.hooksPath', DEV_NULL],
    ['protocol.allow', 'never'],
    [allowFile ? 'protocol.file.allow' : allowHttp ? 'protocol.http.allow' : 'protocol.https.allow', 'always'],
    ['transfer.fsckObjects', 'true'],
    ['fetch.fsckObjects', 'true'],
    ['fetch.recurseSubmodules', 'false'],
    ['credential.helper', ''],
    ['gc.auto', '0'],
  ];
}

/**
 * Creates or updates a bare mirror of the remote's branches and tags.
 *
 * Safety properties (the repository content is untrusted):
 * - bare repository, never checked out: no working tree, so no .gitattributes
 *   filters, no LFS smudge, no submodules, no checkout hooks
 * - core.hooksPath points at /dev/null and no global/system git config is read
 * - only https (or local test transports); credentials never in URLs or argv
 * - every received object is fsck-checked; prompting for credentials is disabled
 * - an existing directory is only reused if it is a bare repository for the same URL
 * - a private repository without a token, or with a rejected token, fails: there is
 *   no fallback to anonymous access
 */
export async function syncRepository(options: SyncOptions): Promise<SyncResult> {
  const started = Date.now();
  const url = validateUrl(options.url, options);
  if (!BRANCH_PATTERN.test(options.branch)) throw new SyncError(`Invalid branch name "${options.branch}"`);
  if (options.token !== null && (options.token.length < 20 || /\s/.test(options.token))) {
    throw new SyncError('The GitHub token file does not contain a valid token', 'auth_failed');
  }
  const path = await cachePath(options.cacheRoot, options.id);
  const home = await mkdtemp(join(tmpdir(), 'repo-sync-home-'));
  const env = gitEnv(home, url, options.token, options);
  const git = (args: string[], cwd?: string) => runGit(options.git ?? 'git', args, env, options.timeoutMs, cwd, options.token);

  try {
    let created = false;
    const existing = await stat(path).catch(() => null);
    if (existing) {
      if (!existing.isDirectory()) throw new SyncError(`${path} exists and is not a repository`, 'conflict');
      const bare = (await git(['rev-parse', '--is-bare-repository'], path).catch(() => '')).trim();
      const remote = (await git(['config', '--get', 'remote.origin.url'], path).catch(() => '')).trim();
      if (bare !== 'true' || remote !== url) {
        throw new SyncError(`Refusing to reuse ${path}: it is not the cache repository for ${url}`, 'conflict');
      }
    } else {
      const others = await directorySize(options.cacheRoot);
      if (others >= options.maxCacheBytes) {
        throw new SyncError(`The repository cache already uses ${others} bytes (limit ${options.maxCacheBytes})`, 'limit_exceeded');
      }
      created = true;
      await mkdir(path);
      await git(['init', '--bare', '--quiet', path]);
    }

    for (const [key, value] of hardenedConfig(!!options.allowFileUrlsForTests, !!options.allowLocalHttpForTests)) {
      await git(['config', key, value], path);
    }
    await git(['config', 'remote.origin.url', url], path);
    await git(['config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*'], path);
    await git(['config', '--add', 'remote.origin.fetch', '+refs/tags/*:refs/tags/*'], path);

    await git(['fetch', '--prune', '--no-recurse-submodules', '--no-write-fetch-head', '--quiet', 'origin'], path);
    const headSha = (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${options.branch}^{commit}`], path).catch(() => {
      throw new SyncError(`Branch ${options.branch} does not exist on the remote`, 'not_found_or_no_access');
    })).trim();
    await git(['symbolic-ref', 'HEAD', `refs/heads/${options.branch}`], path);
    const refs = (await git(['for-each-ref', '--format=%(refname)'], path)).split('\n').filter(Boolean).length;

    const sizeBytes = await directorySize(path);
    const cacheBytes = await directorySize(options.cacheRoot);
    const largestFileBytes = await largestBlob(git, path);
    if (sizeBytes > options.maxBytes) {
      throw new SyncError(`Repository cache is ${sizeBytes} bytes, above the ${options.maxBytes} byte limit`, 'limit_exceeded');
    }
    if (cacheBytes > options.maxCacheBytes) {
      throw new SyncError(`The repository cache uses ${cacheBytes} bytes, above the ${options.maxCacheBytes} byte limit`, 'limit_exceeded');
    }
    if (largestFileBytes > options.maxFileBytes) {
      throw new SyncError(`The repository contains a ${largestFileBytes} byte file, above the ${options.maxFileBytes} byte limit`, 'limit_exceeded');
    }
    return {
      id: options.id,
      url,
      path,
      branch: options.branch,
      headSha,
      created,
      refs,
      sizeBytes,
      cacheBytes,
      largestFileBytes,
      authenticated: options.token !== null,
      durationMs: Date.now() - started,
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

export interface ExportOptions {
  cacheRoot: string;
  /** Root of one agent's export volume: <exportRoot>/<id>.git */
  exportRoot: string;
  /** Exactly the projects this agent may use (enabled and allowed in the registry). */
  projects: string[];
  timeoutMs: number;
  git?: string;
}

export interface ExportResult {
  exported: Array<{ id: string; headSha: string | null }>;
  removed: string[];
  errors: Array<{ id: string; error: string }>;
}

/**
 * Makes an agent's export volume contain exactly `projects`, each as an independent bare copy
 * of the cache (objects copied over file://, no alternates). Anything else in the volume is
 * deleted, so revoking an agent's access or disabling a project removes the repository from that
 * agent's worker. Exports are derived data; the cache and the workers' own clones are untouched.
 */
export async function exportRepositories(options: ExportOptions): Promise<ExportResult> {
  for (const id of options.projects) if (!PROJECT_ID_PATTERN.test(id)) throw new SyncError(`Invalid project id "${id}"`);
  const exportRoot = await realpath(options.exportRoot).catch(() => {
    throw new SyncError(`Export root ${options.exportRoot} does not exist`);
  });
  // Owner-only: readers run as the same user; sandboxed test processes (another uid) cannot list it.
  await chmod(exportRoot, 0o700);
  const home = await mkdtemp(join(tmpdir(), 'repo-export-home-'));
  const env = gitEnv(home, null, null, { allowFileUrlsForTests: true });
  const git = (args: string[], cwd?: string) => runGit(options.git ?? 'git', args, env, options.timeoutMs, cwd, null);
  const result: ExportResult = { exported: [], removed: [], errors: [] };
  const wanted = new Set(options.projects);

  try {
    for (const entry of await readdir(exportRoot, { withFileTypes: true })) {
      const id = entry.name.endsWith('.git') ? entry.name.slice(0, -4) : null;
      if (id !== null && wanted.has(id) && entry.isDirectory()) continue;
      await rm(join(exportRoot, entry.name), { recursive: true, force: true });
      result.removed.push(entry.name);
    }
    for (const id of options.projects) {
      try {
        const source = await cachePath(options.cacheRoot, id);
        if (!(await stat(source).catch(() => null))) throw new SyncError('not in the repository cache; sync it first');
        const target = join(exportRoot, `${id}.git`);
        const origin = pathToFileURL(source).href;
        if (!(await stat(target).catch(() => null))) {
          await mkdir(target);
          await git(['init', '--bare', '--quiet', target]);
        }
        for (const [key, value] of hardenedConfig(true, false)) await git(['config', key, value], target);
        await git(['config', 'remote.origin.url', origin], target);
        await git(['config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*'], target);
        await git(['config', '--add', 'remote.origin.fetch', '+refs/tags/*:refs/tags/*'], target);
        await git(['fetch', '--prune', '--no-recurse-submodules', '--no-write-fetch-head', '--quiet', 'origin'], target);
        // Which GitHub repository this copy is of (the publisher compares it with the registry).
        const upstream = (await git(['config', '--get', 'remote.origin.url'], source).catch(() => '')).trim();
        if (upstream) await git(['config', 'personal-ai.upstream', upstream], target);
        const head = (await git(['symbolic-ref', 'HEAD'], source)).trim();
        await git(['symbolic-ref', 'HEAD', head], target);
        const headSha = (await git(['rev-parse', '--verify', '--quiet', 'HEAD'], target).catch(() => '')).trim() || null;
        result.exported.push({ id, headSha });
      } catch (error) {
        result.errors.push({ id, error: (error as Error).message });
      }
    }
    return result;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function gitEnv(
  home: string,
  url: string | null,
  token: string | null,
  options: Pick<SyncOptions, 'allowFileUrlsForTests' | 'allowLocalHttpForTests'>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: DEV_NULL,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_ALLOW_PROTOCOL: options.allowFileUrlsForTests ? 'file' : options.allowLocalHttpForTests ? 'http' : 'https',
    GIT_LFS_SKIP_SMUDGE: '1',
  };
  if (token !== null && url !== null) {
    // Scoped to this remote's origin, so the header is never sent anywhere else.
    const origin = new URL(url).origin + '/';
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = `http.${origin}.extraHeader`;
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  return env;
}

function runGit(git: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, cwd: string | undefined, token: string | null): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(git, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env, timeout: timeoutMs, killSignal: 'SIGKILL' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')).length);
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 4000) stderr += d.toString('utf8');
    });
    child.once('error', (error) => reject(new SyncError(`git could not be started: ${error.message}`, 'git_failed')));
    child.once('close', (code, signal) => {
      if (code === 0) return resolve(stdout);
      const reason = signal ? `killed (${signal}${signal === 'SIGKILL' ? ', timeout?' : ''})` : `exit ${code}`;
      const detail = scrub(stderr.trim(), token).slice(-600);
      reject(new SyncError(`git ${args[0]} failed: ${reason}: ${detail}`, classify(detail, token !== null)));
    });
  });
}

/** Maps git's stderr to a stable error code the registry can record. */
export function classify(stderr: string, authenticated: boolean): SyncErrorCode {
  if (/Authentication failed|HTTP 401|Invalid username or password|could not read Username|terminal prompts disabled/i.test(stderr)) {
    return authenticated ? 'auth_failed' : 'auth_required';
  }
  if (/Repository not found|HTTP 403|HTTP 404|not found/i.test(stderr)) return 'not_found_or_no_access';
  return 'git_failed';
}

/** Removes anything that could be a credential from git's output. */
export function scrub(text: string, token: string | null = null): string {
  let out = text.replace(/(https?:\/\/)[^/\s@]+@/g, '$1***@');
  out = out.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted]');
  out = out.replace(/(Authorization:\s*\w+\s+)\S+/gi, '$1[redacted]');
  if (token) {
    out = out.split(token).join('[redacted]');
    out = out.split(Buffer.from(`x-access-token:${token}`).toString('base64')).join('[redacted]');
  }
  return out;
}

async function largestBlob(git: (args: string[], cwd?: string) => Promise<string>, path: string): Promise<number> {
  const listing = await git(['cat-file', '--batch-all-objects', '--batch-check=%(objecttype) %(objectsize)'], path);
  let max = 0;
  for (const line of listing.split('\n')) {
    const [type, size] = line.split(' ');
    if (type === 'blob') max = Math.max(max, Number(size));
  }
  return max;
}

async function directorySize(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else if (entry.isFile()) total += (await stat(full)).size;
  }
  return total;
}
