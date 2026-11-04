#!/usr/bin/env node
// Applies (or checks) the Hermes settings of the Personal AI OS integration, in data/hermes:
//
//   node services/hermes-integration/scripts/configure-hermes.mjs           # apply what is missing
//   node services/hermes-integration/scripts/configure-hermes.mjs --check   # report only, exit 1 if not applied
//
// config.yaml
//   skills.external_dirs   + /opt/personal-ai/skills              (read-only skill mount, compose.yaml)
//   skills.disabled        + claude-code, codex, opencode          (bundled skills that run coding CLIs in Hermes)
//   plugins.enabled        + personal-ai-controller                (personal_ai_task tool + pre_tool_call guard)
//   platform_toolsets      telegram / cli / cron without terminal, code_execution, file, computer_use and
//                          delegation: Hermes delegates coding through personal_ai_task instead of doing it.
//                          The previous value is kept as a comment next to each line.
// SOUL.md                  "Personal AI OS role" section = hermes-config/SOUL.personal-ai.md
//
// Idempotent; changes nothing else; backs files up to data/hermes/backups/ before writing.
// Recreate Hermes afterwards so the gateway reloads them.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const hermesHome = process.env.HERMES_DATA_DIR ?? join(repoRoot, 'data', 'hermes');
const check = process.argv.includes('--check');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

const SKILLS_DIR = '/opt/personal-ai/skills';
const DISABLED_SKILLS = ['claude-code', 'codex', 'opencode'];
const PLUGIN = 'personal-ai-controller';
// Everything Hermes needs as a manager: chat, memory, web, vision/tts, skills, cron. No shell, no files.
const MANAGER_TOOLSETS = ['browser', 'clarify', 'connections', 'cronjob', 'image_gen', 'memory', 'session_search', 'skills', 'todo', 'tts', 'vision', 'web'];
const PLATFORM_TOOLSETS = {
  cli: [...MANAGER_TOOLSETS, 'x_search'],
  telegram: MANAGER_TOOLSETS,
  cron: MANAGER_TOOLSETS,
};
const SOUL_HEADING = '## Personal AI OS role';
const SOUL_SECTION = readFileSync(new URL('../hermes-config/SOUL.personal-ai.md', import.meta.url), 'utf8').trim();

let missing = 0;
const report = (ok, what) => {
  if (!ok) missing++;
  console.log(`${ok ? 'ok     ' : check ? 'MISSING' : 'applied'} ${what}`);
};
const backup = (file) => copyFileSync(file, join(hermesHome, 'backups', `${file.split(/[\\/]/).pop()}.bak-${stamp}`));

/** Top-level `name:` block: [start, end) offsets of its indented body. */
function block(text, name) {
  const match = new RegExp(`^${name}:[ \\t]*(?:#.*)?\\n`, 'm').exec(text);
  if (!match) throw new Error(`config.yaml has no top-level "${name}:" section`);
  const start = match.index + match[0].length;
  const rest = text.slice(start);
  const end = /^\S/m.exec(rest);
  return { start, end: start + (end ? end.index : rest.length) };
}

/** Ensures `  <key>:` under the block lists `value`. Adds the key if absent; refuses to rewrite an existing list. */
function ensureListItem(text, blockName, key, values) {
  const b = block(text, blockName);
  const body = text.slice(b.start, b.end);
  const keyMatch = new RegExp(`^  ${key}:[ \\t]*\\n((?:    - .*\\n)*)`, 'm').exec(body);
  if (keyMatch) {
    const present = [...keyMatch[1].matchAll(/^    - (.+?)\s*$/gm)].map((m) => m[1]);
    const absent = values.filter((v) => !present.includes(v));
    if (absent.length === 0) return { text, ok: true };
    const insertAt = b.start + keyMatch.index + keyMatch[0].length;
    return { text: text.slice(0, insertAt) + absent.map((v) => `    - ${v}\n`).join('') + text.slice(insertAt), ok: false };
  }
  if (new RegExp(`^  ${key}:`, 'm').test(body)) throw new Error(`${blockName}.${key} is not a block list; edit it by hand`);
  const insertAt = b.start + body.trimEnd().length + 1;
  const addition = `  # Personal AI OS (services/hermes-integration/scripts/configure-hermes.mjs)\n  ${key}:\n${values.map((v) => `    - ${v}\n`).join('')}`;
  return { text: text.slice(0, insertAt) + addition + text.slice(insertAt), ok: false };
}

