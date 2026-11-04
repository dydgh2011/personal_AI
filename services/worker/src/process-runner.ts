import { spawn } from 'node:child_process';

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Written to the child's stdin, which is then closed. stdin is closed immediately if omitted. */
  stdin?: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  /** Time between SIGTERM and SIGKILL. */
  killGraceMs: number;
  /** Aborting terminates the process the same way a timeout does. */
  signal?: AbortSignal;
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  /** Set when the process could not be started at all (e.g. ENOENT). */
  spawnError: string | null;
}

const isPosix = process.platform !== 'win32';

/**
 * Runs an executable with an argument array. Never uses a shell, so nothing in
 * `args` is interpreted. On POSIX the child leads its own process group and
 * termination signals the whole group, so tools it spawned die with it.
 */
export function runProcess(command: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const stdout = new BoundedBuffer(options.maxStdoutBytes);
  const stderr = new BoundedBuffer(options.maxStderrBytes);
  let timedOut = false;
  let aborted = false;
  let killTimer: NodeJS.Timeout | undefined;
  let timeout: NodeJS.Timeout | undefined;

  return new Promise((resolve) => {
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, spawnError: string | null) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut,
        aborted,
        durationMs: Date.now() - started,
        spawnError,
      });
    };

    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      detached: isPosix,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const terminate = () => {
      if (killTimer || child.exitCode !== null || child.signalCode !== null) return;
      signalTree(child.pid, 'SIGTERM', child);
      killTimer = setTimeout(() => signalTree(child.pid, 'SIGKILL', child), options.killGraceMs);
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);

    let settled = false;
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      finish(null, null, error.message);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      finish(code, signal, null);
    });

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    // The child may exit before reading stdin; that is not an error for us.
    child.stdin.on('error', () => {});
    child.stdin.end(options.stdin ?? '');

    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function signalTree(pid: number | undefined, signal: NodeJS.Signals, child: { kill(signal: NodeJS.Signals): boolean }) {
  if (pid === undefined) return;
  try {
    if (isPosix) process.kill(-pid, signal);
    else child.kill(signal);
  } catch {
    // Already gone.
  }
}

export const TRUNCATION_MARKER = '\n…[output truncated]…\n';

/**
 * Keeps the first and the last half of `limit` bytes and drops the middle.
 * Agents print their final result last (Claude's result object, Codex's
 * closing JSONL events), so the end must survive truncation.
 */
class BoundedBuffer {
  private readonly head: Buffer[] = [];
  private headSize = 0;
  private readonly tail: Buffer[] = [];
  private tailSize = 0;
  private readonly headLimit: number;
  private readonly tailLimit: number;
  truncated = false;

  constructor(limit: number) {
    this.headLimit = Math.ceil(limit / 2);
    this.tailLimit = limit - this.headLimit;
  }

  push(chunk: Buffer) {
    const room = this.headLimit - this.headSize;
    if (room > 0) {
      const part = chunk.subarray(0, room);
      this.head.push(part);
      this.headSize += part.length;
      chunk = chunk.subarray(part.length);
      if (chunk.length === 0) return;
    }
    this.tail.push(chunk);
    this.tailSize += chunk.length;
    while (this.tailSize > this.tailLimit) {
      this.truncated = true;
      const excess = this.tailSize - this.tailLimit;
      const first = this.tail[0];
      if (first.length <= excess) {
        this.tail.shift();
        this.tailSize -= first.length;
      } else {
        this.tail[0] = first.subarray(excess);
        this.tailSize -= excess;
      }
    }
  }

  text(): string {
    const head = Buffer.concat(this.head).toString('utf8');
    const tail = Buffer.concat(this.tail).toString('utf8');
    return this.truncated ? `${head}${TRUNCATION_MARKER}${tail}` : head + tail;
  }
}
