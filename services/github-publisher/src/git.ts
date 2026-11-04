import { spawn } from 'node:child_process';

export class GitError extends Error {
  constructor(message: string, readonly exitCode: number | null, readonly stderr: string) {
    super(message);
  }
}

/**
 * git with no system/global config, no hooks, no prompts and only local transports. Every
 * repository the publisher touches is untrusted content; nothing here can reach the network.
 */
export function git(args: string[], cwd: string, home: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', ...args], {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: home,
        LANG: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '',
        GIT_ALLOW_PROTOCOL: 'file',
        GIT_LFS_SKIP_SMUDGE: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < 32 * 1024 * 1024) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 8000) stderr += d.toString('utf8');
    });
    child.once('error', (error) => reject(new GitError(`git could not be started: ${error.message}`, null, '')));
    child.once('close', (code, signal) => {
      if (code === 0) return resolve(stdout);
      const reason = signal ? `killed (${signal})` : `exit ${code}`;
      reject(new GitError(`git ${args[0]} failed: ${reason}: ${stderr.trim().slice(-500)}`, code, stderr));
    });
  });
}

/** true/false for commands whose exit status is the answer (cat-file -e, merge-base --is-ancestor). */
export async function gitOk(args: string[], cwd: string, home: string): Promise<boolean> {
  try {
    await git(args, cwd, home);
    return true;
  } catch (error) {
    if (error instanceof GitError && error.exitCode !== null) return false;
    throw error;
  }
}