/** Sets `  <platform>: [..]` (flow list) under platform_toolsets, keeping the old value as a comment. */
function ensureToolsets(text, platform, toolsets) {
  const b = block(text, 'platform_toolsets');
  const body = text.slice(b.start, b.end);
  const wanted = `[${toolsets.join(', ')}]`;
  const line = new RegExp(`^  ${platform}:[ \\t]*(.*)$`, 'm').exec(body);
  if (line && line[1].replace(/\s+#.*$/, '').trim() === wanted) return { text, ok: true };
  const comment = `  # ${platform} before Personal AI OS: ${line ? line[1].trim() : '(platform default)'}\n`;
  const replacement = `${comment}  ${platform}: ${wanted}`;
  if (line) {
    const at = b.start + line.index;
    return { text: text.slice(0, at) + replacement + text.slice(at + line[0].length), ok: false };
  }
  const insertAt = b.start + body.trimEnd().length + 1;
  return { text: `${text.slice(0, insertAt)}${replacement}\n${text.slice(insertAt)}`, ok: false };
}

// ---- config.yaml ---------------------------------------------------------------------------
const configFile = join(hermesHome, 'config.yaml');
const original = readFileSync(configFile, 'utf8');
let config = original;
for (const [blockName, key, values, label] of [
  ['skills', 'external_dirs', [SKILLS_DIR], `skills.external_dirs contains ${SKILLS_DIR}`],
  ['skills', 'disabled', DISABLED_SKILLS, `skills.disabled contains ${DISABLED_SKILLS.join(', ')}`],
  ['plugins', 'enabled', [PLUGIN], `plugins.enabled contains ${PLUGIN}`],
]) {
  const result = ensureListItem(config, blockName, key, values);
  config = result.text;
  report(result.ok, `config.yaml ${label}`);
}
for (const [platform, toolsets] of Object.entries(PLATFORM_TOOLSETS)) {
  const result = ensureToolsets(config, platform, toolsets);
  config = result.text;
  report(result.ok, `config.yaml platform_toolsets.${platform} = manager toolsets (no terminal/file/code/delegation)`);
}
if (config !== original && !check) {
  backup(configFile);
  writeFileSync(configFile, config);
}

// ---- SOUL.md -------------------------------------------------------------------------------
const soulFile = join(hermesHome, 'SOUL.md');
const soul = existsSync(soulFile) ? readFileSync(soulFile, 'utf8') : '';
const at = soul.indexOf(SOUL_HEADING);
let current = null;
if (at >= 0) {
  const next = soul.indexOf('\n## ', at + SOUL_HEADING.length);
  current = soul.slice(at, next < 0 ? soul.length : next).trim();
}
report(current === SOUL_SECTION, 'SOUL.md "Personal AI OS role" section is current');
if (current !== SOUL_SECTION && !check) {
  let updated;
  if (at >= 0) {
    const next = soul.indexOf('\n## ', at + SOUL_HEADING.length);
    updated = `${soul.slice(0, at)}${SOUL_SECTION}\n${next < 0 ? '' : soul.slice(next)}`;
  } else {
    updated = soul ? `${soul.trimEnd()}\n\n${SOUL_SECTION}\n` : `${SOUL_SECTION}\n`;
  }
  if (existsSync(soulFile)) backup(soulFile);
  writeFileSync(soulFile, updated);
}

process.exitCode = check && missing ? 1 : 0;
