"""
test_chooser.py - The AI only ever picks one of the planner's candidates, within its time budget.

    python -m pytest tests/test_chooser.py -q
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend import transition_chooser as tc  # noqa: E402
from backend.ai_advisor import engine_order  # noqa: E402

CANDS = [{"id": "A", "technique": "blend", "bars": 16}, {"id": "B", "technique": "blend", "bars": 8}]


def engines(monkeypatch, gemini, jev):
    """gemini/jev: (delay_s, choice or None)."""
    monkeypatch.setenv("GEMINI_API_KEY", "test")
    monkeypatch.setenv("JEV_API_KEY", "test")

    def fake(spec, name):
        def call(*args):
            time.sleep(spec[0])
            return ({"choice": spec[1], "reason": name}, None) if spec[1] else (None, f"{name} failed")
        return call
    monkeypatch.setattr(tc, "_gemini_choice", fake(gemini, "gemini"))
    monkeypatch.setattr(tc, "_jev_choice", fake(jev, "jev"))


def test_engine_order():
    assert engine_order("gemini-3.8-flash") == ["gemini", "jev"]
    assert engine_order(None) == ["gemini", "jev"]
    assert engine_order("jev-latest") == ["jev", "gemini"]
    assert engine_order("local") == []


def test_gemini_preferred_when_on_time(monkeypatch):
    engines(monkeypatch, gemini=(0.2, "B"), jev=(0.0, "A"))
    r = tc.choose_transition({}, {}, CANDS, "gemini-3.8-flash", budget_sec=2)
    assert (r["choice"], r["engine"]) == ("B", "Gemini (gemini-3.8-flash)")


def test_slow_gemini_falls_back_to_jev_within_budget(monkeypatch):
    engines(monkeypatch, gemini=(3.0, "B"), jev=(0.1, "A"))
    t0 = time.monotonic()
    r = tc.choose_transition({}, {}, CANDS, "gemini-3.8-flash", budget_sec=1)
    assert (r["choice"], r["engine"]) == ("A", "Jev System One")
    assert time.monotonic() - t0 < 1.5
    assert r["errors"]["gemini"] == "timed out"


def test_invalid_answers_leave_the_planner_choice(monkeypatch):
    engines(monkeypatch, gemini=(0.0, "Z"), jev=(0.0, None))
    r = tc.choose_transition({}, {}, CANDS, "gemini-3.8-flash", budget_sec=1)
    assert r["choice"] is None and r["engine"] == "planner"


def test_local_and_single_candidate_skip_the_ai(monkeypatch):
    engines(monkeypatch, gemini=(0.0, "A"), jev=(0.0, "A"))
    assert tc.choose_transition({}, {}, CANDS, "local")["choice"] is None
    assert tc.choose_transition({}, {}, CANDS[:1], "gemini-3.8-flash")["choice"] is None
