"""Importer tests with an in-memory stand-in for the knowledge service (no network, no Docker)."""

from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from kbimport import exports  # noqa: E402
from kbimport.client import KnowledgeError  # noqa: E402
from kbimport.extract import extract, kind_of  # noqa: E402
from kbimport.main import Importer  # noqa: E402

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"


class FakeKnowledge:
    def __init__(self, blobs: Path):
        self.blobs = blobs
        self.files: dict[str, dict] = {}
        self.raw: dict[str, dict] = {}

    def call(self, method, path, body=None, timeout=60):
        if method == "GET" and path.startswith("/raw/by-sha/"):
            sha = path.rsplit("/", 1)[1]
            if sha in self.files:
                return {"id": self.files[sha]["id"]}
            raise KnowledgeError("not_found", "no", 404)
        if method == "POST" and path == "/raw/file":
            assert (self.blobs / body["blob"]).read_bytes(), "blob written before registering"
            assert (self.blobs / body["blob"]).stat().st_size == body["size"]
            body = {**body, "id": f"f{len(self.files)}"}
            self.files[body["sha256"]] = body
            return {"id": body["id"], "duplicate": False}
        if method == "POST" and path == "/raw":
            if body["externalId"] in self.raw:
                return {"id": self.raw[body["externalId"]]["id"], "duplicate": True}
            self.raw[body["externalId"]] = {**body, "id": f"r{len(self.raw)}"}
            return {"id": f"r{len(self.raw)}", "duplicate": False}
        raise AssertionError(f"unexpected {method} {path}")


def docx_bytes(paragraphs):
    body = "".join(f"<w:p><w:r><w:t>{t}</w:t></w:r></w:p>" for t in paragraphs)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("word/document.xml", f'<w:document xmlns:w="{W}"><w:body>{body}</w:body></w:document>')
    return buf.getvalue()


def pptx_bytes(slides):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for n, text in enumerate(slides, start=1):
            z.writestr(f"ppt/slides/slide{n}.xml", f'<p:sld xmlns:p="p" xmlns:a="{A}"><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:sld>')
        z.writestr("ppt/notesSlides/notesSlide1.xml", f'<p:notes xmlns:p="p" xmlns:a="{A}"><a:p><a:r><a:t>speaker note</a:t></a:r></a:p></p:notes>')
    return buf.getvalue()


def xlsx_bytes():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("xl/workbook.xml", f'<workbook xmlns="{S}"><sheets><sheet name="Grades"/></sheets></workbook>')
        z.writestr("xl/sharedStrings.xml", f'<sst xmlns="{S}"><si><t>Quiz 1</t></si></sst>')
        z.writestr("xl/worksheets/sheet1.xml", f'<worksheet xmlns="{S}"><sheetData><row><c t="s"><v>0</v></c><c><v>8.5</v></c></row></sheetData></worksheet>')
    return buf.getvalue()


CHATGPT = [{
    "id": "c1", "title": "통계 질문", "create_time": 1700000000, "update_time": 1700000100, "current_node": "n3",
    "mapping": {
        "n0": {"message": None, "parent": None},
        "n1": {"message": {"author": {"role": "user"}, "content": {"parts": ["베이즈 정리 설명해줘"]}, "create_time": 1700000000}, "parent": "n0"},
        "n2x": {"message": {"author": {"role": "assistant"}, "content": {"parts": ["(버려진 가지)"]}}, "parent": "n1"},
        "n2": {"message": {"author": {"role": "assistant"}, "content": {"parts": ["P(A|B) = ..."]}, "create_time": 1700000050}, "parent": "n1"},
        "n3": {"message": {"author": {"role": "system"}, "content": {"parts": ["hidden"]}}, "parent": "n2"},
    },
}]
CLAUDE = [{
    "uuid": "u1", "name": "이력서 다듬기", "created_at": "2026-01-02T03:04:05Z", "updated_at": "2026-01-02T04:00:00Z",
    "chat_messages": [
        {"sender": "human", "text": "내 경력 정리 도와줘", "created_at": "2026-01-02T03:04:05Z",
         "attachments": [{"file_name": "cv.txt", "extracted_content": "2025 인턴 ABC"}]},
        {"sender": "assistant", "text": "", "content": [{"type": "text", "text": "좋아요"}]},
    ],
}]


