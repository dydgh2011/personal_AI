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
        text = self.provider.prefetch("내 헬스 일정 알려줘")
        self.assertTrue(text.startswith("## Known about the owner"))
        self.assertIn("월수금", text)
        self.assertEqual(self.provider.recall_status().count, 1)
        self.client.answers[("GET", "/recall")] = kc.KnowledgeError("unavailable", "down")
        self.assertEqual(self.provider.prefetch("내 헬스 일정"), "")
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
