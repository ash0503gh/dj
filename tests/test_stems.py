"""
test_stems.py - What the stems tell and how they're kept: the vocal stem marks where the lead sings
(section by section, bar by bar), an instrumental's residue marks nothing, and Opus keeps a stem
sample-aligned with its track. The stems are a synthetic track's true parts (Demucs itself runs on the
Mac: its weights aren't reachable from every machine).

    python -m pytest tests/test_stems.py -q
"""

import os
import subprocess
import sys
import warnings

import numpy as np
import pytest
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tests.synth import make_track, SR  # noqa: E402
from backend import stems  # noqa: E402
from backend.audio_analyzer import analyze_track  # noqa: E402


@pytest.fixture(scope="module")
def song(tmp_path_factory):
    d = tmp_path_factory.mktemp("stems")
    y, truth = make_track(bpm=124.0, first_beat=0.2, seed=7, vocal=True)
    path = str(d / "song.wav")
    sf.write(path, y, SR)
    for k, v in truth["stems"].items():
        stems.write_opus(np.vstack([v, v]), str(d / f"{k}.opus"))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        an = analyze_track(path)
    return d, path, an, truth


def sung_share(spans, t0, t1):
    return sum(max(0.0, min(t1, b) - max(t0, a)) for a, b in spans) / (t1 - t0)


def test_vocal_stem_labels_sections_and_bars(song):
    d, path, an, truth = song
    an = dict(an, vocal_source="gemini:gemini-3.8-flash",
              section_map=[dict(s, has_vocals=True) for s in an["section_map"]])    # Gemini said: all sung
    stems.label_vocals(an, stems.sung_frames(str(d / "vocals.opus"), path))
    assert an["vocal_source"] == "stems:htdemucs" and len(an["vocal_gemini"]) == len(an["section_map"])
    right = [(sung_share(truth["vocal_spans"], s["time"], s["time"] + s["duration"]) >= 0.5) == s["has_vocals"]
             for s in an["section_map"]]
    assert sum(right) >= 0.95 * len(right) and any(s["has_vocals"] for s in an["section_map"])
    bars = an["vocal_bars"]
    downs = an["downbeat_times"]
    right = [(sung_share(truth["vocal_spans"], a, b) >= 0.5) == (v >= stems.SUNG_SHARE)
             for a, b, v in zip(downs[:-1], downs[1:], bars)]
    assert sum(right) >= 0.95 * len(right)


def test_instrumental_residue_sings_nowhere(song):
    d, path, _, truth = song
    stems.write_opus(np.vstack([truth["stems"]["drums"] * 0.003] * 2), str(d / "residue.opus"))
    assert not stems.sung_frames(str(d / "residue.opus"), path).any()


def test_opus_stems_stay_aligned_with_the_track(song):
    d, _, _, truth = song
    out = subprocess.run(["ffmpeg", "-v", "error", "-i", str(d / "drums.opus"), "-f", "f32le", "-ac", "1",
                          "-ar", str(SR), "-"], capture_output=True, check=True).stdout
    y = np.frombuffer(out, np.float32)
    x = truth["stems"]["drums"][:len(y)]
    n = 1 << 18
    lag = int(np.argmax(np.fft.irfft(np.fft.rfft(y[:n]) * np.conj(np.fft.rfft(x[:n])))))
    lag = lag - n if lag > n // 2 else lag
    assert abs(lag) <= 2      # samples


@pytest.mark.parametrize("ratio", [1.0, 1.05])
def test_layer_windows_line_up_with_what_the_deck_plays(song, tmp_path, ratio):
    # The kicks of a window of layers land where the deck's own copy (the track, or its keylocked copy)
    # has them: the deck can switch to its stems mid-mix without a flam
    from backend.stretch import stretch_file
    from backend.grid_check import beat_offsets
    d, path, an, truth = song
    ref = path if ratio == 1 else stretch_file(path, ratio, str(tmp_path))
    x = stems.render_layers(str(d), ref, ratio, 40.0, 60.0)
    assert x.shape == (6, int(round(20.0 / ratio * SR)))
    from backend.audio_analyzer import load_mono
    mix = ((x[0::2].sum(0) + x[1::2].sum(0)) / 2).astype(np.float32)
    r = load_mono(ref, SR)[int(round(40.0 / ratio * SR)):][:len(mix)]
    beats = (np.array([b for b in truth["beat_times"] if 41 < b < 59]) - 40.0) / ratio
    period = 60 / 124.0 / ratio
    a = [o for o in beat_offsets(mix, SR, beats, period) if o is not None]
    b = [o for o in beat_offsets(r, SR, beats, period) if o is not None]
    assert len(a) > 20 and abs(np.median(a) - np.median(b)) < 0.001     # within 1 ms
