import { Badge, errorText, Unavailable } from '@/components/ui';
import { controller } from '@/lib/controller';
import { short, since } from '@/lib/diff';
import type { Project } from '@/lib/types';
import { requireSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

/** Read-only registry view. Changes stay with the controller admin API (no credentials shown here). */
export default async function ProjectsPage() {
  await requireSession();
  let projects: Project[] | null = null;
  let error: string | null = null;
  try {
    projects = await controller.projects();
  } catch (e) {
    error = errorText(e);
  }
  return (
    <>
      <h1>Projects</h1>
      <p className="muted">Read-only. Registry changes require the controller admin API.</p>
      {error && <Unavailable what="Project registry" reason={error} />}
      {projects && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Project</th><th>Source</th><th>Visibility</th><th>Branch</th><th>Agents</th>
                <th>Code changes</th><th>Enabled</th><th>Sync</th><th>Last sync</th><th>Head</th><th>Sync error</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id}>
                  <td>
                    <div><strong>{p.id}</strong></div>
                    {p.fullName && <div className="muted">{p.fullName}</div>}
                  </td>
                  <td>{p.source}</td>
                  <td><span className={`badge ${p.visibility === 'private' ? 'warn' : 'muted'}`}>{p.visibility ?? 'local'}</span></td>
                  <td className="mono">{p.defaultBranch}</td>
                  <td>{p.allowedAgents.join(', ') || '-'}</td>
                  <td>{p.allowCodeChanges ? 'allowed' : 'read-only'}</td>
                  <td><span className={`badge ${p.enabled ? 'ok' : 'muted'}`}>{p.enabled ? 'enabled' : 'disabled'}</span></td>
                  <td><Badge value={p.syncStatus} /></td>
                  <td title={p.lastFetchedAt ?? ''}>{p.source === 'local' ? '-' : since(p.lastFetchedAt)}</td>
                  <td className="mono">{p.cachedHeadSha ? short(p.cachedHeadSha) : '-'}</td>
                  <td className="trunc" title={p.lastSyncError ?? ''}>{p.lastSyncError ?? '-'}</td>
                </tr>
              ))}
              {projects.length === 0 && <tr><td colSpan={11} className="muted">No projects</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
