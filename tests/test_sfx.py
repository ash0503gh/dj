"""
test_sfx.py - The sound-effects library: the generated set has its roles' shapes (a build ends loudest
and brightest, a fall starts there, a hit starts at once), and the Freesound download keeps to CC0, to
its per-category count and to the size budget, resumes without fetching twice, and refuses a bad key.
Freesound is stood in for by a fake with the API's shape (search results with licence and previews).

    python -m pytest tests/test_sfx.py -q
"""

import json
import os
import sys

import numpy as np
import pytest
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from backend import sfx  # noqa: E402

CC0_URL = "http://creativecommons.org/publicdomain/zero/1.0/"
BY_URL = "https://creativecommons.org/licenses/by/4.0/"


@pytest.fixture
def folder(tmp_path, monkeypatch):
    monkeypatch.setattr(sfx, "SFX_DIR", str(tmp_path / "sfx"))
    monkeypatch.setattr(sfx, "MANIFEST", str(tmp_path / "sfx" / "manifest.json"))
    return tmp_path / "sfx"


def quarters_db(path):
    y, _ = sf.read(path)
    m = y.mean(axis=1)
    q = len(m) // 4
    return [20 * np.log10(np.sqrt(np.mean(m[i * q:(i + 1) * q] ** 2)) + 1e-9) for i in range(4)]


def test_generated_sounds_have_their_roles_shapes(folder):
    sfx.generate(log=lambda m: None)
    items = sfx.library()
    assert len(items) == len(sfx._recipes()) and all(i["license"] == "own (generated)" for i in items)
    for it in items:
        db = quarters_db(os.path.join(sfx.SFX_DIR, it["file"]))
        if it["role"] == "build":
            assert db[3] > db[0] + 15, it["name"]          # ends loudest
        else:
            assert db[0] > db[3] + 10, it["name"]          # starts loudest
    assert sfx.generate(log=lambda m: None) == 0           # already there: nothing made twice


class FakeResponse:
    def __init__(self, status=200, data=None, content=b""):
        self.status_code, self._data, self.content = status, data, content

    def json(self):
        return self._data

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(self.status_code)


class FakeFreesound:
    """Two pages of results per query: CC0 sounds and one CC-BY sound among them."""
    def __init__(self, size=1000, key="good"):
        self.size, self.key, self.audio_gets = size, key, 0

    def get(self, url, params=None, timeout=None):
        if url == sfx.FREESOUND_SEARCH:
            if params["token"] != self.key:
                return FakeResponse(401)
            assert 'license:"Creative Commons 0"' in params["filter"]
            page, q = params["page"], params["query"]
            results = [{"id": hash((q, page, i)) % 10 ** 8, "name": f"{q} {page}-{i}", "username": "someone",
                        "license": BY_URL if i == 0 else CC0_URL, "duration": 3.0, "url": "https://freesound.org/s/1/",
                        "previews": {"preview-hq-mp3": f"https://cdn.freesound.org/{q}/{page}/{i}.mp3"}}
                       for i in range(3)]
            return FakeResponse(data={"results": results, "next": "more" if page < 2 else None})
        self.audio_gets += 1
        return FakeResponse(content=b"x" * self.size)


def test_download_cc0_only_per_category_and_resumable(folder):
    fake = FakeFreesound()
    got = sfx.download("good", per_category=3, log=lambda m: None, http=fake, pause=0)
    index = json.load(open(folder / "freesound" / "index.json"))
    assert got["downloaded"] == 3 * len(sfx.CATEGORIES) and len(index) == got["downloaded"]
    assert all(v["license"] == CC0_URL for v in index.values())                  # the CC-BY ones skipped
    assert {v["category"] for v in index.values()} == set(sfx.CATEGORIES)
    items = [i for i in sfx.library() if i["source"] == "freesound"]
    assert len(items) == len(index) and all(i["license"] == "CC0" and i["author"] == "someone" for i in items)
    assert sfx.path_of(items[0]["id"]).endswith(".mp3")

    before = fake.audio_gets
    again = sfx.download("good", per_category=3, log=lambda m: None, http=fake, pause=0)
    assert again["downloaded"] == 0 and fake.audio_gets == before                 # nothing fetched twice


def test_download_stops_at_the_budget(folder):
    got = sfx.download("good", per_category=10, max_bytes=5500, log=lambda m: None, http=FakeFreesound(size=1000),
                       pause=0)
    audio = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(folder) for f in fs if f.endswith(".mp3"))
    assert got["downloaded"] == 5 and audio <= 5500


def test_bad_key_is_refused_clearly(folder):
    with pytest.raises(SystemExit, match="API key"):
        sfx.download("bad", log=lambda m: None, http=FakeFreesound(), pause=0)
