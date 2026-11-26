"""personal_ai_planner actions added after the 2026-11-26 review: report, pace, agenda, todo_schedule, block_update
overlap questions, allow_past, exam-like todo warnings. A fake broker client records what would be sent."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "plugins" / "personal-ai-controller"))
import planner_client  # noqa: E402

TODO = "22222222-2222-4222-8222-222222222222"
BLOCK = "11111111-1111-4111-8111-111111111111"


class FakeClient:
    def __init__(self, answers):
        self.answers = answers
        self.calls = []

    def request(self, method, path, body=None, retry=True):
        self.calls.append((method, path, body))
        for (m, prefix), answer in self.answers.items():
            if m == method and path.startswith(prefix):
                return 200, {}, answer(body) if callable(answer) else answer
        raise AssertionError(f"unexpected call {method} {path}")


def run(action, client, **args):
    try:
        return planner_client.HANDLERS[action](client, {"action": action, **args})
    except planner_client.CliError as err:
        return {"ok": False, "error": {"code": err.code, "message": err.message}}


REPORT = {"id": 7, "itemKind": "block", "itemId": BLOCK, "todoId": TODO, "title": "S3 · STA256", "category": "study",
          "course": "STA256", "date": "2026-11-27", "plannedStart": "13:00", "plannedEnd": "14:15", "plannedMinutes": 75,
          "actualStart": None, "actualEnd": "14:45", "minutes": 105, "status": "late", "percent": 100, "note": "어려웠음",
          "corrects": None, "createdAt": ""}
TODO_ROW = {"id": TODO, "title": "S3 · STA256", "estimateMinutes": 300, "doneMinutes": 105, "deadline": "2026-11-30",
            "priority": 2, "status": "open"}


class PlannerActionsTest(unittest.TestCase):
    def test_report_records_and_offers_nothing_by_itself(self):
        client = FakeClient({("POST", "/planner/reports"): {"report": REPORT, "todo": TODO_ROW}})
        out = run("report", client, block_id=BLOCK, report_status="late", actual_end="14:45", notes="어려웠음")
        self.assertTrue(out["ok"])
        self.assertEqual(client.calls[-1][2], {"status": "late", "blockId": BLOCK, "actualEnd": "14:45", "note": "어려웠음"})
        self.assertIn("기록함 (report_id 7)", out["display"])
        self.assertIn("늦게 끝냄 · 계획 13:00-14:15 (75분) · 실제 ?-14:45 105분", out["display"])
        self.assertIn("할 일 진행", out["display"])
        self.assertIn("OFFER", out["note"])
        # a correction points at the report; something unplanned needs a title and a date
        run("report", client, corrects_report_id=7, report_status="late", minutes=90)
        self.assertEqual(client.calls[-1][2], {"status": "late", "corrects": 7, "minutes": 90})
        run("report", client, title="산책", date="2026-11-27", report_status="done", minutes=30)
        self.assertEqual(client.calls[-1][2], {"status": "done", "title": "산책", "date": "2026-11-27", "minutes": 30})
        n = len(client.calls)
        self.assertEqual(run("report", client, block_id=BLOCK, report_status="finished")["error"]["code"], "usage_error")
        self.assertEqual(run("report", client, report_status="done")["error"]["code"], "usage_error")
        self.assertEqual(len(client.calls), n)

    def test_pace_and_agenda_displays(self):
        group = {"key": "STA256", "reports": 3, "done": 1, "partial": 1, "skipped": 0, "late": 1, "plannedMinutes": 200,
                 "actualMinutes": 260, "ratio": 1.3, "endDelayMinutes": 15}
        pace = {"from": "2026-10-31", "to": "2026-11-27", "days": 28, "overall": {**group, "key": "all"},
                "byCourse": [group], "byCategory": [{**group, "key": "study"}]}
        client = FakeClient({("GET", "/planner/pace"): pace})
        out = run("pace", client)
        self.assertEqual(client.calls[-1][1], "/planner/pace?days=28")
        self.assertIn("  STA256: 실제/계획 1.3배 (계획 200분 → 실제 260분, 끝 시각 평균 +15분", out["display"])
        self.assertIn("  공부: 실제/계획 1.3배", out["display"])
        self.assertEqual(run("pace", client, days=0)["error"]["code"], "usage_error")

        agenda = {"from": "2026-11-26", "to": "2026-12-25", "calendarConnected": True, "items": [
            {"kind": "overdue", "date": "2026-11-20", "title": "FAS Technical Test", "todoId": TODO, "minutesLeft": 120, "daysLeft": -6},
            {"kind": "deadline", "date": "2026-12-01", "title": "HW#4", "todoId": TODO, "minutesLeft": 60, "daysLeft": 5},
            {"kind": "exam", "date": "2026-12-10", "start": "17:00", "end": "20:00", "title": "STA256H5 Final Exam",
             "label": "STA256 기말 17:00–20:00", "eventId": "e1", "daysLeft": 14}]}
        client = FakeClient({("GET", "/planner/agenda"): agenda})
        lines = run("agenda", client, days=30)["display"].splitlines()
        self.assertEqual(client.calls[-1][1], "/planner/agenda?days=30")
        self.assertEqual(lines[1:], [
            "  2026-11-20 [마감 지남] FAS Technical Test (6일 지남, 남은 120분)",
            "  2026-12-01 [마감] HW#4 (D-5, 남은 60분)",
            "  2026-12-10 17:00-20:00 [시험] STA256 기말 17:00–20:00 (D-14)",
        ])

    def test_todo_schedule_shows_first_then_writes_after_the_ok(self):
        preview = {"todo": TODO_ROW, "dryRun": True, "block": {"date": "2026-11-27", "start": "14:00", "end": "15:00",
                                                               "title": "S3 · STA256", "category": "study"},
                   "overlaps": [{"date": "2026-11-27", "start": "14:30", "end": "15:30", "title": "병원", "replaceable": True}]}
        written = {"todo": TODO_ROW, "overlaps": [], "block": {"id": BLOCK, "date": "2026-11-27", "start": "14:00", "end": "15:00",
                                                               "title": "S3 · STA256", "category": "study"}}
        client = FakeClient({("POST", f"/planner/todos/{TODO}/schedule"): lambda body: preview if body.get("dryRun") else written})
        args = dict(todo_id=TODO, date="2026-11-27", start="14:00", end="15:00")
        asked = run("todo_schedule", client, **args)
        self.assertEqual(asked["error"]["code"], "needs_confirmation")
        self.assertIn("2026-11-27 14:00-15:00 S3 · STA256 (공부) -> Kelly 캘린더", asked["error"]["message"])
        self.assertIn("2026-11-27 14:30-15:30 병원", asked["error"]["message"])
        self.assertTrue(all(c[2].get("dryRun") for c in client.calls), "nothing written before the OK")
        done = run("todo_schedule", client, **args, confirmed_by_user=True)
        self.assertTrue(done["ok"])
        self.assertEqual(client.calls[-1][2], {"date": "2026-11-27", "start": "14:00", "end": "15:00"})
        self.assertIn("캘린더에 넣음: 2026-11-27 14:00-15:00", done["display"])

    def test_block_update_asks_when_the_new_time_overlaps(self):
        clash = {"block": {"id": BLOCK, "date": "2026-11-27", "start": "12:30", "end": "13:30", "dryRun": True,
                           "overlaps": [{"date": "2026-11-27", "start": "12:00", "end": "13:00", "title": "병원", "replaceable": True}]}}
        moved = {"block": {"id": BLOCK, "date": "2026-11-27", "start": "12:30", "end": "13:30", "overlaps": []}}
        client = FakeClient({("POST", f"/planner/blocks/{BLOCK}/update"): lambda body: clash if body.get("dryRun") else moved})
        asked = run("block_update", client, block_id=BLOCK, start="12:30")
        self.assertEqual(asked["error"]["code"], "needs_confirmation")
        self.assertIn("2026-11-27 12:00-13:00 병원", asked["error"]["message"])
        self.assertEqual(len(client.calls), 1)
        self.assertTrue(run("block_update", client, block_id=BLOCK, start="12:30", confirmed_by_user=True)["ok"])
        self.assertEqual(client.calls[-1][2], {"start": "12:30"})
        # a rename needs no preview
        client.calls.clear()
        run("block_update", client, block_id=BLOCK, title="책")
        self.assertEqual([c[2] for c in client.calls], [{"title": "책"}])

    def test_allow_past_is_passed_only_when_given(self):
        event = {"event": {"id": "", "title": "x", "category": "personal", "when": "11/20(금) 12:00–13:00", "overlaps": [], "replaced": []}}
        client = FakeClient({("POST", "/planner/events"): event, ("POST", "/planner/blocks"): {"block": {"id": BLOCK}}})
        run("event_add", client, title="x", date="2026-11-20", start="12:00", end="13:00", category="personal", allow_past=True)
        self.assertTrue(all(c[2]["allowPast"] is True for c in client.calls))
        client.calls.clear()
        run("event_add", client, title="x", date="2026-11-27", start="12:00", end="13:00", category="personal")
        self.assertTrue(all("allowPast" not in c[2] for c in client.calls))
        self.assertEqual(run("event_add", client, title="x", date="2026-11-27", start="12:00", end="13:00", category="personal",
                             allow_past="yes")["error"]["code"], "usage_error")

    def test_exam_like_todo_comes_back_with_the_warning(self):
        warning = '"FAS Technical Test" looks like an exam or quiz sitting. ... event_add ...'
        client = FakeClient({("POST", "/planner/todos"): {"todo": {**TODO_ROW, "title": "FAS Technical Test", "doneMinutes": 0},
                                                         "warnings": [warning]}})
        out = run("todo_add", client, title="FAS Technical Test", estimate_minutes=120)
        self.assertEqual(out["warnings"], [warning])
        self.assertIn("[주의] \"FAS Technical Test\" looks like an exam", out["display"])

    def test_day_marks_reported_items_and_exam_days(self):
        day = {"date": "2026-11-27", "weekday": "금", "status": "draft", "pendingChanges": False, "noAutoDraft": None,
               "blocks": [{"id": BLOCK, "start": "13:00", "end": "14:15", "title": "S3", "category": "study",
                           "reported": {"reportId": 8, "status": "late", "minutes": 90, "actualStart": None, "actualEnd": "14:30"}}],
               "events": [{"id": "lee1", "seriesId": None, "start": "17:00", "end": "17:30", "title": "LeetCode", "allDay": False,
                           "category": "routine", "deadline": False, "examMarker": False,
                           "reported": {"reportId": 9, "status": "skipped", "minutes": 0, "actualStart": None, "actualEnd": None}}],
               "unscheduled": [], "overdue": [], "warnings": [], "calendarConnected": True}
        text = "\n".join(planner_client._day_lines(day))
        self.assertIn("(block_id 11111111-1111-4111-8111-111111111111) [보고: 늦게 끝냄 · 실제 ?-14:30 · 90분, report_id 8]", text)
        self.assertIn("[보고: 건너뜀 · 0분, report_id 9]", text)
        head = planner_client._day_lines({**day, "noAutoDraft": "STA256H5 Final Exam"})[0]
        self.assertIn("기말 시험일이라 자동 초안 없음 (STA256H5 Final Exam)", head)

    def test_todo_reaching_its_estimate_is_not_finished(self):
        line = planner_client._todo_line({**TODO_ROW, "doneMinutes": 300})
        self.assertIn("예상 시간 다 씀 - 끝났는지 물어보기", line)
        self.assertNotIn("예상 시간 다 씀", planner_client._todo_line({**TODO_ROW, "doneMinutes": 300, "status": "done"}))

    def test_new_actions_and_settings_are_in_the_schema(self):
        import importlib.util
        plugin_dir = Path(__file__).resolve().parents[1] / "plugins" / "personal-ai-controller"
        spec = importlib.util.spec_from_file_location("planner_schema_check", plugin_dir / "__init__.py",
                                                      submodule_search_locations=[str(plugin_dir)])
        plugin = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = plugin
        spec.loader.exec_module(plugin)
        props = plugin.PLANNER_SCHEMA["parameters"]["properties"]
        for action in ("report", "pace", "agenda", "todo_schedule"):
            self.assertIn(action, props["action"]["enum"])
        for key in ("allow_past", "report_status", "actual_start", "actual_end", "percent", "corrects_report_id"):
            self.assertIn(key, props)
        for key in ("noDraftExamWords", "quietEvents", "bundleMinutes", "draftAt"):
            self.assertIn(key, planner_client.SETTING_KEYS)
            self.assertIn(key, props["settings"]["description"])


if __name__ == "__main__":
    unittest.main()
