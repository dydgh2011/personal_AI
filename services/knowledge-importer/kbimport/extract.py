"""Text extraction for imported files. Deterministic code, no LLM.

Returns (kind, content_type, text, page_count, status). Text is marked per page/slide/sheet/part
("[p3]", "[slide 2]", "[sheet Grades]") so search results and later reading keep their place.
status: "ok", "empty" (nothing to extract) or "pending:<reason>" (stored, text later: OCR, transcription).
"""

from __future__ import annotations

import html.parser
import io
import json
import logging
import re
import zipfile
from pathlib import PurePosixPath
from xml.etree import ElementTree

MAX_TEXT_CHARS = 5_000_000
MAX_XML_BYTES = 64 * 1024 * 1024
MAX_PDF_PAGES = 3000

logging.getLogger("pypdf").setLevel(logging.ERROR)

TEXT_EXT = {".txt", ".md", ".markdown", ".rst", ".csv", ".tsv", ".json", ".yaml", ".yml", ".ics", ".tex", ".bib", ".log", ".xml", ".srt", ".vtt"}
CODE_EXT = {".py", ".js", ".mjs", ".ts", ".tsx", ".jsx", ".java", ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".go", ".rs", ".rb",
            ".php", ".swift", ".kt", ".scala", ".r", ".m", ".sql", ".sh", ".ps1", ".bat", ".lua", ".hs", ".ml", ".asm", ".s",
            ".css", ".scss", ".vue", ".svelte", ".dart", ".jl", ".pl", ".v", ".vhd", ".sv", ".racket", ".rkt", ".lisp", ".clj"}
HTML_EXT = {".html", ".htm", ".xhtml"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".svg"}
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"}
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".wmv"}
ARCHIVE_EXT = {".zip"}

CONTENT_TYPES = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ipynb": "application/x-ipynb+json",
    ".zip": "application/zip",
}

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
_S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def kind_of(name: str) -> str:
    ext = PurePosixPath(name.lower()).suffix
    if ext in (".pdf", ".docx", ".pptx", ".xlsx", ".ipynb"):
        return ext[1:]
    if ext in HTML_EXT:
        return "html"
    if ext in CODE_EXT:
        return "code"
    if ext in TEXT_EXT:
        return ext[1:] if ext in (".md", ".csv", ".ics", ".json", ".tex") else "text"
    if ext in IMAGE_EXT:
        return "image"
    if ext in AUDIO_EXT:
        return "audio"
    if ext in VIDEO_EXT:
        return "video"
    if ext in ARCHIVE_EXT:
        return "archive"
    return "other"


def content_type(name: str) -> str:
    ext = PurePosixPath(name.lower()).suffix
    if ext in CONTENT_TYPES:
        return CONTENT_TYPES[ext]
    k = kind_of(name)
    return {"image": "image/*", "audio": "audio/*", "video": "video/*", "html": "text/html"}.get(
        k, "text/plain" if k in ("text", "code", "md", "csv", "ics", "json", "tex") else "application/octet-stream")


def _clean(text: str) -> list[str]:
    out = []
    for raw in text.replace("\r", "\n").split("\n"):
        line = re.sub(r"[ \t ]+", " ", raw).strip()
        if line:
            out.append(line)
    return out


def _safe_xml(data: bytes):
    if b"<!DOCTYPE" in data[:4096].upper() or b"<!ENTITY" in data.upper():
        raise ValueError("XML declarations are not allowed")
    return ElementTree.fromstring(data)


def _zip_xml(archive: zipfile.ZipFile, name: str):
    info = archive.getinfo(name)
    if info.file_size > MAX_XML_BYTES:
        raise ValueError(f"{name} is too large")
    return _safe_xml(archive.read(info))


