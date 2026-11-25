/**
 * Per-project settings for coding agents (ROADMAP 11 and 12). Admin-only, never shown to
 * delegators (Hermes). Workers receive commitStyle and agentInstructions through
 * GET /internal/projects; commitAuthor is NOT sent to workers.
 *
 * commitAuthor and POLICY B: the publisher only accepts commits whose author and committer are
 * `<agent>-worker <<agent>-worker@personal-ai.local>` (POLICY B, fixed). A worker committing as the
 * project's commitAuthor would make every such commit unpublishable (AUTHOR_CHANGED), and making the
 * publisher accept it would change POLICY B. So the value is validated and stored for a later owner
 * decision, and workers keep their own identity. See docs/coding-agent-settings.md.
 */

export const COMMIT_STYLE_MODES = ['off', 'auto', 'manual'] as const;
export type CommitStyleMode = (typeof COMMIT_STYLE_MODES)[number];

export interface CommitAuthor {
  name: string;
  email: string;
}

/**
 * off:    the worker commits with its fixed message (behaviour before v7).
 * auto:   the worker reads recent commit subjects of the project from its read-only repository
 *         copy, derives the style in code, and asks the agent for a matching commit subject.
 * manual: the admin's `guide` text is used instead of the detected style.
 */
export interface CommitStyle {
  mode: CommitStyleMode;
  guide: string | null;
}

/** Coding rules (added to the agent's system prompt) and paths whose changes are never committed. */
export interface AgentInstructions {
  rules: string;
  forbiddenPaths: string[];
}

export const LIMITS = {
  authorName: 100,
  authorEmail: 254,
  styleGuide: 1000,
  rules: 4000,
  forbiddenPaths: 50,
  forbiddenPath: 200,
} as const;

export const DEFAULT_COMMIT_STYLE: CommitStyle = { mode: 'off', guide: null };
export const DEFAULT_AGENT_INSTRUCTIONS: AgentInstructions = { rules: '', forbiddenPaths: [] };

/** Multi-line text: tabs and newlines are fine, other control characters (incl. CR) are not. */
export const TEXT_PATTERN = /^[^\x00-\x08\x0b-\x1f\x7f]*$/;

/** One line, no control characters and none of git's ident delimiters. */
export const AUTHOR_NAME_PATTERN = /^(?=.*\S)[^\x00-\x1f\x7f<>]+$/;

/** Simple, strict address check (git ident safe): local@domain.tld, no spaces, no <>. */
export const AUTHOR_EMAIL_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/**
 * A repository-relative path pattern (gitignore-like): `*` and `?` within a segment, `**` across
 * segments, trailing `/` for a directory. No absolute paths, no "." or ".." segments, no backslashes,
 * no empty segments. The worker applies the same rules again before using them.
 */
export const FORBIDDEN_PATH_PATTERN =
  /^(?!\s)(?!.*\s$)(?!\/)(?!\.\/)(?!.*\/\/)(?!(?:.*\/)?\.{1,2}(?:\/|$))[A-Za-z0-9._\-/*?@+~ ]+$/;

/** Removes CR so text pasted from Windows passes TEXT_PATTERN. */
export function normalizeText(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : value;
}
