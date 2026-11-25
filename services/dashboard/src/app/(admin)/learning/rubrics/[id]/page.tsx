import { notFound } from 'next/navigation';
import { RubricCriteriaFields } from '@/components/learning/client';
import { Chip, Empty, LearningPostFields, PageHeader, Panel } from '@/components/learning/parts';
import s from '@/components/learning/learning.module.css';
import { errorText, Flash, Unavailable } from '@/components/ui';
import { learning, LearningError } from '@/lib/learning';
import { LEARNING_UUID, type LearningSearchParams } from '@/lib/learning-view';
import { requireSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

export default async function RubricPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: LearningSearchParams;
}) {
  const [{ id }, sp, session] = await Promise.all([params, searchParams, requireSession()]);
  if (!LEARNING_UUID.test(id)) notFound();

  try {
    const rubric = await learning.rubric(id);
    const { latestVersion } = rubric;
    const here = `/learning/rubrics/${id}`;

    return (
      <>
        <PageHeader title={rubric.title} crumbs={[{ href: '/learning/rubrics', label: 'Rubrics' }]} actions={<Chip status={rubric.status} />} />
        <Flash ok={sp.ok} error={sp.error} />
        <div className={s.split}>
          <Panel title="Version history">
            {rubric.versions.length ? (
              <div className={s.stack}>
                {rubric.versions.map((version) => (
                  <details className={s.disclosure} key={version.id} open={version.id === latestVersion?.id}>
                    <summary>Version {version.version} · {version.passingScore} / {version.maxScore} to pass</summary>
                    <div className={s.disclosureBody}>
                      <div className={s.rows}>
                        {version.criteria.map((criterion) => (
                          <div key={criterion.key} className={s.row}>
                            <div className={s.rowMain}>
                              <strong className={s.rowTitle}>{criterion.title}</strong>
                              {criterion.description && <p className={s.prose}>{criterion.description}</p>}
                            </div>
                            <span className={s.meterLabel}>Max {criterion.maxScore}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            ) : <Empty title="No rubric versions" />}
          </Panel>

          <div className={s.stack}>
            {latestVersion && (
              <details className={s.disclosure}>
                <summary>New version</summary>
                <div className={s.disclosureBody}>
                  <form method="post" action={`/api/learning/rubrics/${id}/version`} className={s.form}>
                    <LearningPostFields csrf={session.csrf} returnTo={here} />
                    <input type="hidden" name="baseVersion" value={latestVersion.version} />
                    <p className={s.formHint}>Existing assignments and evaluations keep their linked version.</p>
                    <RubricCriteriaFields criteria={latestVersion.criteria} />
                    <label className={s.field}>Passing score
                      <input type="number" name="passingScore" required min={0} step={0.01} defaultValue={latestVersion.passingScore} />
                    </label>
                    <div className={s.formActions}><button type="submit" className="primary">Save new version</button></div>
                  </form>
                </div>
              </details>
            )}
            <Panel title="Rubric settings">
              <form method="post" action={`/api/learning/rubrics/${id}/update`} className={s.form}>
                <LearningPostFields csrf={session.csrf} returnTo={here} />
                <label className={s.field}>Title<input name="title" maxLength={200} required defaultValue={rubric.title} /></label>
                <label className={s.field}>Status
                  <select name="status" defaultValue={rubric.status}>
                    <option value="active">Active</option>
                    <option value="archived">Archived</option>
                  </select>
                </label>
                <div className={s.formActions}><button type="submit">Save settings</button></div>
              </form>
            </Panel>
          </div>
        </div>
      </>
    );
  } catch (error) {
    if (error instanceof LearningError && error.status === 404) notFound();
    return <Unavailable what="Learning service" reason={errorText(error)} />;
  }
}
