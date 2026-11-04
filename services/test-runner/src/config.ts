export interface RunnerConfig {
  controllerUrl: string;
  /** Test-runner token. Read from the environment once, then removed from process.env. */
  token: string;
  /** HMAC key for evidence (shared only with the GitHub Publisher). Removed from process.env too. */
  evidenceKey: Buffer;
  artifactRoots: Record<string, string>;
  exportRoot: string;
  workDir: string;
  /** Unprivileged user the test commands run as (never the runner's own user). */
  sandboxUid: number;
  sandboxGid: number;
  maxOutputBytes: number;
  maxBundleBytes: number;
  pollIntervalMs: number;
  runnerId: string;
}

export class ConfigError extends Error {}

/**
 * Loads the configuration and scrubs secrets from process.env, so nothing the runner spawns can
 * inherit them even by accident (commands get an explicit, minimal environment anyway).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const problems: string[] = [];
  const controllerUrl = (env.CONTROLLER_URL ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+/.test(controllerUrl)) problems.push('CONTROLLER_URL must be an http(s) URL');
  const token = (env.TEST_RUNNER_CONTROLLER_TOKEN ?? '').trim();
  if (token.length < 32) problems.push('TEST_RUNNER_CONTROLLER_TOKEN is required');
  const keyHex = (env.TEST_EVIDENCE_KEY ?? '').trim();
  if (!/^[0-9a-f]{64}$/.test(keyHex)) problems.push('TEST_EVIDENCE_KEY must be 64 hex characters');
  delete env.TEST_RUNNER_CONTROLLER_TOKEN;
  delete env.TEST_EVIDENCE_KEY;

  const artifactRoots: Record<string, string> = {};
  for (const entry of (env.TEST_RUNNER_ARTIFACT_ROOTS ?? 'claude=/artifacts/claude,codex=/artifacts/codex').split(',')) {
    const [agent, path] = entry.split('=').map((s) => s?.trim());
    if (!agent || !path || !/^[a-z]+$/.test(agent) || !path.startsWith('/')) {
      problems.push('TEST_RUNNER_ARTIFACT_ROOTS must look like claude=/artifacts/claude,codex=/artifacts/codex');
      continue;
    }
    artifactRoots[agent] = path;
  }
  const int = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name]?.trim();
    const value = raw ? Number(raw) : fallback;
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return value;
  };
  const sandboxUid = int('TEST_RUNNER_SANDBOX_UID', 10001, 1000, 65534);
  const sandboxGid = int('TEST_RUNNER_SANDBOX_GID', 10001, 1000, 65534);
  if (sandboxUid === 1000) problems.push('TEST_RUNNER_SANDBOX_UID must not be 1000 (the uid that owns artifacts and exports)');

  if (problems.length) throw new ConfigError(`Invalid test runner configuration:\n - ${problems.join('\n - ')}`);
  return {
    controllerUrl,
    token,
    evidenceKey: Buffer.from(keyHex, 'hex'),
    artifactRoots,
    exportRoot: env.TEST_RUNNER_EXPORT_ROOT?.trim() || '/repo-exports',
    workDir: env.TEST_RUNNER_WORK_DIR?.trim() || '/work',
    sandboxUid,
    sandboxGid,
    maxOutputBytes: int('TEST_RUNNER_MAX_OUTPUT_BYTES', 1024 * 1024, 1024, 64 * 1024 * 1024),
    maxBundleBytes: int('TEST_RUNNER_MAX_BUNDLE_BYTES', 256 * 1024 * 1024, 1024, 2 ** 31),
    pollIntervalMs: int('TEST_RUNNER_POLL_SECONDS', 5, 1, 3600) * 1000,
    runnerId: 'test-runner',
  };
}
