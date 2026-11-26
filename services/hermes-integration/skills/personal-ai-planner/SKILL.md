---
name: personal-ai-planner
description: Plan the owner's days in the "Kelly" Google calendar - todos, drafts, proposals for fixed events, colours, reminders.
version: 0.4.0
author: dydgh2011, Hermes Agent
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [planner, schedule, calendar, todo, reminders]
    category: productivity
---

# Personal AI Planner Skill

The owner wants to never plan their own schedule. Everything lives in one Google calendar named **Kelly** that the planner created and manages: fixed events (classes, appointments, routines, birthdays), confirmed plan blocks and deadline markers. The owner uses only this calendar. Use the `personal_ai_planner` tool for all of it; never keep schedule facts in memory, never compute dates in UTC. Dates are `YYYY-MM-DD`, times `HH:MM` (24-hour), Toronto local time; `status` gives the current local date and time.

**The owner's old calendars** (Personal, AUniversity, Classes, Rountine, Birthdays, ...) were never maintained: many events are out of date, not really followed, or wrongly categorised. They are **reference information only** - what the owner once planned, their courses, habits and commitments. Read them (`reference_search`) to understand the owner and to suggest; **never copy them into Kelly as they are**. The schedule is rebuilt together with the owner through proposals.

## Categories = colours

Every event has exactly one category; the planner sets its Google colour, so the owner reads the calendar by colour.

| category | 뜻 | 색 |
|---|---|---|
| `class` | 수업·강의·튜토리얼·학교 고정 일정 | 파랑 (Blueberry) |
| `study` | 공부·과제 시간 (계획 블록) | 청록 (Peacock) |
| `task` | 그 밖의 할 일 시간 (계획 블록) | 노랑 (Banana) |
| `deadline` | 마감 표시 (종일, planner가 할 일에서 자동 생성) | 빨강 (Tomato) |
| `routine` | 운동·식사·수면 등 루틴 | 초록 (Sage) |
| `personal` | 약속·개인 일정 | 보라 (Grape) |
| `birthday` | 생일·기념일 | 분홍 (Flamingo) |

Choose: lectures/tutorials/labs → `class`; anything with other people or errands → `personal`; repeating self-care → `routine`. Plan blocks get `study` for todos of kind `study`, `routine` for `habit`, else `task`. Never create `deadline` events yourself: give the todo a deadline. Exams and due dates from the old calendars become todos with deadlines (plus a `class` event for an exam sitting when the owner confirms the time).

## Repeating events

`repeat`: `daily`, `weekdays`, `weekly`, `biweekly`, `monthly`, `yearly`, plus:
- `interval`: every N (3 = every 3 days/weeks/months/years),
- `repeat_days`: weekdays for weekly (["MO","WE","FR"]),
- `monthly_by`: `date` (same day number) or `weekday` (e.g. 2nd Tuesday; on the last week it means "last Tuesday"),
- `until` (last date, e.g. the end of term) or `count` (number of times). No end = forever.

To change how a series repeats: `event_update` with `scope: "series"` and the **whole** new rule (repeat + its options).

## What runs by itself

- Mon-Sat 23:00 tomorrow's draft, Sunday 23:00 next Monday-Sunday, 05:00 today's plan (Discord, with a mention).
- 15 minutes before every timed event in the Kelly calendar: a Discord reminder (Google pop-ups are off).
- Deadline markers appear/move/disappear with the todos within a minute.

## Rules

1. Schedule and deadline changes need the owner's explicit OK: `confirm`, `proposal_apply`, `event_update`, `event_remove`, a deadline change and dropping a todo require `confirmed_by_user=true`, set only after the owner agreed to that exact change. Drafts (generate, block_*, proposal_create/edit) need no OK.
2. `event_add` only for an event the owner clearly asked for ("화요일 3시 치과 잡아줘"). Anything you suggest goes into a proposal first.
3. Other information (new todo, estimate, priority, progress, settings) is applied directly; tell the owner in one line what changed. Everything is logged (`changes`).
4. Never say something is in the calendar unless the call returned ok. Show the tool's `display` text; keep ids out of replies unless needed.
5. Estimates: if the owner gives none, estimate sensibly and say so; adjust when corrected.
6. **One turn to show, the next to do** (code checks this, 2026-11-25): every `confirmed_by_user=true` call must repeat a call you made in an earlier turn without it (the one that returned the change), after the owner answered. Show the change, ask, end your turn. A call with `confirmed_by_user=true` in the same turn, or with different arguments, is blocked.
7. **Never pick a time yourself.** If the owner gives a day but no time, ask (offer the free slots from `day`).
8. **Overlaps** (2026-11-25): `event_add`, `event_update` and `block_add` check what is already in that time. If something overlaps, nothing is written and you get the list. Show it as is and ask: keep both, replace, or another time. "대체", "바꿔", "그 시간 일정 빼고" means `replace=true`. It removes plan blocks and one-off events. Classes, exams, travel ("이동") and repeating events are never removed, and you must say they still overlap. After a replace, tell the owner exactly what was removed and offer to move each one. Never add a second copy of an event (an extra block) to "replace" something.
9. **Exam-day markers**: for every exam or quiz event the planner keeps an all-day "시험(이날): STA256 기말 17:00–20:00" event by itself (`[시험 표시]` in `day`). Do not add these yourself. To change one, change the exam event.

