import { notFound } from 'next/navigation';
import { Badge, CsrfField, errorText, Flash, Unavailable } from '@/components/ui';
import { controller, ControllerError } from '@/lib/controller';
import { short, since } from '@/lib/diff';
import { LIMITS, latestStyleAnalysis, PROJECT_ID, STYLE_MODES } from '@/lib/project-settings';
import { requireSession } from '@/lib/server';
import type { Project, Task } from '@/lib/types';
import styles from '../projects.module.css';

export const dynamic = 'force-dynamic';

/**
 * One project: registry facts (read-only) and the agent settings an admin may edit here
 * (ROADMAP 11-13). Saving goes through /api/projects/:id/settings (session + CSRF + audit).
 */
export default async function ProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, sp, session] = await Promise.all([params, searchParams, requireSession()]);
  if (!PROJECT_ID.test(id)) notFound();
  let project: Project | null = null;
  let error: string | null = null;
  try {
    project = await controller.project(id);
  } catch (e) {
    if (e instanceof ControllerError && e.status === 404) notFound();
    error = errorText(e);
  }
  if (!project) return <Unavailable what="Project" reason={error ?? 'unknown'} />;

  let tasks: Task[] = [];
  try {
    tasks = (await controller.tasks({ projectId: id, limit: '25' })).items;
  } catch {
    // the analysis panel just stays empty
  }
  const detected = latestStyleAnalysis(tasks);
  const supported = project.commitStyle !== undefined && project.agentInstructions !== undefined;
  const style = project.commitStyle ?? { mode: 'off' as const, guide: null };
  const instructions = project.agentInstructions ?? { rules: '', forbiddenPaths: [] };

  return (
    <>
      <p className="muted"><a href="/projects">← Projects</a></p>
      <h1>{project.id}</h1>
      {project.fullName && <p className="muted">{project.fullName}</p>}
      <Flash ok={sp.ok} error={sp.error} />
      {!supported && (
        <div className="warning bad">This controller does not report agent settings yet (registry before v7). Update the controller first.</div>
      )}

      <div className={styles.layout}>
        <form method="post" action={`/api/projects/${project.id}/settings`} className={styles.form}>
          <CsrfField token={session.csrf} />

          <fieldset className={styles.group}>
            <legend>Coding rules</legend>
            <p className={styles.help}>Added to the agent&apos;s instructions after the worker&apos;s fixed safety rules; they can add limits but never remove them.</p>
            <label className={styles.field}>
              <span>Rules (max {LIMITS.rules} characters)</span>
              <textarea name="rules" rows={8} maxLength={LIMITS.rules} defaultValue={instructions.rules} placeholder={'e.g. Use TypeScript strict mode.\nDo not add new dependencies.'} />
            </label>
            <label className={styles.field}>
              <span>Forbidden paths: one pattern per line (max {LIMITS.forbiddenPaths}). <code>*</code> within a folder, <code>**</code> across folders, <code>name/</code> for a folder anywhere.</span>
              <textarea name="forbiddenPaths" rows={5} className={styles.mono} defaultValue={instructions.forbiddenPaths.join('\n')} placeholder={'secrets/\n*.pem\nconfig/prod/**'} />
            </label>
            <p className={styles.help}>Enforced by the worker, not only asked: if a task changes a matching file, nothing is committed and the task fails.</p>
          </fieldset>

          <fieldset className={styles.group}>
            <legend>Commit style</legend>
            <div className={styles.modes} role="radiogroup" aria-label="Commit style mode">
              {STYLE_MODES.map((m) => (
                <label key={m.value} className={styles.mode}>
                  <input type="radio" name="styleMode" value={m.value} defaultChecked={style.mode === m.value} />
                  <strong>{m.label}</strong>
                  <small>{m.help}</small>
                </label>
              ))}
            </div>
            <label className={styles.field}>
              <span>Guide for “Manual” (max {LIMITS.styleGuide} characters)</span>
              <textarea name="styleGuide" rows={3} maxLength={LIMITS.styleGuide} defaultValue={style.guide ?? ''} placeholder="e.g. Conventional Commits, lower-case summary, no period, English." />
            </label>
            <p className={styles.help}>The agent proposes the commit subject; the worker still makes the commit, and the review shows the exact message.</p>
          </fieldset>

          <fieldset className={styles.group}>
            <legend>Commit author</legend>
            <div className={styles.policy}>
              POLICY B: task commits are made as this person (author and committer), with no AI or agent trace in the message.
              The publisher only publishes commits made exactly as this identity, so without it nothing from this project is published.
              Use the GitHub noreply address to keep your e-mail private.
            </div>
            <div className={styles.pair}>
              <label className={styles.field}>
                <span>Name</span>
                <input name="authorName" maxLength={LIMITS.authorName} defaultValue={project.commitAuthor?.name ?? ''} autoComplete="off" />
              </label>
              <label className={styles.field}>
                <span>E-mail</span>
                <input name="authorEmail" type="email" maxLength={LIMITS.authorEmail} defaultValue={project.commitAuthor?.email ?? ''} autoComplete="off" />
              </label>
            </div>
          </fieldset>

          <div className={styles.actions}>
            <button className="primary" type="submit" disabled={!supported}>Save settings</button>
            <span className="muted">Applies to tasks that start after saving.</span>
          </div>
        </form>

        <aside className={styles.side}>
          <div className="card">
            <h2>Registry</h2>
            <dl className="kv">
              <dt>Source</dt><dd>{project.source}</dd>
              <dt>Visibility</dt><dd>{project.visibility ?? 'local'}</dd>
              <dt>Branch</dt><dd className="mono">{project.defaultBranch}</dd>
              <dt>Agents</dt><dd>{project.allowedAgents.join(', ') || '-'}</dd>
              <dt>Enabled</dt><dd><span className={`badge ${project.enabled ? 'ok' : 'muted'}`}>{project.enabled ? 'enabled' : 'disabled'}</span></dd>
              <dt>Code changes</dt><dd>{project.allowCodeChanges ? 'allowed' : 'read-only'}</dd>
              <dt>Sync</dt><dd><Badge value={project.syncStatus} /> {project.source !== 'local' && <span className="muted">{since(project.lastFetchedAt)}</span>}</dd>
              <dt>Head</dt><dd className="mono">{project.cachedHeadSha ? short(project.cachedHeadSha) : '-'}</dd>
            </dl>
            <p className={styles.help} style={{ marginTop: 8 }}>Enable, agents and sync stay with the controller admin API.</p>
          </div>

          <div className="card">
            <h2>Detected commit style</h2>
            {detected ? (
              <>
                <p className={styles.help}>
                  From {detected.analysis.sampleSize} recent commits, task <a href={`/tasks/${detected.taskId}`} className="mono">{short(detected.taskId, 8)}</a> · {since(detected.at)}
                </p>
                <p>{detected.analysis.guide}</p>
                {detected.analysis.examples.length > 0 && (
                  <>
                    <p className={styles.help}>Recent subjects (shown here only, never sent to the agent):</p>
                    <ul className={`${styles.examples} ${styles.mono}`}>
                      {detected.analysis.examples.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  </>
                )}
              </>
            ) : (
              <p className="muted">No analysis yet. With “Auto”, the worker analyses the history when the next task in this project runs.</p>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}
