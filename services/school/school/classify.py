"""Where each item goes. Fixed rules, no model involved.
  now      right away, summary, ping           mail     right away, summary, no ping
  private  right away, sender+subject only     notice   next digest, "it arrived" only (newsletters)
  digest   next digest with a preview          quiet    knowledge store only
  ignored  nothing (ads)
Mail follows the owner's rules first (school/mailrules.py)."""
from __future__ import annotations

import re

from .items import Item
from .mailrules import ROUTE, default_action, find_rule

URGENT_WORDS = re.compile(
    r"(midterm|final exam|\bexam\b|\btest\b|\bquiz\b|deadline|\bdue\b|extension|extended|cancel|postpone|"
    r"room change|location|make-?up|regrade|remark|marks? (are |is )?(released|available|posted)|"
    r"시험|마감|연장|취소|휴강|변경|재채점)",
    re.I,
)
# In a mail body ordinary words ("due to", "test") are common, so the body check is stricter.
URGENT_BODY = re.compile(
    r"(midterm|final exam|\bexams?\b|\bquiz(zes)?\b|deadline|due (date|on|by)|extension|cancell?ed|postponed?|"
    r"room change|make-?up (test|exam|quiz)|regrade|remark request|"
    r"시험|마감|연장|취소|휴강|장소 변경|재채점)",
    re.I,
)
# Notification mail that duplicates what the APIs already give.
DUPLICATE_SENDERS = ("instructure.com", "piazza.com")
CROWDMARK = "crowdmark"


def classify(item: Item, rules: list[dict] | None = None) -> str:
    k = item.kind
    text = f"{item.title}\n{item.body[:2000]}"
    if k in ("auth_warning", "grade", "announcement", "message"):
        return "now"
    if k == "submission":
        return "quiet"
    if k == "post":
        if item.extra.get("instructor") or item.extra.get("pinned"):
            return "now"
        return "now" if URGENT_WORDS.search(item.title) else "digest"
    if k == "email":
        sender = str(item.extra.get("from", ""))
        rule = find_rule(rules or [], sender)
        if rule and rule["action"] != "normal":
            return ROUTE[rule["action"]]  # the owner's own rule wins over everything below
        if CROWDMARK in sender:
            return "now"  # marks returned: the owner downloads the PDF and gives it to Kelly
        if any(sender.endswith(d) or f"@{d}" in sender or f".{d}" in sender for d in DUPLICATE_SENDERS):
            return "quiet"
        default = default_action(item.service, item.extra)
        if default:
            return ROUTE[default]
        # Every remaining mail goes out right away with a summary; urgent ones (subject or body) also ping.
        urgent = URGENT_WORDS.search(item.title) or URGENT_BODY.search(item.body[:5000])
        return "now" if urgent else "mail"
    if k == "page_change":
        if item.extra.get("first"):
            return "quiet"
        return "now" if URGENT_WORDS.search(text) else "digest"
    return "digest"
