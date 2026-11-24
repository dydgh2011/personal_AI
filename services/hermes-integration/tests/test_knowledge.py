"""Tests for the personal-ai-knowledge memory provider and its tool (no Hermes needed)."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1] / "plugins" / "personal-ai-knowledge"
_spec = importlib.util.spec_from_file_location("personal_ai_knowledge_plugin", PLUGIN_DIR / "__init__.py",
                                               submodule_search_locations=[str(PLUGIN_DIR)])
plugin = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = plugin
_spec.loader.exec_module(plugin)
kc = plugin.kc

UUID = "0f8fad5b-d9cb-469f-a165-70867728950e"


class FakeClient:
    """Records calls; answers from a table of (method, path) -> response or KnowledgeError."""

    def __init__(self, answers=None):
        self.calls = []
        self.answers = answers or {}

    def call(self, method, path, query=None, body=None, timeout=30.0):
        self.calls.append((method, path, query, body))
        answer = self.answers.get((method, path), {})
        if callable(answer):
            answer = answer(query)
        if isinstance(answer, Exception):
            raise answer
        return answer


class RedactTest(unittest.TestCase):
    def test_credentials_are_replaced(self):
        text = ("hook https://discord.com/api/webhooks/123456789/AbC-def_ghi and key sk-ant-api03-abcdefghijklmnopqrstuvwx "
                "AIzaSyA1234567890abcdefghijklmnopqrstuv ghp_abcdefghijklmnopqrstuvwxyz0123456789 "
                "Bearer abcdefghijklmnopqrstuvwxyz123 비밀번호: hunter2 password=letmein")
        out = kc.redact(text)
        for secret in ("AbC-def_ghi", "abcdefghijklmnopqrstuvwx", "AIzaSyA", "ghp_", "Bearer abcdefghijklmnop", "hunter2", "letmein"):
            self.assertNotIn(secret, out)
        self.assertIn("[redacted:discord-webhook]", out)
        self.assertIn("비밀번호: [redacted:password]", out)
        self.assertEqual(kc.redact("CSC263 과제 금요일까지"), "CSC263 과제 금요일까지")


class ToolTest(unittest.TestCase):
    def run_tool(self, client, **args):
        return kc.run_tool(args, client=client)

    def test_validation_happens_before_any_call(self):
        client = FakeClient()
        cases = [
            ({"action": "drop_table"}, "usage_error"),
            ({"action": "search"}, "usage_error"),
            ({"action": "fact_add", "page": "헬스"}, "usage_error"),
            ({"action": "fact_change", "fact_id": "../x", "text": "y"}, "usage_error"),
            ({"action": "activity_change", "activity_id": "1"}, "usage_error"),
            ({"action": "timeline", "date_from": "11/20"}, "usage_error"),
            ({"action": "raw", "raw_id": "../../k.db"}, "usage_error"),
            ({"action": "page_save", "summary": "x"}, "usage_error"),
        ]
        for args, code in cases:
            self.assertEqual(self.run_tool(client, **args)["error"]["code"], code, args)
        self.assertEqual(client.calls, [])

    def test_actions_map_to_fixed_routes_with_camel_case_fields(self):
        client = FakeClient({("GET", "/search"): {"results": [
            {"kind": "fact", "id": UUID, "title": "헬스", "snippet": "헬스: 월수금", "page": {"slug": "헬스", "title": "헬스", "type": "habit"},
             "date": "2026-11-22", "match": "both"}]}})
        found = self.run_tool(client, action="search", q="헬스 언제", kinds=["fact", "bogus"], limit=5)
        self.assertEqual(found["results"], [{"kind": "fact", "title": "헬스", "snippet": "헬스: 월수금", "page": "헬스", "date": "2026-11-22", "id": UUID}])
        self.assertEqual(client.calls[-1][2], {"q": "헬스 언제", "limit": 5, "kinds": "fact"})
        self.assertIsNone(found["note"])
        raw_client = FakeClient({("GET", "/search"): {"results": [
            {"kind": "raw", "id": UUID, "title": "[STA 256] @136 Final Exam Formula Sheet?", "snippet": "will we be given a formula sheet"}]}})
        raw_found = self.run_tool(raw_client, action="search", q="formula sheet")
        self.assertIn("action raw", raw_found["note"])
        self.run_tool(client, action="fact_add", page="헬스", text="화목 저녁으로 바꿈", observed_on="2026-11-22", source_raw_id=UUID)
        self.assertEqual(client.calls[-1][:2], ("POST", "/facts"))
        self.assertEqual(client.calls[-1][3], {"page": "헬스", "text": "화목 저녁으로 바꿈", "sourceRawId": UUID, "observedOn": "2026-11-22"})
        self.run_tool(client, action="fact_change", fact_id=UUID, remove=True, reason="그만둠")
        self.assertEqual(client.calls[-1][1:], (f"/facts/{UUID}", None, {"remove": True, "reason": "그만둠"}))
        self.run_tool(client, action="link", from_page="CSC263", to_page="인턴 준비", relation="goal_of")
        self.assertEqual(client.calls[-1][3], {"from": "CSC263", "to": "인턴 준비", "relation": "goal_of"})
        self.run_tool(client, action="activity_add", title="힙 문제", kind="study", minutes=90, pages=["CSC263"], at="2026-11-21T19:00")
        self.assertEqual(client.calls[-1][3], {"at": "2026-11-21T19:00", "minutes": 90, "kind": "study", "title": "힙 문제", "pages": ["CSC263"]})
        self.run_tool(client, action="activity_change", activity_id=UUID, remove=True, title="ignored")
        self.assertEqual(client.calls[-1][3], {"remove": True})
        self.run_tool(client, action="timeline", date_from="2026-11-01", page="CSC263")
        self.assertEqual(client.calls[-1][2]["from"], "2026-11-01")
        note = self.run_tool(client, action="note", text="와이파이 password: abc123 기억해", title="메모")
        self.assertTrue(note["ok"])
        self.assertEqual(client.calls[-1][3]["text"], "와이파이 password: [redacted:password] 기억해")
        self.run_tool(client, action="raw", raw_id=UUID, offset=6000)
        self.assertEqual(client.calls[-1][1:3], (f"/raw/{UUID}", {"offset": 6000, "limit": 6000}))

    def test_purge_needs_the_owners_confirmation(self):
        client = FakeClient()
        unconfirmed = self.run_tool(client, action="purge", target="fact", fact_id=UUID, reason="잘못 저장됨")
        self.assertEqual(unconfirmed["error"]["code"], "needs_confirmation")
        self.assertEqual(self.run_tool(client, action="purge", target="fact", fact_id=UUID, confirmed_by_user=True)["error"]["code"], "usage_error")
        self.assertEqual(self.run_tool(client, action="purge", target="disk", reason="x", confirmed_by_user=True)["error"]["code"], "usage_error")
        self.assertEqual(client.calls, [])
        self.run_tool(client, action="purge", target="fact", fact_id=UUID, reason="잘못 저장됨", confirmed_by_user=True)
        self.assertEqual(client.calls[-1][1:], ("/purge", None, {"target": "fact", "reason": "잘못 저장됨", "id": UUID}))
        self.run_tool(client, action="purge", target="page", page="옛 프로젝트", reason="필요 없음", confirmed_by_user=True)
        self.assertEqual(client.calls[-1][3], {"target": "page", "reason": "필요 없음", "page": "옛 프로젝트"})

    def test_page_adds_facts_from_linked_pages_that_mention_it(self):
        pages = {
            "MAT223": {"page": {"slug": "mat223", "title": "MAT223", "type": "course", "aliases": ["MAT223H5", "선형대수"]},
                       "facts": [{"id": UUID, "text": "Test 1 47/50", "observedOn": "2026-10-15"}],
                       "links": [{"relation": "covers", "to": {"slug": "tf", "title": "정당화 T/F 문제", "type": "topic"}},
                                 {"relation": "covers", "to": {"slug": "eig", "title": "고유값과 대각화", "type": "topic"}},
                                 {"relation": "covers", "to": {"slug": "gone", "title": "없음", "type": "topic"}}],
                       "linkedFrom": [{"relation": "part_of", "from": {"slug": "me", "title": "나", "type": "me"}}]},
            "tf": {"page": {"slug": "tf"}, "facts": [
                {"id": "a", "text": "MAT 223 Quiz 1 T/F 0/1, Test 1 5(c) 0점", "observedOn": "2026-11-23"},
                {"id": "b", "text": "STA256 T/F도 있음", "observedOn": "2026-11-23"}]},
            "eig": {"page": {"slug": "eig"}, "facts": [{"id": "c", "text": "선형대수 3.3절", "observedOn": "2026-09-02"}]},
            "gone": kc.KnowledgeError("not_found", "No page", 404),
        }
        client = FakeClient({("GET", "/page"): lambda q: pages[q["ref"]]})
        result = self.run_tool(client, action="page", page="MAT223")
        self.assertTrue(result["ok"])
        self.assertEqual(result["linkedFacts"], [
            {"page": "정당화 T/F 문제", "type": "topic",
             "facts": [{"id": "a", "text": "MAT 223 Quiz 1 T/F 0/1, Test 1 5(c) 0점", "observedOn": "2026-11-23"}]},
            {"page": "고유값과 대각화", "type": "topic",
             "facts": [{"id": "c", "text": "선형대수 3.3절", "observedOn": "2026-09-02"}]},
        ])
        self.assertIn("linkedFacts holds", result["note"])
        self.assertIn("never name fields", result["note"])      # course pages get the answering note
        self.assertEqual(result["recordedMistakes"], [
            {"page": "정당화 T/F 문제", "text": "MAT 223 Quiz 1 T/F 0/1, Test 1 5(c) 0점"}])  # "47/50", "3.3절" are not mistakes
        self.assertEqual([c[2]["ref"] for c in client.calls], ["MAT223", "tf", "eig", "gone"])   # never the owner page
        plain = self.run_tool(FakeClient({("GET", "/page"): {"page": {"slug": "x", "title": "헬스"}, "facts": []}}),
                              action="page", page="헬스")
        self.assertNotIn("linkedFacts", plain)
        self.assertNotIn("note", plain)

    def test_errors_come_back_as_results(self):
        client = FakeClient({("GET", "/page"): kc.KnowledgeError("not_found", 'No page "CSC26"', 404, {"similar": ["CSC263"]})})
        result = self.run_tool(client, action="page", page="CSC26")
        self.assertEqual(result["error"], {"code": "not_found", "message": 'No page "CSC26"', "httpStatus": 404, "similar": ["CSC263"]})


class ProviderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.env = {"PERSONAL_AI_BROKER_URL": "http://broker", "PERSONAL_AI_DOCUMENTS_DIR": self.tmp.name}
        self.client = FakeClient({
            ("GET", "/profile"): {"text": "UTM 학생, 아침형", "pages": "course: CSC263", "pageCount": 1},
            ("GET", "/recall"): {"text": "- 헬스: 월수금 아침", "count": 1},
        })
        self.provider = plugin.KnowledgeProvider(env=self.env, client=self.client)
        self.provider.initialize("s1", platform="discord", agent_context="primary")
        self._spawn = plugin.spawn_context_thread
        plugin.spawn_context_thread = lambda target, *, name, daemon=True, args=(), kwargs=None: _Sync(target, args)

    def tearDown(self):
        plugin.spawn_context_thread = self._spawn
        self.tmp.cleanup()

    def test_system_prompt_has_rules_and_profile(self):
        block = self.provider.system_prompt_block()
        self.assertIn("personal_ai_knowledge", block)
        self.assertIn("UTM 학생", block)
        self.assertIn("course: CSC263", block)
        self.assertEqual(self.provider.name, "personal-ai-knowledge")
        self.assertTrue(self.provider.is_available())

    def test_prefetch_recalls_only_for_real_messages(self):
        self.assertEqual(self.provider.prefetch(""), "")
        text = self.provider.prefetch("내 헬스 루틴 알려줘")
        self.assertTrue(text.startswith("## Known about the owner"))
        self.assertIn("월수금", text)
        self.assertEqual(self.provider.recall_status().count, 1)
        self.client.answers[("GET", "/recall")] = kc.KnowledgeError("unavailable", "down")
        self.assertEqual(self.provider.prefetch("내 헬스 루틴"), "")
        self.assertIsNone(self.provider.recall_status())

    def test_sync_turn_keeps_turns_and_attachments_redacted(self):
        (Path(self.tmp.name) / "doc_0123456789ab_notes.txt").write_text("Quiz 1 on Oct 3\nkey sk-ant-api03-abcdefghijklmnopqrstuvwx", encoding="utf-8")
        user = ("[The user sent a document: 'notes.txt'. It is saved at: /opt/data/cache/documents/doc_0123456789ab_notes.txt. "
                "Its text is not inlined here.]\n\n이거 정리해줘. 웹훅은 https://discord.com/api/webhooks/1/abcDEF")
        self.provider.sync_turn(user, "정리했어요", session_id="s1", turn_author={"name": "owner"})
        raw = [c for c in self.client.calls if c[:2] == ("POST", "/raw")]
        doc = [c for c in self.client.calls if c[:2] == ("POST", "/raw/document")]
        self.assertEqual(len(raw), 1)
        body = raw[0][3]
        self.assertEqual(body["source"], "chat")
        self.assertEqual(body["kind"], "discord-turn")
        self.assertTrue(body["externalId"].startswith("turn:"))
        self.assertNotIn("abcDEF", body["text"])
        self.assertIn("kelly: 정리했어요", body["text"])
        self.assertEqual(body["meta"]["author"], "owner")
        self.assertEqual(len(doc), 1)
        self.assertEqual(doc[0][3]["file"], "doc_0123456789ab_notes.txt")
        self.assertIn("Quiz 1 on Oct 3", doc[0][3]["text"])
        self.assertNotIn("abcdefghijklmnopqrstuvwx", doc[0][3]["text"])
        # The same turn again gets the same external id (the store de-duplicates it).
        self.provider.sync_turn(user, "정리했어요", session_id="s1")
        ids = [c[3]["externalId"] for c in self.client.calls if c[:2] == ("POST", "/raw")]
        self.assertEqual(ids[0], ids[1])

    def test_subagents_and_cron_do_not_store(self):
        sub = plugin.KnowledgeProvider(env=self.env, client=self.client)
        sub.initialize("s2", platform="cron", agent_context="cron")
        before = len(self.client.calls)
        sub.sync_turn("hello there", "hi")
        self.assertEqual(len(self.client.calls), before)

    def test_tool_dispatch(self):
        self.assertEqual([s["name"] for s in self.provider.get_tool_schemas()], ["personal_ai_knowledge"])
        bad = json.loads(self.provider.handle_tool_call("other_tool", {}))
        self.assertEqual(bad["error"]["code"], "usage_error")
        ok = json.loads(self.provider.handle_tool_call("personal_ai_knowledge", {"action": "profile"}))
        self.assertTrue(ok["ok"])

    def test_register_uses_the_memory_provider_hook(self):
        seen = []

        class Ctx:
            def register_memory_provider(self, provider):
                seen.append(provider)

        plugin.register(Ctx())
        self.assertIsInstance(seen[0], plugin.KnowledgeProvider)

        hooks = []

        class HookCtx(Ctx):
            def register_hook(self, name, callback):
                hooks.append((name, callback))

        plugin.register(HookCtx())
        self.assertEqual([h[0] for h in hooks], ["transform_llm_output"])


class CourseBriefTest(unittest.TestCase):
    """Code attaches the course record and appends asked-about facts the answer left out."""

    def setUp(self):
        cb = plugin.cb
        cb._index.update(at=0.0, pages=[])
        cb._pending.clear()
        pages = {
            "mat223": {"page": {"slug": "mat223", "title": "MAT223", "type": "course", "aliases": ["선형대수"],
                                "summary": "기말 2026-12-19(토) 09:00–12:00"},
                       "facts": [{"id": "1", "text": "Test 1: 47/50 (94%). Q2 9.5(2d A^{-1}b 셋째 성분 계산 실수 10→18)"},
                                 {"id": "2", "text": "배점: 시험 2개 각 20% · 기말 40%"}],
                       "links": [{"relation": "covers", "to": {"slug": "tf", "title": "정당화 T/F 문제", "type": "topic"}}]},
            "tf": {"page": {"slug": "tf", "title": "정당화 T/F 문제", "type": "topic"},
                   "facts": [{"id": "3", "text": "MAT223 Quiz 1 T/F 0/1, Test 1 5번 7.5/10 (c) 근거가 틀려 0점"}]},
        }
        self.client = FakeClient({
            ("GET", "/pages"): {"pages": [{"slug": "mat223", "title": "MAT223", "type": "course"},
                                          {"slug": "tf", "title": "정당화 T/F 문제", "type": "topic"},
                                          {"slug": "x", "title": "헬스", "type": "habit"}]},
            ("GET", "/page"): lambda q: pages[q["ref"]],
        })
        self.cb = cb

    def test_brief_attaches_the_named_course_with_linked_facts(self):
        text = self.cb.brief(self.client, "MAT 223 약한 주제 알려줘", "s1")
        self.assertIn("## Course record", text)
        self.assertIn("47/50 (94%)", text)
        self.assertIn("[정당화 T/F 문제] MAT223 Quiz 1 T/F 0/1", text)
        self.assertEqual(self.cb.brief(self.client, "선형대수 배점은?", "s2").count("### MAT223"), 1)   # alias
        self.assertEqual(self.cb.brief(self.client, "오늘 헬스 갔어", "s3"), "")                     # not a course/topic

    def test_check_appends_only_what_the_answer_left_out(self):
        self.cb.brief(self.client, "MAT223 약한 주제 알려줘", "s1")
        full = "Test 1 47/50(94%), Q2 9.5 계산 실수 10→18. Quiz 1 0/1, 5번 7.5/10."
        self.assertIsNone(self.cb.check(full, "s1"))
        self.cb.brief(self.client, "MAT223 약한 주제 알려줘", "s1")
        out = self.cb.check("정당화 T/F가 약해요.", "s1")
        self.assertTrue(out.startswith("정당화 T/F가 약해요.\n\n📌 저장소 기록"))
        self.assertIn("[MAT223] Test 1: 47/50 (94%)", out)
        self.assertIn("[정당화 T/F 문제] MAT223 Quiz 1", out)
        self.assertNotIn("배점", out)                          # grading was not asked
        self.assertIsNone(self.cb.check("다른 답", "s1"))       # pending is used once
        self.assertIsNone(self.cb.check("아무 답", "other"))    # no brief for this session

    def test_headline_count_and_total_score_are_never_optional(self):
        fact = "장별 Exercise 109개: 1장 10 · 2장 18 · 3장 17 · 4장 25"
        self.assertFalse(self.cb._covered(fact, "Mohammad notes: 1장 10, 2장 18, 3장 17, 4장 25"))
        self.assertTrue(self.cb._covered(fact, "Exercise 109개 (10, 18, 17)"))
        self.assertFalse(self.cb._covered("Test 1: 47/50 (94%), Q2 9.5, Q5 7.5", "Q2 9.5, Q5 7.5, 94%"))

    def test_provider_hook_never_breaks_a_reply(self):
        provider = plugin.KnowledgeProvider(env={"PERSONAL_AI_BROKER_URL": "http://broker"}, client=self.client)
        self.assertIsNone(provider.check_answer(response_text="hi", session_id="none"))


class ScheduleBriefTest(unittest.TestCase):
    """Code lists every dated item, so 'first/next' never comes from one course."""

    def setUp(self):
        from datetime import date, datetime
        sb = plugin.sb
        self.sb = sb
        sb._cache.clear()
        sb._pending.clear()
        self._now, self._planner_items = sb.now, sb._planner_items
        sb.now = lambda: datetime(2026, 11, 24, 1, 2, tzinfo=sb.TZ)
        sb._planner_items = lambda: [
            {"date": date(2026, 11, 26), "start": None, "end": None, "what": "할 일 마감 · FAS Technical Test", "source": "플래너"},
            {"date": date(2026, 11, 26), "start": None, "end": None, "what": "캘린더 · 마감: FAS Technical Test", "source": "플래너"},
            {"date": date(2026, 12, 16), "start": "09:00", "end": "12:00", "what": "캘린더 · CSC236H5 Final Exam", "source": "플래너"},
        ]
        pages = {
            "csc236": {"page": {"title": "CSC236", "summary": "계산 이론. 기말 12/16"},
                       "facts": [{"text": "기말: 2026-12-16(수) 09:00–12:00, RA Gym A/B"}]},
            "sta256": {"page": {"title": "STA256", "summary": "확률. 기말 12/10"},
                       "facts": [{"text": "기말: 2026-12-10(목) 17:00–20:00, RA Gym A/B"},
                                 {"text": "Term Test 2 (2026-11-14): 11.5/25"}]},
        }
        self.client = FakeClient({
            ("GET", "/pages"): {"pages": [{"slug": "csc236"}, {"slug": "sta256"}]},
            ("GET", "/page"): lambda q: pages[q["ref"]],
        })

    def tearDown(self):
        self.sb.now, self.sb._planner_items = self._now, self._planner_items

    def test_upcoming_lists_every_course_sorted_with_time_left(self):
        text = self.sb.brief(self.client, "제일 처음에 있는 기말고사 언제야? 얼마나 남았어?", "s1")
        lines = [l for l in text.splitlines() if l[:1].isdigit()]
        self.assertIn("2026-11-24(화) 01:02 토론토", text)
        self.assertTrue(lines[0].startswith("1. 2026-11-26(목) · 할 일 마감 · FAS Technical Test · 2일 남음"))
        self.assertEqual(len(lines), 3)                                    # calendar copies merged, past test dropped
        self.assertIn("2026-12-10(목) 17:00–20:00 · STA256", lines[1])
        self.assertIn("16일 15시간 남음", lines[1])
        self.assertIn("CSC236", lines[2])
        self.assertEqual(self.sb._pending["s1"]["first"]["what"][:6], "STA256")   # "기말" picks finals only

    def test_check_appends_the_first_item_when_the_answer_misses_its_date(self):
        self.sb.brief(self.client, "제일 처음에 있는 기말고사 알려줘", "s1")
        out = self.sb.check("가장 먼저는 CSC236, 2026-12-16이야.", "s1")
        self.assertIn("📌 일정 기록", out)
        self.assertIn("2026-12-10(목) 17:00–20:00 · STA256", out)
        self.sb.brief(self.client, "제일 처음에 있는 기말고사 알려줘", "s1")
        self.assertIsNone(self.sb.check("STA256, 12월 10일 17시야.", "s1"))

    def test_all_courses_for_comparisons_only_without_a_named_course(self):
        self.assertIn("- STA256: 확률", self.sb.brief(self.client, "어느 과목이 제일 약해?", "s2"))
        self.assertEqual(self.sb.brief(self.client, "CSC236 과목별 연습문제", "s3"), "")
        self.assertEqual(self.sb.brief(self.client, "오늘 기분 좋아", "s4"), "")

    def test_a_slow_or_failing_source_is_left_out_and_said(self):
        def boom():
            raise RuntimeError("planner down")
        self.sb._planner_items = boom
        text = self.sb.brief(self.client, "다음 시험 언제야", "s5")
        self.assertIn("읽지 못한 곳: 플래너", text)
        self.assertIn("STA256", text)


class FactKindTest(unittest.TestCase):
    """Code picks facts by kind; untyped facts (stored before kinds) keep the old word rules."""

    def run_tool(self, client, **args):
        return kc.run_tool(args, client=client)

    def test_tool_sends_and_validates_fact_kinds(self):
        self.assertEqual(kc.SCHEMA["parameters"]["properties"]["fact_kind"]["enum"], kc.FACT_KINDS)
        self.assertIn("score (test result)", kc.SCHEMA["description"])
        client = FakeClient()
        self.assertEqual(self.run_tool(client, action="fact_add", page="MAT223", text="x", fact_kind="grade")["error"]["code"], "usage_error")
        self.assertEqual(self.run_tool(client, action="fact_change", fact_id=UUID, fact_kind="study")["error"]["code"], "usage_error")
        self.assertEqual(client.calls, [])
        self.run_tool(client, action="fact_add", page="MAT223", text="Test 1: 47/50 (94%)", fact_kind="score")
        self.assertEqual(client.calls[-1][3], {"page": "MAT223", "text": "Test 1: 47/50 (94%)", "kind": "score"})
        self.run_tool(client, action="fact_add", page="MAT223", text="교재: Liu 노트")
        self.assertNotIn("kind", client.calls[-1][3])                       # no kind given: untyped, as before
        self.run_tool(client, action="fact_change", fact_id=UUID, fact_kind="mistake", reason="종류 바로잡기")
        self.assertEqual(client.calls[-1][1:], (f"/facts/{UUID}", None, {"kind": "mistake", "reason": "종류 바로잡기"}))
        self.run_tool(client, action="fact_change", fact_id=UUID, text="Test 1 5(c) 0/2.5", fact_kind="mistake")
        self.assertEqual(client.calls[-1][3], {"text": "Test 1 5(c) 0/2.5", "kind": "mistake"})
        self.assertEqual(self.run_tool(client, action="fact_change", fact_id=UUID)["error"]["code"], "usage_error")   # nothing to change

    def test_fact_is_prefers_the_kind_and_falls_back_for_untyped(self):
        self.assertTrue(kc.fact_is({"text": "아무 말", "kind": "mistake"}, ("mistake",), kc.MISTAKE))
        self.assertFalse(kc.fact_is({"text": "근거 없는 T/F는 0/2 처리", "kind": "grading"}, ("mistake",), kc.MISTAKE))
        self.assertTrue(kc.fact_is({"text": "근거 없는 T/F는 0/2 처리"}, ("mistake",), kc.MISTAKE))          # untyped: word rule
        self.assertTrue(kc.fact_is({"text": "x", "kind": None}, ("mistake",), lambda t: t == "x"))
        self.assertFalse(kc.fact_is({"text": "x"}, ("mistake",)))

    def test_recorded_mistakes_go_by_kind_first(self):
        page = {"page": {"slug": "sta256", "title": "STA256", "type": "course"}, "facts": [
            {"id": "1", "text": "Term Test 2: 11.5/25 (46%)", "kind": "score"},
            {"id": "2", "text": "Q3 조건부확률 분모를 P(A)로 씀", "kind": "mistake"},     # no mistake word: found by kind
            {"id": "3", "text": "늦게 내면 하루 10% 감점, 근거 없는 답은 0/2", "kind": "grading"},   # word false match: left out
            {"id": "4", "text": "Quiz 2 베이즈 계산 실수"},                                  # untyped: word rule as before
            {"id": "5", "text": "교재 5장 연습문제"},                                         # untyped, no mistake word
        ]}
        result = self.run_tool(FakeClient({("GET", "/page"): page}), action="page", page="STA256")
        self.assertEqual(result["recordedMistakes"], [
            {"page": "STA256", "text": "Q3 조건부확률 분모를 P(A)로 씀", "kind": "mistake"},
            {"page": "STA256", "text": "Quiz 2 베이즈 계산 실수"}])

    def test_linked_facts_carry_their_kind(self):
        pages = {"MAT223": {"page": {"slug": "mat223", "title": "MAT223", "type": "topic"},
                            "links": [{"relation": "covers", "to": {"slug": "tf", "title": "정당화 T/F 문제", "type": "topic"}}]},
                 "tf": {"page": {"slug": "tf"}, "facts": [{"id": "a", "text": "MAT223 Test 1 5(c) 0/2.5", "kind": "mistake"}]}}
        result = self.run_tool(FakeClient({("GET", "/page"): lambda q: pages[q["ref"]]}), action="page", page="MAT223")
        self.assertEqual(result["linkedFacts"][0]["facts"][0]["kind"], "mistake")

    def test_course_brief_requires_facts_by_kind_and_words_for_untyped(self):
        cb = plugin.cb
        facts = [
            ("STA256", {"text": "Q3 분모를 P(A)로 씀", "kind": "mistake"}),
            ("STA256", {"text": "Term Test 2: 11.5/25", "kind": "score"}),
            ("STA256", {"text": "기말: 2026-12-10(목), RA Gym", "kind": "exam"}),           # exam by kind, no time range
            ("STA256", {"text": "오피스아워 월 14:00–15:00", "kind": "other"}),               # time range but not an exam
            ("STA256", {"text": "늦으면 10% 감점, 근거 없으면 0/2", "kind": "grading"}),
            ("STA256", {"text": "장별 Exercise 109개", "kind": "resource"}),
            ("MAT223", {"text": "Test 1: 47/50 (94%)"}),                                     # untyped: TOTAL_SCORE
            ("MAT223", {"text": "기말 2026-12-19(토) 09:00–12:00"}),                         # untyped: time range
            ("MAT223", {"text": "배점: 기말 40%"}),                                           # untyped: grading words
        ]
        texts = lambda query: [t for _, t in cb._required(query, facts)]
        self.assertEqual(texts("STA256 약점 알려줘"), ["Q3 분모를 P(A)로 씀", "Term Test 2: 11.5/25", "Test 1: 47/50 (94%)"])
        self.assertEqual(texts("기말 언제야"), ["기말: 2026-12-10(목), RA Gym", "기말 2026-12-19(토) 09:00–12:00"])
        self.assertEqual(texts("배점 비중 알려줘"), ["늦으면 10% 감점, 근거 없으면 0/2", "배점: 기말 40%"])
        self.assertEqual(texts("연습문제 어디서 풀어"), ["장별 Exercise 109개"])

    def test_schedule_skips_typed_results_but_keeps_exams_and_untyped(self):
        from datetime import datetime
        sb = plugin.sb
        sb._cache.clear()
        saved = sb.now
        sb.now = lambda: datetime(2026, 11, 24, 9, 0, tzinfo=sb.TZ)
        try:
            client = FakeClient({
                ("GET", "/pages"): {"pages": [{"slug": "sta256"}]},
                ("GET", "/page"): {"page": {"title": "STA256"}, "facts": [
                    {"text": "기말: 2026-12-10(목) 17:00–20:00", "kind": "exam"},
                    {"text": "Quiz 5 (2026-12-01) 결과 공개 예정 8/10", "kind": "score"},
                    {"text": "과제 A4 2026-12-05 23:59 마감"}]},
            })
            items = [i["what"] for i in sb._course_items(client)]
        finally:
            sb.now = saved
            sb._cache.clear()
        self.assertEqual(items, ["STA256 · 기말: 2026-12-10(목) 17:00–20:00", "STA256 · 과제 A4 2026-12-05 23:59 마감"])


def _load_backfill():
    spec = importlib.util.spec_from_file_location("backfill_fact_kinds", PLUGIN_DIR.parents[1] / "scripts" / "backfill_fact_kinds.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BackfillTest(unittest.TestCase):
    """Deterministic kind proposals for existing facts; dry run by default, writes only through the API."""

    @classmethod
    def setUpClass(cls):
        cls.bf = _load_backfill()

    def test_proposals_follow_the_old_word_rules(self):
        course = {"slug": "mat223", "type": "course"}
        cases = [
            ("MAT223 Quiz 1 T/F 0/1, Test 1 5(c) 0점", course, "mistake"),
            ("Test 1: 47/50 (94%). Q2 9.5(셋째 성분 계산 실수 10→18)", course, "mistake"),   # both: mistake wins (stays in recordedMistakes)
            ("Test 1: 47/50 (94%)", course, "score"),
            ("Term Test 2 (2026-11-14): 11.5/25", course, "score"),
            ("Test 1은 10/15", course, "score"),
            ("기말: 2026-12-16(수) 09:00–12:00, RA Gym A/B", course, "exam"),
            ("기말 (12/16 수) RA Gym", course, "exam"),                       # a date, not a score
            ("기말 12/16 09:00–12:00", course, "exam"),
            ("과제 A2 마감 2026-11-28 23:59", course, "deadline"),
            ("배점: 시험 2개 각 20% · 기말 40%", course, "grading"),
            ("늦으면 하루 10% 감점", course, "grading"),
            ("장별 Exercise 109개: 1장 10 · 2장 18", course, "resource"),
            ("교재: Liu 노트", course, "resource"),
            ("월·수·금 아침 7시", {"slug": "헬스", "type": "habit"}, "habit"),
            ("메일 요약은 마감일 먼저", {"slug": "preferences", "type": "other"}, "preference"),
            ("담당 교수: Mohammad", course, None),
        ]
        for text, page, kind in cases:
            self.assertEqual(self.bf.propose(text, page)[0], kind, text)

    def _db(self, with_kind: bool) -> str:
        import sqlite3
        path = os.path.join(self.tmp.name, f"k{int(with_kind)}.db")
        con = sqlite3.connect(path)
        con.executescript(
            "CREATE TABLE pages (id TEXT PRIMARY KEY, slug TEXT, title TEXT, type TEXT, archived INTEGER DEFAULT 0);"
            f"CREATE TABLE facts (id TEXT PRIMARY KEY, page_id TEXT, text TEXT, status TEXT, created_at TEXT{', kind TEXT' if with_kind else ''});")
        con.execute("INSERT INTO pages VALUES ('p1', 'mat223', 'MAT223', 'course', 0)")
        con.execute("INSERT INTO pages VALUES ('p2', 'old', 'Old', 'course', 1)")
        rows = [("f1", "p1", "Test 1: 47/50 (94%)"), ("f2", "p1", "Test 1 5(c) 근거가 틀려 0점"), ("f3", "p1", "담당 교수: Mohammad"),
                ("f4", "p2", "Quiz 0/1 실수")]
        for i, (fid, pid, text) in enumerate(rows):
            con.execute(f"INSERT INTO facts (id, page_id, text, status, created_at) VALUES (?, ?, ?, 'active', ?)", (fid, pid, text, f"2026-11-0{i + 1}"))
        if with_kind:
            con.execute("UPDATE facts SET kind = 'score' WHERE id = 'f1'")
        con.commit()
        con.close()
        return path

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def _main(self, *argv):
        import contextlib
        import io
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = self.bf.main(list(argv))
        return code, out.getvalue()

    def test_dry_run_on_a_database_copy_changes_nothing(self):
        before_v2 = self._db(with_kind=False)                       # a backup taken before the migration
        code, out = self._main("--db", before_v2)
        self.assertEqual(code, 0)
        self.assertIn("active facts: 3  already typed: 0  untyped: 3", out)   # archived page left out
        self.assertRegex(out, r"mistake\s+1\n\s+f2  \[MAT223\] Test 1 5\(c\)")
        self.assertRegex(out, r"score\s+1\n\s+f1")
        self.assertRegex(out, r"\(no rule: stays untyped\)\s+1")
        self.assertIn("recordedMistakes   gained 0; lost 0", out)
        self.assertIn("dry run: nothing was changed.", out)
        code, out = self._main("--db", self._db(with_kind=True), "--no-excerpts")
        self.assertIn("already typed: 1  untyped: 2", out)
        self.assertIn("already typed (left as they are): score 1", out)
        self.assertNotIn("근거가", out)                               # ids only
        import contextlib
        import io
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            self.bf.main(["--db", before_v2, "--apply"])             # never writes into a database file

    def test_apply_goes_through_the_api_for_untyped_facts_only(self):
        posted, keys = [], []
        facts = [{"id": UUID, "text": "Test 1 5(c) 근거가 틀려 0점", "kind": None, "page": {"slug": "mat223", "title": "MAT223", "type": "course"}},
                 {"id": "typed", "text": "Quiz 0/1 실수", "kind": "other", "page": {"slug": "mat223", "title": "MAT223", "type": "course"}},
                 {"id": "plain", "text": "담당 교수", "kind": None, "page": {"slug": "mat223", "title": "MAT223", "type": "course"}}]

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _send(self, payload):
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(payload).encode())

            def do_GET(self):  # noqa: N802
                keys.append(self.headers.get("X-Knowledge-Key"))
                self._send({"facts": facts, "total": len(facts)})

            def do_POST(self):  # noqa: N802
                keys.append(self.headers.get("X-Knowledge-Key"))
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                posted.append((self.path, body))
                self._send({"id": UUID, "kind": body["kind"], "retyped": True})

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        key_file = os.path.join(self.tmp.name, "op.key")
        with open(key_file, "w", encoding="utf-8") as f:
            f.write("o" * 40 + "\n")
        try:
            api = f"http://127.0.0.1:{server.server_address[1]}"
            code, out = self._main("--api", api, "--key-file", key_file)
            self.assertEqual((code, posted), (0, []))                  # dry run: reads only
            code, out = self._main("--api", api, "--key-file", key_file, "--apply")
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual(code, 0)
        self.assertEqual(posted, [(f"/facts/{UUID}", {"kind": "mistake", "reason": "kind backfill (word rules)"})])
        self.assertIn("applied: 1 stored, 0 unchanged, 0 failed", out)
        self.assertTrue(all(k == "o" * 40 for k in keys))
        self.assertNotIn("o" * 40, out)


class _Sync:
    def __init__(self, target, args):
        self.target, self.args = target, args

    def start(self):
        self.target(*self.args)


class HttpClientTest(unittest.TestCase):
    def test_sends_the_broker_key_and_maps_errors(self):
        seen = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):  # noqa: N802
                seen.append((self.path, self.headers.get("X-Broker-Key")))
                if self.path.startswith("/knowledge/page"):
                    self.send_response(404)
                    payload = {"statusCode": 404, "code": "not_found", "message": "No page", "similar": ["CSC263"]}
                else:
                    self.send_response(200)
                    payload = {"results": []}
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(payload).encode())

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        with tempfile.NamedTemporaryFile("w", delete=False, suffix=".key") as f:
            f.write("b" * 40 + "\n")
        try:
            env = {"PERSONAL_AI_BROKER_URL": f"http://127.0.0.1:{server.server_address[1]}", "PERSONAL_AI_BROKER_KEY_FILE": f.name}
            ok = kc.run_tool({"action": "search", "q": "헬스"}, env)
            self.assertTrue(ok["ok"])
            missing = kc.run_tool({"action": "page", "page": "CSC26"}, env)
            self.assertEqual(missing["error"]["similar"], ["CSC263"])
            self.assertTrue(seen[0][0].startswith("/knowledge/search?q="))
            self.assertTrue(all(key == "b" * 40 for _, key in seen))
            down = kc.run_tool({"action": "profile"}, {"PERSONAL_AI_BROKER_URL": "http://127.0.0.1:9"})
            self.assertEqual(down["error"]["code"], "unavailable")
        finally:
            server.shutdown()
            os.unlink(f.name)


if __name__ == "__main__":
    unittest.main()
