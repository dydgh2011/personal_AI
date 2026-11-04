import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { CheckoutError, prepareCheckout, type TestRunJob } from './checkout.js';
import { ConfigError, loadConfig, type RunnerConfig } from './config.js';
import { overallStatus, seal, type Evidence } from './evidence.js';
import { killSandboxProcesses, runCommand, type CommandResult } from './sandbox.js';

const log = (level: 'info' | 'warn' | 'error', message: string, extra: Record<string, unknown> = {}) =>
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, message, ...extra }) + '\n');

export interface ResultBody {
  status: Evidence['status'];
  results: CommandResult[];
  evidence: string;
  evidenceHash: string;
  evidenceSignature: string;
  error?: string;
}

/**
 * One test run: verified checkout of the exact commit, every approved command as the sandbox user,
 * evidence signed with the runner key. Never reports anything better than the observed exit codes.
 */
export async function runJob(job: TestRunJob, config: RunnerConfig): Promise<ResultBody> {
  const startedAt = new Date().toISOString();
  const jobDir = join(config.workDir, job.validation.id);
  const commands = job.validation.commands;
  const results: CommandResult[] = [];
  let treeSha: string | null = null;
  let error: string | null = null;
  await cleanup(jobDir, config);
  await mkdir(jobDir, { recursive: true, mode: 0o755 });
  try {
    const checkout = await prepareCheckout(job, config, jobDir);
    treeSha = checkout.treeSha;
    for (const command of commands) {
      const result = await runCommand(command, {
        cwd: checkout.dir,
        home: checkout.home,
        uid: config.sandboxUid,
        gid: config.sandboxGid,
        env: { BASE_SHA: job.baseSha, HEAD_SHA: job.commitSha, TASK_ID: job.task.id, PROJECT_ID: job.validation.projectId },
        maxOutputBytes: config.maxOutputBytes,
      });
      await killSandboxProcesses(config.sandboxUid);
      results.push(result);
    }
  } catch (e) {
    error = e instanceof CheckoutError ? `checkout: ${e.message}` : `runner error: ${(e as Error).message.slice(0, 500)}`;
  } finally {
    await cleanup(jobDir, config);
  }
  const status = error ? 'aborted' : overallStatus(commands, results);
  const evidence: Evidence = {
    format: 'personal-ai-test-evidence/v1',
    validationId: job.validation.id,
    taskId: job.task.id,
    projectId: job.validation.projectId,
    agent: job.task.agent,
    baseSha: job.baseSha,
    commitSha: job.commitSha,
    treeSha,
    commands,
    results,
    status,
    error,
    runner: { id: config.runnerId, sandboxUid: config.sandboxUid, network: 'controller-only' },
    startedAt,
    completedAt: new Date().toISOString(),
  };
  return { status, results, ...seal(evidence, config.evidenceKey), ...(error ? { error } : {}) };
}

/** Removes a job directory: the sandbox user deletes what it owns, then the runner the rest. */
async function cleanup(jobDir: string, config: RunnerConfig): Promise<void> {
  await killSandboxProcesses(config.sandboxUid);
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    await new Promise<void>((resolve) => {
      const child = spawn('sh', ['-c', 'chmod -R u+rwX -- "$1" 2>/dev/null; rm -rf -- "$1"/src "$1"/home 2>/dev/null; true', 'cleanup', jobDir], {
        uid: config.sandboxUid, gid: config.sandboxGid, stdio: 'ignore', env: { PATH: '/usr/bin:/bin' },
      });
      child.once('close', () => resolve());
      child.once('error', () => resolve());
    });
  }
  await rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
}

async function post(config: RunnerConfig, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(config.controllerUrl + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`controller answered ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function main(): Promise<void> {
  let config: RunnerConfig;
  try {
    config = loadConfig();
  } catch (error) {
    log('error', error instanceof ConfigError ? error.message : String(error));
    process.exit(2);
  }
  await mkdir(config.workDir, { recursive: true });
  log('info', 'test runner started', { sandboxUid: config.sandboxUid });
  const stop = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => stop.abort());
  let failures = 0;
  while (!stop.signal.aborted) {
    await writeFile(join(config.workDir, 'heartbeat'), new Date().toISOString()).catch(() => undefined);
    try {
      const { job } = (await post(config, '/internal/test-runner/claim', {})) as { job: TestRunJob | null };
      failures = 0;
      if (job) {
        log('info', 'test run started', { validationId: job.validation.id, taskId: job.task.id, commit: job.commitSha });
        const body = await runJob(job, config);
        await post(config, `/internal/test-runner/validations/${job.validation.id}/result`, body);
        log('info', 'test run finished', { validationId: job.validation.id, status: body.status, exitCodes: body.results.map((r) => r.exitCode) });
        continue;
      }
    } catch (error) {
      failures++;
      if (failures === 1 || failures % 20 === 0) log('warn', 'controller not available', { error: (error as Error).message });
    }
    await sleep(Math.min(config.pollIntervalMs * Math.max(1, failures), 60_000), undefined, { signal: stop.signal }).catch(() => undefined);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
