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


def test_situations_and_reasons(monkeypatch):
    with tempfile.TemporaryDirectory() as d:
        monkeypatch.setattr(server, "UPLOAD_DIR", d)
        monkeypatch.setattr(server, "FEEDBACK", {"ratings": None})
        client = TestClient(server.app)
        wash = ["wash", "gap.entry.split", "gap.after.echo", "gap.land.drop"]
        rate = lambda r, keys, gap: client.post("/api/feedback", json={  # noqa: E731
            "rating": r, "keys": keys, "pair": {"out": "a.mp3", "in": "b.mp3", "tempo_gap": gap}}).json()
        rate(1, wash, 0.30)
        rate(0, wash, 0.15)
        summary = client.get("/api/feedback/summary").json()["keys"]
        # The same kind of mix is also rated per situation: how far apart the tempos were
        assert summary["wash"] == [1, 2]
        assert summary["wash@gap.20-50"] == [1, 1] and summary["wash@gap.12-20"] == [0, 1]
        assert summary["gap.land.drop@wash"] == [1, 2]

        # A reason after NOT FOR ME blames only the part of the mix it is about
        switch = ["switch", "gap.entry.at", "gap.after.cut", "gap.land.hook", "gap.before.riser"]
        bad = rate(0, switch, 0.40)
        assert client.post("/api/feedback/reason", json={"id": bad["id"], "reason": "entry"}).status_code == 200
        summary = client.get("/api/feedback/summary").json()["keys"]
        assert summary["gap.land.hook"] == [0, 1] and summary["gap.land.hook@switch"] == [0, 1]
        assert "switch" not in summary and "gap.after.cut" not in summary and "gap.before.riser" not in summary

        # A song choice blames no part of the mix
        other = rate(0, ["blend", "blend.mids.hats", "blend.tail.filter", "blend.entry.drop"], 0.02)
        client.post("/api/feedback/reason", json={"id": other["id"], "reason": "song"})
        summary = client.get("/api/feedback/summary").json()["keys"]
        assert "blend" not in summary and "blend.mids.hats" not in summary

        assert client.post("/api/feedback/reason", json={"id": bad["id"], "reason": "meh"}).status_code == 400
        assert client.post("/api/feedback/reason", json={"id": "nope", "reason": "song"}).status_code == 404


def test_jev_agreement_and_half_time_situation(monkeypatch):
    with tempfile.TemporaryDirectory() as d:
        monkeypatch.setattr(server, "UPLOAD_DIR", d)
        monkeypatch.setattr(server, "FEEDBACK", {"ratings": None})
        client = TestClient(server.app)
        blend = ["blend", "blend.mids.hats", "blend.tail.filter", "blend.entry.drop"]
        post = lambda r, jev, pair: client.post("/api/feedback", json={  # noqa: E731
            "rating": r, "keys": blend, "jev": jev, "pair": pair}).json()
        post(1, 1.0, {"tempo_gap": 0.5, "tempo_multiple": 2})       # liked, Jev low
        post(0, 3.0, {"tempo_gap": 0.02})                            # disliked, Jev high
        bad = post(0, 1.0, {"tempo_gap": 0.02})                     # disliked for the song: not Jev's call
        client.post("/api/feedback/reason", json={"id": bad["id"], "reason": "song"})
        keys = client.get("/api/feedback/summary").json()["keys"]
        # Jev put the liked mix below the disliked one: it agreed in 0 of 1 pair
        assert keys["jev.agree"] == [0, 1]
        # A blend at half time is rated in a situation of its own
        assert keys["blend@tempo.half"] == [1, 1] and keys["blend@gap.le12"] == [0, 1]
