"""Reads backfill files (JSON Lines, one item per line) made by the owner's one-time collection.
Format and id rules: docs/knowledge/SCHOOL_BACKFILL.md."""
from __future__ import annotations

import json
import re
from pathlib import Path

from .items import Item

SERVICES = ("quercus", "piazza", "outlook", "gmail", "course_site")
KIND = re.compile(r"^[a-z][a-z_]{1,29}$")
MAX_BODY = 2_000_000


class BackfillError(ValueError):
    pass


def parse_line(line: str, where: str) -> Item:
    try:
        o = json.loads(line)
    except json.JSONDecodeError as err:
        raise BackfillError(f"{where}: not JSON ({err.msg})") from None
    if not isinstance(o, dict):
        raise BackfillError(f"{where}: must be a JSON object")
    extra_keys = set(o) - {"service", "id", "kind", "title", "url", "date", "body", "course", "extra"}
    if extra_keys:
        raise BackfillError(f"{where}: unknown fields {sorted(extra_keys)}")
    if o.get("service") not in SERVICES:
        raise BackfillError(f"{where}: service must be one of {SERVICES}")
    for key, limit in (("id", 300), ("title", 300)):
        if not isinstance(o.get(key), str) or not 1 <= len(o[key]) <= limit:
            raise BackfillError(f"{where}: {key} must be text of 1-{limit} characters")
    if not isinstance(o.get("kind"), str) or not KIND.match(o["kind"]):
        raise BackfillError(f"{where}: kind must be lowercase letters/underscores (e.g. announcement, post, email)")
    for key in ("url", "date", "course"):
        if o.get(key) is not None and not isinstance(o[key], str):
            raise BackfillError(f"{where}: {key} must be text")
    body = o.get("body") or ""
    if not isinstance(body, str) or len(body) > MAX_BODY:
        raise BackfillError(f"{where}: body must be text up to {MAX_BODY} characters")
    extra = o.get("extra") or {}
    if not isinstance(extra, dict):
        raise BackfillError(f"{where}: extra must be an object")
    return Item(o["service"], o["id"], o["kind"], o["title"], o.get("url") or "", o.get("date") or "", body,
                o.get("course") or "", extra)


def read_dir(path: str) -> list[Item]:
    items: list[Item] = []
    files = sorted(Path(path).rglob("*.jsonl"))
    if not files:
        raise BackfillError(f"no .jsonl files under {path}")
    for f in files:
        with f.open(encoding="utf-8") as fh:
            for n, line in enumerate(fh, 1):
                if line.strip():
                    items.append(parse_line(line, f"{f.name}:{n}"))
    return items
