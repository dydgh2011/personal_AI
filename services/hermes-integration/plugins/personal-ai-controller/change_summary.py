"""Code-made footer: what really changed in this turn (2026-11-26).

Kelly once answered "반영했어" without calling any tool. The footer is built from the post_tool_call records of this
turn (turn_state.py), not from the model's text:
- every personal_ai_* change that succeeded is listed (tool, action, short subject);
- when the answer claims a change (반영했/추가했/넣었/…, added/updated/…) but nothing succeeded, a warning line;
- otherwise nothing is added.

Hermes hook `transform_llm_output` (agent/turn_finalizer.py `apply_llm_output_transform`): every registered
callback runs, then the FIRST one that returns a string wins and the rest are dropped. The knowledge plugin's
answer check (📌 저장소 기록) is such a callback too. So when this hook has a footer to add, it first runs the
transform callbacks registered after it on the answer (in Hermes's order) and appends its footer to their result;
the two notes then compose. The controller plugin is loaded at gateway start, the knowledge memory provider only
when the first agent is built (agent.log), so this hook comes first.
"""

from __future__ import annotations

import logging
import re
import sys
from pathlib import Path
from typing import Any, Callable

try:  # loaded as a package by Hermes
    from . import turn_state
except ImportError:  # loaded as a plain module (tests)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import turn_state  # type: ignore[no-redef]

logger = logging.getLogger("personal_ai.changes")

HOOK = "transform_llm_output"
MAX_LINES = 8
SUBJECT_MAX = 60

TOOL_LABEL = {
    "personal_ai_planner": "일정", "personal_ai_school": "학교", "personal_ai_knowledge": "저장소",
    "personal_ai_task": "작업", "personal_ai_worker_login": "로그인", "personal_ai_learning": "학습",
    # Hermes's built-in memo (MEMORY.md / USER.md): 2026-11-26 Kelly "remembered" an owner fact only there.
    "memory": "Hermes 내부 메모(지식 저장소 아님)",
}
# Argument fields that say what a change was about, in display order. Never codes, keys or long texts.
SUBJECT_FIELDS = ("title", "page", "date", "end_date", "start", "end", "dates", "todo_id", "event_id", "block_id",
                  "proposal", "item_numbers", "id", "status", "minutes", "estimate_minutes", "deadline", "agent",
                  "project_id", "rule", "match")

HEADER = "🧾 이번 답에서 실제로 바뀐 것 (코드 기록)"
NOTHING = "⚠️ 이번 답에서 실제로 바뀐 것은 없어요 (코드 확인: 성공한 변경 도구 호출 없음)"

# Claims of a change made now. Past-tense forms only; "안 넣었어" / "추가했던" (a past reference) do not count.
_CLAIM_KO = re.compile(
    r"(?<!안 )(?<!못 )(?<!안)(?<!못)"
    r"(?:반영|추가|변경|수정|삭제|저장|등록|확정|기록|적용|입력|예약)(?:했|하였|해\s?(?:뒀|두었|놨|놓았))(?!던)"
    r"|(?<!안 )(?<!못 )(?:넣었|넣어\s?(?:뒀|두었|놨|놓았)|바꿨|바꾸었|바꿔\s?(?:뒀|놨)|지웠|옮겼|잡아\s?(?:뒀|두었|놨|놓았)|잡았)(?!던)"
    r"|(?:반영|추가|변경|수정|삭제|저장|등록|확정|적용)\s?(?:완료|됐|되었)"
    r"|(?<!안 )(?<!못 )기억(?:했|해\s?(?:뒀|두었|놨|놓았))(?!던)"
)
_CLAIM_EN = re.compile(
    r"(?i)\b(?:i(?:'ve| have)\s+)?(?:added|updated|saved|deleted|removed|scheduled|changed|moved|booked|recorded|remembered|noted|"
    r"put\s+(?:it|them)\s+(?:in|on))\b(?!\s+(?:before|earlier|already))"
)
_NEGATED_EN = re.compile(r"(?i)\b(?:not|n't|never|no)\s+(?:\w+\s+){0,2}$")


def claims_change(text: str) -> bool:
    if not text:
        return False
    if _CLAIM_KO.search(text):
        return True
    for match in _CLAIM_EN.finditer(text):
        if not _NEGATED_EN.search(text[max(0, match.start() - 30):match.start()]):
            return True
    return False


def _value(value: Any) -> str:
    if isinstance(value, list):
        return ",".join(str(v) for v in value[:6]) + ("…" if len(value) > 6 else "")
    if isinstance(value, bool):
        return "예" if value else "아니오"
    return " ".join(str(value).split())


