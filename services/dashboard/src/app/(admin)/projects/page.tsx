import { Badge, errorText, Unavailable } from '@/components/ui';
import { controller } from '@/lib/controller';
import { short, since } from '@/lib/diff';
import { settingsSummary } from '@/lib/project-settings';
import type { Project } from '@/lib/types';
import { requireSession } from '@/lib/server';
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

/** Registry overview. Agent settings are edited per project (/projects/:id); everything else stays with the controller admin API. */
export default async function ProjectsPage() {
  await requireSession();
  const t = await getT();
  const k = t.projects;
  let projects: Project[] | null = null;
  let error: string | null = null;
  try {
    projects = await controller.projects();
  } catch (e) {
    error = errorText(e, t);
  }
  return (
    <>
      <h1>{k.title}</h1>
      <p className="muted">{k.intro}</p>
      {error && <Unavailable t={t} what={k.registry} reason={error} />}
      {projects && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t.common.project}</th><th>{k.source}</th><th>{k.visibility}</th><th>{t.common.branch}</th><th>{k.agents}</th>
                <th>{k.codeChanges}</th><th>{k.enabled}</th><th>{k.agentSettings}</th><th>{k.sync}</th><th>{k.lastSync}</th><th>{k.head}</th><th>{k.syncError}</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div><a href={`/projects/${p.id}`}><strong>{p.id}</strong></a></div>
                    {p.fullName && <div className="muted">{p.fullName}</div>}
                  </td>
                  <td>{p.source}</td>
                  <td><span className={`badge ${p.visibility === 'private' ? 'warn' : 'muted'}`}>{p.visibility ?? k.local}</span></td>
                  <td className="mono">{p.defaultBranch}</td>
                  <td>{p.allowedAgents.join(', ') || '-'}</td>
                  <td>{p.allowCodeChanges ? k.allowed : k.readOnly}</td>
                  <td><span className={`badge ${p.enabled ? 'ok' : 'muted'}`}>{p.enabled ? k.enabledYes : k.enabledNo}</span></td>
                  <td><a href={`/projects/${p.id}`}>{settingsSummary(p, t)}</a></td>
                  <td><Badge value={p.syncStatus} /></td>
                  <td title={p.lastFetchedAt ?? ''}>{p.source === 'local' ? '-' : since(p.lastFetchedAt, t)}</td>
                  <td className="mono">{p.cachedHeadSha ? short(p.cachedHeadSha) : '-'}</td>
                  <td className="trunc" title={p.lastSyncError ?? ''}>{p.lastSyncError ?? '-'}</td>
                </tr>
              ))}
              {projects.length === 0 && <tr><td colSpan={12} className="muted">{k.noProjects}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
