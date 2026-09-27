"""
test_presets.py - The deck track lists: every song once, however many copies were uploaded (from
either deck or under another name), and never the bucket's pointer objects (analysis/by-sha1/).

    python -m pytest tests/test_presets.py -q
"""

import os
import sys
import tempfile

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend import server, storage  # noqa: E402


def meta(title, bpm, key, duration):
    return {"title": title, "bpm": str(bpm), "camelot": key, "duration": str(duration)}


BUCKET = [
    ("analysis/deck_1_06_Talk_Dirty.mp3.json", meta("06 Talk Dirty.mp3", 100.3941, "11A", 177.76)),
    ("analysis/deck_2_06_Talk_Dirty.mp3.json", meta("06 Talk Dirty.mp3", 100.3941, "11A", 177.76)),
    ("analysis/deck_1_SAIYAARA_X_AKON.mp3.json", meta("SAIYAARA X AKON.mp3", 122.0001, "1A", 201.3)),
    ("analysis/deck_2_SAIYAARA_X_AKON_(AFRO_HOUSE_CALVIN_EDIT).mp3.json",
     meta("SAIYAARA X AKON (AFRO HOUSE CALVIN EDIT).mp3", 122.0001, "1A", 201.3)),   # same audio, renamed
    ("analysis/deck_1_Ari_Ari_(Part_2).mp3.json", meta("Ari Ari (Part 2).mp3", 95.0, "7A", 180.4)),
    ("analysis/by-sha1/03f585b470d45f5e612960ae.json", {}),                              # a pointer
]


def test_one_entry_per_song(monkeypatch):
    with tempfile.TemporaryDirectory() as d:
        monkeypatch.setattr(server, "UPLOAD_DIR", d)
        monkeypatch.setattr(server, "CACHE_FILE", os.path.join(d, "analysis_cache.json"))
        monkeypatch.setattr(server, "ANALYSIS_CACHE", {})
        monkeypatch.setattr(storage, "list_metadata", lambda prefix: iter(BUCKET))
        tracks = TestClient(server.app).get("/api/presets").json()["tracks"]
        ids = [t["file_id"] for t in tracks]
        assert not any(i.startswith("by-sha1/") for i in ids)
        assert sum("Talk_Dirty" in i for i in ids) == 1
        assert sum("SAIYAARA" in i for i in ids) == 1
        assert "deck_1_Ari_Ari_(Part_2).mp3" in ids and len(ids) == 3
