"""
test_key_detect.py - Key tags in every usual notation read as Camelot, tags read from the file, and the
whole-track key extractor naming the right Camelot number on tracks of known key.

    python -m pytest tests/test_key_detect.py -q
"""

import os
import shutil
import subprocess
import sys

import pytest
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tests.synth import make_track, SR  # noqa: E402
from backend import key_detect  # noqa: E402
from backend.audio_analyzer import CAMELOT_MAP, PITCH_CLASSES  # noqa: E402


@pytest.mark.parametrize("raw,camelot", [
    ("8A", "8A"), ("08B", "8B"), ("12A", "12A"),
    ("1m", "8A"), ("1d", "8B"), ("6m", "1A"), ("10d", "5B"),          # Open Key
    ("Am", "8A"), ("A minor", "8A"), ("Amin", "8A"), ("C", "8B"), ("C major", "8B"),
    ("F#m", "11A"), ("Gbm", "11A"), ("Fsm", "11A"), ("A♭m", "1A"), ("Bbmaj", "6B"), ("Ebm", "2A"), ("E#", "7B"),
    ("", None), ("foo", None), (None, None),
])
def test_tag_camelot(raw, camelot):
    assert key_detect.tag_camelot(raw) == camelot


def test_read_tags(tmp_path):
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg not installed")
    y, _ = make_track(bpm=124.0, seed=1)
    wav, mp3 = str(tmp_path / "t.wav"), str(tmp_path / "t.mp3")
    sf.write(wav, y[:5 * SR], SR)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", wav, "-metadata", "TBPM=124", "-metadata", "TKEY=Bm", mp3],
                   check=True)
    assert key_detect.read_tags(mp3) == {"bpm": 124.0, "key": "Bm", "camelot": "10A"}


@pytest.mark.skipif(not key_detect.available(), reason="essentia not installed")
@pytest.mark.parametrize("transpose", [0, 2, 5, 7, 10])
def test_detect_key_camelot_number(tmp_path, transpose):
    # Am F C G transposed: the minor key or its relative major (same Camelot number) both mix right
    y, truth = make_track(bpm=124.0, seed=transpose, transpose=transpose)
    path = str(tmp_path / "k.wav")
    sf.write(path, y, SR)
    res = key_detect.detect_key(path)
    assert res["camelot"][:-1] == CAMELOT_MAP[(PITCH_CLASSES[truth["key_pc"]], "minor")][:-1]
