"""
test_upload_cache.py - Uploading the same audio again (same name, another name or the other deck)
reuses its analysis, so Gemini's vocal labels survive and nobody pays for another listen; different
audio under the same name is analyzed anew.

    python -m pytest tests/test_upload_cache.py -q
"""

import asyncio
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
        up = lambda data, name="Track A.mp3", deck="deck_1": client.post(  # noqa: E731
            "/api/upload", files={"file": (name, data, "audio/mpeg")}, data={"deck": deck}).json()["track"]

        first = up(b"same audio")
        server.ANALYSIS_CACHE[first["file_id"]]["vocal_source"] = "gemini"  # listened in between
        again = up(b"same audio")
        assert len(calls) == 1
        assert again["vocal_source"] == "gemini"

        other_deck = up(b"same audio", name="Same Song Renamed.mp3", deck="deck_2")
        assert len(calls) == 1
        assert other_deck["vocal_source"] == "gemini"
        assert (other_deck["file_id"], other_deck["deck"]) == ("deck_2_Same_Song_Renamed.mp3", "deck_2")
        assert os.path.exists(os.path.join(d, "deck_2_Same_Song_Renamed.mp3"))

        changed = up(b"other audio, same name")
        assert len(calls) == 2
        assert "vocal_source" not in changed


def test_reanalysis_keeps_gemini_labels(monkeypatch):
    """A newer analyzer re-analyzes the track (its sections move with the grid); Gemini's labels are
    mapped onto the new sections instead of paying for another listen."""
    calls = []

    async def fake_heavy(fn, path):
        calls.append(path)
        return {"bpm": 100.0, "analysis_version": server.ANALYSIS_VERSION,
                "section_map": [{"time": 0.0, "duration": 6.0, "has_vocals": False, "vocal_score": 0.1},
                                {"time": 6.0, "duration": 6.0, "has_vocals": False, "vocal_score": 0.1}]}

    with tempfile.TemporaryDirectory() as d:
        monkeypatch.setattr(server, "UPLOAD_DIR", d)
        monkeypatch.setattr(server, "CACHE_FILE", os.path.join(d, "analysis_cache.json"))
        monkeypatch.setattr(server, "ANALYSIS_CACHE", {})
        monkeypatch.setattr(server, "heavy", fake_heavy)
        client = TestClient(server.app)
        up = lambda: client.post(  # noqa: E731
            "/api/upload", files={"file": ("Track A.mp3", b"audio", "audio/mpeg")}, data={"deck": "deck_1"}).json()["track"]

        first = up()
        old = server.ANALYSIS_CACHE[first["file_id"]]   # Gemini listened, then the analyzer changed
        old["section_map"] = [{"time": 0.0, "duration": 4.0, "has_vocals": False, "vocal_score": 0.0},
                              {"time": 4.0, "duration": 8.0, "has_vocals": True, "vocal_score": 1.0}]
        old["vocal_source"] = "gemini:gemini-3.8-flash"
        old["analysis_version"] = server.ANALYSIS_VERSION - 1

        again = up()
        assert len(calls) == 2
        assert again["vocal_source"] == "gemini:gemini-3.8-flash"
        assert [s["has_vocals"] for s in again["section_map"]] == [False, True]   # 2 of 6 s sung, then all


def test_listen_reuses_labels_of_another_copy(monkeypatch):
    """Asked to listen to a track whose audio another copy already has labels for (other deck or name,
    older analyzer), the server copies them over instead of calling Gemini."""
    from backend import vocal_listen

    def no_gemini(*a, **k):
        raise AssertionError("Gemini must not be called")

    monkeypatch.setattr(vocal_listen, "listen_for_vocals", no_gemini)
    monkeypatch.setattr(server, "get_cached_analysis",
                        lambda fid: _async(server.ANALYSIS_CACHE.get(fid)))
    sections = lambda sung: [{"time": 0.0, "duration": 4.0, "has_vocals": sung, "vocal_score": 1.0 if sung else 0.0},  # noqa: E731
                             {"time": 4.0, "duration": 4.0, "has_vocals": False, "vocal_score": 0.0}]
    with tempfile.TemporaryDirectory() as d:
        monkeypatch.setattr(server, "UPLOAD_DIR", d)
        monkeypatch.setattr(server, "CACHE_FILE", os.path.join(d, "analysis_cache.json"))
        monkeypatch.setattr(server, "ANALYSIS_CACHE", {
            "deck_2_a.mp3": {"content_sha1": "x", "analysis_version": server.ANALYSIS_VERSION - 1,
                             "vocal_source": "gemini:gemini-3.8-flash", "section_map": sections(True)},
            "deck_1_a.mp3": {"content_sha1": "x", "analysis_version": server.ANALYSIS_VERSION,
                             "section_map": sections(False)},
        })
        res = TestClient(server.app).post("/api/listen-vocals", json={"file_id": "deck_1_a.mp3"}).json()
        assert res["status"] == "success"
        assert res["vocal_source"] == "gemini:gemini-3.8-flash"
        assert [s["has_vocals"] for s in res["section_map"]] == [True, False]


def test_reanalysis_keeps_the_fingerprint(monkeypatch):
    """A track re-analyzed by a newer analyzer (preset load) keeps its audio fingerprint, so later
    uploads of the same audio still find it and its labels."""
    async def fake_heavy(fn, path):
        return {"bpm": 100.0, "analysis_version": server.ANALYSIS_VERSION,
                "section_map": [{"time": 0.0, "duration": 8.0, "has_vocals": False, "vocal_score": 0.0}]}

    async def fake_local(fid):
        return "/dev/null"

    with tempfile.TemporaryDirectory() as d:
        monkeypatch.setattr(server, "UPLOAD_DIR", d)
        monkeypatch.setattr(server, "CACHE_FILE", os.path.join(d, "analysis_cache.json"))
        monkeypatch.setattr(server, "heavy", fake_heavy)
        monkeypatch.setattr(server, "local_track", fake_local)
        monkeypatch.setattr(server, "ANALYSIS_CACHE", {"deck_1_a.mp3": {
            "content_sha1": "x", "analysis_version": server.ANALYSIS_VERSION - 1,
            "vocal_source": "gemini:gemini-3.8-flash",
            "section_map": [{"time": 0.0, "duration": 8.0, "has_vocals": True, "vocal_score": 1.0}]}})
        an = asyncio.run(server.get_cached_analysis("deck_1_a.mp3"))
        assert an["content_sha1"] == "x"
        assert an["vocal_source"] == "gemini:gemini-3.8-flash"


async def _async(value):
    return value


def test_pointer_vouches_for_a_copy_without_fingerprint(monkeypatch):
    """The bucket's pointer for an audio fingerprint leads to a labelled analysis that lost its own
    fingerprint (re-analyzed before fingerprints were kept): it still counts as the same audio."""
    from backend import storage
    store = {"analysis/by-sha1/x.json": {"file_id": "deck_1_a.mp3"},
             "analysis/deck_1_a.mp3.json": {"analysis_version": server.ANALYSIS_VERSION,
                                             "vocal_source": "gemini:gemini-3.8-flash", "section_map": []}}
    monkeypatch.setattr(storage, "enabled", lambda: True)
    monkeypatch.setattr(storage, "get_json", lambda key: store.get(key))
    monkeypatch.setattr(server, "ANALYSIS_CACHE", {})
    an = asyncio.run(server._analysis_by_digest("x", current_only=False))
    assert an["vocal_source"] == "gemini:gemini-3.8-flash"
    assert an["content_sha1"] == "x"
