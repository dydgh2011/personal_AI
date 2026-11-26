"""Planner actions for the Hermes tool `personal_ai_planner`.

Each action maps to one fixed planner route behind the hermes-broker (/planner/...). Inputs are
checked here for shape and again by the planner. Results are compact JSON plus a `display` text
(times are local Toronto time) that Hermes can show as is.
"""

from __future__ import annotations

import re
from typing import Any, Callable

try:
    from . import controller_client as client_lib
except ImportError:  # plain module (tests)
    import controller_client as client_lib  # type: ignore[no-redef]

CliError = client_lib.CliError

DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$|^24:00$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
EVENT_ID = re.compile(r"^[A-Za-z0-9_]{3,300}$")

# Same categories (and Google event colours) as the planner. deadline is managed by the planner.
CATEGORIES = ("class", "study", "task", "routine", "personal", "birthday")
CATEGORY_LABEL = {"class": "수업", "study": "공부", "task": "할 일", "deadline": "마감", "routine": "루틴",
                  "personal": "개인", "birthday": "생일·기념일"}
REPEATS = ("none", "daily", "weekdays", "weekly", "biweekly", "monthly", "yearly")

ACTIONS = (
    "day", "week", "generate", "confirm",
    "block_add", "block_update", "block_remove",
    "todo_list", "todo_add", "todo_update", "todo_progress",
    "event_add", "event_update", "event_remove",
    "calendars", "reference_sync", "reference_search",
    "proposal_create", "proposal_list", "proposal_show", "proposal_edit", "proposal_apply", "proposal_discard",
    "status", "settings_update", "changes", "calendar_connect",
)

SETTING_KEYS = ("dayStart", "dayEnd", "maxFocusMinutes", "breakMinutes", "maxBlockMinutes", "minBlockMinutes",
                "undatedDailyMinutes", "remindMinutes", "remindScope", "shortEventMinutes", "shortRemindMinutes",
                "sleepStart", "sleepEnd", "lastBus", "homePlace", "places", "travel", "protectedEvents")


def _bad(message: str) -> CliError:
    return CliError("usage_error", message)


def _date(args: dict[str, Any], key: str, required: bool = True) -> str | None:
    value = args.get(key)
    if value in (None, ""):
        if required:
            raise _bad(f"{key} is required (YYYY-MM-DD, local date)")
        return None
    if not isinstance(value, str) or not DATE.match(value):
        raise _bad(f"{key} must be a date YYYY-MM-DD")
    return value


def _time(args: dict[str, Any], key: str, required: bool = True) -> str | None:
    value = args.get(key)
    if value in (None, ""):
        if required:
            raise _bad(f"{key} is required (HH:MM, 24-hour local time)")
        return None
    if not isinstance(value, str) or not TIME.match(value):
        raise _bad(f"{key} must be a time HH:MM (24-hour)")
    return value


def _id(args: dict[str, Any], key: str) -> str:
    value = args.get(key)
    if not isinstance(value, str) or not UUID.match(value):
        raise _bad(f"{key} must be the id shown by day/todo_list")
    return value


def _confirmed(args: dict[str, Any], what: str) -> None:
    if args.get("confirmed_by_user") is not True:
        raise CliError("needs_confirmation",
                       f"{what} needs the user's explicit OK. Show the change, ask, and call again with "
                       "confirmed_by_user=true only after the user agreed.")


def _pick(args: dict[str, Any], mapping: dict[str, str]) -> dict[str, Any]:
    """Tool argument names (snake_case) -> planner field names, only those given."""
    return {target: args[source] for source, target in mapping.items() if source in args and args[source] is not None}


# ---- display -----------------------------------------------------------------------------

