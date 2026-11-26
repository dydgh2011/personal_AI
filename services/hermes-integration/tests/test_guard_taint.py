"""Tests for the turn taint, the settings rule and the confirmation gate changes (guard.py, turn_state.py; 2026-11-26).

    python -m unittest discover -s services/hermes-integration/tests -v
"""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1] / "plugins" / "personal-ai-controller"
_spec = importlib.util.spec_from_file_location("personal_ai_controller_taint_test", PLUGIN_DIR / "__init__.py",
                                               submodule_search_locations=[str(PLUGIN_DIR)])
plugin = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = plugin
_spec.loader.exec_module(plugin)
guard = plugin.guard
turn_state = plugin.turn_state

PLANNER = "personal_ai_planner"
SCHOOL = "personal_ai_school"


class Clock:
    def __init__(self, now: float = 1000.0):
        self.now = now

    def __call__(self) -> float:
        return self.now


class TurnTest(unittest.TestCase):
    """Drives the hooks the way Hermes does: pre_llm_call once per turn, then pre/post_tool_call per call."""

    def setUp(self):
        self.clock = Clock()
        self._saved = (guard.TURNS, guard.GATE)
        guard.TURNS = turn_state.TurnLedger()
        guard.GATE = guard.ConfirmationGate(clock=self.clock)
        self.session = "s1"
        self.n = 0

    def tearDown(self):
        guard.TURNS, guard.GATE = self._saved

    def turn(self, message="오늘 일정 알려줘", session=None):
        self.n += 1
        self.turn_id = f"{session or self.session}:task:{self.n}"
        guard.pre_llm_call(session_id=session or self.session, turn_id=self.turn_id, user_message=message,
                           conversation_history=[], model="kelly", platform="discord")
        return self.turn_id

    def call(self, tool, result=None, **args):
        blocked = guard.pre_tool_call(tool_name=tool, args=args, session_id=self.session, turn_id=self.turn_id,
                                      task_id="t", tool_call_id="c")
        if blocked is None:
            guard.post_tool_call(tool_name=tool, args=args, result=json.dumps(result if result is not None else {"ok": True}),
                                 session_id=self.session, turn_id=self.turn_id, status="ok")
        return blocked


