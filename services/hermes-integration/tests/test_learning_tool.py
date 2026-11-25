"""Test the Learning tool against a loopback stand-in for the broker."""

from __future__ import annotations

import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from test_plugin import plugin


ROADMAP_ID = "3f1c2a54-0000-4000-8000-000000000000"
TEST_KEY = "synthetic-broker-key-" + "k" * 32


class LearningToolTest(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.post_status = 201
        self.redirect = False
        mock = self

        class Broker(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def respond(self, status, data):
                data = json.dumps(data).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                if status == 302:
                    self.send_header("Location", "/different-target")
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                mock.calls.append(("GET", self.path, None, self.headers))
                if mock.redirect and self.path == "/learning/schedule/status":
                    self.respond(302, {})
                    return
                self.respond(200, {"items": []})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                mock.calls.append(("POST", self.path, body, self.headers))
                self.respond(mock.post_status, {"proposal": {"code": "A", "title": "Study", "status": "draft"}})

        server = ThreadingHTTPServer(("127.0.0.1", 0), Broker)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join, 2)
        self.addCleanup(server.shutdown)
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        key = Path(temp.name) / "synthetic-key"
        key.write_text(TEST_KEY, encoding="utf-8")
        self.env = {
            "PERSONAL_AI_BROKER_URL": f"http://127.0.0.1:{server.server_port}",
            "PERSONAL_AI_BROKER_KEY_FILE": str(key),
            "CONTROLLER_TOKEN_FILE": str(Path(temp.name) / "no-controller-credential"),
        }

    def tool(self, **args):
        return plugin.run_learning_tool(
            args, env=self.env, client_factory=lambda c: plugin.client_lib.Client(c, timeout=3, sleep=lambda _seconds: None)
        )

    def test_query_routes_use_fixed_paths_and_send_only_the_broker_key(self):
        for resource, args, path in [
            ("domains", {}, "/learning/domains"),
            ("roadmaps", {}, "/learning/roadmaps"),
            ("roadmap", {"roadmap_id": ROADMAP_ID}, f"/learning/roadmaps/{ROADMAP_ID}"),
            ("status", {}, "/learning/schedule/status"),
            ("schedule", {}, "/learning/schedule"),
            ("schedule", {"date": "2028-02-29", "period": "week"}, "/learning/schedule?date=2028-02-29&period=week"),
        ]:
            with self.subTest(resource=resource):
                result = self.tool(action="query", resource=resource, **args)
                self.assertTrue(result["ok"])
                self.assertEqual(result["data"], {"items": []})
                self.assertNotIn(TEST_KEY, json.dumps(result))
                method, requested, body, headers = self.calls[-1]
                self.assertEqual((method, requested, body), ("GET", path, None))
                self.assertEqual(headers["X-Broker-Key"], TEST_KEY)
                self.assertIsNone(headers["Authorization"])
                self.assertIsNone(headers["X-Learning-Key"])

    def test_propose_returns_status_and_does_not_retry_writes(self):
        result = self.tool(action="propose", date="2026-11-24", period="day")
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["proposal"]["status"], "draft")
        self.assertEqual(self.calls[-1][:3], ("POST", "/learning/schedule/propose", {"date": "2026-11-24", "period": "day"}))
        self.post_status = 503
        result = self.tool(action="propose")
        self.assertEqual(result["error"]["httpStatus"], 503)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.calls[-1][2], {})

    def test_out_of_scope_or_invalid_inputs_make_no_request(self):
        for args in [
            {"action": "apply"},
            {"action": "query", "resource": "/export"},
            {"action": "query", "resource": "roadmap"},
            {"action": "query", "resource": "roadmap", "roadmap_id": "invalid"},
            {"action": "query", "resource": "schedule", "date": "2026-02-29"},
            {"action": "query", "resource": "status", "period": "day"},
            {"action": "propose", "period": "year"},
            {"action": "propose", "deadline": "2026-11-24"},
            {"action": "propose", "url": "http://learning"},
        ]:
            with self.subTest(args=args):
                self.assertEqual(self.tool(**args)["error"]["code"], "usage_error")
        self.assertEqual(self.calls, [])

    def test_requires_broker_key_and_refuses_redirects(self):
        key_file = self.env.pop("PERSONAL_AI_BROKER_KEY_FILE")
        self.assertEqual(self.tool(action="query", resource="status")["error"]["code"], "config_error")
        self.assertEqual(self.calls, [])
        self.env["PERSONAL_AI_BROKER_KEY_FILE"] = key_file
        self.redirect = True
        error = self.tool(action="query", resource="status")["error"]
        self.assertEqual(error["httpStatus"], 302)
        self.assertEqual([call[1] for call in self.calls], ["/learning/schedule/status"])
