"""SQLite: every item seen (with its full text), what was sent to the owner, per-service state."""
from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone

from .items import Item


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def utc_iso(value: str, fallback: str) -> str:
    """The item's own time in UTC (for "last N days" by when it happened); fallback = when we first saw it."""
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return fallback
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, path: str):
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        with self.lock:
            self.db.executescript("""
                PRAGMA journal_mode = WAL;
                CREATE TABLE IF NOT EXISTS items (
                  service TEXT NOT NULL,
                  item_id TEXT NOT NULL,
                  kind TEXT NOT NULL,
                  course TEXT NOT NULL,
                  title TEXT NOT NULL,
                  url TEXT NOT NULL,
                  date TEXT NOT NULL,
                  body TEXT NOT NULL,
                  extra TEXT NOT NULL,
                  first_seen TEXT NOT NULL,
                  baseline INTEGER NOT NULL,
                  route TEXT NOT NULL,          -- now | digest | quiet | baseline
                  summary TEXT,
                  sent_at TEXT,
                  knowledge_id TEXT,
                  PRIMARY KEY (service, item_id)
                );
                CREATE INDEX IF NOT EXISTS items_seen ON items(first_seen);
                CREATE TABLE IF NOT EXISTS state (
                  service TEXT PRIMARY KEY,
                  data TEXT NOT NULL
                );
            """)
            cols = {r[1] for r in self.db.execute("PRAGMA table_info(items)")}
            if "at_utc" not in cols:
                self.db.execute("ALTER TABLE items ADD COLUMN at_utc TEXT")
                for r in self.db.execute("SELECT service, item_id, date, first_seen FROM items").fetchall():
                    self.db.execute("UPDATE items SET at_utc = ? WHERE service = ? AND item_id = ?",
                                    (utc_iso(r[2], r[3]), r[0], r[1]))
            self.db.execute("CREATE INDEX IF NOT EXISTS items_at ON items(at_utc)")
            self.db.executescript("""
                CREATE TABLE IF NOT EXISTS settings (
                  key TEXT PRIMARY KEY,
                  value TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  by TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS settings_history (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  key TEXT NOT NULL,
                  value TEXT NOT NULL,
                  at TEXT NOT NULL,
                  by TEXT NOT NULL
                );
                -- the owner's answer to each Quercus deadline (todo candidate): added to the planner or not needed
                CREATE TABLE IF NOT EXISTS deadline_decisions (
                  assignment TEXT PRIMARY KEY,   -- quercus:<assignment id>
                  decision TEXT NOT NULL,        -- added | dismissed
                  due TEXT NOT NULL,             -- the due date it was decided for (a moved due asks again)
                  todo_id TEXT,
                  note TEXT NOT NULL,
                  at TEXT NOT NULL,
                  by TEXT NOT NULL
                );
                -- every decision ever made, reopenings included (never deleted)
                CREATE TABLE IF NOT EXISTS deadline_history (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  assignment TEXT NOT NULL,
                  decision TEXT NOT NULL,        -- added | dismissed | pending (reopened)
                  due TEXT NOT NULL,
                  todo_id TEXT,
                  note TEXT NOT NULL,
                  at TEXT NOT NULL,
                  by TEXT NOT NULL
                );
            """)

    def close(self) -> None:
        self.db.close()

    def has(self, service: str, item_id: str) -> bool:
        with self.lock:
            return self.db.execute("SELECT 1 FROM items WHERE service = ? AND item_id = ?", (service, item_id)).fetchone() is not None

    def known_ids(self, service: str) -> set[str]:
        with self.lock:
            return {r[0] for r in self.db.execute("SELECT item_id FROM items WHERE service = ?", (service,))}

    def add(self, item: Item, baseline: bool, route: str) -> None:
        seen = now_iso()
        with self.lock:
            self.db.execute(
                """INSERT OR IGNORE INTO items (service, item_id, kind, course, title, url, date, body, extra, first_seen, baseline, route, at_utc)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (item.service, item.id, item.kind, item.course, item.title, item.url, item.date, item.body,
                 json.dumps(item.extra, ensure_ascii=False), seen, 1 if baseline else 0, route, utc_iso(item.date, seen)),
            )

    def set_knowledge_id(self, service: str, item_id: str, kid: str) -> None:
        with self.lock:
            self.db.execute("UPDATE items SET knowledge_id = ? WHERE service = ? AND item_id = ?", (kid, service, item_id))

    def without_knowledge(self, limit: int = 200) -> list[sqlite3.Row]:
        with self.lock:
            return self.db.execute("SELECT * FROM items WHERE knowledge_id IS NULL ORDER BY first_seen LIMIT ?", (limit,)).fetchall()

    def pending(self, route: str, limit: int = 200) -> list[sqlite3.Row]:
        with self.lock:
            return self.db.execute("SELECT * FROM items WHERE route = ? AND sent_at IS NULL ORDER BY first_seen LIMIT ?",
                                   (route, limit)).fetchall()

    def mark_sent(self, keys: list[tuple[str, str]], summaries: dict[tuple[str, str], str] | None = None) -> None:
        with self.lock:
            at = now_iso()
            for service, item_id in keys:
                summary = (summaries or {}).get((service, item_id))
                self.db.execute("UPDATE items SET sent_at = ?, summary = COALESCE(?, summary) WHERE service = ? AND item_id = ?",
                                (at, summary, service, item_id))

    def recent(self, since_iso: str, service: str | None, important_only: bool, limit: int) -> list[sqlite3.Row]:
        # by when it happened; items from before the connection that have no date of their own are left out
        sql = "SELECT * FROM items WHERE at_utc >= ? AND NOT (baseline = 1 AND date = '') AND route NOT IN ('quiet', 'ignored')"
        args: list = [since_iso]
        if service:
            sql += " AND service = ?"
            args.append(service)
        if important_only:
            sql += " AND route IN ('now', 'mail')"
        sql += " ORDER BY at_utc DESC LIMIT ?"
        args.append(limit)
        with self.lock:
            return self.db.execute(sql, args).fetchall()

    def get(self, service: str, item_id: str) -> sqlite3.Row | None:
        with self.lock:
            return self.db.execute("SELECT * FROM items WHERE service = ? AND item_id = ?", (service, item_id)).fetchone()

    def counts(self) -> dict[str, int]:
        with self.lock:
            return {r[0]: r[1] for r in self.db.execute("SELECT service, COUNT(*) FROM items GROUP BY service")}

    # ---- the owner's preferences (mail rules, summary style), every change kept ------------------
    def setting(self, key: str, default):
        with self.lock:
            row = self.db.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set_setting(self, key: str, value, by: str) -> None:
        data, at = json.dumps(value, ensure_ascii=False), now_iso()
        with self.lock:
            self.db.execute("""INSERT INTO settings (key, value, updated_at, by) VALUES (?, ?, ?, ?)
                               ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, by = excluded.by""",
                            (key, data, at, by))
            self.db.execute("INSERT INTO settings_history (key, value, at, by) VALUES (?, ?, ?, ?)", (key, data, at, by))

    def setting_history(self, key: str, limit: int = 20) -> list[dict]:
        with self.lock:
            rows = self.db.execute("SELECT value, at, by FROM settings_history WHERE key = ? ORDER BY id DESC LIMIT ?",
                                   (key, limit)).fetchall()
        return [{"value": json.loads(r[0]), "at": r[1], "by": r[2]} for r in rows]

    # ---- Quercus deadlines as todo candidates ------------------------------------------------
    def assignments(self) -> list[sqlite3.Row]:
        with self.lock:
            return self.db.execute("SELECT * FROM items WHERE service = 'quercus' AND kind = 'assignment' ORDER BY first_seen").fetchall()

    def deadline_decisions(self) -> dict[str, dict]:
        with self.lock:
            rows = self.db.execute("SELECT * FROM deadline_decisions").fetchall()
        return {r["assignment"]: dict(r) for r in rows}

    def decide_deadline(self, assignment: str, decision: str, due: str, todo_id: str | None, note: str, by: str) -> str:
        at = now_iso()
        with self.lock:
            if decision == "pending":
                self.db.execute("DELETE FROM deadline_decisions WHERE assignment = ?", (assignment,))
            else:
                self.db.execute("""INSERT INTO deadline_decisions (assignment, decision, due, todo_id, note, at, by)
                                   VALUES (?, ?, ?, ?, ?, ?, ?)
                                   ON CONFLICT(assignment) DO UPDATE SET decision = excluded.decision, due = excluded.due,
                                     todo_id = excluded.todo_id, note = excluded.note, at = excluded.at, by = excluded.by""",
                                (assignment, decision, due, todo_id, note, at, by))
            self.db.execute("""INSERT INTO deadline_history (assignment, decision, due, todo_id, note, at, by)
                               VALUES (?, ?, ?, ?, ?, ?, ?)""", (assignment, decision, due, todo_id, note, at, by))
        return at

    def deadline_history(self, assignment: str, limit: int = 20) -> list[dict]:
        with self.lock:
            rows = self.db.execute("SELECT decision, due, todo_id, note, at, by FROM deadline_history WHERE assignment = ? "
                                   "ORDER BY id DESC LIMIT ?", (assignment, limit)).fetchall()
        return [dict(r) for r in rows]

    def state(self, service: str) -> dict:
        with self.lock:
            row = self.db.execute("SELECT data FROM state WHERE service = ?", (service,)).fetchone()
        return json.loads(row[0]) if row else {}

    def save_state(self, service: str, data: dict) -> None:
        with self.lock:
            self.db.execute("INSERT INTO state (service, data) VALUES (?, ?) ON CONFLICT(service) DO UPDATE SET data = excluded.data",
                            (service, json.dumps(data, ensure_ascii=False)))
