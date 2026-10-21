"""
stems.py - A track's stems (vocals, drums, bass, other), separated once by Demucs v4 (htdemucs, Rouard,
Massa and Défossez 2023) on the Mac's GPU, kept as Ogg Opus beside the library index, and what they
tell: where the lead vocal really sings, bar by bar, for free (no Gemini).

Opus keeps the stems small (~15 MB a track for all four) and decodes sample-aligned with the track:
it carries its own encoder delay, which ffmpeg and Chrome both remove (checked: 0.02 ms at 44.1 kHz).
Optional: without Demucs installed (requirements-local.txt), prepare runs without stems.
"""

import importlib.util
import os
import subprocess
from typing import Any, Dict, List

import numpy as np

SOURCES = ("vocals", "drums", "bass", "other")
MODEL = "htdemucs"
SR = 44100
BITRATE = "128k"

# Where the lead vocal sings, from the vocal stem (provisional, to tune on real tracks): a frame sings
# when the stem is within VOICE_DB of its own sung level and not buried more than BURIED_DB under the
# music; a section or bar sings when SUNG_SHARE of its frames do. A vocal stem whose sung level sits
# INSTRUMENTAL_DB under the track's is separation residue: an instrumental.
FRAME_SEC = 0.05
VOICE_DB = 18.0
BURIED_DB = 20.0
SUNG_SHARE = 0.35
INSTRUMENTAL_DB = 30.0

_sep = None
_device_used = None


def available() -> bool:
    return importlib.util.find_spec("demucs") is not None and importlib.util.find_spec("torch") is not None


def paths(folder: str) -> Dict[str, str]:
    return {s: os.path.join(folder, f"{s}.opus") for s in SOURCES}


def have(folder: str) -> bool:
    return all(os.path.exists(p) for p in paths(folder).values())


def _device() -> str:
    import torch
    return "mps" if torch.backends.mps.is_available() else "cpu"


def load(device: str = None):
    """The separator, loaded once per process (downloads the model's weights the first time)."""
    global _sep, _device_used
    device = device or _device_used or _device()
    if _sep is None or device != _device_used:
        os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")   # ops MPS lacks run on the CPU
        from demucs.api import Separator
        _sep, _device_used = Separator(model=MODEL, device=device, progress=False), device
    return _sep


def _decode_stereo(path: str) -> np.ndarray:
    """The whole track as stereo float32 (2 x N) at SR, decoded by ffmpeg as the analysis decodes it."""
    out = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '2', '-ar', str(SR), '-'],
                         capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype=np.float32).reshape(-1, 2).T.copy()


def write_opus(x: np.ndarray, dst: str) -> None:
    """Stereo float32 (2 x N, at SR) to an Ogg Opus file, written to a temporary name first."""
    tmp = dst + ".part.opus"
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', '2', '-i', '-',
                    '-c:a', 'libopus', '-b:a', BITRATE, tmp],
                   input=np.ascontiguousarray(x.T, dtype=np.float32).tobytes(), check=True)
    os.replace(tmp, dst)


def separate(path: str, folder: str) -> Dict[str, Any]:
    """Separate one track into its four stems in `folder`."""
    import torch
    wav = torch.from_numpy(_decode_stereo(path))
    try:
        _, out = load().separate_tensor(wav, SR)
    except RuntimeError:
        if _device_used == "cpu":
            raise
        _, out = load("cpu").separate_tensor(wav, SR)    # the GPU path failed: the CPU from here on
    os.makedirs(folder, exist_ok=True)
    for s in SOURCES:
        write_opus(out[s].detach().cpu().numpy(), paths(folder)[s])
    return {"stems_model": f"demucs:{MODEL}"}


def _frames_db(y: np.ndarray, sr: int) -> np.ndarray:
    n = int(FRAME_SEC * sr)
    k = len(y) // n
    return 10 * np.log10(np.mean(y[:k * n].reshape(k, n).astype(np.float64) ** 2, axis=1) + 1e-12)


def sung_frames(vocal_path: str, track_path: str) -> np.ndarray:
    """Per 50 ms frame from the track's start: True where the lead vocal sings (by its stem)."""
    from .audio_analyzer import load_mono, ANALYSIS_SR
    v = _frames_db(load_mono(vocal_path, ANALYSIS_SR), ANALYSIS_SR)
    m = _frames_db(load_mono(track_path, ANALYSIS_SR), ANALYSIS_SR)
    n = min(len(v), len(m))
    v, m = v[:n], m[:n]
    sung_level = float(np.percentile(v, 95))
    if sung_level < float(np.percentile(m, 95)) - INSTRUMENTAL_DB:
        return np.zeros(n, bool)                                    # residue: an instrumental
    return (v > sung_level - VOICE_DB) & (v > m - BURIED_DB)


def share(sung: np.ndarray, t0: float, t1: float) -> float:
    """Share of [t0, t1) the vocal sings in."""
    a, b = max(0, int(t0 / FRAME_SEC)), min(len(sung), int(t1 / FRAME_SEC))
    return float(sung[a:b].mean()) if b > a else 0.0


