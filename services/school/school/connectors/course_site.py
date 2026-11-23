"""Public course websites (no login): remembers each page's text and reports the added lines.

Env: SCHOOL_COURSE_SITES = "CSC207|https://mcs.utm.utoronto.ca/~207/26f/|index,lectures,assignments,tests,resources"
     (several sites separated by ";"; page names get ".shtml" unless they contain a dot).
"""
from __future__ import annotations

import difflib
import hashlib

import requests
from bs4 import BeautifulSoup

from ..items import Item

ALLOWED_HOSTS = ("https://mcs.utm.utoronto.ca/",)


def parse_sites(raw: str) -> list[tuple[str, str, list[str]]]:
    sites = []
    for chunk in (raw or "").split(";"):
        if not chunk.strip():
            continue
        course, base, pages = (p.strip() for p in chunk.split("|"))
        if not base.startswith(ALLOWED_HOSTS):
            raise RuntimeError(f"course site {base} is not on an allowed host {ALLOWED_HOSTS}")
        base = base if base.endswith("/") else base + "/"
        sites.append((course, base, [p.strip() for p in pages.split(",") if p.strip()]))
    return sites


class CourseSites:
    name = "course_site"

    def __init__(self, env: dict[str, str], http: requests.Session):
        self.sites = parse_sites(env.get("SCHOOL_COURSE_SITES", ""))
        self.http = http

    def _page_text(self, url: str) -> str:
        r = self.http.get(url, timeout=20, allow_redirects=False)
        r.raise_for_status()
        soup = BeautifulSoup(r.text, "html.parser")
        for tag in soup(["script", "style"]):
            tag.decompose()
        lines = [" ".join(line.split()) for line in soup.get_text("\n").splitlines()]
        return "\n".join(line for line in lines if line)

    def fetch(self, state: dict) -> list[Item]:
        items = []
        snapshots = state.setdefault("snapshots", {})
        for course, base, pages in self.sites:
            for page in pages:
                url = f"{base}{page if '.' in page else page + '.shtml'}"
                text = self._page_text(url)
                digest = hashlib.sha256(text.encode()).hexdigest()[:16]
                old = snapshots.get(url)
                if old is None:
                    # first sight: keep the whole page as an original
                    items.append(Item("course_site", f"{course}:{page}:{digest}", "page_change", f"{course} '{page}' page",
                                      url, "", text, course, {"first": True}))
                elif old != text:
                    added = [line[1:] for line in difflib.unified_diff(old.splitlines(), text.splitlines(), lineterm="", n=0)
                             if line.startswith("+") and not line.startswith("+++")]
                    items.append(Item("course_site", f"{course}:{page}:{digest}", "page_change",
                                      f"{course} '{page}' page updated", url, "",
                                      "\n".join(added) or "(줄이 지워지기만 했어요)", course, {"added_lines": len(added)}))
                snapshots[url] = text
        return items

    def check(self) -> str:
        return "OK - " + ", ".join(f"{c} ({len(p)} pages)" for c, _, p in self.sites)
