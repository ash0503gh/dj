"""
test_grid_check.py - The grid check finds where the kicks really sit against a track's grid: about 0 all
along a quantized track, the true offset on a track whose tempo drifts (a live drummer), and nothing in
a breakdown with no kick.

    python -m pytest tests/test_grid_check.py -q
"""

import os
import sys
import warnings

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tests.synth import make_track, SR  # noqa: E402
from backend.audio_analyzer import analyze_track  # noqa: E402
from backend.grid_check import check_track, DRIFT_FLAG_MS  # noqa: E402


def measured_vs_truth(tmp_path, drift_bpm):
    y, truth = make_track(bpm=124.0, first_beat=0.2, seed=3, drift_bpm=drift_bpm)
    path = str(tmp_path / f"t{drift_bpm}.wav")
    sf.write(path, y, SR)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        an = analyze_track(path)
    res = check_track(path, an["grid"], an["duration"])
    grid_beats, true_beats = np.array(an["beat_times"]), truth["beat_times"]
    i = np.clip(np.searchsorted(grid_beats, true_beats), 1, len(grid_beats) - 1)
    near = np.where(np.abs(grid_beats[i - 1] - true_beats) < np.abs(grid_beats[i] - true_beats),
                    grid_beats[i - 1], grid_beats[i])
    err_ms = (true_beats - near) * 1000.0
    ge = res["grid_err"]
    rows = []
    for k, v in enumerate(ge["ms"]):
        t0 = ge["start"] + k * ge["window_sec"]
        inside = (true_beats >= t0) & (true_beats < t0 + ge["window_sec"])
        rows.append((t0, v, float(np.median(err_ms[inside])) if inside.any() else None))
    return res, rows


def test_quantized_track_sits_on_its_grid(tmp_path):
    res, rows = measured_vs_truth(tmp_path, 0.0)
    measured = [v for _, v, _ in rows if v is not None]
    assert len(measured) >= 15 and max(abs(v) for v in measured) < 3.0
    assert res["grid_err_spread_ms"] < DRIFT_FLAG_MS
    # The synthetic breakdown (bars 32-48) has no kick: not measured
    assert all(v is None for t0, v, _ in rows if 32 * 4 * 60 / 124.0 + 1 < t0 < 47 * 4 * 60 / 124.0)


def test_drifting_track_measured_and_flagged(tmp_path):
    res, rows = measured_vs_truth(tmp_path, 0.5)
    pairs = [(v, tr) for _, v, tr in rows if v is not None and tr is not None]
    assert len(pairs) >= 12
    assert max(abs(v - tr) for v, tr in pairs) < 5.0          # within 5 ms of where the kicks really are
    assert res["grid_err_spread_ms"] > DRIFT_FLAG_MS