def _day_lines(day: dict[str, Any]) -> list[str]:
    status = {"none": "계획 없음", "draft": "초안(미확정)", "confirmed": "확정"}.get(day.get("status"), day.get("status"))
    head = f"{day['date']}({day.get('weekday', '')}) {status}"
    if day.get("pendingChanges"):
        head += " - 캘린더에 아직 반영 안 된 변경 있음"
    rows: list[tuple[str, str]] = []
    for e in day.get("events", []):
        marker = e.get("deadline") or e.get("examMarker")
        label = ("마감·이날까지" if e.get("deadline") else "시험 표시" if e.get("examMarker")
                 else CATEGORY_LABEL.get(e.get("category") or "", "일정"))
        when = "종일" if e.get("allDay") else f"{e['start']}-{e['end']}"
        ref = "" if marker else f" (event_id {e['id']}{', 반복' if e.get('seriesId') else ''})"
        rows.append(("00:00" if e.get("allDay") else e.get("start") or "00:00", f"  [{label}] {when} {e['title']}{ref}"))
    for b in day.get("blocks", []):
        label = CATEGORY_LABEL.get(b.get("category") or "", "할 일")
        rows.append((b["start"], f"  [계획·{label}] {b['start']}-{b['end']} {b['title']} (block_id {b['id']})"))
    rows.sort(key=lambda r: r[0])
    lines = [head] + [r[1] for r in rows]
    if not rows:
        lines.append("  (비어 있음)")
    for u in day.get("unscheduled", []):
        lines.append(f"  [못 넣음] {u['title']} {u['minutes']}분")
    for w in day.get("warnings", []):
        lines.append(f"  [주의] {w}")
    if not day.get("calendarConnected"):
        lines.append("  (Google Calendar 미연결: calendar_connect)")
    return lines


def _days(result: dict[str, Any]) -> dict[str, Any]:
    days = result.get("days", [])
    return {"ok": True, "days": days, "display": "\n".join(line for d in days for line in _day_lines(d))}


def _todo_line(t: dict[str, Any]) -> str:
    left = max(0, t["estimateMinutes"] - t["doneMinutes"])
    parts = [f"{t['title']}", f"남은 {left}분/{t['estimateMinutes']}분"]
    if t.get("deadline"):
        parts.append(f"마감 {t['deadline']}")
    parts.append(f"우선순위 {t['priority']}")
    if t.get("status") != "open":
        parts.append(t["status"])
    return " · ".join(parts) + f" (todo_id {t['id']})"


# ---- actions -----------------------------------------------------------------------------

def _get(client, path: str) -> Any:
    return client.request("GET", "/planner" + path)[2]


def _post(client, path: str, body: dict[str, Any] | None = None) -> Any:
    # Planner writes are not retried automatically (a retry could add a todo twice).
    return client.request("POST", "/planner" + path, body or {}, retry=False)[2]


def a_day(client, args):
    date = _date(args, "date", required=False)
    day = _get(client, "/day" + (f"?date={date}" if date else ""))
    return {"ok": True, "day": day, "display": "\n".join(_day_lines(day))}


def a_week(client, args):
    start = _date(args, "date", required=False)
    return _days(_get(client, "/week" + (f"?start={start}" if start else "")))


def a_generate(client, args):
    body = {"date": _date(args, "date")}
    if args.get("days") is not None:
        body["days"] = args["days"]
    out = _days(_post(client, "/plans/generate", body))
    out["note"] = "Draft only: nothing is in Google Calendar until the user confirms (action confirm)."
    return out


def a_confirm(client, args):
    dates = args.get("dates") or ([args["date"]] if args.get("date") else None)
    if not isinstance(dates, list) or not dates or not all(isinstance(d, str) and DATE.match(d) for d in dates):
        raise _bad("dates must list the dates to confirm (YYYY-MM-DD)")
    _confirmed(args, "Confirming a plan (it is written to Google Calendar)")
    out = _days(_post(client, "/plans/confirm", {"dates": dates}))
    out["note"] = "Confirmed and written to Google Calendar. Reminders go out before each event."
    return out


def _minutes(t: str) -> int:
    h, m = t.split(":")
    return int(h) * 60 + int(m)


def a_block_add(client, args):
    body = {"date": _date(args, "date"), "start": _time(args, "start"), "end": _time(args, "end")}
    body.update(_pick(args, {"title": "title", "todo_id": "todoId"}))
    if args.get("confirmed_by_user") is not True:
        day = _get(client, f"/day?date={body['date']}")
        lo, hi = _minutes(body["start"]), _minutes(body["end"])
        overlaps = [{"start": x["start"], "end": x["end"], "title": x["title"], "replaceable": False}
                    for x in day.get("events", []) + day.get("blocks", [])
                    if not x.get("allDay") and x.get("start") and x.get("end") and _minutes(x["start"]) < hi and lo < _minutes(x["end"])]
        if overlaps:
            raise CliError("needs_confirmation",
                           f"A plan block {body['start']}-{body['end']} on {body['date']} overlaps:\n" + "\n".join(
                               f"  {o['start']}-{o['end']} {o['title']}" for o in overlaps) +
                           "\nNothing was written. To put something IN PLACE of these, use event_add/event_update with "
                           "replace=true instead of a block. Otherwise show the owner the list, ask, end your turn, and call "
                           "again with confirmed_by_user=true only if they want both.")
    return {"ok": True, **_post(client, "/blocks", body), "note": "Added to the draft; confirm to write it to the calendar."}


