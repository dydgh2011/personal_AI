---
name: personal-ai-planner
description: Plan the owner's days in the "Kelly" Google calendar - todos, drafts, proposals for fixed events, colours, reminders.
version: 0.5.0
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

Choose: lectures/tutorials/labs → `class`; anything with other people or errands → `personal`; repeating self-care → `routine`. Plan blocks get `study` for todos of kind `study`, `routine` for `habit`, else `task`. Never create `deadline` events yourself: give the todo a deadline. **Exams, tests and quizzes are events, not todos** (2026-11-26): the sitting is an `event_add` with category `class` at its real time; only the preparation is a todo ("STA256 기말 대비", deadline before the sitting). Due dates of assignments are todos with deadlines. If `todo_add` returns a `[주의]` warning about an exam-like title, tell the owner and offer to add the sitting as an event and archive that todo.

## Repeating events

`repeat`: `daily`, `weekdays`, `weekly`, `biweekly`, `monthly`, `yearly`, plus:
- `interval`: every N (3 = every 3 days/weeks/months/years),
- `repeat_days`: weekdays for weekly (["MO","WE","FR"]),
- `monthly_by`: `date` (same day number) or `weekday` (e.g. 2nd Tuesday; on the last week it means "last Tuesday"),
- `until` (last date, e.g. the end of term) or `count` (number of times). No end = forever.

To change how a series repeats: `event_update` with `scope: "series"` and the **whole** new rule (repeat + its options).

## What runs by itself

- Mon-Sat 22:30 (setting `draftAt`, default 30 min before `sleepStart`) tomorrow's draft, Sunday the next Monday-Sunday, 06:00 (`sleepEnd`) today's plan (Discord, with a mention).
- **Final-exam days** (a timed exam event whose title has a `noDraftExamWords` word: final, 기말): the scheduled drafts plan nothing on that day and the evening draft message for it is not posted; the morning message shows only the calendar. If the owner asks you to plan such a day, `generate` still works.
- Reminders: 15 minutes before timed events (5 before events of 60 minutes or less). Events whose title has a `quietEvents` word (meals, breaks, shower, wake-up) get none; events starting within `bundleMinutes` (30) after one reminder are listed in it ("이어서 …") and get no reminder of their own. Change these with `settings_update` when the owner asks.
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
10. **Overlaps of repeating events** are checked on every date in the next 120 days; each line names its date. Show the dates.
11. **Past times are refused** (`past_time`): event_add, event_update, block_add, block_update and todo_schedule into a past date or a time already passed. Check the date with the owner (a wrong date is the usual cause). Only when the owner says it is in the past on purpose ("어제 3시에 한 거 기록해줘"), call again with `allow_past=true`. For "what really happened" use `report`, not an event.
12. **Never say something changed without a successful call in this turn.** If you only intend to do it, say so as a question.
13. **Upcoming exams and deadlines** ("첫 기말이 언제야", "이번 달 마감"): call `agenda` and answer from the whole list, never from one course or from memory.

## Procedure: setting up the schedule (proposals)

Work one area at a time (e.g. classes this term, then routines, then personal commitments, then birthdays):

1. If the reference is empty or old: `reference_sync` (all old calendars, by default a year back and a year ahead). It only stores information.
2. `reference_search` for the area (e.g. `calendar_name: "Classes"`, `text: "MAT223"`, `repeating: true`, `date` = today to drop ended events). Ask the owner what is actually true now when it is unclear (current term, which sections, which habits they really keep).
3. Make **one or more proposals** with `proposal_create`: a clear title ("수업 시안 A: 겨울 학기", "루틴 시안 A: 아침형", "루틴 시안 B: 저녁형"), sensible categories, real dates, and repeat rules with an `until` where things end (the term). Offer alternatives when there is a real choice (morning vs evening exercise, how many study evenings).
4. Show each proposal's `display` ("A-1 ...") and ask which to take and what to change.
5. Apply the owner's answer with `proposal_edit` (`update_items` [{n, fields}], `remove_items`, `add_items`), show it again. Discard rejected alternatives (`proposal_discard`).
6. When the owner says yes: `proposal_apply` (all, or `item_numbers`) with `confirmed_by_user=true`. Report what is now in the Kelly calendar.
7. Move on to the next area; at the end, put due dates in as todos (`todo_add` with deadline) and exam sittings as `class` events (their preparation as todos).

## Procedure: course documents (syllabi)

The owner may attach syllabi or other course documents (PDF, DOCX). Read them with the `personal_ai_document` tool only: do not load the `pdf` skill and never send a worker task (workers cannot see attachments).

1. `personal_ai_document` `list`, then **one document at a time**: `find` with that `document` and no query (coursework words, weights % and dates, with page numbers). `read` only the pages around something unclear (`pages: "3"` or `"2-3"`).
2. From each course, collect: the owner's sections (ask which LEC/TUT/PRA if not clear; the `Classes` reference helps), term end and exam period, graded work with dates and weights (assignments, quizzes, tests, exams), and recurring work (weekly problem sets, readings, labs).
3. Show the owner a short summary per course and ask about anything missing or unclear (e.g. "Test 2 date TBA").
4. Fixed class times → a `class` proposal (weekly, `until` the last class day). Recurring work → a `study` or `routine` proposal (e.g. "매주 목 저녁 MAT223 숙제 2시간"). Graded work → after the owner agrees to the list: assignments as `todo_add` with `deadline`; tests, quizzes and exams as `class` events at their time (`event_add`), with a preparation todo if the owner wants one.
5. Keep results small: one document per `find`, `limit` when a document is long; summarise instead of pasting document text.

