import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, loadConfig } from './config.js';

const base = { CONTROLLER_URL: 'http://controller:3000/', CONTROLLER_WORKER_TOKEN: 't'.repeat(43) };

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const config = loadConfig(base);
    assert.equal(config.agent, 'claude');
    assert.equal(config.workerId, 'claude-worker');
    assert.equal(config.controllerUrl, 'http://controller:3000');
    assert.equal(config.workspaceRoot, '/workspace');
    assert.equal(config.projects, null, 'the registry decides unless WORKER_PROJECTS restricts it');
    assert.equal(config.writableProjects, null);
    assert.equal(config.repoCacheRoot, '/repo-cache');
    assert.deepEqual(loadConfig({ ...base, WORKER_PROJECTS: 'sandbox, docs' }).projects, ['sandbox', 'docs']);
    assert.deepEqual(config.agentCommand, ['claude']);
    assert.equal(config.heartbeatIntervalMs, 30_000);
  });

  it('requires the controller URL and token without echoing the token', () => {
    assert.throws(() => loadConfig({}), ConfigError);
    try {
      loadConfig({ ...base, CONTROLLER_WORKER_TOKEN: 'short-secret' });
      assert.fail('expected error');
    } catch (error) {
      assert.match((error as Error).message, /CONTROLLER_WORKER_TOKEN is required/);
      assert.doesNotMatch((error as Error).message, /short-secret/);
    }
  });

  it('only allows writable projects that are enabled, and rejects path-like ids', () => {
    assert.throws(() => loadConfig({ ...base, WORKER_PROJECTS: 'docs', WORKER_WRITABLE_PROJECTS: 'sandbox' }), /not in WORKER_PROJECTS/);
    assert.throws(() => loadConfig({ ...base, WORKER_PROJECTS: '../etc' }), /invalid project id/);
  });

  it('parses the agent command as a JSON array only', () => {
    assert.deepEqual(loadConfig({ ...base, WORKER_AGENT_COMMAND: '["node","fake.mjs"]' }).agentCommand, ['node', 'fake.mjs']);
    assert.throws(() => loadConfig({ ...base, WORKER_AGENT_COMMAND: 'claude; rm -rf /' }), /JSON array/);
  });
});
