"""
test_stretch.py - A stretched deck must keep every beat where the math says: native t -> t / ratio.

    python -m pytest tests/test_stretch.py -q
    python tests/test_stretch.py
"""

import os
import sys
import tempfile

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tests.synth import make_track, SR  # noqa: E402
from tests.test_grid import grid_errors  # noqa: E402
from backend.audio_analyzer import analyze_track  # noqa: E402
from backend.stretch import stretch_file, has_rubberband  # noqa: E402

RATIOS = [0.955, 0.987, 1.0, 1.0183, 1.047]


def run(ratio, tmpdir):
    audio, truth = make_track(bpm=122.0, first_beat=0.25, pickup_beats=0, pre_bars=0)
    src = os.path.join(tmpdir, "src.wav")
    sf.write(src, audio, SR)
    out = stretch_file(src, ratio, tmpdir, analyze_track(src)["grid"])
    scaled = {
        "bpm": truth["bpm"] * ratio,
        "beat_times": truth["beat_times"] / ratio,
        "downbeat_times": truth["downbeat_times"] / ratio,
        "phrase_16_times": truth["phrase_16_times"] / ratio,
    }
    return grid_errors(analyze_track(out), scaled)


def test_stretch_keeps_beats_on_the_math():
    with tempfile.TemporaryDirectory() as d:
        for r in RATIOS:
            e = run(r, d)
            assert e["bpm_err"] < 0.03, (r, e)
            assert e["mean_abs_ms"] < 5.0, (r, e)
            assert e["max_abs_ms"] < 12.0, (r, e)


if __name__ == "__main__":
    print("stretcher:", "rubberband" if has_rubberband() else "atempo")
    with tempfile.TemporaryDirectory() as d:
        for r in RATIOS:
            e = run(r, d)
            print(f"ratio {r:.4f}: bpm err {e['bpm_err']:.3f}  mean |beat err| {e['mean_abs_ms']:.1f} ms  "
                  f"max {e['max_abs_ms']:.1f} ms")
