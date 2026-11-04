import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { EXPORT_TARGETS, exportRepositories, SyncError, syncRepository } from './sync.js';

const USAGE = [
  'usage: repo-sync sync --id <projectId> --url https://github.com/<owner>/<repo>.git --branch <branch> [--auth none|token]',
  '       repo-sync export --agent claude|codex|publisher --projects <id,id,...>   (empty list removes every export)',
].join('\n');

/**
 * One JSON object on stdout; exit 0 on success, 1 on a sync failure, 2 on bad usage.
 * This is the interface a scheduler (cron, event handler) can drive later; today
 * services/repo-sync/scripts/sync-project.ps1 calls it.
 */
async function main(): Promise<number> {
  const print = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        id: { type: 'string' },
        url: { type: 'string' },
        branch: { type: 'string' },
        auth: { type: 'string', default: 'none' },
        agent: { type: 'string' },
        projects: { type: 'string' },
      },
    });
  } catch (error) {
    print({ ok: false, code: 'invalid', error: `${(error as Error).message}\n${USAGE}` });
    return 2;
  }
  const { positionals, values } = parsed;
  const number = (name: string, fallback: number) => {
    const raw = process.env[name];
    return raw && /^\d+$/.test(raw) ? Number(raw) : fallback;
  };
  const timeoutMs = number('REPO_SYNC_TIMEOUT_SECONDS', 600) * 1000;

  try {
    if (positionals[0] === 'sync' && positionals.length === 1 && values.id && values.url && values.branch) {
      if (values.auth !== 'none' && values.auth !== 'token') throw new SyncError('--auth must be none or token');
      const result = await syncRepository({
        cacheRoot: process.env.REPO_CACHE_ROOT || '/repo-cache',
        id: values.id,
        url: values.url,
        branch: values.branch,
        token: values.auth === 'token' ? readToken() : null,
        timeoutMs,
        maxBytes: number('REPO_SYNC_MAX_BYTES', 2 * 1024 ** 3),
        maxCacheBytes: number('REPO_SYNC_MAX_CACHE_BYTES', 20 * 1024 ** 3),
        maxFileBytes: number('REPO_SYNC_MAX_FILE_BYTES', 100 * 1024 ** 2),
      });
      print({ ok: true, ...result });
      return 0;
    }
    if (positionals[0] === 'export' && positionals.length === 1 && values.agent && values.projects !== undefined) {
      if (!(EXPORT_TARGETS as readonly string[]).includes(values.agent)) throw new SyncError('--agent must be claude, codex or publisher');
      const result = await exportRepositories({
        cacheRoot: process.env.REPO_CACHE_ROOT || '/repo-cache',
        exportRoot: `${process.env.REPO_EXPORT_ROOT || '/exports'}/${values.agent}`,
        projects: values.projects.split(',').map((p) => p.trim()).filter(Boolean),
        timeoutMs,
      });
      print({ ok: result.errors.length === 0, agent: values.agent, ...result });
      return result.errors.length === 0 ? 0 : 1;
    }
    print({ ok: false, code: 'invalid', error: USAGE });
    return 2;
  } catch (error) {
    const e = error instanceof SyncError ? error : new SyncError(`Unexpected error: ${(error as Error).message}`, 'git_failed');
    print({ ok: false, code: e.code, error: e.message });
    return 1;
  }
}

/** The token comes only from the mounted secret file; a missing file is an error, never anonymous access. */
function readToken(): string {
  const file = process.env.REPO_SYNC_TOKEN_FILE || '/run/secrets/github_token';
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    throw new SyncError(`This project needs a GitHub token but ${file} is not mounted (compose.github.yaml)`, 'auth_required');
  }
}

process.exitCode = await main();