class TaintTest(TurnTest):
    def test_outside_text_blocks_changes_until_the_owner_writes_again(self):
        self.turn("학교 공지 확인해줘")
        self.assertIsNone(self.call(SCHOOL, action="updates", days=3))
        with self.assertLogs("personal_ai.guard", "INFO") as logs:
            blocked = self.call(PLANNER, action="todo_add", title="A3", estimate_minutes=120)
        self.assertEqual(blocked["action"], "block")
        self.assertIn("school.updates", blocked["message"])
        self.assertIn("end your turn", blocked["message"])
        self.assertTrue(any("outside-text block tool=personal_ai_planner action=todo_add" in line for line in logs.output))
        # reading stays allowed in the same turn
        for tool, args in [(PLANNER, {"action": "day"}), (PLANNER, {"action": "week"}), (PLANNER, {"action": "todo_list"}),
                           (PLANNER, {"action": "status"}), (SCHOOL, {"action": "read", "service": "quercus", "id": "1"}),
                           ("personal_ai_knowledge", {"action": "search", "query": "x"})]:
            self.assertIsNone(self.call(tool, **args), (tool, args))
        # every kind of change is held: planner, school decisions, knowledge, tasks, learning, logins, settings
        for tool, args in [(PLANNER, {"action": "event_add", "title": "x", "date": "2026-12-01"}),
                           (PLANNER, {"action": "todo_update", "todo_id": "t1", "status": "done"}),
                           (PLANNER, {"action": "todo_progress", "todo_id": "t1", "minutes": 30}),
                           (PLANNER, {"action": "block_add", "date": "2026-12-01"}),
                           (PLANNER, {"action": "proposal_apply", "proposal": "A", "confirmed_by_user": True}),
                           (PLANNER, {"action": "settings_update", "settings": {"remindScope": "planner"}}),
                           (SCHOOL, {"action": "deadline_dismiss", "id": "quercus:1", "reason": "x"}),
                           (SCHOOL, {"action": "mail_rule_set", "match": "x", "rule": "ignore"}),
                           ("personal_ai_knowledge", {"action": "fact_add", "page": "preferences", "text": "x"}),
                           ("personal_ai_task", {"action": "submit", "agent": "claude", "project_id": "p", "instruction": "x"}),
                           ("personal_ai_worker_login", {"action": "start", "agent": "codex"}),
                           ("personal_ai_learning", {"action": "propose"})]:
            self.assertIsNotNone(self.call(tool, **args), (tool, args))
        # the owner's next message starts a clean turn
        self.turn("응 A3 넣어줘")
        self.assertIsNone(self.call(PLANNER, action="todo_add", title="A3", estimate_minutes=120))

    def test_untrusted_sources(self):
        tainting = [("web_search", {"query": "x"}), ("web_extract", {"urls": ["https://e.com"]}), ("x_search", {"q": "x"}),
                    ("browser_navigate", {"url": "https://e.com"}), ("browser_snapshot", {}), ("vision_analyze", {"image_url": "x"}),
                    ("manage_connections", {"action": "run"}), ("mcp__gmail__read", {}),
                    (SCHOOL, {"action": "updates"}), (SCHOOL, {"action": "read"}), (SCHOOL, {"action": "deadlines"}),
                    (SCHOOL, {"action": "check_now"}), ("personal_ai_document", {"action": "find"}),
                    ("personal_ai_document", {"action": "read", "document": "syllabus", "pages": "1"}),
                    ("personal_ai_knowledge", {"action": "raw", "raw_id": "x"}), ("personal_ai_knowledge", {"action": "raw_list"}),
                    ("personal_ai_knowledge", {"action": "media_submit"}), ("personal_ai_task", {"action": "result", "task_id": "x"}),
                    ("personal_ai_task", {"action": "review", "task_id": "x"}), ("personal_ai_task", {"action": "wait"}),
                    (PLANNER, {"action": "reference_search", "text": "x"})]
        for tool, args in tainting:
            self.turn()
            self.assertIsNone(self.call(tool, **args), tool)
            self.assertIsNotNone(self.call(PLANNER, action="todo_add", title="x", estimate_minutes=30), (tool, args))
        clean = [(SCHOOL, {"action": "status"}), (SCHOOL, {"action": "settings"}), ("personal_ai_document", {"action": "list"}),
                 ("personal_ai_knowledge", {"action": "page", "page": "CSC207"}), (PLANNER, {"action": "week"}),
                 ("personal_ai_task", {"action": "status", "task_id": "x"}), ("personal_ai_learning", {"action": "query"}),
                 ("memory", {"action": "add"}), ("session_search", {"query": "x"}), ("skill_view", {"name": "x"})]
        for tool, args in clean:
            self.turn()
            self.assertIsNone(self.call(tool, **args), tool)
            self.assertIsNone(self.call(PLANNER, action="todo_add", title="x", estimate_minutes=30), (tool, args))

    def test_a_knowledge_search_taints_only_when_it_returned_raw_records(self):
        self.turn()
        self.call("personal_ai_knowledge", result={"ok": True, "results": [{"kind": "fact", "text": "x"}]}, action="search")
        self.assertIsNone(self.call(PLANNER, action="todo_add", title="x", estimate_minutes=30))
        self.call("personal_ai_knowledge", result={"ok": True, "results": [{"kind": "raw", "text": "mail"}]}, action="search")
        self.assertIn("knowledge.search(raw)", self.call(PLANNER, action="todo_add", title="y", estimate_minutes=30)["message"])

    def test_unknown_actions_and_tools_count_as_changes(self):
        self.assertFalse(turn_state.is_write(PLANNER, {"action": "day"}))
        self.assertTrue(turn_state.is_write(PLANNER, {"action": "upcoming_new"}))
        self.assertTrue(turn_state.is_write(PLANNER, {}))
        self.assertTrue(turn_state.is_write("personal_ai_future", {"action": "list"}))
        self.assertFalse(turn_state.is_write("web_search", {"action": "x"}))
        for tool, actions in turn_state.READ_ONLY_ACTIONS.items():
            self.assertTrue(tool.startswith("personal_ai_"))
            self.assertNotIn("settings_update", actions)
        # every read-only planner / school / document action is a real action of that tool
        # planner: agenda and pace come with the planner change of 2026-11-26 (may not be in this planner_client yet)
        self.assertLessEqual(turn_state.READ_ONLY_ACTIONS[PLANNER] - {"agenda", "pace"}, set(plugin.planner_client.ACTIONS))
        for action in ("todo_schedule", "report", "todo_progress", "generate", "reference_sync", "calendar_connect"):
            self.assertTrue(turn_state.is_write(PLANNER, {"action": action}), action)
        self.assertLessEqual(turn_state.READ_ONLY_ACTIONS[SCHOOL], set(plugin.school_client.ACTIONS))
        self.assertLessEqual(turn_state.READ_ONLY_ACTIONS["personal_ai_document"], set(plugin.document_client.ACTIONS))
        self.assertLessEqual(turn_state.READ_ONLY_ACTIONS["personal_ai_task"], set(plugin.ACTIONS))

    def test_a_held_change_is_the_preview_for_the_owners_next_turn(self):
        self.turn("이 강의계획서 마감 넣어줘")
        self.call("personal_ai_document", action="read", document="syllabus", pages="2")
        args = {"action": "event_remove", "event_id": "e1"}
        self.assertIsNotNone(self.call(PLANNER, **args))
        self.turn("응 지워줘")
        self.assertIsNone(self.call(PLANNER, **args, confirmed_by_user=True))

    def test_a_confirmation_after_reading_outside_text_waits_too(self):
        self.turn()
        args = {"action": "event_remove", "event_id": "e1"}
        self.assertIsNone(self.call(PLANNER, **args))          # preview shown
        self.turn("응")
        self.call(SCHOOL, action="updates")                     # outside text before the OK is used
        self.assertIn("outside", self.call(PLANNER, **args, confirmed_by_user=True)["message"])
        self.turn("응 지워")
        self.assertIsNone(self.call(PLANNER, **args, confirmed_by_user=True), "the preview was not used up")

    def test_turns_are_per_session_and_calls_without_a_session_are_not_tracked(self):
        self.turn()
        self.call(SCHOOL, action="updates")
        other = guard.pre_tool_call(tool_name=PLANNER, args={"action": "todo_add", "title": "x", "estimate_minutes": 30},
                                    session_id="s2", turn_id="s2:x:1")
        self.assertIsNone(other)
        self.assertIsNone(guard.pre_tool_call(tool_name="web_search", args={"query": "x"}))
        self.assertIsNone(guard.pre_tool_call(tool_name=PLANNER, args={"action": "todo_add", "title": "x", "estimate_minutes": 30}))

    def test_a_new_turn_id_is_a_new_turn_even_without_pre_llm_call(self):
        self.turn()
        self.call(SCHOOL, action="updates")
        self.turn_id = "s1:task:new"
        self.assertIsNone(self.call(PLANNER, action="todo_add", title="x", estimate_minutes=30))

    def test_another_turn_in_the_same_session_does_not_clear_the_taint(self):
        owner_turn = self.turn("메일 확인해줘")
        self.call(SCHOOL, action="updates")
        # a background review or cron prompt in the same session, interleaved
        self.assertIsNone(guard.pre_tool_call(tool_name=PLANNER, args={"action": "day"}, session_id=self.session,
                                              turn_id="s1:review:1"))
        guard.pre_llm_call(session_id=self.session, turn_id="s1:cron:1", user_message="cron prompt")
        self.turn_id = owner_turn
        self.assertIsNotNone(self.call(PLANNER, action="todo_add", title="x", estimate_minutes=30))
        self.assertEqual(guard.TURNS.owner_message(self.session, owner_turn), "메일 확인해줘")

    def test_ledger_is_bounded(self):
        ledger = turn_state.TurnLedger(max_sessions=3)
        for i in range(10):
            ledger.taint(f"s{i}", "t", "web_search")
        self.assertEqual(len(ledger._turns), 3)
        self.assertEqual(ledger.tainted_by("s9", "t"), ["web_search"])


