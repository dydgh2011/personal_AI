import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/configure-hermes.mjs', import.meta.url));
const role = readFileSync(new URL('../hermes-config/SOUL.personal-ai.md', import.meta.url), 'utf8');
const manager = 'browser, clarify, connections, cronjob, image_gen, memory, session_search, skills, todo, tts, vision, web';
const discord = 'web, "vision", todo, skills, session_search, memory, cronjob, clarify';
const config = [
  'skills:',
  '  external_dirs:',
  '    - /opt/personal-ai/skills',
  '  disabled:',
  '    - claude-code',
  '    - codex',
  '    - opencode',
  'plugins:',
  '  enabled:',
  '    - personal-ai-controller',
  'platform_toolsets:',
  `  cli: [${manager}, x_search]`,
  `  telegram: [${manager}]`,
  `  cron: [${manager}]`,
  `  discord: [${discord}] # trimmed for Kelly`,
  'ignored_record: synthetic-confidential-fixture',
  '',
].join('\r\n');

function runCheck(t, contents, soul = role) {
  const home = mkdtempSync(join(tmpdir(), 'hermes-config-check-'));
  const configFile = join(home, 'config.yaml');
  const soulFile = join(home, 'SOUL.md');
  writeFileSync(configFile, contents);
  writeFileSync(soulFile, soul);
  t.after(() => {
    unlinkSync(configFile);
    unlinkSync(soulFile);
    rmdirSync(home);
  });

  const result = spawnSync(process.execPath, [script, '--check'], {
    env: { ...process.env, HERMES_DATA_DIR: home },
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(readFileSync(configFile, 'utf8'), contents);
  assert.equal(readFileSync(soulFile, 'utf8'), soul);
  assert.deepEqual(readdirSync(home).sort(), ['SOUL.md', 'config.yaml'].sort());
  assert.ok(!(result.stdout + result.stderr).includes('synthetic-confidential-fixture'));
  return result;
}

test('integrity check accepts the managed Discord list and Windows line endings', (t) => {
  const result = runCheck(t, config);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ok\s+config\.yaml platform_toolsets\.discord/);
});

test('integrity check detects Discord tool changes and role drift without writing files', (t) => {
  const changed = config.replace(discord, `${discord}, terminal`);
  const result = runCheck(t, changed, '## Personal AI OS role\nAltered role\n');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /MISSING config\.yaml platform_toolsets\.discord/);
  assert.match(result.stdout, /MISSING SOUL\.md/);
});

test('integrity check fails if a second platform block shadows the managed settings', (t) => {
  const result = runCheck(t, config + 'platform_toolsets:\r\n  discord: [terminal]\r\n');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /repeated "platform_toolsets" keys/);
});
