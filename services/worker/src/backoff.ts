export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
}

/** Exponential backoff with "equal jitter": between half and all of the capped delay. */
export function backoffDelay(attempt: number, { baseMs, maxMs }: BackoffOptions, random = Math.random): number {
  const capped = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
  return Math.round(capped / 2 + (random() * capped) / 2);
}

/** Resolves after `ms`, or immediately when `signal` aborts. Never rejects. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}
