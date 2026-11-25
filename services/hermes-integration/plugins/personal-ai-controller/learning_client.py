"""Query Learning records and request an owner-reviewed schedule proposal."""

from __future__ import annotations

import re
from datetime import date
from typing import Any
from urllib.parse import urlencode

try:
    from .controller_client import CliError
except ImportError:  # loaded as a plain module
    from controller_client import CliError


NAME = "personal_ai_learning"
QUERY_PATHS = {
    "domains": "/domains",
    "roadmaps": "/roadmaps",
    "roadmap": "/roadmaps/{roadmap_id}",
    "status": "/schedule/status",
    "schedule": "/schedule",
}
PERIODS = ("day", "week")
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
ISO_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
SCHEMA: dict[str, Any] = {
    "name": NAME,
    "description": (
        "Read the owner's Learning records and Toronto day/week study plan. Use propose only when the owner "
        "asks for a schedule draft with Learning assignments and reviews. The draft requires owner approval."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["query", "propose"]},
            "resource": {
                "type": "string", "enum": list(QUERY_PATHS),
                "description": "Required for query. Use roadmaps to find a roadmap_id.",
            },
            "roadmap_id": {"type": "string", "description": "Required for query resource=roadmap."},
            "date": {"type": "string", "description": "YYYY-MM-DD for schedule or propose. Defaults to today in Toronto."},
            "period": {"type": "string", "enum": list(PERIODS), "description": "Schedule or propose. Defaults to day."},
        },
        "required": ["action"],
        "additionalProperties": False,
    },
}


def request_for(args: Any) -> tuple[str, str, dict[str, str] | None, str]:
    """Map validated arguments to a fixed method, path and optional body."""
    if not isinstance(args, dict):
        raise CliError("usage_error", "Expected a Learning action")
    action = args.get("action")
    if action == "propose":
        _require_fields(args, {"action", "date", "period"})
        return "POST", "/learning/schedule/propose", _schedule_parameters(args), "schedule"
    if action != "query":
        raise CliError("usage_error", "action must be query or propose")

    resource = args.get("resource")
    if not isinstance(resource, str) or resource not in QUERY_PATHS:
        raise CliError("usage_error", "query requires resource: domains, roadmaps, roadmap, status or schedule")
    path = "/learning" + QUERY_PATHS[resource]
    fields = {"action", "resource"}
    if resource == "roadmap":
        _require_fields(args, fields | {"roadmap_id"})
        roadmap_id = args.get("roadmap_id")
        if not isinstance(roadmap_id, str) or not UUID.fullmatch(roadmap_id):
            raise CliError("usage_error", "roadmap_id must be an ID from the roadmaps query")
        path = path.format(roadmap_id=roadmap_id)
    elif resource == "schedule":
        _require_fields(args, fields | {"date", "period"})
        query = urlencode(_schedule_parameters(args))
        if query:
            path += "?" + query
    else:
        _require_fields(args, fields)
    return "GET", path, None, resource


def _require_fields(args: dict[str, Any], allowed: set[str]) -> None:
    if args.keys() - allowed:
        raise CliError("usage_error", "Unexpected arguments for this Learning action")


def _schedule_parameters(args: dict[str, Any]) -> dict[str, str]:
    params = {}
    if "date" in args:
        day = args["date"]
        if not isinstance(day, str) or not ISO_DATE.fullmatch(day):
            raise CliError("usage_error", "date must be a valid YYYY-MM-DD date")
        try:
            date.fromisoformat(day)
        except ValueError:
            raise CliError("usage_error", "date must be a valid YYYY-MM-DD date") from None
        params["date"] = day
    if "period" in args:
        period = args["period"]
        if period not in PERIODS:
            raise CliError("usage_error", "period must be day or week")
        params["period"] = period
    return params
