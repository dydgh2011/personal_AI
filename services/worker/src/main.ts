import { AuthManager, claudeBackend, codexBackend } from './auth.js';
import { loadConfig, type WorkerConfig } from './config.js';
import { ControllerClient } from './controller-client.js';
import { createLogger } from './logger.js';
import type { AgentRunner } from './runners/agent-runner.js';
import { ClaudeRunner } from './runners/claude-runner.js';
import { CodexRunner } from './runners/codex-runner.js';
import { InstanceLock, LockError, WorkerState } from './state.js';
import { Worker } from './worker.js';
import { Workspace } from './workspace.js';

function createRunner(config: WorkerConfig): AgentRunner {
  switch (config.agent) {
    case 'claude':
      return new ClaudeRunner(config.agentCommand, config.model);
    case 'codex':
      return new CodexRunner(config.agentCommand, config.model);
  }
}

async function main(): Promise<number> {
  let config: WorkerConfig;
  try {
    config = loadConfig();
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }

  const logger = createLogger({ worker: config.workerId });
  let runner: AgentRunner;
  try {
    runner = createRunner(config);
  } catch (error) {
    logger.error((error as Error).message);
    return 1;
  }

  const client = new ControllerClient(config.controllerUrl, config.token);
  // WORKER_AUTH_GATE=false turns the login gate off (e.g. for fake agents in tests).
  const auth =
    process.env.WORKER_AUTH_GATE?.trim() === 'false'
      ? undefined
      : new AuthManager(
          config.agent,
          config.agent === 'claude' ? claudeBackend(config.agentCommand[0]) : codexBackend(config.agentCommand[0]),
          client,
          logger,
        );
  const worker = new Worker({
    config,
    client,
    auth,
    workspace: new Workspace(config),
    runner,
    state: new WorkerState(config.stateDir),
    lock: new InstanceLock(config.stateDir),
    logger,
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info('Shutdown requested', { signal });
      worker.stop();
    });
  }

  try {
    await worker.run();
    return 0;
  } catch (error) {
    logger.error(error instanceof LockError ? error.message : `Worker failed: ${(error as Error).stack}`);
    return 1;
  }
}

process.exitCode = await main();
