"""
test_neural_hints.py - How the analyzer takes a neural beat tracker's opinion (beats_nn.py): its
downbeats choose the 1, a tempo at an odd ratio refits the grid only when the kicks agree, and the share
of its beats on the grid is measured. The tracker's output is given here (the true beats of a synthetic
track, or a deliberately wrong opinion), so this tests the analyzer's use of it, not the model.

    python -m pytest tests/test_neural_hints.py -q
"""

import os
import sys
import warnings

import pytest
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tests.synth import make_track, SR  # noqa: E402
from backend.audio_analyzer import analyze_track, _tempo_relation, _vote_downbeat, _beat_agreement  # noqa: E402


def test_tempo_relation():
    assert _tempo_relation(128, 128.5) == ("same", 1)
    assert _tempo_relation(128, 64) == ("same", 2)
    assert _tempo_relation(133.3, 100)[0] == "odd"
    assert _tempo_relation(85, 128)[0] == "odd"        # 2/3
    assert _tempo_relation(128, 111) == (None, None)


def test_vote_downbeat():
    p = 0.5
    assert _vote_downbeat(0.1, p, [0.1 + p * (2 + 4 * k) + 0.01 for k in range(20)]) == (2, 1.0)
    # split between two phases (a tracker counting two-beat bars): no clear winner
    assert _vote_downbeat(0.1, p, [0.1 + p * 2 * k for k in range(20)])[0] is None
    assert _beat_agreement(0.1, p, [0.1 + p * k for k in range(10)] + [0.35, 0.85]) == round(10 / 12, 3)


@pytest.fixture(scope="module")
def track(tmp_path_factory):
    y, truth = make_track(bpm=122.37, first_beat=0.123, pickup_beats=1, pre_bars=2, seed=5)
    path = str(tmp_path_factory.mktemp("nn") / "t.wav")
    sf.write(path, y, SR)
    return path, truth


def analyze(path, nn=None):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        return analyze_track(path, nn)["grid"]


def test_downbeats_follow_the_neural_opinion(track):
    path, truth = track
    plain = analyze(path)
    beats, downs = list(truth["beat_times"]), list(truth["downbeat_times"])
    agreed = analyze(path, {"nn_beats": beats, "nn_downbeats": downs, "nn_bpm": 122.37})
    assert agreed["downbeat_source"] == "neural" and agreed["nn_agree"] == 1.0
    assert agreed["downbeat_offset"] == plain["downbeat_offset"]       # the analyzer had it right
    later = analyze(path, {"nn_beats": beats, "nn_downbeats": [d + 60 / 122.37 for d in downs], "nn_bpm": 122.37})
    assert later["downbeat_offset"] == (plain["downbeat_offset"] + 1) % 4


def test_wrong_odd_tempo_is_disputed_not_taken(track):
    path, truth = track
    g = analyze(path, {"nn_beats": list(truth["beat_times"]), "nn_downbeats": list(truth["downbeat_times"]),
                       "nn_bpm": 122.37 * 0.75})
    assert abs(g["bpm"] - 122.37) < 0.02 and g["tempo_source"] == "grid" and g["tempo_conflict"]
