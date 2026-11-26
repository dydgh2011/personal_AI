#!/usr/bin/env python3
"""Personal AI task controller client (stdlib only).

Used by the Hermes plugin tool `personal_ai_task` (in-process, no shell) and,
for operators, as a CLI. It talks to the hermes-broker, which holds the
controller credential; this module itself needs no token. Every command
returns exactly one JSON object; the CLI exits non-zero on failure (EXIT_CODES).

    controller_client.py submit --agent claude|codex --project ID --instruction-file PATH [--new]
    controller_client.py status|result|cancel TASK_ID
    controller_client.py wait TASK_ID [--timeout SECONDS]
    controller_client.py list [--agent A] [--status S] [--limit N]
    controller_client.py projects
    controller_client.py system-status

CLI instructions are read from a file, never from the command line, so their
text is not parsed by a shell. If CONTROLLER_TOKEN_FILE is set (operator use
against the controller directly), the token is read from that file and never
printed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, NoReturn

DEFAULT_URL = "http://hermes-broker:8080"
AGENTS = ("claude", "codex")
STATUSES = ("queued", "running", "completed", "failed", "cancel_requested", "canceled")
TERMINAL = ("completed", "failed", "canceled")
MAX_INSTRUCTION_CHARS = 20_000
REQUEST_TIMEOUT = 15.0
MAX_WAIT_SECONDS = 170  # keeps one tool call (and the chat turn) reasonably short
TASK_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
PROJECT_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
# Model and reasoning effort for a task (same rules as the controller's tasks/run-settings.ts).
MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,79}$")
EFFORTS = ("low", "medium", "high", "xhigh", "max")
# What the owner says to go back to the CLI's own default (sent to the controller as null).
CLI_DEFAULT = "cli-default"

EXIT_CODES = {
    "usage_error": 2,
    "connection_error": 3,
    "auth_error": 4,
    "not_found": 5,
    "conflict": 6,
    "invalid_request": 7,
    "server_error": 8,
    "config_error": 9,
    "rate_limited": 10,
}

STATUS_MEANING = {
    "queued": "Waiting for a worker to pick it up.",
    "running": "A worker is executing it.",
    "cancel_requested": "Cancellation was requested; the worker has NOT yet confirmed that execution stopped.",
    "completed": "Finished successfully.",
    "failed": "Finished unsuccessfully (see the error report).",
    "canceled": "Canceled; execution has stopped or never started.",
}

TESTS_NOT_REPORTED = "The worker report contains no test results; do not claim that tests ran or passed."


class CliError(Exception):
    def __init__(self, code: str, message: str, http_status: int | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status


# ---- configuration --------------------------------------------------------------------


class Config:
    def __init__(self, env: dict[str, str]):
        self.url = env.get("PERSONAL_AI_BROKER_URL", DEFAULT_URL).strip().rstrip("/")
        if not re.match(r"^https?://[^\s/]+", self.url):
            raise CliError("config_error", "PERSONAL_AI_BROKER_URL must be an http(s) URL")
        # Optional, operators only. Hermes itself has no token; the broker adds it.
        self.token_file = env.get("CONTROLLER_TOKEN_FILE", "").strip() or None
        # Client key for the hermes-broker (sent as X-Broker-Key). Read only by this module.
        self.broker_key_file = env.get("PERSONAL_AI_BROKER_KEY_FILE", "").strip() or None
        self._broker_key: str | None = None
        # Optional extra client-side allowlist on top of the controller's project registry.
        allowed = env.get("PERSONAL_AI_ALLOWED_PROJECTS", "").strip()
        self.projects = [p.strip() for p in allowed.split(",") if p.strip()] if allowed else None
        self.host_workspaces = env.get("PERSONAL_AI_HOST_WORKSPACES", "").strip().rstrip("\\/")
        self._token: str | None = None

    @property
    def broker_key(self) -> str | None:
        if self.broker_key_file is None:
            return None
        if self._broker_key is None:
            try:
                key = Path(self.broker_key_file).read_text(encoding="utf-8").strip()
            except OSError:
                raise CliError("config_error", "The broker client key file is missing or unreadable") from None
            if len(key) < 32 or any(c.isspace() for c in key):
                raise CliError("config_error", "The broker client key file does not contain a valid key")
            self._broker_key = key
        return self._broker_key

    @property
    def token(self) -> str | None:
        if self.token_file is None:
            return None
        if self._token is None:
            try:
                token = Path(self.token_file).read_text(encoding="utf-8").strip()
            except OSError:
                raise CliError("config_error", f"Controller token file is missing or unreadable: {self.token_file}") from None
            if len(token) < 32 or any(c.isspace() for c in token):
                raise CliError("config_error", f"Controller token file does not contain a valid token: {self.token_file}")
            self._token = token
        return self._token


# ---- HTTP -------------------------------------------------------------------------------


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Keep credential-bearing requests on the configured origin.
        return None


class Client:
    def __init__(self, config: Config, timeout: float = REQUEST_TIMEOUT, retries: int = 3, sleep=time.sleep):
        self.config = config
        self.timeout = timeout
        self.retries = retries
        self.sleep = sleep
        self.opener = urllib.request.build_opener(_NoRedirect())

    def request(self, method: str, path: str, body: Any = None, headers: dict[str, str] | None = None,
                retry: bool = True) -> tuple[int, dict[str, str], Any]:
        """Sends one request. Connection errors and 5xx are retried only when `retry` is True
        (GETs, and POSTs that are safe to repeat thanks to an Idempotency-Key)."""
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        all_headers = {"Accept": "application/json"}
        token = self.config.token
        if token:
            all_headers["Authorization"] = f"Bearer {token}"
        key = self.config.broker_key
        if key:
            all_headers["X-Broker-Key"] = key
        if data is not None:
            all_headers["Content-Type"] = "application/json; charset=utf-8"
        all_headers.update(headers or {})
        attempts = self.retries if retry else 1
        last: CliError | None = None
        for attempt in range(attempts):
            req = urllib.request.Request(self.config.url + path, data=data, method=method, headers=all_headers)
            try:
                with self.opener.open(req, timeout=self.timeout) as res:
                    return res.status, {k.lower(): v for k, v in res.headers.items()}, _json(res.read())
            except urllib.error.HTTPError as err:
                with err:
                    error = _http_error(err.code, _json(err.read()))
                if err.code < 500:
                    raise error from None
                last = error
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as err:
                reason = getattr(err, "reason", err)
                last = CliError("connection_error", f"Cannot reach the task service at {self.config.url}: {reason}")
            if attempt + 1 < attempts:
                self.sleep(0.5 * 2**attempt)
        assert last is not None
        raise last


def _json(raw: bytes) -> Any:
    try:
        return json.loads(raw.decode("utf-8")) if raw else None
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None


def _http_error(status: int, body: Any) -> CliError:
    message = body.get("message") if isinstance(body, dict) else None
    if isinstance(message, list):
        message = "; ".join(str(m) for m in message)
    message = str(message or f"HTTP {status}")
    if status in (401, 403):
        return CliError("auth_error", f"Controller refused the request ({status}): {message}", status)
    if status == 404:
        return CliError("not_found", message, status)
    if status == 409:
        return CliError("conflict", message, status)
    if status == 429:
        return CliError("rate_limited", f"Too many requests: {message}", status)
    if 400 <= status < 500:
        return CliError("invalid_request", message, status)
    return CliError("server_error", f"Controller error ({status}): {message}", status)


# ---- formatting -------------------------------------------------------------------------


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _seconds_between(start: str | None, end: str | None) -> float | None:
    a, b = _parse_time(start), _parse_time(end)
    return round((b - a).total_seconds(), 1) if a and b else None


def _clip(text: Any, limit: int) -> str | None:
    if text is None:
        return None
    text = str(text)
    return text if len(text) <= limit else text[:limit] + f"… [{len(text) - limit} more chars]"


def task_view(task: dict[str, Any]) -> dict[str, Any]:
    status = task.get("status")
    return {
        "id": task.get("id"),
        "agent": task.get("agent"),
        "projectId": task.get("projectId"),
        "status": status,
        "statusMeaning": STATUS_MEANING.get(status, "Unknown status."),
        "finished": status in TERMINAL,
        "success": True if status == "completed" else False if status == "failed" else None,
        "createdAt": task.get("createdAt"),
        "startedAt": task.get("startedAt"),
        "completedAt": task.get("completedAt"),
        "cancelRequestedAt": task.get("cancelRequestedAt"),
        "elapsedSeconds": _seconds_between(task.get("startedAt"), task.get("completedAt")),
        "claimedBy": task.get("claimedBy"),
        "attempt": task.get("attempt"),
        "model": task.get("model") or CLI_DEFAULT,
        "effort": task.get("effort") or CLI_DEFAULT,
    }


def parse_report(task: dict[str, Any], host_workspaces: str = "") -> dict[str, Any] | None:
    """Interprets the agent-worker/v1 JSON stored in `result` (success) or `error` (failure).
    Only facts present in the report are returned; nothing is inferred."""
    raw = task.get("result") if task.get("result") is not None else task.get("error")
    if raw is None:
        return None
    try:
        report = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        report = None
    if not isinstance(report, dict) or report.get("format") != "agent-worker/v1":
        # e.g. "lease_expired: ..." written by the controller itself
        return {"format": "text", "message": _clip(raw, 2000), "tests": {"reported": False, "note": TESTS_NOT_REPORTED}}

    workspace = report.get("workspace") if isinstance(report.get("workspace"), dict) else {}
    details = report.get("agentDetails") if isinstance(report.get("agentDetails"), dict) else {}
    outcome = report.get("outcome")
    success = outcome == "completed" and task.get("status") == "completed"
    host_path = None
    if host_workspaces and workspace.get("path") and task.get("agent") in AGENTS:
        relative = str(workspace["path"]).removeprefix("/workspace").strip("/").replace("/", "\\")
        host_path = f"{host_workspaces}\\{task['agent']}\\{relative}"

    view: dict[str, Any] = {
        "format": "agent-worker/v1",
        "outcome": outcome,
        "success": success,
        "message": _clip(report.get("message"), 4000),
        "exitCode": report.get("exitCode"),
        "signal": report.get("signal"),
        "durationSeconds": round(report["durationMs"] / 1000, 1) if isinstance(report.get("durationMs"), (int, float)) else None,
        "timedOut": report.get("timedOut"),
        "projectId": workspace.get("projectId"),
        "branch": workspace.get("branch"),
        "commit": workspace.get("commit"),
        "baseCommit": workspace.get("baseCommit"),
        "changedFiles": [
            {"status": f.get("status"), "path": f.get("path")}
            for f in (workspace.get("changedFiles") or []) if isinstance(f, dict)
        ],
        "worktreePath": workspace.get("path"),
        "hostPath": host_path,
        "workspaceError": report.get("workspaceError"),
        "tests": {"reported": False, "note": TESTS_NOT_REPORTED},
    }
    # Agent-specific facts that help explain what happened, without raw logs.
    if isinstance(details.get("commands"), list):
        view["commands"] = [
            {"command": _clip(c.get("command"), 200), "exitCode": c.get("exitCode")}
            for c in details["commands"][:20] if isinstance(c, dict)
        ]
    if details.get("permissionDenials"):
        view["permissionDenials"] = details["permissionDenials"][:20]
    if details.get("errors"):
        view["agentErrors"] = [_clip(e, 300) for e in details["errors"][:10]]
    if details.get("tokens"):
        view["tokens"] = details["tokens"]
    if details.get("model"):
        view["model"] = details["model"]
    if not success and report.get("stderrTail"):
        view["stderrTail"] = _clip(report["stderrTail"][-1500:], 1500)
    return view


STATUS_KO = {
    "queued": "대기 중 (워커가 가져가기 전)",
    "running": "실행 중",
    "cancel_requested": "취소 요청됨 (워커가 아직 중단을 확인하지 않음)",
    "completed": "성공",
    "failed": "실패",
    "canceled": "취소됨",
}


def _run_ko(value: Any) -> str:
    return "기본값(CLI)" if not value or value == CLI_DEFAULT else str(value)


def _run_choice(args: argparse.Namespace) -> dict[str, str]:
    """model/effort the owner asked for this one task (absent = the worker's default)."""
    out: dict[str, str] = {}
    model = (getattr(args, "model", None) or "").strip()
    effort = (getattr(args, "effort", None) or "").strip()
    if model and model != CLI_DEFAULT:
        if not MODEL.match(model):
            raise CliError("usage_error", f"'{model}' is not a valid model name (letters, digits, . _ : - [ ], max 80)")
        out["model"] = model
    if effort and effort != CLI_DEFAULT:
        if effort not in EFFORTS:
            raise CliError("usage_error", f"effort must be one of {', '.join(EFFORTS)}")
        out["effort"] = effort
    return out


def user_report(view: dict[str, Any], report: dict[str, Any] | None = None, headline: str | None = None) -> str:
    """Fixed Korean report built only from controller facts, so the model can show it as is."""
    none = "없음"
    lines = [headline] if headline else []
    lines += [
        f"작업 ID: {view.get('id')}",
        f"담당: {view.get('agent')} / 프로젝트: {view.get('projectId')}",
        f"모델: {_run_ko(view.get('model'))} / effort: {_run_ko(view.get('effort'))}",
        f"결과: {STATUS_KO.get(view.get('status'), view.get('status'))}" if view.get("finished")
        else f"상태: {STATUS_KO.get(view.get('status'), view.get('status'))}",
    ]
    if report and report.get("format") == "agent-worker/v1":
        files = report.get("changedFiles") or []
        lines += [
            f"요약: {_clip(report.get('message'), 1200) or none}",
            "변경 파일: " + (", ".join(f"{c.get('status')} {c.get('path')}" for c in files) if files else none),
            f"Git 브랜치: {report.get('branch') or none}",
            f"커밋: {report.get('commit') or none}" + ("   (에이전트 종료 후 Worker가 작업 브랜치에 커밋, 병합·푸시 없음)" if report.get("commit") else ""),
            f"실행 시간: {report.get('durationSeconds')}초" if report.get("durationSeconds") is not None else f"실행 시간: {none}",
            f"PC 경로: {report.get('hostPath') or none}",
            "테스트: 작업 보고서에 테스트 결과 없음",
        ]
        errors = [str(e) for e in (report.get("workspaceError"), *(report.get("agentErrors") or [])) if e]
        if report.get("timedOut"):
            errors.append("실행 시간 제한 초과")
        if not report.get("success") and (errors or report.get("stderrTail")):
            tail = (report.get("stderrTail") or "").strip().splitlines()[-3:]
            lines.append("오류: " + "; ".join(errors + tail))
    elif report:
        lines.append(f"오류: {report.get('message')}")
    return "\n".join(lines)


# ---- commands ---------------------------------------------------------------------------


def _require_task_id(task_id: str) -> str:
    task_id = task_id.strip().lower()
    if not TASK_ID.match(task_id):
        raise CliError("usage_error", "TASK_ID must be a task UUID as returned by submit or list")
    return task_id


def cmd_submit(client: Client, config: Config, args: argparse.Namespace) -> dict[str, Any]:
    if args.agent not in AGENTS:
        raise CliError("usage_error", f"--agent must be one of {', '.join(AGENTS)}")
    if not isinstance(args.project, str) or not PROJECT_ID.match(args.project):
        raise CliError("invalid_request", f"'{args.project}' is not a valid project id")
    if config.projects is not None and args.project not in config.projects:
        raise CliError("invalid_request", f"Project '{args.project}' is not allowed here. Allowed: {', '.join(config.projects)}")
    # The registry decides; asking first gives the user a clear answer and the list of real projects.
    _, _, page = client.request("GET", "/projects")
    projects = {p.get("id"): p for p in (page or {}).get("items", []) if isinstance(p, dict)}
    project = projects.get(args.project)
    if project is None:
        raise CliError("invalid_request", f"Project '{args.project}' is not registered. Registered projects: "
                       f"{', '.join(sorted(projects)) or 'none'}. Only an administrator can register projects.")
    if args.agent not in (project.get("allowedAgents") or []):
        raise CliError("invalid_request", f"Agent {args.agent} is not allowed in project '{args.project}' "
                       f"(allowed: {', '.join(project.get('allowedAgents') or [])})")

    path: Path | None = None
    if getattr(args, "instruction", None) is not None:
        instruction = str(args.instruction).strip()
    else:
        if not args.instruction_file:
            raise CliError("usage_error", "--instruction-file is required")
        path = Path(args.instruction_file)
        try:
            instruction = path.read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            raise CliError("usage_error", f"Instruction file not found: {path}") from None
        except (OSError, UnicodeDecodeError) as err:
            raise CliError("usage_error", f"Cannot read instruction file {path}: {err}") from None
    if not instruction:
        raise CliError("usage_error", "The instruction is empty")
    run = _run_choice(args)
    if len(instruction) > MAX_INSTRUCTION_CHARS:
        raise CliError("usage_error", f"Instruction is {len(instruction)} characters; the limit is {MAX_INSTRUCTION_CHARS}")

    if args.new:
        key = f"hermes-new-{uuid.uuid4().hex}"
    else:
        parts = (args.agent, args.project, instruction, run.get("model", ""), run.get("effort", ""))
        digest = hashlib.sha256("\0".join(parts).encode("utf-8")).hexdigest()
        key = f"hermes-auto-{digest[:40]}"
    status, headers, task = client.request(
        "POST", "/tasks",
        {"agent": args.agent, "projectId": args.project, "instruction": instruction, **run},
        headers={"Idempotency-Key": key},
    )
    duplicate = headers.get("idempotent-replayed") == "true"
    # Consumed: a stale file must never be submitted again by accident.
    if path is not None and not getattr(args, "keep_file", False):
        try:
            path.unlink()
        except OSError:
            pass
    view = task_view(task)
    result = {"ok": True, "duplicate": duplicate, "task": view,
              "userReport": user_report(view, headline="이미 같은 요청으로 등록된 작업입니다 (새로 만들지 않음)." if duplicate
                                        else "작업을 등록했습니다.")}
    if duplicate:
        result["note"] = ("The same request was already submitted in the last few minutes; this is that existing task, "
                          "not a new one. Set new=true only if the user explicitly wants to run it again.")
    return result


def cmd_projects(client: Client, config: Config, args: argparse.Namespace) -> dict[str, Any]:
    _, _, page = client.request("GET", "/projects")
    items = [p for p in (page or {}).get("items", []) if isinstance(p, dict)]
    return {
        "ok": True,
        "projects": [
            {k: p.get(k) for k in ("id", "source", "fullName", "defaultBranch", "allowedAgents", "allowCodeChanges", "description")}
            for p in items
        ],
        "note": "Only these projects accept tasks. Registering or enabling projects is an administrator action.",
    }


def cmd_status(client: Client, config: Config, args: argparse.Namespace) -> dict[str, Any]:
    _, _, task = client.request("GET", f"/tasks/{_require_task_id(args.task_id)}")
    view = task_view(task)
    report = parse_report(task, config.host_workspaces)
    result: dict[str, Any] = {"ok": True, "task": view, "userReport": user_report(view, report)}
    if report:
        result["summary"] = {
            "outcome": report.get("outcome"),
            "success": report.get("success"),
            "message": _clip(report.get("message"), 600),
            "branch": report.get("branch"),
            "commit": report.get("commit"),
            "changedFiles": len(report.get("changedFiles") or []),
        }
    return result


def cmd_result(client: Client, config: Config, args: argparse.Namespace) -> dict[str, Any]:
    _, _, task = client.request("GET", f"/tasks/{_require_task_id(args.task_id)}")
    view = task_view(task)
    if not view["finished"]:
        return {"ok": True, "task": view, "report": None, "userReport": user_report(view),
                "note": f"The task is still {task.get('status')}; there is no result yet."}
    report = parse_report(task, config.host_workspaces)
    return {"ok": True, "task": view, "report": report, "userReport": user_report(view, report)}


def cmd_wait(client: Client, config: Config, args: argparse.Namespace, sleep=time.sleep, now=time.monotonic) -> dict[str, Any]:
    task_id = _require_task_id(args.task_id)
    timeout = max(1, min(int(args.timeout), MAX_WAIT_SECONDS))
    deadline = now() + timeout
    while True:
        _, _, task = client.request("GET", f"/tasks/{task_id}")
        if task.get("status") in TERMINAL or now() >= deadline:
            break
        sleep(min(5.0, max(0.0, deadline - now())))
    view = task_view(task)
    if task.get("status") in TERMINAL:
        report = parse_report(task, config.host_workspaces)
        return {"ok": True, "task": view, "report": report, "userReport": user_report(view, report)}
    return {"ok": True, "task": view, "report": None, "userReport": user_report(view),
            "note": f"Still {task.get('status')} after {timeout}s. Tell the user the task id, or wait again."}


def cmd_list(client: Client, config: Config, args: argparse.Namespace) -> dict[str, Any]:
    query = [f"limit={max(1, min(int(args.limit), 200))}"]
    if args.agent:
        if args.agent not in AGENTS:
            raise CliError("usage_error", f"--agent must be one of {', '.join(AGENTS)}")
        query.append(f"agent={args.agent}")
    if args.status:
        if args.status not in STATUSES:
            raise CliError("usage_error", f"--status must be one of {', '.join(STATUSES)}")
        query.append(f"status={args.status}")
    _, _, page = client.request("GET", "/tasks?" + "&".join(query))
    items = page.get("items", [])
    by_agent: dict[str, dict[str, int]] = {}
    for task in items:
        counts = by_agent.setdefault(task.get("agent", "?"), {})
        counts[task.get("status", "?")] = counts.get(task.get("status", "?"), 0) + 1
    return {
        "ok": True,
        "total": page.get("total"),
        "shown": len(items),
        "countsShownByAgentAndStatus": by_agent,
        "tasks": [
            {
                "id": t.get("id"),
                "agent": t.get("agent"),
                "projectId": t.get("projectId"),
                "status": t.get("status"),
                "createdAt": t.get("createdAt"),
                "completedAt": t.get("completedAt"),
                "model": t.get("model") or CLI_DEFAULT,
                "effort": t.get("effort") or CLI_DEFAULT,
                "instruction": _clip((t.get("instruction") or "").replace("\n", " "), 100),
            }
            for t in items
        ],
    }


def cmd_cancel(client: Client, config: Config, args: argparse.Namespace) -> dict[str, Any]:
    # Repeating a cancel is harmless (the controller reports cancel_already_requested), so retry is safe.
    _, _, res = client.request("POST", f"/tasks/{_require_task_id(args.task_id)}/cancel")
    outcome = res.get("outcome")
    view = task_view(res.get("task", {}))
    return {
        "ok": True,
        "outcome": outcome,
        "stopped": outcome == "canceled",
        "message": res.get("message"),
        "task": view,
        "userReport": user_report(view, headline="작업을 취소했습니다." if outcome == "canceled"
                                  else "취소를 요청했습니다. 아직 중단이 확인되지 않았습니다."),
        "note": None if outcome == "canceled" else
        "Not stopped yet: the worker stops the agent and confirms within about 10-20 seconds. Check status again before telling the user it is canceled.",
    }


REVIEW_KO = {"awaiting_approval": "승인 대기", "approved": "승인됨", "rejected": "거부됨", "invalidated": "무효화됨"}


def cmd_review(client: Client, config: Config, args: argparse.Namespace) -> dict[str, Any]:
    """Diff and review state of a completed task. Read-only: approving is an administrator action."""
    _, _, d = client.request("GET", f"/tasks/{_require_task_id(args.task_id)}/diff")
    review = d.get("review") or {}
    files = d.get("files") or []
    lines = [
        f"작업 ID: {d.get('taskId')} / 프로젝트: {d.get('projectId')} / 담당: {d.get('agent')}",
        f"기준 커밋: {d.get('baseSha')}",
        f"결과 커밋: {d.get('headSha')}",
        (f"변경: +{d.get('additions')} / -{d.get('deletions')} (파일 {len(files)}개)" if d.get('additions') is not None else f"변경: 줄 수 기록 없음 (파일 {len(files)}개, E-1 이전 작업)"),
    ]
    for f in files[:30]:
        flags = "".join([" [바이너리]" if f.get("binary") else "", " [민감 정보 의심, 내용 제외]" if f.get("sensitive") else ""])
        counts = "" if f.get("binary") or f.get("additions") is None else f" (+{f.get('additions')}/-{f.get('deletions')})"
        lines.append(f"  {f.get('status')} {f.get('path')}{counts}{flags}")
    lines.append(f"검토 상태: {REVIEW_KO.get(review.get('status'), review.get('status'))}")
    lines.append("테스트: " + ("보고됨" if d.get("tests") else "작업 보고서에 테스트 결과 없음"))
    lines.append("승인·거부는 관리자만 할 수 있습니다 (Hermes는 승인할 수 없음).")
    patch = d.get("patch")
    return {
        "ok": True,
        "taskId": d.get("taskId"),
        "baseSha": d.get("baseSha"),
        "headSha": d.get("headSha"),
        "reviewStatus": review.get("status"),
        "files": files,
        "patch": _clip(patch, 4000) if patch else None,
        "patchWithheld": d.get("patchWithheld"),
        "patchTruncated": d.get("patchTruncated"),
        "userReport": "\n".join(lines),
    }


def cmd_system_status(client: Client, config: Config, args: argparse.Namespace) -> dict[str, Any]:
    _, _, status = client.request("GET", "/system/status")
    now = datetime.now(timezone.utc)
    workers = []
    for w in status.get("workers", []):
        seen = _parse_time(w.get("lastSeenAt"))
        age = round((now - seen).total_seconds()) if seen else None
        online = age is not None and age < 60
        login = w.get("login") or {}
        logged_in = login.get("loggedIn")
        if not online:
            state = "offline"
        elif logged_in is False:
            state = "login_required"
        else:
            state = "ready"
        workers.append({
            "workerId": w.get("workerId"),
            "agent": w.get("agent"),
            "lastSeenSecondsAgo": age,
            "online": online,
            "state": state,
            "loggedIn": logged_in,
            "loginSession": login.get("sessionStatus"),
            "queuedTasks": w.get("queuedTasks"),
            "activeTasks": w.get("activeTasks"),
        })
    attention = [
        f"The {w['agent']} worker is logged out; its tasks wait in the queue. To send the user a new login link, "
        f"call personal_ai_worker_login(action=\"start\", agent=\"{w['agent']}\")."
        for w in workers
        if w["state"] == "login_required" and w["loginSession"] not in ("waiting_user", "code_submitted", "verifying")
    ]
    result: dict[str, Any] = {
        "ok": True,
        "controller": {k: status.get("controller", {}).get(k) for k in ("status", "version", "uptimeSeconds")},
        "database": status.get("database"),
        "tasks": status.get("tasks"),
        "workers": workers,
        "projects": status.get("projects"),
        "services": status.get("services"),
    }
    if attention:
        result["attention"] = attention
    return result


def _login_view(item: dict[str, Any]) -> dict[str, Any]:
    session = item.get("session") or None
    view: dict[str, Any] = {"agent": item.get("agent"), "loggedIn": item.get("loggedIn"), "loginRequested": item.get("requested")}
    if session:
        view["session"] = {k: session.get(k) for k in ("id", "status", "loginUrl", "userCode", "needsCode", "expiresAt", "message")}
    return view


def cmd_login_status(client: Client, config: Config, args: argparse.Namespace) -> dict[str, Any]:
    """Login state of the worker CLIs. The login link itself is also sent to Discord automatically."""
    _, _, page = client.request("GET", "/workers/auth")
    return {"ok": True, "workers": [_login_view(i) for i in page.get("items", [])]}


def cmd_login_start(client: Client, config: Config, args: argparse.Namespace) -> dict[str, Any]:
    if args.agent not in AGENTS:
        raise CliError("invalid_request", f"agent must be one of {', '.join(AGENTS)}")
    try:
        _, _, item = client.request("POST", f"/workers/{args.agent}/auth/start")
    except CliError as err:
        if err.code != "conflict":
            raise
        # A login is already under way: its link is on Discord. Say so instead of reporting an error.
        _, _, page = client.request("GET", "/workers/auth")
        current = next((i for i in page.get("items", []) if i.get("agent") == args.agent), {})
        return {"ok": True, "alreadyWaiting": True, "worker": _login_view(current),
                "note": "A login link for this worker is already on Discord and still valid until session.expiresAt "
                        "(UTC). Tell the user to use that message; no new link is needed."}
    return {"ok": True, "worker": _login_view(item),
            "note": "The worker starts a login on its next poll; the login link arrives on Discord within about a minute."}


def cmd_login_code(client: Client, config: Config, args: argparse.Namespace) -> dict[str, Any]:
    if args.agent not in AGENTS:
        raise CliError("invalid_request", f"agent must be one of {', '.join(AGENTS)}")
    code = (args.code or "").strip()
    if not code:
        raise CliError("invalid_request", "code is required: the code shown after signing in at the login link")
    _, _, item = client.request("POST", f"/workers/{args.agent}/auth/code", {"code": code})
    return {"ok": True, "worker": _login_view(item),
            "note": "Code handed to the worker. A Discord message confirms when the login is complete (usually within seconds)."}


def _defaults_view(item: dict[str, Any]) -> dict[str, Any]:
    return {"agent": item.get("agent"), "model": item.get("model") or CLI_DEFAULT, "effort": item.get("effort") or CLI_DEFAULT,
            "updatedAt": item.get("updatedAt"), "updatedBy": item.get("updatedBy")}


def cmd_defaults(client: Client, config: Config, args: argparse.Namespace) -> dict[str, Any]:
    _, _, page = client.request("GET", "/agent-defaults")
    items = [_defaults_view(i) for i in (page or {}).get("items", []) if isinstance(i, dict)]
    return {"ok": True, "defaults": items, "effortLevels": list(EFFORTS),
            "userReport": "\n".join(f"{i['agent']}: 모델 {_run_ko(i['model'])} / effort {_run_ko(i['effort'])}" for i in items),
            "note": "cli-default = the worker CLI's own default. One task can still ask for another model/effort (submit)."}


def cmd_defaults_set(client: Client, config: Config, args: argparse.Namespace) -> dict[str, Any]:
    if args.agent not in AGENTS:
        raise CliError("usage_error", f"agent is required: one of {', '.join(AGENTS)}")
    if not getattr(args, "confirmed_by_user", False):
        raise CliError("invalid_request", "Changing a worker default needs the owner's explicit OK in this conversation "
                       "(say exactly what will change, then set confirmed_by_user=true).")
    change: dict[str, Any] = {}
    for name, value in (("model", getattr(args, "model", None)), ("effort", getattr(args, "effort", None))):
        value = (value or "").strip()
        if not value:
            continue
        if value == CLI_DEFAULT:
            change[name] = None
        elif name == "model" and not MODEL.match(value):
            raise CliError("usage_error", f"'{value}' is not a valid model name (letters, digits, . _ : - [ ], max 80)")
        elif name == "effort" and value not in EFFORTS:
            raise CliError("usage_error", f"effort must be one of {', '.join(EFFORTS)} or {CLI_DEFAULT}")
        else:
            change[name] = value
    if not change:
        raise CliError("usage_error", f"Give model and/or effort ({CLI_DEFAULT} = the CLI's own default)")
    _, _, item = client.request("POST", f"/agent-defaults/{args.agent}", change)
    view = _defaults_view(item or {})
    return {"ok": True, "defaults": view,
            "userReport": f"{view['agent']} 기본값을 바꿨습니다: 모델 {_run_ko(view['model'])} / effort {_run_ko(view['effort'])}. "
                          "새로 등록하는 작업부터 적용됩니다."}


COMMANDS = {
    "login-status": cmd_login_status,
    "login-start": cmd_login_start,
    "login-code": cmd_login_code,
    "submit": cmd_submit,
    "status": cmd_status,
    "result": cmd_result,
    "wait": cmd_wait,
    "list": cmd_list,
    "cancel": cmd_cancel,
    "system-status": cmd_system_status,
    "projects": cmd_projects,
    "review": cmd_review,
    "defaults": cmd_defaults,
    "defaults-set": cmd_defaults_set,
}


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        raise CliError("usage_error", message)


def build_parser() -> argparse.ArgumentParser:
    parser = _Parser(prog="controller.py", description="Personal AI task controller client for Hermes")
    sub = parser.add_subparsers(dest="command", required=True, parser_class=_Parser)
    submit = sub.add_parser("submit", help="queue a coding task for a worker")
    submit.add_argument("--agent", required=True, choices=AGENTS)
    submit.add_argument("--project", required=True)
    submit.add_argument("--instruction-file", required=True, help="UTF-8 file with the task text")
    submit.add_argument("--new", action="store_true", help="submit even if the same request was just submitted")
    submit.add_argument("--keep-file", action="store_true", help="do not delete the instruction file after submitting")
    submit.add_argument("--model", help="model for this task only (default: the agent's default)")
    submit.add_argument("--effort", choices=EFFORTS, help="reasoning effort for this task only")
    sub.add_parser("defaults", help="default model and effort per agent")
    defaults_set = sub.add_parser("defaults-set", help="change an agent's default model/effort (owner's OK needed)")
    defaults_set.add_argument("--agent", required=True, choices=AGENTS)
    defaults_set.add_argument("--model", help=f"model name or {CLI_DEFAULT}")
    defaults_set.add_argument("--effort", choices=(*EFFORTS, CLI_DEFAULT))
    defaults_set.add_argument("--confirmed-by-user", action="store_true")
    for name in ("status", "result", "cancel", "review"):
        sub.add_parser(name).add_argument("task_id")
    wait = sub.add_parser("wait", help=f"poll until the task finishes (max {MAX_WAIT_SECONDS}s per call)")
    wait.add_argument("task_id")
    wait.add_argument("--timeout", type=int, default=150)
    lst = sub.add_parser("list")
    lst.add_argument("--agent")
    lst.add_argument("--status")
    lst.add_argument("--limit", type=int, default=20)
    sub.add_parser("system-status")
    sub.add_parser("projects")
    sub.add_parser("login-status")
    sub.add_parser("login-start").add_argument("--agent", required=True, choices=AGENTS)
    login_code = sub.add_parser("login-code")
    login_code.add_argument("--agent", required=True, choices=AGENTS)
    login_code.add_argument("--code", required=True)
    return parser


def run(argv: list[str], env: dict[str, str], client_factory=Client) -> tuple[int, dict[str, Any]]:
    config: Config | None = None
    try:
        args = build_parser().parse_args(argv)
        config = Config(env)
        client = client_factory(config)
        return 0, COMMANDS[args.command](client, config, args)
    except CliError as err:
        message = err.message
        if config is not None:
            for secret in (config._token, config._broker_key):
                if secret:
                    message = message.replace(secret, "[redacted]")
        error: dict[str, Any] = {"code": err.code, "message": message}
        if err.http_status is not None:
            error["httpStatus"] = err.http_status
        return EXIT_CODES[err.code], {"ok": False, "error": error}
    except (AttributeError, KeyError, TypeError, ValueError) as err:
        # A response that does not look like the controller's API (wrong service, proxy page, ...).
        return EXIT_CODES["server_error"], {
            "ok": False,
            "error": {"code": "server_error", "message": f"Unexpected controller response ({type(err).__name__})"},
        }


def main() -> int:
    code, payload = run(sys.argv[1:], dict(os.environ))
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    return code


if __name__ == "__main__":
    sys.exit(main())
