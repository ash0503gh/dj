"""
test_tempo_check.py - A tempo read at 4/3 of the real one (what dotted and triplet rhythms do to the
coarse estimate) is corrected when the kick/snare grid at the real tempo fits better; a right tempo
is left alone.

    python -m pytest tests/test_tempo_check.py -q
"""

import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend import audio_analyzer as aa  # noqa: E402

FPS = aa.ANALYSIS_SR / aa.ONSET_HOP


def kick_snare(bpm, seconds=90):
    """Onset envelope of a kick on 1 and 3 and a snare on 2 and 4 (slightly smeared hits)."""
    env = np.zeros(int(seconds * FPS))
    period = 60.0 * FPS / bpm
    for k in range(int(len(env) / period)):
        env[int(round(k * period))] += 1.0 if k % 2 == 0 else 0.8
    return np.convolve(env, [0.3, 1.0, 0.3], mode="same").astype(np.float32)


def bpm_of(fit):
    return 60.0 * FPS / fit["period_frames"]


def test_four_thirds_error_is_corrected():
    env = kick_snare(100.0)
    wrong = 100.0 * 4 / 3
    fit = aa._odd_ratio_check(env, FPS, wrong, aa._fit_constant_grid(env, FPS, wrong))
    assert abs(bpm_of(fit) - 100.0) < 0.5


def test_right_tempo_is_kept():
    env = kick_snare(100.0)
    fit = aa._odd_ratio_check(env, FPS, 100.0, aa._fit_constant_grid(env, FPS, 100.0))
    assert abs(bpm_of(fit) - 100.0) < 0.5
