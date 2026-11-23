"""The owner's mail preferences: per sender rules and defaults. Fixed code decides; no model involved.

Rule actions (set by the owner through Kelly, kept with history):
  important    - always right away, with a summary and a ping
  notify_only  - only "it arrived" (sender + subject) in the next digest, no summary (newsletters the owner reads himself)
  ignore       - nothing at all: not notified, not stored (ads)
  private      - right away, sender + subject only: the text is never sent to an AI provider and the
                 knowledge store keeps only the subject (bank, health, anything sensitive)
  normal       - back to the defaults below

Defaults when no rule matches:
  UofT mail (outlook): every mail right away with a summary; a ping when subject/body look urgent.
  Personal Gmail: Gmail "Promotions" tab -> ignore; "Social"/"Updates"/"Forums" tab or mailing-list
  headers -> notify_only; everything else (Primary) -> right away with a summary, ping when urgent.
"""
from __future__ import annotations

import re

ACTIONS = ("important", "notify_only", "ignore", "private", "normal")
ADDRESS = re.compile(r"^[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}$")
DOMAIN = re.compile(r"^@?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$")

# routes (store/notification paths) for each action
ROUTE = {"important": "now", "notify_only": "notice", "ignore": "ignored", "private": "private"}


class RuleError(ValueError):
    pass


def normalize_match(raw: str) -> str:
    """'Name <a@b.com>' / 'a@b.com' -> 'a@b.com'; '@b.com' / 'b.com' -> '@b.com'."""
    value = (raw or "").strip().lower()
    m = re.search(r"<([^>]+)>", value)
    if m:
        value = m.group(1).strip()
    if ADDRESS.match(value):
        return value
    if DOMAIN.match(value):
        return value if value.startswith("@") else f"@{value}"
    raise RuleError("match must be an email address (name@example.com) or a domain (@example.com)")


def find_rule(rules: list[dict], sender: str) -> dict | None:
    """Exact address first, then the most specific domain (sub.example.com before example.com)."""
    sender = (sender or "").lower()
    by_match = {r["match"]: r for r in rules}
    if sender in by_match:
        return by_match[sender]
    domain = sender.split("@", 1)[1] if "@" in sender else ""
    parts = domain.split(".")
    for i in range(len(parts) - 1):
        hit = by_match.get("@" + ".".join(parts[i:]))
        if hit:
            return hit
    return None


def default_action(service: str, extra: dict) -> str | None:
    """Default for personal mail by Gmail tab / list headers (None = normal handling)."""
    if service != "gmail":
        return None
    category = extra.get("category", "primary")
    if category == "promotions":
        return "ignore"
    if category in ("social", "updates", "forums") or extra.get("bulk"):
        return "notify_only"
    return None
