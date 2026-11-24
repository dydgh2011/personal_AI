#!/usr/bin/env python3
"""Propose a kind for every untyped fact in the knowledge store, by fixed word rules (no LLM).

The rules are the ones Kelly's plugin used before kinds existed (knowledge_client.MISTAKE,
course_brief.TOTAL_SCORE and INTENTS), plus a few for kinds those never picked (deadline,
habit, preference). Default is a dry run: it prints counts per proposed kind, sample ids with
short excerpts, and how the plugin's selections would change once the proposals are stored.

Read facts from a database copy (safest: a backup file, opened read-only):
    python services/hermes-integration/scripts/backfill_fact_kinds.py --db data/backups/knowledge/knowledge-YYYYMMDD.db
or from the operator API (compose.knowledge-operator.yaml, key from secrets/knowledge-operator.key):
    python services/hermes-integration/scripts/backfill_fact_kinds.py --api
Store the proposals (only after the owner approved the dry run; API only, one logged change per fact,
facts that already have a kind are never touched):
    python services/hermes-integration/scripts/backfill_fact_kinds.py --api --apply [--max N]

Standard library only. The key is never printed.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve()
ROOT = HERE.parents[3] if len(HERE.parents) > 3 else Path.cwd()   # the repository (services/hermes-integration/scripts)
PLUGIN_DIR = Path(__file__).resolve().parents[1] / "plugins" / "personal-ai-knowledge"

# The plugin's own modules, so the rules here are the ones Kelly uses (not a copy).
sys.path.insert(0, str(PLUGIN_DIR))
import course_brief as cb  # noqa: E402
import knowledge_client as kc  # noqa: E402

PREFERENCES_SLUG = "preferences"

# ---- rules (first match wins) -------------------------------------------------------------------

EXAM_WORD = re.compile(r"기말|중간|시험|퀴즈|exam|test|quiz|final|midterm", re.I)
DEADLINE_WORD = re.compile(r"마감|제출|due|deadline|과제|assignment|\bA\d\b|\bPS\d\b", re.I)
GRADING = re.compile(r"배점|비중|감점|성적\s*(산출|구성|비율)|grading|weight|late\s*penalty", re.I)
RESOURCE = re.compile(r"연습문제|Exercise|\d+\s*문제|교재|textbook|노트|notes|강의\s*자료|슬라이드|slides|문제집|practice", re.I)
HABIT_WORD = re.compile(r"매일|매주|아침마다|저녁마다|루틴|습관|every\s*(day|week)", re.I)
PREFERENCE_WORD = re.compile(r"^\s*선호|좋아해|싫어해|원해|prefers?\b", re.I)
SCORE_WORD = re.compile(r"test|quiz|퀴즈|시험|점수|score|midterm|final|기말|중간|과제|assignment|\bA\d\b|lab|점", re.I)
FRACTION = re.compile(r"(?<![\d./:-])(\d+(?:\.\d+)?)/(\d+(?:\.\d+)?)(?![\d/])")
DATE_AFTER = re.compile(r"\s*(\(|[월화수목금토일]\b|[월화수목금토일]\)|\d{1,2}:\d{2})")
DATED = re.compile(r"\b\d{4}-\d{2}-\d{2}\b|(?<![\d./])\d{1,2}/\d{1,2}(?=\s*[(월화수목금토일)]|\s+\d{1,2}:\d{2})")
TIME_RANGE = cb.INTENTS["exam"][2]


def _score(text: str) -> bool:
    """A result like 'Test 1은 10/15' or '11.5/25' (not a date like '(12/03 목)' or '12/16 09:00')."""
    if cb.TOTAL_SCORE.search(text):
        return True
    if not SCORE_WORD.search(text):
        return False
    for m in FRACTION.finditer(text):
        a, b = m.group(1), m.group(2)
        whole = "." not in a + b
        looks_like_date = whole and 1 <= int(a) <= 12 and 1 <= int(b) <= 31 and (
            text[max(0, m.start() - 1):m.start()] == "(" or DATE_AFTER.match(text, m.end()))
        if not looks_like_date:
            return True
    return False


RULES: list[tuple[str, str, Callable[[str, dict[str, Any]], bool]]] = [
    ("preference", "preferences-page", lambda t, p: p.get("slug") == PREFERENCES_SLUG),
    ("habit", "habit-page", lambda t, p: p.get("type") == "habit"),
    ("mistake", "mistake-words", lambda t, p: bool(kc.MISTAKE.search(t))),
    ("score", "score", lambda t, p: _score(t)),
    ("exam", "exam-date", lambda t, p: bool(EXAM_WORD.search(t)) and bool(TIME_RANGE.search(t) or DATED.search(t))),
    ("deadline", "deadline-date", lambda t, p: bool(DEADLINE_WORD.search(t)) and bool(DATED.search(t))),
    ("grading", "grading-words", lambda t, p: bool(GRADING.search(t))),
    ("resource", "resource-words", lambda t, p: bool(RESOURCE.search(t))),
    ("habit", "habit-words", lambda t, p: bool(HABIT_WORD.search(t))),
    ("preference", "preference-words", lambda t, p: bool(PREFERENCE_WORD.search(t))),
]


def propose(text: str, page: dict[str, Any]) -> tuple[str | None, str | None]:
    """(kind, rule name) for a fact's text on a page ({slug, type}); (None, None) when no rule fits."""
    for kind, rule, test in RULES:
        if test(text or "", page or {}):
            return kind, rule
    return None, None