class SettingsTest(TurnTest):
    def test_settings_always_need_the_owners_ok_in_a_later_turn(self):
        args = {"action": "settings_update", "settings": {"remindScope": "planner"}}
        self.turn("알림 줄여줘")
        blocked = self.call(PLANNER, **args)
        self.assertIn("settings change only with the owner's OK", blocked["message"])
        self.assertIn("same turn", self.call(PLANNER, **args, confirmed_by_user=True)["message"])
        self.turn("응 그렇게 바꿔")
        self.assertIsNone(self.call(PLANNER, **args, confirmed_by_user=True))
        # a different value than the one shown is not accepted
        self.turn()
        self.call(PLANNER, **args)
        self.turn("응")
        self.assertIsNotNone(self.call(PLANNER, action="settings_update", settings={"remindScope": "all"}, confirmed_by_user=True))


class GateTest(unittest.TestCase):
    def test_order_of_orderless_lists_does_not_matter(self):
        gate = guard.ConfirmationGate(clock=lambda: 1000.0)
        cases = [
            ({"action": "confirm", "dates": ["2026-11-27", "2026-11-28"]}, {"dates": ["2026-11-28", "2026-11-27"]}),
            ({"action": "proposal_apply", "proposal": "A", "item_numbers": [3, 1, 2]}, {"item_numbers": [1, 2, 3]}),
            ({"action": "proposal_edit", "proposal": "A", "remove_items": [2, 1]}, {"remove_items": [1, 2]}),
            ({"action": "event_add", "title": "헬스", "repeat_days": ["WE", "MO"]}, {"repeat_days": ["MO", "WE"]}),
            ({"action": "reference_sync", "calendars": ["b", "a"]}, {"calendars": ["a", "b"]}),
        ]
        for i, (shown, reordered) in enumerate(cases):
            self.assertIsNone(gate.check(PLANNER, shown, "s", f"t{i}a"))
            self.assertIsNone(gate.check(PLANNER, {**shown, **reordered, "confirmed_by_user": True}, "s", f"t{i}b"), shown)
        # lists where order matters are still compared as they are
        self.assertIsNone(gate.check(PLANNER, {"action": "proposal_create", "items": [{"n": 1}, {"n": 2}]}, "s", "x1"))
        self.assertIsNotNone(gate.check(PLANNER, {"action": "proposal_create", "items": [{"n": 2}, {"n": 1}],
                                                  "confirmed_by_user": True}, "s", "x2"))
        # different dates are a different change
        self.assertIsNone(gate.check(PLANNER, {"action": "confirm", "dates": ["2026-11-27"]}, "s", "y1"))
        self.assertIsNotNone(gate.check(PLANNER, {"action": "confirm", "dates": ["2026-11-28"], "confirmed_by_user": True}, "s", "y2"))

    def test_previews_survive_a_restart_and_keep_no_arguments(self):
        clock = Clock()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "personal-ai" / "confirmation-previews.json"
            args = {"action": "event_remove", "event_id": "secret-looking-title-치과"}
            first = guard.ConfirmationGate(clock=clock, path=path)
            self.assertIsNone(first.check(PLANNER, args, "s1", "t1"))
            stored = path.read_text(encoding="utf-8")
            self.assertNotIn("치과", stored)
            self.assertNotIn("event_remove", stored)
            self.assertEqual(json.loads(stored)["version"], 1)
            restarted = guard.ConfirmationGate(clock=clock, path=path)
            self.assertIsNone(restarted.check(PLANNER, {**args, "confirmed_by_user": True}, "s1", "t2"))
            again = guard.ConfirmationGate(clock=clock, path=path)
            self.assertIsNotNone(again.check(PLANNER, {**args, "confirmed_by_user": True}, "s1", "t3"), "used once, also on disk")
            # expired previews are dropped when loaded
            first.check(PLANNER, args, "s1", "t4")
            clock.now += 7 * 3600
            late = guard.ConfirmationGate(clock=clock, path=path)
            self.assertIsNotNone(late.check(PLANNER, {**args, "confirmed_by_user": True}, "s1", "t5"))
            self.assertEqual(late.previews, {})

    def test_a_broken_state_file_starts_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "previews.json"
            path.write_text("{not json", encoding="utf-8")
            gate = guard.ConfirmationGate(clock=lambda: 1000.0, path=path)
            with self.assertLogs("personal_ai.guard", "WARNING"):
                self.assertIsNotNone(gate.check(PLANNER, {"action": "event_remove", "event_id": "e", "confirmed_by_user": True}, "s", "t"))
            path.write_text(json.dumps({"version": 1, "previews": [["s", "k", "t", "bad"], "x", ["s", 1, "t", 5]]}), encoding="utf-8")
            self.assertEqual(guard.ConfirmationGate(clock=lambda: 1000.0, path=path).check(PLANNER, {"action": "day"}, "s", "t"), None)

    def test_state_path_is_hermes_home_never_the_plugin_mount(self):
        import os
        saved = {k: os.environ.pop(k, None) for k in ("PERSONAL_AI_GUARD_STATE_FILE", "HERMES_HOME")}
        try:
            self.assertIsNone(guard._state_path())
            os.environ["HERMES_HOME"] = "/opt/data"
            self.assertEqual(guard._state_path().as_posix(), "/opt/data/personal-ai/confirmation-previews.json")
            self.assertIsNone(guard._PROTECTED_WRITE.search(guard._state_path().as_posix()))
        finally:
            for key, value in saved.items():
                os.environ.pop(key, None)
                if value is not None:
                    os.environ[key] = value

    def test_confirmation_needs_a_non_empty_owner_message_and_logs_a_snippet(self):
        gate = guard.ConfirmationGate(clock=lambda: 1000.0)
        args = {"action": "event_remove", "event_id": "e1"}
        ok = {**args, "confirmed_by_user": True}
        gate.check(PLANNER, args, "s", "t1")
        self.assertIn("empty", gate.check(PLANNER, ok, "s", "t2", owner_message="   "))
        long_message = "응 그거 지워줘. 그리고 내일 아침 일정도 다시 확인해 줄래? 고마워 정말로"
        with self.assertLogs("personal_ai.guard", "INFO") as logs:
            self.assertIsNone(gate.check(PLANNER, ok, "s", "t3", owner_message=long_message))
        line = next(line for line in logs.output if "confirmation accepted" in line)
        quoted = json.loads(line.split("owner=", 1)[1])
        self.assertLessEqual(len(quoted), 40)
        self.assertTrue(long_message.startswith(quoted.rstrip("…")))
        # Hermes did not pass the message (no pre_llm_call seen): accepted as before, and the log says so
        gate.check(PLANNER, args, "s", "t4")
        with self.assertLogs("personal_ai.guard", "INFO") as logs:
            self.assertIsNone(gate.check(PLANNER, ok, "s", "t5"))
        self.assertIn("(message not seen)", logs.output[-1])

    def test_owner_message_text(self):
        self.assertEqual(turn_state.message_text("[Wed 2026-11-26 01:53:17 EST] 응 넣어줘"), "응 넣어줘")
        self.assertEqual(turn_state.message_text([{"type": "text", "text": "응"}, {"type": "image_url"}]), "응")
        self.assertEqual(turn_state.message_text(None), "")
        self.assertEqual(turn_state.snippet("a\n b"), "a b")