def a_block_update(client, args):
    block_id = _id(args, "block_id")
    body = {}
    if args.get("date"):
        body["date"] = _date(args, "date")
    for key in ("start", "end"):
        if args.get(key):
            body[key] = _time(args, key)
    if args.get("title"):
        body["title"] = args["title"]
    if not body:
        raise _bad("give date, start, end or title to change")
    return {"ok": True, **_post(client, f"/blocks/{block_id}/update", body),
            "note": "Changed in the draft; confirm to write it to the calendar."}


def a_block_remove(client, args):
    block_id = _id(args, "block_id")
    _post(client, f"/blocks/{block_id}/remove")
    return {"ok": True, "removed": block_id, "note": "Removed from the draft; confirm to remove it from the calendar too."}


def a_todo_list(client, args):
    status = args.get("status") or "open"
    if status not in ("open", "done", "all"):
        raise _bad("status must be open, done or all")
    todos = _get(client, f"/todos?status={status}")["todos"]
    return {"ok": True, "todos": todos, "display": "\n".join(_todo_line(t) for t in todos) or "(할 일 없음)"}


TODO_FIELDS = {"title": "title", "notes": "notes", "kind": "kind", "priority": "priority",
               "estimate_minutes": "estimateMinutes", "deadline": "deadline", "earliest": "earliest"}


def a_todo_add(client, args):
    if not args.get("title") or args.get("estimate_minutes") is None:
        raise _bad("todo_add needs title and estimate_minutes (ask the user or estimate sensibly and say so)")
    todo = _post(client, "/todos", _pick(args, TODO_FIELDS))["todo"]
    return {"ok": True, "todo": todo, "display": _todo_line(todo),
            "note": "Saved. It is planned into the next draft (generate) or the 23:00 draft."}


def a_todo_update(client, args):
    todo_id = _id(args, "todo_id")
    body = _pick(args, {**TODO_FIELDS, "status": "status"})
    if not body:
        raise _bad("nothing to change")
    if "deadline" in body or body.get("status") == "archived":
        _confirmed(args, "Changing a deadline or dropping a todo")
    todo = _post(client, f"/todos/{todo_id}/update", body)["todo"]
    return {"ok": True, "todo": todo, "display": _todo_line(todo)}


def a_todo_progress(client, args):
    todo_id = _id(args, "todo_id")
    body = _pick(args, {"minutes": "minutes", "done": "done"})
    todo = _post(client, f"/todos/{todo_id}/progress", body)["todo"]
    return {"ok": True, "todo": todo, "display": _todo_line(todo)}


# ---- fixed events (classes, appointments, routines, birthdays) ----------------------------

def _category(args: dict[str, Any], required: bool) -> str | None:
    value = args.get("category")
    if value is None:
        if required:
            raise _bad(f"category is required: one of {', '.join(CATEGORIES)}")
        return None
    if value not in CATEGORIES:
        raise _bad(f"category must be one of {', '.join(CATEGORIES)}")
    return value


def _event_id(args: dict[str, Any]) -> str:
    value = args.get("event_id")
    if not isinstance(value, str) or not EVENT_ID.match(value):
        raise _bad("event_id must be an event_id shown by day/week")
    return value


# Tool argument (snake_case) -> planner field. The same names inside proposal items.
EVENT_KEYS = {"title": "title", "date": "date", "start": "start", "end": "end", "end_date": "endDate",
              "all_day": "allDay", "category": "category", "location": "location", "notes": "notes",
              "repeat": "repeat", "interval": "interval", "repeat_days": "repeatDays", "monthly_by": "monthlyBy",
              "until": "until", "count": "count"}
REPEAT_KEYS = ("interval", "repeat_days", "monthly_by", "until", "count")


