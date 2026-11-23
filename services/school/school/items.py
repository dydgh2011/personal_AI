from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from html import unescape


class AuthExpired(Exception):
    """A token / password / session is no longer valid: the owner has to act."""


@dataclass
class Item:
    service: str          # quercus | piazza | outlook | course_site
    id: str               # stable per version (an edit or a new answer gives a new id)
    kind: str             # announcement | grade | submission | assignment | message | discussion | notification
                          # | post | email | page_change | auth_warning
    title: str
    url: str = ""
    date: str = ""        # ISO 8601 when known
    body: str = ""        # full plain text (the knowledge store keeps it)
    course: str = ""
    extra: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


_TAG = re.compile(r"<(br|/p|/div|/li|/h\d|/tr)\b[^>]*>", re.I)


def html_text(html: str | None, limit: int = 200_000) -> str:
    """HTML -> readable plain text (line breaks kept), without any third-party parser."""
    if not html:
        return ""
    text = _TAG.sub("\n", html)
    text = re.sub(r"<li\b[^>]*>", "\n- ", text, flags=re.I)
    text = re.sub(r"<(script|style)\b.*?</\1>", " ", text, flags=re.I | re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    text = unescape(text)
    lines = [" ".join(line.split()) for line in text.splitlines()]
    out = "\n".join(line for line in lines if line)
    return out[:limit]
