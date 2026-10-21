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

NN_DOWN = set()     # file names whose neural tracker fails (no model, say)


@pytest.fixture
def lib(tmp_path, monkeypatch):
    music = tmp_path / "music"
    (music / "house").mkdir(parents=True)
    monkeypatch.setenv("PULSE_LIBRARY", str(music))
    monkeypatch.setenv("PULSE_DATA", str(tmp_path / "data"))
    monkeypatch.setattr(library, "_uploaded_labels", lambda: {})
    library._FEATURES.clear()
    # Every stage, whatever is installed here: the neural tracker and the key extractor are stubbed
    monkeypatch.setattr(library, "STAGES", {"beats_nn": 1, "analysis": library.ANALYSIS_VERSION, "key": 1,
                                            "loudness": 2, "grid_check": 1})
    calls = []
    NN_DOWN.clear()

    def fake_beats(path):
        calls.append(("beats_nn", os.path.basename(path)))
        if os.path.basename(path) in NN_DOWN:
            raise RuntimeError("no model")
        return {"nn_beats": [0.1, 0.58], "nn_downbeats": [0.1], "nn_bpm": 124.0}

    def fake_key(path):
        calls.append(("key", os.path.basename(path)))
        return {"key": "E Minor", "mode": "minor", "camelot": "9A", "key_source": "essentia-edma"}

    def fake_analyze(path, nn=None):
        calls.append(("analysis", os.path.basename(path)))
        if b"broken" in open(path, "rb").read():
            raise RuntimeError("could not decode")
        drift = b"drift" in open(path, "rb").read()
        return {"bpm": 124.0, "camelot": "8A", "key": "Am", "duration": 200.0, "loudness_db": -12.0,
                "grid": {"bpm": 124.0, "period": 60 / 124.0, "first_beat": 0.1, "downbeat_offset": 0,
                         "phrase_offset_bars": 0, "confidence": 0.9, "tempo_stable": not drift,
                         "drift_ms": 40.0 if drift else 2.0, "downbeat_source": "neural" if nn else "grid"},
                "section_map": [{"time": 0.1, "duration": 7.74, "has_vocals": True, "vocal_score": 0.6},
                                {"time": 7.84, "duration": 7.74, "has_vocals": True, "vocal_score": 0.6}],
                "suggested_cue_intro": 0.1, "suggested_cue_outro": 150.0,
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
    monkeypatch.setattr(library.beats_nn, "track_beats", fake_beats)
    monkeypatch.setattr(library.beats_nn, "load", lambda device=None: None)
    monkeypatch.setattr(library.key_detect, "detect_key", fake_key)
    monkeypatch.setattr(library.key_detect, "read_tags", lambda path: {"bpm": 124.0, "key": "Am", "camelot": "8A"})
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
    assert [c[0] for c in calls if c[1] == "a.mp3"] == ["beats_nn", "analysis", "key", "loudness", "grid_check"]
    tracks = {t["title"]: t for t in library.ready_tracks()}
    assert set(tracks) == {"a.mp3", "b.mp3", "c.mp3"}
    assert tracks["a.mp3"]["flags"] == []
    assert tracks["b.mp3"]["flags"] == ["grid_drift"]
    assert tracks["c.mp3"]["flags"] == ["grid_drift"]       # caught by the grid check
    assert tracks["a.mp3"]["file_id"].startswith("lib_") and tracks["a.mp3"]["file_id"].endswith(".mp3")
    row = library.get(tracks["a.mp3"]["file_id"])
    assert row["analysis"]["loudness_lufs"] == -8.5
    assert row["analysis"]["content_sha1"] == row["sha1"]


def test_listing_tells_folder_age_and_how_much_is_sung(lib):
    """What the browser's crates sort by: the sub-folder, when the file came in, how much is sung."""
    music, calls = lib
    (music / "house" / "deep").mkdir()
    (music / "top.mp3").write_bytes(b"audio top")
    (music / "house" / "deep" / "low.mp3").write_bytes(b"audio low")
    prep()
    tracks = {t["title"]: t for t in library.ready_tracks()}
    assert tracks["top.mp3"]["folder"] == "" and tracks["low.mp3"]["folder"] == "house/deep"
    assert all(t["added"] > 0 for t in tracks.values())
    assert tracks["top.mp3"]["sung"] is None                  # no vocal labels yet: unknown, not instrumental
    fid = tracks["top.mp3"]["file_id"]
    an = library.get(fid)["analysis"]
    an["vocal_source"] = "stems:htdemucs"
    an["section_map"][1]["has_vocals"] = False
    library.save_analysis(fid, an)
    assert {t["title"]: t for t in library.ready_tracks()}["top.mp3"]["sung"] == 0.5


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

    # A newer analysis re-runs the key (it replaces the analysis's) and the grid check on its new grid
    # too, but not loudness or the neural beats
    calls.clear()
    monkeypatch.setitem(library.STAGES, "analysis", library.STAGES["analysis"] + 1)
    prep()
    assert calls == [("analysis", "a.mp3"), ("key", "a.mp3"), ("grid_check", "a.mp3")]
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


def test_neural_beats_optional_and_second_opinion(lib):
    music, calls = lib
    (music / "x.mp3").write_bytes(b"audio x")
    NN_DOWN.add("x.mp3")
    res = prep()
    assert res["counts"]["ready"] == 1                      # ready without the neural opinion
    row = library.get(library.ready_tracks()[0]["file_id"])
    assert row["analysis"]["grid"]["downbeat_source"] == "grid" and "beats_nn" not in row["stages"]

    calls.clear()
    prep()
    assert calls == [("beats_nn", "x.mp3")]                 # tried again, nothing re-run for it failing

    NN_DOWN.clear()
    calls.clear()
    prep()
    # it ran: the analysis takes its opinion, and what builds on the analysis runs again
    assert calls == [("beats_nn", "x.mp3"), ("analysis", "x.mp3"), ("key", "x.mp3"), ("grid_check", "x.mp3")]
    an = library.get(library.ready_tracks()[0]["file_id"])["analysis"]
    assert an["grid"]["downbeat_source"] == "neural" and an["nn_bpm"] == 124.0
    assert an["loudness_st"] == [-9.0] * 200                # kept from before


def test_key_stage_replaces_the_estimate_and_keeps_it(lib):
    music, _ = lib
    (music / "k.mp3").write_bytes(b"audio k")
    prep()
    an = library.get(library.ready_tracks()[0]["file_id"])["analysis"]
    assert an["camelot"] == "9A" and an["key_source"] == "essentia-edma"
    assert an["key_ks"] == "8A" and an["tags"]["camelot"] == "8A"


def test_grid_fix_survives_reanalysis_and_grid_ok_clears_flags(lib, monkeypatch):
    music, _ = lib
    (music / "d.mp3").write_bytes(b"audio d drift")
    prep()
    fid = library.ready_tracks()[0]["file_id"]
    assert library.ready_tracks()[0]["flags"] == ["grid_drift"]

    from backend import server
    client = TestClient(server.app)
    assert client.post("/api/grid-adjust", json={"file_id": fid, "shift_beats": 1}).json()["track"]["flags"] == ["grid_drift"]
    assert client.post("/api/grid-confirm", json={"file_id": fid}).json()["flags"] == []
    assert library.ready_tracks()[0]["flags"] == []

    # A newer analyzer finds the same tempo: the DJ's downbeat and confirmation stay
    monkeypatch.setitem(library.STAGES, "analysis", library.STAGES["analysis"] + 1)
    prep()
    an = library.get(fid)["analysis"]
    assert an["grid"]["downbeat_offset"] == 1 and an["grid_confirmed"] and library.ready_tracks()[0]["flags"] == []


def id3(tags: bytes) -> bytes:
    """An ID3v2.3 tag block holding `tags` (as the frame data: enough to test skipping it)."""
    n = len(tags)
    return b"ID3\x03\x00\x00" + bytes([(n >> 21) & 0x7F, (n >> 14) & 0x7F, (n >> 7) & 0x7F, n & 0x7F]) + tags


def test_audio_fingerprint_ignores_tags(tmp_path):
    audio = b"\xff\xfb" + bytes(range(256)) * 40
    plain, tagged, retagged, other = (tmp_path / f"{n}.mp3" for n in ("p", "t", "r", "o"))
    plain.write_bytes(audio)
    tagged.write_bytes(id3(b"TIT2 My Song" * 50) + audio + b"TAG" + bytes(125))
    # APEv2 footer: its size counts the items and the footer (no header here)
    ape = b"APETAGEX" + (2000).to_bytes(4, "little") + (8 + 32).to_bytes(4, "little") + bytes(16)
    retagged.write_bytes(id3(b"GEOB Serato Markers" * 300) + audio + b"x" * 8 + ape)
    other.write_bytes(id3(b"TIT2 My Song" * 50) + audio[:-1] + b"\x00")
    h = library.audio_sha1
    assert h(str(plain)) == h(str(tagged)) == h(str(retagged)) != h(str(other))


def test_retagged_file_stays_the_same_track_for_free(lib):
    music, calls = lib
    path = music / "song.mp3"
    path.write_bytes(b"\xff\xfb audio frames")
    prep()
    fid = library.ready_tracks()[0]["file_id"]
    calls.clear()
    path.write_bytes(id3(b"TKEY 8A, written by Mixed In Key") + b"\xff\xfb audio frames")
    prep()
    assert calls == [] and [t["file_id"] for t in library.ready_tracks()] == [fid]


def test_old_whole_file_fingerprints_migrate_keeping_everything(lib):
    music, calls = lib
    path = music / "song.mp3"
    path.write_bytes(id3(b"TIT2 Song") + b"\xff\xfb audio frames")
    prep()
    fid = library.ready_tracks()[0]["file_id"]
    # As an index from before audio fingerprints left it: whole-file hashes, version 0
    con = library._connect()
    whole = library._sha1_file(str(path))
    con.execute("UPDATE tracks SET sha1 = ?", (whole,))
    con.execute("UPDATE files SET sha1 = ?", (whole,))
    con.execute("PRAGMA user_version = 0")
    con.commit()
    calls.clear()
    prep()
    assert calls == [] and [t["file_id"] for t in library.ready_tracks()] == [fid]
    assert library.get(fid)["sha1"] == library.audio_sha1(str(path))


def test_listen_once_with_estimate_budget_and_no_repeat(lib, monkeypatch):
    music, _ = lib
    for n in ("a", "b", "c"):
        (music / f"{n}.mp3").write_bytes(f"audio {n}".encode())
    prep()
    heard = []

    def fake_listen(path, sections, key, model, usage=None):
        heard.append(os.path.basename(path))
        usage.update(promptTokenCount=8000, candidatesTokenCount=500, thoughtsTokenCount=1500)
        return [True, False], None

    monkeypatch.setattr("backend.vocal_listen.listen_for_vocals", fake_listen)
    monkeypatch.setattr("backend.ai_advisor.get_gemini_api_key", lambda *a: "key")
    assert len(library.unlistened()) == 3 and all(t["est_inr"] > 0 for t in library.unlistened())

    assert library.listen(log=lambda m: None, ask=lambda q: "n")["listened"] == 0 and heard == []
    one = library.inr(8000, 2000)
    res = library.listen(log=lambda m: None, ask=lambda q: "y", max_inr=1.5 * library.unlistened()[0]["est_inr"])
    assert res["listened"] == 1 and res["inr"] == round(one, 2)            # stopped at the budget
    res = library.listen(yes=True, log=lambda m: None)
    assert res["listened"] == 2 and len(heard) == 3 and library.unlistened() == []
    assert library.listen(yes=True, log=lambda m: None)["listened"] == 0 and len(heard) == 3   # never twice
    an = library.get(library.ready_tracks()[0]["file_id"])["analysis"]
    assert an["vocal_source"].startswith("gemini:") and [s["has_vocals"] for s in an["section_map"]] == [True, False]


def test_console_never_pays_for_listening_in_local_mode(lib, monkeypatch):
    music, _ = lib
    (music / "a.mp3").write_bytes(b"audio a")
    prep()
    monkeypatch.setattr("backend.vocal_listen.listen_for_vocals", lambda *a, **k: pytest.fail("Gemini called"))
    from backend import server
    fid = library.ready_tracks()[0]["file_id"]
    assert TestClient(server.app).post("/api/listen-vocals", json={"file_id": fid}).json()["status"] == "skipped"


@pytest.fixture
def with_stems(lib, monkeypatch):
    """The library with the stems and vocals stages; the separator stubbed (it writes silent stems), the
    vocal stem read as singing in the first section only."""
    monkeypatch.setitem(library.STAGES, "stems", 1)
    monkeypatch.setitem(library.STAGES, "vocals", 1)
    music, calls = lib
    loaded = []

    def fake_separate(path, folder):
        calls.append(("stems", os.path.basename(path)))
        os.makedirs(folder, exist_ok=True)
        for p in library.stems.paths(folder).values():
            open(p, "wb").write(b"opus")
        return {"stems_model": "demucs:htdemucs"}

    def fake_sung(vocal_path, track_path):
        calls.append(("vocals", os.path.basename(track_path)))
        return np.array([True] * int(7.74 / library.stems.FRAME_SEC) + [False] * 400)

    monkeypatch.setattr(library.stems, "separate", fake_separate)
    monkeypatch.setattr(library.stems, "sung_frames", fake_sung)
    monkeypatch.setattr(library.stems, "load", lambda device=None: loaded.append(1))
    monkeypatch.setattr(library.stems, "_device_used", "cpu", raising=False)
    return music, calls, loaded


def test_stems_separated_after_the_rest_and_label_vocals(with_stems, monkeypatch):
    music, calls, loaded = with_stems
    (music / "s.mp3").write_bytes(b"audio s")
    prep()
    order = [c[0] for c in calls if c[1] == "s.mp3"]
    assert order == ["beats_nn", "analysis", "key", "loudness", "grid_check", "stems", "vocals"]
    assert loaded == [1]                                   # the model loaded once, in this process
    fid = library.ready_tracks()[0]["file_id"]
    an = library.get(fid)["analysis"]
    assert an["vocal_source"] == "stems:htdemucs" and [s["has_vocals"] for s in an["section_map"]] == [True, False]
    monkeypatch.setattr("backend.ai_advisor.get_gemini_api_key", lambda *a: "key")
    assert library.unlistened() == []                      # nothing left to pay Gemini for

    from backend import server
    client = TestClient(server.app)
    assert client.get(f"/api/track-stems/{fid}/vocals").content == b"opus"
    assert client.get(f"/api/track-stems/{fid}/lead").status_code == 404
    assert client.post("/api/load-preset", data={"file_id": fid}).json()["track"]["stems"] is True

    # A newer analysis relabels from the stems it has, without separating again
    calls.clear()
    monkeypatch.setitem(library.STAGES, "analysis", library.STAGES["analysis"] + 1)
    prep()
    assert [c[0] for c in calls] == ["analysis", "key", "grid_check", "vocals"]

    # Stems deleted from disk: separated again
    calls.clear()
    for p in library.stems.paths(library.stems_folder(fid)).values():
        os.remove(p)
    prep()
    assert [c[0] for c in calls] == ["stems", "vocals"]


def test_without_the_separator_tracks_are_still_ready(with_stems, monkeypatch):
    music, calls, _ = with_stems
    monkeypatch.setattr(library.stems, "load", lambda device=None: (_ for _ in ()).throw(RuntimeError("offline")))
    (music / "s.mp3").write_bytes(b"audio s")
    res = prep()
    assert res["counts"]["ready"] == 1 and not any(c[0] == "stems" for c in calls)
    an = library.get(library.ready_tracks()[0]["file_id"])["analysis"]
    assert "vocal_source" not in an


def test_song_name_ignores_what_copies_and_sites_add():
    names = ["Mitran Di Chhatri-Babbu Maan.mp3", "Mitran Di Chhatri-Babbu Maan (1).mp3",
             "07 - Mitran Di Chhatri-Babbu Maan (Mp3Hungama.com).mp3", "Mitran_Di_Chhatri-Babbu_Maan_(320 kbps).mp3",
             "Mitran Di Chhatri-Babbu Maan - Copy.mp3", "deck_1_Mitran Di Chhatri-Babbu Maan [128k].mp3",
             "www.DJPunjab.com - Mitran Di Chhatri-Babbu Maan.mp3"]
    assert {library.song_name(n) for n in names} == {"mitrandichhatribabbumaan"}
    assert library.song_name("Mitran Di Chhatri (Remix)-Babbu Maan.mp3") != "mitrandichhatribabbumaan"


def test_copies_of_one_song_prepared_and_listed_once(lib, monkeypatch):
    music, calls = lib
    # (lengths and bitrates as ffprobe would give them)
    probe = {"Song.mp3": (335.2, 320000), "Song (1).mp3": (335.4, 128000), "Song (Extended).mp3": (402.0, 320000),
             "Other.mp3": (335.2, 320000)}
    monkeypatch.setattr(library, "_probe", lambda p: probe[os.path.basename(p)])
    for n in probe:
        (music / n).write_bytes(f"audio {n}".encode())
    res = prep()
    assert sorted(t["title"] for t in library.ready_tracks()) == ["Other.mp3", "Song (Extended).mp3", "Song.mp3"]
    assert res["counts"]["duplicate"] == 1
    assert not any(c[1] == "Song (1).mp3" for c in calls)            # never processed

    # The kept copy goes: the other one takes its place
    calls.clear()
    os.remove(music / "Song.mp3")
    prep()
    assert "Song (1).mp3" in [t["title"] for t in library.ready_tracks()]
    assert ("analysis", "Song (1).mp3") in calls


def test_a_prepared_copy_stays_the_one_listed(lib, monkeypatch):
    music, calls = lib
    probe = {"Song.mp3": (300.0, 128000), "Song (320 kbps).mp3": (300.3, 320000)}
    monkeypatch.setattr(library, "_probe", lambda p: probe[os.path.basename(p)])
    (music / "Song.mp3").write_bytes(b"audio low")
    prep()
    (music / "Song (320 kbps).mp3").write_bytes(b"audio high")
    calls.clear()
    prep()
    assert [t["title"] for t in library.ready_tracks()] == ["Song.mp3"] and calls == []


def test_mix_log_keeps_entries_newest_first(lib):
    from backend import server
    client = TestClient(server.app)
    for i in range(3):
        assert client.post("/api/mix-log", json={"label": f"mix {i}", "live": {"entry_rise_db": i}}).json()["count"] == i + 1
    got = client.get("/api/mix-log", params={"limit": 2}).json()["entries"]
    assert [e["label"] for e in got] == ["mix 2", "mix 1"]
    assert os.path.exists(os.path.join(os.environ["PULSE_DATA"], "mix_log.jsonl"))    # next to the library index
