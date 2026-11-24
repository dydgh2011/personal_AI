"""Schedule and comparison brief: code gathers every candidate, so the model never picks from one.

1. Upcoming: when the owner asks about dates, order or time left (시험, 마감, 언제, 제일 먼저, 얼마나
   남았어 ...), code lists every dated item it can find - future dates in course facts, open planner
   todos with a deadline, exam/deadline events in the planner's next two weeks - sorted, with the time
   left computed from now in Toronto time.
2. All courses: when the owner compares courses (어느 과목, 과목별, 모든 과목 ...) without naming one,
   every course page's summary is attached.
3. check(): for "first / next" questions, the answer must contain the date of the first matching item;
   if it does not, that item is appended under a fixed heading (store/planner text, not a model's).

Standard library only. Sources are read in parallel within a time budget and cached briefly; a source
that fails or is slow is left out and the block says so.
"""

from __future__ import annotations

import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

try:
    from . import knowledge_client as kc
except ImportError:  # loaded by path in tests
    import knowledge_client as kc  # type: ignore[no-redef]

def _toronto():
    """America/Toronto; without tz data (Windows Python) the same rule by hand: EDT (UTC-4) from the
    second Sunday of March 02:00 to the first Sunday of November 02:00, else EST (UTC-5)."""
    try:
        return ZoneInfo("America/Toronto")
    except Exception:  # noqa: BLE001 - ZoneInfoNotFoundError, missing tzdata
        from datetime import timezone, tzinfo

        class Toronto(tzinfo):
            def _dst(self, dt):
                if dt is None:
                    return False
                march = date(dt.year, 3, 8 + (6 - date(dt.year, 3, 8).weekday()) % 7)
                nov = date(dt.year, 11, 1 + (6 - date(dt.year, 11, 1).weekday()) % 7)
                naive = dt.replace(tzinfo=None)
                return datetime(march.year, march.month, march.day, 2) <= naive < datetime(nov.year, nov.month, nov.day, 2)

            def utcoffset(self, dt):
                return timedelta(hours=-4 if self._dst(dt) else -5)

            def dst(self, dt):
                return timedelta(hours=1 if self._dst(dt) else 0)

            def tzname(self, dt):
                return "EDT" if self._dst(dt) else "EST"

            def fromutc(self, dt):
                std = dt + timedelta(hours=-5)
                return std + timedelta(hours=1) if self._dst(std.replace(tzinfo=None)) else std

        _ = timezone
        return Toronto()


TZ = _toronto()
CACHE_TTL = 120          # seconds a source result is reused
BUDGET = 3.0             # seconds for all sources together (Hermes allows 8 for the whole prefetch, recall included)
MAX_ITEMS = 20
PLANNER_DAYS = 14
WEEKDAYS = "월화수목금토일"
HEADING = "📌 일정 기록 (답에서 빠진 가장 가까운 항목을 코드가 붙임)"

ASK_SCHEDULE = re.compile(
    r"언제|며칠|몇\s*일|얼마나\s*남|남았|남은|제일\s*(처음|먼저|빨리|가까|늦)|가장\s*(먼저|빠|가까|처음|늦)|"
    r"첫\s*(번째\s*)?(시험|기말|마감|과제)|다음\s*(시험|기말|마감|일정|과제|퀴즈)|순서|일정|마감|데드라인|"
    r"시험|기말|중간고사|퀴즈|과제|이번\s*주|다음\s*주|D-?day|deadline|due|exam|final|midterm|quiz", re.I)
ASK_FIRST = re.compile(r"제일\s*(처음|먼저|빨리|가까)|가장\s*(먼저|빠|가까|처음)|첫\s*(번째\s*)?|다음\s*(시험|기말|마감|일정|과제|퀴즈)|"
                       r"earliest|next", re.I)
ASK_COMPARE = re.compile(r"어느\s*과목|어떤\s*과목|모든\s*과목|전\s*과목|과목별|과목\s*중|과목들|각\s*과목|네\s*과목|"
                         r"다섯\s*과목|과목마다", re.I)
