"""Bulk import into the knowledge store.

    python -m kbimport scan [SUBPATH] [--dry-run] [--limit N]

Walks the inbox (read-only), and for every file:
  1. sha256 of the content; already stored -> skipped (safe to run again, resumes where it stopped)
  2. copies the original into the blob folder as <sha256><ext> (write to a temp name, then rename)
  3. extracts text (extract.py; no LLM) and registers it: POST /raw/file
ZIP files are opened: each member is imported as its own file ("archive.zip!dir/file.pdf").
ChatGPT/Claude exports (a zip or folder with conversations.json) become one item per conversation,
and the export file itself is kept as an original.

Only the operator key can use these routes; the knowledge service re-checks size and hash.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import time
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

from . import exports
from .client import Client, KnowledgeError
from .extract import content_type, extract, kind_of

SKIP_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini", "__MACOSX", ".git", "node_modules", "__pycache__", ".venv", ".idea", ".vscode"}
MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024
MAX_MEMBER_BYTES = 1024 * 1024 * 1024
MAX_EXTRACT_BYTES = 512 * 1024 * 1024
STREAM_KINDS = {"image", "audio", "video", "other"}


class Importer:
    def __init__(self, client: Client, inbox: Path, blobs: Path, dry_run: bool = False, out=sys.stdout):
        self.client, self.inbox, self.blobs, self.dry_run, self.out = client, inbox, blobs, dry_run, out
        self.totals = {"files": 0, "stored": 0, "skipped": 0, "conversations": 0, "pending": 0, "failed": 0, "bytes": 0}

    def report(self, **fields: Any) -> None:
        self.out.write(json.dumps(fields, ensure_ascii=False) + "\n")
        self.out.flush()

    # -- walking --

    def scan(self, sub: str = "", limit: int | None = None) -> dict[str, int]:
        root = (self.inbox / sub).resolve()
        if not str(root).startswith(str(self.inbox.resolve())):
            raise SystemExit("SUBPATH must stay inside the inbox")
        paths = [root] if root.is_file() else sorted(self._walk(root))
        for path in paths:
            if limit is not None and self.totals["files"] >= limit:
                break
            rel = path.relative_to(self.inbox.resolve()).as_posix()
            if path.suffix.lower() == ".zip":
                self.import_zip(path, rel)
            elif path.name == "conversations.json":
                self.import_export_folder(path.parent, rel)
            else:
                self.import_bytes_from_file(path, rel)
        return self.totals

    def _walk(self, root: Path):
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            dirnames[:] = [d for d in dirnames if d not in SKIP_NAMES and not d.startswith(".")]
            for name in filenames:
                if name in SKIP_NAMES or name.startswith("~$") or name.startswith("."):
                    continue
                path = Path(dirpath) / name
                if path.is_symlink() or not path.is_file():
                    continue
                yield path

    # -- one file --

    def import_bytes_from_file(self, path: Path, rel: str) -> None:
        size = path.stat().st_size
        if size > MAX_FILE_BYTES:
            self.totals["files"] += 1
            self.totals["failed"] += 1
            self.report(path=rel, status="failed", reason="larger than 4 GB")
            return
        if size <= MAX_EXTRACT_BYTES and kind_of(path.name) not in STREAM_KINDS:
            self.import_bytes(path.read_bytes(), rel, path.name, path.stat().st_mtime)
            return
        # Large or media files: hash and copy in chunks, no text now (OCR/transcription later).
        self.totals["files"] += 1
        digest = hashlib.sha256()
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(8 * 1024 * 1024), b""):
                digest.update(chunk)
        sha = digest.hexdigest()
        if self._already(sha, rel):
            return
        kind = kind_of(path.name)
        status = "pending:transcription" if kind in ("audio", "video") else "pending:ocr" if kind == "image" else "empty"
        self._register(sha, size, rel, path.name, path.stat().st_mtime, kind, content_type(path.name), "", None, status, source=path)

    def import_bytes(self, data: bytes, rel: str, name: str, mtime: float | None) -> str | None:
        self.totals["files"] += 1
        sha = hashlib.sha256(data).hexdigest()
        existing = self._already(sha, rel)
        if existing:
            return existing
        kind, ctype, text, pages, status = extract(name, data)
        return self._register(sha, len(data), rel, name, mtime, kind, ctype, text, pages, status, data=data)

    def _already(self, sha: str, rel: str) -> str | None:
        try:
            existing = self.client.call("GET", f"/raw/by-sha/{sha}")
        except KnowledgeError as err:
            if err.status != 404:
                raise
            return None
        self.totals["skipped"] += 1
        self.report(path=rel, status="skipped", reason="already stored", id=existing.get("id"))
        return existing.get("id") or "stored"

    def _register(self, sha: str, size: int, rel: str, name: str, mtime: float | None, kind: str, ctype: str, text: str,
                  pages: int | None, status: str, data: bytes | None = None, source: Path | None = None) -> str | None:
        ext = PurePosixPath(name.lower()).suffix
        ext = ext if ext and len(ext) <= 11 and ext[1:].isalnum() else ""
        blob = f"{sha}{ext}"
        if self.dry_run:
            self.report(path=rel, status="would-store", kind=kind, chars=len(text), extract=status)
            return None
        target = self.blobs / blob
        if not target.exists():
            tmp = self.blobs / f".{blob}.{os.getpid()}.tmp"
            if data is not None:
                tmp.write_bytes(data)
            else:
                shutil.copyfile(source, tmp)
            os.replace(tmp, target)
        body: dict[str, Any] = {"sha256": sha, "blob": blob, "size": size, "title": name[:300], "path": rel[:1000],
                                "kind": kind, "contentType": ctype, "text": text, "meta": {"extract": status}}
        if pages is not None:
            body["pageCount"] = pages
        if mtime:
            body["occurredAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(mtime))
        result = self.client.call("POST", "/raw/file", body=body, timeout=900)
        self.totals["stored"] += 1
        self.totals["bytes"] += size
        if status.startswith("pending"):
            self.totals["pending"] += 1
        if status.startswith("failed"):
            self.totals["failed"] += 1
        self.report(path=rel, status="stored", kind=kind, chars=len(text), extract=status, id=result.get("id"))
        return result.get("id")

    # -- archives and exports --

    def import_zip(self, path: Path, rel: str) -> None:
        try:
            archive = zipfile.ZipFile(path)
        except zipfile.BadZipFile:
            self.import_bytes_from_file(path, rel)
            return
        with archive:
            members = [i for i in archive.infolist() if not i.is_dir()
                       and not any(part in SKIP_NAMES or part.startswith(".") for part in PurePosixPath(i.filename).parts)]
            json_files = {i.filename: i for i in members if i.filename.endswith(".json")}
            if any(n.split("/")[-1] == "conversations.json" for n in json_files):
                files = {n: archive.read(i) for n, i in json_files.items() if i.file_size <= MAX_MEMBER_BYTES}
                which, items = exports.export_items(files)
                if which:
                    # The export file itself is the original; conversations are items of their own.
                    self.import_bytes_from_file(path, rel)
                    self._post_items(items, rel)
                    return
            for info in members:
                if info.file_size > MAX_MEMBER_BYTES:
                    self.totals["failed"] += 1
                    self.report(path=f"{rel}!{info.filename}", status="failed", reason="member larger than 1 GB")
                    continue
                name = PurePosixPath(info.filename).name
                member_time = time.mktime(info.date_time + (0, 0, -1)) if info.date_time else None
                self.import_bytes(archive.read(info), f"{rel}!{info.filename}", name, member_time)

    def import_export_folder(self, folder: Path, rel: str) -> None:
        files = {p.name: p.read_bytes() for p in folder.glob("*.json") if p.stat().st_size <= MAX_MEMBER_BYTES}
        which, items = exports.export_items(files)
        if not which:
            self.import_bytes_from_file(folder / "conversations.json", rel)
            return
        for p in sorted(folder.glob("*.json")):
            self.import_bytes_from_file(p, f"{Path(rel).parent.as_posix()}/{p.name}")
        self._post_items(items, rel)

    def _post_items(self, items: list[dict[str, Any]], rel: str) -> None:
        for item in items:
            if self.dry_run:
                self.report(path=rel, status="would-store", kind=item["kind"], title=item["title"])
                continue
            result = self.client.call("POST", "/raw", body=item, timeout=120)
            self.totals["conversations"] += 1
            if result.get("duplicate"):
                self.totals["skipped"] += 1
            self.report(path=rel, status="skipped" if result.get("duplicate") else "stored", kind=item["kind"], title=item["title"], id=result.get("id"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="kbimport")
    sub = parser.add_subparsers(dest="command", required=True)
    scan = sub.add_parser("scan", help="import the inbox (or a sub folder / file of it)")
    scan.add_argument("subpath", nargs="?", default="")
    scan.add_argument("--dry-run", action="store_true")
    scan.add_argument("--limit", type=int)
    args = parser.parse_args(argv)
    inbox = Path(os.environ.get("KB_INBOX", "/inbox"))
    blobs = Path(os.environ.get("KB_BLOBS", "/blobs"))
    client = Client(os.environ.get("KB_URL", "http://knowledge:8092"), os.environ.get("KB_KEY_FILE", "/run/secrets/operator_key"))
    importer = Importer(client, inbox, blobs, dry_run=args.dry_run)
    try:
        totals = importer.scan(args.subpath, args.limit)
    except KnowledgeError as err:
        importer.report(status="error", code=err.code, message=err.message)
        return 1
    importer.report(status="done", **totals)
    return 0


if __name__ == "__main__":
    sys.exit(main())
