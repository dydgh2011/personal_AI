import { AutoRefresh } from '@/components/client';
import { Badge, errorText, Unavailable } from '@/components/ui';
import { controller } from '@/lib/controller';
import { short, since } from '@/lib/diff';
import type { Review } from '@/lib/types';
import { getT } from '@/i18n/server';
import { requireSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

const STATUSES = ['awaiting_approval', 'approved', 'rejected', 'invalidated'];

export default async function ReviewsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [sp, , t] = await Promise.all([searchParams, requireSession(), getT()]);
  const raw = Array.isArray(sp.status) ? sp.status[0] : sp.status;
  const status = raw === 'all' ? undefined : STATUSES.includes(raw ?? '') ? raw : 'awaiting_approval';
  let items: Review[] | null = null;
  let error: string | null = null;
  try {
    items = await controller.reviews(status);
  } catch (e) {
    error = errorText(e, t);
  }
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>{t.reviews.title}</h1>
        <AutoRefresh seconds={10} />
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        {[...STATUSES, 'all'].map((s) => (
          <a key={s} href={`/reviews?status=${s}`} className={(status ?? 'all') === s ? 'badge info' : 'badge muted'}>{s}</a>
        ))}
      </div>
      {error && <Unavailable t={t} what={t.reviews.list} reason={error} />}
      {items && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>{t.common.task}</th><th>{t.common.project}</th><th>{t.common.agent}</th><th>{t.common.status}</th><th>{t.reviews.baseHead}</th><th>{t.common.created}</th><th>{t.reviews.decided}</th></tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td className="mono"><a href={`/reviews/${r.taskId}`}>{short(r.taskId, 8)}</a></td>
                  <td>{r.projectId}</td>
                  <td>{r.agent}</td>
                  <td><Badge value={r.status} /></td>
                  <td className="mono">{short(r.baseSha, 8)} → {short(r.headSha, 8)}</td>
                  <td title={r.createdAt}>{since(r.createdAt, t)}</td>
                  <td className="muted">{r.decidedBy ? `${r.decidedBy}, ${since(r.decidedAt, t)}` : r.invalidatedReason ?? '-'}</td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={7} className="muted">{t.reviews.nothing}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
