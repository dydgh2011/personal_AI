// Checks the Codex sandbox inside the running codex-worker container without calling a model.
//
//   docker exec -i personal_ai-codex-worker-1 node - < services/worker/scripts/codex-sandbox-probe.mjs
//
// Takes the exact -c/--disable arguments CodexRunner passes to `codex exec`, applies them with
// `codex sandbox` to a throwaway worktree under /tmp, and runs escape attempts inside it.
// Prints one line per check and never prints file contents. Exit code = number of failed checks.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { CodexRunner, PERMISSION_PROFILE } from '/opt/agent-worker/runners/codex-runner.js';

const root = mkdtempSync('/tmp/codex-probe-');
const repo = join(root, 'sandbox');
const worktree = join(root, '.worktrees', 'probe');
const sh = (script) => execFileSync('sh', ['-c', script], { encoding: 'utf8' });
sh(`git init -q -b main ${repo} && git -C ${repo} -c user.name=p -c user.email=p@p commit -q --allow-empty -m init && git -C ${repo} worktree add -q -b codex/task-probe ${worktree}`);
symlinkSync('/home/node/.codex', join(worktree, 'link-codex-home'));
symlinkSync(repo, join(worktree, 'link-main-checkout'));

function sandboxArgs(mode) {
  const { args } = new CodexRunner(['codex']).buildInvocation({ taskId: 'probe', instruction: '', cwd: worktree, mode });
  const passed = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' || args[i] === '--disable') passed.push(args[i], args[i + 1]);
  }
  return [...passed, '-P', PERMISSION_PROFILE, '-C', worktree];
}

// Each probe exits 0 when the action succeeded inside the sandbox.
const probes = {
  write_task_worktree: 'echo ok > "inside-$PROBE_MODE.txt"',
  write_tmp: 'echo x > /tmp/codex-probe-escape.txt',
  write_main_checkout: `echo x > ${repo}/escape.txt`,
  write_git_metadata: `echo x >> ${repo}/.git/config`,
  write_real_workspace: 'echo x > /workspace/codex-probe-escape.txt',
  write_home: 'echo x > /home/node/codex-probe-escape.txt',
  write_via_symlink_home: 'echo x > link-codex-home/codex-probe-escape.txt',
  write_via_symlink_main: 'echo x > link-main-checkout/escape2.txt',
  read_codex_auth: 'cat /home/node/.codex/auth.json',
  read_codex_auth_via_symlink: 'cat link-codex-home/auth.json',
  read_worker_state: 'ls /home/node/.agent-worker',
  read_main_checkout: `ls ${repo}`,
  read_real_workspace: 'ls /workspace',
  see_worker_token_env: "grep -qs CONTROLLER_WORKER_TOKEN /proc/[0-9]*/environ",
  // matches the start of argv, so the probe's own shell cannot match itself
  see_worker_process: 'for p in /proc/[0-9]*; do case "$(tr "\\0" " " < $p/cmdline 2>/dev/null)" in "node /opt/agent-worker/main.js"*) exit 0;; esac; done; exit 1',
  network: "node -e \"fetch('https://example.com').then(()=>process.exit(0),()=>process.exit(1))\"",
  run_tools: 'node -e 1 && git --version',
};
// Expected result per mode: true = must succeed, false = must not take effect.
const expected = (mode, name) => (name === 'run_tools' ? true : name === 'write_task_worktree' ? mode === 'write' : false);
// Paths that must not exist on the real filesystem afterwards, whatever the sandbox reported.
const leaks = [
  '/tmp/codex-probe-escape.txt',
  join(repo, 'escape.txt'),
  join(repo, 'escape2.txt'),
  '/workspace/codex-probe-escape.txt',
  '/home/node/codex-probe-escape.txt',
  '/home/node/.codex/codex-probe-escape.txt',
];

let failed = 0;
for (const mode of ['write', 'read']) {
  const script = `PROBE_MODE=${mode}
` + Object.entries(probes)
    .map(([name, cmd]) => `if ( ${cmd} ) >/dev/null 2>&1; then echo "${name}=1"; else echo "${name}=0"; fi`)
    .join('\n');
  const result = spawnSync('codex', ['sandbox', ...sandboxArgs(mode), '--', 'sh', '-c', script], {
    cwd: worktree,
    encoding: 'utf8',
    env: { HOME: process.env.HOME, PATH: process.env.PATH, LANG: 'C.UTF-8' },
  });
  const seen = Object.fromEntries(result.stdout.trim().split('\n').filter(Boolean).map((l) => l.split('=')).map(([k, v]) => [k, v === '1']));
  if (result.status !== 0 || Object.keys(seen).length !== Object.keys(probes).length) {
    console.log(`FAIL [${mode}] codex sandbox did not run the probes (exit ${result.status}): ${result.stderr.trim().slice(-400)}`);
    failed++;
    continue;
  }
  for (const name of Object.keys(probes)) {
    let ok = seen[name] === expected(mode, name);
    let note = seen[name] ? 'succeeded' : 'blocked';
    // Writes to denied paths may "succeed" into the sandbox's private tmpfs; that is fine as long
    // as nothing reaches the real filesystem (checked below).
    if (!ok && name.startsWith('write_') && !(mode === 'write' && name === 'write_task_worktree')) {
      ok = true;
      note = 'succeeded inside the sandbox only (private tmpfs, discarded)';
    }
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'} [${mode}] ${name}: ${note}`);
  }
}
for (const path of leaks) {
  const leaked = existsSync(path);
  if (leaked) failed++;
  console.log(`${leaked ? 'FAIL' : 'PASS'} [fs] ${path} ${leaked ? 'EXISTS on the real filesystem' : 'not created'}`);
}
const inside = existsSync(join(worktree, 'inside-write.txt'));
const readOnly = !existsSync(join(worktree, 'inside-read.txt'));
if (!inside) failed++;
if (!readOnly) failed++;
console.log(`${inside ? 'PASS' : 'FAIL'} [fs] write mode: file written in the task worktree persisted`);
console.log(`${readOnly ? 'PASS' : 'FAIL'} [fs] read mode: ${readOnly ? 'nothing written to the project' : 'file was WRITTEN to the project'}`);

execFileSync('rm', ['-rf', root]);
console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`);
process.exitCode = failed;