def _event_fields(src: dict[str, Any], where: str, partial: bool = False) -> dict[str, Any]:
    """Checks and renames one event's fields (event_add, proposal items). The planner validates again."""
    unknown = [k for k in src if k not in EVENT_KEYS and k != "n"]
    if unknown:
        raise _bad(f"{where}: unknown fields {', '.join(unknown)} (use {', '.join(EVENT_KEYS)})")
    out: dict[str, Any] = {}
    for key, target in EVENT_KEYS.items():
        if key not in src or src[key] is None:
            continue
        value = src[key]
        if key in ("date", "end_date", "until") and not (isinstance(value, str) and DATE.match(value)):
            raise _bad(f"{where}: {key} must be a date YYYY-MM-DD")
        if key in ("start", "end") and not (isinstance(value, str) and TIME.match(value)):
            raise _bad(f"{where}: {key} must be a time HH:MM (24-hour)")
        if key == "category" and value not in CATEGORIES:
            raise _bad(f"{where}: category must be one of {', '.join(CATEGORIES)}")
        if key == "repeat" and value not in REPEATS:
            raise _bad(f"{where}: repeat must be one of {', '.join(REPEATS)}")
        out[target] = value
    if out.get("repeat") == "none":
        del out["repeat"]
    if not partial:
        for need in ("title", "date", "category"):
            if need not in out:
                raise _bad(f"{where}: {need} is required")
        if not out.get("allDay") and ("start" not in out or "end" not in out):
            raise _bad(f"{where}: give start and end, or all_day=true")
    return out


# ---- overlaps: never put something on top of the owner's plan without asking (2026-11-25) ------------

KEEP_NOTE = "그대로 둠: 수업·시험·이동·반복 일정"


def _overlap_lines(overlaps: list[dict[str, Any]]) -> list[str]:
    return [f"  {o['start']}-{o['end']} {o['title']}" + ("" if o.get("replaceable") else f" ({KEEP_NOTE})") for o in overlaps]


def _replace_flag(args: dict[str, Any]) -> bool:
    value = args.get("replace", False)
    if not isinstance(value, bool):
        raise _bad("replace must be true or false")
    return value


def _overlap_question(what: str, overlaps: list[dict[str, Any]]) -> CliError:
    return CliError(
        "needs_confirmation",
        f"{what} overlaps what is already planned:\n" + "\n".join(_overlap_lines(overlaps)) +
        "\nNothing was written. Show the owner this exact list (times and titles) and ask which they want: keep both, "
        "replace (replace=true removes every item not marked '그대로 둠'), or another time. End your turn and wait. "
        "After they answer, call again with the same arguments, confirmed_by_user=true, and replace=true only if they "
        "said replace. Never pick the time or the replacement yourself.")


def _replaced_lines(result: dict[str, Any]) -> list[str]:
    lines = []
    replaced = result.get("replaced") or []
    if replaced:
        lines.append("대체해서 지운 것 (기록에 남음, 다시 넣을 수 있음):")
        lines += _overlap_lines(replaced)
    kept = [o for o in result.get("overlaps") or [] if o["id"] not in {r["id"] for r in replaced}]
    if kept:
        lines.append("아직 겹치는 것:")
        lines += _overlap_lines(kept)
    return lines


def a_event_add(client, args):
    body = _event_fields({k: args[k] for k in EVENT_KEYS if k not in ("replace",) and k in args}, "event_add")
    replace = _replace_flag(args)
    if not body.get("allDay"):
        preview = _post(client, "/events", {**body, "dryRun": True})["event"]
        if preview["overlaps"] and args.get("confirmed_by_user") is not True:
            raise _overlap_question(f"{body['title']} ({preview['when']})", preview["overlaps"])
    event = _post(client, "/events", {**body, "replace": True} if replace else body)["event"]
    lines = [f"{event['title']} · {event['when']} ({CATEGORY_LABEL.get(event['category'])})"] + _replaced_lines(event)
    note = "Added to the Kelly calendar (Google Calendar). Plans now work around it."
    if event.get("replaced"):
        note += " Tell the owner what was removed and ask whether to move any of it to another time."
    return {"ok": True, "event": event, "display": "\n".join(lines), "note": note}


def a_event_update(client, args):
    event_id = _event_id(args)
    body: dict[str, Any] = {"scope": args.get("scope") or "this"}
    body.update(_event_fields({k: args[k] for k in EVENT_KEYS if k in args and k not in ("end_date", "all_day")},
                              "event_update", partial=True))
    if len(body) == 1:
        raise _bad("give what to change: date, start, end, title, category, location, notes or the repeat rule")
    replace = _replace_flag(args)
    if args.get("confirmed_by_user") is not True:
        preview = _post(client, f"/events/{event_id}/update", {**body, "dryRun": True})["event"]
        change = ", ".join(f"{k}={v}" for k, v in body.items() if k != "scope")
        if preview["overlaps"]:
            raise _overlap_question(f"Changing event {event_id} ({change})", preview["overlaps"])
        _confirmed(args, f"Changing a calendar event ({change})")
    result = _post(client, f"/events/{event_id}/update", {**body, "replace": True} if replace else body)["event"]
    return {"ok": True, "event": result, "display": "\n".join(["변경함"] + _replaced_lines(result))}