def _decode(data: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-16"):
        try:
            if encoding == "utf-16" and not data.startswith((b"\xff\xfe", b"\xfe\xff")):
                continue
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def _looks_binary(data: bytes) -> bool:
    return b"\x00" in data[:8192] and not data.startswith((b"\xff\xfe", b"\xfe\xff"))


def pdf_text(data: bytes) -> tuple[str, int]:
    from pypdf import PdfReader  # installed in the importer image

    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted and not reader.decrypt(""):
        raise PermissionError("password-protected PDF")
    parts = []
    pages = reader.pages[:MAX_PDF_PAGES]
    for n, page in enumerate(pages, start=1):
        lines = _clean(page.extract_text() or "")
        if len(lines) >= 40 and sum(len(x) for x in lines) / len(lines) < 15:
            lines = _clean(page.extract_text(extraction_mode="layout") or "") or lines
        parts.append(f"[p{n}]\n" + "\n".join(lines))
    return "\n\n".join(parts), len(reader.pages)


def _paragraph_text(element) -> str:
    out = []
    for node in element.iter():
        if node.tag in (_W + "t", _A + "t") and node.text:
            out.append(node.text)
        elif node.tag in (_W + "tab",):
            out.append(" ")
        elif node.tag in (_W + "br", _W + "cr", _A + "br"):
            out.append("\n")
    return "".join(out)


def docx_text(data: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        body = _zip_xml(archive, "word/document.xml").find(_W + "body")
    lines: list[str] = []
    for child in list(body) if body is not None else []:
        if child.tag == _W + "p":
            lines += _clean(_paragraph_text(child))
        elif child.tag == _W + "tbl":
            for row in child.iter(_W + "tr"):
                cells = [" ".join(_clean(_paragraph_text(c))) for c in row.findall(_W + "tc")]
                if any(cells):
                    lines.append(" | ".join(c for c in cells if c))
    return "\n".join(lines)


def _numbered(names: list[str], pattern: str) -> list[tuple[int, str]]:
    found = []
    for name in names:
        m = re.fullmatch(pattern, name)
        if m:
            found.append((int(m.group(1)), name))
    return sorted(found)


def pptx_text(data: bytes) -> tuple[str, int]:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = archive.namelist()
        slides = _numbered(names, r"ppt/slides/slide(\d+)\.xml")
        notes = dict(_numbered(names, r"ppt/notesSlides/notesSlide(\d+)\.xml"))
        parts = []
        for n, name in slides:
            root = _zip_xml(archive, name)
            lines = []
            for para in root.iter(_A + "p"):
                lines += _clean(_paragraph_text(para))
            text = f"[slide {n}]\n" + "\n".join(lines)
            if n in notes:
                note_lines = []
                for para in _zip_xml(archive, notes[n]).iter(_A + "p"):
                    note_lines += _clean(_paragraph_text(para))
                if note_lines:
                    text += "\n(notes) " + " ".join(note_lines)
            parts.append(text)
    return "\n\n".join(parts), len(slides)


def xlsx_text(data: bytes, max_rows: int = 5000) -> tuple[str, int]:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = archive.namelist()
        shared: list[str] = []
        if "xl/sharedStrings.xml" in names:
            for si in _zip_xml(archive, "xl/sharedStrings.xml").iter(_S + "si"):
                shared.append("".join(t.text or "" for t in si.iter(_S + "t")))
        sheet_names: dict[str, str] = {}
        if "xl/workbook.xml" in names:
            for i, sheet in enumerate(_zip_xml(archive, "xl/workbook.xml").iter(_S + "sheet"), start=1):
                sheet_names[f"xl/worksheets/sheet{i}.xml"] = sheet.get("name") or f"Sheet{i}"
        parts = []
        sheets = _numbered(names, r"xl/worksheets/sheet(\d+)\.xml")
        for _, name in sheets:
            rows = []
            for row in _zip_xml(archive, name).iter(_S + "row"):
                cells = []
                for c in row.findall(_S + "c"):
                    v = c.find(_S + "v")
                    if c.get("t") == "s" and v is not None and (v.text or "").isdigit() and int(v.text) < len(shared):
                        cells.append(shared[int(v.text)])
                    elif c.get("t") == "inlineStr":
                        cells.append("".join(t.text or "" for t in c.iter(_S + "t")))
                    elif v is not None and v.text is not None:
                        cells.append(v.text)
                if any(x.strip() for x in cells):
                    rows.append("\t".join(cells))
                if len(rows) >= max_rows:
                    rows.append("(more rows not extracted)")
                    break
            parts.append(f"[sheet {sheet_names.get(name, name)}]\n" + "\n".join(rows))
    return "\n\n".join(parts), len(sheets)


def ipynb_text(data: bytes) -> str:
    nb = json.loads(_decode(data))
    parts = []
    for n, cell in enumerate(nb.get("cells", []), start=1):
        source = cell.get("source", "")
        source = "".join(source) if isinstance(source, list) else str(source)
        text = f"[cell {n} {cell.get('cell_type', '')}]\n{source.strip()}"
        outputs = []
        for out in cell.get("outputs", []) or []:
            t = out.get("text") or (out.get("data") or {}).get("text/plain")
            if t:
                outputs.append("".join(t) if isinstance(t, list) else str(t))
        if outputs:
            text += "\n(output) " + "\n".join(outputs)[:4000]
        parts.append(text)
    return "\n\n".join(parts)


class _HtmlText(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript"):
            self.skip += 1
        elif tag in ("p", "br", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article"):
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript") and self.skip:
            self.skip -= 1

    def handle_data(self, data):
        if not self.skip:
            self.out.append(data)


def html_text(data: bytes) -> str:
    parser = _HtmlText()
    parser.feed(_decode(data))
    return "\n".join(_clean("".join(parser.out)))


def extract(name: str, data: bytes) -> tuple[str, str, str, int | None, str]:
    """(kind, content_type, text, page_count, status) for one file. Never raises."""
    kind = kind_of(name)
    ctype = content_type(name)
    pages: int | None = None
    try:
        if kind == "pdf":
            text, pages = pdf_text(data)
        elif kind == "docx":
            text = docx_text(data)
        elif kind == "pptx":
            text, pages = pptx_text(data)
        elif kind == "xlsx":
            text, pages = xlsx_text(data)
        elif kind == "ipynb":
            text = ipynb_text(data)
        elif kind == "html":
            text = html_text(data)
        elif kind in ("text", "code", "md", "csv", "ics", "json", "tex"):
            if _looks_binary(data):
                return kind, ctype, "", None, "empty"
            text = _decode(data)
        elif kind == "image":
            return kind, ctype, "", None, "pending:ocr"
        elif kind in ("audio", "video"):
            return kind, ctype, "", None, "pending:transcription"
        else:
            return kind, ctype, "", None, "empty"
    except PermissionError as err:
        return kind, ctype, "", pages, f"pending:{err}"
    except Exception as err:  # noqa: BLE001 - a broken file is kept as an original without text
        return kind, ctype, "", pages, f"failed:{type(err).__name__}"
    text = text.strip()
    if len(text) > MAX_TEXT_CHARS:
        return kind, ctype, text[:MAX_TEXT_CHARS], pages, "truncated"
    return kind, ctype, text, pages, "ok" if text else "empty"
