import { AutoRefresh } from '@/components/client';
import { requireSession } from '@/lib/server';
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
  const [map] = await Promise.all([readServiceMap(), requireSession()]);
  const age = map.ok ? ageSeconds(map.snapshot, new Date()) : null;
  return (
    <div className={s.page}>
      <div className={s.header}>
        <h1>Services</h1>
        <AutoRefresh seconds={60} />
      </div>
      {!map.ok ? (
        <section className="card">
          <h2>서비스 지도 없음</h2>
          <p className="muted">
            {map.code === 'missing'
              ? '아직 수집된 스냅샷이 없습니다. 호스트에서 수집기를 한 번 실행하세요: node services/service-map/collect.mjs'
              : `스냅샷을 읽을 수 없습니다 (${map.message}).`}
          </p>
          <p className="muted">파일: {serviceMapFile()}</p>
        </section>
      ) : (
        <>
          {age !== null && age > STALE_AFTER_SECONDS && (
            <p className={s.stale} role="status">
              수집이 멈췄습니다: 마지막 수집이 {Math.round(age / 60)}분 전입니다. 아래 상태는 그때 기준입니다. 작업 스케줄러의
              PersonalAI\ServiceMap 작업과 Docker Desktop을 확인하세요.
            </p>
          )}
          <ServiceMapView snapshot={map.snapshot} ageSeconds={age ?? 0} />
        </>
      )}
    </div>
  );
}
