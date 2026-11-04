import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { DiffView } from '@/components/DiffView';
import { Badge, CsrfField, errorText, Flash, Unavailable } from '@/components/ui';
import { controller, ControllerError, UUID } from '@/lib/controller';
import { short, since } from '@/lib/diff';
import { requireSession } from '@/lib/server';
import { decidable, reviewWarnings, testsOf } from '@/lib/review';
import type { DiffResponse, PublicationStatus } from '@/lib/types';
import { AutoRefresh } from '@/components/client';
import { PublicationPanel } from '@/components/PublicationPanel';

export const dynamic = 'force-dynamic';

export default async function ReviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, sp, session] = await Promise.all([params, searchParams, requireSession()]);
  if (!UUID.test(id)) notFound();
  let d: DiffResponse | null = null;
  let publication: PublicationStatus | null = null;
  let error: string | null = null;
  try {
    d = await controller.diff(id);
    publication = await controller.publication(id).catch(() => null);
  } catch (e) {
    if (e instanceof ControllerError && e.status === 404) {
      error = e.message;
    } else {
      error = errorText(e);
    }
  }
  if (!d) {
    return (
      <>
        <h1>Review</h1>
        <Flash ok={sp.ok} error={sp.error} />
        <Unavailable what="Diff" reason={error ?? 'unknown'} />
        <a href={`/tasks/${id}`}>Task details →</a>
      </>
    );
  }

  const warnings = reviewWarnings(d, publication?.testValidation);
  const tests = testsOf(d, publication?.testValidation);
  const pending = decidable(d);
  const confirm = sp.confirm === 'approve' || sp.confirm === 'reject' ? sp.confirm : null;
  const publishConfirm = sp.confirm === 'authorize' || sp.confirm === 'publish' ? sp.confirm : null;

  return (
    <>
      <h1>Review <span className="mono">{short(d.taskId, 8)}</span> <Badge value={d.review?.status} /></h1>
      <Flash ok={sp.ok} error={sp.error} />
      <div className="card">
        <dl className="kv">
          <dt>Project</dt><dd>{d.projectId}</dd>
          <dt>Agent</dt><dd>{d.agent} · <a href={`/tasks/${d.taskId}`}>task</a></dd>
          <dt>Base</dt><dd className="mono">{d.baseSha}</dd>
          <dt>Head</dt><dd className="mono">{d.headSha}</dd>
          <dt>Tree</dt><dd className="mono">{d.headTree ?? 'not reported'}</dd>
          <dt>Changes</dt><dd>{d.files.length} file(s) <span className="plus">+{d.additions ?? '?'}</span> <span className="minus">-{d.deletions ?? '?'}</span></dd>
          <dt>Tests</dt><dd><span className={`badge ${tests.status === 'passed' ? 'ok' : tests.level === 'bad' ? 'bad' : 'warn'}`}>{tests.status}</span> <span className="muted">{tests.text}</span></dd>
        </dl>
        <div className="section">
          <h2>Commit message</h2>
          <pre className="block">{d.commitMessage ?? '(not reported)'}</pre>
        </div>
      </div>

      <div className="section">
        {warnings.map((w, i) => (
          <div key={i} className={w.level === 'bad' ? 'warning bad' : 'warning'}>{w.text}</div>
        ))}
      </div>

      {pending && !confirm && (
        <div className="row section">
          <a className="btn approve" href={`/reviews/${d.taskId}?confirm=approve#decide`}>Approve…</a>
          <a className="btn danger" href={`/reviews/${d.taskId}?confirm=reject#decide`}>Reject…</a>
        </div>
      )}

      {pending && confirm && (
        <div id="decide" className="card section" style={{ borderColor: confirm === 'approve' ? 'var(--ok)' : 'var(--bad)' }}>
          <h2>Confirm {confirm}</h2>
          <dl className="kv">
            <dt>Project</dt><dd>{d.projectId}</dd>
            <dt>Base SHA</dt><dd className="mono">{d.baseSha}</dd>
            <dt>Head SHA</dt><dd className="mono">{pending.headSha}</dd>
            <dt>Files</dt><dd><pre className="block">{d.files.map((f) => `${f.status}\t${f.path}`).join('\n') || '(none)'}</pre></dd>
          </dl>
          <p className="muted">
            This records a decision for this exact commit only. It does not push, merge or open a PR.
            {warnings.length > 0 && ` ${warnings.length} warning(s) above apply.`}
          </p>
          <form method="post" action={`/api/reviews/${d.taskId}/decision`} className="section" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <CsrfField token={session.csrf} />
            <input type="hidden" name="decision" value={confirm} />
            <input type="hidden" name="headSha" value={pending.headSha} />
            <label className="row">
              <input type="checkbox" name="confirmed" value="yes" required /> I reviewed commit <span className="mono">{short(pending.headSha)}</span> and want to {confirm} it.
            </label>
            <textarea name="reason" maxLength={2000} rows={2} placeholder="Reason (optional)" />
            <div className="row">
              <button type="submit" className={confirm === 'approve' ? 'approve' : 'danger'}>{confirm === 'approve' ? 'Approve commit' : 'Reject commit'}</button>
              <a href={`/reviews/${d.taskId}`}>Cancel</a>
            </div>
          </form>
        </div>
      )}

      <PublicationPanel taskId={d.taskId} status={publication} csrf={session.csrf} confirm={publishConfirm} files={d.files} idempotencyKey={randomUUID()} />
      {(publication?.state === 'validation_pending' || publication?.testValidation?.status === 'pending' || publication?.testValidation?.status === 'running') && <AutoRefresh seconds={3} />}

      <div className="section">
        <h2>Files</h2>
        <DiffView files={d.files} patch={d.patch} omitted={d.omittedFiles} withheld={d.patchWithheld} />
      </div>

      <div className="section">
        <h2>History</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Head</th><th>Status</th><th>Decided by</th><th>When</th><th>Reason</th></tr></thead>
            <tbody>
              {d.history.map((h) => (
                <tr key={h.id}>
                  <td className="mono">{short(h.headSha)}</td>
                  <td><Badge value={h.status} /></td>
                  <td>{h.decidedBy ?? '-'}</td>
                  <td title={h.decidedAt ?? h.createdAt}>{since(h.decidedAt ?? h.createdAt)}</td>
                  <td className="trunc">{h.reason ?? h.invalidatedReason ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
