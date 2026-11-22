/**
 * Message templates. Callers send typed events; only this module decides the Discord text,
 * so no caller (and no LLM behind a caller) can make the bot post arbitrary content.
 */

export const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DISCORD_LIMIT = 2000;

export interface ChangedFile {
  status: string;
  path: string;
}

export interface TaskFinished {
  id: string;
  agent: 'claude' | 'codex';
  projectId: string | null;
  status: 'completed' | 'failed' | 'canceled';
  /** True only when the worker reported a successful run and the task is completed. */
  success: boolean;
  summary: string | null;
  changedFiles: ChangedFile[];
  branch: string | null;
  commit: string | null;
  durationSeconds: number | null;
  hostPath: string | null;
}

export class ValidationError extends Error {}

function str(value: unknown, field: string, max: number, nullable = true): string | null {
  if (value === null || value === undefined) {
    if (nullable) return null;
    throw new ValidationError(`${field} is required`);
  }
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
  if (value.length > max) throw new ValidationError(`${field} is longer than ${max} characters`);
  return value;
}

/** Strict validation of a task_finished event: unknown fields are rejected. */
export function parseTaskFinished(value: unknown): TaskFinished {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ValidationError('task must be an object');
  const t = value as Record<string, unknown>;
  const allowed = ['id', 'agent', 'projectId', 'status', 'success', 'summary', 'changedFiles', 'branch', 'commit', 'durationSeconds', 'hostPath'];
  const extra = Object.keys(t).filter((k) => !allowed.includes(k));
  if (extra.length) throw new ValidationError(`Unexpected task fields: ${extra.join(', ')}`);
  if (typeof t.id !== 'string' || !TASK_ID_PATTERN.test(t.id)) throw new ValidationError('task.id must be a task UUID');
  if (t.agent !== 'claude' && t.agent !== 'codex') throw new ValidationError('task.agent must be claude or codex');
  const projectId = str(t.projectId, 'task.projectId', 64);
  if (projectId !== null && !PROJECT_ID_PATTERN.test(projectId)) throw new ValidationError('task.projectId is invalid');
  if (t.status !== 'completed' && t.status !== 'failed' && t.status !== 'canceled') {
    throw new ValidationError('task.status must be completed, failed or canceled');
  }
  if (typeof t.success !== 'boolean') throw new ValidationError('task.success must be a boolean');
  const files = t.changedFiles ?? [];
  if (!Array.isArray(files) || files.length > 500) throw new ValidationError('task.changedFiles must be an array (max 500)');
  const changedFiles = files.map((f, i) => {
    if (typeof f !== 'object' || f === null) throw new ValidationError(`task.changedFiles[${i}] must be an object`);
    const o = f as Record<string, unknown>;
    return { status: str(o.status, `task.changedFiles[${i}].status`, 8, false)!, path: str(o.path, `task.changedFiles[${i}].path`, 500, false)! };
  });
  const commit = str(t.commit, 'task.commit', 64);
  if (commit !== null && !/^[0-9a-f]{7,64}$/.test(commit)) throw new ValidationError('task.commit must be a hex SHA');
  const duration = t.durationSeconds ?? null;
  if (duration !== null && (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0)) {
    throw new ValidationError('task.durationSeconds must be a non-negative number');
  }
  return {
    id: t.id,
    agent: t.agent,
    projectId,
    status: t.status,
    success: t.success,
    summary: str(t.summary, 'task.summary', 4000),
    changedFiles,
    branch: str(t.branch, 'task.branch', 300),
    commit,
    durationSeconds: duration as number | null,
    hostPath: str(t.hostPath, 'task.hostPath', 500),
  };
}

// ---------------------------------------------------------------- logins

