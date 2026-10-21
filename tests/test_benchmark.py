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
