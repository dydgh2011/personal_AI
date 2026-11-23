"""Quercus (Canvas LMS): official REST API with the owner's personal access token, GET only.

Env: QUERCUS_TOKEN, QUERCUS_TOKEN_EXPIRES (YYYY-MM-DD; UofT caps tokens at 30 days -> warning 5 days before).
The token could also submit work or send messages; this module only ever sends GET requests.
"""
from __future__ import annotations

from datetime import date

import requests

from ..items import AuthExpired, Item, html_text

BASE = "https://q.utoronto.ca/api/v1"
RENEW_WARN_DAYS = 5
KIND = {"Announcement": "announcement", "Submission": "grade", "Conversation": "message",
        "DiscussionTopic": "discussion", "Message": "notification"}


class Quercus:
    name = "quercus"

    def __init__(self, env: dict[str, str], http: requests.Session, today=date.today):
        self.token = (env.get("QUERCUS_TOKEN") or "").strip()
        self.expires = (env.get("QUERCUS_TOKEN_EXPIRES") or "").strip()
        self.http = http
        self.today = today
        if not self.token:
            raise RuntimeError("QUERCUS_TOKEN is not set")

    def _get(self, path: str, **params):
        r = self.http.get(f"{BASE}{path}", params=params, timeout=30, allow_redirects=False,
                          headers={"Authorization": f"Bearer {self.token}"})
        if r.status_code == 401:
            raise AuthExpired("Quercus 토큰이 만료되었거나 잘못됐어요 - 새로 발급해서 secrets/school.env의 QUERCUS_TOKEN을 바꿔 주세요")
        r.raise_for_status()
        return r.json()

    def days_left(self) -> int | None:
        if not self.expires:
            return None
        return (date.fromisoformat(self.expires) - self.today()).days

    def _expiry_items(self) -> list[Item]:
        left = self.days_left()
        if left is None:
            return []
        if left < 0:
            raise AuthExpired(f"Quercus 토큰이 {self.expires}에 만료됐어요 - 새 토큰(최대 30일)을 발급해 주세요")
        if left <= RENEW_WARN_DAYS:
            return [Item("quercus", f"token-expiry:{self.expires}:{left}", "auth_warning",
                         f"Quercus 토큰이 {left}일 뒤({self.expires}) 만료돼요 - 갱신해 주세요",
                         "https://q.utoronto.ca/profile/settings", self.today().isoformat(),
                         "Quercus → Account → Settings → + New Access Token (최대 30일) → secrets/school.env의 "
                         "QUERCUS_TOKEN과 QUERCUS_TOKEN_EXPIRES 교체 → school 서비스 재시작")]
        return []

    def fetch(self, state: dict) -> list[Item]:
        items = self._expiry_items()
        courses = {c["id"]: c.get("course_code") or c.get("name", "")
                   for c in self._get("/courses", enrollment_state="active", per_page=100) if "id" in c}
        for a in self._get("/users/self/activity_stream", per_page=100):
            course = courses.get(a.get("course_id"), "")
            kind = KIND.get(a.get("type", ""), str(a.get("type", "other")).lower())
            title = a.get("title") or ""
            extra: dict = {"type": a.get("type")}
            if a.get("type") == "Submission":
                asg = a.get("assignment") or {}
                if a.get("score") is None:
                    kind, title = "submission", f"Submitted: {asg.get('name', title)}"
                else:
                    title = f"Graded: {asg.get('name', title)} - {a.get('score')}/{asg.get('points_possible')}"
                    extra.update(score=a.get("score"), points_possible=asg.get("points_possible"))
            # updated_at in the id: edits, new replies and regrades come again
            items.append(Item("quercus", f"stream:{a['id']}:{a.get('updated_at')}", kind, title,
                              a.get("html_url", ""), a.get("updated_at", ""), html_text(a.get("message")) or title,
                              course, extra))
        for t in self._get("/users/self/todo", per_page=100):
            asg = t.get("assignment") or t.get("quiz") or {}
            due = asg.get("due_at") or ""
            name = asg.get("name") or asg.get("title") or "?"
            body = html_text(asg.get("description")) or name
            items.append(Item("quercus", f"todo:{asg.get('id')}:{due}", "assignment", f"Due {due[:10]}: {name}",
                              asg.get("html_url", ""), due, body, t.get("context_name", ""),
                              {"due": due, "points_possible": asg.get("points_possible")}))
        return items

    def check(self) -> str:
        me = self._get("/users/self")
        courses = self._get("/courses", enrollment_state="active", per_page=100)
        left = self.days_left()
        exp = f", token {left} days left" if left is not None else ", QUERCUS_TOKEN_EXPIRES not set"
        return f"OK - {me.get('name')}, {len(courses)} active courses{exp}"
