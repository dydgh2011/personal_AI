"""Tests for the code-made change footer (change_summary.py, 2026-11-26).

    python -m unittest discover -s services/hermes-integration/tests -v
"""

from __future__ import annotations

import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1] / "plugins" / "personal-ai-controller"
_spec = importlib.util.spec_from_file_location("personal_ai_controller_summary_test", PLUGIN_DIR / "__init__.py",
                                               submodule_search_locations=[str(PLUGIN_DIR)])
plugin = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = plugin
_spec.loader.exec_module(plugin)
guard = plugin.guard
turn_state = plugin.turn_state
cs = plugin.change_summary

PLANNER = "personal_ai_planner"


class SummaryTest(unittest.TestCase):
    def setUp(self):
        self._saved = (guard.TURNS, guard.GATE, turn_state.LEDGER)
        guard.TURNS = turn_state.LEDGER = turn_state.TurnLedger()
        guard.GATE = guard.ConfirmationGate(clock=lambda: 1000.0)
        self.n = 0

    def tearDown(self):
        guard.TURNS, guard.GATE, turn_state.LEDGER = self._saved
        sys.modules.pop("hermes_cli", None)
        sys.modules.pop("hermes_cli.plugins", None)

    def turn(self, message="응"):
        self.n += 1
        self.turn_id = f"s1:task:{self.n}"
        guard.pre_llm_call(session_id="s1", turn_id=self.turn_id, user_message=message)

    def call(self, tool, result, **args):
        blocked = guard.pre_tool_call(tool_name=tool, args=args, session_id="s1", turn_id=self.turn_id)
        if blocked is None:
            guard.post_tool_call(tool_name=tool, args=args, result=json.dumps(result), session_id="s1",
                                 turn_id=self.turn_id)
        return blocked

    def answer(self, text):
        return cs.transform_llm_output(response_text=text, session_id="s1", turn_id=self.turn_id, model="kelly",
                                       platform="discord")

    def test_lists_the_changes_that_succeeded(self):
        self.turn("내일 치과 3시 넣어줘")
        self.call(PLANNER, {"ok": True, "display": "..."}, action="day", date="2026-11-27")
        self.call(PLANNER, {"ok": True}, action="event_add", title="치과", date="2026-11-27", start="15:00", end="16:00",
                  category="personal")
        self.call("personal_ai_knowledge", {"ok": True}, action="fact_add", page="preferences", text="아침엔 공부 안 함")
        self.call(PLANNER, {"ok": False, "error": {"code": "server_error"}}, action="todo_add", title="실패", estimate_minutes=30)
        out = self.answer("내일 15:00 치과 일정을 넣었어요.")
        self.assertTrue(out.startswith("내일 15:00 치과 일정을 넣었어요.\n\n🧾"))
        self.assertIn("- 일정 event_add: 치과 2026-11-27 15:00 16:00", out)
        self.assertIn("- 저장소 fact_add: preferences 아침엔 공부 안 함", out)
        self.assertNotIn("실패", out)
        self.assertNotIn(" day", out)

    def test_warns_when_the_answer_claims_a_change_that_did_not_happen(self):
        self.turn("앞으로 시험날은 비워줘")
        out = self.answer("반영했어. 앞으로 시험/퀴즈 날짜에는 다른 일정을 넣지 않을게.")
        self.assertTrue(out.endswith(cs.NOTHING))
        # a change that only asked for the OK, or was blocked, is named as not applied
        self.turn()
        self.call(PLANNER, {"ok": False, "error": {"code": "needs_confirmation", "message": "..."}},
                  action="event_remove", event_id="e1")
        self.call(PLANNER, {"ok": True}, action="event_remove", event_id="e2", confirmed_by_user=True)  # gate: not shown
        out = self.answer("일정을 삭제했어요.")
        self.assertIn(cs.NOTHING, out)
        self.assertIn("변경 시도 2건은 확인 대기 또는 실패", out)

    def test_nothing_is_added_without_changes_or_claims(self):
        self.turn()
        self.call(PLANNER, {"ok": True}, action="week")
        for text in ["이번 주 일정은 이래요.", "아직 추가하지 않았어요. 넣을까요?", "그 일정은 안 넣었어요.",
                     "지난번에 추가했던 일정은 그대로예요.", "I have not added it yet.", "Should I add it?", ""]:
            self.assertIsNone(self.answer(text), text)

    def test_builtin_memory_write_is_named_as_not_the_knowledge_store(self):
        # 2026-11-26 live: "기억해 뒀어" after a Hermes memory add (USER.md), no knowledge fact
        self.turn("나는 영어로 배워서 한국어 문서 이름은 잘 못 알아봐. 기억해 둬.")
        self.call("memory", {"success": True, "message": "Entry added."}, action="add", target="user",
                  content="User prefers to study from English materials")
        out = self.answer("기억해 뒀어: 영어 자료 위주로 공부.")
        self.assertIn("🧾", out)
        self.assertIn("- Hermes 내부 메모(지식 저장소 아님) add: User prefers to study from English materials", out)
        # without any write, the same claim gets the warning
        self.turn()
        self.assertTrue(self.answer("기억해 뒀어.").endswith(cs.NOTHING))
        self.assertTrue(cs.claims_change("I remembered that."))
        self.assertFalse(cs.claims_change("기억할게요?"))

    def test_claim_patterns(self):
        for text in ["반영했어", "추가했어요", "넣었어", "바꿨어요", "삭제했어", "저장했어요", "등록했습니다", "옮겼어",
                     "넣어 뒀어", "잡아놨어", "추가 완료!", "반영됐어요", "I added it to your calendar", "Updated.",
                     "I've saved that preference"]:
            self.assertTrue(cs.claims_change(text), text)
        for text in ["추가할까요?", "넣을게요", "안 넣었어", "못 바꿨어요", "추가했던 일", "I didn't add it", "not updated"]:
            self.assertFalse(cs.claims_change(text), text)

    def test_never_shows_a_login_code_and_caps_the_list(self):
        self.turn()
        self.call("personal_ai_worker_login", {"ok": True}, action="code", agent="claude", code="SECRET-CODE-123")
        for i in range(12):
            self.call(PLANNER, {"ok": True}, action="todo_add", title=f"할 일 {i}", estimate_minutes=30)
        out = self.answer("넣었어요")
        self.assertNotIn("SECRET-CODE-123", out)
        self.assertIn("- 로그인 code: claude", out)
        self.assertIn("외 5건", out)

    def test_other_turns_and_sessions_are_not_mixed(self):
        self.turn()
        self.call(PLANNER, {"ok": True}, action="todo_add", title="A", estimate_minutes=30)
        self.turn()
        self.assertIsNone(self.answer("이번 주는 이래요"))
        self.assertIn(cs.NOTHING, self.answer("넣었어"), "the change of the previous turn is not this turn's")
        self.assertIn(cs.NOTHING, cs.transform_llm_output(response_text="넣었어", session_id="s2", turn_id="s2:x"))

    def test_composes_with_the_knowledge_footer(self):
        calls = []

        def knowledge_check(response_text="", session_id="", **_):
            calls.append(response_text)
            return response_text + "\n\n📌 저장소 기록 (답에서 빠진 내용을 코드가 붙임)\n- STA256 기말 12/10"

        def narrow(response_text):  # a callback that declares only some fields
            return None

        class Manager:
            def __init__(self, hooks):
                self._hooks = {"transform_llm_output": hooks}

            @classmethod
            def _invoke_hook_callback(cls, callback, payload):
                import inspect
                params = inspect.signature(callback).parameters
                if any(p.kind == p.VAR_KEYWORD for p in params.values()):
                    return callback(**payload)
                return callback(**{k: v for k, v in payload.items() if k in params})

        manager = Manager([cs.transform_llm_output, narrow, knowledge_check])
        hermes_cli = types.ModuleType("hermes_cli")
        hermes_plugins = types.ModuleType("hermes_cli.plugins")
        hermes_plugins.get_plugin_manager = lambda: manager
        hermes_cli.plugins = hermes_plugins
        sys.modules["hermes_cli"], sys.modules["hermes_cli.plugins"] = hermes_cli, hermes_plugins

        self.turn()
        self.call(PLANNER, {"ok": True}, action="todo_add", title="STA256 공부", estimate_minutes=90)
        out = self.answer("할 일을 추가했어요.")
        self.assertEqual(calls, ["할 일을 추가했어요."], "the knowledge check sees the model's answer")
        self.assertLess(out.index("📌 저장소 기록"), out.index("🧾"), "both notes, the change list last")
        # no footer: leave the answer to the other hooks (Hermes then takes the knowledge note itself)
        self.turn()
        self.assertIsNone(self.answer("이번 주는 이래요"))
        # if another transform hook runs first, say so in the log (its note would hide this footer)
        manager._hooks["transform_llm_output"] = [knowledge_check, cs.transform_llm_output]
        cs._warned_not_first = False
        self.turn()
        self.call(PLANNER, {"ok": True}, action="todo_add", title="x", estimate_minutes=30)
        with self.assertLogs("personal_ai.changes", "WARNING"):
            self.assertIn("🧾", self.answer("추가했어요"))

    def test_a_failing_chained_hook_does_not_cost_the_footer(self):
        def broken(**_):
            raise RuntimeError("boom")

        class Manager:
            _hooks = {"transform_llm_output": [cs.transform_llm_output, broken]}

        hermes_cli = types.ModuleType("hermes_cli")
        hermes_plugins = types.ModuleType("hermes_cli.plugins")
        hermes_plugins.get_plugin_manager = lambda: Manager()
        hermes_cli.plugins = hermes_plugins
        sys.modules["hermes_cli"], sys.modules["hermes_cli.plugins"] = hermes_cli, hermes_plugins
        self.turn()
        self.call(PLANNER, {"ok": True}, action="todo_add", title="x", estimate_minutes=30)
        self.assertTrue(self.answer("추가했어요").startswith("추가했어요\n\n🧾"))

    def test_never_raises(self):
        self.assertIsNone(cs.transform_llm_output())
        self.assertIsNone(cs.transform_llm_output(response_text=None))
        self.assertIsNone(cs.transform_llm_output(response_text="x", session_id=object()))


if __name__ == "__main__":
    unittest.main()
