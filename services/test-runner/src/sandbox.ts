import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';

export interface CommandResult {
  name: string;
  argv: string[];
  status: 'passed' | 'failed' | 'skipped' | 'aborted';
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  outputBytes: number;
  outputSha256: string;
  outputTail: string;
}

export interface SandboxOptions {
  cwd: string;
  home: string;
  uid: number;
  gid: number;
  env: Record<string, string>;
  maxOutputBytes: number;
}

/**
 * Runs one approved command as the sandbox user, in its own process group, with a minimal
 * environment (no tokens, no keys). The verdict is the process exit status observed here.
 */
export function runCommand(command: { name: string; argv: string[]; timeoutSeconds: number }, options: SandboxOptions): Promise<CommandResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const hash = createHash('sha256');
    let bytes = 0;
    let kept = Buffer.alloc(0);
    let timedOut = false;
    const [file, ...args] = command.argv;
    const child = spawn(file, args, {
      cwd: options.cwd,
      shell: false,
      detached: true,
      uid: options.uid,
      gid: options.gid,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: options.home,
        LANG: 'C.UTF-8',
        CI: 'true',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        ...options.env,
      },
    });
    const onData = (d: Buffer) => {
      bytes += d.length;
      hash.update(d);
      if (kept.length < options.maxOutputBytes) kept = Buffer.concat([kept, d]).subarray(0, options.maxOutputBytes);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, command.timeoutSeconds * 1000);
    let finished = false;
    const finish = (exitCode: number | null, signal: string | null, spawnError?: string) => {
      // 'error' and 'close' can both fire for a program that cannot be started.
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      killGroup(child.pid);
      const tail = (spawnError ? `${spawnError}\n` : '') + kept.subarray(Math.max(0, kept.length - 4000)).toString('utf8');
      resolve({
        name: command.name,
        argv: command.argv,
        status: timedOut || (exitCode === null && !spawnError) ? 'aborted' : exitCode === 0 ? 'passed' : 'failed',
        exitCode: timedOut ? null : exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - started,
        outputBytes: bytes,
        outputSha256: hash.digest('hex'),
        outputTail: tail.slice(-4000),
      });
    };
    child.once('error', (error) => finish(127, null, `could not start ${file}: ${(error as NodeJS.ErrnoException).code ?? error.message}`));
    child.once('close', (code, signal) => finish(code, signal));
  });
}

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

/** Kills every process still owned by the sandbox user (anything a test left behind). */
export async function killSandboxProcesses(uid: number): Promise<number> {
  let killed = 0;
  for (const entry of await readdir('/proc').catch(() => [] as string[])) {
    if (!/^\d+$/.test(entry)) continue;
    const status = await readFile(`/proc/${entry}/status`, 'utf8').catch(() => '');
    const real = /^Uid:\s+(\d+)/m.exec(status)?.[1];
    if (real !== undefined && Number(real) === uid) {
      try {
        process.kill(Number(entry), 'SIGKILL');
        killed++;
      } catch {
        // raced with exit
      }
    }
  }
  return killed;
}
