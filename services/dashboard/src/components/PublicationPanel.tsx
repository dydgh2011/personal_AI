import { CsrfField } from '@/components/ui';
import { short, since } from '@/lib/diff';
import { nextSteps, reasonText } from '@/lib/publishing';
import type { PublicationState, PublicationStatus } from '@/lib/types';

const LABEL: Record<PublicationState, { text: string; tone: string }> = {
  not_approved: { text: 'Not approved', tone: 'muted' },
  approved: { text: 'Approved', tone: 'info' },
  validation_pending: { text: 'Validation pending', tone: 'warn' },
  ready_to_publish: { text: 'Ready to publish', tone: 'ok' },
  validation_failed: { text: 'Validation failed', tone: 'bad' },
  published: { text: 'Published', tone: 'ok' },
  pr_created: { text: 'PR created', tone: 'ok' },
};

export function publicationLabel(state: PublicationState) {
  return LABEL[state] ?? { text: state, tone: 'muted' };
}

const TEST_TONE: Record<string, string> = { passed: 'ok', failed: 'bad', aborted: 'bad', skipped: 'warn', pending: 'warn', running: 'info' };

/**
 * Publishing of the reviewed commit. Review approval, test evidence, publish authorization and the
 * publish request are separate; every button here is also enforced by the controller and the
 * publisher. All report text is rendered as text.
 */
