import { spawn } from 'node:child_process';

export class GitError extends Error {}

/**
 * git as the runner (root without most capabilities): no hooks, no system/global config, only the
 * local file transport. Repositories are untrusted content; safe.directory is set because the
 * read-only exports and artifacts belong to another uid.
 */
export function git(args: string[], cwd: string, home: string, timeoutMs = 300_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', '-c', 'safe.directory=*', ...args], {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      env: { PATH: process.env.PATH, HOME: home, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file', GIT_LFS_SKIP_SMUDGE: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < 16 * 1024 * 1024) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 8000) stderr += d.toString('utf8');
    });
    child.once('error', (error) => reject(new GitError(`git could not be started: ${error.message}`)));
    child.once('close', (code, signal) => {
      if (code === 0) return resolve(stdout);
      reject(new GitError(`git ${args[0]} failed: ${signal ?? `exit ${code}`}: ${stderr.trim().slice(-500)}`));
    });
  });
}
