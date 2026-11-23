from __future__ import annotations

import requests

from .course_site import CourseSites
from .mail import Mail
from .piazza import Piazza
from .quercus import Quercus

USER_AGENT = "personal-ai-school/1.0 (personal use, read-only)"
NAMES = ("quercus", "piazza", "outlook", "course_site")


def build(names: list[str], env: dict[str, str]) -> dict[str, object]:
    """Connectors for the enabled services. A missing credential disables only that service."""
    http = requests.Session()
    http.headers["User-Agent"] = USER_AGENT
    makers = {
        "quercus": lambda: Quercus(env, http),
        "piazza": lambda: Piazza(env),
        "outlook": lambda: Mail(env),
        "course_site": lambda: CourseSites(env, http),
    }
    out: dict[str, object] = {}
    for name in names:
        if name not in makers:
            raise RuntimeError(f"unknown school service {name!r}; choose from {NAMES}")
        out[name] = makers[name]()
    return out
