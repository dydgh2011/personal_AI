"""python -m school                 run the service (poll loop + read API on 8095)
python -m school check           test each connection once and print the result (no storing, no notifying)
python -m school import <dir>    one-time backfill from .jsonl files (docs/knowledge/SCHOOL_BACKFILL.md)
"""
from __future__ import annotations

import json
import logging
import os
import signal
import sys
import threading

from . import connectors
from .clients import Knowledge, Llm, Notifier
from .service import School, serve
from .store import Store


def secret(path_var: str, default: str) -> str:
    path = os.environ.get(path_var) or default
    with open(path, encoding="utf-8") as f:
        value = f.read().strip()
    if not value:
        raise RuntimeError(f"{path} is empty")
    return value


def main() -> None:
    logging.basicConfig(level=logging.INFO, format='{"ts":"%(asctime)s","level":"%(levelname)s","msg":%(message)r}')
    env = dict(os.environ)
    names = [n.strip() for n in env.get("SCHOOL_SERVICES", ",".join(connectors.NAMES)).split(",") if n.strip()]
    built: dict[str, object] = {}
    broken: dict[str, str] = {}
    for name in names:
        try:
            built.update(connectors.build([name], env))
        except RuntimeError as err:
            broken[name] = str(err)
            logging.warning("%s disabled: %s", name, err)

    if len(sys.argv) > 1 and sys.argv[1] == "check":
        for name, conn in built.items():
            try:
                print(f"[{name}] {conn.check()}")
            except Exception as err:  # noqa: BLE001
                print(f"[{name}] FAIL - {type(err).__name__}: {err}")
        for name, reason in broken.items():
            print(f"[{name}] DISABLED - {reason}")
        return

    if len(sys.argv) > 1 and sys.argv[1] == "import":
        from .backfill import BackfillError, read_dir
        if len(sys.argv) < 3:
            sys.exit("usage: python -m school import <dir with .jsonl files>")
        try:
            items = read_dir(sys.argv[2])
        except BackfillError as err:
            sys.exit(f"backfill rejected (nothing stored): {err}")
        store = Store(env.get("SCHOOL_DB", "/var/lib/school/school.db"))
        school = School({}, {}, store,
                        Knowledge(env.get("KNOWLEDGE_URL", "http://knowledge:8092"), secret("KNOWLEDGE_KEY_FILE", "/run/secrets/knowledge_key")),
                        None, None)
        print(json.dumps({"files": sys.argv[2], "items": len(items), **school.import_items(items)}, ensure_ascii=False))
        store.close()
        return

    store = Store(env.get("SCHOOL_DB", "/var/lib/school/school.db"))
    school = School(
        built, broken, store,
        Knowledge(env.get("KNOWLEDGE_URL", "http://knowledge:8092"), secret("KNOWLEDGE_KEY_FILE", "/run/secrets/knowledge_key")),
        Notifier(env.get("NOTIFIER_URL", "http://notifier:8090"), secret("NOTIFIER_KEY_FILE", "/run/secrets/notifier_key")),
        Llm(env.get("LLM_URL", "http://llm-gateway:8094"), secret("LLM_KEY_FILE", "/run/secrets/llm_key")),
        tz=env.get("SCHOOL_TIME_ZONE", "America/Toronto"),
        poll_minutes=int(env.get("SCHOOL_POLL_MINUTES", "20")),
        digest_times=tuple(t.strip() for t in env.get("SCHOOL_DIGEST_TIMES", "12:00,20:00").split(",") if t.strip()),
    )
    clients = []
    for entry in (env.get("SCHOOL_CLIENTS") or "").split(","):
        if entry.strip():
            name, path = entry.strip().split("=", 1)
            with open(path, encoding="utf-8") as f:
                key = f.read().strip()
            if len(key) < 32:
                raise RuntimeError(f"the key for {name} must be at least 32 characters")
            clients.append((name, key))
    if not clients:
        raise RuntimeError("SCHOOL_CLIENTS must name at least one caller")
    server = serve(school, clients, int(env.get("PORT", "8095")))
    logging.info("school service up: services=%s disabled=%s callers=%s", list(built), list(broken), [c[0] for c in clients])

    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    school.run_forever(stop)
    server.shutdown()
    store.close()


if __name__ == "__main__":
    main()
