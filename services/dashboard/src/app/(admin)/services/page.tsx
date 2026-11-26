import { AutoRefresh } from '@/components/client';
import { requireSession } from '@/lib/server';
import { getT } from '@/i18n/server';
import { ageSeconds, STALE_AFTER_SECONDS } from '@/lib/service-map';
import { readServiceMap, serviceMapFile } from '@/lib/service-map-server';
import s from './services.module.css';
import { ServiceMapView } from './view';

export const dynamic = 'force-dynamic';

/**
 * Service map: every container of the stack, how they connect and how each is locked down.
 * Read-only. The data is a snapshot written every minute by the host collector
 * (services/service-map/collect.mjs); the dashboard has no Docker socket and no extra networks.
 */
export default async function Services() {
  const [map, , t] = await Promise.all([readServiceMap(), requireSession(), getT()]);
  const k = t.svc;
  const age = map.ok ? ageSeconds(map.snapshot, new Date()) : null;
  return (
    <div className={s.page}>
      <div className={s.header}>
        <h1>{k.title}</h1>
        <AutoRefresh seconds={60} />
      </div>
      {!map.ok ? (
        <section className="card">
          <h2>{k.noMap}</h2>
          <p className="muted">
            {map.code === 'missing'
              ? k.noSnapshot
              : k.unreadable(map.message)}
          </p>
          <p className="muted">{k.file(serviceMapFile())}</p>
        </section>
      ) : (
        <>
          {age !== null && age > STALE_AFTER_SECONDS && (
            <p className={s.stale} role="status">
              {k.staleBefore(Math.round(age / 60))}<code>PersonalAI\ServiceMap</code>{k.staleAfter}
            </p>
          )}
          <ServiceMapView snapshot={map.snapshot} ageSeconds={age ?? 0} />
        </>
      )}
    </div>
  );
}