# ---- what changes for the plugin ----------------------------------------------------------------

# Selections the plugin makes, as (name, kinds, word rule for untyped facts).
SELECTIONS = [
    ("recordedMistakes", ("mistake",), kc.MISTAKE),
    ("weak question", ("mistake", "score"), cb._weak_words),
    ("grading question", ("grading",), cb.INTENTS["grading"][2]),
    ("exam question", ("exam",), cb.INTENTS["exam"][2]),
    ("practice question", ("resource",), cb.INTENTS["practice"][2]),
]


def selection_changes(facts: list[dict[str, Any]], proposals: dict[str, str]) -> dict[str, dict[str, list[str]]]:
    """For each plugin selection: ids of facts that would newly be picked / no longer be picked once the
    proposed kinds are stored (the same fact before: untyped, after: typed)."""
    out: dict[str, dict[str, list[str]]] = {}
    for name, kinds, words in SELECTIONS:
        gained, lost = [], []
        for f in facts:
            kind = proposals.get(f["id"])
            if not kind:
                continue
            before = kc.fact_is({"text": f["text"]}, kinds, words)
            after = kc.fact_is({"text": f["text"], "kind": kind}, kinds, words)
            if after and not before:
                gained.append(f["id"])
            elif before and not after:
                lost.append(f["id"])
        out[name] = {"gained": gained, "lost": lost}
    return out


# ---- sources ------------------------------------------------------------------------------------

def facts_from_db(path: str) -> list[dict[str, Any]]:
    uri = Path(path).resolve().as_uri() + "?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    try:
        cols = {r[1] for r in con.execute("PRAGMA table_info(facts)")}
        kind = "f.kind" if "kind" in cols else "NULL"
        rows = con.execute(
            f"SELECT f.id, f.text, {kind}, p.slug, p.title, p.type FROM facts f JOIN pages p ON p.id = f.page_id "
            "WHERE f.status = 'active' AND p.archived = 0 ORDER BY f.created_at, f.id").fetchall()
    finally:
        con.close()
    return [{"id": r[0], "text": r[1], "kind": r[2], "page": {"slug": r[3], "title": r[4], "type": r[5]}} for r in rows]


