import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from worker import ExtractionError, Extractor, MAX_TEXT, bounded_text, vtt_lines


class WorkerTest(unittest.TestCase):
    def test_timestamps_survive_segment_offsets_and_blank_audio_is_ignored(self):
        vtt = """WEBVTT

00:00:01.580 --> 00:00:03.130
Lecture starts here.

00:00:03.150 --> 00:00:07.000
[BLANK_AUDIO]
"""
        self.assertEqual(vtt_lines(vtt, 600.4), ["[00:10:01] Lecture starts here."])
        text = bounded_text("a" * (MAX_TEXT + 50))
        self.assertLessEqual(len(text), MAX_TEXT)
        self.assertIn("생략", text)

    def test_only_hash_named_blobs_are_accepted_and_speech_waits_for_a_model(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wav = root / ("e" * 64 + ".wav")
            wav.write_bytes(b"sample")
            extractor = Extractor(root, root / "model.bin")
            self.assertEqual(extractor.capabilities(), {"transcription": False})
            for path, code in [("../outside.wav", "invalid_file"), (wav.name, "model_required")]:
                with self.subTest(path=path), self.assertRaisesRegex(ExtractionError, code):
                    extractor.extract(path)

    def test_rejects_non_image_content_before_ocr(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / ("a" * 64 + ".png")
            image.write_bytes(b"plain text with an image extension")
            with patch("worker.run_engine") as engine:
                with self.assertRaisesRegex(ExtractionError, "invalid_file"):
                    Extractor(root, root / "model.bin").extract(image.name)
                engine.assert_not_called()

    def test_video_without_an_audio_track_returns_a_specific_status(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            video = root / ("c" * 64 + ".mp4")
            model = root / "model.bin"
            video.write_bytes(b"sample")
            model.write_bytes(b"fixture")
            with patch("worker.run_engine", return_value=json.dumps({"streams": []}).encode()) as engine:
                with self.assertRaisesRegex(ExtractionError, "no_audio"):
                    Extractor(root, model).extract(video.name)
                self.assertEqual(engine.call_args.args[0][0], "ffprobe")
                self.assertIn("file,pipe", engine.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