class ExtractTest(unittest.TestCase):
    def test_formats(self):
        self.assertEqual(extract("a.docx", docx_bytes(["Assignment 1 due Oct 3"]))[2], "Assignment 1 due Oct 3")
        kind, _, text, pages, status = extract("lec.pptx", pptx_bytes(["Bayes rule", "Priors"]))
        self.assertEqual((kind, pages, status), ("pptx", 2, "ok"))
        self.assertIn("[slide 1]\nBayes rule\n(notes) speaker note", text)
        self.assertIn("[sheet Grades]\nQuiz 1\t8.5", extract("g.xlsx", xlsx_bytes())[2])
        nb = json.dumps({"cells": [{"cell_type": "code", "source": ["print(1)"], "outputs": [{"text": ["1\n"]}]}]}).encode()
        self.assertIn("(output) 1", extract("h.ipynb", nb)[2])
        self.assertEqual(extract("p.html", b"<html><script>x()</script><p>Hello</p><p>World</p></html>")[2], "Hello\nWorld")
        self.assertEqual(extract("x.bin", b"\x00\x01")[4], "empty")
        self.assertEqual(extract("photo.jpg", b"\xff\xd8")[4], "pending:ocr")
        self.assertTrue(extract("broken.pdf", b"%PDF-1.4 nonsense")[4].startswith("failed:"))
        self.assertEqual(kind_of("Main.java"), "code")

    def test_exports(self):
        which, items = exports.export_items({"conversations.json": json.dumps(CHATGPT).encode()})
        self.assertEqual(which, "chatgpt")
        self.assertEqual(len(items), 1)
        self.assertIn("owner: 베이즈 정리 설명해줘", items[0]["text"])
        self.assertIn("chatgpt: P(A|B)", items[0]["text"])
        self.assertNotIn("버려진", items[0]["text"])
        self.assertNotIn("hidden", items[0]["text"])
        which, items = exports.export_items({"conversations.json": json.dumps(CLAUDE).encode(),
                                             "users.json": b'[{"full_name": "x"}]', "memories.json": b"[]"})
        self.assertEqual(which, "claude")
        self.assertEqual([i["kind"] for i in items], ["claude-conversation", "claude-export-file"])
        self.assertIn("(attachment) 2025 인턴 ABC", items[0]["text"])
        self.assertIn("claude: 좋아요", items[0]["text"])
        self.assertEqual(exports.export_items({"conversations.json": b"[{\"x\": 1}]"}), (None, []))


class ImporterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.inbox, self.blobs = root / "inbox", root / "blobs"
        self.inbox.mkdir()
        self.blobs.mkdir()
        self.kb = FakeKnowledge(self.blobs)
        self.out = io.StringIO()

    def tearDown(self):
        self.tmp.cleanup()

    def importer(self, **kw):
        return Importer(self.kb, self.inbox, self.blobs, out=self.out, **kw)

    def test_scan_stores_each_content_once_and_resumes(self):
        course = self.inbox / "courses" / "STA256"
        course.mkdir(parents=True)
        (course / "week1.docx").write_bytes(docx_bytes(["Probability axioms"]))
        (course / "copy-of-week1.docx").write_bytes(docx_bytes(["Probability axioms"]))
        (course / "slides.pptx").write_bytes(pptx_bytes(["Random variables"]))
        (course / "lecture.mp4").write_bytes(b"\x00video" * 100)
        (course / ".hidden").write_text("x")
        (course / "Thumbs.db").write_text("x")
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("hw/hw1.txt", "Homework 1: Bayes")
            z.writestr("__MACOSX/._hw1.txt", "junk")
        (self.inbox / "homework.zip").write_bytes(buf.getvalue())
        totals = self.importer().scan()
        self.assertEqual(totals["stored"], 4)
        self.assertEqual(totals["skipped"], 1, "the copy has the same content")
        self.assertEqual(totals["pending"], 1, "the video waits for transcription")
        paths = sorted(f["path"] for f in self.kb.files.values())
        self.assertIn("homework.zip!hw/hw1.txt", paths)
        self.assertIn("courses/STA256/lecture.mp4", paths)
        video = next(f for f in self.kb.files.values() if f["kind"] == "video")
        self.assertEqual(video["text"], "")
        self.assertTrue((self.blobs / video["blob"]).exists())
        again = self.importer().scan()
        self.assertEqual((again["stored"], again["skipped"]), (0, 5))
        self.assertFalse(list(self.blobs.glob(".*.tmp")))

    def test_chat_exports_become_conversations(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("conversations.json", json.dumps(CHATGPT))
            z.writestr("user.json", json.dumps({"id": "user-1"}))
        (self.inbox / "chatgpt-export.zip").write_bytes(buf.getvalue())
        folder = self.inbox / "claude-export"
        folder.mkdir()
        (folder / "conversations.json").write_text(json.dumps(CLAUDE), encoding="utf-8")
        totals = self.importer().scan()
        kinds = sorted(r["kind"] for r in self.kb.raw.values())
        self.assertEqual(kinds, ["chatgpt-conversation", "chatgpt-export-file", "claude-conversation"])
        self.assertEqual(totals["conversations"], 3)
        self.assertIn("chatgpt-export.zip", [f["path"] for f in self.kb.files.values()], "the export file itself is kept")
        again = self.importer().scan()
        self.assertEqual(again["stored"], 0)

    def test_dry_run_and_subpath(self):
        (self.inbox / "a.txt").write_text("hello")
        totals = self.importer(dry_run=True).scan()
        self.assertEqual(totals["stored"], 0)
        self.assertFalse(self.kb.files)
        self.assertIn("would-store", self.out.getvalue())
        with self.assertRaises(SystemExit):
            self.importer().scan("../../etc")


if __name__ == "__main__":
    unittest.main()
