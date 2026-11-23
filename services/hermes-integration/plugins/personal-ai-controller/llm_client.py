"""Slash commands for the LLM gateway, handled by code (no model involved):

    /ai-paid on|off|status   allow paid AI (OpenAI Private nano) for the rest of today, or stop it
    /ai-usage                today's free quotas, paid spend, approval

They run even when every free quota is used up, which is exactly when the owner needs them.
The gateway key comes from LLM_GATEWAY_KEY (also Hermes' model key); the tools the model can call
have no way to reach /control/paid.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any

TIMEOUT = 10


def _call(method: str, path: str, body: dict[str, Any] | None = None, env: dict[str, str] | None = None) -> dict[str, Any]:
    env = env if env is not None else dict(os.environ)
    base = (env.get("LLM_GATEWAY_URL") or "http://llm-gateway:8094").rstrip("/")
    key = env.get("LLM_GATEWAY_KEY", "").strip()
    if not key:
        raise RuntimeError("LLM_GATEWAY_KEY is not set")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{base}{path}", data=data, method=method,
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:  # noqa: S310 (fixed internal URL)
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        try:
            detail = json.loads(err.read().decode("utf-8")).get("error", {}).get("message", "")
        finally:
            err.close()
        raise RuntimeError(f"gateway {err.code}: {detail}") from None


def _tokens(n: float) -> str:
    return f"{n / 1_000_000:.2f}M" if n >= 1_000_000 else f"{round(n / 1000)}K"


def usage_text(env: dict[str, str] | None = None) -> str:
    u = _call("GET", "/usage?days=1", env=env)
    lines = [f"**AI 사용량** ({u['localDay']})"]
    for p in u["pools"]:
        if p["tokensPerDay"]:
            used = f"{_tokens(p['tokens'])} / {_tokens(p['tokensPerDay'])} 토큰"
        else:
            used = f"{p['requests']} / {p['requestsPerDay']} 요청"
        stop = round(p["stopAt"] * 100)
        lines.append(f"- {p['label']}: {used} ({round(p['usedShare'] * 100)}%, {stop}%에서 멈춤)")
    paid = u["paid"]
    state = "허용됨 (오늘 자정까지)" if paid["approvedToday"] else "꺼짐"
    lines.append(f"- 유료: {state}, 오늘 ${paid['spentTodayUsd']:.4f} / 상한 ${paid['dailyCapUsd']:.2f}")
    lines.append(f"- 지금까지 유료 합계: ${u['totalSpentUsd']:.4f}")
    return "\n".join(lines)


def paid_command(raw_args: str, env: dict[str, str] | None = None) -> str:
    arg = (raw_args or "").strip().lower()
    if arg in ("", "status"):
        u = _call("GET", "/usage?days=1", env=env)
        p = u["paid"]
        return (f"유료 AI: {'허용됨 (오늘 자정까지)' if p['approvedToday'] else '꺼짐'} · "
                f"오늘 ${p['spentTodayUsd']:.4f} / 상한 ${p['dailyCapUsd']:.2f}\n"
                "허용: `/ai-paid on` · 끄기: `/ai-paid off`")
    if arg not in ("on", "off"):
        return "사용법: `/ai-paid on` (오늘만 유료 허용) · `/ai-paid off` · `/ai-paid status`"
    r = _call("POST", "/control/paid", {"enable": arg == "on"}, env=env)
    if r["approvedToday"]:
        return (f"✅ 오늘({r['localDay']}) 자정까지 유료 AI(OpenAI Private nano)를 허용했어요. "
                f"상한 ${r['dailyCapUsd']:.2f}, 지금까지 ${r['spentTodayUsd']:.4f}. 무료 한도가 남아 있으면 무료를 먼저 써요.")
    return "⏹️ 유료 AI를 껐어요. 무료 한도가 다 차면 Kelly는 쉬어요."


def handle_paid(raw_args: str = "", **_: Any) -> str:
    try:
        return paid_command(raw_args)
    except Exception as err:  # noqa: BLE001 - the owner sees the reason
        return f"게이트웨이에 연결하지 못했어요: {err}"


def handle_usage(raw_args: str = "", **_: Any) -> str:
    try:
        return usage_text()
    except Exception as err:  # noqa: BLE001
        return f"게이트웨이에 연결하지 못했어요: {err}"
