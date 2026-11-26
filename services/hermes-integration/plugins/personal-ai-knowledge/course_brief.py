"""Course brief and answer check: code, not the model, decides what goes in and what must come out.

1. brief(): when the owner's message names a course or topic page (title or alias, spaces ignored),
   the page and its linked topic facts (one hop, read-only) are attached to the message as a
   "course record" block, so the model does not have to decide to open the page.
2. check(): after the model answers, facts the question asked about (weak points, grading, exam
   dates, where to practise) whose numbers are mostly missing from the answer are appended
   verbatim under a fixed heading. The text comes from the store, not from a model.

Standard library only. State between the two steps is kept per session id (module level, because
Hermes may build more than one provider object).
"""

from __future__ import annotations

import re
import threading
import time
from typing import Any

try:
    from . import knowledge_client as kc
except ImportError:  # loaded by path in tests
    import knowledge_client as kc  # type: ignore[no-redef]

INDEX_TTL = 600            # seconds between page-index refreshes
MAX_PAGES = 2              # pages per message
BRIEF_MAX_CHARS = 6000     # whole block
APPEND_MAX = 6             # facts appended to one answer
COVERED = 0.5              # share of a fact's numbers that must appear in the answer
PENDING_TTL = 900          # a brief older than this is not checked

HEADING = "📌 저장소 기록 (답에서 빠진 내용을 코드가 붙임)"

# What the owner asked about -> which facts must show up in the answer: (question pattern, fact kinds,
# word rule). A typed fact counts by its kind; an untyped one (stored before kinds) by the word rule.
# The owner asks in Korean or English; facts are stored in English since 2026-11-26 and older ones are
# Korean, so every pattern carries both.
INTENTS = {
    "weak": (re.compile(r"약점|약한|약해|틀린|틀렸|실수|부족|못하|weak|mistakes?|wrong|lost\s+(?:points?|marks?)|"
                        r"struggl|bad\s+at|not\s+good\s+at", re.I), ("mistake", "score"), None),   # rule: _weak_words
    "grading": (re.compile(r"비중|배점|성적|grading|grade\s*(?:breakdown|scheme|split)|weight|worth|marking\s*scheme|"
                           r"how\s+much\s+(?:is|are|does)\b.*\b(?:count|worth)", re.I), ("grading",),
                re.compile(r"배점|비중|grading|weight(?:s|ing)?\b|\bworth\b|marking\s*scheme|\d+\s*%\s*(?:each|of\s+the)", re.I)),
    "exam": (re.compile(r"기말|중간|시험\s*(날짜|일정|언제)|final|midterm|exam\s*(?:date|time|schedule|room)|"
                        r"when\s+is\s+(?:the|my)\s+\w*\s*(?:exam|test)", re.I), ("exam",),
             re.compile(r"\b\d{2}:\d{2}\s*[–-]\s*\d{2}:\d{2}")),   # 09:00–12:00, not 2.1:10
    "practice": (re.compile(r"연습|문제는?\s*어디|어디서\s*풀|교재|exercise|practi[cs]e|problem\s*sets?|past\s*(?:exams?|papers?)|"
                            r"textbook|where\s+(?:can|do|should)\s+i\s+(?:practi|study|find)", re.I), ("resource",),
                 re.compile(r"연습문제|Exercise|\d+\s*문제|\b\d+\s*(?:problems|questions)\b|problem\s*sets?|past\s*(?:exams?|papers?)|"
                            r"practice\s*(?:problems|questions|exams?)", re.I)),
}
TOTAL_SCORE = re.compile(r"\d+(?:\.\d+)?/\d+(?:\.\d+)?\s*\(\d+(?:\.\d+)?%")
# "Exercise 109개", "63문제", "109 exercises", "63 problems": the total of a list
HEADLINE_COUNT = re.compile(r"(?<![\d.])(\d{2,})\s*(?:개|문제|exercises\b|problems\b|questions\b)", re.I)
DATE = re.compile(r"\b\d{4}-\d{2}-\d{2}\b|(?<=\()\d{1,2}/\d{1,2}(?=[\s)])")   # 2026-10-15, (11/05), (12/03 목)
PAGE_REF = re.compile(r"\bp\d+(?:[–-]\d*)?")
HANGUL = re.compile(r"[가-힣]")   # two-letter Korean names (선대) are specific enough; two-letter Latin ones are not
NUMBER = re.compile(r"(?<![A-Za-z\d.])\d+(?:\.\d+)?(?:/\d+(?:\.\d+)?)?%?")   # not codes like MAT223, Q2

_lock = threading.Lock()
_index: dict[str, Any] = {"at": 0.0, "pages": []}
_pending: dict[str, dict[str, Any]] = {}


def _squash(text: str) -> str:
    return re.sub(r"\s+", "", text or "").lower()


def _numbers(text: str) -> list[str]:
    """Numbers that identify a fact: scores (47/50, 0/2.5), percents, counts. Dates, page refs and
    single digits (chapter numbers) are left out."""
    text = PAGE_REF.sub(" ", DATE.sub(" ", text))
    out = []
    for n in NUMBER.findall(text):
        if "/" in n or "%" in n or len(n.replace(".", "")) >= 2:
            if n not in out:
                out.append(n)
    return out