/** Only the CLIs' own sign-in pages may be linked: a login message must never become a phishing link. */
const LOGIN_URL_PATTERN = /^https:\/\/(?:claude\.com|claude\.ai|platform\.claude\.com|console\.anthropic\.com|auth\.openai\.com)\/[^\s<>`]*$/;
const SESSION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface LoginRequired {
  agent: 'claude' | 'codex';
  sessionId: string;
  loginUrl: string;
  userCode: string | null;
  needsCode: boolean;
  expiresAt: string | null;
}

export interface LoginResult {
  agent: 'claude' | 'codex';
  sessionId: string;
  status: 'succeeded' | 'failed' | 'expired';
  message: string | null;
}

function loginBase(value: unknown, allowed: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ValidationError('login must be an object');
  const l = value as Record<string, unknown>;
  const extra = Object.keys(l).filter((k) => !allowed.includes(k));
  if (extra.length) throw new ValidationError(`Unexpected login fields: ${extra.join(', ')}`);
  if (l.agent !== 'claude' && l.agent !== 'codex') throw new ValidationError('login.agent must be claude or codex');
  if (typeof l.sessionId !== 'string' || !SESSION_PATTERN.test(l.sessionId)) throw new ValidationError('login.sessionId must be a UUID');
  return l;
}

export function parseLoginRequired(value: unknown): LoginRequired {
  const l = loginBase(value, ['agent', 'sessionId', 'loginUrl', 'userCode', 'needsCode', 'expiresAt']);
  if (typeof l.loginUrl !== 'string' || l.loginUrl.length > 2048 || !LOGIN_URL_PATTERN.test(l.loginUrl)) {
    throw new ValidationError('login.loginUrl must be a Claude/OpenAI sign-in URL');
  }
  const userCode = str(l.userCode, 'login.userCode', 24);
  if (userCode !== null && !/^[A-Z0-9-]{4,24}$/.test(userCode)) throw new ValidationError('login.userCode is invalid');
  if (typeof l.needsCode !== 'boolean') throw new ValidationError('login.needsCode must be a boolean');
  const expiresAt = str(l.expiresAt, 'login.expiresAt', 40);
  if (expiresAt !== null && Number.isNaN(Date.parse(expiresAt))) throw new ValidationError('login.expiresAt must be a date');
  return { agent: l.agent as LoginRequired['agent'], sessionId: l.sessionId as string, loginUrl: l.loginUrl, userCode, needsCode: l.needsCode, expiresAt };
}

export function parseLoginResult(value: unknown): LoginResult {
  const l = loginBase(value, ['agent', 'sessionId', 'status', 'message']);
  if (l.status !== 'succeeded' && l.status !== 'failed' && l.status !== 'expired') throw new ValidationError('login.status is invalid');
  return { agent: l.agent as LoginResult['agent'], sessionId: l.sessionId as string, status: l.status, message: str(l.message, 'login.message', 500) };
}

const AGENT_NAME = { claude: 'Claude', codex: 'Codex' } as const;

const CLOCK = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/Toronto' });

/** "HH:MM" in Toronto time, 24-hour (the Node image has no Korean locale data for "오전/오후"). */
export function torontoClock(iso: string): string {
  return CLOCK.format(new Date(iso));
}

function minutesLeft(expiresAt: string | null): string {
  if (!expiresAt) return '';
  return ` (${torontoClock(expiresAt)}까지)`;
}

export function formatLoginRequired(l: LoginRequired, mentionUserId: string | null): string {
  const lines = [`${mentionUserId ? `<@${mentionUserId}> ` : ''}**🔑 ${AGENT_NAME[l.agent]} Worker 로그인이 필요해요**`];
  lines.push(`로그인이 끝날 때까지 ${l.agent} 작업은 대기열에서 기다려요(실패 처리하지 않아요).`);
  lines.push(`1. 이 링크를 열고 구독 계정으로 로그인하세요${minutesLeft(l.expiresAt)}:`);
  lines.push(`<${l.loginUrl}>`);
  if (l.needsCode) {
    lines.push('2. 로그인 후 화면에 나오는 **코드를 복사**해서 Kelly에게 이렇게 보내주세요:');
    lines.push(`\`@Kelly ${l.agent} 로그인 코드: <복사한 코드>\``);
  } else if (l.userCode) {
    lines.push(`2. 화면에서 이 일회용 코드를 입력하세요: **${l.userCode}**`);
    lines.push('3. 입력하면 자동으로 끝나요. Kelly에게 따로 보낼 것은 없어요.');
  }
  lines.push(`세션 ID: \`${l.sessionId}\``);
  return lines.join('\n');
}

export function formatLoginResult(l: LoginResult, mentionUserId: string | null): string {
  const mention = mentionUserId ? `<@${mentionUserId}> ` : '';
  if (l.status === 'succeeded') return `${mention}**✅ ${AGENT_NAME[l.agent]} Worker 로그인 완료** — 대기 중이던 작업을 다시 처리해요.`;
  const head = l.status === 'expired' ? '⌛ 로그인 시간이 지났어요' : '❌ 로그인에 실패했어요';
  const detail = l.message ? `\n내용: ${clean(l.message, 300)}` : '';
  return `${mention}**${head}** · ${AGENT_NAME[l.agent]} Worker${detail}\n새 로그인 링크가 곧 오지 않으면 Kelly에게 \`@Kelly ${l.agent} 로그인 다시 시작해줘\`라고 보내주세요.`;
}

/** Plain text for inside a Discord message: no code-span breakouts, no masked links. */
function clean(text: string, max: number): string {
  const flat = text.replace(/`/g, 'ʹ').replace(/\r/g, '').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const AUTH_HINT = /401|oauth|authenticat|not logged in|login/i;

export function formatTaskFinished(task: TaskFinished, mentionUserId: string | null, dashboardUrl: string): string {
  const head =
    task.status === 'completed' && task.success
      ? '✅ 작업 완료'
      : task.status === 'canceled'
        ? '⏹️ 작업 취소됨'
        : '❌ 작업 실패';
  const lines: string[] = [];
  lines.push(`${mentionUserId ? `<@${mentionUserId}> ` : ''}**${head}** · ${task.agent} / ${task.projectId ?? '(프로젝트 없음)'}`);
  lines.push(`작업 ID: \`${task.id}\``);
  if (task.summary) lines.push(`${task.status === 'completed' && task.success ? '요약' : '내용'}: ${clean(task.summary, 700)}`);
  if (task.changedFiles.length) {
    const shown = task.changedFiles.slice(0, 10).map((f) => `${clean(f.status, 8)} ${clean(f.path, 120)}`);
    const more = task.changedFiles.length > 10 ? ` 외 ${task.changedFiles.length - 10}개` : '';
    lines.push(`변경 파일 (${task.changedFiles.length}): ${shown.join(', ')}${more}`);
  } else if (task.status === 'completed') {
    lines.push('변경 파일: 없음');
  }
  if (task.branch) lines.push(`브랜치: \`${clean(task.branch, 200)}\``);
  if (task.durationSeconds !== null) lines.push(`실행 시간: ${task.durationSeconds}초`);
  if (task.hostPath) lines.push(`PC 경로: ${clean(task.hostPath, 300)}`);
  if (task.status === 'failed' && task.summary && AUTH_HINT.test(task.summary)) {
    lines.push(`⚠️ ${task.agent} Worker 로그인이 만료된 것으로 보여요. 재로그인이 필요해요.`);
  }
  if (task.status === 'completed' && task.changedFiles.length) {
    lines.push(`검토: ${dashboardUrl}/tasks/${task.id} (승인 전에는 병합·게시되지 않아요)`);
  }
  const text = lines.join('\n');
  return text.length > DISCORD_LIMIT ? `${text.slice(0, DISCORD_LIMIT - 1)}…` : text;
}
