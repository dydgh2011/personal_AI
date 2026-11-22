"""Minimal client for the knowledge service with the operator key (standard library only)."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any


class KnowledgeError(Exception):
    def __init__(self, code: str, message: str, status: int | None = None):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


class Client:
    def __init__(self, base_url: str, key_file: str):
        self.base = base_url.rstrip("/")
        with open(key_file, encoding="utf-8") as f:
            self.key = f.read().strip()

    def call(self, method: str, path: str, body: dict[str, Any] | None = None, timeout: float = 60) -> Any:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        headers = {"X-Knowledge-Key": self.key, "Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed internal URL
                return json.loads(response.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as err:
            try:
                payload = json.loads(err.read().decode("utf-8") or "{}")
            except ValueError:
                payload = {}
            finally:
                err.close()
            raise KnowledgeError(str(payload.get("code") or "http_error"), str(payload.get("message") or f"HTTP {err.code}"), err.code) from err
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            raise KnowledgeError("unavailable", f"knowledge service not reachable ({type(err).__name__})") from err