def a_event_remove(client, args):
    event_id = _event_id(args)
    _confirmed(args, "Removing a calendar event")
    return {"ok": True, **_post(client, f"/events/{event_id}/remove", {"scope": args.get("scope") or "this"})}


# ---- reference: the owner's old calendars (information only) ------------------------------

def a_calendars(client, args):
    cals = _get(client, "/calendars")["calendars"]
    return {"ok": True, "calendars": cals, "display": "\n".join(c["name"] + (" (기본)" if c.get("primary") else "") for c in cals)}


def a_reference_sync(client, args):
    body: dict[str, Any] = {}
    if args.get("calendars"):
        if not isinstance(args["calendars"], list) or not all(isinstance(c, str) for c in args["calendars"]):
            raise _bad("calendars must be a list of calendar names (see action calendars)")
        body["calendars"] = args["calendars"]
    if args.get("date"):
        body["from"] = _date(args, "date")
    if args.get("until"):
        body["to"] = _date(args, "until")
    out = _post(client, "/reference/sync", body)
    lines = [f"{c['name']}: {c['events']}개 (반복 {c['repeating']}개)" for c in out["calendars"]]
    return {"ok": True, **out, "display": "\n".join(lines),
            "note": "Saved as reference only (nothing was added to the Kelly calendar). Use reference_search to study it."}


def a_reference_search(client, args):
    body = _pick(args, {"text": "text", "repeating": "repeating", "limit": "limit"})
    if args.get("calendar_name"):
        body["calendar"] = args["calendar_name"]
    if args.get("date"):
        body["from"] = _date(args, "date")
    if args.get("until"):
        body["to"] = _date(args, "until")
    out = _post(client, "/reference/search", body)
    lines = [f"[{i['calendar']}] {i['title']} · {i['when']}" + (f" · {i['location']}" if i.get("location") else "")
             for i in out["items"]]
    more = f"\n(외 {out['total'] - len(out['items'])}개)" if out["total"] > len(out["items"]) else ""
    return {"ok": True, **out, "display": ("\n".join(lines) or "(없음)") + more,
            "note": "Old, unreliable data: use it to understand the owner and to suggest; never copy it as is."}


# ---- proposals: drafts of fixed events the owner picks from --------------------------------

CODE = re.compile(r"^[A-Z]{1,3}$")


def _code(args: dict[str, Any]) -> str:
    value = str(args.get("proposal") or "").strip().upper()
    if not CODE.match(value):
        raise _bad("proposal must be a proposal code such as A or B (see proposal_list)")
    return value


def _items(value: Any, where: str, partial: bool = False) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not value:
        raise _bad(f"{where} must list events")
    out = []
    for i, item in enumerate(value, 1):
        if not isinstance(item, dict):
            raise _bad(f"{where}[{i}] must be an event object")
        fields = _event_fields(item, f"{where}[{i}]", partial)
        if partial:
            if not isinstance(item.get("n"), int):
                raise _bad(f"{where}[{i}] needs n, the item number")
            fields = {"n": item["n"], **fields}
        out.append(fields)
    return out


def _proposal_display(p: dict[str, Any]) -> str:
    status = {"draft": "시안", "applied": "캘린더에 반영됨", "discarded": "버림"}.get(p["status"], p["status"])
    lines = [f"시안 {p['code']}: {p['title']} ({status})"]
    if p.get("notes"):
        lines.append(f"  {p['notes']}")
    for i in p["items"]:
        mark = " ✅" if i.get("applied") else ""
        where = f" · {i['location']}" if i.get("location") else ""
        lines.append(f"  {p['code']}-{i['n']} [{CATEGORY_LABEL.get(i['category'], i['category'])}] {i['title']} · {i['when']}{where}{mark}")
    for w in p.get("warnings", []):
        lines.append(f"  [주의] {w}")
    return "\n".join(lines)


