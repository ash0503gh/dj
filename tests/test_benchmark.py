"""
test_benchmark.py - The Phase 2 yardstick counts what it says: grids that wander, how the library's pairs
split into blends, near misses and switches, and how the rated mixes went.

    python -m pytest tests/test_benchmark.py -q
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend import benchmark  # noqa: E402


def track(title, bpm, camelot="8A", spread=1.0, body=-8.0):
    return {"title": title, "bpm": bpm, "camelot": camelot, "grid": {"tempo_stable": True},
            "grid_err_spread_ms": spread, "loudness_body_lufs": body}


def test_library_and_pairs():
    lib = [track("a", 124.0), track("b", 126.0, "9A"), track("c", 104.0, spread=60.0), track("d", 70.0, body=-17.0)]
    rep = benchmark.library_report(lib)
    assert rep["tracks"] == 4 and rep["grid_drift_tracks"] == 1
    assert rep["worst_grids"][0]["title"] == "c"
    assert rep["past_trim_reach"] == 1                     # d: 9 dB under the others' middle

    pairs = benchmark.pairs_report(lib)
    assert pairs["pairs"] == 12
    # a, b and d (at double time: 140) blend with each other; c is 16-19% from a and b, 26% from d's 140
    assert pairs["blend"] + pairs["ramp_12_20"] + pairs["switch_only"] == 1.0
    assert pairs["no_blend_partner"] == 1 and pairs["no_blend_partner_titles"] == ["c"]


def test_played():
    ratings = [
        {"keys": ["blend", "blend.mids.overlap"], "rating": 1, "measured": {"kick_flam_ms": 2.0, "loudness_bump_db": 1.0}},
        {"keys": ["blend"], "rating": 0, "reason": "clash", "measured": {"kick_flam_ms": 12.0, "loudness_dip_db": -3.0}},
        {"keys": ["switch"], "rating": 1, "measured": {}},
    ]
    rep = benchmark.played_report(ratings)
    assert rep["rated"] == 3 and rep["good"] == round(2 / 3, 3)
    assert rep["by_kind"]["blend"] == {"rated": 2, "good": 0.5}
    assert rep["kick_flam_ms"]["over_10"] == 1
    assert rep["reasons"] == {"clash": 1}
    assert benchmark.played_report([]) == {"rated": 0}


def test_tags_and_neural():
    lib = [
        dict(track("a", 124.0), camelot="8A", key_ks="8A", tags={"bpm": 124.0, "camelot": "8A"}),
        dict(track("b", 126.0), camelot="9A", key_ks="3B", tags={"bpm": 63.0, "camelot": "8A"}),   # half-time tag
        dict(track("c", 100.0), camelot="5A", key_ks="5A", tags={"bpm": 133.0, "camelot": "1B"}),
        dict(track("d", 120.0), camelot="8A", tags={}),
    ]
    rep = benchmark.tags_report(lib)
    assert rep["key_tagged"] == 3 and rep["key_now"] == {"tracks": 3, "same": 0.333, "compatible": 0.667}
    assert rep["key_old"] == {"tracks": 3, "same": 0.333, "compatible": 0.333}
    assert rep["bpm_tagged"] == 3 and rep["bpm_agree"] == 0.667 and rep["bpm_disagree_titles"] == ["c"]

    nn = [dict(track("a", 124.0), nn_beats=[0.1], grid={"downbeat_source": "neural", "tempo_source": "grid", "nn_agree": 0.95}),
          dict(track("b", 126.0), nn_beats=[0.1], grid={"downbeat_source": "grid", "tempo_conflict": True, "nn_agree": 0.4}),
          track("c", 100.0)]
    rep = benchmark.neural_report(nn)
    assert rep["tracks"] == 2 and rep["downbeat_by_neural"] == 1 and rep["tempo_conflict"] == 1
    assert rep["agree"]["median"] == 0.675
