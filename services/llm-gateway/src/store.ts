import { DatabaseSync } from 'node:sqlite';
import { POOLS } from './config.js';

export const OWNER_TIME_ZONE = 'America/Toronto';

export function dayIn(timeZone: string, at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

export interface CallRecord {
  at: Date;
  client: string;
  alias: string;
  provider: string;
  model: string;
  pool: string | null;
  paid: boolean;
  status: number;
  outcome: 'ok' | 'error';
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  costUsd: number;
  listCostUsd: number;
  latencyMs: number;
  error: string | null;
}

/** Usage records, daily approvals and sent notices. One SQLite file; nothing here is secret. */
export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        local_day TEXT NOT NULL,
        client TEXT NOT NULL,
        alias TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        pool TEXT,
        pool_day TEXT,
        paid INTEGER NOT NULL,
        status INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL,
        cached_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        list_cost_usd REAL NOT NULL,
        latency_ms INTEGER NOT NULL,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS calls_pool ON calls(pool, pool_day);
      CREATE INDEX IF NOT EXISTS calls_day ON calls(local_day);
      CREATE TABLE IF NOT EXISTS approvals (
        day TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        at TEXT NOT NULL,
        by TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notices (
        key TEXT PRIMARY KEY,
        at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  poolDay(poolId: string, at: Date): string {
    return dayIn(POOLS[poolId].resetTimeZone, at);
  }

  record(c: CallRecord): void {
    this.db
      .prepare(
        `INSERT INTO calls (at, local_day, client, alias, provider, model, pool, pool_day, paid, status, outcome,
           prompt_tokens, cached_tokens, completion_tokens, cost_usd, list_cost_usd, latency_ms, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.at.toISOString(), dayIn(OWNER_TIME_ZONE, c.at), c.client, c.alias, c.provider, c.model, c.pool,
        c.pool ? this.poolDay(c.pool, c.at) : null, c.paid ? 1 : 0, c.status, c.outcome,
        c.promptTokens, c.cachedTokens, c.completionTokens, c.costUsd, c.listCostUsd, Math.round(c.latencyMs), c.error,
      );
  }

  /** Tokens (successful calls) and requests (every call that reached the provider) in the pool's current day. */
  poolUsage(poolId: string, at: Date): { tokens: number; requests: number; day: string } {
    const day = this.poolDay(poolId, at);
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN outcome = 'ok' THEN prompt_tokens + completion_tokens ELSE 0 END), 0) AS tokens,
                COUNT(*) AS requests
           FROM calls WHERE pool = ? AND pool_day = ? AND status > 0`,
      )
      .get(poolId, day) as { tokens: number; requests: number };
    return { tokens: Number(row.tokens), requests: Number(row.requests), day };
  }

  paidSpend(at: Date): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM calls WHERE paid = 1 AND local_day = ?`)
      .get(dayIn(OWNER_TIME_ZONE, at)) as { usd: number };
    return Number(row.usd);
  }

  approval(at: Date): { enabled: boolean; at: string | null; by: string | null } {
    const row = this.db.prepare(`SELECT enabled, at, by FROM approvals WHERE day = ?`).get(dayIn(OWNER_TIME_ZONE, at)) as
      | { enabled: number; at: string; by: string }
      | undefined;
    return row ? { enabled: row.enabled === 1, at: row.at, by: row.by } : { enabled: false, at: null, by: null };
  }

  setApproval(at: Date, enabled: boolean, by: string): void {
    this.db
      .prepare(`INSERT INTO approvals (day, enabled, at, by) VALUES (?, ?, ?, ?)
                ON CONFLICT(day) DO UPDATE SET enabled = excluded.enabled, at = excluded.at, by = excluded.by`)
      .run(dayIn(OWNER_TIME_ZONE, at), enabled ? 1 : 0, at.toISOString(), by);
  }

  /** True the first time a notice key is seen (so each warning goes out once). */
  firstNotice(key: string, at: Date): boolean {
    const res = this.db.prepare(`INSERT OR IGNORE INTO notices (key, at) VALUES (?, ?)`).run(key, at.toISOString());
    return Number(res.changes) === 1;
  }

  daily(days: number, at: Date): Array<Record<string, unknown>> {
    const from = new Date(at.getTime() - (days - 1) * 86_400_000);
    return this.db
      .prepare(
        `SELECT local_day AS day, alias, provider, model, COUNT(*) AS calls,
                SUM(CASE WHEN outcome = 'ok' THEN 1 ELSE 0 END) AS ok,
                SUM(prompt_tokens) AS prompt_tokens, SUM(cached_tokens) AS cached_tokens,
                SUM(completion_tokens) AS completion_tokens,
                ROUND(SUM(cost_usd), 6) AS cost_usd, ROUND(SUM(list_cost_usd), 6) AS list_cost_usd
           FROM calls WHERE local_day >= ? GROUP BY 1, 2, 3, 4 ORDER BY 1 DESC, 2, 3`,
      )
      .all(dayIn(OWNER_TIME_ZONE, from));
  }

  totalSpend(): number {
    const row = this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM calls`).get() as { usd: number };
    return Number(row.usd);
  }

  recentErrors(limit: number): Array<Record<string, unknown>> {
    return this.db
      .prepare(`SELECT at, client, alias, provider, model, status, error FROM calls WHERE outcome = 'error' ORDER BY id DESC LIMIT ?`)
      .all(limit);
  }
}
