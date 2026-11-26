// Logs that survive the container (same as services/planner/src/filelog.ts): every line goes to stdout and is appended to a JSON-lines file per day
// (UTC date) in the service's data volume (2026-11-26: planner and notifier logs were only on stdout and were lost when the
// container was recreated; owner rule "keep every record"). Files are only appended to, never rewritten or
// deleted. A file that cannot be written never stops the service: it says so once on stdout and keeps trying.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface LineLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export function jsonLinesLogger(dir: string | null, prefix: string, now: () => Date = () => new Date(), out: (line: string) => void = (l) => console.log(l)): LineLogger {
  let warned = false;
  let ready = false;
  const write = (level: 'info' | 'warn', msg: string, fields: Record<string, unknown> = {}) => {
    const at = now();
    const line = JSON.stringify({ ts: at.toISOString(), level, msg, ...fields });
    out(line);
    if (!dir) return;
    try {
      if (!ready) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        ready = true;
      }
      appendFileSync(join(dir, `${prefix}-${at.toISOString().slice(0, 10)}.jsonl`), `${line}\n`, { mode: 0o600 });
      warned = false;
    } catch (error) {
      if (!warned) out(JSON.stringify({ ts: at.toISOString(), level: 'warn', msg: 'Cannot write the log file; stdout only until it works again', dir, error: (error as Error).message }));
      warned = true;
    }
  };
  return { info: (msg, fields) => write('info', msg, fields), warn: (msg, fields) => write('warn', msg, fields) };
}
