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
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

export default async function ReviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, sp, session, t] = await Promise.all([params, searchParams, requireSession(), getT()]);
  const k = t.review;
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
      error = errorText(e, t);
    }
  }
  if (!d) {
    return (
      <>
        <h1>{k.title}</h1>
        <Flash ok={sp.ok} error={sp.error} />
        <Unavailable t={t} what={k.diff} reason={error ?? t.common.unknown} />
        <a href={`/tasks/${id}`}>{k.taskDetails}</a>
      </>
    );
  }

  const warnings = reviewWarnings(d, publication?.testValidation, t);
  const tests = testsOf(d, publication?.testValidation, t);
  const pending = decidable(d);
  const confirm = sp.confirm === 'approve' || sp.confirm === 'reject' ? sp.confirm : null;
  const publishConfirm = sp.confirm === 'authorize' || sp.confirm === 'publish' ? sp.confirm : null;

  return (
    <>
      <h1>{k.title} <span className="mono">{short(d.taskId, 8)}</span> <Badge value={d.review?.status} /></h1>
      <Flash ok={sp.ok} error={sp.error} />
      <div className="card">
        <dl className="kv">
          <dt>{t.common.project}</dt><dd>{d.projectId}</dd>
          <dt>{t.common.agent}</dt><dd>{d.agent} · <a href={`/tasks/${d.taskId}`}>{t.common.task}</a></dd>
          <dt>{k.base}</dt><dd className="mono">{d.baseSha}</dd>
          <dt>{k.head}</dt><dd className="mono">{d.headSha}</dd>
          <dt>{k.tree}</dt><dd className="mono">{d.headTree ?? k.notReported}</dd>
          <dt>{k.changes}</dt><dd>{k.fileCount(d.files.length)} <span className="plus">+{d.additions ?? '?'}</span> <span className="minus">-{d.deletions ?? '?'}</span></dd>
          <dt>{k.tests}</dt><dd><span className={`badge ${tests.status === 'passed' ? 'ok' : tests.level === 'bad' ? 'bad' : 'warn'}`}>{tests.status}</span> <span className="muted">{tests.text}</span></dd>
        </dl>
        <div className="section">
          <h2>{k.commitMessage}</h2>
          <pre className="block">{d.commitMessage ?? t.common.notReported}</pre>
        </div>
      </div>

      <div className="section">
        {warnings.map((w, i) => (
          <div key={i} className={w.level === 'bad' ? 'warning bad' : 'warning'}>{w.text}</div>
        ))}
      </div>

      {pending && !confirm && (
        <div className="row section">
          <a className="btn approve" href={`/reviews/${d.taskId}?confirm=approve#decide`}>{k.approve}</a>
          <a className="btn danger" href={`/reviews/${d.taskId}?confirm=reject#decide`}>{k.reject}</a>
        </div>
      )}

      {pending && confirm && (
        <div id="decide" className="card section" style={{ borderColor: confirm === 'approve' ? 'var(--ok)' : 'var(--bad)' }}>
          <h2>{k.confirmTitle(confirm)}</h2>
          <dl className="kv">
            <dt>{t.common.project}</dt><dd>{d.projectId}</dd>
            <dt>{k.baseSha}</dt><dd className="mono">{d.baseSha}</dd>
            <dt>{k.headSha}</dt><dd className="mono">{pending.headSha}</dd>
            <dt>{t.common.files}</dt><dd><pre className="block">{d.files.map((f) => `${f.status}\t${f.path}`).join('\n') || t.common.none}</pre></dd>
          </dl>
          <p className="muted">
            {k.confirmNote}
            {warnings.length > 0 && k.warningsApply(warnings.length)}
          </p>
          <form method="post" action={`/api/reviews/${d.taskId}/decision`} className="section" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <CsrfField token={session.csrf} />
            <input type="hidden" name="decision" value={confirm} />
            <input type="hidden" name="headSha" value={pending.headSha} />
            <label className="row">
              <input type="checkbox" name="confirmed" value="yes" required /> {k.confirmCheck(confirm)} <span className="mono">{short(pending.headSha)}</span>
            </label>
            <textarea name="reason" maxLength={2000} rows={2} placeholder={k.reasonPlaceholder} />
            <div className="row">
              <button type="submit" className={confirm === 'approve' ? 'approve' : 'danger'}>{confirm === 'approve' ? k.approveCommit : k.rejectCommit}</button>
              <a href={`/reviews/${d.taskId}`}>{t.common.cancel}</a>
            </div>
          </form>
        </div>
      )}

      <PublicationPanel t={t} taskId={d.taskId} status={publication} csrf={session.csrf} confirm={publishConfirm} files={d.files} idempotencyKey={randomUUID()} />
      {(publication?.state === 'validation_pending' || publication?.testValidation?.status === 'pending' || publication?.testValidation?.status === 'running') && <AutoRefresh seconds={3} />}

      <div className="section">
        <h2>{t.common.files}</h2>
        <DiffView t={t} files={d.files} patch={d.patch} omitted={d.omittedFiles} withheld={d.patchWithheld} />
      </div>

      <div className="section">
        <h2>{k.history}</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>{k.head}</th><th>{t.common.status}</th><th>{k.decidedBy}</th><th>{k.when}</th><th>{t.common.reason}</th></tr></thead>
            <tbody>
              {d.history.map((h) => (
                <tr key={h.id}>
                  <td className="mono">{short(h.headSha)}</td>
                  <td><Badge value={h.status} /></td>
                  <td>{h.decidedBy ?? '-'}</td>
                  <td title={h.decidedAt ?? h.createdAt}>{since(h.decidedAt ?? h.createdAt, t)}</td>
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
