"""Bounded, local extraction of a specific immutable blob over a Unix socket."""

from __future__ import annotations

import json
import math
import os
import re
import socket
import socketserver
import stat
import subprocess
import tempfile
import threading
import time
import wave
from pathlib import Path
from typing import Any

TIFF_HEADERS = (b"II*\0", b"MM\0*", b"II+\0", b"MM\0+")
IMAGE_HEADERS = {
    ".png": (b"\x89PNG\r\n\x1a\n",),
    ".jpg": (b"\xff\xd8\xff",),
    ".jpeg": (b"\xff\xd8\xff",),
    ".gif": (b"GIF87a", b"GIF89a"),
    ".webp": (b"RIFF",),
    ".bmp": (b"BM",),
    ".tif": TIFF_HEADERS,
    ".tiff": TIFF_HEADERS,
}
FORMATS = {
    ".mp3": "mp3", ".wav": "wav", ".aac": "aac", ".flac": "flac", ".ogg": "ogg", ".opus": "ogg",
    ".m4a": "mov", ".mp4": "mov", ".mov": "mov", ".m4v": "mov",
    ".mkv": "matroska", ".webm": "matroska", ".avi": "avi", ".wmv": "asf",
}
BLOB_NAME = re.compile(r"[0-9a-f]{64}\.[a-z0-9]{1,10}")
IMAGE_BYTES = 50 * 1024**2
MEDIA_BYTES = 4 * 1024**3
MEDIA_SECONDS = 3 * 60 * 60
MAX_TEXT = 180_000
SEGMENT_SECONDS = 600
JOB_SECONDS = 60 * 60
VTT_TIME = re.compile(r"^(\d{2,}):(\d{2}):(\d{2})\.(\d{3})\s+-->")
PLACEHOLDER = re.compile(r"\[(?:blank_audio|silence|no speech|music)\]", re.IGNORECASE)


class ExtractionError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def run_engine(argv: list[str], timeout: float, *, capture: bool = False) -> bytes:
    if timeout <= 0:
        raise ExtractionError("timeout")
    try:
        result = subprocess.run(
            argv, stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
            timeout=timeout, check=True,
        )
    except subprocess.TimeoutExpired as error:
        raise ExtractionError("timeout") from error
    except (OSError, subprocess.CalledProcessError) as error:
        raise ExtractionError("engine_failed") from error
    return result.stdout if capture else b""


def read_text(path: Path, count: int = MAX_TEXT + 1) -> str:
    with path.open("r", encoding="utf-8", errors="replace") as stream:
        return stream.read(count)


def bounded_text(value: str) -> str:
    if len(value) <= MAX_TEXT:
        return value.strip()
    notice = "\n[길이 제한으로 나머지 결과를 생략했습니다.]"
    return value[:MAX_TEXT - len(notice)].rstrip() + notice


def vtt_lines(vtt: str, offset: float) -> list[str]:
    parts: list[str] = []
    for block in re.split(r"\n\s*\n", vtt):
        lines = block.splitlines()
        if not lines:
            continue
        timing = next(((index, match) for index, line in enumerate(lines) if (match := VTT_TIME.match(line.strip()))), None)
        if not timing:
            continue
        index, match = timing
        caption = " ".join(line.strip() for line in lines[index + 1:] if line.strip())
        if not caption or PLACEHOLDER.fullmatch(caption):
            continue
        h, m, s, ms = (int(part) for part in match.groups())
        absolute = int(offset + h * 3600 + m * 60 + s + ms / 1000)
        hour, remainder = divmod(absolute, 3600)
        minute, second = divmod(remainder, 60)
        parts.append(f"[{hour:02}:{minute:02}:{second:02}] {caption}")
    return parts


