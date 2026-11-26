"""pre_tool_call guard for the Personal AI OS.

Enforced in the Hermes process, so it does not depend on the model following
SOUL.md or SKILL.md. It is defence in depth: the primary controls are that
Hermes holds no controller credential (the hermes-broker does) and that the
terminal / code-execution / file / delegation toolsets are disabled for the
chat platforms. If someone re-enables those toolsets, this guard still blocks
the paths that would bypass the controller or touch credentials.

Pattern matching on commands cannot stop a determined obfuscator; it stops the
behaviour actually observed (running `docker`, `claude`, installing CLIs,
reading token files) and accidental policy violations.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

logger = logging.getLogger("personal_ai.guard")

POLICY = "Coding work must be delegated with the personal_ai_task tool (Claude/Codex workers via the task controller)."

# Tools that hand work to another agent outside the controller.
_DELEGATION_TOOLS = {"delegate_task"}
# Tools that run commands or code inside the Hermes container.
_EXEC_TOOLS = {"terminal", "execute_code", "process_manage"}
# Tools that write or read files directly.
_FILE_TOOLS = {"write_file", "patch", "read_file", "search_files"}

_DENY_COMMANDS = re.compile(
    r"""(?ix)
    (?:^|[\s;&|`'"(/$])(?:claude|codex|opencode|aider|cursor-agent|gemini-cli|docker|podman|nerdctl|kubectl|crictl)(?=$|[\s;&|`'")])
    | \b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\b[^\n]*\s-g\b
    | \b(?:npm|pnpm)\s+(?:i|install)\s+(?:-g|--global)\b
    | \bpip3?\s+install\b
    | \bgit\s+(?:push|clone|remote|fetch|pull|config\s+--global)\b
    | /run/secrets | controller_token | hermes-controller\.token | CONTROLLER_[A-Z_]*TOKEN
    | /var/run/docker\.sock | docker\.sock
    | \bcontroller:3000\b
    """
)

# Paths that hold credentials or the Personal AI integration itself.
_PROTECTED_READ = re.compile(r"(?i)/run/secrets|/opt/data/\.env\b|(?:^|/)auth\.json\b|controller_token|hermes-controller\.token")
_PROTECTED_WRITE = re.compile(
    r"(?i)/run/secrets|/opt/data/plugins|/opt/personal-ai|/opt/data/config\.yaml|/opt/data/SOUL\.md|/opt/data/\.env\b"
    r"|/opt/data/skills/[^\"]*personal-ai"
)
_PROTECTED_SKILL = re.compile(r"(?i)personal[-_ ]?ai")
# What the browser tools must never reach: local files and the internal Docker services.
_INTERNAL_TARGETS = re.compile(
    r"(?i)file:|/run/secrets|/opt/data"
    r"|://(?:[^/\s\"@]*@)?(?:hermes-broker|controller|claude-worker|codex-worker|hermes|learning|localhost|"
    r"127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|\[?::1\]?)"
    r"(?::\d+)?(?:[/\"?#]|$)"
)


def _text(args: Any) -> str:
    try:
        return json.dumps(args, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(args)


def check(tool_name: str, args: Any) -> str | None:
    """Returns a block message, or None to let the call proceed."""
    text = _text(args)
    if tool_name in _DELEGATION_TOOLS:
        return f"BLOCKED by Personal AI policy: {tool_name} is not used here. {POLICY}"
    if tool_name in _EXEC_TOOLS and _DENY_COMMANDS.search(text):
        return ("BLOCKED by Personal AI policy: this command would run coding agents, containers, package installs, "
                f"git remotes or touch credentials from Hermes. {POLICY}")
    if tool_name in _FILE_TOOLS:
        if tool_name in ("write_file", "patch") and _PROTECTED_WRITE.search(text):
            return "BLOCKED by Personal AI policy: this path is managed by the operator and is read-only for Hermes."
        if _PROTECTED_READ.search(text):
            return "BLOCKED by Personal AI policy: credential files are not readable by Hermes."
    if tool_name.startswith("browser") and _INTERNAL_TARGETS.search(text):
        return ("BLOCKED by Personal AI policy: the browser may not open local files or internal services "
                f"(broker, controller, workers, learning). {POLICY}")
    if tool_name == "skill_manage" and _PROTECTED_SKILL.search(text):
        return ("BLOCKED by Personal AI policy: skills named after the Personal AI controller are provided read-only by "
                "the operator and cannot be created, replaced or shadowed.")
    return None


class ConfirmationGate:
    """confirmed_by_user=true is accepted only after the owner could answer (2026-11-25).

    Kelly once set confirmed_by_user=true on her own reading of "넣어줘" and called an action the owner never
    saw. Now a call with confirmed_by_user=true passes only when the same call (same tool and arguments, without
    confirmed_by_user / replace) was made earlier in this session *in an earlier turn* - the call that returned the
    change to show - and the owner's message started a new turn since. A turn is one owner message. Each preview
    can be used once, for at most `ttl` seconds. The model still has to show the change; this makes sure it
    cannot skip the owner's answer.
    """

    IGNORED = ("confirmed_by_user", "replace")

    def __init__(self, ttl: float = 6 * 3600, clock=None, max_entries: int = 1000):
        import time
        self.ttl = ttl
        self.clock = clock or time.time
        self.max_entries = max_entries
        self.previews: dict[tuple[str, str], tuple[str, float]] = {}

    def _key(self, tool_name: str, args: dict[str, Any]) -> str:
        import hashlib
        rest = {k: v for k, v in args.items() if k not in self.IGNORED}
        return hashlib.sha256((tool_name + "\0" + json.dumps(rest, sort_keys=True, ensure_ascii=False, default=str)).encode()).hexdigest()

    def check(self, tool_name: str, args: Any, session_id: str, turn_id: str) -> str | None:
        if not tool_name.startswith("personal_ai_") or not isinstance(args, dict) or not session_id or not turn_id:
            return None
        now = self.clock()
        if len(self.previews) > self.max_entries:
            self.previews = {k: v for k, v in self.previews.items() if now - v[1] < self.ttl}
        key = (session_id, self._key(tool_name, args))
        if args.get("confirmed_by_user") is not True:
            self.previews[key] = (turn_id, now)
            return None
        seen = self.previews.get(key)
        if seen and seen[0] != turn_id and now - seen[1] < self.ttl:
            del self.previews[key]
            logger.info("confirmation accepted tool=%s action=%s", tool_name, args.get("action"))
            return None
        reason = "it was shown in this same turn" if seen else "this exact change was not shown to the owner first"
        logger.info("confirmation blocked tool=%s action=%s (%s)", tool_name, args.get("action"), reason)
        return ("BLOCKED: confirmed_by_user=true needs the owner's answer, and " + reason + ". Call it again WITHOUT "
                "confirmed_by_user to get the exact change, show it to the owner, ask, and end your turn. Only after "
                "the owner replies, call again with the same arguments and confirmed_by_user=true. Do not say it is done.")


GATE = ConfirmationGate()


def pre_tool_call(tool_name: str = "", args: Any = None, session_id: str = "", turn_id: str = "", **_: Any) -> dict[str, str] | None:
    """Hermes hook. Never raises: Hermes treats a raising pre_tool_call hook as a block."""
    try:
        message = check(tool_name, args) or GATE.check(tool_name, args, session_id, turn_id)
    except Exception:  # noqa: BLE001 - a guard bug must not break unrelated tools
        logger.warning("guard error for %s", tool_name, exc_info=True)
        return None
    return {"action": "block", "message": message} if message else None