# Which items a "first/next X" question is about.
KINDS = [
    (re.compile(r"기말|final", re.I), re.compile(r"기말|final", re.I)),
    (re.compile(r"중간|midterm", re.I), re.compile(r"중간|midterm|Test\s*\d|Term Test", re.I)),
    (re.compile(r"퀴즈|quiz", re.I), re.compile(r"퀴즈|quiz", re.I)),
    (re.compile(r"시험|exam|test", re.I), re.compile(r"기말|중간|시험|exam|test|quiz|퀴즈|final|midterm", re.I)),
    (re.compile(r"마감|과제|deadline|due", re.I), re.compile(r"마감|과제|due|assignment|\bA\d\b|deadline", re.I)),
]
FACT_DATE = re.compile(r"(\d{4})-(\d{2})-(\d{2})(?:\([^)]{1,3}\))?(?:\s*(\d{1,2}):(\d{2})(?:\s*[–-]\s*(\d{1,2}):(\d{2}))?)?")
COURSE_CODE = re.compile(r"\b([A-Z]{3}\d{3})")
LABEL = re.compile(r"^(할 일 마감|캘린더)\s*·\s*(마감:\s*)?")   # the same deadline as a todo and as a calendar event
# Typed facts of these kinds are results, study material or routines, never upcoming items (even with a date in them).
NOT_UPCOMING = {"score", "mistake", "resource", "habit", "preference"}
EVENT_WORTH = re.compile(r"exam|test|quiz|final|midterm|시험|퀴즈|기말|중간|마감|due|deadline", re.I)

_lock = threading.Lock()
_cache: dict[str, tuple[float, Any]] = {}
_pending: dict[str, dict[str, Any]] = {}


def now() -> datetime:
    return datetime.now(TZ)


def _cached(key: str, fn):
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_TTL:
            return hit[1]
    value = fn()
    with _lock:
        _cache[key] = (time.time(), value)
    return value


def _planner():
    """planner_client + controller_client from the sibling plugin (same repository, read-only)."""
    sibling = Path(__file__).resolve().parent.parent / "personal-ai-controller"
    if str(sibling) not in sys.path:
        sys.path.append(str(sibling))
    import controller_client  # type: ignore[import-not-found]
    import planner_client  # type: ignore[import-not-found]

    import os
    return planner_client, controller_client.Client(controller_client.Config(dict(os.environ)))


# ---- sources ------------------------------------------------------------------------------------

def _courses(client) -> list[dict[str, Any]]:
    """Every course page with its facts."""
    def load():
        pages = [p for p in client.call("GET", "/pages", {"type": "course"}).get("pages", [])]
        return [client.call("GET", "/page", {"ref": p["slug"]}) for p in pages]
    return _cached("courses", load)


def _course_items(client) -> list[dict[str, Any]]:
    items = []
    today = now().date()
    for result in _courses(client):
        title = (result.get("page") or {}).get("title") or ""
        for f in result.get("facts") or []:
            if f.get("kind") in NOT_UPCOMING:
                continue
            text = str(f.get("text") or "")
            m = FACT_DATE.search(text)
            if not m:
                continue
            y, mo, d, h1, m1, h2, m2 = m.groups()
            try:
                day = date(int(y), int(mo), int(d))
            except ValueError:
                continue
            if day < today:
                continue
            start = f"{int(h1):02d}:{m1}" if h1 else None
            end = f"{int(h2):02d}:{m2}" if h2 else None
            label = text if len(text) <= 110 else text[:109] + "…"
            items.append({"date": day, "start": start, "end": end, "what": f"{title} · {label}", "source": "저장소"})
    return items


def _planner_items() -> list[dict[str, Any]]:
    def load():
        planner_client, pc = _planner()
        items = []
        for t in planner_client._get(pc, "/todos?status=open").get("todos", []):
            dl = str(t.get("deadline") or "")
            m = re.match(r"(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?", dl)
            if m:
                y, mo, d, h, mi = m.groups()
                items.append({"date": date(int(y), int(mo), int(d)), "start": f"{h}:{mi}" if h else None, "end": None,
                              "what": f"할 일 마감 · {t.get('title')}", "source": "플래너"})
        start = now().date()
        for week in range(0, PLANNER_DAYS, 7):
            data = planner_client._get(pc, f"/week?start={(start + timedelta(days=week)).isoformat()}")
            for day in data.get("days", []) if isinstance(data, dict) else []:
                for e in day.get("events", []):
                    title = str(e.get("title") or "")
                    if not (e.get("deadline") or e.get("category") == "deadline" or EVENT_WORTH.search(title)):
                        continue
                    y, mo, d = (int(x) for x in str(day["date"]).split("-"))
                    items.append({"date": date(y, mo, d), "start": None if e.get("allDay") else e.get("start"),
                                  "end": None if e.get("allDay") else e.get("end"),
                                  "what": f"캘린더 · {title}" + (f" · {e['location']}" if e.get("location") else ""),
                                  "source": "플래너"})
        return items
    return _cached("planner", load)


