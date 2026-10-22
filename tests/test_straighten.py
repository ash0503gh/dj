"""
test_straighten.py - Live-played tracks put on a steady beat (backend/straighten.py): a track whose tempo
drifts by a few BPM (a drummer speeding up) is followed kick by kick, rendered on its average tempo, and
the copy's kicks sit on one grid (the grid check's wander drops from ~200 ms to a few ms); its length and
pitch are kept. A steady track isn't touched, and a map with a misread is refused.

    python -m pytest tests/test_straighten.py -q
"""

import os
import sys
import warnings

import numpy as np
import pytest
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tests.synth import make_track, SR  # noqa: E402
from backend import straighten  # noqa: E402
from backend.audio_analyzer import analyze_track  # noqa: E402
from backend.grid_check import check_track  # noqa: E402


def analysed(path):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        an = analyze_track(path)
    an.update(check_track(path, an["grid"], an["duration"]))
    return an


@pytest.fixture(scope="module")
def drummer(tmp_path_factory):
    d = tmp_path_factory.mktemp("straighten")
    y, truth = make_track(bpm=124.0, first_beat=0.2, seed=5, drift_bpm=3.0)    # 124 -> 127 BPM
    path = str(d / "live.wav")
    sf.write(path, y, SR)
    return d, path, analysed(path), truth


def test_drifting_track_is_followed_and_put_on_one_grid(drummer):
    d, path, an, truth = drummer
    assert straighten.drifting(an) and an["grid_err_spread_ms"] > 100
    dst = str(d / "straight.flac")
    info = straighten.straighten(path, dst, an)
    assert info and info["points"] > 50 and info["max_change_pct"] < 3
    copy = analysed(dst)
    assert copy["grid_err_spread_ms"] < 5, copy["grid_err"]["ms"]
    assert not straighten.drifting(copy)
    assert abs(copy["duration"] - an["duration"]) < 0.5
    assert 124 < copy["bpm"] < 127                       # the track's average tempo


def test_kicks_are_followed_through_the_drift(drummer):
    d, path, an, truth = drummer
    from backend.audio_analyzer import load_mono, ANALYSIS_SR
    g = an["grid"]
    first = g["first_beat"] + (g.get("downbeat_offset") or 0) * g["period"]
    beats = straighten.follow_kicks(load_mono(path, ANALYSIS_SR), ANALYSIS_SR, first, g["period"], an["duration"])
    true = np.array(truth["beat_times"])
    found = [t for t, hit in beats if hit]
    err = [abs(true[np.argmin(np.abs(true - t))] - t) * 1000 for t in found]
    assert len(found) > 250 and np.median(err) < 3 and max(err) < 25


def test_steady_track_is_left_alone(tmp_path):
    y, _ = make_track(bpm=124.0, first_beat=0.2, seed=6)
    path = str(tmp_path / "steady.wav")
    sf.write(path, y, SR)
    assert not straighten.drifting(analysed(path))


def speeds(m):
    return [(a1 - a0) / (b1 - b0) for (a0, b0), (a1, b1) in zip(m, m[1:])]


def test_misread_kicks_dont_bend_it_and_a_tempo_jump_is_refused():
    steady = straighten.time_map([(0.5 + k * 0.48, True) for k in range(200)])
    assert steady and all(abs(s - 1) < 1e-6 for s in speeds(steady))
    beats = [(0.5 + k * 0.48, True) for k in range(200)]
    beats[100:104] = [(t + 0.2, True) for t, _ in beats[100:104]]      # a bar read 200 ms late
    m = straighten.time_map(beats)
    assert m and all(abs(s - 1) < 0.005 for s in speeds(m))           # left out, not followed
    jump = [(0.5 + k * 0.48 if k < 100 else 0.5 + 100 * 0.48 + (k - 100) * 0.38, True) for k in range(200)]
    assert straighten.time_map(jump) is None                            # 20% faster at once: not drift
