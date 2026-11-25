import type { RegistryProject } from './controller-client.js';

/**
 * Per-project agent settings from the controller's registry (ROADMAP 11, 12): how commit subjects
 * should look, the owner's coding rules, and paths whose changes are never committed.
 *
 * The worker checks everything again (same limits as the controller) and refuses the task if a
 * value is out of bounds: a registry the worker cannot trust is treated like an unreadable one.
 * A controller from before these settings sends none; that means "nothing configured".
 *
 * Commit author (POLICY B, owner decision 2026-11-24): when the project has a commit author, the
 * worker commits as that person (author and committer) and the commit carries no agent trace: no
 * trailers, no worker or task lines, no tool names. Without one, the worker identity is kept and
 * the publisher refuses to publish.
 */

export type CommitStyleMode = 'off' | 'auto' | 'manual';

export interface CommitAuthor {
  name: string;
  email: string;
}

export interface ProjectSettings {
  commitStyle: { mode: CommitStyleMode; guide: string | null };
  /** The owner's git identity for task commits; null = keep the worker identity (not publishable). */
  commitAuthor: CommitAuthor | null;
  rules: string;
  forbiddenPaths: string[];
}

export const LIMITS = { styleGuide: 1000, rules: 4000, forbiddenPaths: 50, forbiddenPath: 200, subject: 100, authorName: 100, authorEmail: 254 } as const;

const EMAIL = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/;

/**
 * Lines and words that would show a commit was made by an AI agent or by this system's workers.
 * Used to clean the agent's proposed subject; the publisher refuses commits that still carry one.
 */
