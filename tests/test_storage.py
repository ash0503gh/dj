"""
test_storage.py - A fresh Cloud Run instance fetches the same track for several requests at once.

    python -m pytest tests/test_storage.py -q
"""

import os
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend import storage  # noqa: E402


class SlowBlob:
    def download_to_filename(self, name):
        with open(name, "wb") as f:
            time.sleep(0.05)
            f.write(b"audio")


class Bucket:
    def blob(self, key):
        return SlowBlob()


def test_concurrent_fetches_of_one_track(monkeypatch):
    monkeypatch.setattr(storage, "BUCKET", "test")
    monkeypatch.setattr(storage, "_b", lambda: Bucket())
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "uploads", "track.mp3")
        results, errors = [], []

        def fetch():
            try:
                results.append(storage.fetch_file("uploads/track.mp3", path))
            except Exception as e:  # noqa: BLE001
                errors.append(e)

        threads = [threading.Thread(target=fetch) for _ in range(6)]
        [t.start() for t in threads]
        [t.join() for t in threads]
        assert not errors and results == [True] * 6
        assert open(path, "rb").read() == b"audio"
        assert os.listdir(os.path.dirname(path)) == ["track.mp3"]  # no temp files left behind
