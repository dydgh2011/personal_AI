import { CsrfField } from '@/components/ui';
import type { Dict } from '@/i18n';
import { short, since } from '@/lib/diff';
import { nextSteps, reasonText } from '@/lib/publishing';
import type { PublicationState, PublicationStatus } from '@/lib/types';

const TONE: Record<PublicationState, string> = {
  not_approved: 'muted',
  approved: 'info',
  validation_pending: 'warn',
  ready_to_publish: 'ok',
  validation_failed: 'bad',
  published: 'ok',
  pr_created: 'ok',
};

export function publicationLabel(state: PublicationState, t: Dict) {
  const text = (t.publication.states as Record<string, string>)[state];
  return text ? { text, tone: TONE[state] ?? 'muted' } : { text: state, tone: 'muted' };
}

const TEST_TONE: Record<string, string> = { passed: 'ok', failed: 'bad', aborted: 'bad', skipped: 'warn', pending: 'warn', running: 'info' };

/**
 * Publishing of the reviewed commit. Review approval, test evidence, publish authorization and the
 * publish request are separate; every button here is also enforced by the controller and the
 * publisher. All report text is rendered as text.
 */
export function PublicationPanel({ t, taskId, status, csrf, confirm, files, idempotencyKey }: {
  t: Dict; taskId: string; status: PublicationStatus | null; csrf: string; confirm?: string | null;
  files?: Array<{ status: string; path: string }>; idempotencyKey: string;
}) {
  if (!status) return null;
  const p = t.publication;
  const label = publicationLabel(status.state, t);
  const pub = status.current;
  const r = pub?.result ?? null;
  const tests = status.testValidation;
  const steps = nextSteps(status);
  const head = status.review?.headSha ?? '';
  const preflightStale = !!r && !!tests && r.testValidationId !== tests.id;

  return (
    <div id="publication" className="card section">
      <h2>{p.title}</h2>
      <div className="row">
        <span className={`badge ${label.tone}`}>{label.text}</span>
        <span className="muted">{p.policy(status.publishEnabled)}</span>
      </div>

      {/* ---- tests */}
      <div className="section">
        <h2>{p.testValidation}</h2>
        {steps.testsMissing && <div className="warning bad">{reasonText('TEST_REPORT_MISSING', t)}{tests ? p.runStatus(tests.status) : ''}</div>}
        {tests && (
          <>
            <dl className="kv">
              <dt>{t.common.status}</dt><dd><span className={`badge ${TEST_TONE[tests.status] ?? 'muted'}`}>{tests.status}</span> <span className="muted">{p.runLine(short(tests.id, 8), tests.requestedBy, since(tests.requestedAt, t))}</span></dd>
              <dt>{p.testedCommit}</dt><dd className="mono">{tests.commitSha}{tests.commitSha !== head && <span className="badge bad">{p.notReviewedCommit}</span>}</dd>
              <dt>{p.evidence}</dt><dd className="mono">{tests.evidenceHash ? p.evidenceSigned(short(tests.evidenceHash, 16)) : '-'}</dd>
              {tests.error && <><dt>{t.common.error}</dt><dd>{tests.error}</dd></>}
            </dl>
            <div className="table-wrap section">
              <table>
                <thead><tr><th>{p.command}</th><th>argv</th><th>{p.exitCode}</th><th>{t.common.result}</th><th>{p.time}</th></tr></thead>
                <tbody>
                  {tests.commands.map((c, i) => {
                    const res = tests.results?.[i];
                    return (
                      <tr key={c.name}>
                        <td className="mono">{c.name}</td>
                        <td className="mono trunc" title={c.argv.join(' ')}>{c.argv.join(' ')}</td>
                        <td className="mono">{res ? (res.exitCode ?? (res.timedOut ? 'timeout' : '-')) : '-'}</td>
                        <td>{res ? <span className={`badge ${TEST_TONE[res.status] ?? 'muted'}`}>{res.status}</span> : <span className="muted">{p.notRun}</span>}</td>
                        <td>{res ? t.common.seconds((res.durationMs / 1000).toFixed(1)) : '-'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {tests.results?.some((x) => x.status !== 'passed' && x.outputTail) && (
              <details className="section"><summary>{p.failingOutput}</summary>
                <pre className="block">{tests.results.filter((x) => x.status !== 'passed').map((x) => `$ ${x.argv.join(' ')}\n${x.outputTail}`).join('\n\n')}</pre>
              </details>
            )}
          </>
        )}
        {steps.canRunTests && (
          <form method="post" action={`/api/reviews/${taskId}/tests`} className="section">
            <CsrfField token={csrf} />
            <input type="hidden" name="headSha" value={head} />
            <button type="submit">{p.runTests}</button> <span className="muted">{p.runTestsHelp}</span>
          </form>
        )}
      </div>

      {/* ---- preflight */}
      <div className="section">
        <h2>{p.preflight}</h2>
        <dl className="kv">
          <dt>{p.reviewApproval}</dt><dd><span className={`badge ${status.review?.status === 'approved' ? 'ok' : 'muted'}`}>{status.review?.status ?? p.noneStatus}</span>{status.review?.decidedBy && <span className="muted">{p.by(status.review.decidedBy)}</span>}</dd>
          <dt>{p.gitIntegrity}</dt><dd>{r ? (r.gitVerified ? p.gitVerified : p.gitNotVerified) : p.notChecked}</dd>
          <dt>{p.commitAuthor}</dt><dd className="mono">{r?.author ? `${r.author.name} <${r.author.email}> · ${p.committer} ${r.author.committerName} <${r.author.committerEmail}>` : p.notChecked}</dd>
          <dt>{p.eligibility}</dt><dd>{r ? <><span className={`badge ${r.eligible ? 'ok' : 'bad'}`}>{r.eligible ? p.eligible : p.notEligible}</span> <span className={`badge ${r.canPublish ? 'ok' : 'muted'}`}>{r.canPublish ? p.canPublish : p.cannotPublish}</span></> : '-'}</dd>
          {r?.reason && <><dt>{t.common.reason}</dt><dd><span className="mono">{r.reason}</span> — {reasonText(r.reason, t)}</dd></>}
          {r?.target && <><dt>{p.target}</dt><dd className="mono">{r.target.repository ?? '?'} : {r.target.baseBranch} → {r.target.branch}</dd></>}
          {pub && <><dt>{p.lastRun}</dt><dd className="muted">{p.lastRunLine(pub.mode, pub.requestedBy, since(pub.requestedAt, t), pub.completedAt ? since(pub.completedAt, t) : null)}</dd></>}
        </dl>
        {preflightStale && <div className="warning">{p.stale}</div>}
        {r?.error && <div className="warning bad">{r.error}</div>}
        {r?.controllerNote && <div className="warning bad">{r.controllerNote}</div>}
        {(r?.blockers ?? []).map((b, i) => <div key={`b${i}`} className="warning bad">{b}</div>)}
        {(r?.warnings ?? []).map((w, i) => <div key={`w${i}`} className="warning">{w}</div>)}
        {steps.canDryRun && (
          <form method="post" action={`/api/reviews/${taskId}/dry-run`} className="section">
            <CsrfField token={csrf} />
            <input type="hidden" name="headSha" value={head} />
            <button type="submit">{p.validate}</button>
          </form>
        )}
        {r?.checks && (
          <details className="section"><summary>{p.checks(r.checks.filter((c) => c.ok).length, r.checks.length)}</summary>
            <div className="table-wrap">
              <table>
                <thead><tr><th>{p.check}</th><th>{t.common.result}</th><th>{p.detail}</th></tr></thead>
                <tbody>
                  {r.checks.map((c) => (
                    <tr key={c.id}>
                      <td className="mono">{c.id}</td>
                      <td><span className={`badge ${c.ok ? 'ok' : 'bad'}`}>{c.ok ? p.pass : c.code ?? p.blocked}</span></td>
                      <td>{c.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
        {r?.pullRequest && (
          <details className="section"><summary>{p.plannedPr(r.pullRequest.title)}</summary>
            <dl className="kv"><dt>{p.branches}</dt><dd className="mono">{r.pullRequest.head} → {r.pullRequest.base} {p.draft}</dd></dl>
            <pre className="block">{r.pullRequest.body}</pre>
          </details>
        )}
      </div>

      {/* ---- publish authorization (separate from review approval) */}
      <div className="section">
        <h2>{p.authorization}</h2>
        {status.authorization && (
          <div className="muted">
            {p.authLine(status.authorization.status, status.authorization.authorizedBy, since(status.authorization.authorizedAt, t), status.authorization.expiresAt, short(status.authorization.headSha), short(status.authorization.testValidationId, 8))}
          </div>
        )}
        {!steps.canAuthorize && !steps.activeAuth && (
          <div className="muted">
            {p.authUnavailable}
          </div>
        )}
        {steps.canAuthorize && confirm !== 'authorize' && <a className="btn approve" href={`/reviews/${taskId}?confirm=authorize#publication`}>{p.authorizeLink}</a>}
        {steps.canAuthorize && confirm === 'authorize' && r && pub && (
          <div className="card section" style={{ borderColor: 'var(--ok)' }}>
            <h2>{p.confirmAuth}</h2>
            <dl className="kv">
              <dt>{p.repository}</dt><dd>{r.target?.repository}</dd>
              <dt>{t.common.branch}</dt><dd className="mono">{p.branchNew(r.target?.branch ?? '?', r.target?.baseBranch ?? '?')}</dd>
              <dt>{t.reviews.baseHead}</dt><dd className="mono">{short(r.target?.baseSha)} → {r.target?.headSha}</dd>
              <dt>{t.common.files}</dt><dd><pre className="block">{(files ?? r.files ?? []).map((f) => `${f.status}\t${f.path}`).join('\n')}</pre></dd>
              <dt>{t.review.tests}</dt><dd className="mono">{tests?.results?.map((x) => `${x.name}: exit ${x.exitCode}`).join(', ')}</dd>
              <dt>{p.author}</dt><dd className="mono">{r.author ? `${r.author.name} <${r.author.email}>` : '-'} {p.kept}</dd>
            </dl>
            <p className="muted">{p.authNote}</p>
            <form method="post" action={`/api/reviews/${taskId}/authorize`} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <CsrfField token={csrf} />
              <input type="hidden" name="headSha" value={head} />
              <input type="hidden" name="dryRunId" value={pub.id} />
              <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
              <label className="row"><input type="checkbox" name="confirmed" value="yes" required /> {p.authCheck(short(head), r.target?.repository ?? '?')}</label>
              <div className="row"><button type="submit" className="approve">{p.authorize}</button><a href={`/reviews/${taskId}#publication`}>{t.common.cancel}</a></div>
            </form>
          </div>
        )}
      </div>

      {/* ---- publish */}
      <div className="section">
        <h2>{p.publish}</h2>
        {!status.publishEnabled && <button type="button" disabled title={reasonText('PUBLISH_DISABLED', t)}>{p.publishDisabled}</button>}
        {status.publishEnabled && steps.activeAuth && confirm !== 'publish' && <a className="btn approve" href={`/reviews/${taskId}?confirm=publish#publication`}>{p.publishLink}</a>}
        {status.publishEnabled && steps.activeAuth && confirm === 'publish' && (
          <form method="post" action={`/api/reviews/${taskId}/publish`} className="card section" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <CsrfField token={csrf} />
            <input type="hidden" name="authorizationId" value={steps.activeAuth.id} />
            <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
            <label className="row"><input type="checkbox" name="confirmed" value="yes" required /> {p.publishCheck(short(head), r?.target?.branch ?? '?')}</label>
            <div className="row"><button type="submit" className="approve">{p.publish}</button><a href={`/reviews/${taskId}#publication`}>{t.common.cancel}</a></div>
          </form>
        )}
      </div>
    </div>
  );
}
