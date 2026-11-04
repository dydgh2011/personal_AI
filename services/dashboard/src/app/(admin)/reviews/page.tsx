import { AutoRefresh } from '@/components/client';
import { Badge, errorText, Unavailable } from '@/components/ui';
import { controller } from '@/lib/controller';
import { short, since } from '@/lib/diff';
import type { Review } from '@/lib/types';
import { requireSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

const STATUSES = ['awaiting_approval', 'approved', 'rejected', 'invalidated'];

export default async function ReviewsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [sp] = await Promise.all([searchParams, requireSession()]);
  const raw = Array.isArray(sp.status) ? sp.status[0] : sp.status;
  const status = raw === 'all' ? undefined : STATUSES.includes(raw ?? '') ? raw : 'awaiting_approval';
  let items: Review[] | null = null;
  let error: string | null = null;
  try {
    items = await controller.reviews(status);
  } catch (e) {
    error = errorText(e);
  }
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Code Reviews</h1>
        <AutoRefresh seconds={10} />
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        {[...STATUSES, 'all'].map((s) => (
          <a key={s} href={`/reviews?status=${s}`} className={(status ?? 'all') === s ? 'badge info' : 'badge muted'}>{s}</a>
        ))}
      </div>
      {error && <Unavailable what="Review list" reason={error} />}
      {items && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Task</th><th>Project</th><th>Agent</th><th>Status</th><th>Base → Head</th><th>Created</th><th>Decided</th></tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td className="mono"><a href={`/reviews/${r.taskId}`}>{short(r.taskId, 8)}</a></td>
                  <td>{r.projectId}</td>
                  <td>{r.agent}</td>
                  <td><Badge value={r.status} /></td>
                  <td className="mono">{short(r.baseSha, 8)} → {short(r.headSha, 8)}</td>
                  <td title={r.createdAt}>{since(r.createdAt)}</td>
                  <td className="muted">{r.decidedBy ? `${r.decidedBy}, ${since(r.decidedAt)}` : r.invalidatedReason ?? '-'}</td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={7} className="muted">Nothing here</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