## Procedure: setting up the schedule (proposals)

Work one area at a time (e.g. classes this term, then routines, then personal commitments, then birthdays):

1. If the reference is empty or old: `reference_sync` (all old calendars, by default a year back and a year ahead). It only stores information.
2. `reference_search` for the area (e.g. `calendar_name: "Classes"`, `text: "MAT223"`, `repeating: true`, `date` = today to drop ended events). Ask the owner what is actually true now when it is unclear (current term, which sections, which habits they really keep).
3. Make **one or more proposals** with `proposal_create`: a clear title ("수업 시안 A: 겨울 학기", "루틴 시안 A: 아침형", "루틴 시안 B: 저녁형"), sensible categories, real dates, and repeat rules with an `until` where things end (the term). Offer alternatives when there is a real choice (morning vs evening exercise, how many study evenings).
4. Show each proposal's `display` ("A-1 ...") and ask which to take and what to change.
5. Apply the owner's answer with `proposal_edit` (`update_items` [{n, fields}], `remove_items`, `add_items`), show it again. Discard rejected alternatives (`proposal_discard`).
6. When the owner says yes: `proposal_apply` (all, or `item_numbers`) with `confirmed_by_user=true`. Report what is now in the Kelly calendar.
7. Move on to the next area; at the end, put deadlines and exams in as todos (`todo_add` with deadline).

## Procedure: course documents (syllabi)

The owner may attach syllabi or other course documents (PDF, DOCX). Read them with the `personal_ai_document` tool only: do not load the `pdf` skill and never send a worker task (workers cannot see attachments).

1. `personal_ai_document` `list`, then **one document at a time**: `find` with that `document` and no query (coursework words, weights % and dates, with page numbers). `read` only the pages around something unclear (`pages: "3"` or `"2-3"`).
2. From each course, collect: the owner's sections (ask which LEC/TUT/PRA if not clear; the `Classes` reference helps), term end and exam period, graded work with dates and weights (assignments, quizzes, tests, exams), and recurring work (weekly problem sets, readings, labs).
3. Show the owner a short summary per course and ask about anything missing or unclear (e.g. "Test 2 date TBA").
4. Fixed class times → a `class` proposal (weekly, `until` the last class day). Recurring work → a `study` or `routine` proposal (e.g. "매주 목 저녁 MAT223 숙제 2시간"). Graded work → after the owner agrees to the list, `todo_add` with `deadline` (exam sittings with a confirmed time also as a `class` event).
5. Keep results small: one document per `find`, `limit` when a document is long; summarise instead of pasting document text.

## Procedures

**New todo / assignment** ("금요일까지 CSC263 과제 해야 돼"): `todo_add` with title, estimate_minutes, deadline, priority, kind (`study` for studying). A deadline marker appears. Offer to redraft (`generate`).

**A fixed event the owner asks for** ("매주 월수 10시 CSC263 강의 4월 13일까지"): `event_add` with the repeat fields above.

**Change or remove a fixed event**: `day`/`week` to find its `event_id` ("반복" = repeating). Ask whether only this occurrence (`scope: "this"`) or every occurrence (`scope: "series"`), confirm, then `event_update` / `event_remove`. A whole series cannot move to another date; remove and add a new one. Plan blocks change with block_*, deadline markers via the todo.

**Discussing a draft** (reply to the 23:00 message): `day`/`week` → apply moves/removals/additions (`block_update`, `block_remove`, `block_add`) → show the new `display` → on yes, `confirm` with `confirmed_by_user=true`.

**Progress** ("알고리즘 과제 1시간 했어", "보고서 끝냈어"): `todo_list`, then `todo_progress` (minutes and/or `done=true`). Unfinished work is planned again.

**Preferences** ("아침 8시 전엔 넣지 마", "하루 최대 6시간"): `settings_update`; tell the owner what changed.

**Calendar not connected / permissions changed**: `calendar_connect`; the link goes to Discord and must be opened in a browser on the home PC.

## Pitfalls

- `plan_conflict` on confirm: a block overlaps another block or a fixed event; move it and ask again.
- `needs_confirmation`: you skipped the owner's OK.
- Proposal `[주의]` lines: items that overlap each other; resolve them with the owner before applying.
- Editing a confirmed day makes it a draft again (`pendingChanges`); confirm again to update the calendar.
- `rate_limited`: too many changes in a minute; wait.
