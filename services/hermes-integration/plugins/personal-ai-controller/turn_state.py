"""What happened in the current turn, per Hermes session (2026-11-26).

A turn is one incoming message (the owner's, or a cron prompt) and every model call and tool call that answers it.
Hermes gives every hook of one turn the same `turn_id` (agent/turn_context.py `_bind_turn_identity`), and
`pre_llm_call` carries the message text (`user_message`).

Used by
- guard.py: "taint". Once a turn has read text written by other people (school services, mail, attached
  documents, web pages, raw records, worker output), personal_ai_* calls that change something are blocked
  for the rest of that turn: a prompt injection in that text could otherwise make Kelly change the owner's
  schedule, knowledge or tasks. The owner's next message starts a new, clean turn.
- change_summary.py: the code-made footer listing what really changed in this turn.

State is in memory only (a restart starts clean turns, which is the safe direction: no taint is needed for a turn
that has not read anything yet). Bounded: the newest MAX_SESSIONS sessions are kept.
"""

from __future__ import annotations

import json
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any

MAX_SESSIONS = 200
MAX_EVENTS = 50

# Actions that change nothing, per Personal AI tool. Everything else (and every action of a personal_ai_* tool
# not listed here) counts as a write. Add a new read-only action here when a tool gains one.
READ_ONLY_ACTIONS: dict[str, frozenset[str]] = {
    # agenda / pace: read-only views added by the planner work of 2026-11-26 (todo_schedule and report write).
    "personal_ai_planner": frozenset({"day", "week", "agenda", "pace", "todo_list", "calendars", "reference_search",
                                      "proposal_list", "proposal_show", "status", "changes"}),
    "personal_ai_school": frozenset({"updates", "read", "status", "check_now", "settings", "deadlines"}),
    "personal_ai_document": frozenset({"list", "find", "read"}),
    # media_submit only transcribes / OCRs an attachment the owner sent; it changes none of the owner's records.
    "personal_ai_knowledge": frozenset({"search", "page", "pages", "timeline", "profile", "raw", "raw_list", "review",
                                        "changes", "media_submit"}),
    "personal_ai_task": frozenset({"status", "result", "wait", "list", "projects", "system_status", "review",
                                   "defaults"}),
    "personal_ai_worker_login": frozenset({"status"}),
    "personal_ai_learning": frozenset({"query"}),
}

# Calls whose result carries text written by someone other than the owner or Kelly.
UNTRUSTED_ACTIONS: dict[str, frozenset[str]] = {
    "personal_ai_school": frozenset({"updates", "read", "check_now", "deadlines"}),   # Quercus, Piazza, mail
    "personal_ai_document": frozenset({"find", "read"}),                               # attached files
    "personal_ai_knowledge": frozenset({"raw", "raw_list", "media_submit"}),           # raw imports, transcripts
    "personal_ai_task": frozenset({"result", "wait", "review"}),                       # worker output, diffs
    "personal_ai_planner": frozenset({"reference_search"}),                            # old calendars (invites)
}
# Hermes tools (toolsets.py in the Hermes image): web, x_search, vision, connections, browser_*; MCP tools
# (mcp__<server>__<tool>) bring outside services' text too.
UNTRUSTED_TOOLS = frozenset({"web_search", "web_extract", "x_search", "vision_analyze", "manage_connections"})
UNTRUSTED_PREFIXES = ("browser_", "mcp_")

TIMESTAMP_PREFIX = re.compile(r"^\s*\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^\]]{0,60}\]\s*")


def action_of(args: Any) -> str:
    return str(args.get("action") or "") if isinstance(args, dict) else ""


def is_personal_ai(tool_name: str) -> bool:
    return isinstance(tool_name, str) and tool_name.startswith("personal_ai_")


# Hermes's built-in memo tool. Its writes are not Personal AI changes (no guard), but the footer lists them so a
# "기억해 뒀어" that only reached MEMORY.md / USER.md is visible as not being in the knowledge store (2026-11-26).
MEMORY_TOOL = "memory"
MEMORY_WRITES = frozenset({"add", "patch", "remove"})


def is_memory_write(tool_name: str, args: Any) -> bool:
    return tool_name == MEMORY_TOOL and action_of(args) in MEMORY_WRITES


def is_write(tool_name: str, args: Any) -> bool:
    """A personal_ai_* call that changes something. Unknown tools and actions count as writes."""
    if not is_personal_ai(tool_name):
        return False
    return action_of(args) not in READ_ONLY_ACTIONS.get(tool_name, frozenset())


def untrusted_source(tool_name: str, args: Any) -> str | None:
    """A short label when this call returns outside text, else None."""
    if not isinstance(tool_name, str) or not tool_name:
        return None
    if tool_name in UNTRUSTED_TOOLS or tool_name.startswith(UNTRUSTED_PREFIXES):
        return tool_name
    action = action_of(args)
    if action in UNTRUSTED_ACTIONS.get(tool_name, frozenset()):
        return f"{tool_name.removeprefix('personal_ai_')}.{action}"
    return None


def untrusted_result(tool_name: str, args: Any, result: Any) -> str | None:
    """Outside text that only the result shows: a knowledge search that returned raw records."""
    if tool_name != "personal_ai_knowledge" or action_of(args) != "search":
        return None
    data = parse_result(result)
    hits = data.get("results") if isinstance(data, dict) else None
    if isinstance(hits, list) and any(isinstance(h, dict) and h.get("kind") == "raw" for h in hits):
        return "knowledge.search(raw)"
    return None


