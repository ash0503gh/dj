"""
test_chooser.py - Gemini picks, Jev rates every candidate, both within the time budget; the AI can
only ever name one of the planner's candidates.

    python -m pytest tests/test_chooser.py -q
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend import transition_chooser as tc  # noqa: E402
from backend.ai_advisor import engine_order  # noqa: E402

CANDS = [{"id": "A", "technique": "blend", "bars": 16}, {"id": "B", "technique": "blend", "bars": 8}]
SCORES = {"A": {"overall": 2.0, "mean": 2.1}, "B": {"overall": 3.5, "mean": 3.4}}


def engines(monkeypatch, gemini, jev):
    """gemini: (delay_s, choice or None); jev: (delay_s, scores or None)."""
    monkeypatch.setenv("GEMINI_API_KEY", "test")
    monkeypatch.setenv("JEV_API_KEY", "test")

    def fake_gemini(*args):
        time.sleep(gemini[0])
        return ({"choice": gemini[1], "reason": "gemini reason"}, None) if gemini[1] else (None, "gemini failed")

    def fake_jev(*args):
        time.sleep(jev[0])
        return (jev[1], None) if jev[1] else (None, "jev failed")
    monkeypatch.setattr(tc, "_gemini_choice", fake_gemini)
    monkeypatch.setattr(tc, "_jev_scores", fake_jev)


def test_engine_order():
    assert engine_order("gemini-3.8-flash") == ["gemini", "jev"]
    assert engine_order(None) == ["gemini", "jev"]
    assert engine_order("jev-latest") == ["jev", "gemini"]
    assert engine_order("local") == []


def test_gemini_picks_and_jev_scores_come_back_together(monkeypatch):
    engines(monkeypatch, gemini=(0.2, "A"), jev=(0.05, SCORES))
    r = tc.choose_transition({}, {}, CANDS, "gemini-3.8-flash", budget_sec=2)
    assert (r["choice"], r["gemini_choice"]) == ("A", "A")
    assert r["engine"].startswith("Gemini") and r["scores"] == SCORES


def test_slow_gemini_leaves_jevs_best_rated_within_budget(monkeypatch):
    engines(monkeypatch, gemini=(3.0, "A"), jev=(0.1, SCORES))
    t0 = time.monotonic()
    r = tc.choose_transition({}, {}, CANDS, "gemini-3.8-flash", budget_sec=1)
    assert time.monotonic() - t0 < 1.5
    assert (r["choice"], r["engine"], r["gemini_choice"]) == ("B", "Jev System One", None)
    assert r["errors"]["gemini"] == "timed out"


def test_jev_selected_leads_with_its_best_rated(monkeypatch):
    engines(monkeypatch, gemini=(0.0, "A"), jev=(0.0, SCORES))
    r = tc.choose_transition({}, {}, CANDS, "jev-latest", budget_sec=1)
    assert (r["choice"], r["engine"], r["gemini_choice"]) == ("B", "Jev System One", "A")


def test_invalid_answers_leave_the_planner_choice(monkeypatch):
    engines(monkeypatch, gemini=(0.0, "Z"), jev=(0.0, None))
    r = tc.choose_transition({}, {}, CANDS, "gemini-3.8-flash", budget_sec=1)
    assert r["choice"] is None and r["engine"] == "planner" and r["scores"] is None
    assert "invalid choice" in r["errors"]["gemini"]


def test_local_and_single_candidate_skip_the_ai(monkeypatch):
    engines(monkeypatch, gemini=(0.0, "A"), jev=(0.0, SCORES))
    assert tc.choose_transition({}, {}, CANDS, "local")["choice"] is None
    assert tc.choose_transition({}, {}, CANDS[:1], "gemini-3.8-flash")["choice"] is None
