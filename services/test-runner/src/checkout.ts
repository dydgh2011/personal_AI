import { createHash } from 'node:crypto';
import { chown, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { RunnerConfig } from './config.js';
import { git } from './git.js';

export interface TestRunJob {
  validation: { id: string; taskId: string; projectId: string; commands: Array<{ name: string; argv: string[]; timeoutSeconds: number }> };
  task: { id: string; agent: string; projectId: string; status: string };
  baseSha: string;
  commitSha: string;
  headTree: string | null;
}

export class CheckoutError extends Error {}

export interface Checkout {
  dir: string;
  home: string;
  treeSha: string;
}

/**
 * Materializes exactly the commit under test, from the worker's bundle and the trusted repo-sync
 * copy (the same sources the publisher verifies), as a plain working tree owned by the sandbox user.
 * The checkout carries only this project's objects (copied in, no alternates left behind), so a test
 * cannot read other repositories through it.
 */
export async function prepareCheckout(job: TestRunJob, config: RunnerConfig, jobDir: string): Promise<Checkout> {
  const { taskId, projectId } = job.validation;
  const agent = job.task.agent;
  const root = config.artifactRoots[agent];
  if (!root) throw new CheckoutError(`no artifact location for agent ${agent}`);
  const runnerHome = join(jobDir, 'runner-home');
  await mkdir(runnerHome, { recursive: true });

  // artifact: manifest must describe this exact commit; bundle copied out and checksummed
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(await readFile(join(root, `${taskId}.json`), 'utf8'));
  } catch {
    throw new CheckoutError(`artifact missing for task ${taskId}`);
  }
  const expected: Record<string, unknown> = {
    format: 'personal-ai-artifact/v1', taskId, agent, projectId, branch: `${agent}/task-${taskId}`, baseSha: job.baseSha, headSha: job.commitSha,
  };
  const mismatch = Object.keys(expected).filter((k) => manifest[k] !== expected[k]);
  if (mismatch.length) throw new CheckoutError(`artifact manifest does not describe this commit (${mismatch.join(', ')})`);
  const bundle = join(jobDir, 'artifact.bundle');
  const source = await realpath(join(root, `${taskId}.bundle`)).catch(() => null);
  if (!source || !source.startsWith((await realpath(root)) + sep)) throw new CheckoutError('bundle missing');
  if ((await stat(source)).size > config.maxBundleBytes) throw new CheckoutError('bundle too large');
  // Plain read + write: copyFile also carries over the source's owner and mode, which the runner
  // (root without CAP_FOWNER/CAP_DAC_OVERRIDE) is not allowed to do for files of another uid.
  await writeFile(bundle, await readFile(source), { mode: 0o600 });
  if (createHash('sha256').update(await readFile(bundle)).digest('hex') !== manifest.bundleSha256) {
    throw new CheckoutError('bundle checksum does not match its manifest');
  }

  const trusted = await realpath(join(config.exportRoot, `${projectId}.git`)).catch(() => null);
  if (!trusted || !trusted.startsWith((await realpath(config.exportRoot)) + sep)) throw new CheckoutError(`no trusted copy of ${projectId}`);

  const dir = join(jobDir, 'src');
  await mkdir(dir);
  await git(['init', '-q', dir], jobDir, runnerHome);
  for (const [k, v] of [['core.hooksPath', '/dev/null'], ['core.symlinks', 'false'], ['transfer.fsckObjects', 'true'], ['fetch.fsckObjects', 'true'], ['gc.auto', '0'], ['submodule.recurse', 'false']]) {
    await git(['config', k, v], dir, runnerHome);
  }
  const alternates = join(dir, '.git', 'objects', 'info', 'alternates');
  await writeFile(alternates, `${join(trusted, 'objects')}\n`);
  try {
    await git(['bundle', 'verify', bundle], dir, runnerHome);
  } catch {
    throw new CheckoutError('bundle does not apply to the trusted repository (missing base or foreign objects)');
  }
  const ref = `refs/heads/${agent}/task-${taskId}`;
  await git(['fetch', '-q', '--no-tags', bundle, `${ref}:refs/heads/under-test`], dir, runnerHome);
  const head = (await git(['rev-parse', '--verify', 'refs/heads/under-test^{commit}'], dir, runnerHome)).trim();
  if (head !== job.commitSha) throw new CheckoutError(`bundle holds ${head}, not ${job.commitSha}`);
  const treeSha = (await git(['rev-parse', `${head}^{tree}`], dir, runnerHome)).trim();
  if (job.headTree && treeSha !== job.headTree) throw new CheckoutError(`tree ${treeSha} is not the reviewed ${job.headTree}`);
  if (!(await git(['merge-base', '--is-ancestor', job.baseSha, head], dir, runnerHome).then(() => true, () => false))) {
    throw new CheckoutError('base is not an ancestor of the commit under test');
  }
  await git(['checkout', '-q', '--detach', head], dir, runnerHome);
  // Copy the needed objects in and drop the link to the shared export.
  await git(['repack', '-a', '-d', '-q'], dir, runnerHome);
  await rm(alternates, { force: true });
  await git(['fsck', '--connectivity-only', '--no-dangling'], dir, runnerHome);
  await rm(bundle, { force: true });

  const home = join(jobDir, 'home');
  await mkdir(home);
  await chownTree(dir, config.sandboxUid, config.sandboxGid);
  await chown(home, config.sandboxUid, config.sandboxGid);
  return { dir, home, treeSha };
}

async function chownTree(path: string, uid: number, gid: number): Promise<void> {
  await chown(path, uid, gid);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) await chownTree(full, uid, gid);
    else await chown(full, uid, gid).catch(() => undefined);
  }
}
