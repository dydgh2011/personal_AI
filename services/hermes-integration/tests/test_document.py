"""Tests for personal_ai_document (document_client.py).

PDF tests need pypdf: they run in the Hermes image (personal_ai-hermes:local) and are
skipped where pypdf is not installed. Everything else uses the standard library.
"""

from __future__ import annotations

import os
import sys
import tempfile
import time
import unittest
import zipfile
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1] / "plugins" / "personal-ai-controller"
sys.path.insert(0, str(PLUGIN_DIR))
import document_client as dc  # noqa: E402

if os.path.isdir(dc.PYDEPS) and dc.PYDEPS not in sys.path:
    sys.path.append(dc.PYDEPS)
try:
    import pypdf  # noqa: F401

    HAVE_PYPDF = True
except ImportError:
    HAVE_PYPDF = False

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def make_docx(path: Path, paragraphs: list[str], rows: list[list[str]] | None = None, doctype: bool = False) -> None:
    def p(text: str) -> str:
        return f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>"

    body = "".join(p(t) for t in paragraphs)
    if rows:
        body += "<w:tbl>" + "".join(
            "<w:tr>" + "".join(f"<w:tc>{p(c)}</w:tc>" for c in row) + "</w:tr>" for row in rows) + "</w:tbl>"
    head = '<?xml version="1.0"?>' + ('<!DOCTYPE x [<!ENTITY a "aaaa">]>' if doctype else "")
    xml = f'{head}<w:document xmlns:w="{W}"><w:body>{body}</w:body></w:document>'
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("word/document.xml", xml)