def a_proposal_create(client, args):
    if not args.get("title"):
        raise _bad("title is required, e.g. '루틴 시안 A: 아침형'")
    body = {"title": args["title"], "items": _items(args.get("items"), "items")}
    if args.get("notes"):
        body["notes"] = args["notes"]
    p = _post(client, "/proposals", body)["proposal"]
    return {"ok": True, "proposal": p, "display": _proposal_display(p),
            "note": "Draft only: show it and let the owner choose or change items. Nothing is in the calendar yet."}


def a_proposal_list(client, args):
    status = "all" if args.get("status") == "all" else "draft"
    ps = _get(client, f"/proposals?status={status}")["proposals"]
    return {"ok": True, "proposals": ps,
            "display": "\n".join(f"시안 {p['code']}: {p['title']} ({p['items']}개, 반영 {p['applied']}개, {p['status']})" for p in ps) or "(시안 없음)"}


def a_proposal_show(client, args):
    p = _get(client, f"/proposals/{_code(args)}")["proposal"]
    return {"ok": True, "proposal": p, "display": _proposal_display(p)}


def a_proposal_edit(client, args):
    code = _code(args)
    body: dict[str, Any] = _pick(args, {"title": "title", "notes": "notes"})
    if args.get("add_items"):
        body["add"] = _items(args["add_items"], "add_items")
    if args.get("update_items"):
        body["update"] = _items(args["update_items"], "update_items", partial=True)
    if args.get("remove_items"):
        if not isinstance(args["remove_items"], list) or not all(isinstance(n, int) for n in args["remove_items"]):
            raise _bad("remove_items must list item numbers")
        body["remove"] = args["remove_items"]
    if not body:
        raise _bad("give title, notes, add_items, update_items or remove_items")
    p = _post(client, f"/proposals/{code}/edit", body)["proposal"]
    return {"ok": True, "proposal": p, "display": _proposal_display(p)}


def a_proposal_apply(client, args):
    code = _code(args)
    body: dict[str, Any] = {}
    if args.get("item_numbers"):
        if not isinstance(args["item_numbers"], list) or not all(isinstance(n, int) for n in args["item_numbers"]):
            raise _bad("item_numbers must list item numbers")
        body["items"] = args["item_numbers"]
    _confirmed(args, "Writing a proposal into the Kelly calendar")
    p = _post(client, f"/proposals/{code}/apply", body)["proposal"]
    return {"ok": True, "proposal": p, "display": _proposal_display(p),
            "note": f"Written to the Kelly calendar: {', '.join(str(w['n']) for w in p.get('written', []))}."}


def a_proposal_discard(client, args):
    return {"ok": True, **_post(client, f"/proposals/{_code(args)}/discard")}


def a_status(client, args):
    return {"ok": True, **_get(client, "/status")}


def a_settings_update(client, args):
    settings = args.get("settings")
    if not isinstance(settings, dict) or not settings:
        raise _bad(f"settings must be an object with some of: {', '.join(SETTING_KEYS)}")
    unknown = [k for k in settings if k not in SETTING_KEYS]
    if unknown:
        raise _bad(f"unknown settings: {', '.join(unknown)}")
    return {"ok": True, **_post(client, "/settings", settings), "note": "Saved and logged; tell the user what changed."}


def a_changes(client, args):
    limit = args.get("limit") or 20
    return {"ok": True, **_get(client, f"/changes?limit={int(limit)}")}


def a_calendar_connect(client, args):
    out = _post(client, "/calendar/connect")
    return {"ok": True, **out,
            "note": "The sign-in link was posted to Discord. The user must open it in a browser on the home PC "
                    "(Google sends them back to http://127.0.0.1). Share the link only with the user."}


HANDLERS: dict[str, Callable[[Any, dict[str, Any]], dict[str, Any]]] = {
    "day": a_day, "week": a_week, "generate": a_generate, "confirm": a_confirm,
    "block_add": a_block_add, "block_update": a_block_update, "block_remove": a_block_remove,
    "todo_list": a_todo_list, "todo_add": a_todo_add, "todo_update": a_todo_update, "todo_progress": a_todo_progress,
    "event_add": a_event_add, "event_update": a_event_update, "event_remove": a_event_remove,
    "calendars": a_calendars, "reference_sync": a_reference_sync, "reference_search": a_reference_search,
    "proposal_create": a_proposal_create, "proposal_list": a_proposal_list, "proposal_show": a_proposal_show,
    "proposal_edit": a_proposal_edit, "proposal_apply": a_proposal_apply, "proposal_discard": a_proposal_discard,
    "status": a_status, "settings_update": a_settings_update, "changes": a_changes, "calendar_connect": a_calendar_connect,
}
