"""Display text of personal_ai_planner for overdue todos and blocks dropped with a finished todo (2026-11-26)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "plugins" / "personal-ai-controller"))
import planner_client  # noqa: E402

OVERDUE = {"todoId": "f1a6c249-f4ca-4efc-829e-06b541209c79", "title": "FAS Technical Test", "deadline": "2026-11-26", "minutes": 120}


def day(date: str, overdue: list) -> dict:
    return {"date": date, "weekday": "금", "status": "draft", "pendingChanges": False, "blocks": [], "events": [],
            "unscheduled": [], "overdue": overdue, "warnings": [], "calendarConnected": True}


class PlannerDisplayTest(unittest.TestCase):
    def test_day_lists_overdue_todos_and_what_to_ask(self):
        text = "\n".join(planner_client._day_lines(day("2026-11-27", [OVERDUE])))
        self.assertIn("[마감 지남] FAS Technical Test (마감 2026-11-26, 남은 120분", text)
        self.assertIn("자동으로 다시 넣지 않음", text)

    def test_week_lists_each_overdue_todo_once(self):
        out = planner_client._days({"days": [day("2026-11-27", [OVERDUE]), day("2026-11-28", [OVERDUE])]})
        self.assertEqual(out["display"].count("[마감 지남]"), 1)
        self.assertTrue(out["display"].rstrip().splitlines()[-1].startswith("  [마감 지남]"))

    def test_old_planner_without_overdue_field(self):
        d = day("2026-11-27", [])
        del d["overdue"]
        self.assertNotIn("마감 지남", "\n".join(planner_client._day_lines(d)))

    def test_todo_line_shows_dropped_blocks(self):
        todo = {"id": "22222222-2222-4222-8222-222222222222", "title": "리포트", "estimateMinutes": 600, "doneMinutes": 600,
                "deadline": "2026-11-30", "priority": 2, "status": "done",
                "droppedBlocks": [{"date": "2026-11-28", "start": "07:00", "end": "08:30", "title": "리포트", "inCalendar": True},
                                  {"date": "2026-11-29", "start": "07:00", "end": "08:30", "title": "리포트", "inCalendar": False}]}
        line = planner_client._todo_line(todo)
        self.assertIn("초안에서 뺀 블록: 2026-11-28 07:00-08:30 (캘린더에 있음: 그날 confirm하면 지워짐), 2026-11-29 07:00-08:30", line)
        del todo["droppedBlocks"]
        self.assertNotIn("뺀 블록", planner_client._todo_line(todo))


if __name__ == "__main__":
    unittest.main()


class SettingsConfirmationTest(unittest.TestCase):
    """settings_update shows before -> after and writes nothing without confirmed_by_user (2026-11-26)."""

    class Client:
        def __init__(self):
            self.posts = []

        def request(self, method, path, body=None, retry=True):
            if method == "GET" and path == "/planner/status":
                return 200, {}, {"settings": {"remindScope": "all", "remindMinutes": 15}}
            self.posts.append((path, body))
            return 200, {}, {"settings": {"remindScope": "planner"}}

    def test_preview_then_confirmed(self):
        client = self.Client()
        with self.assertRaises(planner_client.CliError) as err:
            planner_client.a_settings_update(client, {"settings": {"remindScope": "planner"}})
        self.assertEqual(err.exception.code, "needs_confirmation")
        self.assertIn('remindScope: "all" -> "planner"', err.exception.message)
        self.assertEqual(client.posts, [])
        out = planner_client.a_settings_update(client, {"settings": {"remindScope": "planner"}, "confirmed_by_user": True})
        self.assertTrue(out["ok"])
        self.assertEqual(client.posts, [("/planner/settings", {"remindScope": "planner"})])
