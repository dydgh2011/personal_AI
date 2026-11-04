import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { Workspace } from './workspace.js';

/**
 * Writes (or rewrites) the publisher artifact of a task that already ran, e.g. one completed before
 * artifacts existed. Runs inside the worker container, which holds the task branch:
 *
 *   docker compose exec codex-worker node /opt/agent-worker/export-artifact.js \
 *     --task <taskId> --project <projectId> --base <baseSha>
 *
 * The branch is always <agent>/task-<taskId> in this worker's clone; nothing else can be exported.
 * Prints one JSON object; exit 0 on success, 1 on failure, 2 on bad usage.
 */
async function main(): Promise<number> {
  const print = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  let values;
  try {
    ({ values } = parseArgs({ options: { task: { type: 'string' }, project: { type: 'string' }, base: { type: 'string' } } }));
  } catch (error) {
    print({ ok: false, error: (error as Error).message });
    return 2;
  }
  if (!values.task || !values.project || !values.base) {
    print({ ok: false, error: 'usage: export-artifact --task <taskId> --project <projectId> --base <baseSha>' });
    return 2;
  }
  try {
    const config = loadConfig();
    const workspace = new Workspace(config);
    const repo = workspace.githubRepoPath(values.project);
    const branch = `${config.agent}/task-${values.task}`;
    const head = await workspace.branchHead(repo, branch);
    const manifest = await workspace.exportArtifact(repo, values.task, values.project, branch, values.base, head);
    print({ ok: true, manifest });
    return 0;
  } catch (error) {
    print({ ok: false, error: (error as Error).message });
    return 1;
  }
}

process.exitCode = await main();
