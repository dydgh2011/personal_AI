import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runProcess, TRUNCATION_MARKER, type RunOptions } from './process-runner.js';
import { tempDir, waitFor } from './testing/helpers.js';

const node = process.execPath;
const opts = (overrides: Partial<RunOptions> = {}): RunOptions => ({
  cwd: process.cwd(),
  env: process.env,
  timeoutMs: 10_000,
  maxStdoutBytes: 1024 * 1024,
  maxStderrBytes: 1024 * 1024,
  killGraceMs: 500,
  ...overrides,
});

describe('runProcess', () => {
  it('passes stdin, closes it, and collects output and exit code', async () => {
    const script = 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(s.toUpperCase());process.stderr.write("err");process.exit(3)})';
    const result = await runProcess(node, ['-e', script], opts({ stdin: 'hello' }));
    assert.equal(result.stdout, 'HELLO');
    assert.equal(result.stderr, 'err');
    assert.equal(result.exitCode, 3);
    assert.equal(result.timedOut, false);
  });

  it('does not interpret arguments through a shell', async () => {
    const result = await runProcess(node, ['-e', 'console.log(process.argv[1])', '$(whoami); echo pwned'], opts());
    assert.equal(result.stdout.trim(), '$(whoami); echo pwned');
  });

  it('caps collected output, keeping the beginning and the end', async () => {
    const script = 'process.stdout.write("HEAD" + "x".repeat(100000)); setTimeout(() => process.stdout.write("END"), 50)';
    const result = await runProcess(node, ['-e', script], opts({ maxStdoutBytes: 1000 }));
    assert.equal(result.stdout.length, 1000 + TRUNCATION_MARKER.length);
    assert.ok(result.stdout.startsWith('HEAD'));
    assert.ok(result.stdout.endsWith('END'));
    assert.ok(result.stdout.includes(TRUNCATION_MARKER));
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.exitCode, 0);
  });

  it('keeps output under the limit unchanged', async () => {
    const result = await runProcess(node, ['-e', 'process.stdout.write("a".repeat(999))'], opts({ maxStdoutBytes: 1000 }));
    assert.equal(result.stdout, 'a'.repeat(999));
    assert.equal(result.stdoutTruncated, false);
  });

  it('kills a process that exceeds its timeout', async () => {
    const result = await runProcess(node, ['-e', 'setTimeout(()=>{}, 60000)'], opts({ timeoutMs: 200 }));
    assert.equal(result.timedOut, true);
    assert.ok(result.durationMs < 5000);
  });

  it('stops on abort', async () => {
    const control = new AbortController();
    setTimeout(() => control.abort(), 100);
    const result = await runProcess(node, ['-e', 'setTimeout(()=>{}, 60000)'], opts({ signal: control.signal }));
    assert.equal(result.aborted, true);
    assert.ok(result.durationMs < 5000);
  });

  it('reports a missing executable instead of throwing', async () => {
    const result = await runProcess('definitely-not-a-real-binary-xyz', [], opts());
    assert.equal(result.exitCode, null);
    assert.match(result.spawnError ?? '', /ENOENT/);
  });

  it('escalates to SIGKILL and kills the whole process group', { skip: process.platform === 'win32' }, async () => {
    const dir = await tempDir('runner-');
    try {
      const pidFile = join(dir.path, 'grandchild.pid');
      const script = `
        process.on('SIGTERM', () => {});
        const c = require('child_process').spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setTimeout(()=>{},60000)'], { stdio: 'ignore' });
        require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
        setTimeout(()=>{}, 60000);`;
      const control = new AbortController();
      const running = runProcess(node, ['-e', script], opts({ signal: control.signal, killGraceMs: 300 }));
      await waitFor(async () => (await readFile(pidFile, 'utf8').catch(() => '')) !== '', 5000, 'grandchild pid');
      control.abort();
      const result = await running;
      assert.equal(result.signal, 'SIGKILL');
      const grandchild = Number(await readFile(pidFile, 'utf8'));
      await waitFor(() => {
        try {
          process.kill(grandchild, 0);
          return false;
        } catch {
          return true;
        }
      }, 5000, 'grandchild to exit');
    } finally {
      await dir.cleanup();
    }
  });
});
