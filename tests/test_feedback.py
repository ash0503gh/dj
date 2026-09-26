"""
test_feedback.py - The DJ's ratings of Auto mixes are kept and summed per feature key, which is what
the console's confidence leans on.

    python -m pytest tests/test_feedback.py -q
"""

import os
import sys
import tempfile

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend import server  # noqa: E402


def test_ratings_are_kept_and_summed_per_key(monkeypatch):
    with tempfile.TemporaryDirectory() as d:
        monkeypatch.setattr(server, "UPLOAD_DIR", d)
        monkeypatch.setattr(server, "FEEDBACK", {"ratings": None})
        client = TestClient(server.app)
        rate = lambda r, keys: client.post("/api/feedback", json={"rating": r, "keys": keys,  # noqa: E731
                                                                  "label": "4-bar filter wash, echo out"})
        assert rate(1, ["handover", "gap.entry.split"]).json()["count"] == 1
        assert rate(0, ["switch", "gap.entry.at"]).status_code == 200
        assert rate(1, ["handover", "gap.entry.split"]).status_code == 200
        assert rate(1, ["blend", "blend.mids.hats"]).status_code == 200
        assert client.post("/api/feedback", json={"rating": 1, "keys": []}).status_code == 400

        # Blends and filter washes are rated apart; older ratings said 'handover' for both
        summary = client.get("/api/feedback/summary").json()
        assert summary["count"] == 4
        assert summary["keys"]["wash"] == [2, 2]
        assert summary["keys"]["blend"] == [1, 1]
        assert "handover" not in summary["keys"]
        assert summary["keys"]["switch"] == [0, 1]

        # A fresh instance reads them back from disk
        monkeypatch.setattr(server, "FEEDBACK", {"ratings": None})
        assert client.get("/api/feedback/summary").json()["keys"]["gap.entry.split"] == [2, 2]