export function PublicationPanel({ taskId, status, csrf, confirm, files, idempotencyKey }: {
  taskId: string; status: PublicationStatus | null; csrf: string; confirm?: string | null;
  files?: Array<{ status: string; path: string }>; idempotencyKey: string;
}) {
  if (!status) return null;
  const label = publicationLabel(status.state);
  const pub = status.current;
  const r = pub?.result ?? null;
  const tests = status.testValidation;
  const steps = nextSteps(status);
  const head = status.review?.headSha ?? '';
  const preflightStale = !!r && !!tests && r.testValidationId !== tests.id;

  return (
    <div id="publication" className="card section">
      <h2>Publishing</h2>
      <div className="row">
        <span className={`badge ${label.tone}`}>{label.text}</span>
        <span className="muted">Policy: tests required (POLICY A) · commits only as the project owner, no AI trace (POLICY B) · real publishing {status.publishEnabled ? 'enabled' : 'disabled'}</span>
      </div>

      {/* ---- tests */}
      <div className="section">
        <h2>Test validation</h2>
        {steps.testsMissing && <div className="warning bad">{reasonText('TEST_REPORT_MISSING')}{tests ? ` (run ${tests.status})` : ''}</div>}
        {tests && (
          <>
            <dl className="kv">
              <dt>Status</dt><dd><span className={`badge ${TEST_TONE[tests.status] ?? 'muted'}`}>{tests.status}</span> <span className="muted">run {short(tests.id, 8)}, requested by {tests.requestedBy} {since(tests.requestedAt)}</span></dd>
              <dt>Tested commit</dt><dd className="mono">{tests.commitSha}{tests.commitSha !== head && <span className="badge bad"> not the reviewed commit</span>}</dd>
              <dt>Evidence</dt><dd className="mono">{tests.evidenceHash ? `sha256 ${short(tests.evidenceHash, 16)}… (signed by the test runner)` : '-'}</dd>
              {tests.error && <><dt>Error</dt><dd>{tests.error}</dd></>}
            </dl>
            <div className="table-wrap section">
              <table>
                <thead><tr><th>Command</th><th>argv</th><th>Exit code</th><th>Result</th><th>Time</th></tr></thead>
                <tbody>
                  {tests.commands.map((c, i) => {
                    const res = tests.results?.[i];
                    return (
                      <tr key={c.name}>
                        <td className="mono">{c.name}</td>
                        <td className="mono trunc" title={c.argv.join(' ')}>{c.argv.join(' ')}</td>
                        <td className="mono">{res ? (res.exitCode ?? (res.timedOut ? 'timeout' : '-')) : '-'}</td>
                        <td>{res ? <span className={`badge ${TEST_TONE[res.status] ?? 'muted'}`}>{res.status}</span> : <span className="muted">not run</span>}</td>
                        <td>{res ? `${(res.durationMs / 1000).toFixed(1)}s` : '-'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {tests.results?.some((x) => x.status !== 'passed' && x.outputTail) && (
              <details className="section"><summary>Output of failing commands</summary>
                <pre className="block">{tests.results.filter((x) => x.status !== 'passed').map((x) => `$ ${x.argv.join(' ')}\n${x.outputTail}`).join('\n\n')}</pre>
              </details>
            )}
          </>
        )}
        {steps.canRunTests && (
          <form method="post" action={`/api/reviews/${taskId}/tests`} className="section">
            <CsrfField token={csrf} />
            <input type="hidden" name="headSha" value={head} />
            <button type="submit">Run tests</button> <span className="muted">Runs the project&apos;s admin-approved commands on exactly this commit in the isolated test runner.</span>
          </form>
        )}
      </div>

      {/* ---- preflight */}
      <div className="section">
        <h2>Publisher preflight (dry-run)</h2>
        <dl className="kv">
          <dt>Review approval</dt><dd><span className={`badge ${status.review?.status === 'approved' ? 'ok' : 'muted'}`}>{status.review?.status ?? 'none'}</span>{status.review?.decidedBy && <span className="muted"> by {status.review.decidedBy}</span>}</dd>
          <dt>Git integrity</dt><dd>{r ? (r.gitVerified ? 'verified against trusted git objects' : 'not verified') : 'not checked yet'}</dd>
          <dt>Commit author</dt><dd className="mono">{r?.author ? `${r.author.name} <${r.author.email}> · committer ${r.author.committerName} <${r.author.committerEmail}>` : 'not checked yet'}</dd>
          <dt>Eligibility</dt><dd>{r ? <><span className={`badge ${r.eligible ? 'ok' : 'bad'}`}>{r.eligible ? 'eligible' : 'not eligible'}</span> <span className={`badge ${r.canPublish ? 'ok' : 'muted'}`}>{r.canPublish ? 'can publish' : 'cannot publish'}</span></> : '-'}</dd>
          {r?.reason && <><dt>Reason</dt><dd><span className="mono">{r.reason}</span> — {reasonText(r.reason)}</dd></>}
          {r?.target && <><dt>Target</dt><dd className="mono">{r.target.repository ?? '?'} : {r.target.baseBranch} → {r.target.branch}</dd></>}
          {pub && <><dt>Last run</dt><dd className="muted">{pub.mode} by {pub.requestedBy} {since(pub.requestedAt)}{pub.completedAt ? `, finished ${since(pub.completedAt)}` : ''}</dd></>}
        </dl>
        {preflightStale && <div className="warning">The last preflight used another test run; validate again.</div>}
        {r?.error && <div className="warning bad">{r.error}</div>}
        {r?.controllerNote && <div className="warning bad">{r.controllerNote}</div>}
        {(r?.blockers ?? []).map((b, i) => <div key={`b${i}`} className="warning bad">{b}</div>)}
        {(r?.warnings ?? []).map((w, i) => <div key={`w${i}`} className="warning">{w}</div>)}
        {steps.canDryRun && (
          <form method="post" action={`/api/reviews/${taskId}/dry-run`} className="section">
            <CsrfField token={csrf} />
            <input type="hidden" name="headSha" value={head} />
            <button type="submit">Validate / Dry-run</button>
          </form>
        )}
        {r?.checks && (
          <details className="section"><summary>Checks ({r.checks.filter((c) => c.ok).length}/{r.checks.length} passed)</summary>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead>
                <tbody>
                  {r.checks.map((c) => (
                    <tr key={c.id}>
                      <td className="mono">{c.id}</td>
                      <td><span className={`badge ${c.ok ? 'ok' : 'bad'}`}>{c.ok ? 'pass' : c.code ?? 'blocked'}</span></td>
                      <td>{c.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
        {r?.pullRequest && (
          <details className="section"><summary>Planned pull request (not created): {r.pullRequest.title}</summary>
            <dl className="kv"><dt>Branches</dt><dd className="mono">{r.pullRequest.head} → {r.pullRequest.base} (draft)</dd></dl>
            <pre className="block">{r.pullRequest.body}</pre>
          </details>
        )}
      </div>

      {/* ---- publish authorization (separate from review approval) */}
      <div className="section">
        <h2>Publish authorization</h2>
        {status.authorization && (
          <div className="muted">
            {status.authorization.status} — by {status.authorization.authorizedBy} {since(status.authorization.authorizedAt)}, expires {status.authorization.expiresAt}, commit {short(status.authorization.headSha)}, test run {short(status.authorization.testValidationId, 8)}
          </div>
        )}
        {!steps.canAuthorize && !steps.activeAuth && (
          <div className="muted">
            Available only after: review approved, tests passed on this commit, and a fresh eligible dry-run for that test run.
          </div>
        )}
        {steps.canAuthorize && confirm !== 'authorize' && <a className="btn approve" href={`/reviews/${taskId}?confirm=authorize#publication`}>Authorize publishing…</a>}
        {steps.canAuthorize && confirm === 'authorize' && r && pub && (
          <div className="card section" style={{ borderColor: 'var(--ok)' }}>
            <h2>Confirm publish authorization</h2>
            <dl className="kv">
              <dt>Repository</dt><dd>{r.target?.repository}</dd>
              <dt>Branch</dt><dd className="mono">{r.target?.branch} (new; {r.target?.baseBranch} untouched)</dd>
              <dt>Base → Head</dt><dd className="mono">{short(r.target?.baseSha)} → {r.target?.headSha}</dd>
              <dt>Files</dt><dd><pre className="block">{(files ?? r.files ?? []).map((f) => `${f.status}\t${f.path}`).join('\n')}</pre></dd>
              <dt>Tests</dt><dd className="mono">{tests?.results?.map((x) => `${x.name}: exit ${x.exitCode}`).join(', ')}</dd>
              <dt>Author</dt><dd className="mono">{r.author ? `${r.author.name} <${r.author.email}>` : '-'} (kept)</dd>
            </dl>
            <p className="muted">This only authorizes publishing for 30 minutes. It does not push. The controller and the publisher check everything again.</p>
            <form method="post" action={`/api/reviews/${taskId}/authorize`} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <CsrfField token={csrf} />
              <input type="hidden" name="headSha" value={head} />
              <input type="hidden" name="dryRunId" value={pub.id} />
              <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
              <label className="row"><input type="checkbox" name="confirmed" value="yes" required /> I authorize publishing commit <span className="mono">{short(head)}</span> to {r.target?.repository}.</label>
              <div className="row"><button type="submit" className="approve">Authorize publishing</button><a href={`/reviews/${taskId}#publication`}>Cancel</a></div>
            </form>
          </div>
        )}
      </div>

      {/* ---- publish */}
      <div className="section">
        <h2>Publish</h2>
        {!status.publishEnabled && <button type="button" disabled title={reasonText('PUBLISH_DISABLED')}>Publish (disabled in Phase E-2B)</button>}
        {status.publishEnabled && steps.activeAuth && confirm !== 'publish' && <a className="btn approve" href={`/reviews/${taskId}?confirm=publish#publication`}>Publish…</a>}
        {status.publishEnabled && steps.activeAuth && confirm === 'publish' && (
          <form method="post" action={`/api/reviews/${taskId}/publish`} className="card section" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <CsrfField token={csrf} />
            <input type="hidden" name="authorizationId" value={steps.activeAuth.id} />
            <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
            <label className="row"><input type="checkbox" name="confirmed" value="yes" required /> Push {short(head)} to {r?.target?.branch} and open a draft pull request.</label>
            <div className="row"><button type="submit" className="approve">Publish</button><a href={`/reviews/${taskId}#publication`}>Cancel</a></div>
          </form>
        )}
      </div>
    </div>
  );
}
