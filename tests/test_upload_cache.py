"""
test_upload_cache.py - Uploading the same audio again reuses its analysis, so Gemini's vocal labels
survive and nobody pays for another listen; different audio under the same name is analyzed anew.

    python -m pytest tests/test_upload_cache.py -q
"""

import os
import sys
import tempfile

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend import server  # noqa: E402


def test_same_audio_reuses_analysis_and_vocal_labels(monkeypatch):
    calls = []

    async def fake_heavy(fn, path):
        calls.append(path)
        return {"bpm": 122.0, "section_map": [{"time": 0.0, "duration": 8.0, "has_vocals": True}],
                "analysis_version": server.ANALYSIS_VERSION}

    with tempfile.TemporaryDirectory() as d:
        monkeypatch.setattr(server, "UPLOAD_DIR", d)
        monkeypatch.setattr(server, "CACHE_FILE", os.path.join(d, "analysis_cache.json"))
        monkeypatch.setattr(server, "ANALYSIS_CACHE", {})
        monkeypatch.setattr(server, "heavy", fake_heavy)
        client = TestClient(server.app)
        up = lambda data: client.post("/api/upload", files={"file": ("Track A.mp3", data, "audio/mpeg")},  # noqa: E731
                                      data={"deck": "deck_1"}).json()["track"]

        first = up(b"same audio")
        server.ANALYSIS_CACHE[first["file_id"]]["vocal_source"] = "gemini"  # listened in between
        again = up(b"same audio")
        assert len(calls) == 1
        assert again["vocal_source"] == "gemini"

        changed = up(b"other audio, same name")
        assert len(calls) == 2
        assert "vocal_source" not in changed
