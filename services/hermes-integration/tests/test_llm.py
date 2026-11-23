"""Tests for the /ai-paid and /ai-usage slash commands (llm_client) against a fake gateway.

    python -m unittest discover -s services/hermes-integration/tests -v
"""
from __future__ import annotations

import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "plugins" / "personal-ai-controller"))
import llm_client  # noqa: E402

KEY = "k" * 43
STATE = {"approved": False, "calls": []}


class FakeGateway(BaseHTTPRequestHandler):
    def log_message(self, *args):  # quiet
        pass

    def _send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        STATE["calls"].append(("GET", self.path, self.headers.get("Authorization")))
        if self.headers.get("Authorization") != f"Bearer {KEY}":
            return self._send(401, {"error": {"message": "Invalid key"}})
        self._send(200, {
            "localDay": "2026-11-23",
            "pools": [
                {"label": "OpenAI 무료 (mini/nano)", "tokens": 1_250_000, "requests": 40, "tokensPerDay": 2_500_000,
                 "requestsPerDay": None, "stopAt": 0.8, "usedShare": 0.5},
                {"label": "Gemini 3.5 Flash-Lite 무료", "tokens": 0, "requests": 12, "tokensPerDay": None,
                 "requestsPerDay": 500, "stopAt": 0.96, "usedShare": 0.024},
            ],
            "paid": {"approvedToday": STATE["approved"], "spentTodayUsd": 0.0123, "dailyCapUsd": 0.3},
            "totalSpentUsd": 0.0456,
        })

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        STATE["calls"].append(("POST", self.path, body))
        STATE["approved"] = body["enable"]
        self._send(200, {"approvedToday": body["enable"], "localDay": "2026-11-23", "dailyCapUsd": 0.3, "spentTodayUsd": 0})


class LlmCommandTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeGateway)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.env = {"LLM_GATEWAY_URL": f"http://127.0.0.1:{cls.server.server_port}", "LLM_GATEWAY_KEY": KEY}

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_usage_text(self):
        text = llm_client.usage_text(self.env)
        self.assertIn("1.25M / 2.50M 토큰 (50%, 80%에서 멈춤)", text)
        self.assertIn("12 / 500 요청", text)
        self.assertIn("유료: 꺼짐", text)

    def test_paid_on_off_status(self):
        self.assertIn("자정까지 유료", llm_client.paid_command("on", self.env))
        self.assertEqual(STATE["calls"][-1], ("POST", "/control/paid", {"enable": True}))
        self.assertIn("허용됨", llm_client.paid_command("status", self.env))
        self.assertIn("껐어요", llm_client.paid_command("off", self.env))
        self.assertIn("사용법", llm_client.paid_command("yes please", self.env))

    def test_errors_are_reported_not_raised(self):
        self.assertIn("401", llm_client.paid_command.__name__ and str(self._err()))

    def _err(self):
        try:
            llm_client.usage_text({**self.env, "LLM_GATEWAY_KEY": "wrong"})
        except RuntimeError as err:
            return err
        return None

    def test_plugin_registers_commands(self):
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from test_plugin import FakeContext, plugin  # noqa: E402
        ctx = FakeContext()
        plugin.register(ctx)
        self.assertEqual(sorted(ctx.commands), ["ai-paid", "ai-usage"])


if __name__ == "__main__":
    unittest.main()
