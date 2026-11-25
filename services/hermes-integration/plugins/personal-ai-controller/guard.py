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
import re
from typing import Any

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


def pre_tool_call(tool_name: str = "", args: Any = None, **_: Any) -> dict[str, str] | None:
    """Hermes hook. Never raises: Hermes treats a raising pre_tool_call hook as a block."""
    try:
        message = check(tool_name, args)
    except Exception:  # noqa: BLE001 - a guard bug must not break unrelated tools
        return None
    return {"action": "block", "message": message} if message else None