export const AGENT_TRACE: RegExp[] = [
  /co-authored-by\s*:/i,
  /^\s*(signed-off-by|generated-by|assisted-by)\s*:/im,
  /generated\s+(with|by)\s+\[?(claude|chatgpt|codex|openai|anthropic|copilot|an?\s+ai)/i,
  /\bclaude\s+code\b/i,
  /noreply@anthropic\.com|@openai\.com|personal-ai\.local/i,
  /\b(claude|codex)-worker\b/i,
  /\bas an ai\b|\bai[- ]generated\b|\bai coding agent\b/i,
  /\u{1F916}/u,
];

export function hasAgentTrace(text: string): boolean {
  return AGENT_TRACE.some((re) => re.test(text));
}

/** Commit subjects read for the style analysis (newest first, merges skipped). */
export const STYLE_SAMPLE = 50;

const TEXT = /^[^\x00-\x08\x0b-\x1f\x7f]*$/;
const PATH_PATTERN = /^(?!\s)(?!.*\s$)(?!\/)(?!\.\/)(?!.*\/\/)(?!(?:.*\/)?\.{1,2}(?:\/|$))[A-Za-z0-9._\-/*?@+~ ]+$/;

export class SettingsError extends Error {}

export function readProjectSettings(project: Pick<RegistryProject, 'id' | 'commitStyle' | 'agentInstructions' | 'commitAuthor'>): ProjectSettings {
  const fail = (what: string): never => {
    throw new SettingsError(`Project "${project.id}" has invalid agent settings in the registry (${what}); the task was not run`);
  };
  const style = project.commitStyle ?? { mode: 'off', guide: null };
  if (typeof style !== 'object' || style === null) fail('commitStyle');
  if (!['off', 'auto', 'manual'].includes(style.mode)) fail('commitStyle.mode');
  const guide = style.guide ?? null;
  if (guide !== null && (typeof guide !== 'string' || guide.length > LIMITS.styleGuide || !TEXT.test(guide))) fail('commitStyle.guide');
  if (style.mode === 'manual' && !guide?.trim()) fail('commitStyle.guide');

  const instructions = project.agentInstructions ?? { rules: '', forbiddenPaths: [] };
  if (typeof instructions !== 'object' || instructions === null) fail('agentInstructions');
  const { rules, forbiddenPaths } = instructions;
  if (typeof rules !== 'string' || rules.length > LIMITS.rules || !TEXT.test(rules)) fail('agentInstructions.rules');
  if (!Array.isArray(forbiddenPaths) || forbiddenPaths.length > LIMITS.forbiddenPaths) fail('agentInstructions.forbiddenPaths');
  for (const p of forbiddenPaths) {
    if (typeof p !== 'string' || p.length > LIMITS.forbiddenPath || !PATH_PATTERN.test(p)) fail(`forbidden path ${JSON.stringify(String(p).slice(0, 60))}`);
  }
  const author = project.commitAuthor ?? null;
  let commitAuthor: CommitAuthor | null = null;
  if (author !== null) {
    if (typeof author !== 'object') fail('commitAuthor');
    const name = typeof author.name === 'string' ? author.name.trim() : '';
    const email = typeof author.email === 'string' ? author.email.trim() : '';
    if (!name || [...name].length > LIMITS.authorName || !TEXT.test(name) || /[<>\n]/.test(name)) fail('commitAuthor.name');
    if (!email || email.length > LIMITS.authorEmail || !EMAIL.test(email)) fail('commitAuthor.email');
    if (hasAgentTrace(`${name} <${email}>`)) fail('commitAuthor (looks like an agent identity)');
    commitAuthor = { name, email };
  }
  return { commitStyle: { mode: style.mode, guide: guide?.trim() || null }, commitAuthor, rules: rules.trim(), forbiddenPaths: [...forbiddenPaths] };
}

// ---- forbidden paths ------------------------------------------------------------------

/**
 * gitignore-like pattern → RegExp over repository-relative paths ("a/b/c.txt"):
 * - `*` and `?` stay within one path segment, `**` crosses segments;
 * - a pattern without "/" (apart from a trailing one) matches at any depth (`*.pem`, `secrets/`);
 * - a pattern with "/" is anchored at the repository root (`config/prod/**`);
 * - a match also covers everything below it (`secrets` forbids `secrets/x`).
 * Errs on the side of matching more.
 */
export function patternToRegExp(pattern: string): RegExp {
  const body = pattern.replace(/\/+$/, '');
  const anchored = body.includes('/');
  let re = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '*' && body[i + 1] === '*') {
      i++;
      if (body[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else {
        re += '.*';
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${anchored ? '^' : '^(?:.*/)?'}${re}(?:/.*)?$`);
}

export function forbiddenMatcher(patterns: string[]): (path: string) => boolean {
  const compiled = patterns.map(patternToRegExp);
  return (path) => compiled.some((re) => re.test(path));
}

// ---- commit style ---------------------------------------------------------------------

const CONVENTIONAL = /^(feat|fix|docs|chore|refactor|test|tests|style|perf|build|ci|revert)(\([^)]{1,40}\))?!?: ?(.*)$/i;
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const LATIN = /[A-Za-z]/;

/**
 * What the code derived from recent commit subjects. Only `examples` contains repository text, and
 * it is shown to the owner (dashboard, report) but never put into the agent's prompt: commit
 * messages of a third-party repository are untrusted input.
 */
export interface CommitStyleAnalysis {
  sampleSize: number;
  /** Share of subjects in Conventional Commits form (`type(scope): summary`). */
  conventional: number;
  /** Conventional types used here, most frequent first (fixed vocabulary). */
  types: string[];
  scopes: number;
  language: 'korean' | 'english' | 'mixed' | 'unknown';
  /** Share of summaries starting with an upper-case latin letter (of those starting with one). */
  capitalized: number;
  trailingPeriod: number;
  medianLength: number;
  examples: string[];
  /** The instruction derived from the numbers above (what the agent is told). */
  guide: string;
}

export function analyzeCommitSubjects(subjects: string[]): CommitStyleAnalysis | null {
  const list = subjects.map((s) => s.trim()).filter(Boolean).slice(0, STYLE_SAMPLE);
  if (list.length < 3) return null;
  const share = (n: number) => Math.round((n / list.length) * 100) / 100;

  const typeCount = new Map<string, number>();
  let conventional = 0;
  let scopes = 0;
  let upper = 0;
  let latinStart = 0;
  let korean = 0;
  let english = 0;
  const summaries: string[] = [];
  for (const subject of list) {
    const m = CONVENTIONAL.exec(subject);
    let summary = subject;
    if (m) {
      conventional++;
      const type = m[1].toLowerCase() === 'tests' ? 'test' : m[1].toLowerCase();
      typeCount.set(type, (typeCount.get(type) ?? 0) + 1);
      if (m[2]) scopes++;
      summary = m[3];
    }
    summaries.push(summary);
    const first = summary.trimStart()[0] ?? '';
    if (/[A-Za-z]/.test(first)) {
      latinStart++;
      if (first === first.toUpperCase()) upper++;
    }
    if (HANGUL.test(subject)) korean++;
    else if (LATIN.test(subject)) english++;
  }
  const lengths = list.map((s) => [...s].length).sort((a, b) => a - b);
  const analysis: CommitStyleAnalysis = {
    sampleSize: list.length,
    conventional: share(conventional),
    types: [...typeCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t),
    scopes: share(scopes),
    language: korean / list.length >= 0.6 ? 'korean' : english / list.length >= 0.6 ? 'english' : korean + english > 0 ? 'mixed' : 'unknown',
    capitalized: latinStart ? Math.round((upper / latinStart) * 100) / 100 : 0,
    trailingPeriod: share(list.filter((s) => /[.。]$/.test(s)).length),
    medianLength: lengths[Math.floor(lengths.length / 2)],
    examples: list.slice(0, 5).map((s) => sanitizeLine(s, 120)),
    guide: '',
  };
  analysis.guide = describeStyle(analysis, latinStart);
  return analysis;
}

/** Built only from fixed phrases and numbers, so repository text cannot reach the prompt. */
function describeStyle(a: CommitStyleAnalysis, latinStart: number): string {
  const parts: string[] = [];
  if (a.conventional >= 0.6) {
    const scope = a.scopes >= 0.3 ? ' or "type(scope): summary"' : '';
    parts.push(`Use Conventional Commits ("type: summary"${scope}); types used in this project: ${a.types.slice(0, 6).join(', ')}.`);
  } else if (a.conventional <= 0.2) {
    parts.push('Do not use a "type:" prefix; write a plain summary.');
  }
  if (a.language === 'korean') parts.push('Write the subject in Korean.');
  else if (a.language === 'english') parts.push('Write the subject in English.');
  if (latinStart >= 3) {
    if (a.capitalized >= 0.7) parts.push('Start the summary with a capital letter.');
    else if (a.capitalized <= 0.3) parts.push('Start the summary with a lower-case letter.');
  }
  if (a.trailingPeriod <= 0.1) parts.push('Do not end the subject with a period.');
  else if (a.trailingPeriod >= 0.7) parts.push('End the subject with a period.');
  parts.push(`Keep it short: about ${Math.min(Math.max(a.medianLength, 20), 72)} characters, at most 72.`);
  return parts.join(' ');
}

// ---- prompt and commit subject --------------------------------------------------------

export const COMMIT_SUBJECT_MARKER = 'COMMIT_MESSAGE:';

/**
 * The project part of the agent's system prompt. It is appended after the worker's own fixed
 * rules and says that it cannot relax them. Empty when nothing is configured.
 */
export function buildProjectPrompt(settings: ProjectSettings, analysis: CommitStyleAnalysis | null, writable: boolean): string {
  const sections: string[] = [];
  if (settings.rules || settings.forbiddenPaths.length) {
    const lines = ['--- Project rules (set by the project owner; they add to the rules above and never relax them) ---'];
    if (settings.rules) lines.push(settings.rules);
    if (settings.forbiddenPaths.length) {
      lines.push(
        'Do not read, create, change, rename or delete files matching these paths. The worker checks this: ' +
          'if any of them changed, nothing is committed and the task fails.',
        ...settings.forbiddenPaths.map((p) => `- ${p}`),
      );
    }
    sections.push(lines.join('\n'));
  }
  const style = settings.commitStyle.mode === 'manual' ? settings.commitStyle.guide : settings.commitStyle.mode === 'auto' ? analysis?.guide : null;
  if (writable && (settings.commitStyle.mode !== 'off' || settings.commitAuthor)) {
    sections.push(
      [
        '--- Commit message ---',
        'Do not run git; the worker commits your changes. If you changed files, end your final answer with exactly one line:',
        `${COMMIT_SUBJECT_MARKER} <one-line commit subject describing the change>`,
        style ? `Commit style of this project: ${style}` : 'Match the usual style of a short, imperative commit subject.',
        'Write it as the project owner would: no mention of AI, agents, tools, models or task ids, and no trailers.',
      ].join('\n'),
    );
  }
  return sections.join('\n\n');
}

/** The agent's proposed commit subject (last marker line), cleaned to one bounded line, or null. */
export function extractCommitSubject(text: string): string | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const at = lines[i].indexOf(COMMIT_SUBJECT_MARKER);
    if (at === -1 || lines[i].slice(0, at).trim().replace(/[*_`>-]/g, '') !== '') continue;
    const subject = sanitizeLine(lines[i].slice(at + COMMIT_SUBJECT_MARKER.length).replace(/^[\s`"'*]+|[\s`"'*]+$/g, ''), LIMITS.subject);
    // A subject that names an agent or tool is not used (the neutral fallback is).
    return subject && !hasAgentTrace(subject) ? subject : null;
  }
  return null;
}

/** One line, no control characters, collapsed spaces, at most `max` characters. */
function sanitizeLine(text: string, max: number): string {
  const clean = text.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...clean];
  return chars.length > max ? chars.slice(0, max).join('').trimEnd() : clean;
}