def _covered(fact: str, answer: str) -> bool:
    nums = _numbers(fact)
    if not nums:
        return True   # nothing countable to check
    flat = answer.replace(" ", "")
    for total in TOTAL_SCORE.findall(fact):   # a test's total score (47/50 (94%)) is never optional
        if total.split("(")[0].strip().replace(" ", "") not in flat:
            return False
    head = HEADLINE_COUNT.search(fact)             # nor is the first count of a list (109개, 63문제)
    if head and head.group(1) not in flat:
        return False
    hit = sum(1 for n in nums if n in flat)
    return hit / len(nums) >= COVERED


def _page_index(client) -> list[dict[str, Any]]:
    with _lock:
        if time.time() - _index["at"] < INDEX_TTL and _index["pages"]:
            return _index["pages"]
    pages = []
    for p in client.call("GET", "/pages", {}).get("pages", []):
        if p.get("type") not in ("course", "topic"):
            continue
        names = {_squash(p.get("title", ""))}
        # aliases: course codes and Korean names of English pages (MAT223H5, 선형대수, 고유값), so a Korean
        # question finds an English page. /pages lists them; an older service without them: one read per course.
        if isinstance(p.get("aliases"), list):
            names |= {_squash(str(a)) for a in p["aliases"]}
        elif p.get("type") == "course":
            try:
                full = client.call("GET", "/page", {"ref": p["slug"]})
                names |= {_squash(a) for a in (full.get("page") or {}).get("aliases") or []}
            except kc.KnowledgeError:
                pass
        pages.append({"slug": p["slug"], "title": p["title"], "type": p["type"],
                      "names": sorted(n for n in names if len(n) >= 3 or (len(n) == 2 and HANGUL.search(n)))})
    with _lock:
        _index.update(at=time.time(), pages=pages)
    return pages


def _matches(query: str, pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    q = _squash(query)
    hits = [p for p in pages if any(n in q for n in p["names"])]
    hits.sort(key=lambda p: (p["type"] != "course", -max(len(n) for n in p["names"])))
    return hits[:MAX_PAGES]


def _render(result: dict[str, Any]) -> str:
    page = result.get("page") or {}
    lines = [f"### {page.get('title')} ({page.get('type')})"]
    if page.get("summary"):
        lines.append(f"Summary: {page['summary']}")
    for f in result.get("facts") or []:
        lines.append(f"- {f.get('text')}")
    for group in result.get("linkedFacts") or []:
        for f in group.get("facts") or []:
            lines.append(f"- [{group.get('page')}] {f.get('text')}")
    return "\n".join(lines)


def brief(client, query: str, session_id: str = "") -> str:
    """The course-record block for this message ('' when it names no course or topic)."""
    if not query or not query.strip():
        return ""
    hits = _matches(query, _page_index(client))
    if not hits:
        _pending.pop(session_id or "", None)
        return ""
    blocks, facts = [], []
    for hit in hits:
        try:
            result = kc.run(client, {"action": "page", "page": hit["slug"]})
        except kc.KnowledgeError:
            continue
        blocks.append(_render(result))
        title = (result.get("page") or {}).get("title")
        facts += [(title, f) for f in result.get("facts") or []]
        facts += [(g.get("page"), f) for g in result.get("linkedFacts") or [] for f in g.get("facts") or []]
        facts += [(m.get("page"), m) for m in result.get("recordedMistakes") or []]
    if not blocks:
        return ""
    required = _required(query, facts)
    with _lock:
        _pending[session_id or ""] = {"at": time.time(), "required": required}
    text = "\n\n".join(blocks)
    if len(text) > BRIEF_MAX_CHARS:
        text = text[:BRIEF_MAX_CHARS].rsplit("\n", 1)[0] + "\n…"
    return ("## Course record (knowledge store, attached by code because the message names it; complete, "
            "use its specifics - scores, question numbers, mistakes, book names, counts)\n" + text)


def _weak_words(text: str) -> bool:
    """Untyped facts: a mistake (same rule as recordedMistakes) or a test's total score."""
    return bool(kc.MISTAKE.search(text)) or bool(TOTAL_SCORE.search(text))


def _required(query: str, facts: list[tuple[str, dict[str, Any]]]) -> list[tuple[str, str]]:
    """(page, text) of the facts the question asks about; facts are (page, {"text", "kind"?})."""
    out: list[tuple[str, str]] = []
    for name, (ask, kinds, words) in INTENTS.items():
        if not ask.search(query):
            continue
        for page, fact in facts:
            text = str(fact.get("text") or "")
            keep = kc.fact_is(fact, kinds, _weak_words if name == "weak" else words)
            if keep and (page, text) not in out:
                out.append((page, text))
    return out


def check(response_text: str, session_id: str = "") -> str | None:
    """Answer plus the asked-about facts it left out, or None to keep the answer as is."""
    with _lock:
        pending = _pending.pop(session_id or "", None)
    if not pending or not response_text or time.time() - pending["at"] > PENDING_TTL:
        return None
    missing = [(p, t) for p, t in pending["required"] if not _covered(t, response_text)]
    if not missing:
        return None
    lines = [f"- [{p}] {t if len(t) <= 300 else t[:299] + '…'}" for p, t in missing[:APPEND_MAX]]
    return response_text.rstrip() + "\n\n" + HEADING + "\n" + "\n".join(lines)