def _merge(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Sort by time; drop a calendar copy of an item the store already has (same day, start, course)."""
    items.sort(key=lambda i: (i["date"], i["start"] or "99:99", i["source"] != "저장소"))
    out, seen = [], set()
    for i in items:
        codes = COURSE_CODE.findall(i["what"])
        same = codes[0] if codes else re.sub(r"\s+", "", LABEL.sub("", i["what"]).split(" · ")[0]).lower()
        key = (i["date"], i["start"], same)
        if key in seen:
            continue
        seen.add(key)
        out.append(i)
    return out


def _gather(client) -> tuple[list[dict[str, Any]], list[str]]:
    missing = []
    with ThreadPoolExecutor(max_workers=2) as pool:
        jobs = {pool.submit(_course_items, client): "지식 저장소", pool.submit(_planner_items): "플래너"}
        done, not_done = wait(jobs, timeout=BUDGET)
        items: list[dict[str, Any]] = []
        for job in jobs:
            if job in done and job.exception() is None:
                items += job.result()
            else:
                missing.append(jobs[job])
    return _merge(items), missing


# ---- rendering ------------------------------------------------------------------------------------

def _when(i: dict[str, Any]) -> str:
    d = i["date"]
    s = f"{d.isoformat()}({WEEKDAYS[d.weekday()]})"
    if i["start"]:
        s += f" {i['start']}" + (f"–{i['end']}" if i["end"] else "")
    return s


def _left(i: dict[str, Any], at: datetime) -> str:
    h, m = (int(x) for x in (i["start"] or "00:00").split(":"))
    target = datetime(i["date"].year, i["date"].month, i["date"].day, h, m, tzinfo=TZ)
    delta = target - at
    if delta.total_seconds() < 0:
        return "진행 중이거나 지남" if i["start"] else "오늘"
    days, hours = delta.days, delta.seconds // 3600
    if not i["start"]:
        return f"{(i['date'] - at.date()).days}일 남음" if i["date"] != at.date() else "오늘"
    return f"{days}일 {hours}시간 남음" if days else f"{hours}시간 {delta.seconds % 3600 // 60}분 남음"


def _matching(query: str, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for ask, pick in KINDS:
        if ask.search(query):
            return [i for i in items if pick.search(i["what"])]
    return items


def brief(client, query: str, session_id: str = "") -> str:
    """Upcoming-items block and/or all-courses block for this message ('' when neither applies)."""
    with _lock:
        _pending.pop(session_id or "", None)
    if not query or not query.strip():
        return ""
    blocks = []
    at = now()
    if ASK_SCHEDULE.search(query):
        items, missing = _gather(client)
        stamp = f"{at.date().isoformat()}({WEEKDAYS[at.weekday()]}) {at:%H:%M} 토론토"
        lines = [f"## Upcoming (made by code: every dated item found, sorted; time left from now = {stamp}). "
                 "Compare all of them; never answer 'first/next' from one course."]
        for n, i in enumerate(items[:MAX_ITEMS], 1):
            lines.append(f"{n}. {_when(i)} · {i['what']} · {_left(i, at)}")
        if not items:
            lines.append("(앞으로 날짜가 있는 항목 없음)")
        if missing:
            lines.append(f"(읽지 못한 곳: {', '.join(missing)} - 이 목록이 전부가 아닐 수 있음)")
        blocks.append("\n".join(lines))
        if ASK_FIRST.search(query):
            pick = _matching(query, items)
            if pick:
                with _lock:
                    _pending[session_id or ""] = {"at": time.time(), "first": pick[0], "now": at}
    if ASK_COMPARE.search(query) and not COURSE_CODE.search(query.upper().replace(" ", "")):
        try:
            courses = _courses(client)
        except kc.KnowledgeError:
            courses = []
        if courses:
            lines = ["## All courses (made by code; compare every course before answering)"]
            for r in courses:
                p = r.get("page") or {}
                lines.append(f"- {p.get('title')}: {p.get('summary') or '(요약 없음)'}")
            blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def _date_forms(d: date) -> list[str]:
    return [d.isoformat(), f"{d.month:02d}-{d.day:02d}", f"{d.month}/{d.day}", f"{d.month:02d}/{d.day:02d}",
            f"{d.month}월{d.day}일", f"{d.month}월 {d.day}일"]


def check(response_text: str, session_id: str = "") -> str | None:
    """Answer plus the first matching item when a 'first/next' answer does not name its date."""
    with _lock:
        pending = _pending.pop(session_id or "", None)
    if not pending or not response_text or time.time() - pending["at"] > 900:
        return None
    first = pending["first"]
    if any(f in response_text for f in _date_forms(first["date"])):
        return None
    line = f"- 가장 가까운 항목: {_when(first)} · {first['what']} · {_left(first, pending['now'])}"
    return response_text.rstrip() + "\n\n" + HEADING + "\n" + line
