"""Personal AI OS knowledge store as Hermes's memory provider (memory.provider: personal-ai-knowledge).

- sync_turn: every completed chat turn is kept as a raw original (and every attached document,
  with its extracted text), through hermes-broker. Deterministic code, no LLM involved.
- prefetch: before each reply, a few short lines the store clearly knows about the message
  (pages, facts, activities). Empty when nothing matches.
- system_prompt_block: how to use the store, plus the owner's profile and page index.
- Tool personal_ai_knowledge: fixed, validated actions (knowledge_client.py).

Credentials (password, key, token, webhook) are redacted before anything is stored.
Mounted read-only from the repository (services/hermes-integration/plugins).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:  # Hermes
    from agent.memory_provider import MemoryProvider, RecallStatus, is_trivial_prompt, spawn_context_thread
except ImportError:  # tests outside the Hermes image
    from abc import ABC

    class MemoryProvider(ABC):  # type: ignore[no-redef]
        pass

    class RecallStatus:  # type: ignore[no-redef]
        def __init__(self, provider_label: str, count: int, glyph: str = "🧠"):
            self.provider_label, self.count, self.glyph = provider_label, count, glyph

    def is_trivial_prompt(text):  # type: ignore[no-redef]
        return not (text or "").strip()

    def spawn_context_thread(target, *, name, daemon=True, args=(), kwargs=None):  # type: ignore[no-redef]
        return threading.Thread(target=target, args=args, kwargs=kwargs, name=name, daemon=daemon)

try:
    from . import knowledge_client as kc
except ImportError:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import knowledge_client as kc  # type: ignore[no-redef]

logger = logging.getLogger("personal_ai_knowledge")

NAME = "personal-ai-knowledge"
RECALL_TIMEOUT = 3.0
# "[The user sent a document: 'x.pdf'. It is saved at: /opt/data/cache/documents/..../doc_..._x.pdf." (Hermes gateway)
DOCUMENT_PATH = re.compile(r"saved at:?\s+(/opt/data/cache/documents/[^\s\]]+?)(?=[.,;\]]?(?:\s|$))")

RULES = (
    "# Knowledge store (Personal AI OS)\n"
    "Everything known about the owner lives in the knowledge store; every chat turn and attachment is kept "
    "there automatically. Lines under 'Known about the owner' are recalled from it for the current message. "
    "Use the personal_ai_knowledge tool: search before saying you don't know; when the owner tells you something "
    "lasting about themselves (courses, goals, habits, people, preferences, plans that changed), store it as a fact "
    "on the right page (create the page if needed) and tell them in one line; when they report what they did, add "
    "an activity. Correct outdated facts with fact_change instead of adding contradictions. Never store passwords, "
    "keys or tokens. Schedules and todos belong to personal_ai_planner, not here."
)


def _secret_file_readable(env: dict[str, str]) -> bool:
    path = env.get("PERSONAL_AI_BROKER_KEY_FILE")
    return not path or os.access(path, os.R_OK)


class KnowledgeProvider(MemoryProvider):
    def __init__(self, env: dict[str, str] | None = None, client: kc.Client | None = None):
        self._env = env
        self._client = client
        self._session_id = ""
        self._platform = "chat"
        self._primary = True
        self._profile = ""
        self._last_count = 0
        self._lock = threading.Lock()

    # -- identity / availability --

    @property
    def name(self) -> str:
        return NAME

    def _environ(self) -> dict[str, str]:
        return self._env if self._env is not None else dict(os.environ)

    def is_available(self) -> bool:
        env = self._environ()
        return bool(env.get("PERSONAL_AI_BROKER_URL")) and _secret_file_readable(env)

    def unavailable_reason(self) -> str:
        return "PERSONAL_AI_BROKER_URL and a readable PERSONAL_AI_BROKER_KEY_FILE are required"

    def initialize(self, session_id: str, **kwargs) -> None:
        self._session_id = session_id or ""
        self._platform = str(kwargs.get("platform") or "chat")[:20]
        self._primary = kwargs.get("agent_context", "primary") == "primary"
        if self._client is None:
            self._client = kc.Client(self._environ())
        try:
            profile = self._client.call("GET", "/profile", {"compact": "1"}, timeout=RECALL_TIMEOUT)
            parts = []
            if profile.get("text"):
                parts.append("About the owner:\n" + profile["text"])
            if profile.get("pages"):
                parts.append("Pages in the store: " + profile["pages"])
            self._profile = "\n".join(parts)
        except kc.KnowledgeError as err:
            logger.warning("knowledge profile unavailable: %s", err.code)
            self._profile = ""

    # -- prompt and recall --

    def system_prompt_block(self) -> str:
        return RULES + (f"\n\n{self._profile}" if self._profile else "")

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        self._last_count = 0
        if not self._client or is_trivial_prompt(query):
            return ""
        try:
            result = self._client.call("GET", "/recall", {"q": query[:2000]}, timeout=RECALL_TIMEOUT)
        except kc.KnowledgeError as err:
            logger.info("knowledge recall skipped: %s", err.code)
            return ""
        text = str(result.get("text") or "").strip()
        if not text:
            return ""
        self._last_count = int(result.get("count") or 0)
        return "## Known about the owner (knowledge store; check with personal_ai_knowledge if it matters)\n" + text

    def recall_status(self):
        return RecallStatus("knowledge", self._last_count) if self._last_count else None

    # -- capture --

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "",
                  messages: list[dict[str, Any]] | None = None, turn_author: dict[str, Any] | None = None) -> None:
        if not self._client or not self._primary or not (user_content or "").strip():
            return
        sid = session_id or self._session_id
        author = (turn_author or {}).get("name") if isinstance(turn_author, dict) else None
        spawn_context_thread(self._store_turn, args=(user_content, assistant_content or "", sid, author),
                             name="personal-ai-knowledge-sync").start()

    def _store_turn(self, user_content: str, assistant_content: str, session_id: str, author: str | None) -> None:
        now = datetime.now(timezone.utc)
        text = kc.redact(f"owner: {user_content}\n\nkelly: {assistant_content}")
        digest = hashlib.sha256("\0".join([session_id, user_content, assistant_content]).encode("utf-8")).hexdigest()[:40]
        body = {
            "source": "chat",
            "kind": f"{re.sub(r'[^a-z0-9]', '', self._platform.lower()) or 'chat'}-turn",
            "text": text,
            "occurredAt": now.isoformat(),
            "externalId": f"turn:{digest}",
            "meta": {"sessionId": session_id[:120], "platform": self._platform, **({"author": str(author)[:80]} if author else {})},
        }
        try:
            self._client.call("POST", "/raw", body=body, timeout=30)
        except kc.KnowledgeError as err:
            logger.warning("knowledge: chat turn not stored: %s", err.code)
        for path in dict.fromkeys(DOCUMENT_PATH.findall(user_content)):
            self._store_document(Path(path).name)

    def _store_document(self, file_name: str) -> None:
        try:
            document_client = _document_client()
            doc = document_client.extract(file_name, self._environ())
            body = {"file": doc["file"], "text": kc.redact(doc["text"]), "contentType": doc["contentType"], "pageCount": doc["count"]}
        except Exception as err:  # noqa: BLE001 - keep the original even when the text cannot be extracted
            logger.info("knowledge: no text for %s (%s)", file_name, type(err).__name__)
            body = {"file": file_name, "text": ""}
        try:
            self._client.call("POST", "/raw/document", body=body, timeout=60)
        except kc.KnowledgeError as err:
            logger.warning("knowledge: document not stored: %s", err.code)

    # -- tool --

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        return [kc.SCHEMA]

    def handle_tool_call(self, tool_name: str, args: dict[str, Any], **kwargs) -> str:
        if tool_name != kc.TOOL_NAME:
            return json.dumps({"ok": False, "error": {"code": "usage_error", "message": f"unknown tool {tool_name}"}})
        try:
            result = kc.run_tool(args or {}, client=self._client) if self._client else kc.run_tool(args or {}, self._environ())
        except Exception as err:  # noqa: BLE001 - never crash the agent loop
            logger.warning("%s failed: %s", kc.TOOL_NAME, type(err).__name__)
            result = {"ok": False, "error": {"code": "server_error", "message": f"Unexpected error ({type(err).__name__})"}}
        logger.info("%s action=%s ok=%s", kc.TOOL_NAME, (args or {}).get("action"), result.get("ok"))
        return json.dumps(result, ensure_ascii=False)


def _document_client():
    """document_client.py from the sibling personal-ai-controller plugin (same repository, read-only)."""
    sibling = Path(__file__).resolve().parent.parent / "personal-ai-controller"
    if str(sibling) not in sys.path:
        sys.path.append(str(sibling))
    import document_client  # type: ignore[import-not-found]

    return document_client


def register(ctx) -> None:
    ctx.register_memory_provider(KnowledgeProvider())