class RegistrationTest(unittest.TestCase):
    def test_hooks_are_registered(self):
        hooks = {}

        class Ctx:
            def register_tool(self, **kwargs):
                pass

            def register_command(self, *args, **kwargs):
                pass

            def register_hook(self, name, fn):
                hooks[name] = fn

        plugin.register(Ctx())
        self.assertIs(hooks["pre_tool_call"], guard.pre_tool_call)
        self.assertIs(hooks["pre_llm_call"], guard.pre_llm_call)
        self.assertIs(hooks["post_tool_call"], guard.post_tool_call)
        self.assertIs(hooks["transform_llm_output"], plugin.change_summary.transform_llm_output)
        manifest = (PLUGIN_DIR / "plugin.yaml").read_text(encoding="utf-8")
        for name in hooks:
            self.assertIn(f"  - {name}", manifest)

    def test_hooks_never_raise(self):
        class Weird:
            def __repr__(self):
                raise RuntimeError("boom")
        self.assertIsNone(guard.pre_llm_call(session_id="s", turn_id="t", user_message=Weird()))
        self.assertIsNone(guard.post_tool_call(tool_name=PLANNER, args={"x": Weird()}, result=Weird(), session_id="s", turn_id="t"))
        self.assertIsNone(guard.post_tool_call())
        self.assertIsNone(guard.pre_llm_call())


if __name__ == "__main__":
    unittest.main()
