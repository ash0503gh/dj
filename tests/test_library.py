"""
test_library.py - Local mode: the library folder is prepared once (one track per audio however many
copies or names), re-runs only touch what changed, renames keep the track, and the console lists and
loads only prepared tracks, with uploads off.

    python -m pytest tests/test_library.py -q
"""

import os
import shutil
import sys

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend import library  # noqa: E402


@pytest.fixture
def lib(tmp_path, monkeypatch):
    music = tmp_path / "music"
    (music / "house").mkdir(parents=True)
    monkeypatch.setenv("PULSE_LIBRARY", str(music))
    monkeypatch.setenv("PULSE_DATA", str(tmp_path / "data"))
    monkeypatch.setattr(library, "_uploaded_labels", lambda: {})
    library._FEATURES.clear()
    calls = []

    def fake_analyze(path):
        calls.append(("analysis", os.path.basename(path)))
        if b"broken" in open(path, "rb").read():
            raise RuntimeError("could not decode")
        drift = b"drift" in open(path, "rb").read()
        return {"bpm": 124.0, "camelot": "8A", "key": "Am", "duration": 200.0, "loudness_db": -12.0,
                "grid": {"bpm": 124.0, "period": 60 / 124.0, "first_beat": 0.1, "downbeat_offset": 0,
                         "phrase_offset_bars": 0, "confidence": 0.9, "tempo_stable": not drift,
                         "drift_ms": 40.0 if drift else 2.0},
                "section_map": [], "suggested_cue_intro": 0.1, "suggested_cue_outro": 150.0,
                "analysis_version": library.ANALYSIS_VERSION}

    def fake_loudness(path):
        calls.append(("loudness", os.path.basename(path)))
        return {"loudness_lufs": -8.5, "loudness_range_lu": 5.0, "loudness_st": [-9.0] * 200}

    def fake_check(path, grid, duration):
        calls.append(("grid_check", os.path.basename(path)))
        spread = 35.0 if b"wander" in open(path, "rb").read() else 1.0
        return {"grid_err": {"start": 0.1, "window_sec": 7.74, "ms": [0.0, spread]}, "grid_err_spread_ms": spread}

    monkeypatch.setattr(library, "analyze_track", fake_analyze)
    monkeypatch.setattr(library, "measure_loudness", fake_loudness)
    monkeypatch.setattr(library, "check_track", fake_check)
    return music, calls


def prep(**kw):
    return library.prepare(workers=0, log=lambda m: None, **kw)


def test_prepare_one_track_per_audio_and_flags(lib):
    music, calls = lib
    (music / "a.mp3").write_bytes(b"audio a")
    (music / "house" / "a copy.mp3").write_bytes(b"audio a")      # same audio, another name and folder
    (music / "b.mp3").write_bytes(b"audio b drift")
    (music / "c.mp3").write_bytes(b"audio c wander")               # a grid the analyzer thinks is stable
    (music / "notes.txt").write_bytes(b"not audio")
    (music / ".hidden.mp3").write_bytes(b"hidden")

    res = prep()
    assert res["counts"]["ready"] == 3
    assert len([c for c in calls if c[0] == "analysis"]) == 3
    tracks = {t["title"]: t for t in library.ready_tracks()}
    assert set(tracks) == {"a.mp3", "b.mp3", "c.mp3"}
    assert tracks["a.mp3"]["flags"] == []
    assert tracks["b.mp3"]["flags"] == ["grid_drift"]
    assert tracks["c.mp3"]["flags"] == ["grid_drift"]       # caught by the grid check
    assert tracks["a.mp3"]["file_id"].startswith("lib_") and tracks["a.mp3"]["file_id"].endswith(".mp3")
    row = library.get(tracks["a.mp3"]["file_id"])
    assert row["analysis"]["loudness_lufs"] == -8.5
    assert row["analysis"]["content_sha1"] == row["sha1"]


