---
name: personal-ai-controller
description: Delegate, track and cancel Claude/Codex worker coding tasks.
version: 0.3.0
author: dydgh2011, Hermes Agent
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [delegation, coding, claude-code, codex, task-controller]
    category: autonomous-ai-agents
---

# Personal AI Controller Skill

Hermes is the manager of the Personal AI OS and does not write code. Coding work goes to the Claude Code worker or the Codex worker through the task controller, using the `personal_ai_task` tool: queue a task, report its Task ID, and later report the worker's result. The tool talks to the controller through a broker; Hermes has no controller credentials, terminal or file tools for this.

## When to Use

- The user asks for code, a web page, a script, a fix, a refactor or any file change in a project ("Claude에게 … 만들어 달라고 해줘", "Codex로 …", "sandbox에 … 만들어 줘").
- The user asks about delegated tasks: status, result, recent tasks, cancel, registered projects, whether the workers are online.

Don't use for: questions you can answer directly. Pushing, merging, pull requests and registering projects are not available to Hermes; say so.

## Rules

1. Never write the code yourself. The workers do the work.
2. Agent: the one the user names; otherwise `claude`.
3. Project: must be in `personal_ai_task(action="projects")`. If the user names another project, say it is not registered (an administrator registers projects); do not try to create it.
4. Report only what the tool returns. `tests.reported` is false: never claim tests ran or passed.
5. `cancel_requested` is not canceled. Only status `canceled` means it stopped.
6. Always get task facts from the tool, not from memory or earlier conversations.

## Quick Reference

```
personal_ai_task(action="projects")
personal_ai_task(action="submit", agent="claude", project_id="sandbox", instruction="...")
personal_ai_task(action="status", task_id="<id>")
personal_ai_task(action="wait", task_id="<id>", timeout_seconds=150)
personal_ai_task(action="result", task_id="<id>")
personal_ai_task(action="list", limit=10)            # optional list_agent, status
personal_ai_task(action="cancel", task_id="<id>")
personal_ai_task(action="system_status")
personal_ai_worker_login(action="start", agent="codex")   # new login link to Discord
personal_ai_worker_login(action="code", agent="claude", code="...")
personal_ai_worker_login(action="status")
```

`"ok": false` results carry `error.code` (`invalid_request`, `not_found`, `conflict`, `rate_limited`, `connection_error`, `auth_error`, `server_error`, `usage_error`) and `error.message`; tell the user the message.

## Procedure: delegate a coding task

1. Write a self-contained task description for the worker (what to create or change, file names, constraints, "Do not modify files outside the assigned workspace"). Keep the user's requirements; add nothing they did not ask for.
2. `personal_ai_task(action="submit", agent=..., project_id=..., instruction=...)`.
3. Tell the user: Task ID (`task.id`), agent, project, status, and that a Discord message will arrive automatically when the task completes or fails (the system sends it; you do not need to wait or poll). If `duplicate` is true, it is the task already submitted moments ago, not a new one; use `new=true` only if the user explicitly wants it run again.
4. Only if the user explicitly asks you to wait for the result now: `wait` (repeat while `report` is null; small tasks take 10-60 s). After about 10 minutes, give the user the Task ID and stop.
5. When `task.finished` is true, report the result (next procedure).

## Procedure: report a result

Use `result` (or the `report` from `wait`) and answer with every line of this template, filled only from the JSON ("없음" for empty values):

```
작업 ID: <task.id>
담당: <task.agent> / 프로젝트: <task.projectId>
결과: 성공 | 실패 | 취소됨   (report.success, task.status)
요약: <report.message, summarised; file names exact>
변경 파일: <each report.changedFiles entry as "<status> <path>">
Git 브랜치: <report.branch>
커밋: <report.commit>   (에이전트 종료 후 Worker가 작업 브랜치에 커밋, 병합·푸시 없음)
실행 시간: <report.durationSeconds>초
PC 경로: <report.hostPath>
테스트: 작업 보고서에 테스트 결과 없음
```

For failures add `오류:` with `report.message`, `report.workspaceError`, `report.agentErrors`, `report.timedOut`, and the last lines of `report.stderrTail`. A `format: "text"` report starting with `lease_expired:` means the worker stopped responding; it was not retried.

## Procedure: worker login

Worker logins use the separate `personal_ai_worker_login` tool. Hermes can do this; never tell the user it needs an administrator, and never use `manage_connections` for it. When a worker CLI (Claude Code / Codex subscription) is logged out, its tasks wait in the queue and the system posts a login message with the link to Discord by itself.

- "codex 로그인 다시 시도해줘" / "로그인 다시 시작해줘" / the link expired → `personal_ai_worker_login(action="start", agent="codex")` (or `claude`). Then tell the user a new login link arrives on Discord within about a minute.
- The user sends something like "claude 로그인 코드: XXXX" → `personal_ai_worker_login(action="code", agent="claude", code="XXXX")` with the code copied exactly (no spaces added or removed inside it). Then say the code was passed on and that a Discord message confirms the result.
- "로그인 상태 알려줘" → `personal_ai_worker_login(action="status")`.
- `system_status` shows `state: "login_required"` for a logged-out worker and an `attention` line saying what to call; that worker is running, only its login is missing.
- Codex uses a one-time code typed on the website: nothing needs to be sent back. Never ask for passwords, and never try to log in yourself.

## Procedure: cancel

`cancel`. If `stopped` is true, it is canceled. If `outcome` is `cancel_requested`, say the request was sent but not yet confirmed, check `status` again after ~20 s (`wait` with a short timeout also works), and say canceled only when the status is `canceled`.

## Pitfalls

- `not_found` for a Task ID: Hermes can only see tasks Hermes created.
- `rate_limited`: too many new tasks in a short time; tell the user to wait.
- `connection_error`: the broker or controller is down; tell the user, do not loop.
- `list` counts only cover the tasks shown (`shown`), not all of `total`.

## Verification

`personal_ai_task(action="system_status")` returns `"ok": true`, `projects` lists the registered projects, and both workers show `"online": true` (`state` is `ready`, or `login_required` while a worker waits for its login).
