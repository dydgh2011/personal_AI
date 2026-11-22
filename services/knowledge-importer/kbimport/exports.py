"""ChatGPT and Claude data exports: one raw item per conversation (and per project document).

ChatGPT: conversations.json = [{id|conversation_id, title, create_time, update_time, mapping: {node: {message, parent}}, current_node}]
Claude:  conversations.json = [{uuid, name, created_at, updated_at, chat_messages: [{sender, text, content, created_at, attachments}]}]
         projects.json      = [{uuid, name, description, prompt_template, docs: [{filename, content, created_at}]}]
Other JSON files in an export (users, memories, ...) are kept as text items as they are.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Iterator

MAX_TEXT_CHARS = 5_000_000


def _iso(value: Any) -> str | None:
    if value in (None, ""):
        return None
    try:
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(float(value), tz=timezone.utc).isoformat()
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc).isoformat()
    except (ValueError, OSError, OverflowError):
        return None


def _stamp(iso: str | None) -> str:
    return f"[{iso[:16].replace('T', ' ')}] " if iso else ""


def detect(conversations: Any) -> str | None:
    if not isinstance(conversations, list) or not conversations:
        return None
    first = conversations[0]
    if isinstance(first, dict) and "mapping" in first:
        return "chatgpt"
    if isinstance(first, dict) and "chat_messages" in first:
        return "claude"
    return None


def _chatgpt_text(message: dict[str, Any]) -> str:
    content = message.get("content") or {}
    parts = content.get("parts") or []
    texts = [p for p in parts if isinstance(p, str)]
    if not texts and isinstance(content.get("text"), str):
        texts = [content["text"]]
    return "\n".join(t for t in texts if t.strip())


def chatgpt_items(conversations: list[dict[str, Any]]) -> Iterator[dict[str, Any]]:
    for conv in conversations:
        cid = str(conv.get("conversation_id") or conv.get("id") or "")
        mapping = conv.get("mapping") or {}
        # The branch the owner ended on: from current_node back to the root.
        chain = []
        node_id = conv.get("current_node")
        seen = set()
        while node_id and node_id in mapping and node_id not in seen:
            seen.add(node_id)
            chain.append(mapping[node_id])
            node_id = mapping[node_id].get("parent")
        lines = []
        count = 0
        for node in reversed(chain):
            message = node.get("message") or {}
            role = (message.get("author") or {}).get("role")
            if role not in ("user", "assistant"):
                continue
            text = _chatgpt_text(message)
            if not text:
                continue
            count += 1
            lines.append(f"{_stamp(_iso(message.get('create_time')))}{'owner' if role == 'user' else 'chatgpt'}: {text}")
        if not lines or not cid:
            continue
        updated = _iso(conv.get("update_time")) or ""
        yield _item("chatgpt-conversation", f"chatgpt:{cid}:{updated[:19]}", conv.get("title") or "ChatGPT conversation",
                    "\n\n".join(lines), _iso(conv.get("create_time")), {"conversationId": cid, "messages": count, "updatedAt": updated})


def _claude_text(message: dict[str, Any]) -> str:
    text = message.get("text") or ""
    if not text.strip():
        blocks = message.get("content") or []
        text = "\n".join(b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text")
    attachments = [a.get("extracted_content") for a in message.get("attachments") or [] if isinstance(a, dict) and a.get("extracted_content")]
    if attachments:
        text += "\n(attachment) " + "\n(attachment) ".join(attachments)
    return text.strip()


def claude_items(conversations: list[dict[str, Any]]) -> Iterator[dict[str, Any]]:
    for conv in conversations:
        cid = str(conv.get("uuid") or "")
        lines = []
        for message in conv.get("chat_messages") or []:
            text = _claude_text(message)
            if not text:
                continue
            who = "owner" if message.get("sender") == "human" else "claude"
            lines.append(f"{_stamp(_iso(message.get('created_at')))}{who}: {text}")
        if not lines or not cid:
            continue
        updated = _iso(conv.get("updated_at")) or ""
        yield _item("claude-conversation", f"claude:{cid}:{updated[:19]}", conv.get("name") or "Claude conversation",
                    "\n\n".join(lines), _iso(conv.get("created_at")), {"conversationId": cid, "messages": len(lines), "updatedAt": updated})


def claude_project_items(projects: Any) -> Iterator[dict[str, Any]]:
    if not isinstance(projects, list):
        return
    for project in projects:
        pid = str(project.get("uuid") or "")
        name = project.get("name") or "Claude project"
        about = "\n".join(x for x in (project.get("description"), project.get("prompt_template")) if x)
        if pid and about.strip():
            yield _item("claude-project", f"claude-project:{pid}", name, about, _iso(project.get("created_at")), {"projectId": pid})
        for doc in project.get("docs") or []:
            did = str(doc.get("uuid") or doc.get("filename") or "")
            if did and (doc.get("content") or "").strip():
                yield _item("claude-project-doc", f"claude-project-doc:{pid}:{did}"[:200], f"{name} / {doc.get('filename') or 'document'}",
                            doc["content"], _iso(doc.get("created_at")), {"projectId": pid})


def _item(kind: str, external_id: str, title: str, text: str, occurred: str | None, meta: dict[str, Any]) -> dict[str, Any]:
    truncated = len(text) > MAX_TEXT_CHARS
    safe_id = "".join(ch if ch.isalnum() or ch in "._:-" else "-" for ch in external_id)[:200]
    item = {"source": "import", "kind": kind, "externalId": safe_id, "title": str(title)[:200],
            "text": text[:MAX_TEXT_CHARS], "meta": {**meta, **({"truncated": True} if truncated else {})}}
    if occurred:
        item["occurredAt"] = occurred
    return item


def export_items(files: dict[str, bytes]) -> tuple[str | None, list[dict[str, Any]]]:
    """(export kind, raw items) for the JSON files of one export ({name: bytes}); (None, []) if not an export."""
    conversations_name = next((n for n in files if n.split("/")[-1] == "conversations.json"), None)
    if conversations_name is None:
        return None, []
    conversations = json.loads(files[conversations_name].decode("utf-8-sig"))
    which = detect(conversations)
    if which is None:
        return None, []
    items = list(chatgpt_items(conversations) if which == "chatgpt" else claude_items(conversations))
    if which == "claude":
        projects_name = next((n for n in files if n.split("/")[-1] == "projects.json"), None)
        if projects_name:
            items += list(claude_project_items(json.loads(files[projects_name].decode("utf-8-sig"))))
    for name, data in files.items():
        base = name.split("/")[-1]
        if base in ("conversations.json", "projects.json") or not base.endswith(".json"):
            continue
        text = data.decode("utf-8-sig", errors="replace")
        if text.strip() in ("", "[]", "{}"):
            continue
        items.append(_item(f"{which}-export-file", f"{which}-file:{base}:{len(data)}", f"{which} export / {base}", text, None, {"file": base}))
    return which, items
