export type PublisherMode = 'dry-run';
/** disabled: never pushes (default). mock: records what would be pushed (tests). github: not allowed in E-2B. */
export type PublishBackend = 'disabled' | 'mock' | 'github';

export interface GitHubAppConfig {
  appId: string;
  installationId: number;
  /** PEM private key (Docker secret). Read when a token is needed, never logged. */
  privateKeyFile: string;
}

export interface PublisherConfig {
  mode: PublisherMode;
  controllerUrl: string;
  /** Publisher token for the controller (Docker secret); read per request, never logged. */
  tokenFile: string;
  /** owner/repo (lower case) the publisher may ever target. Anything else is blocked. */
  allowedRepositories: string[];
  /** Read-only artifact volume per agent: <root>/<taskId>.bundle + <taskId>.json */
  artifactRoots: Record<string, string>;
  /** Read-only repo-sync export with the trusted copies: <root>/<projectId>.git */
  exportRoot: string;
  /** Scratch space for verification repositories (tmpfs). */
  workDir: string;
  /** Persistent journal of every run and the GitHub audit log (volume). */
  stateDir: string;
  githubApiUrl: string;
  branchPrefix: string;
  /** POLICY A (fixed): a commit without a passed, signed test run of exactly that commit is never published. */
  requireReportedTests: true;
  /** POLICY B (owner decision 2026-11-24): only commits made as the project's commit author (the owner), with no agent trace. */
  commitAuthorPolicy: 'owner';
  /** HMAC key the test runner signs evidence with (Docker secret). */
  testEvidenceKeyFile: string;
  githubApp: GitHubAppConfig | null;
  publishBackend: PublishBackend;
  /** Where pushes go (https://github.com; a local server in tests). */
  gitBaseUrl: string;
  maxBundleBytes: number;
  pollIntervalMs: number;
}

export class ConfigError extends Error {}

const REPO = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PublisherConfig {
  const problems: string[] = [];

  const mode = (env.PUBLISHER_MODE ?? 'dry-run').trim();
  if (mode !== 'dry-run') problems.push(`PUBLISHER_MODE=${mode} is not available; real publishing is controlled by PUBLISHER_PUBLISH_BACKEND`);
  // The user's policies are fixed; a configuration that tries to relax them does not start.
  const tests = (env.PUBLISHER_REQUIRE_REPORTED_TESTS ?? 'true').trim();
  if (tests !== 'true') problems.push('PUBLISHER_REQUIRE_REPORTED_TESTS must be true (POLICY A is fixed)');
  const author = (env.PUBLISHER_COMMIT_AUTHOR_POLICY ?? 'owner').trim();
  if (author !== 'owner') problems.push('PUBLISHER_COMMIT_AUTHOR_POLICY must be owner (POLICY B: commits are published only as the owner)');
  // Personal access tokens are never used for publishing; only a GitHub App installation token.
  for (const name of ['GITHUB_TOKEN', 'PUBLISHER_GITHUB_TOKEN', 'GH_TOKEN']) {
    if (env[name]) problems.push(`${name} is set: the publisher only uses GitHub App installation tokens`);
  }

  const backend = (env.PUBLISHER_PUBLISH_BACKEND ?? 'disabled').trim();
  if (backend !== 'disabled' && backend !== 'mock' && backend !== 'github') problems.push('PUBLISHER_PUBLISH_BACKEND must be disabled, mock or github');

  let githubApp: GitHubAppConfig | null = null;
  const appId = env.PUBLISHER_GITHUB_APP_ID?.trim();
  const installation = env.PUBLISHER_GITHUB_APP_INSTALLATION_ID?.trim();
  const keyFile = env.PUBLISHER_GITHUB_APP_KEY_FILE?.trim();
  if (appId || installation || keyFile) {
    if (!appId || !/^\d+$/.test(appId)) problems.push('PUBLISHER_GITHUB_APP_ID must be the numeric App id');
    if (!installation || !/^\d+$/.test(installation)) problems.push('PUBLISHER_GITHUB_APP_INSTALLATION_ID must be numeric');
    if (!keyFile || !keyFile.startsWith('/')) problems.push('PUBLISHER_GITHUB_APP_KEY_FILE must be an absolute path (Docker secret)');
    if (appId && installation && keyFile) githubApp = { appId, installationId: Number(installation), privateKeyFile: keyFile };
  }

  const controllerUrl = (env.CONTROLLER_URL ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+/.test(controllerUrl)) problems.push('CONTROLLER_URL must be an http(s) URL');

  const allowedRepositories = (env.PUBLISHER_ALLOWED_REPOSITORIES ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const repo of allowedRepositories) if (!REPO.test(repo)) problems.push(`PUBLISHER_ALLOWED_REPOSITORIES entry "${repo}" is not owner/repo`);

  const artifactRoots: Record<string, string> = {};
  for (const entry of (env.PUBLISHER_ARTIFACT_ROOTS ?? 'claude=/artifacts/claude,codex=/artifacts/codex').split(',')) {
    const [agent, path] = entry.split('=').map((s) => s?.trim());
    if (!agent || !path || !/^[a-z]+$/.test(agent) || !path.startsWith('/')) {
      problems.push('PUBLISHER_ARTIFACT_ROOTS must look like claude=/artifacts/claude,codex=/artifacts/codex');
      continue;
    }
    artifactRoots[agent] = path;
  }

  const number = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name]?.trim();
    const value = raw ? Number(raw) : fallback;
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return value;
  };
  const pollSeconds = number('PUBLISHER_POLL_SECONDS', 5, 1, 3600);
  const maxBundleBytes = number('PUBLISHER_MAX_BUNDLE_BYTES', 256 * 1024 * 1024, 1024, 4 * 1024 ** 3);

  const branchPrefix = (env.PUBLISHER_BRANCH_PREFIX ?? 'personal-ai/').trim();
  if (!/^[a-z0-9][a-z0-9-]*\/$/.test(branchPrefix)) problems.push('PUBLISHER_BRANCH_PREFIX must look like "personal-ai/"');

  if (backend === 'github' && !githubApp) problems.push('PUBLISHER_PUBLISH_BACKEND=github needs the GitHub App (PUBLISHER_GITHUB_APP_ID, _INSTALLATION_ID, _KEY_FILE)');

  if (problems.length) throw new ConfigError(`Invalid publisher configuration:\n - ${problems.join('\n - ')}`);
  return {
    mode: 'dry-run',
    controllerUrl,
    tokenFile: env.PUBLISHER_TOKEN_FILE?.trim() || '/run/secrets/controller_token',
    allowedRepositories,
    artifactRoots,
    exportRoot: env.PUBLISHER_EXPORT_ROOT?.trim() || '/repo-exports',
    workDir: env.PUBLISHER_WORK_DIR?.trim() || '/tmp/publisher',
    stateDir: env.PUBLISHER_STATE_DIR?.trim() || '/var/lib/publisher',
    githubApiUrl: (env.GITHUB_API_URL?.trim() || 'https://api.github.com').replace(/\/+$/, ''),
    branchPrefix,
    requireReportedTests: true,
    commitAuthorPolicy: 'owner',
    testEvidenceKeyFile: env.PUBLISHER_TEST_EVIDENCE_KEY_FILE?.trim() || '/run/secrets/test_evidence_key',
    githubApp,
    publishBackend: backend === 'mock' ? 'mock' : backend === 'github' ? 'github' : 'disabled',
    gitBaseUrl: (env.PUBLISHER_GIT_BASE_URL?.trim() || 'https://github.com').replace(/\/+$/, ''),
    maxBundleBytes,
    pollIntervalMs: pollSeconds * 1000,
  };
}