def parse_result(result: Any) -> Any:
    if isinstance(result, (dict, list)):
        return result
    if isinstance(result, (bytes, bytearray)):
        result = result.decode("utf-8", "replace")
    if isinstance(result, str):
        try:
            return json.loads(result)
        except ValueError:
            return None
    return None


def succeeded(result: Any) -> bool:
    data = parse_result(result)
    # Personal AI tools answer {"ok": true}; Hermes's memory tool answers {"success": true}.
    return isinstance(data, dict) and (data.get("ok") is True or data.get("success") is True)


def failure_kind(result: Any) -> str:
    """"confirmation" when the tool only asked for the owner's OK (nothing written), else "failed"."""
    data = parse_result(result)
    error = data.get("error") if isinstance(data, dict) else None
    return "confirmation" if isinstance(error, dict) and error.get("code") == "needs_confirmation" else "failed"


def message_text(message: Any) -> str:
    """The text of a user message (plain or multimodal parts), without the gateway's timestamp prefix."""
    if isinstance(message, list):
        parts = []
        for part in message:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"])
            elif isinstance(part, str):
                parts.append(part)
        message = " ".join(parts)
    if not isinstance(message, str):
        return ""
    return TIMESTAMP_PREFIX.sub("", message, count=1).strip()


def snippet(text: str, limit: int = 40) -> str:
    flat = " ".join((text or "").split())
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


@dataclass
class Turn:
    turn_id: str
    owner_message: str | None = None          # None: pre_llm_call was not seen for this turn
    tainted_by: list[str] = field(default_factory=list)
    writes: list[tuple[str, dict[str, Any]]] = field(default_factory=list)      # succeeded
    not_applied: list[tuple[str, dict[str, Any], str]] = field(default_factory=list)  # blocked / failed
    touched: float = field(default_factory=time.time)


class TurnLedger:
    """Turns are kept per (session, turn_id), a few per session, so a turn that runs in the same session at the
    same time (a background review, a cron prompt) can never clear another turn's record. A call without a
    turn_id uses the session's newest turn."""

    TURNS_PER_SESSION = 8

    def __init__(self, max_sessions: int = MAX_SESSIONS):
        self.max_sessions = max_sessions
        self._turns: dict[str, dict[str, Turn]] = {}
        self._lock = threading.Lock()

    def _find(self, session_id: str, turn_id: str) -> Turn | None:
        turns = self._turns.get(session_id) if session_id else None
        if not turns:
            return None
        if turn_id:
            return turns.get(turn_id)
        return max(turns.values(), key=lambda t: t.touched)

    def _turn(self, session_id: str, turn_id: str) -> Turn | None:
        """This turn's record, created when new. Caller holds the lock."""
        if not session_id:
            return None
        turn = self._find(session_id, turn_id)
        if turn is None:
            turns = self._turns.setdefault(session_id, {})
            turn = turns[turn_id] = Turn(turn_id=turn_id)
            if len(turns) > self.TURNS_PER_SESSION:
                for key, _ in sorted(turns.items(), key=lambda kv: kv[1].touched)[: len(turns) - self.TURNS_PER_SESSION]:
                    turns.pop(key, None)
            if len(self._turns) > self.max_sessions:
                newest = {sid: max(t.touched for t in ts.values()) if ts else 0.0 for sid, ts in self._turns.items()}
                for sid in sorted(newest, key=newest.get)[: len(self._turns) - self.max_sessions]:
                    if sid != session_id:
                        self._turns.pop(sid, None)
        turn.touched = time.time()
        return turn

    def start_turn(self, session_id: str, turn_id: str, user_message: Any) -> None:
        if not session_id:
            return
        with self._lock:
            if turn_id and session_id in self._turns:
                self._turns[session_id].pop(turn_id, None)
            turn = self._turn(session_id, turn_id)
            if turn is not None:
                turn.owner_message = message_text(user_message)

    def owner_message(self, session_id: str, turn_id: str) -> str | None:
        with self._lock:
            turn = self._find(session_id, turn_id)
            return turn.owner_message if turn is not None else None

    def taint(self, session_id: str, turn_id: str, source: str) -> None:
        with self._lock:
            turn = self._turn(session_id, turn_id)
            if turn is not None and source not in turn.tainted_by and len(turn.tainted_by) < MAX_EVENTS:
                turn.tainted_by.append(source)

    def tainted_by(self, session_id: str, turn_id: str) -> list[str]:
        with self._lock:
            turn = self._find(session_id, turn_id)
            return list(turn.tainted_by) if turn is not None else []

    def record_result(self, session_id: str, turn_id: str, tool_name: str, args: Any, ok: bool,
                      why: str = "failed") -> None:
        with self._lock:
            turn = self._turn(session_id, turn_id)
            if turn is None:
                return
            entry_args = dict(args) if isinstance(args, dict) else {}
            if ok and len(turn.writes) < MAX_EVENTS:
                turn.writes.append((tool_name, entry_args))
            elif not ok and len(turn.not_applied) < MAX_EVENTS:
                turn.not_applied.append((tool_name, entry_args, why))

    def record_blocked(self, session_id: str, turn_id: str, tool_name: str, args: Any, why: str) -> None:
        with self._lock:
            turn = self._turn(session_id, turn_id)
            if turn is not None and len(turn.not_applied) < MAX_EVENTS:
                turn.not_applied.append((tool_name, dict(args) if isinstance(args, dict) else {}, why))

    def summary(self, session_id: str, turn_id: str) -> tuple[list[tuple[str, dict[str, Any]]], list[tuple[str, dict[str, Any], str]]]:
        with self._lock:
            turn = self._find(session_id, turn_id)
            if turn is None:
                return [], []
            return list(turn.writes), list(turn.not_applied)


LEDGER = TurnLedger()
