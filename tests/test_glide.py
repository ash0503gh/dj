"""
test_glide.py - Keylocked tempo glides (backend/glide.py): along a window whose tempo eases from one
speed to another, every kick lands where the time map puts it (within 2 ms), the lead-in lines up with
the file the deck plays before the glide (the track, or its keylocked copy), and the map is the
frontend's (same formula, checked at a few points).

    python -m pytest tests/test_glide.py -q
"""

import os
import sys
import warnings

import numpy as np
import pytest
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tests.synth import make_track, SR  # noqa: E402
from backend import glide  # noqa: E402
from backend.stretch import stretch_file  # noqa: E402
from backend.audio_analyzer import analyze_track  # noqa: E402


@pytest.fixture(scope="module")
def song(tmp_path_factory):
    d = tmp_path_factory.mktemp("glide")
    y, truth = make_track(bpm=124.0, first_beat=0.2, seed=3)
    path = str(d / "song.wav")
    sf.write(path, y, SR)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        an = analyze_track(path)
    return d, path, an, truth


def kick_errors_ms(rendered, beats, start, at, length, s0, s1):
    """Each kick's lag (ms) against where the map puts it, by matching the kick's shape."""
    y, sr = sf.read(rendered)
    y = y.mean(axis=1) if y.ndim > 1 else y
    t = np.arange(int(0.12 * sr)) / sr
    kick = np.sin(2 * np.pi * np.cumsum(50 + 100 * np.exp(-t / 0.03)) / sr) * np.exp(-t / 0.18)
    errs = []
    for b in glide.buffer_time(beats, start, at, length, s0, s1):
        c, w = int(round(b * sr)), int(0.03 * sr)
        if c - w < int(1.5 * sr) or c + w + len(kick) > len(y):
            continue
        cc = np.correlate(y[c - w:c + w + len(kick)], kick, 'valid')
        errs.append((np.argmax(cc) - w) / sr * 1000)
    return np.array(errs)


def kick_beats(truth, t0, t1):
    """The true beats in [t0, t1) that carry a kick (the breakdown has none)."""
    beats = np.array(truth["beat_times"])
    return beats[(beats >= t0) & (beats < t1)]


@pytest.mark.parametrize("s0,s1", [(1.0, 1.09), (1.0, 0.92)])
def test_kicks_follow_the_map_along_the_glide(song, s0, s1):
    d, path, an, truth = song
    at = truth["beat_times"][20]               # glides start on a beat (a bar line, live)
    start, length, end = at - 8.0, 24.0, at + 40.0
    dst = str(d / f"g_{s1}.flac")
    glide.render(path, dst, start, end, at, length, s0, s1)
    beats = kick_beats(truth, start, end)
    errs = kick_errors_ms(dst, beats, start, at, length, s0, s1)
    assert len(errs) > 40
    assert np.abs(errs).max() < 2.0, errs.round(2)
    expected = float(glide.buffer_time(end, start, at, length, s0, s1))
    assert abs(sf.info(dst).duration - expected) < 0.2


def test_lines_up_with_the_keylocked_copy_it_follows(song):
    """A deck on its keylocked copy at 1.05 glides back to the track's own tempo."""
    d, path, an, truth = song
    copy = stretch_file(path, 1.05, str(d / "stretch"), an["grid"])
    at = truth["beat_times"][60]               # (the kicks stop at the breakdown, beat 128)
    start, length, end = at - 8.0, 20.0, at + 28.0
    dst = str(d / "back.flac")
    glide.render(path, dst, start, end, at, length, 1.05, 1.0, reference=copy, ref_ratio=1.05)
    # the lead-in matches the copy sample for sample: the deck can switch between them anywhere in it
    g, _ = sf.read(dst)
    c, _ = sf.read(copy)
    i0 = int(round(1.5 * SR))
    j0 = int(round((start + 1.5 * 1.05) / 1.05 * SR))
    n = int(4 * SR)
    def mono(x):
        return x.mean(axis=1) if x.ndim > 1 else x
    a, b = mono(g[i0:i0 + n]), mono(c[j0:j0 + n])
    lag = np.argmax(np.correlate(a, b[200:-200], 'valid')) - 200
    assert abs(lag) <= int(0.001 * SR)
    errs = kick_errors_ms(dst, kick_beats(truth, start, end), start, at, length, 1.05, 1.0)
    assert np.abs(errs).max() < 2.5, errs.round(2)


def test_map_matches_the_closed_form():
    start, at, length, s0, s1 = 5.0, 9.0, 16.0, 1.0, 1.1
    k = (s1 - s0) / length
    assert glide.buffer_time(7.0, start, at, length, s0, s1) == pytest.approx(2.0)
    assert glide.buffer_time(17.0, start, at, length, s0, s1) == pytest.approx(4.0 + np.log((s0 + 8 * k) / s0) / k)
    after = 4.0 + np.log(s1 / s0) / k + 10.0 / s1
    assert glide.buffer_time(35.0, start, at, length, s0, s1) == pytest.approx(after)
    # the steps the renderer sends integrate to the same map
    cmds = [ln.split() for ln in glide.commands(start, 40.0, at, length, s0, s1, "rubberband@glide").splitlines()]
    times = np.array([float(c[0]) for c in cmds] + [35.0 - start])
    speeds = np.array([float(c[3].rstrip(';')) for c in cmds])
    assert np.sum(np.diff(times) / speeds) == pytest.approx(after, abs=1e-4)


def test_refuses_a_window_without_a_lead_in(song, tmp_path):
    with pytest.raises(ValueError):
        glide.render(song[1], str(tmp_path / "x.flac"), 9.0, 30.0, 10.0, 10.0, 1.0, 1.05)


def test_endpoint_renders_and_checks_its_window(song, tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from backend import server
    d, path, an, truth = song

    async def inline(fn, *a, **kw):
        return fn(*a, **kw)

    async def track(file_id):
        return path if file_id == "song.wav" else None

    async def analysis(fid):
        return an

    monkeypatch.setattr(server, "heavy", inline)
    monkeypatch.setattr(server, "local_track", track)
    monkeypatch.setattr(server, "get_cached_analysis", analysis)
    monkeypatch.setattr(server, "GLIDE_DIR", str(tmp_path / "glides"))
    monkeypatch.setattr(server, "STRETCH_DIR", str(tmp_path / "stretch"))
    client = TestClient(server.app)
    at = float(truth["beat_times"][40])
    q = {"start": at - 6, "end": at + 30, "at": at, "length": 16, "s0": 1.04, "s1": 1.0}
    res = client.get("/api/glide/song.wav", params=q)
    assert res.status_code == 200 and res.headers["content-type"] == "audio/flac"
    out = tmp_path / "g.flac"
    out.write_bytes(res.content)
    expected = float(glide.buffer_time(q["end"], q["start"], at, 16, 1.04, 1.0))
    assert abs(sf.info(str(out)).duration - expected) < 0.2
    assert os.listdir(tmp_path / "stretch")                 # lined up with the keylocked copy at 1.04
    assert client.get("/api/glide/song.wav", params=dict(q, start=at - 1)).status_code == 400    # no lead-in
    assert client.get("/api/glide/song.wav", params=dict(q, s1=1.4)).status_code == 400
    assert client.get("/api/glide/nope.wav", params=q).status_code == 404
