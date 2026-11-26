import type { ReactNode } from 'react';
import type { Dict } from '@/i18n';

const TONE: Record<string, string> = {
  completed: 'ok', approved: 'ok', ok: 'ok', reachable: 'ok', online: 'ok', synced: 'ok',
  running: 'info', queued: 'muted', awaiting_approval: 'warn', cancel_requested: 'warn', syncing: 'info',
  failed: 'bad', rejected: 'bad', error: 'bad', unreachable: 'bad', offline: 'bad',
  canceled: 'muted', invalidated: 'warn', unknown: 'muted', stale: 'warn', never_synced: 'muted',
};

/** Status codes from the services are shown as they are (they are also the filter values). */
export function Badge({ value }: { value: string | null | undefined }) {
  const v = value || 'unknown';
  return <span className={`badge ${TONE[v] ?? 'muted'}`}>{v}</span>;
}

/** ?ok= / ?error= messages set by route-handler redirects (rendered as text, already translated). */
export function Flash({ ok, error }: { ok?: string | string[]; error?: string | string[] }) {
  const first = (v?: string | string[]) => (Array.isArray(v) ? v[0] : v);
  return (
    <>
      {first(ok) && <div className="flash ok">{first(ok)}</div>}
      {first(error) && <div className="flash error">{first(error)}</div>}
    </>
  );
}

export function CsrfField({ token }: { token: string }) {
  return <input type="hidden" name="csrf" value={token} />;
}

export function Unavailable({ t, what, reason }: { t: Dict; what: string; reason: string }) {
  return <div className="warning bad">{t.common.unavailable(what, reason)}</div>;
}

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

/**
 * A backend error as text. Errors the dashboard produced itself carry a `local` code and are
 * translated; a message that came from another service is shown as it is (not translated).
 */
export function errorText(error: unknown, t: Dict): string {
  const e = error as { status?: number | null } | null;
  const message = backendMessage(error, t);
  return e?.status ? t.common.httpStatus(message, e.status) : message;
}

/** Same as errorText without the HTTP status (for flash notices). */
export function backendMessage(error: unknown, t: Dict): string {
  const e = error as { message?: string; status?: number | null; local?: LocalErrorCode | null } | null;
  return (e?.local ? localErrorText(e.local, e.status ?? null, t) : e?.message) || t.common.unknownError;
}

export type LocalErrorCode =
  | 'controller_token' | 'controller_unreachable' | 'controller_http'
  | 'learning_token' | 'learning_unreachable' | 'learning_http'
  | 'knowledge_key' | 'knowledge_unreachable' | 'knowledge_http'
  | 'llm_key' | 'llm_unreachable' | 'llm_http' | 'llm_unexpected';

export function localErrorText(code: LocalErrorCode, status: number | null, t: Dict): string {
  const b = t.common.backend;
  switch (code) {
    case 'controller_token': return b.controllerTokenMissing;
    case 'controller_unreachable': return b.controllerUnreachable;
    case 'controller_http': return b.controllerHttp(status ?? 0);
    case 'learning_token': return b.learningTokenMissing;
    case 'learning_unreachable': return b.learningUnreachable;
    case 'learning_http': return b.learningHttp(status ?? 0);
    case 'knowledge_key': return t.kg.flash.notConfigured;
    case 'knowledge_unreachable': return b.knowledgeUnreachable;
    case 'knowledge_http': return b.knowledgeHttp(status ?? 0);
    case 'llm_key': return t.aiUsage.err.notConfigured;
    case 'llm_unreachable': return b.llmUnreachable;
    case 'llm_http': return b.llmHttp(status ?? 0);
    case 'llm_unexpected': return t.aiUsage.err.unexpected;
  }
}
