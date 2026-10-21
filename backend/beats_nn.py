"""
beats_nn.py - A second opinion on beats and downbeats from a neural beat tracker: Beat This! (Foscarin,
Schlüter and Widmer, ISMIR 2024), trained on many genres and run on the Mac's GPU (PyTorch MPS) or CPU.

The analyzer's one constant grid stays the grid: on quantized music it is more precise than any tracker.
The neural beats decide what a constant fit can't (audio_analyzer.estimate_grid):
  - which beat is the 1 (downbeats from the model, voted onto the grid's beats);
  - a tempo read at an odd ratio of the true one (3/4, 4/3, 2/3, 3/2), as triplet and dotted rhythms
    mislead the onset envelope;
  - how much of the track the grid follows at all (nn_agree), which flags a grid to check.

Optional: without PyTorch and beat-this installed (requirements-local.txt), prepare runs without it.
The model's weights download once, on first use, into PyTorch's cache (~/.cache/torch/hub).
"""

import importlib.util
import os
from typing import Any, Dict

import numpy as np

SR = 22050                  # what the model's spectrogram expects
CHECKPOINT = "final0"       # the authors' main model (all training data but GTZAN)

_model = None
_device_used = None


def available() -> bool:
    return importlib.util.find_spec("beat_this") is not None and importlib.util.find_spec("torch") is not None


def _device() -> str:
    import torch
    return "mps" if torch.backends.mps.is_available() else "cpu"


def load(device: str = None):
    """The model, loaded once per process (downloads its weights the first time)."""
    global _model, _device_used
    device = device or _device_used or _device()
    if _model is None or device != _device_used:
        os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")   # ops MPS lacks run on the CPU
        from beat_this.inference import Audio2Beats
        _model, _device_used = Audio2Beats(checkpoint_path=CHECKPOINT, device=device, dbn=False), device
    return _model


def track_beats(path: str) -> Dict[str, Any]:
    """Beat and downbeat times (s) of the whole track, decoded as the analyzer decodes it (ffmpeg, the
    browser's decoder too, so its times line up with playback), and the median tempo they imply."""
    from .audio_analyzer import load_mono
    y = load_mono(path, SR).astype(np.float64)
    try:
        beats, downbeats = load()(y, SR)
    except RuntimeError:
        if _device_used == "cpu":
            raise
        beats, downbeats = load("cpu")(y, SR)    # the GPU path failed: the CPU from here on
    beats, downbeats = np.asarray(beats, float), np.asarray(downbeats, float)
    ibi = np.diff(beats)
    bpm = float(60.0 / np.median(ibi)) if len(ibi) >= 8 else None
    return {"nn_beats": [round(float(t), 4) for t in beats],
            "nn_downbeats": [round(float(t), 4) for t in downbeats],
            "nn_bpm": round(bpm, 3) if bpm else None,
            "nn_model": f"beat_this:{CHECKPOINT}"}