def label_vocals(an: Dict[str, Any], sung: np.ndarray) -> None:
    """The analysis's sections and bars labelled from the vocal stem (replacing Gemini's or the spectral
    guess; Gemini's sung spans are kept as `vocal_gemini` to compare)."""
    if str(an.get("vocal_source", "")).startswith("gemini"):
        an["vocal_gemini"] = [[s["time"], s["time"] + s["duration"]] for s in an.get("section_map", [])
                              if s.get("has_vocals")]
    for s in an.get("section_map", []):
        v = share(sung, s["time"], s["time"] + s["duration"])
        if "vocal_score_dsp" not in s:
            s["vocal_score_dsp"] = s.get("vocal_score", 0.0)
        s["vocal_score"] = round(v, 3)
        s["has_vocals"] = v >= SUNG_SHARE
    downbeats: List[float] = an.get("downbeat_times") or []
    an["vocal_bars"] = [round(share(sung, a, b), 2) for a, b in zip(downbeats[:-1], downbeats[1:])]
    an["vocal_source"] = f"stems:{MODEL}"


# ── Layers: what a deck plays during a mix that uses its stems ──

LAYERS = ("vocals", "drums", "rest")    # rest = bass + other: the bass swap's isolator handles the bass
LAYER_PAD_SEC = 1.0                     # decoded either side of the window, so the stretcher starts warm
MAX_ALIGN_SEC = 0.06                    # the most the layers are moved to line up with the deck's audio


def _decode_opus(path: str) -> np.ndarray:
    out = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '2', '-ar', str(SR), '-'],
                         capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype=np.float32).reshape(-1, 2).T


def _stretch(x: np.ndarray, ratio: float) -> np.ndarray:
    """All channels of x (C x N) through the keylocked stretcher together (the same timing for every
    stem), as the deck's own copy is stretched (stretch.py)."""
    from .stretch import tempo_filter, has_rubberband
    f = tempo_filter(ratio) + (":channels=together" if has_rubberband() else "")
    out = subprocess.run(['ffmpeg', '-v', 'error', '-f', 'f32le', '-ar', str(SR), '-ac', str(len(x)), '-i', '-',
                          '-af', f, '-f', 'f32le', '-'],
                         input=np.ascontiguousarray(x.T).tobytes(), capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype=np.float32).reshape(-1, len(x)).T


def _lag(a: np.ndarray, ref: np.ndarray, most: int) -> int:
    """Samples by which `a` sits late against `ref` (cross-correlation, within ±most); 0 when unclear."""
    n = min(len(a), len(ref))
    size = 1 << int(np.ceil(np.log2(2 * n)))
    xc = np.fft.irfft(np.fft.rfft(a[:n], size) * np.conj(np.fft.rfft(ref[:n], size)), size)
    lags = np.concatenate([np.arange(0, most + 1), np.arange(-most, 0)])
    vals = np.concatenate([xc[:most + 1], xc[-most:]])
    k = int(np.argmax(vals))
    clear = vals[k] > 0.5 * np.sqrt(np.dot(a[:n], a[:n]) * np.dot(ref[:n], ref[:n]))
    return int(lags[k]) if clear else 0


def render_layers(folder: str, reference: str, ratio: float, start: float, end: float) -> np.ndarray:
    """The layers (6 x N: vocals, drums, rest as stereo pairs) of native [start, end) at `ratio` x tempo,
    sample 0 at native `start` played at that tempo, lined up with `reference`: the very file the deck
    plays (the track, or its keylocked copy at `ratio`), whose sample k is native k / SR * ratio."""
    p = paths(folder)
    s = {k: _decode_opus(p[k]) for k in SOURCES}
    n = min(v.shape[1] for v in s.values())
    a = max(0, int((start - LAYER_PAD_SEC) * SR))
    b = min(n, int((end + LAYER_PAD_SEC) * SR))
    x = np.vstack([s["vocals"][:, a:b], s["drums"][:, a:b], s["bass"][:, a:b] + s["other"][:, a:b]])
    if abs(ratio - 1) >= 0.0005:
        x = _stretch(x, ratio)
    # where native `start` falls in x, and in the deck's own file
    skip = int(round((start - a / SR) / ratio * SR))
    ref0 = int(round(start / ratio * SR))
    from .audio_analyzer import load_mono
    ref = load_mono(reference, SR)
    look = min(x.shape[1] - skip, int(20 * SR))           # 20 s are plenty to line up on
    mix = x[0::2].sum(axis=0)[skip:skip + look] + x[1::2].sum(axis=0)[skip:skip + look]
    lag = _lag(mix, ref[ref0:ref0 + look] * 2, int(MAX_ALIGN_SEC * SR))
    skip += lag
    length = int(round((end - start) / ratio * SR))
    out = np.zeros((6, length), np.float32)
    seg = x[:, max(0, skip):skip + length]
    out[:, max(0, -skip):max(0, -skip) + seg.shape[1]] = seg
    return out


def write_flac(x: np.ndarray, dst: str) -> None:
    """Multichannel float32 (C x N, at SR) to 16-bit FLAC (decodes in Chrome with its channel order)."""
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', str(len(x)), '-i', '-',
                    '-c:a', 'flac', '-sample_fmt', 's16', dst],
                   input=np.ascontiguousarray(np.clip(x, -1, 1).T, dtype=np.float32).tobytes(), check=True)


def layers_file(folder: str, reference: str, ratio: float, start: float, end: float, dst: str) -> str:
    """render_layers into a FLAC at `dst` (once: kept for the next request of the same window)."""
    if not os.path.exists(dst):
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        tmp = dst + ".part.flac"
        write_flac(render_layers(folder, reference, ratio, start, end), tmp)
        os.replace(tmp, dst)
    return dst
