"""Personal AI OS plugin for Hermes.

- Tool `personal_ai_task`: delegate coding work to the Claude/Codex workers and
  report on it. Runs in the Hermes process and talks to the hermes-broker over
  HTTP; no shell, no files, no credential in Hermes.
- Hook `pre_tool_call`: blocks tool calls that would bypass the controller or
  touch credentials (see guard.py).

Mounted read-only from the repository (services/hermes-integration/plugins).
"""

from __future__ import annotations

import json
import logging
import os
import sys
import types
from pathlib import Path
from typing import Any

try:  # loaded as a package by Hermes
    from . import controller_client as client_lib
    from . import guard
except ImportError:  # loaded as a plain module (tests)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import controller_client as client_lib  # type: ignore[no-redef]
    import guard  # type: ignore[no-redef]

logger = logging.getLogger("personal_ai_controller")

TOOL_NAME = "personal_ai_task"
ACTIONS = ("submit", "status", "result", "wait", "list", "cancel", "projects", "system_status", "review")

SCHEMA: dict[str, Any] = {
    "name": TOOL_NAME,
    "description": (
        "Delegate coding work (create/change code or files in a registered project) to the Claude Code or Codex "
        "worker, and check on delegated tasks. This is the ONLY way to get code written: Hermes does not code "
        "itself. Actions: submit (queue a task; needs agent, project_id, instruction), status / result / wait / "
        "cancel (need task_id), list (recent tasks), projects (registered projects), system_status (are workers "
        "online), review (the diff and approval state of a completed task; read-only - approving or rejecting is only possible for the administrator, never for Hermes). When a result has a userReport, show it to the user as is (it holds only controller facts: Task ID, "
        "result, changed files, branch, commit, duration); you may add one short sentence. Never claim tests passed. "
        "cancel may return cancel_requested, which is NOT stopped yet: check status again before saying it stopped."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": list(ACTIONS)},
            "agent": {"type": "string", "enum": list(client_lib.AGENTS),
                      "description": "submit: the worker. Use the one the user named; default claude."},
            "project_id": {"type": "string", "description": "submit: a registered project id (see action=projects)."},
            "instruction": {"type": "string", "description": "submit: self-contained task description for the worker."},
            "new": {"type": "boolean", "description": "submit: true only if the user explicitly wants an identical "
                                                      "request run again within a few minutes."},
            "task_id": {"type": "string", "description": "status/result/wait/cancel: the task UUID."},
            "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": client_lib.MAX_WAIT_SECONDS,
                                "description": "wait: how long to wait for completion (default 150)."},
            "status": {"type": "string", "enum": list(client_lib.STATUSES), "description": "list: filter by status."},
            "list_agent": {"type": "string", "enum": list(client_lib.AGENTS), "description": "list: filter by agent."},
            "limit": {"type": "integer", "minimum": 1, "maximum": 50, "description": "list: number of tasks (default 10)."},
        },
        "required": ["action"],
        "additionalProperties": False,
    },
}


def _namespace(args: dict[str, Any]) -> types.SimpleNamespace:
    return types.SimpleNamespace(
        agent=args.get("agent", "claude"),
        project=args.get("project_id"),
        instruction=args.get("instruction") if args.get("instruction") is not None else "",
        instruction_file=None,
        new=bool(args.get("new", False)),
        keep_file=True,
        task_id=str(args.get("task_id") or ""),
        timeout=int(args.get("timeout_seconds") or 150),
        status=args.get("status"),
        limit=int(args.get("limit") or 10),
        # list uses `agent` for its filter; keep submit's agent separate
        list_agent=args.get("list_agent"),
    )


def run_tool(args: dict[str, Any], env: dict[str, str] | None = None, client_factory=client_lib.Client) -> dict[str, Any]:
    """Executes one tool call and returns the JSON-able result (never raises)."""
    action = (args or {}).get("action")
    if action not in ACTIONS:
        return {"ok": False, "error": {"code": "usage_error", "message": f"action must be one of {', '.join(ACTIONS)}"}}
    command = "system-status" if action == "system_status" else action
    ns = _namespace(args or {})
    if command == "list":
        ns.agent = ns.list_agent
    try:
        config = client_lib.Config(env if env is not None else dict(os.environ))
        handler = client_lib.COMMANDS[command]
        return handler(client_factory(config), config, ns)
    except client_lib.CliError as err:
        error: dict[str, Any] = {"code": err.code, "message": err.message}
        if err.http_status is not None:
            error["httpStatus"] = err.http_status
        return {"ok": False, "error": error}
    except Exception as err:  # noqa: BLE001 - report, never crash the agent loop
        logger.warning("personal_ai_task %s failed: %s", action, type(err).__name__)
        return {"ok": False, "error": {"code": "server_error", "message": f"Unexpected error ({type(err).__name__})"}}


def handle_personal_ai_task(args: dict[str, Any], **_: Any) -> str:
    result = run_tool(args)
    logger.info("personal_ai_task action=%s ok=%s", (args or {}).get("action"), result.get("ok"))
    return json.dumps(result, ensure_ascii=False)


def register(ctx) -> None:
    ctx.register_tool(
        name=TOOL_NAME,
        toolset="personal_ai",
        schema=SCHEMA,
        handler=handle_personal_ai_task,
        description="Delegate coding tasks to the Personal AI workers",
        emoji="🛠️",
    )
    ctx.register_hook("pre_tool_call", guard.pre_tool_call)
