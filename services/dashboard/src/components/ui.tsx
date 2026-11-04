import type { ReactNode } from 'react';

const TONE: Record<string, string> = {
  completed: 'ok', approved: 'ok', ok: 'ok', reachable: 'ok', online: 'ok', synced: 'ok',
  running: 'info', queued: 'muted', awaiting_approval: 'warn', cancel_requested: 'warn', syncing: 'info',
  failed: 'bad', rejected: 'bad', error: 'bad', unreachable: 'bad', offline: 'bad',
  canceled: 'muted', invalidated: 'warn', unknown: 'muted', stale: 'warn', never_synced: 'muted',
};

export function Badge({ value }: { value: string | null | undefined }) {
  const v = value || 'unknown';
  return <span className={`badge ${TONE[v] ?? 'muted'}`}>{v}</span>;
}

/** ?ok= / ?error= messages set by route-handler redirects (rendered as text). */
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

export function Unavailable({ what, reason }: { what: string; reason: string }) {
  return (
    <div className="warning bad">
      {what} unavailable: {reason}
    </div>
  );
}

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export function errorText(error: unknown): string {
  const e = error as { message?: string; status?: number | null };
  return e?.status ? `${e.message} (HTTP ${e.status})` : (e?.message ?? 'unknown error');
}
