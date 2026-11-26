import { notFound } from 'next/navigation';
import { Badge, CsrfField, errorText, Flash, Unavailable } from '@/components/ui';
import { controller, ControllerError } from '@/lib/controller';
import { short, since } from '@/lib/diff';
import { LIMITS, latestStyleAnalysis, PROJECT_ID, STYLE_MODES } from '@/lib/project-settings';
import { requireSession } from '@/lib/server';
import { getT } from '@/i18n/server';
import type { Project, Task } from '@/lib/types';
import styles from '../projects.module.css';

export const dynamic = 'force-dynamic';

/**
 * One project: registry facts (read-only) and the agent settings an admin may edit here
 * (ROADMAP 11-13). Saving goes through /api/projects/:id/settings (session + CSRF + audit).
 */
export default async function ProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ id }, sp, session, t] = await Promise.all([params, searchParams, requireSession(), getT()]);
  const k = t.projects;
  if (!PROJECT_ID.test(id)) notFound();
  let project: Project | null = null;
  let error: string | null = null;
  try {
    project = await controller.project(id);
  } catch (e) {
    if (e instanceof ControllerError && e.status === 404) notFound();
    error = errorText(e, t);
  }
  if (!project) return <Unavailable t={t} what={k.projectWhat} reason={error ?? t.common.unknown} />;

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
      <p className="muted"><a href="/projects">{k.back}</a></p>
      <h1>{project.id}</h1>
      {project.fullName && <p className="muted">{project.fullName}</p>}
      <Flash ok={sp.ok} error={sp.error} />
      {!supported && (
        <div className="warning bad">{k.oldController}</div>
      )}

      <div className={styles.layout}>
        <form method="post" action={`/api/projects/${project.id}/settings`} className={styles.form}>
          <CsrfField token={session.csrf} />

          <fieldset className={styles.group}>
            <legend>{k.codingRules}</legend>
            <p className={styles.help}>{k.codingRulesHelp}</p>
            <label className={styles.field}>
              <span>{k.rules(LIMITS.rules)}</span>
              <textarea name="rules" rows={8} maxLength={LIMITS.rules} defaultValue={instructions.rules} placeholder={k.rulesPlaceholder} />
            </label>
            <label className={styles.field}>
              <span>{k.forbiddenPaths(LIMITS.forbiddenPaths)}<code>*</code> {k.forbiddenPathsSyntax.star}, <code>**</code> {k.forbiddenPathsSyntax.doubleStar}, <code>name/</code> {k.forbiddenPathsSyntax.folder}.</span>
              <textarea name="forbiddenPaths" rows={5} className={styles.mono} defaultValue={instructions.forbiddenPaths.join('\n')} placeholder={'secrets/\n*.pem\nconfig/prod/**'} />
            </label>
            <p className={styles.help}>{k.forbiddenHelp}</p>
          </fieldset>

          <fieldset className={styles.group}>
            <legend>{k.commitStyle}</legend>
            <div className={styles.modes} role="radiogroup" aria-label={k.commitStyleMode}>
              {STYLE_MODES.map((m) => (
                <label key={m} className={styles.mode}>
                  <input type="radio" name="styleMode" value={m} defaultChecked={style.mode === m} />
                  <strong>{k.modes[m].label}</strong>
                  <small>{k.modes[m].help}</small>
                </label>
              ))}
            </div>
            <label className={styles.field}>
              <span>{k.guide(LIMITS.styleGuide)}</span>
              <textarea name="styleGuide" rows={3} maxLength={LIMITS.styleGuide} defaultValue={style.guide ?? ''} placeholder={k.guidePlaceholder} />
            </label>
            <p className={styles.help}>{k.styleHelp}</p>
          </fieldset>

          <fieldset className={styles.group}>
            <legend>{k.commitAuthor}</legend>
            <div className={styles.policy}>{k.policyB}</div>
            <div className={styles.pair}>
              <label className={styles.field}>
                <span>{k.name}</span>
                <input name="authorName" maxLength={LIMITS.authorName} defaultValue={project.commitAuthor?.name ?? ''} autoComplete="off" />
              </label>
              <label className={styles.field}>
                <span>{k.email}</span>
                <input name="authorEmail" type="email" maxLength={LIMITS.authorEmail} defaultValue={project.commitAuthor?.email ?? ''} autoComplete="off" />
              </label>
            </div>
          </fieldset>

          <div className={styles.actions}>
            <button className="primary" type="submit" disabled={!supported}>{k.save}</button>
            <span className="muted">{k.saveHelp}</span>
          </div>
        </form>

        <aside className={styles.side}>
          <div className="card">
            <h2>{k.registryTitle}</h2>
            <dl className="kv">
              <dt>{k.source}</dt><dd>{project.source}</dd>
              <dt>{k.visibility}</dt><dd>{project.visibility ?? k.local}</dd>
              <dt>{t.common.branch}</dt><dd className="mono">{project.defaultBranch}</dd>
              <dt>{k.agents}</dt><dd>{project.allowedAgents.join(', ') || '-'}</dd>
              <dt>{k.enabled}</dt><dd><span className={`badge ${project.enabled ? 'ok' : 'muted'}`}>{project.enabled ? k.enabledYes : k.enabledNo}</span></dd>
              <dt>{k.codeChanges}</dt><dd>{project.allowCodeChanges ? k.allowed : k.readOnly}</dd>
              <dt>{k.sync}</dt><dd><Badge value={project.syncStatus} /> {project.source !== 'local' && <span className="muted">{since(project.lastFetchedAt, t)}</span>}</dd>
              <dt>{k.head}</dt><dd className="mono">{project.cachedHeadSha ? short(project.cachedHeadSha) : '-'}</dd>
            </dl>
            <p className={styles.help} style={{ marginTop: 8 }}>{k.registryHelp}</p>
          </div>

          <div className="card">
            <h2>{k.detected}</h2>
            {detected ? (
              <>
                <p className={styles.help}>
                  {k.detectedFrom(detected.analysis.sampleSize)} <a href={`/tasks/${detected.taskId}`} className="mono">{short(detected.taskId, 8)}</a> · {since(detected.at, t)}
                </p>
                <p>{detected.analysis.guide}</p>
                {detected.analysis.examples.length > 0 && (
                  <>
                    <p className={styles.help}>{k.recentSubjects}</p>
                    <ul className={`${styles.examples} ${styles.mono}`}>
                      {detected.analysis.examples.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  </>
                )}
              </>
            ) : (
              <p className="muted">{k.noAnalysis}</p>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}
