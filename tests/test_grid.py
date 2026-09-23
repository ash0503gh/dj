"""
test_grid.py - Beat-grid accuracy on synthetic tracks with known ground truth.

    python -m pytest tests/test_grid.py -q        # pass/fail
    python tests/test_grid.py                     # table of errors per case
    python tests/test_grid.py --old path/to/old_audio_analyzer.py   # same table for another analyzer
"""

import os
import sys
import tempfile
import importlib.util

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tests.synth import make_track, SR  # noqa: E402

CASES = [
    dict(bpm=126.0, first_beat=0.0, pickup_beats=0, pre_bars=0),
    dict(bpm=122.37, first_beat=0.123, pickup_beats=1, pre_bars=2),
    dict(bpm=118.0, first_beat=0.41, pickup_beats=3, pre_bars=4),
    dict(bpm=128.0, first_beat=0.05, pickup_beats=0, pre_bars=8, hat_gain=1.5),
    dict(bpm=100.0, first_beat=0.2, pickup_beats=2, pre_bars=0),
    dict(bpm=140.0, first_beat=0.0, pickup_beats=0, pre_bars=4),
    dict(bpm=174.0, first_beat=0.33, pickup_beats=1, pre_bars=0),
]

# Pass thresholds
MAX_BPM_ERR = 0.02        # BPM
MAX_MEAN_BEAT_ERR = 5.0   # ms, mean |error| over every beat of the track
MAX_BEAT_ERR = 10.0       # ms, worst beat anywhere in the track


def grid_errors(est, truth, max_t=None):
    tb = np.asarray(truth["beat_times"])
    if max_t is not None:
        tb = tb[tb < max_t]
    eb = np.asarray(est["beat_times"])
    i = np.clip(np.searchsorted(eb, tb), 1, len(eb) - 1)
    nearest = np.where(np.abs(eb[i - 1] - tb) < np.abs(eb[i] - tb), eb[i - 1], eb[i])
    err_ms = (nearest - tb) * 1000.0

    def hit_rate(true_times, est_times, tol=0.03):
        tt = np.asarray(true_times)
        if max_t is not None:
            tt = tt[tt < max_t]
        et = np.asarray(est_times)
        if len(tt) == 0 or len(et) == 0:
            return 0.0
        return float(np.mean([np.min(np.abs(et - t)) < tol for t in tt]))

    return {
        "bpm_err": abs(float(est["bpm"]) - truth["bpm"]),
        "mean_abs_ms": float(np.mean(np.abs(err_ms))),
        "max_abs_ms": float(np.max(np.abs(err_ms))),
        "beats_covered": float(np.mean(np.abs(err_ms) < 30)),
        "downbeat_hit": hit_rate(truth["downbeat_times"], est["downbeat_times"]),
        "phrase16_hit": hit_rate(truth["phrase_16_times"], est["phrase_16_times"]),
    }


def run_case(analyze, case, tmpdir, max_t=None):
    audio, truth = make_track(**case)
    path = os.path.join(tmpdir, "case.wav")
    sf.write(path, audio, SR)
    return grid_errors(analyze(path), truth, max_t)


def load_analyzer(path=None):
    if path is None:
        from backend.audio_analyzer import analyze_track
        return analyze_track
    spec = importlib.util.spec_from_file_location("alt_analyzer", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.analyze_track


def test_grid_accuracy():
    analyze = load_analyzer()
    with tempfile.TemporaryDirectory() as d:
        for case in CASES:
            r = run_case(analyze, case, d)
            assert r["bpm_err"] <= MAX_BPM_ERR, (case, r)
            assert r["mean_abs_ms"] <= MAX_MEAN_BEAT_ERR, (case, r)
            assert r["max_abs_ms"] <= MAX_BEAT_ERR, (case, r)
            assert r["downbeat_hit"] >= 0.99, (case, r)
            assert r["phrase16_hit"] >= 0.99, (case, r)


if __name__ == "__main__":
    alt = sys.argv[sys.argv.index("--old") + 1] if "--old" in sys.argv else None
    max_t = float(sys.argv[sys.argv.index("--max-t") + 1]) if "--max-t" in sys.argv else None
    analyze = load_analyzer(alt)
    print(f"{'case':44s} {'bpmErr':>7s} {'mean ms':>8s} {'max ms':>8s} {'beats':>6s} {'down':>5s} {'phr16':>6s}")
    with tempfile.TemporaryDirectory() as d:
        for case in CASES:
            r = run_case(analyze, case, d, max_t)
            label = f"{case['bpm']}bpm fb={case['first_beat']} pick={case['pickup_beats']} pre={case['pre_bars']}"
            print(f"{label:44s} {r['bpm_err']:7.3f} {r['mean_abs_ms']:8.1f} {r['max_abs_ms']:8.1f} "
                  f"{r['beats_covered']:6.0%} {r['downbeat_hit']:5.0%} {r['phrase16_hit']:6.0%}")