class Extractor:
    def __init__(self, blobs: Path, model: Path):
        self.blobs = blobs
        self.model = model

    def capabilities(self) -> dict[str, bool]:
        return {"transcription": self.model.is_file() and os.access(self.model, os.R_OK)}

    def extract(self, name: str) -> str:
        if not isinstance(name, str) or not BLOB_NAME.fullmatch(name):
            raise ExtractionError("invalid_file")
        file = self.blobs / name
        try:
            info = file.lstat()
        except OSError as error:
            raise ExtractionError("invalid_file") from error
        if not stat.S_ISREG(info.st_mode) or not info.st_size:
            raise ExtractionError("invalid_file")
        suffix = file.suffix
        if suffix in IMAGE_HEADERS:
            if info.st_size > IMAGE_BYTES:
                raise ExtractionError("too_large")
            # Tesseract also accepts text file lists. Require a supported image header first.
            with file.open("rb") as source:
                header = source.read(12)
            if not header.startswith(IMAGE_HEADERS[suffix]) or (suffix == ".webp" and header[8:12] != b"WEBP"):
                raise ExtractionError("invalid_file")
            with tempfile.TemporaryDirectory(prefix="ocr-") as directory:
                output = Path(directory) / "text"
                run_engine(["tesseract", str(file), str(output), "-l", "kor+eng", "--psm", "3"], 120)
                return bounded_text(read_text(output.with_suffix(".txt")))
        if suffix not in FORMATS:
            raise ExtractionError("unsupported")
        if info.st_size > MEDIA_BYTES:
            raise ExtractionError("too_large")
        if not self.capabilities()["transcription"]:
            raise ExtractionError("model_required")
        return self.transcribe(file, FORMATS[suffix])

    def transcribe(self, file: Path, file_format: str) -> str:
        deadline = time.monotonic() + JOB_SECONDS
        input_args = ["-protocol_whitelist", "file,pipe", "-f", file_format]
        try:
            probe = json.loads(run_engine([
                "ffprobe", "-v", "error", *input_args, "-select_streams", "a:0",
                "-show_entries", "stream=index:format=duration", "-of", "json", str(file),
            ], 45, capture=True))
        except (ValueError, TypeError) as error:
            raise ExtractionError("invalid_file") from error
        if not probe.get("streams"):
            raise ExtractionError("no_audio")
        try:
            duration = float(probe.get("format", {}).get("duration", "nan"))
        except (TypeError, ValueError):
            duration = math.nan
        if math.isfinite(duration) and duration > MEDIA_SECONDS:
            raise ExtractionError("too_long")

        with tempfile.TemporaryDirectory(prefix="asr-") as directory:
            work = Path(directory)
            run_engine([
                "ffmpeg", "-nostdin", "-v", "error", "-threads", "2", *input_args, "-i", str(file),
                "-map", "0:a:0", "-vn", "-sn", "-dn", "-t", str(MEDIA_SECONDS + 1),
                "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-f", "segment",
                "-segment_time", str(SEGMENT_SECONDS), "-reset_timestamps", "1", str(work / "part-%03d.wav"),
            ], 300)
            parts = []
            for wav in sorted(work.glob("part-*.wav")):
                with wave.open(str(wav), "rb") as audio:
                    seconds = audio.getnframes() / audio.getframerate()
                if seconds:
                    parts.append((wav, seconds))
            if not parts:
                raise ExtractionError("no_audio")
            if sum(seconds for _, seconds in parts) > MEDIA_SECONDS:
                raise ExtractionError("too_long")

            offset = 0.0
            transcripts: list[str] = []
            characters = 0
            for wav, seconds in parts:
                output = wav.with_suffix("")
                run_engine([
                    "whisper-cli", "-m", str(self.model), "-f", str(wav), "-l", "auto", "-t", "2",
                    "-ovtt", "-of", str(output),
                ], deadline - time.monotonic())
                captions = vtt_lines(read_text(output.with_suffix(".vtt")), offset)
                transcripts.extend(captions)
                characters += sum(len(line) + 1 for line in captions)
                offset += seconds
                if characters > MAX_TEXT:
                    break
            return bounded_text("\n".join(transcripts))


class Handler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        self.connection.settimeout(5)
        try:
            line = self.rfile.readline(1025)
            if len(line) > 1024 or not line.endswith(b"\n"):
                return
            request = json.loads(line)
            if not isinstance(request, dict):
                return
            reply = self.server.dispatch(request)
            self.wfile.write(json.dumps(reply, ensure_ascii=False).encode("utf-8") + b"\n")
        except (BrokenPipeError, ConnectionResetError, TimeoutError, ValueError):
            return


def serve(path: Path, extractor: Extractor) -> None:
    class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
        daemon_threads = True

        def __init__(self, path: Path, extractor: Extractor):
            self.extractor = extractor
            self.job_lock = threading.Lock()
            super().__init__(str(path), Handler)

        def dispatch(self, request: dict[str, Any]) -> dict[str, Any]:
            if request == {"op": "status"}:
                return self.extractor.capabilities()
            if request.get("op") != "extract" or set(request) != {"op", "blob"}:
                return {"status": "failed", "code": "invalid_file"}
            if not self.job_lock.acquire(blocking=False):
                return {"status": "busy"}
            try:
                return {"status": "complete", "text": self.extractor.extract(request["blob"])}
            except ExtractionError as error:
                return {"status": "failed", "code": error.code}
            except (OSError, wave.Error, EOFError):
                return {"status": "failed", "code": "engine_failed"}
            finally:
                self.job_lock.release()

    with Server(path, extractor) as server:
        server.serve_forever()

def main() -> None:
    import sys

    path = Path(os.environ.get("KNOWLEDGE_MEDIA_SOCKET", "/run/knowledge-media/worker.sock"))
    if sys.argv[1:] == ["--check"]:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(3)
            client.connect(str(path))
            client.sendall(b'{"op":"status"}\n')
            if not isinstance(json.loads(client.makefile("rb").readline(1024)).get("transcription"), bool):
                raise SystemExit(1)
        return
    if path.exists():
        if not stat.S_ISSOCK(path.lstat().st_mode):
            raise RuntimeError("The media socket path is already occupied")
        path.unlink()
    os.umask(0o007)
    extractor = Extractor(
        Path(os.environ.get("KNOWLEDGE_MEDIA_BLOBS", "/blobs")),
        Path(os.environ.get("KNOWLEDGE_WHISPER_MODEL", "/models/ggml-base.bin")),
    )
    serve(path, extractor)


if __name__ == "__main__":
    main()
