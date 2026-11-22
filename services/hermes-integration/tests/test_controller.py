"""Tests for plugins/personal-ai-controller/controller_client.py against a mock broker/controller.

    python -m unittest discover -s services/hermes-integration/tests -v

stdlib only; no network access beyond 127.0.0.1.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "plugins" / "personal-ai-controller" / "controller_client.py"
sys.path.insert(0, str(SCRIPT.parent))
import controller_client as controller  # noqa: E402

TOKEN = "t0k3n-" + "x" * 40


def worker_report(task_id: str, agent: str, outcome: str, **extra) -> str:
    report = {
        "format": "agent-worker/v1", "taskId": task_id, "agent": agent, "workerId": f"{agent}-worker", "attempt": 1,
        "outcome": outcome, "message": "Created index.html with a heading.", "exitCode": 0 if outcome == "completed" else 1,
        "signal": None, "durationMs": 12345, "timedOut": False, "stdoutTruncated": False, "stderrTail": "boom at line 3",
        "agentDetails": {"commands": [{"command": "npm test", "exitCode": 1, "status": "failed"}], "model": "cli-default"},
        "workspace": {"projectId": "sandbox", "mode": "write", "path": f"/workspace/.worktrees/{task_id}",
                      "branch": f"{agent}/task-{task_id}", "baseCommit": "abc", "commit": "def123",
                      "changedFiles": [{"status": "A", "path": "index.html"}]},
        "workspaceError": None,
    }
    report.update(extra)
    return json.dumps(report)


class MockController:
    """Implements the slice of the controller API the client uses, including auth and idempotency."""

    def __init__(self):
        self.tasks: dict[str, dict] = {}
        self.order: list[str] = []
        self.keys: dict[str, str] = {}
        self.requests: list[dict] = []
        self.fail_next: list[int] = []  # HTTP statuses to return before handling normally
        self.fail_posts: list[int] = []  # same, but only for POST requests
        # None: like the broker (no token needed). A string: like the controller (operator mode).
        self.require_token: str | None = None
        self.projects = [
            {"id": "sandbox", "source": "local", "allowedAgents": ["claude", "codex"], "defaultBranch": "main"},
            {"id": "docs", "source": "github", "fullName": "octocat/docs", "allowedAgents": ["claude"], "defaultBranch": "main"},
            # listed but rejected on POST, e.g. disabled between the two calls
            {"id": "ghost", "source": "local", "allowedAgents": ["claude"], "defaultBranch": "main"},
        ]
        mock = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _send(self, status, body, headers=None):
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _handle(self, method):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                mock.requests.append({"method": method, "path": self.path, "headers": dict(self.headers), "body": raw.decode()})
                if mock.fail_next:
                    return self._send(mock.fail_next.pop(0), {"message": "temporary failure"})
                if method == "POST" and mock.fail_posts:
                    return self._send(mock.fail_posts.pop(0), {"message": "temporary failure"})
                if mock.require_token is not None and self.headers.get("Authorization") != f"Bearer {mock.require_token}":
                    return self._send(401, {"message": "Invalid bearer token"})
                path = self.path.split("?")[0]
                parts = [p for p in path.split("/") if p]
                if method == "POST" and parts == ["tasks"]:
                    body = json.loads(raw)
                    if body.get("projectId") not in ("sandbox", "docs"):
                        return self._send(400, {"message": f"Unknown projectId \"{body.get('projectId')}\""})
                    key = self.headers.get("Idempotency-Key")
                    if key and key in mock.keys:
                        return self._send(200, mock.tasks[mock.keys[key]], {"Idempotent-Replayed": "true"})
                    task = mock.add(body["agent"], body["instruction"])
                    if key:
                        mock.keys[key] = task["id"]
                    return self._send(201, task)
                if method == "GET" and parts == ["projects"]:
                    return self._send(200, {"items": mock.projects})
                if method == "GET" and parts == ["tasks"]:
                    items = [mock.tasks[i] for i in reversed(mock.order)]
                    return self._send(200, {"items": items, "total": len(items), "limit": 20, "offset": 0})
                if method == "GET" and len(parts) == 3 and parts[2] == "diff":
                    task = mock.tasks.get(parts[1])
                    return self._send(200, task["diff"]) if task and task.get("diff") else self._send(404, {"message": "no diff"})
                if method == "GET" and len(parts) == 2 and parts[0] == "tasks":
                    task = mock.tasks.get(parts[1])
                    return self._send(200, task) if task else self._send(404, {"message": f"Task {parts[1]} not found"})
                if method == "POST" and len(parts) == 3 and parts[2] == "cancel":
                    task = mock.tasks.get(parts[1])
                    if not task:
                        return self._send(404, {"message": "not found"})
                    if task["status"] == "queued":
                        task["status"] = "canceled"
                        return self._send(200, {"outcome": "canceled", "message": "Task was canceled before it started.", "task": task})
                    if task["status"] == "running":
                        task["status"] = "cancel_requested"
                        return self._send(200, {"outcome": "cancel_requested", "message": "Cancellation requested. The worker has not yet confirmed that execution stopped.", "task": task})
                    return self._send(409, {"message": f"Task is already {task['status']} and cannot be canceled"})
                if parts[:1] == ["planner"]:
                    mock.planner_calls = getattr(mock, "planner_calls", []) + [(method, self.path, json.loads(raw) if raw else None)]
                    day = {"date": "2026-11-23", "weekday": "월", "status": "draft", "pendingChanges": False,
                           "blocks": [{"id": "11111111-1111-4111-8111-111111111111", "date": "2026-11-23", "start": "07:00",
                                       "end": "08:30", "title": "알고리즘 과제", "todoId": None, "origin": "auto", "category": "study",
                                       "inCalendar": False, "pending": True}],
                           "events": [{"id": "lec1_20261123T140000Z", "seriesId": "lec1", "start": "09:00", "end": "11:00", "title": "CSC263",
                                       "allDay": False, "location": None, "category": "class", "deadline": False},
                                      {"id": "dl1", "seriesId": None, "start": None, "end": None, "title": "마감: 보고서",
                                       "allDay": True, "location": None, "category": "deadline", "deadline": True}],
                           "unscheduled": [], "warnings": [], "calendarConnected": True}
                    todo = {"id": "22222222-2222-4222-8222-222222222222", "title": "보고서", "notes": None, "kind": "task",
                            "priority": 2, "estimateMinutes": 90, "doneMinutes": 0, "deadline": "2026-11-30", "earliest": None,
                            "status": "open", "createdAt": "", "updatedAt": ""}
                    sub = parts[1:]
                    if method == "GET" and sub == ["day"]:
                        return self._send(200, day)
                    if method == "POST" and sub in (["plans", "generate"], ["plans", "confirm"]):
                        return self._send(200, {"days": [day]})
                    if method == "POST" and sub[:1] == ["todos"]:
                        return self._send(200, {"todo": todo})
                    if method == "POST" and sub == ["events"]:
                        return self._send(200, {"event": {"id": "evt123abc", "title": "치과", "category": "personal",
                                                          "when": "11/24(화) 15:00–16:00"}})
                    if method == "POST" and sub[:1] == ["events"]:
                        return self._send(200, {"id": sub[1], "scope": "this"})
                    if method == "GET" and sub == ["calendars"]:
                        return self._send(200, {"calendars": [{"name": "Classes", "primary": False, "accessRole": "owner"}]})
                    if method == "POST" and sub == ["reference", "sync"]:
                        return self._send(200, {"calendars": [{"name": "Classes", "events": 26, "repeating": 26}], "from": "2025-11-22", "to": "2027-11-22"})
                    if method == "POST" and sub == ["reference", "search"]:
                        return self._send(200, {"total": 1, "items": [{"calendar": "Rountine", "title": "Gym", "when": "매주 화·수·목 19:00–21:00",
                                                                       "repeats": True, "location": None, "hint": "routine"}]})
                    proposal = {"code": "A", "title": "루틴 시안 A", "notes": None, "status": "draft", "warnings": [],
                                "items": [{"n": 1, "title": "헬스", "category": "routine", "when": "매주 월·수·금 07:00–08:00",
                                           "location": None, "applied": False}]}
                    if sub == ["proposals"]:
                        return self._send(200, {"proposal": proposal} if method == "POST" else {"proposals": []})
                    if sub[:1] == ["proposals"]:
                        return self._send(200, {"proposal": {**proposal, "written": [{"n": 1, "title": "헬스"}]}})
                    if method == "POST" and sub[:1] == ["blocks"]:
                        return self._send(200, {"block": day["blocks"][0]})
                    return self._send(404, {"message": "no planner route"})
                if parts[:1] == ["workers"]:
                    session = {"id": "33333333-3333-4333-8333-333333333333", "status": "waiting_user", "needsCode": True,
                               "loginUrl": "https://claude.com/cai/oauth/authorize?x=1", "userCode": None, "expiresAt": None, "message": None}
                    item = {"agent": "claude", "loggedIn": False, "requested": False, "session": session}
                    if method == "GET" and parts == ["workers", "auth"]:
                        return self._send(200, {"items": [item, {"agent": "codex", "loggedIn": True, "requested": False, "session": None}]})
                    if method == "POST" and parts[2:] == ["auth", "start"]:
                        if parts[1] == "claude":  # its session above is still waiting for the user
                            return self._send(409, {"message": "A claude login is already in progress (waiting_user)"})
                        return self._send(200, {**item, "agent": parts[1], "requested": True, "session": None})
                    if method == "POST" and parts[2:] == ["auth", "code"]:
                        mock.login_codes = getattr(mock, "login_codes", []) + [json.loads(raw)]
                        return self._send(200, {**item, "agent": parts[1], "session": {**session, "status": "code_submitted"}})
                if method == "GET" and parts == ["system", "status"]:
                    return self._send(200, {
                        "controller": {"status": "ok", "version": "0.1.0", "uptimeSeconds": 5, "nodeVersion": "v24"},
                        "database": {"status": "ok"}, "tasks": {"total": len(mock.tasks), "byStatus": {}},
                        "workers": [{"agent": "claude", "workerId": "claude-worker", "queuedTasks": 0, "activeTasks": 0,
                                     **({"lastSeenAt": datetime.now(timezone.utc).isoformat(), "login": mock.worker_login}
                                        if getattr(mock, "worker_login", None) else {"lastSeenAt": None})}],
                        "projects": ["sandbox"], "services": [],
                    })
                return self._send(404, {"message": "no route"})

            def do_GET(self):
                self._handle("GET")

            def do_POST(self):
                self._handle("POST")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def add(self, agent: str, instruction: str, status: str = "queued", **fields) -> dict:
        task_id = str(uuid.uuid4())
        task = {"id": task_id, "agent": agent, "projectId": "sandbox", "instruction": instruction, "status": status,
                "result": None, "error": None, "createdAt": "2026-10-24T10:00:00.000Z", "updatedAt": "2026-10-24T10:00:00.000Z",
                "startedAt": None, "completedAt": None, "cancelRequestedAt": None, "claimedBy": None,
                "leaseExpiresAt": None, "attempt": 0, "createdBy": "delegator:hermes", "idempotencyKey": None}
        task.update(fields)
        self.tasks[task_id] = task
        self.order.append(task_id)
        return task

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class ControllerCliTest(unittest.TestCase):
    def setUp(self):
        self.mock = MockController()
        self.dir = tempfile.TemporaryDirectory()
        self.token_file = Path(self.dir.name) / "token"
        self.token_file.write_text(TOKEN + "\n", encoding="utf-8")
        self.instruction = Path(self.dir.name) / "instruction.txt"
        self.env = {
            "PERSONAL_AI_BROKER_URL": self.mock.url,
            "PERSONAL_AI_HOST_WORKSPACES": "D:\\personal_ai\\workspaces",
        }

    def tearDown(self):
        self.mock.close()
        self.dir.cleanup()

    def run_cli(self, *argv: str, env: dict | None = None) -> tuple[int, dict]:
        no_sleep = lambda config: controller.Client(config, timeout=5, sleep=lambda _s: None)  # noqa: E731
        return controller.run(list(argv), env or self.env, client_factory=no_sleep)

    def assert_no_token(self, payload):
        self.assertNotIn(TOKEN, json.dumps(payload))

    # ---- submit ------------------------------------------------------------------------

    def test_submit_reads_instruction_from_file_and_reports_the_task(self):
        text = 'Create index.html; $(rm -rf /) `whoami` "quotes" \'single\' && echo pwned\n한국어 지시'
        self.instruction.write_text(text, encoding="utf-8")
        code, out = self.run_cli("submit", "--agent", "claude", "--project", "sandbox", "--instruction-file", str(self.instruction))
        self.assertEqual(code, 0, out)
        self.assertTrue(out["ok"])
        self.assertFalse(out["duplicate"])
        self.assertEqual(out["task"]["agent"], "claude")
        self.assertEqual(out["task"]["projectId"], "sandbox")
        self.assertEqual(out["task"]["status"], "queued")
        self.assertNotIn("Authorization", self.mock.requests[-1]["headers"], "Hermes sends no token; the broker adds it")
        sent = json.loads(self.mock.requests[-1]["body"])
        self.assertEqual(sent, {"agent": "claude", "projectId": "sandbox", "instruction": text.strip()})
        self.assertTrue(self.mock.requests[-1]["headers"]["Idempotency-Key"].startswith("hermes-auto-"))
        self.assertFalse(self.instruction.exists(), "instruction file is consumed")
        self.assert_no_token(out)

    def test_submit_twice_returns_the_same_task_marked_duplicate(self):
        self.instruction.write_text("Make a page", encoding="utf-8")
        _, first = self.run_cli("submit", "--agent", "codex", "--project", "sandbox", "--instruction-file", str(self.instruction))
        self.instruction.write_text("Make a page", encoding="utf-8")
        _, second = self.run_cli("submit", "--agent", "codex", "--project", "sandbox", "--instruction-file", str(self.instruction))
        self.assertTrue(second["duplicate"])
        self.assertEqual(second["task"]["id"], first["task"]["id"])
        self.assertEqual(len(self.mock.tasks), 1)
        self.instruction.write_text("Make a page", encoding="utf-8")
        _, third = self.run_cli("submit", "--agent", "codex", "--project", "sandbox", "--instruction-file", str(self.instruction), "--new")
        self.assertFalse(third["duplicate"])
        self.assertEqual(len(self.mock.tasks), 2)

    def test_submit_retries_server_errors_with_the_same_idempotency_key(self):
        self.instruction.write_text("Make a page", encoding="utf-8")
        self.mock.fail_posts = [503, 502]
        code, out = self.run_cli("submit", "--agent", "claude", "--project", "sandbox", "--instruction-file", str(self.instruction))
        self.assertEqual(code, 0, out)
        posts = [r for r in self.mock.requests if r["method"] == "POST"]
        keys = {r["headers"]["Idempotency-Key"] for r in posts}
        self.assertEqual(len(posts), 3)
        self.assertEqual(len(keys), 1)
        self.assertEqual(len(self.mock.tasks), 1)

    def test_submit_rejects_unregistered_projects_and_disallowed_agents_without_creating_a_task(self):
        self.instruction.write_text("x", encoding="utf-8")
        for argv, expected, text in (
            (("--agent", "claude", "--project", "secret-repo"), "invalid_request", "Registered projects: docs, ghost, sandbox"),
            (("--agent", "claude", "--project", "../etc"), "invalid_request", "not a valid project id"),
            (("--agent", "codex", "--project", "docs"), "invalid_request", "Agent codex is not allowed"),
            (("--agent", "gemini", "--project", "sandbox"), "usage_error", ""),
        ):
            code, out = self.run_cli("submit", *argv, "--instruction-file", str(self.instruction))
            self.assertFalse(out["ok"])
            self.assertEqual(out["error"]["code"], expected, out)
            self.assertIn(text, out["error"]["message"])
            self.assertNotEqual(code, 0)
        self.assertEqual([r for r in self.mock.requests if r["method"] == "POST"], [])
        self.assertTrue(self.instruction.exists(), "file kept when nothing was submitted")

    def test_server_side_project_rejection_is_reported(self):
        self.instruction.write_text("x", encoding="utf-8")
        code, out = self.run_cli("submit", "--agent", "claude", "--project", "ghost", "--instruction-file", str(self.instruction))
        self.assertEqual(code, controller.EXIT_CODES["invalid_request"])
        self.assertEqual(out["error"]["httpStatus"], 400)
        self.assertIn("Unknown projectId", out["error"]["message"])

    def test_submit_requires_an_instruction_file(self):
        code, out = self.run_cli("submit", "--agent", "claude", "--project", "sandbox", "--instruction-file", str(self.instruction))
        self.assertEqual(out["error"]["code"], "usage_error")
        self.assertIn("not found", out["error"]["message"])
        self.instruction.write_text("   \n", encoding="utf-8")
        _, out = self.run_cli("submit", "--agent", "claude", "--project", "sandbox", "--instruction-file", str(self.instruction))
        self.assertIn("empty", out["error"]["message"])
        self.instruction.write_text("x" * (controller.MAX_INSTRUCTION_CHARS + 1), encoding="utf-8")
        _, out = self.run_cli("submit", "--agent", "claude", "--project", "sandbox", "--instruction-file", str(self.instruction))
        self.assertIn("limit", out["error"]["message"])

    # ---- status / result / wait -----------------------------------------------------------

    def test_status_of_a_running_task(self):
        task = self.mock.add("claude", "x", status="running", startedAt="2026-10-24T10:00:01.000Z", claimedBy="claude-worker")
        code, out = self.run_cli("status", task["id"])
        self.assertEqual(code, 0)
        self.assertEqual(out["task"]["status"], "running")
        self.assertFalse(out["task"]["finished"])
        self.assertIsNone(out["task"]["success"])
        self.assertNotIn("summary", out)

    def test_result_of_a_completed_task_reports_only_facts_from_the_report(self):
        task = self.mock.add("codex", "x", status="completed", startedAt="2026-10-24T10:00:00.000Z",
                             completedAt="2026-10-24T10:00:21.000Z")
        task["result"] = worker_report(task["id"], "codex", "completed")
        code, out = self.run_cli("result", task["id"])
        self.assertEqual(code, 0)
        report = out["report"]
        self.assertTrue(report["success"])
        self.assertEqual(report["branch"], f"codex/task-{task['id']}")
        self.assertEqual(report["commit"], "def123")
        self.assertEqual(report["changedFiles"], [{"status": "A", "path": "index.html"}])
        self.assertEqual(report["durationSeconds"], 12.3)
        self.assertEqual(report["hostPath"], f"D:\\personal_ai\\workspaces\\codex\\.worktrees\\{task['id']}")
        self.assertEqual(report["tests"]["reported"], False)
        self.assertEqual(report["commands"], [{"command": "npm test", "exitCode": 1}])
        self.assertNotIn("stderrTail", report, "stderr only for failures")
        self.assertEqual(out["task"]["elapsedSeconds"], 21.0)

    def test_result_of_a_failed_task_includes_the_error_report(self):
        task = self.mock.add("claude", "x", status="failed")
        task["error"] = worker_report(task["id"], "claude", "failed", message="Claude Code finished with error_during_execution")
        _, out = self.run_cli("result", task["id"])
        self.assertFalse(out["report"]["success"])
        self.assertEqual(out["report"]["outcome"], "failed")
        self.assertIn("boom", out["report"]["stderrTail"])

    def test_result_handles_plain_text_errors_and_unfinished_tasks(self):
        task = self.mock.add("codex", "x", status="failed", error="lease_expired: the worker stopped renewing its lease")
        _, out = self.run_cli("result", task["id"])
        self.assertEqual(out["report"]["format"], "text")
        self.assertIn("lease_expired", out["report"]["message"])
        running = self.mock.add("codex", "x", status="running")
        _, out = self.run_cli("result", running["id"])
        self.assertIsNone(out["report"])
        self.assertIn("still running", out["note"])

    def test_wait_returns_when_the_task_finishes(self):
        task = self.mock.add("claude", "x", status="running")
        calls = {"n": 0}

        def sleep(_seconds):
            calls["n"] += 1
            if calls["n"] == 2:
                task["status"] = "completed"
                task["result"] = worker_report(task["id"], "claude", "completed")

        config = controller.Config(self.env)
        client = controller.Client(config, sleep=lambda _s: None)
        args = controller.build_parser().parse_args(["wait", task["id"], "--timeout", "60"])
        out = controller.cmd_wait(client, config, args, sleep=sleep)
        self.assertEqual(out["task"]["status"], "completed")
        self.assertTrue(out["report"]["success"])

    def test_wait_gives_up_at_the_timeout(self):
        task = self.mock.add("claude", "x", status="running")
        clock = {"t": 0.0}
        config = controller.Config(self.env)
        client = controller.Client(config)
        args = controller.build_parser().parse_args(["wait", task["id"], "--timeout", "999"])
        out = controller.cmd_wait(client, config, args, sleep=lambda s: clock.__setitem__("t", clock["t"] + s),
                                  now=lambda: clock["t"])
        self.assertIsNone(out["report"])
        self.assertIn(f"after {controller.MAX_WAIT_SECONDS}s", out["note"])

    # ---- list / cancel / system-status ---------------------------------------------------

    def test_list_summarises_by_agent_and_status(self):
        self.mock.add("claude", "first\nline", status="completed")
        self.mock.add("codex", "second", status="running")
        self.mock.add("codex", "third", status="completed")
        code, out = self.run_cli("list", "--limit", "10")
        self.assertEqual(code, 0)
        self.assertEqual(out["total"], 3)
        self.assertEqual(out["countsShownByAgentAndStatus"], {"codex": {"completed": 1, "running": 1}, "claude": {"completed": 1}})
        self.assertEqual(out["tasks"][-1]["instruction"], "first line")
        self.assertIn("limit=10", self.mock.requests[-1]["path"])
        _, bad = self.run_cli("list", "--status", "exploded")
        self.assertEqual(bad["error"]["code"], "usage_error")

    def test_cancel_distinguishes_requested_from_stopped(self):
        queued = self.mock.add("claude", "x", status="queued")
        running = self.mock.add("claude", "x", status="running")
        _, out = self.run_cli("cancel", queued["id"])
        self.assertTrue(out["stopped"])
        self.assertEqual(out["task"]["status"], "canceled")
        _, out = self.run_cli("cancel", running["id"])
        self.assertEqual(out["outcome"], "cancel_requested")
        self.assertFalse(out["stopped"])
        self.assertIn("NOT yet confirmed", out["task"]["statusMeaning"])
        self.assertIn("Check status again", out["note"])
        code, out = self.run_cli("cancel", queued["id"])
        self.assertEqual(out["error"]["code"], "conflict")
        self.assertEqual(code, controller.EXIT_CODES["conflict"])

    def test_system_status(self):
        code, out = self.run_cli("system-status")
        self.assertEqual(code, 0)
        self.assertEqual(out["projects"], ["sandbox"])
        self.assertEqual(out["workers"][0]["online"], False)
        self.assertNotIn("nodeVersion", json.dumps(out))

    # ---- errors ---------------------------------------------------------------------------

    def test_error_codes(self):
        _, out = self.run_cli("status", str(uuid.uuid4()))
        self.assertEqual(out["error"]["code"], "not_found")
        sent = len(self.mock.requests)
        _, out = self.run_cli("status", "../../etc/passwd")
        self.assertEqual(out["error"]["code"], "usage_error")
        self.assertEqual(len(self.mock.requests), sent, "invalid ids never reach the API")

        self.mock.require_token = TOKEN
        self.token_file.write_text("w" * 40, encoding="utf-8")
        code, out = self.run_cli("system-status", env={**self.env, "CONTROLLER_TOKEN_FILE": str(self.token_file)})
        self.assertEqual(out["error"]["code"], "auth_error")
        self.assertEqual(code, controller.EXIT_CODES["auth_error"])

    def test_missing_token_file_and_unreachable_controller(self):
        _, out = self.run_cli("system-status", env={**self.env, "CONTROLLER_TOKEN_FILE": str(Path(self.dir.name) / "nope")})
        self.assertEqual(out["error"]["code"], "config_error")
        port = self.mock.server.server_address[1]
        self.mock.close()
        self.mock = MockController()  # tearDown closes this one
        code, out = self.run_cli("system-status", env={**self.env, "PERSONAL_AI_BROKER_URL": f"http://127.0.0.1:{port}"})
        self.assertEqual(out["error"]["code"], "connection_error")
        self.assertEqual(code, controller.EXIT_CODES["connection_error"])
        self.assertIn("Cannot reach the task service", out["error"]["message"])

    def test_cancel_is_not_retried_on_server_errors_more_than_allowed(self):
        task = self.mock.add("claude", "x", status="running")
        self.mock.fail_next = [500, 500, 500]
        code, out = self.run_cli("cancel", task["id"])
        self.assertEqual(out["error"]["code"], "server_error")
        self.assertEqual(code, controller.EXIT_CODES["server_error"])

    def test_cli_prints_one_json_object_and_never_the_token(self):
        self.mock.fail_next = [401]
        env = {**os.environ, **self.env, "CONTROLLER_TOKEN_FILE": str(self.token_file)}
        proc = subprocess.run([sys.executable, str(SCRIPT), "system-status"], env=env,
                              capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, controller.EXIT_CODES["auth_error"])
        payload = json.loads(proc.stdout)
        self.assertFalse(payload["ok"])
        self.assertNotIn(TOKEN, proc.stdout + proc.stderr)
        self.assertEqual(proc.stderr, "")


    def test_operator_mode_sends_the_token_from_its_file_only(self):
        self.mock.require_token = TOKEN
        code, out = self.run_cli("projects", env={**self.env, "CONTROLLER_TOKEN_FILE": str(self.token_file)})
        self.assertEqual(code, 0, out)
        self.assertEqual([p["id"] for p in out["projects"]], ["sandbox", "docs", "ghost"])
        self.assertIn("administrator", out["note"])
        self.assert_no_token(out)
        _, out = self.run_cli("projects")
        self.assertEqual(out["error"]["code"], "auth_error", "no token configured -> rejected by a token-checking server")

    def test_rate_limit_is_reported(self):
        self.mock.fail_next = [429]
        _, out = self.run_cli("list")
        self.assertEqual(out["error"]["code"], "rate_limited")


if __name__ == "__main__":
    unittest.main()
