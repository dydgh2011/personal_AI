"""Tests for the Hermes plugin: the personal_ai_task tool and the pre_tool_call guard.

    python -m unittest discover -s services/hermes-integration/tests -v
"""

from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_controller import MockController  # noqa: E402

PLUGIN_DIR = Path(__file__).resolve().parents[1] / "plugins" / "personal-ai-controller"
_spec = importlib.util.spec_from_file_location("personal_ai_controller_plugin", PLUGIN_DIR / "__init__.py",
                                               submodule_search_locations=[str(PLUGIN_DIR)])
plugin = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = plugin
_spec.loader.exec_module(plugin)
guard = plugin.guard


class FakeContext:
    def __init__(self):
        self.tools = {}
        self.hooks = {}

    def register_tool(self, **kwargs):
        self.tools[kwargs["name"]] = kwargs

    def register_hook(self, name, fn):
        self.hooks[name] = fn

    def register_command(self, name, handler, description="", args_hint=""):
        self.commands = getattr(self, "commands", {})
        self.commands[name] = handler


class ToolTest(unittest.TestCase):
    def setUp(self):
        self.mock = MockController()
        self.env = {"PERSONAL_AI_BROKER_URL": self.mock.url, "PERSONAL_AI_HOST_WORKSPACES": "D:\\personal_ai\\workspaces"}

    def tearDown(self):
        self.mock.close()

    def tool(self, **args):
        return plugin.run_tool(args, env=self.env,
                               client_factory=lambda c: plugin.client_lib.Client(c, timeout=5, sleep=lambda _s: None))

    def login(self, **args):
        return plugin.run_login_tool(args, env=self.env,
                                     client_factory=lambda c: plugin.client_lib.Client(c, timeout=5, sleep=lambda _s: None))

    def test_login_tool(self):
        status = self.login(action="status")
        self.assertTrue(status["ok"])
        self.assertEqual(status["workers"][0]["session"]["status"], "waiting_user")
        started = self.login(action="start", agent="codex")
        self.assertTrue(started["ok"])
        self.assertEqual((self.mock.requests[-1]["method"], self.mock.requests[-1]["path"]), ("POST", "/workers/codex/auth/start"))
        # A link is already out: no error, the tool says to use the message already on Discord.
        again = self.login(action="start", agent="claude")
        self.assertEqual((again["ok"], again["alreadyWaiting"], again["worker"]["session"]["status"]), (True, True, "waiting_user"))
        sent = self.login(action="code", agent="claude", code="  AbCd1234#state-xyz  ")
        self.assertTrue(sent["ok"])
        self.assertEqual(self.mock.login_codes, [{"code": "AbCd1234#state-xyz"}])
        self.assertEqual(self.login(action="code", agent="claude")["error"]["code"], "invalid_request")
        # start/code never fall back to a default worker: the model must name the one the user meant.
        self.assertEqual(self.login(action="start")["error"]["code"], "usage_error")
        self.assertEqual(self.login(action="login_start", agent="codex")["error"]["code"], "usage_error")
        # Logins are no longer actions of the task tool.
        self.assertEqual(self.tool(action="login_start", agent="codex")["error"]["code"], "usage_error")

    def test_system_status_points_at_the_login_tool_when_a_worker_is_logged_out(self):
        self.mock.worker_login = {"loggedIn": False, "sessionStatus": "failed", "requested": False}
        out = self.tool(action="system_status")
        worker = out["workers"][0]
        self.assertEqual((worker["online"], worker["state"], worker["loggedIn"]), (True, "login_required", False))
        self.assertIn('personal_ai_worker_login(action="start", agent="claude")', out["attention"][0])
        # While a login link is out, there is nothing to start.
        self.mock.worker_login = {"loggedIn": False, "sessionStatus": "waiting_user", "requested": False}
        self.assertNotIn("attention", self.tool(action="system_status"))

    def planner(self, **args):
        return plugin.run_planner_tool(args, env=self.env,
                                       client_factory=lambda c: plugin.client_lib.Client(c, timeout=5, sleep=lambda _s: None))

    def test_planner_day_shows_calendar_events_and_blocks_in_order(self):
        out = self.planner(action="day", date="2026-11-23")
        self.assertTrue(out["ok"])
        self.assertEqual(out["display"].splitlines(), [
            "2026-11-23(월) 초안(미확정)",
            "  [마감·이날까지] 종일 마감: 보고서",
            "  [계획·공부] 07:00-08:30 알고리즘 과제 (block_id 11111111-1111-4111-8111-111111111111)",
            "  [수업] 09:00-11:00 CSC263 (event_id lec1_20261123T140000Z, 반복)",
        ])
        self.assertEqual(self.mock.planner_calls[-1][:2], ("GET", "/planner/day?date=2026-11-23"))

    def test_planner_confirm_and_deadline_changes_need_the_users_ok(self):
        refused = self.planner(action="confirm", dates=["2026-11-23"])
        self.assertEqual(refused["error"]["code"], "needs_confirmation")
        self.assertFalse(getattr(self.mock, "planner_calls", []), "nothing reaches the planner without the OK")
        self.assertTrue(self.planner(action="confirm", dates=["2026-11-23"], confirmed_by_user=True)["ok"])
        self.assertEqual(self.mock.planner_calls[-1], ("POST", "/planner/plans/confirm", {"dates": ["2026-11-23"]}))
        todo = "22222222-2222-4222-8222-222222222222"
        self.assertEqual(self.planner(action="todo_update", todo_id=todo, deadline="2026-12-02")["error"]["code"], "needs_confirmation")
        self.assertTrue(self.planner(action="todo_update", todo_id=todo, priority=1)["ok"], "other changes apply directly")
        self.assertEqual(self.mock.planner_calls[-1][2], {"priority": 1})

    def test_planner_validates_before_sending(self):
        self.assertEqual(self.planner(action="nope")["error"]["code"], "usage_error")
        self.assertEqual(self.planner(action="block_add", date="23-11-2026", start="07:00", end="08:00")["error"]["code"], "usage_error")
        self.assertEqual(self.planner(action="block_add", date="2026-11-23", start="7pm", end="08:00")["error"]["code"], "usage_error")
        self.assertEqual(self.planner(action="block_remove", block_id="../todos")["error"]["code"], "usage_error")
        self.assertEqual(self.planner(action="todo_add", title="보고서")["error"]["code"], "usage_error")
        self.assertEqual(self.planner(action="settings_update", settings={"token": "x"})["error"]["code"], "usage_error")
        self.assertFalse(getattr(self.mock, "planner_calls", []))
        added = self.planner(action="todo_add", title="보고서", estimate_minutes=90, deadline="2026-11-30")
        self.assertIn("마감 2026-11-30", added["display"])
        self.assertEqual(self.mock.planner_calls[-1][2], {"title": "보고서", "estimateMinutes": 90, "deadline": "2026-11-30"})

    def test_planner_fixed_events_and_import(self):
        added = self.planner(action="event_add", title="치과", date="2026-11-24", start="15:00", end="16:00", category="personal")
        self.assertTrue(added["ok"])
        self.assertEqual(self.mock.planner_calls[-1][2], {"title": "치과", "date": "2026-11-24", "category": "personal",
                                                          "start": "15:00", "end": "16:00"})
        weekly = self.planner(action="event_add", title="헬스", date="2026-11-23", start="07:00", end="08:00", category="routine",
                              repeat="weekly", repeat_days=["MO", "TH"], until="2026-12-31")
        self.assertTrue(weekly["ok"])
        self.assertEqual(self.mock.planner_calls[-1][2]["repeatDays"], ["MO", "TH"])
        self.assertEqual(self.planner(action="event_add", title="x", date="2026-11-24", start="15:00", end="16:00",
                                      category="deadline")["error"]["code"], "usage_error", "deadline markers belong to todos")
        calls = len(self.mock.planner_calls)
        for action in ("event_update", "event_remove"):
            self.assertEqual(self.planner(action=action, event_id="evt123abc", start="16:00")["error"]["code"], "needs_confirmation")
        self.assertEqual(self.planner(action="proposal_apply", proposal="A")["error"]["code"], "needs_confirmation")
        self.assertEqual(self.planner(action="import_apply", items=[1])["error"]["code"], "usage_error", "no direct import any more")
        self.assertEqual(len(self.mock.planner_calls), calls, "nothing sent without the OK")
        self.assertTrue(self.planner(action="event_remove", event_id="evt123abc", scope="series", confirmed_by_user=True)["ok"])
        self.assertEqual(self.mock.planner_calls[-1][1:], ("/planner/events/evt123abc/remove", {"scope": "series"}))

        self.assertEqual(self.planner(action="reference_sync", calendars=["Classes"])["display"], "Classes: 26개 (반복 26개)")
        found = self.planner(action="reference_search", text="gym", calendar_name="Rountine")
        self.assertEqual(found["display"], "[Rountine] Gym · 매주 화·수·목 19:00–21:00")
        self.assertEqual(self.mock.planner_calls[-1][2], {"text": "gym", "calendar": "Rountine"})

    def test_planner_proposals(self):
        made = self.planner(action="proposal_create", title="루틴 시안 A", items=[
            {"title": "헬스", "date": "2026-11-23", "start": "07:00", "end": "08:00", "category": "routine",
             "repeat": "weekly", "repeat_days": ["MO", "WE", "FR"], "interval": 1}])
        self.assertTrue(made["ok"])
        self.assertIn("A-1 [루틴] 헬스 · 매주 월·수·금 07:00–08:00", made["display"])
        self.assertEqual(self.mock.planner_calls[-1][2]["items"][0]["repeatDays"], ["MO", "WE", "FR"], "snake_case is renamed for the planner")
        for bad in ([{"title": "x", "date": "2026-11-23", "start": "07:00", "end": "08:00", "category": "routine", "colour": "red"}],
                    [{"title": "x", "date": "2026-11-23", "category": "routine"}],
                    [{"title": "x", "date": "2026-11-23", "start": "7am", "end": "08:00", "category": "routine"}]):
            self.assertEqual(self.planner(action="proposal_create", title="t", items=bad)["error"]["code"], "usage_error")
        edited = self.planner(action="proposal_edit", proposal="a", update_items=[{"n": 1, "start": "06:00", "end": "07:00"}], remove_items=[2])
        self.assertTrue(edited["ok"])
        self.assertEqual(self.mock.planner_calls[-1][1:], ("/planner/proposals/A/edit", {"update": [{"n": 1, "start": "06:00", "end": "07:00"}], "remove": [2]}))
        self.assertEqual(self.planner(action="proposal_edit", proposal="A", update_items=[{"start": "06:00"}])["error"]["code"], "usage_error")
        calls = len(self.mock.planner_calls)
        self.assertEqual(self.planner(action="proposal_apply", proposal="A")["error"]["code"], "needs_confirmation")
        self.assertEqual(len(self.mock.planner_calls), calls)
        applied = self.planner(action="proposal_apply", proposal="A", item_numbers=[1], confirmed_by_user=True)
        self.assertIn("Written to the Kelly calendar: 1", applied["note"])
        self.assertEqual(self.planner(action="proposal_show", proposal="../x")["error"]["code"], "usage_error")

    def test_registers_tools_and_the_guard_hook(self):
        ctx = FakeContext()
        plugin.register(ctx)
        self.assertEqual(list(ctx.tools), ["personal_ai_task", "personal_ai_worker_login", "personal_ai_planner",
                                           "personal_ai_document", "personal_ai_school", "personal_ai_learning"])
        document = ctx.tools["personal_ai_document"]
        self.assertEqual(document["toolset"], "personal_ai")
        self.assertEqual(document["schema"]["parameters"]["properties"]["action"]["enum"], ["list", "find", "read"])
        self.assertEqual(json.loads(document["handler"]({"action": "nope"}))["error"]["code"], "usage_error")
        self.assertEqual(ctx.tools["personal_ai_planner"]["toolset"], "personal_ai")
        login = ctx.tools["personal_ai_worker_login"]
        self.assertEqual(login["toolset"], "personal_ai")
        self.assertEqual(login["schema"]["parameters"]["properties"]["action"]["enum"], ["start", "code", "status"])
        self.assertEqual(json.loads(login["handler"]({"action": "nope"}))["error"]["code"], "usage_error")
        spec = ctx.tools["personal_ai_task"]
        self.assertEqual(spec["toolset"], "personal_ai")
        self.assertEqual(spec["schema"]["parameters"]["required"], ["action"])
        self.assertFalse(spec["schema"]["parameters"]["additionalProperties"])
        learning = ctx.tools["personal_ai_learning"]
        self.assertEqual(learning["toolset"], "personal_ai")
        self.assertEqual(learning["schema"]["parameters"]["properties"]["action"]["enum"], ["query", "propose"])
        self.assertEqual(json.loads(learning["handler"]({"action": "apply"}))["error"]["code"], "usage_error")
        self.assertIs(ctx.hooks["pre_tool_call"], guard.pre_tool_call)
        # The handler returns a JSON string, as Hermes expects.
        self.assertEqual(json.loads(spec["handler"]({"action": "nope"}))["error"]["code"], "usage_error")

    def test_submit_passes_the_instruction_verbatim_without_a_shell_or_file(self):
        text = 'Create index.html; $(rm -rf /) `id` "q" \'s\'\n한국어'
        out = self.tool(action="submit", agent="codex", project_id="sandbox", instruction=text)
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["task"]["agent"], "codex")
        post = [r for r in self.mock.requests if r["method"] == "POST"][0]
        self.assertEqual(json.loads(post["body"]), {"agent": "codex", "projectId": "sandbox", "instruction": text.strip()})
        self.assertNotIn("Authorization", post["headers"])
        self.assertIn("작업을 등록했습니다.", out["userReport"])
        self.assertIn(out["task"]["id"], out["userReport"])
        again = self.tool(action="submit", agent="codex", project_id="sandbox", instruction=text)
        self.assertTrue(again["duplicate"])
        self.assertIn("새로 만들지 않음", again["userReport"])

    def test_user_report_contains_only_reported_facts(self):
        from test_controller import worker_report
        task = self.mock.add("claude", "x", status="completed")
        task["result"] = worker_report(task["id"], "claude", "completed")
        text = self.tool(action="result", task_id=task["id"])["userReport"]
        for expected in [f"작업 ID: {task['id']}", "결과: 성공", "변경 파일: A index.html", f"Git 브랜치: claude/task-{task['id']}",
                         "커밋: def123", "실행 시간: 12.3초", "테스트: 작업 보고서에 테스트 결과 없음",
                         f"PC 경로: D:\personal_ai\workspaces\claude\.worktrees\{task['id']}"]:
            self.assertIn(expected, text)
        self.assertNotIn("오류", text)
        failed = self.mock.add("codex", "y", status="failed")
        failed["error"] = worker_report(failed["id"], "codex", "failed", workspaceError="commit failed")
        text = self.tool(action="result", task_id=failed["id"])["userReport"]
        self.assertIn("결과: 실패", text)
        self.assertIn("오류: commit failed", text)
        running = self.mock.add("codex", "z", status="running")
        self.assertIn("상태: 실행 중", self.tool(action="status", task_id=running["id"])["userReport"])
        self.assertIn("아직 중단이 확인되지 않았습니다", self.tool(action="cancel", task_id=running["id"])["userReport"])

    def test_submit_validation(self):
        self.assertEqual(self.tool(action="submit", agent="claude", project_id="secret-repo", instruction="x")["error"]["code"],
                         "invalid_request")
        self.assertIn("not allowed", self.tool(action="submit", agent="codex", project_id="docs", instruction="x")["error"]["message"])
        self.assertIn("empty", self.tool(action="submit", agent="claude", project_id="sandbox")["error"]["message"])
        self.assertEqual(self.tool(action="submit", agent="claude", instruction="x")["error"]["code"], "invalid_request")
        self.assertEqual([r for r in self.mock.requests if r["method"] == "POST"], [])

    def test_read_actions(self):
        task = self.mock.add("claude", "x", status="running")
        self.assertEqual(self.tool(action="status", task_id=task["id"])["task"]["status"], "running")
        self.assertIsNone(self.tool(action="result", task_id=task["id"])["report"])
        self.mock.add("codex", "y", status="completed")
        listed = self.tool(action="list", list_agent="codex", limit=5)
        self.assertTrue(listed["ok"])
        self.assertIn("agent=codex", self.mock.requests[-1]["path"])
        self.assertIn("limit=5", self.mock.requests[-1]["path"])
        self.assertEqual([p["id"] for p in self.tool(action="projects")["projects"]], ["sandbox", "docs", "ghost"])
        self.assertTrue(self.tool(action="system_status")["ok"])
        cancel = self.tool(action="cancel", task_id=task["id"])
        self.assertEqual(cancel["outcome"], "cancel_requested")
        self.assertFalse(cancel["stopped"])
        self.assertEqual(self.tool(action="status", task_id="../../x")["error"]["code"], "usage_error")

    def test_sends_the_broker_client_key_from_its_file(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            key_file = Path(d) / "key"
            key_file.write_text("b" * 48, encoding="utf-8")
            out = plugin.run_tool({"action": "projects"}, env={**self.env, "PERSONAL_AI_BROKER_KEY_FILE": str(key_file)},
                                  client_factory=lambda c: plugin.client_lib.Client(c, timeout=5))
            self.assertTrue(out["ok"])
            self.assertEqual(self.mock.requests[-1]["headers"].get("X-Broker-Key"), "b" * 48)
            self.assertNotIn("b" * 48, json.dumps(out))
            missing = plugin.run_tool({"action": "projects"}, env={**self.env, "PERSONAL_AI_BROKER_KEY_FILE": str(Path(d) / "nope")})
            self.assertEqual(missing["error"]["code"], "config_error")

    def test_review_is_read_only_and_reports_the_diff(self):
        task = self.mock.add("claude", "x", status="completed")
        task["diff"] = {"taskId": task["id"], "projectId": "sandbox", "agent": "claude", "baseSha": "a" * 40, "headSha": "b" * 40,
                        "additions": 3, "deletions": 1, "tests": None, "patch": "diff --git a/x b/x", "patchWithheld": None,
                        "files": [{"path": "x", "status": "M", "additions": 3, "deletions": 1, "binary": False, "sensitive": False},
                                  {"path": ".env", "status": "A", "additions": 1, "deletions": 0, "binary": False, "sensitive": True}],
                        "review": {"status": "awaiting_approval", "headSha": "b" * 40}}
        out = self.tool(action="review", task_id=task["id"])
        self.assertEqual(out["reviewStatus"], "awaiting_approval")
        self.assertIn("승인 대기", out["userReport"])
        self.assertIn("민감 정보 의심", out["userReport"])
        self.assertIn("관리자만", out["userReport"])
        self.assertTrue(all(r["method"] == "GET" for r in self.mock.requests), "review never writes")

    def test_unreachable_broker_is_an_error_result_not_an_exception(self):
        self.mock.close()
        out = plugin.run_tool({"action": "projects"}, env={"PERSONAL_AI_BROKER_URL": "http://127.0.0.1:9"},
                              client_factory=lambda c: plugin.client_lib.Client(c, timeout=2, retries=1))
        self.assertEqual(out["error"]["code"], "connection_error")
        self.mock = MockController()


class GuardTest(unittest.TestCase):
    def blocked(self, tool, args):
        return guard.pre_tool_call(tool_name=tool, args=args)

    def test_blocks_the_bypasses_seen_in_testing(self):
        for command in [
            "docker ps",
            "cd /x && docker compose up",
            "claude --version",
            "/usr/bin/codex exec hi",
            "npm install -g @anthropic-ai/claude-code",
            "npm i -g @openai/codex",
            "pip install requests",
            "cat /run/secrets/controller_token",
            "env | grep CONTROLLER_HERMES_TOKEN",
            "curl http://controller:3000/tasks",
            "git push origin main",
            "git clone https://github.com/a/b",
        ]:
            result = self.blocked("terminal", {"command": command})
            self.assertIsNotNone(result, command)
            self.assertEqual(result["action"], "block")
        self.assertIsNotNone(self.blocked("execute_code", {"code": "import os; os.system('docker ps')"}))
        self.assertIsNotNone(self.blocked("delegate_task", {"goal": "write the app"}))

    def test_protects_credentials_and_the_integration_files(self):
        self.assertIsNotNone(self.blocked("read_file", {"path": "/run/secrets/controller_token"}))
        self.assertIsNotNone(self.blocked("read_file", {"path": "/opt/data/.env"}))
        self.assertIsNotNone(self.blocked("read_file", {"path": "/opt/data/auth.json"}))
        for path in ["/opt/data/plugins/personal-ai-controller/guard.py", "/opt/data/config.yaml", "/opt/data/SOUL.md",
                     "/opt/personal-ai/skills/personal-ai-controller/SKILL.md", "/opt/data/skills/x/personal-ai-controller/SKILL.md"]:
            self.assertIsNotNone(self.blocked("write_file", {"path": path, "content": "x"}), path)
            self.assertIsNotNone(self.blocked("patch", {"path": path, "old": "a", "new": "b"}), path)
        self.assertIsNotNone(self.blocked("skill_manage", {"action": "create", "name": "personal-ai-controller"}))
        self.assertIsNotNone(self.blocked("skill_manage", {"action": "create", "name": "personal_ai_tasks", "content": "use terminal"}))

    def test_leaves_ordinary_work_alone(self):
        for tool, args in [
            ("terminal", {"command": "ls -la"}),
            ("terminal", {"command": "python3 -c 'print(1)'"}),
            ("read_file", {"path": "/opt/data/home/notes.md"}),
            ("write_file", {"path": "/opt/data/home/notes.md", "content": "docker is mentioned in prose"}),
            ("web_search", {"query": "docker compose secrets"}),
            ("skill_manage", {"action": "create", "name": "weekly-report"}),
            ("personal_ai_task", {"action": "submit", "instruction": "write a Dockerfile; use docker compose"}),
            ("memory", {"content": "The user prefers Claude"}),
        ]:
            self.assertIsNone(self.blocked(tool, args), (tool, args))

    def test_blocks_the_browser_from_local_files_and_internal_services(self):
        for url in ["file:///run/secrets/x", "http://hermes-broker:8080/tasks", "http://controller:3000/tasks",
                    "http://127.0.0.1:8700/projects", "http://172.18.0.4:3000/", "http://localhost:9119/", "http://[::1]:8080/",
                    "http://learning:3000/schedule"]:
            self.assertIsNotNone(self.blocked("browser_navigate", {"url": url}), url)
        for url in ["https://github.com/octocat", "https://docs.python.org/3/", "https://example.com/controller/docs"]:
            self.assertIsNone(self.blocked("browser_navigate", {"url": url}), url)

    def test_never_raises(self):
        class Weird:
            def __repr__(self):
                raise RuntimeError("boom")
        self.assertIsNone(guard.pre_tool_call(tool_name="terminal", args={"x": Weird()}))
        self.assertIsNone(guard.pre_tool_call())


if __name__ == "__main__":
    unittest.main()