def subject(tool_name: str, args: dict[str, Any]) -> str:
    parts = []
    for name in SUBJECT_FIELDS:
        if name in args and args[name] not in (None, "", []):
            parts.append(_value(args[name]) + ("분" if name in ("minutes", "estimate_minutes") else ""))
    settings = args.get("settings")
    if isinstance(settings, dict) and settings:
        parts.append("설정 " + ",".join(sorted(str(k) for k in settings)[:6]))
    if tool_name in ("personal_ai_knowledge", "memory"):
        for name in ("text", "summary", "content"):
            if isinstance(args.get(name), str) and args[name].strip():
                parts.append(args[name])
                break
    text = " ".join(parts)
    return turn_state.snippet(text, SUBJECT_MAX) if text else ""


def footer(writes: list[tuple[str, dict[str, Any]]], not_applied: list[tuple[str, dict[str, Any], str]],
           answer: str) -> str:
    if writes:
        lines = [HEADER]
        for tool_name, args in writes[:MAX_LINES]:
            label = TOOL_LABEL.get(tool_name, tool_name.removeprefix("personal_ai_"))
            about = subject(tool_name, args)
            lines.append(f"- {label} {turn_state.action_of(args) or '?'}" + (f": {about}" if about else ""))
        if len(writes) > MAX_LINES:
            lines.append(f"- 외 {len(writes) - MAX_LINES}건")
        return "\n".join(lines)
    if claims_change(answer):
        held = len(not_applied)
        return NOTHING + (f" · 변경 시도 {held}건은 확인 대기 또는 실패" if held else "")
    return ""


def _is_this_hook(callback: Any) -> bool:
    func = getattr(callback, "__func__", callback)
    return func is transform_llm_output or (
        getattr(func, "__name__", "") == "transform_llm_output"
        and str(getattr(func, "__module__", "")).endswith("change_summary"))


def _later_transforms() -> tuple[list[Callable], Callable | None, bool]:
    """(callbacks registered after this hook, Hermes's kwargs-filtering invoker, this hook is first)."""
    try:
        from hermes_cli import plugins as hermes_plugins  # type: ignore[import-not-found]
        manager = hermes_plugins.get_plugin_manager()
        callbacks = list(getattr(manager, "_hooks", {}).get(HOOK, []))
    except Exception:  # noqa: BLE001 - outside Hermes (tests) or an API change: no chaining
        return [], None, True
    mine = [i for i, cb in enumerate(callbacks) if _is_this_hook(cb)]
    if not mine:
        return [], None, True
    invoker = getattr(type(manager), "_invoke_hook_callback", None)
    return [cb for cb in callbacks[mine[0] + 1:] if not _is_this_hook(cb)], invoker, mine[0] == 0


_warned_not_first = False


def _run_later_transforms(text: str, payload: dict[str, Any]) -> str:
    global _warned_not_first
    callbacks, invoker, first = _later_transforms()
    if not first and not _warned_not_first:
        _warned_not_first = True
        logger.warning("another %s hook runs before the change summary; its note can hide this footer", HOOK)
    for callback in callbacks:
        try:
            kwargs = {**payload, "response_text": text}
            out = invoker(callback, kwargs) if invoker else callback(**kwargs)
        except Exception as err:  # noqa: BLE001 - another plugin's note must never cost the reply
            logger.info("chained %s callback skipped: %s", HOOK, type(err).__name__)
            continue
        if isinstance(out, str) and out:
            text = out
    return text


def transform_llm_output(response_text: str = "", session_id: str = "", turn_id: str = "", **kwargs: Any) -> str | None:
    """Hermes hook. Returns the answer with the footer, or None to leave it alone. Never raises."""
    try:
        if not isinstance(response_text, str) or not response_text.strip():
            return None
        writes, not_applied = turn_state.LEDGER.summary(session_id or "", turn_id or "")
        note = footer(writes, not_applied, response_text)
        if not note:
            return None
        if writes:
            logger.info("change summary: %d change(s) in this turn", len(writes))
        else:
            logger.info("change summary: the answer claims a change but none succeeded (%d not applied)", len(not_applied))
        payload = {**kwargs, "session_id": session_id, "turn_id": turn_id}
        text = _run_later_transforms(response_text, payload)
        return text.rstrip() + "\n\n" + note
    except Exception:  # noqa: BLE001
        logger.warning("change summary failed", exc_info=True)
        return None
