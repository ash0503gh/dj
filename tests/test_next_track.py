"""
test_next_track.py - Next-track suggestions: a track that can blend (close tempo) in a matching key
with room to blend in ranks first; the same song under another name is suggested once; the track
on air, the other deck's track and their other copies are never suggested.

    python -m pytest tests/test_next_track.py -q
"""

import os
import sys
import tempfile

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend import next_track, server  # noqa: E402


def analysis(fid, bpm, key, sha, sung_from=40.0, loud=-7.0):
    """A labelled analysis: 4-bar sections, instrumental until `sung_from`."""
    bar = 4 * 60.0 / bpm
    sections = [{"time": t * 4 * bar, "duration": 4 * bar, "energy": 1.0, "vocal_score": 1.0,
                 "has_vocals": t * 4 * bar >= sung_from} for t in range(12)]
    return {"file_id": fid, "title": fid, "bpm": bpm, "camelot": key, "duration": 200.0, "loudness_db": loud,
            "suggested_cue_intro": 0.0, "section_map": sections, "vocal_source": "gemini:x", "content_sha1": sha,
            "analysis_version": server.ANALYSIS_VERSION}


LIB = [
    analysis("deck_1_on_air.mp3", 122.0, "8A", "a"),
    analysis("deck_2_on_air.mp3", 122.0, "8A", "a"),        # the same song on the other deck
    analysis("deck_1_blends.mp3", 122.0, "9A", "b"),        # close tempo, matching key, 20-bar intro
    analysis("deck_2_blends.mp3", 122.0, "9A", "b"),        # ...uploaded twice
    analysis("deck_1_rubs.mp3", 124.0, "3A", "c"),          # close tempo, clashing key
    analysis("deck_1_far.mp3", 95.0, "8A", "d"),            # matching key, tempo gap: switch only
    analysis("deck_1_short.mp3", 122.0, "8A", "e", sung_from=0.0),  # vocals from its first beat
]


def test_blendable_matching_key_with_intro_ranks_first():
    lib = [next_track.features(a) for a in LIB]
    out = lib[0]
    ranked = next_track.rank(out, 122.0, lib)
    names = [r["file_id"] for r in ranked]
    assert names[0] in ("deck_1_blends.mp3", "deck_2_blends.mp3")
    assert sum(n.endswith("blends.mp3") for n in names) == 1          # one copy per song
    assert not any(n.endswith("on_air.mp3") for n in names)          # never the track on air
    assert names.index("deck_1_short.mp3") > 0                       # no room to blend in
    assert names.index("deck_1_rubs.mp3") < names.index("deck_1_far.mp3")
    top = ranked[0]
    assert top["blend"] and top["key_severity"] == 0 and top["intro_bars"] >= 16
    far = next(r for r in ranked if r["file_id"] == "deck_1_far.mp3")
    assert not far["blend"] and "switch only" in far["reasons"][0]


def test_excluded_songs_are_skipped_in_every_copy():
    lib = [next_track.features(a) for a in LIB]
    ranked = next_track.rank(lib[0], 122.0, lib, exclude=["deck_2_blends.mp3"])
    assert not any(r["file_id"].endswith("blends.mp3") for r in ranked)


def test_endpoint(monkeypatch):
    with tempfile.TemporaryDirectory() as d:
        monkeypatch.setattr(server, "UPLOAD_DIR", d)
        monkeypatch.setattr(server, "CACHE_FILE", os.path.join(d, "analysis_cache.json"))
        monkeypatch.setattr(server, "ANALYSIS_CACHE", {a["file_id"]: a for a in LIB})
        for a in LIB:                                 # the library: analyses with their audio
            open(os.path.join(d, a["file_id"]), "wb").close()
        res = TestClient(server.app).get("/api/suggest-next", params=[
            ("file_id", "deck_1_on_air.mp3"), ("bpm", "122"), ("exclude", "deck_1_rubs.mp3")]).json()
        names = [s["file_id"] for s in res["suggestions"]]
        assert res["status"] == "success"
        assert names[0].endswith("blends.mp3")
        assert "deck_1_rubs.mp3" not in names and not any(n.endswith("on_air.mp3") for n in names)
