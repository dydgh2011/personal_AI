"""python -m unittest discover -s services/school/tests -v"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.request
from datetime import datetime, timezone
from email.message import EmailMessage
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from school.classify import classify  # noqa: E402
from school.clients import ServiceError, external_id  # noqa: E402
from school.connectors.course_site import CourseSites, parse_sites  # noqa: E402
from school.connectors.mail import Mail, body_text, is_uoft  # noqa: E402
from school.connectors.piazza import _post_text  # noqa: E402
from school.items import AuthExpired, Item, html_text  # noqa: E402
from school.service import School, serve  # noqa: E402
from school.store import Store  # noqa: E402


class FakeConnector:
    def __init__(self, name):
        self.name = name
        self.items: list[Item] = []
        self.error: Exception | None = None

    def fetch(self, state):
        if self.error:
            raise self.error
        return list(self.items)


class FakeKnowledge:
    def __init__(self):
        self.added = []
        self.fail = False

    def add(self, item):
        if self.fail:
            raise ServiceError("knowledge down")
        self.added.append(item)
        return f"k{len(self.added)}"


class FakeNotifier:
    def __init__(self):
        self.sent = []

    def school(self, key, mode, items, more, ping=True):
        self.sent.append({"key": key, "mode": mode, "items": items, "more": more, "ping": ping})


class FakeLlm:
    def __init__(self):
        self.calls = 0

    def summarise(self, item, style=""):
        self.calls += 1
        self.style = style
        return f"요약: {item.title}"


def grade(i="1"):
    return Item("quercus", f"stream:{i}:t", "grade", f"Graded: A{i} - 18/20", "https://q.utoronto.ca/x", "2026-11-23T10:00:00Z",
                "Your assignment was graded", "CSC207")


def student_post(i="5"):
    return Item("piazza", f"c:{i}:m", "post", f"@{i} question about lab", "https://piazza.com/class/c/post/5", "", "how do I...",
                "CSC 207", {"tags": [], "instructor": False, "pinned": False})


class SchoolTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.store = Store(os.path.join(self.dir.name, "s.db"))
        self.q, self.p = FakeConnector("quercus"), FakeConnector("piazza")
        self.k, self.n, self.llm = FakeKnowledge(), FakeNotifier(), FakeLlm()
        self.now = datetime(2026, 11, 23, 15, 0, tzinfo=timezone.utc)  # 10:00 Toronto
        self.school = School({"quercus": self.q, "piazza": self.p}, {"outlook": "GMAIL_ADDRESS not set"}, self.store,
                             self.k, self.n, self.llm, clock=lambda: self.now)

    def tearDown(self):
        self.store.close()
        self.dir.cleanup()

    def test_first_poll_stores_everything_and_notifies_nothing(self):
        self.q.items = [grade("1"), grade("2")]
        self.p.items = [student_post()]
        self.school.poll()
        self.assertEqual(len(self.k.added), 3)
        self.assertEqual(self.n.sent, [])
        # the same items again: nothing new
        self.school.poll()
        self.assertEqual(len(self.k.added), 3)

    def test_new_items_go_now_or_to_the_digest(self):
        self.school.poll()  # empty baseline
        self.q.items = [grade("3")]
        self.p.items = [student_post("6")]
        self.school.poll()
        self.assertEqual(len(self.n.sent), 1)
        msg = self.n.sent[0]
        self.assertEqual(msg["mode"], "now")
        self.assertEqual([i["title"] for i in msg["items"]], ["Graded: A3 - 18/20"])
        self.assertEqual(msg["items"][0]["summary"], "요약: Graded: A3 - 18/20")
        # digest at 12:00 Toronto
        self.assertEqual(self.school.digest_due("2026-11-22 20:00"), None)  # 10:00 now: nothing due today yet
        self.now = datetime(2026, 11, 23, 17, 5, tzinfo=timezone.utc)  # 12:05 Toronto
        slot = self.school.digest_due("2026-11-22 20:00")
        self.assertEqual(slot, "2026-11-23 12:00")
        self.assertEqual(self.school.send_digest(), 1)
        self.assertEqual(self.n.sent[1]["mode"], "digest")
        self.assertEqual(self.school.send_digest(), 0)

    def test_every_uoft_mail_goes_out_at_once_urgent_ones_ping(self):
        m = FakeConnector("outlook")
        self.school.connectors["outlook"] = m
        self.school.poll()
        m.items = [Item("outlook", "<a@x>", "email", "Prof: Quick update", body="Test 2 is postponed to Friday.", extra={"from": "prof@utoronto.ca"}),
                   Item("outlook", "<b@x>", "email", "Club: newsletter", body="Join us", extra={"from": "club@utoronto.ca"})]
        self.school.poll()
        self.assertEqual([(s["mode"], s["ping"], [i["title"] for i in s["items"]]) for s in self.n.sent],
                         [("now", True, ["Prof: Quick update"]), ("now", False, ["Club: newsletter"])])
        self.assertTrue(all(i["summary"].startswith("요약:") for s in self.n.sent for i in s["items"]))
        self.assertEqual([i["title"] for i in self.school.api_updates(3, "outlook", True, 30)["items"]].__len__(), 2)

    def test_owner_rules_private_ignored_and_newsletters(self):
        m = FakeConnector("outlook")
        self.school.connectors["outlook"] = m
        self.school.poll()
        self.school.set_mail_rule("Bank <alerts@mybank.com>", "private", "은행", "hermes-broker")
        self.school.set_mail_rule("@shop.example", "ignore", "", "hermes-broker")
        self.school.set_summary_style("마감일을 맨 앞에, 한 줄로", "hermes-broker")
        m.items = [
            Item("gmail", "<p@x>", "email", "Bank (alerts@mybank.com): Statement", body="Balance 1,234.56", extra={"from": "alerts@mybank.com"}),
            Item("gmail", "<i@x>", "email", "Shop: sale", body="buy", extra={"from": "deals@shop.example"}),
            Item("gmail", "<n@x>", "email", "Weekly news", body="long newsletter", extra={"from": "news@paper.com", "category": "updates"}),
            Item("gmail", "<f@x>", "email", "Friend: dinner?", body="dinner on friday?", extra={"from": "friend@gmail.com"}),
        ]
        self.school.poll()
        sent = {i["title"]: (s["ping"], i["summary"]) for s in self.n.sent for i in s["items"]}
        self.assertEqual(sent["Bank (alerts@mybank.com): Statement"], (False, None))  # no AI, no body
        self.assertEqual(sent["Friend: dinner?"], (False, "요약: Friend: dinner?"))
        self.assertNotIn("Shop: sale", sent)
        self.assertNotIn("Weekly news", sent)  # newsletters wait for the digest
        self.assertEqual(self.llm.style, "마감일을 맨 앞에, 한 줄로")
        stored = {k.title: k.body for k in self.k.added}
        self.assertEqual(stored["Bank (alerts@mybank.com): Statement"], "Bank (alerts@mybank.com): Statement")
        self.assertNotIn("Shop: sale", stored)
        self.now = datetime(2026, 11, 23, 17, 5, tzinfo=timezone.utc)
        self.school.send_digest()
        digest = self.n.sent[-1]
        self.assertEqual(digest["mode"], "digest")
        self.assertEqual([(i["title"], i["summary"]) for i in digest["items"]], [("Weekly news", None)])
        settings = self.school.api_settings()
        self.assertEqual([r["match"] for r in settings["mailRules"]], ["@shop.example", "alerts@mybank.com"])
        self.school.set_mail_rule("@shop.example", "normal", "", "hermes-broker")
        self.assertEqual([r["match"] for r in self.school.mail_rules()], ["alerts@mybank.com"])
        self.assertEqual(len(self.school.api_settings()["history"]["mailRules"]), 3)

    def test_auth_problem_is_reported_once_a_day_and_others_keep_working(self):
        self.school.poll()
        self.q.error = AuthExpired("Quercus 토큰 만료")
        self.p.items = [student_post("7")]
        self.school.poll()
        self.school.poll()
        warnings = [i for m in self.n.sent for i in m["items"] if i["kind"] == "auth_warning"]
        self.assertEqual(len(warnings), 1)
        self.assertTrue(self.school.status["piazza"]["ok"])
        self.assertTrue(self.school.status["quercus"]["authExpired"])

    def test_updates_include_dated_items_from_before_the_connection(self):
        old = grade("10")
        old.date = "2026-11-22T12:00:00Z"
        undated = Item("course_site", "CSC207:index:x", "page_change", "CSC207 'index' page", extra={"first": True})
        ancient = grade("11")
        ancient.date = "2026-10-01T12:00:00Z"
        self.q.items = [old, ancient]
        self.p.items = []
        self.school.poll()
        self.store.add(undated, baseline=True, route="baseline")
        titles = [i["title"] for i in self.school.api_updates(3, None, False, 30)["items"]]
        self.assertEqual(titles, ["Graded: A10 - 18/20"])
        self.assertTrue(self.school.api_updates(3, None, False, 30)["items"][0]["beforeConnection"])

    def test_backfill_import_is_quiet_and_skips_known_items(self):
        from school.backfill import BackfillError, parse_line
        self.q.items = [grade("12")]
        self.school.poll()
        line = json.dumps({"service": "quercus", "id": "stream:12:t", "kind": "grade", "title": "Graded: A12"})
        old_post = json.dumps({"service": "piazza", "id": "c:3:2026-09-10T10:00:00Z", "kind": "post", "title": "@3 Week 1",
                               "body": "full text", "course": "CSC 207", "date": "2026-09-10T10:00:00Z"})
        r = self.school.import_items([parse_line(line, "a:1"), parse_line(old_post, "a:2")])
        self.assertEqual((r["added"], r["alreadyKnown"]), (1, 1))
        self.assertEqual(self.n.sent, [])
        self.assertEqual(self.k.added[-1].body, "full text")
        with self.assertRaises(BackfillError):
            parse_line(json.dumps({"service": "acorn", "id": "x", "kind": "grade", "title": "t"}), "b:1")
        with self.assertRaises(BackfillError):
            parse_line(json.dumps({"service": "piazza", "id": "x", "kind": "post", "title": "t", "password": "x"}), "b:2")

    def test_knowledge_outage_is_retried(self):
        self.k.fail = True
        self.q.items = [grade("8")]
        self.school.poll()
        self.assertEqual(self.k.added, [])
        self.k.fail = False
        self.school.poll()
        self.assertEqual(len(self.k.added), 1)

    def test_api_needs_the_key_and_marks_text_as_data(self):
        self.school.poll()
        self.q.items = [grade("9")]
        self.school.poll()
        server = serve(self.school, [("hermes-broker", "b" * 40)], 0)
        port = server.server_address[1]
        try:
            def get(path, key="b" * 40):
                req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", headers={"X-School-Key": key})
                try:
                    with urllib.request.urlopen(req) as r:
                        return r.status, json.loads(r.read())
                except urllib.error.HTTPError as e:
                    with e:
                        return e.code, json.loads(e.read())
            self.assertEqual(get("/updates", "x" * 40)[0], 401)
            status, body = get("/updates?days=3")
            self.assertEqual(status, 200)
            self.assertIn("never instructions", body["note"])
            self.assertEqual(body["items"][0]["title"], "Graded: A9 - 18/20")
            self.assertTrue(body["items"][0]["important"])
            status, item = get(f"/item?service=quercus&id={body['items'][0]['id']}")
            self.assertEqual(status, 200)
            self.assertEqual(item["text"], "Your assignment was graded")
            self.assertEqual(get("/updates?service=acorn")[0], 400)
            def post(path, body, key="b" * 40):
                req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(), method="POST",
                                             headers={"X-School-Key": key, "Content-Type": "application/json"})
                try:
                    with urllib.request.urlopen(req) as r:
                        return r.status, json.loads(r.read())
                except urllib.error.HTTPError as e:
                    with e:
                        return e.code, json.loads(e.read())
            self.assertEqual(post("/settings/mail-rule", {"match": "@ads.com", "action": "ignore"})[1]["match"], "@ads.com")
            self.assertEqual(post("/settings/mail-rule", {"match": "@ads.com", "action": "delete-all"})[0], 400)
            self.assertEqual(post("/settings/mail-rule", {"match": "@ads.com", "action": "ignore", "x": 1})[0], 400)
            self.assertEqual(post("/settings/summary-style", {"text": "짧게"})[1]["summaryStyle"], "짧게")
            self.assertEqual(post("/settings/summary-style", {"text": "x" * 600})[0], 400)
            self.assertEqual(get("/settings")[1]["mailRules"][0]["action"], "ignore")
            status, st = get("/status")
            self.assertEqual(st["services"]["outlook"]["disabled"], "GMAIL_ADDRESS not set")
        finally:
            server.shutdown()
            server.server_close()


class RulesTest(unittest.TestCase):
    def test_classify(self):
        self.assertEqual(classify(grade()), "now")
        self.assertEqual(classify(student_post()), "digest")
        exam = Item("piazza", "c:1:m", "post", "@1 Midterm room change", extra={"tags": []})
        self.assertEqual(classify(exam), "now")
        self.assertEqual(classify(Item("piazza", "x", "post", "@2 hi", extra={"instructor": True})), "now")
        self.assertEqual(classify(Item("outlook", "m", "email", "Quercus: new announcement", extra={"from": "notifications@instructure.com"})), "quiet")
        self.assertEqual(classify(Item("outlook", "m", "email", "Your STA256 Test 1 is returned", extra={"from": "noreply@crowdmark.com"})), "now")
        self.assertEqual(classify(Item("outlook", "m", "email", "Club newsletter", extra={"from": "club@utoronto.ca"})), "mail")
        body_urgent = Item("outlook", "m", "email", "Quick update", body="Hi all, Test 2 is postponed to Friday.", extra={"from": "prof@utoronto.ca"})
        self.assertEqual(classify(body_urgent), "now")
        due_to = Item("outlook", "m", "email", "Office hours", body="Due to the holiday there are no office hours.", extra={"from": "ta@utoronto.ca"})
        self.assertEqual(classify(due_to), "mail")
        self.assertEqual(classify(Item("quercus", "s", "submission", "Submitted: A1")), "quiet")
        self.assertEqual(classify(Item("course_site", "p", "page_change", "x", extra={"first": True})), "quiet")

    def test_html_and_ids(self):
        self.assertEqual(html_text("<p>Hi &amp; <b>bye</b></p><ul><li>one</li></ul>"), "Hi & bye\n- one")
        self.assertEqual(external_id(grade()), "school:quercus:stream:1:t")
        mail = Item("outlook", "<CAabc@mail.gmail.com>", "email", "t")
        self.assertRegex(external_id(mail), r"^school:outlook:h:[0-9a-f]{40}$")

    def test_piazza_post_text(self):
        post = {"history": [{"content": "<p>When is A2 due?</p>"}],
                "children": [{"type": "i_answer", "history": [{"content": "Friday 5pm"}]},
                             {"type": "followup", "subject": "Thanks", "children": [{"subject": "np"}]}]}
        self.assertEqual(_post_text(post), "When is A2 due?\n\n[강사 답변] Friday 5pm\n\n[후속 질문] Thanks\n\n  [답글] np")

    def test_mail_detection_and_body(self):
        m = EmailMessage()
        m["From"] = "Prof <prof@utoronto.ca>"
        m["To"] = "me@mail.utoronto.ca"
        m["Subject"] = "Test moved"
        m["Message-ID"] = "<1@x>"
        m.set_content("Test 2 is moved to Friday.\n\nRoom: MN1210")
        self.assertTrue(is_uoft(m, "me@mail.utoronto.ca"))
        self.assertEqual(body_text(m), "Test 2 is moved to Friday.\nRoom: MN1210")
        personal = EmailMessage()
        personal["To"] = "me@gmail.com"
        personal.set_content("hi")
        self.assertFalse(is_uoft(personal, "me@mail.utoronto.ca"))

        personal["From"] = "Shop <deals@shop.example>"
        personal["Subject"] = "50% off"
        personal["Message-ID"] = "<2@x>"
        personal["List-Unsubscribe"] = "<mailto:u@shop.example>"
        box = {b"1": m, b"2": personal}

        class FakeImap:
            def login(self, *a):
                pass

            def select(self, *a, **k):
                assert k.get("readonly") is True
                return "OK", [str(len(box)).encode()]

            def response(self, name):
                return name, [b"777"]

            def uid(self, cmd, *args):
                if cmd == "search":
                    args = tuple(a for a in args if a is not None)  # the charset argument
                    if "X-GM-RAW" in args:
                        return "OK", [b"2" if args[-1] == '"category:promotions"' else b""]
                    if args[0] == "UID":
                        low = int(args[1].split(b":")[0])
                        return "OK", [b" ".join(u for u in box if int(u) >= low)]
                    return "OK", [b" ".join(box)]
                assert args[1] == "(BODY.PEEK[])"  # never marks mail as read
                return "OK", [(b"x", box[args[0]].as_bytes())]

            def logout(self):
                pass

        mail = Mail({"GMAIL_ADDRESS": "me@gmail.com", "GMAIL_APP_PASSWORD": "abcd efgh", "UOFT_EMAIL": "me@mail.utoronto.ca"},
                    imap_factory=FakeImap)
        state: dict = {}
        items = mail.fetch(state)
        self.assertTrue(state.pop("_baseline_this_run"))
        self.assertEqual([(i.service, i.title) for i in items],
                         [("outlook", "Prof (prof@utoronto.ca): Test moved"), ("gmail", "Shop (deals@shop.example): 50% off")])
        self.assertEqual(items[1].extra["category"], "promotions")
        self.assertTrue(items[1].extra["bulk"])
        self.assertEqual(state["last_uid"], 2)
        # next check: only mail after the last UID
        self.assertEqual(mail.fetch(state), [])
        box[b"3"] = m
        self.assertEqual(len(mail.fetch(state)), 1)
        self.assertEqual(state["last_uid"], 3)
        self.assertNotIn("_baseline_this_run", state)

    def test_mail_rules(self):
        from school.mailrules import RuleError, find_rule, normalize_match
        self.assertEqual(normalize_match("Bank <Alerts@MyBank.com>"), "alerts@mybank.com")
        self.assertEqual(normalize_match("news.example.com"), "@news.example.com")
        with self.assertRaises(RuleError):
            normalize_match("not an address")
        rules = [{"match": "@example.com", "action": "ignore"}, {"match": "@news.example.com", "action": "notify_only"},
                 {"match": "boss@example.com", "action": "important"}]
        self.assertEqual(find_rule(rules, "boss@example.com")["action"], "important")
        self.assertEqual(find_rule(rules, "weekly@news.example.com")["action"], "notify_only")
        self.assertEqual(find_rule(rules, "ads@example.com")["action"], "ignore")
        self.assertIsNone(find_rule(rules, "x@other.org"))

        def mail(service, sender, title="hi", body="", **extra):
            return Item(service, "m", "email", title, body=body, extra={"from": sender, **extra})
        self.assertEqual(classify(mail("gmail", "boss@example.com"), rules), "now")
        self.assertEqual(classify(mail("gmail", "ads@example.com", "Midterm sale!"), rules), "ignored")
        self.assertEqual(classify(mail("gmail", "w@news.example.com"), rules), "notice")
        private = [{"match": "@mybank.com", "action": "private"}]
        self.assertEqual(classify(mail("gmail", "alerts@mybank.com"), private), "private")
        # personal defaults by Gmail tab; UofT mail ignores the tabs
        self.assertEqual(classify(mail("gmail", "a@shop.com", category="promotions")), "ignored")
        self.assertEqual(classify(mail("gmail", "a@site.com", category="updates")), "notice")
        self.assertEqual(classify(mail("gmail", "a@list.org", bulk=True)), "notice")
        self.assertEqual(classify(mail("gmail", "friend@gmail.com")), "mail")
        self.assertEqual(classify(mail("gmail", "friend@gmail.com", "Exam tomorrow")), "now")
        self.assertEqual(classify(mail("outlook", "dept@utoronto.ca", category="promotions", bulk=True)), "mail")

    def test_course_sites(self):
        with self.assertRaises(RuntimeError):
            parse_sites("X|https://evil.example/|index")

        class Resp:
            def __init__(self, text):
                self.text = text

            def raise_for_status(self):
                pass

        pages = {"v": "<p>A1 due Oct 1</p>"}

        class Http:
            def get(self, url, **kw):
                return Resp(pages["v"])

        site = CourseSites({"SCHOOL_COURSE_SITES": "CSC207|https://mcs.utm.utoronto.ca/~207/26f|index"}, Http())
        state: dict = {}
        first = site.fetch(state)
        self.assertTrue(first[0].extra["first"])
        self.assertEqual(site.fetch(state), [])
        pages["v"] = "<p>A1 due Oct 1</p><p>Midterm moved to Nov 3</p>"
        changed = site.fetch(state)
        self.assertEqual(changed[0].body, "Midterm moved to Nov 3")
        self.assertEqual(changed[0].url, "https://mcs.utm.utoronto.ca/~207/26f/index.shtml")


if __name__ == "__main__":
    unittest.main()