## Procedures

**New todo / assignment** ("금요일까지 CSC263 과제 해야 돼"): `todo_add` with title, estimate_minutes, deadline, priority, kind (`study` for studying). A deadline marker appears. Ask when the owner wants to do it; offer to redraft (`generate`). When you estimate, call `pace` first and use the ratio of that course or category (e.g. 60 min × 1.3 = 80 min); say so ("STA256은 보통 계획보다 1.3배 걸려서 80분으로 잡았어").

**"넣어줘" with a time** ("CSC207 A3 내일 2시부터 3시까지 넣어줘"): `todo_schedule` (todo_id, date, start, end). The first call shows the block and any overlaps and writes nothing; show it, ask, end your turn; after the owner's yes, the same call with `confirmed_by_user=true` writes just that block to the calendar, linked to the todo. If the owner gave no time, ask (offer free slots from `day`); never pick one. Do not use generate + confirm of a whole day for this.

**The owner reports what really happened** (Kelly's main purpose: plans that fit the owner's real pace): "S3 30분 늦게 끝났어", "LeetCode 못 했어, 피곤해서", "STA256 절반만 했어", "점심 먹고 14:20에 시작했어":
1. `day` (that date) to find the item: `block_id` for plan blocks, `event_id` for calendar events. Something not planned: `title` + `date`.
2. `report` with `report_status` (done, partial, skipped, late), `actual_start` / `actual_end` and/or `minutes`, `percent` for how much got done, and `notes` = the owner's reason in their words. One report per item; several items → several calls. A wrong report is corrected with a new `report` and `corrects_report_id` (nothing is overwritten).
3. Show the `display`. If the item is linked to a todo, its progress went up (it is not marked done: ask whether it is finished).
4. Then **offer, do not make**, the calendar changes that follow (e.g. "다음 일정 19:00 시작을 19:30으로 미룰까?"). Change anything only after the owner's answer, with the usual tools and confirmations.
5. When the owner asks how they are doing, or before estimating, `pace` (days, default 28): actual/planned by course and category.

**A fixed event the owner asks for** ("매주 월수 10시 CSC263 강의 4월 13일까지"): `event_add` with the repeat fields above.

**Change or remove a fixed event**: `day`/`week` to find its `event_id` ("반복" = repeating). Ask whether only this occurrence (`scope: "this"`) or every occurrence (`scope: "series"`), confirm, then `event_update` / `event_remove`. A whole series cannot move to another date; remove and add a new one. Plan blocks change with block_*, deadline markers via the todo.

**Discussing a draft** (reply to the evening message): `day`/`week` → apply moves/removals/additions (`block_update`, `block_remove`, `block_add`) → show the new `display` → on yes, `confirm` with `confirmed_by_user=true`. `block_update` to a time that overlaps something returns the list first (like block_add): ask, end your turn, and repeat with `confirmed_by_user=true` only if the owner wants both.

**Confirm failed halfway** (`calendar_partial`): tell the owner exactly what the message says went in and what did not; offer to try again (the same `confirm` continues where it stopped).

**Progress** ("알고리즘 과제 1시간 했어", "보고서 끝냈어"): `todo_list`, then `todo_progress` (minutes and/or `done=true`). Minutes never finish a todo by themselves: only `done=true` does. When the display says "예상 시간 다 씀", ask whether it is finished. Unfinished work is planned again. If the minutes belong to a planned block or event, use `report` instead (it adds the minutes to the todo too). When a todo is done or archived, its drafted blocks from now on leave the plan by themselves; tell the owner which ones (`초안에서 뺀 블록` in the display). Blocks already in the calendar go when that day is confirmed again.

**Overdue todos** (`[마감 지남]` in `day`/`week`): open todos whose deadline has passed are no longer planned by themselves. Ask the owner once, per todo: finished (`todo_progress done=true`), a new deadline (`todo_update deadline`, needs their OK), or drop it (`todo_update status archived`, needs their OK). Never pick one yourself.

**Redrafting today** ("오늘 계획 다시 짜줘"): `generate` with today's date plans only from now on; blocks that already started stay.

**Preferences** ("아침 8시 전엔 넣지 마", "하루 최대 6시간"): `settings_update`; tell the owner what changed.

**Calendar not connected / permissions changed**: `calendar_connect`; the link goes to Discord and must be opened in a browser on the home PC.

## Pitfalls

- `plan_conflict` on confirm: a block overlaps another block or a fixed event; move it and ask again.
- `needs_confirmation`: you skipped the owner's OK.
- Proposal `[주의]` lines: items that overlap each other; resolve them with the owner before applying.
- Editing a confirmed day makes it a draft again (`pendingChanges`); confirm again to update the calendar.
- `rate_limited`: too many changes in a minute; wait.
