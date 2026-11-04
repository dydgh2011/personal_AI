import type { WorkerReport } from './types';

/** Task result/error are JSON-encoded agent-worker/v1 reports; anything else is shown raw. */
export function parseReport(raw: string | null): WorkerReport | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && (value as { format?: unknown }).format === 'agent-worker/v1'
      ? (value as WorkerReport)
      : null;
  } catch {
    return null;
  }
}

/** A worker is "online" if it polled recently. Presence is in controller memory, so null = unknown. */
export function workerState(lastSeenAt: string | null, now = Date.now(), freshMs = 60_000): 'online' | 'stale' | 'unknown' {
  if (!lastSeenAt) return 'unknown';
  const age = now - Date.parse(lastSeenAt);
  if (!Number.isFinite(age)) return 'unknown';
  return age <= freshMs ? 'online' : 'stale';
}