class Api:
    def __init__(self, base: str, key_file: Path):
        self.base = base.rstrip("/")
        try:
            self.key = key_file.read_text(encoding="utf-8").strip()
        except OSError:
            sys.exit(f"Cannot read {key_file} (operator key). Nothing was changed.")

    def call(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        headers = {"X-Knowledge-Key": self.key, "Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as res:  # noqa: S310 - operator URL on this PC
                return json.loads(res.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", "replace")[:300]
            err.close()
            raise RuntimeError(f"HTTP {err.code} {path}: {detail}") from err
        except urllib.error.URLError as err:
            raise RuntimeError(f"Cannot reach {self.base} (is compose.knowledge-operator.yaml up?)") from err

    def facts(self) -> list[dict[str, Any]]:
        out, offset = [], 0
        while True:
            page = self.call("GET", f"/facts?limit=500&offset={offset}")
            out += page.get("facts", [])
            offset += 500
            if offset >= int(page.get("total") or 0):
                return out


# ---- report -------------------------------------------------------------------------------------

def excerpt(text: str, n: int = 32) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    return text if len(text) <= n else text[:n - 1] + "…"


def report(facts: list[dict[str, Any]], samples: int, excerpts: bool) -> tuple[dict[str, str], list[str]]:
    typed = Counter(f["kind"] for f in facts if f.get("kind"))
    untyped = [f for f in facts if not f.get("kind")]
    proposals: dict[str, str] = {}
    by_kind: dict[str, list[dict[str, Any]]] = defaultdict(list)
    rules = Counter()
    for f in untyped:
        kind, rule = propose(f["text"], f.get("page") or {})
        if kind:
            proposals[f["id"]] = kind
            rules[rule] += 1
        by_kind[kind or "(no rule: stays untyped)"].append(f)
    lines = [f"active facts: {len(facts)}  already typed: {sum(typed.values())}  untyped: {len(untyped)}"]
    if typed:
        lines.append("already typed (left as they are): " + ", ".join(f"{k} {n}" for k, n in sorted(typed.items())))
    lines.append("proposed kinds for untyped facts:")
    for kind in [*kc.FACT_KINDS, "(no rule: stays untyped)"]:
        group = by_kind.get(kind) or []
        if not group:
            continue
        lines.append(f"  {kind:<26} {len(group)}")
        for f in group[:samples]:
            page = (f.get("page") or {}).get("title") or ""
            lines.append(f"      {f['id']}  [{excerpt(page, 16)}] {excerpt(f['text']) if excerpts else ''}".rstrip())
    lines.append("rules used: " + ", ".join(f"{r} {n}" for r, n in rules.most_common()))
    lines.append("plugin selections after storing (gained = newly picked, lost = no longer picked):")
    for name, change in selection_changes(untyped, proposals).items():
        ids = lambda xs: (" e.g. " + ", ".join(xs[:samples])) if xs else ""
        lines.append(f"  {name:<18} gained {len(change['gained'])}{ids(change['gained'])}; lost {len(change['lost'])}{ids(change['lost'])}")
    return proposals, lines


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--db", help="a knowledge.db copy (opened read-only)")
    src.add_argument("--api", nargs="?", const="http://127.0.0.1:8793", help="operator API (default http://127.0.0.1:8793)")
    ap.add_argument("--key-file", default=str(ROOT / "secrets" / "knowledge-operator.key"))
    ap.add_argument("--apply", action="store_true", help="store the proposals (API only); default is a dry run")
    ap.add_argument("--max", type=int, default=0, help="with --apply: store at most this many (0 = all)")
    ap.add_argument("--samples", type=int, default=5, help="sample ids per kind (default 5)")
    ap.add_argument("--no-excerpts", action="store_true", help="ids only, no text excerpts")
    args = ap.parse_args(argv)
    if args.apply and not args.api:
        ap.error("--apply writes through the operator API only (use --api), never into a database file")

    api = Api(args.api, Path(args.key_file)) if args.api else None
    facts = api.facts() if api else facts_from_db(args.db)
    proposals, lines = report(facts, args.samples, not args.no_excerpts)
    print("\n".join(lines))
    if not args.apply:
        print("dry run: nothing was changed.")
        return 0
    todo = list(proposals.items())[: args.max or None]
    done = failed = 0
    for fact_id, kind in todo:
        try:
            result = api.call("POST", f"/facts/{fact_id}", {"kind": kind, "reason": "kind backfill (word rules)"})
            done += 1 if result.get("retyped") else 0
        except RuntimeError as err:
            failed += 1
            print(f"failed {fact_id}: {err}", file=sys.stderr)
    print(f"applied: {done} stored, {len(todo) - done - failed} unchanged, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