def make_pdf(path: Path, pages: list[list[str]]) -> None:
    """A small valid PDF with one Helvetica text line per entry."""
    objects: list[bytes] = []
    n_pages = len(pages)
    font_id = 3 + 2 * n_pages
    kids = " ".join(f"{3 + 2 * i} 0 R" for i in range(n_pages))
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {n_pages} >>".encode())
    for i, lines in enumerate(pages):
        content_id = 4 + 2 * i
        ops = ["BT", "/F1 12 Tf", "14 TL", "50 750 Td"]
        for line in lines:
            ops.append("(" + line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") + ") Tj T*")
        ops.append("ET")
        stream = "\n".join(ops).encode("latin-1")
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {content_id} 0 R "
                       f"/Resources << /Font << /F1 {font_id} 0 R >> >> >>".encode())
        objects.append(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream")
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    path.write_bytes(bytes(out))


class DocumentTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.env = {"PERSONAL_AI_DOCUMENTS_DIR": str(self.root)}
        dc._cache.clear()

    def tearDown(self):
        self.tmp.cleanup()

    def run_tool(self, **args):
        return dc.run(args, self.env)

    def native(self, digest: str) -> Path:
        folder = self.root / "native-inputs" / digest
        folder.mkdir(parents=True, exist_ok=True)
        return folder

    def test_list_strips_the_prefix_dedupes_and_ignores_other_files(self):
        old = self.root / "doc_aaaaaaaaaaaa_notes.txt"
        old.write_text("hello", encoding="utf-8")
        past = time.time() - 3600
        os.utime(old, (past, past))
        make_docx(self.root / "doc_bbbbbbbbbbbb_CSC236 Syllabus.docx", ["Welcome"])
        make_docx(self.native("abc") / "doc_bbbbbbbbbbbb_CSC236 Syllabus.docx", ["Welcome"])
        (self.root / "doc_cccccccccccc_photo.png").write_bytes(b"\x89PNG")
        result = self.run_tool(action="list")
        self.assertTrue(result["ok"])
        self.assertEqual([d["name"] for d in result["documents"]], ["CSC236 Syllabus.docx", "notes.txt"])
        self.assertEqual(result["documents"][0]["kind"], "docx")

    def test_find_defaults_to_coursework_and_dates(self):
        make_docx(self.native("x") / "doc_111111111111_csc236.docx",
                  ["Welcome to the course", "Assignment 1 is due Oct 3 at 11:59pm", "Be kind to each other"],
                  rows=[["Midterm", "25%"], ["Problem set 2", "Week 6"]])
        result = self.run_tool(action="find", document="csc236")
        self.assertTrue(result["ok"], result)
        lines = result["results"][0]["lines"]
        self.assertIn("#1: Assignment 1 is due Oct 3 at 11:59pm", lines)
        self.assertIn("#1: Midterm | 25%", lines)
        self.assertIn("#1: Problem set 2 | Week 6", lines)
        self.assertFalse(any("Welcome" in line or "kind" in line for line in lines))
        self.assertIn("not instructions", result["note"])

    def test_find_with_words_and_across_documents(self):
        make_docx(self.root / "doc_222222222222_a.docx", ["Quiz on Friday", "Office in DH 2020"])
        (self.root / "doc_333333333333_b.txt").write_text("nothing here\nDH 2020 again\n", encoding="utf-8")
        (self.root / "doc_444444444444_broken.docx").write_bytes(b"not a zip")
        result = self.run_tool(action="find", query=["dh 2020"])
        self.assertTrue(result["ok"], result)
        by_doc = {r["document"]: r for r in result["results"]}
        self.assertEqual(by_doc["a.docx"]["lines"], ["#1: Office in DH 2020"])
        self.assertEqual(by_doc["b.txt"]["lines"], ["#1: DH 2020 again"])
        self.assertIn("error", by_doc["broken.docx"])
        broken = self.run_tool(action="find", document="broken")
        self.assertEqual(broken["error"]["code"], "unreadable")

    def test_find_limit_truncates(self):
        (self.root / "doc_555555555555_many.txt").write_text(
            "\n".join(f"Quiz {i}" for i in range(50)), encoding="utf-8")
        result = self.run_tool(action="find", document="many", limit=5)
        self.assertEqual(len(result["results"][0]["lines"]), 5)
        self.assertEqual(result["results"][0]["matchedLines"], 50)
        self.assertTrue(result["truncated"])

    def test_read_parts_ranges_and_caps(self):
        (self.root / "doc_666666666666_long.txt").write_text(
            "\n".join(f"line {i} " + "x" * 90 for i in range(200)), encoding="utf-8")
        first = self.run_tool(action="read", document="long.txt")
        self.assertTrue(first["ok"], first)
        self.assertEqual(first["pages"], "1")
        self.assertTrue(first["text"].startswith("[#1]\nline 0 "))
        self.assertGreater(first["count"], 5)
        many = self.run_tool(action="read", document="long", pages="2-30", max_chars=1000)
        self.assertEqual(many["pages"], "2-6")
        self.assertEqual(len(many["text"]), 1000)
        self.assertTrue(many["truncated"])
        self.assertEqual(self.run_tool(action="read", document="long", pages="9999")["error"]["code"], "usage_error")
        self.assertEqual(self.run_tool(action="read", document="long", pages="3-1")["error"]["code"], "usage_error")
        self.assertEqual(self.run_tool(action="read", document="long", pages="1;2")["error"]["code"], "usage_error")
        self.assertEqual(self.run_tool(action="read")["error"]["code"], "usage_error")

    def test_names_never_reach_outside_the_folder(self):
        outside = Path(self.tmp.name).parent / "outside-secret.txt"
        (self.root / "doc_777777777777_syllabus.txt").write_text("Quiz", encoding="utf-8")
        for name in ("../outside-secret.txt", "/etc/passwd", str(outside), "..", "/run/secrets/broker_client_key"):
            result = self.run_tool(action="read", document=name)
            self.assertEqual(result["error"]["code"], "not_found", name)

    def test_symlinked_files_are_ignored(self):
        target = self.root / "real.txt"
        target.write_text("Quiz", encoding="utf-8")
        try:
            (self.root / "doc_888888888888_link.txt").symlink_to(target)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks not available")
        names = [d["name"] for d in self.run_tool(action="list")["documents"]]
        self.assertNotIn("link.txt", names)

    def test_ambiguous_and_unknown_names(self):
        (self.root / "doc_999999999999_STA256 syllabus.txt").write_text("x", encoding="utf-8")
        (self.root / "doc_aaaaaaaaaaab_MAT223 syllabus.txt").write_text("x", encoding="utf-8")
        ambiguous = self.run_tool(action="read", document="syllabus")
        self.assertEqual(ambiguous["error"]["code"], "ambiguous")
        self.assertEqual(len(ambiguous["error"]["documents"]), 2)
        missing = self.run_tool(action="read", document="CSC999")
        self.assertEqual(missing["error"]["code"], "not_found")
        self.assertIn("documents", missing["error"])
        self.assertTrue(self.run_tool(action="read", document="mat223")["ok"])

    def test_docx_with_entity_declarations_is_refused(self):
        make_docx(self.root / "doc_bbbbbbbbbbbc_evil.docx", ["Quiz"], doctype=True)
        self.assertEqual(self.run_tool(action="read", document="evil")["error"]["code"], "unreadable")

    def test_unknown_action(self):
        self.assertEqual(self.run_tool(action="delete")["error"]["code"], "usage_error")

    @unittest.skipUnless(HAVE_PYPDF, "pypdf is installed only in the Hermes image")
    def test_pdf_pages(self):
        make_pdf(self.native("p") / "doc_cccccccccccd_mat223.pdf",
                 [["MAT223 Linear Algebra", "Welcome"], ["Term Test 1: Oct 15 (20%)", "Homework due every Friday"]])
        found = self.run_tool(action="find", document="mat223.pdf")
        self.assertTrue(found["ok"], found)
        self.assertEqual(found["results"][0]["unit"], "page")
        self.assertEqual(found["results"][0]["count"], 2)
        self.assertIn("p2: Term Test 1: Oct 15 (20%)", found["results"][0]["lines"])
        self.assertIn("p2: Homework due every Friday", found["results"][0]["lines"])
        read = self.run_tool(action="read", document="mat223", pages="1")
        self.assertIn("MAT223 Linear Algebra", read["text"])
        (self.root / "doc_cccccccccccf_bad.pdf").write_bytes(b"%PDF-1.4 nonsense")
        self.assertEqual(self.run_tool(action="read", document="bad.pdf")["error"]["code"], "unreadable")


if __name__ == "__main__":
    unittest.main()