def test_rerun_only_touches_what_changed(lib, monkeypatch):
    music, calls = lib
    (music / "a.mp3").write_bytes(b"audio a")
    prep()
    calls.clear()
    prep()
    assert calls == []

    # A newer loudness stage re-runs loudness only, keeping the analysis
    monkeypatch.setitem(library.STAGES, "loudness", library.STAGES["loudness"] + 1)
    prep()
    assert calls == [("loudness", "a.mp3")]
    assert library.ready_tracks()[0]["title"] == "a.mp3"

    # A newer analysis re-runs the grid check on its new grid too, but not loudness
    calls.clear()
    monkeypatch.setitem(library.STAGES, "analysis", library.STAGES["analysis"] + 1)
    prep()
    assert calls == [("analysis", "a.mp3"), ("grid_check", "a.mp3")]
    an = library.get(library.ready_tracks()[0]["file_id"])["analysis"]
    assert an["loudness_st"] == [-9.0] * 200 and an["grid_err"]["ms"] == [0.0, 1.0]


def test_rename_keeps_track_and_removal_marks_missing(lib):
    music, _ = lib
    (music / "a.mp3").write_bytes(b"audio a")
    prep()
    fid = library.ready_tracks()[0]["file_id"]

    os.rename(music / "a.mp3", music / "house" / "A (Extended).mp3")
    prep()
    tracks = library.ready_tracks()
    assert [t["file_id"] for t in tracks] == [fid]
    assert library.path_of(fid).endswith("A (Extended).mp3")

    os.remove(music / "house" / "A (Extended).mp3")
    res = prep()
    assert res["counts"]["missing"] == 1 and library.ready_tracks() == []
    assert library.path_of(fid) is None


def test_failed_track_is_not_ready_and_retried_on_request(lib):
    music, calls = lib
    (music / "bad.mp3").write_bytes(b"broken")
    res = prep()
    assert res["counts"]["failed"] == 1 and res["failed"][0]["error"] == "could not decode"
    calls.clear()
    prep()
    assert calls == []                      # not retried by default
    prep(retry_failed=True)
    assert ("analysis", "bad.mp3") in calls


def test_measure_loudness_ebu_r128(tmp_path):
    # A 997 Hz sine at half scale: -3.01 LUFS at full scale (BS.1770), -6.02 dB for the half
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg not installed")
    sr = 48000
    t = np.arange(10 * sr) / sr
    path = str(tmp_path / "sine.wav")
    sf.write(path, 0.5 * np.sin(2 * np.pi * 997 * t), sr)
    res = library.measure_loudness(path)
    assert abs(res["loudness_lufs"] - (-9.03)) < 0.3
    assert len(res["loudness_st"]) in (9, 10) and all(abs(v - (-9.03)) < 0.3 for v in res["loudness_st"][3:])


def test_server_local_mode(lib):
    music, _ = lib
    (music / "a.mp3").write_bytes(b"audio a")
    prep()
    (music / "new.mp3").write_bytes(b"audio new")        # added after preparing
    library.index(library._connect(), str(music), log=lambda m: None)

    from backend import server
    client = TestClient(server.app)
    presets = client.get("/api/presets").json()
    assert presets["mode"] == "local"
    assert [t["title"] for t in presets["tracks"]] == ["a.mp3"]
    assert presets["library"]["counts"]["pending"] == 1

    fid = presets["tracks"][0]["file_id"]
    loaded = client.post("/api/load-preset", data={"file_id": fid, "deck": "deck_1"}).json()["track"]
    assert loaded["bpm"] == 124.0 and loaded["audio_url"] == f"/api/audio/{fid}"
    assert client.get(loaded["audio_url"]).content == b"audio a"

    pending = [r for r in library._connect().execute("SELECT file_id FROM tracks WHERE status = 'pending'")]
    assert client.post("/api/load-preset", data={"file_id": pending[0]["file_id"]}).status_code == 409
    assert client.post("/api/load-preset", data={"file_id": "lib_nothere.mp3"}).status_code == 404

    up = client.post("/api/upload", files={"file": ("x.mp3", b"x", "audio/mpeg")}, data={"deck": "deck_1"})
    assert up.status_code == 403

    # A grid fix lands in the library index
    r = client.post("/api/grid-adjust", json={"file_id": fid, "shift_beats": 1})
    assert r.status_code == 200
    assert library.get(fid)["analysis"]["grid"]["downbeat_offset"] == 1
    r = client.post("/api/grid-adjust", json={"file_id": fid, "shift_ms": 5})
    assert library.get(fid)["analysis"]["grid_err"]["ms"] == [-5.0, -4.0]     # kicks now 5 ms earlier on it
    assert library.get(fid)["status"] == "ready"
