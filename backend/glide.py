"""
glide.py - Keylocked tempo glides (Phase 5): a window of a track whose tempo eases from one speed to
another with its pitch unchanged, rendered once on the server, so the deck and the sound check play
exactly the same audio.

The time map. The speed s (native seconds played per second) is s0 up to native time `at`, moves
linearly in native time to s1 over the next `length` native seconds, and stays s1 after. The window's
sample 0 is native `start` (a lead-in at s0 before `at`), so native n sits at buffer time

    b(n) = (n - start) / s0                                       n <= at
         = (at - start) / s0 + ln(s(n) / s0) / k                  in the ramp, k = (s1 - s0) / length
         = (at - start) / s0 + ln(s1 / s0) / k + (n - at - length) / s1      after it

(frontend/js/audio_engine.js TimeMap computes the same). ffmpeg's rubberband filter renders it, its
tempo stepped every 1024 input samples (23 ms) to the speed at each step's middle: the steps add up to
the map within microseconds, and kicks land on it within ~1.5 ms all along the ramp (tests/test_glide.py).

The window is lined up with the file the deck plays before the glide (the track, or its keylocked copy
at s0) by cross-correlating the lead-in, where both run at s0, so the deck switches to it seamlessly.
"""

import os
import glob
import hashlib
import subprocess
import tempfile

import numpy as np

from .stretch import tempo_filter, stretch_latency, _align

SR = 44100
STEP = 1024               # input samples between tempo commands
LEAD_SKIP = 1.0           # seconds of the window's lead-in the stretcher may still be settling in
MAX_ALIGN_SEC = 0.15
MAX_CACHED = 8
# Rubber Band's delay is about this many seconds of INPUT, so in output time it shrinks as the tempo
# rises (28 ms / s): left alone, kicks after a glide from 1.0 to 1.09 land 2.3 ms early. The commanded
# ramp is stretched by that difference so the window still lands on the map (measured on synthetic tracks)
RB_LATENCY_IN = 0.028


def buffer_time(n, start: float, at: float, length: float, s0: float, s1: float):
    """Buffer seconds of native time(s) `n` in a glide window (the module's time map)."""
    n = np.asarray(n, dtype=np.float64)
    k = (s1 - s0) / length if length > 0 else 0.0

    def ramp(x):
        return x / s0 if abs(k) < 1e-12 else np.log((s0 + k * x) / s0) / k

    b0 = (at - start) / s0
    x = np.clip(n - at, 0.0, max(length, 0.0))
    return np.where(n <= at, (n - start) / s0, b0 + ramp(x) + np.maximum(0.0, n - at - length) / s1)


def speed_at(n, at: float, length: float, s0: float, s1: float):
    n = np.asarray(n, dtype=np.float64)
    if length <= 0:
        return np.where(n <= at, s0, s1)
    return s0 + (s1 - s0) * np.clip((n - at) / length, 0.0, 1.0)


def commands(start: float, end: float, at: float, length: float, s0: float, s1: float, target: str,
             latency_in: float = 0.0) -> str:
    """asendcmd lines: the tempo for each STEP of input samples (window time = native - start), where
    it changes, at the speed of the step's middle (with the ramp lengthened by the stretcher's
    `latency_in` change, so its output lands on the map after it)."""
    lines, last = [], None
    extra = latency_in * (1 / s0 - 1 / s1) / length if length > 0 else 0.0
    for i in range(0, int((end - start) * SR) + STEP, STEP):
        n = start + (i + STEP / 2) / SR
        s = float(speed_at(n, at, length, s0, s1))
        if at < n < at + length:
            s = 1 / (1 / s + extra)
        if last is None or abs(s - last) > 1e-7:
            lines.append(f"{i / SR:.6f} {target} tempo {s:.7f};")
            last = s
    return "\n".join(lines)


def _decode(path: str, t0: float, t1: float) -> np.ndarray:
    """Mono float32 at SR of [t0, t1) seconds of a file, decoded from its start (exact on VBR MP3s)."""
    out = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-af',
                          f"atrim=start={max(0.0, t0):.6f}:end={t1:.6f},asetpts=PTS-STARTPTS",
                          '-f', 'f32le', '-ac', '1', '-ar', str(SR), '-'], capture_output=True, check=True).stdout
    return np.frombuffer(out, dtype=np.float32)


def render(src: str, dst: str, start: float, end: float, at: float, length: float, s0: float, s1: float,
           reference: str = None, ref_ratio: float = 1.0) -> float:
    """Render native [start, end) of `src` along the glide into FLAC `dst`, lined up with `reference`
    (the file the deck plays at s0, whose buffer time is native / ref_ratio; default the track itself).
    Returns the seconds it was moved by to line up."""
    if not start + LEAD_SKIP * s0 + 1.0 <= at:
        raise ValueError("the window needs a lead-in of at least 2 s before the glide")
    base = tempo_filter(s0)
    kind = base.split('=', 1)[0]                     # rubberband (atempo where ffmpeg lacks it)
    target = f"{kind}@glide"
    with tempfile.TemporaryDirectory() as d:
        cmd_file = os.path.join(d, "tempo.cmd")
        with open(cmd_file, "w") as f:
            f.write(commands(start, end, at, length, s0, s1, target,
                             RB_LATENCY_IN if kind == "rubberband" else 0.0))
        chain = (f"atrim=start={start:.6f}:end={end:.6f},asetpts=PTS-STARTPTS,aresample={SR},"
                 f"asetnsamples=n={STEP}:p=0,asendcmd=f={cmd_file},{target}={base.split('=', 1)[1]}")
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-af', chain, '-c:a', 'flac',
                        '-sample_fmt', 's16', dst], check=True)
    # Line the lead-in up with what the deck plays: both are native [start + LEAD_SKIP * s0, at) at s0
    n0, n1 = start + LEAD_SKIP * s0, at - 0.05
    ref = _decode(reference or src, n0 / ref_ratio, n1 / ref_ratio)
    out = _decode(dst, LEAD_SKIP, (n1 - start) / s0)
    from .stems import _lag
    lag = _lag(out, ref, int(MAX_ALIGN_SEC * SR), unclear=None)
    late = lag / SR if lag is not None else stretch_latency(round(s0, 6))
    if abs(late) > 0.0005:
        _align(dst, late)
    return late


def glide_path(cache_dir: str, name: str, start, end, at, length, s0, s1) -> str:
    key = hashlib.sha1(f"{name}|{start:.3f}|{end:.3f}|{at:.4f}|{length:.4f}|{s0:.6f}|{s1:.6f}".encode()).hexdigest()
    return os.path.join(cache_dir, f"{key[:16]}.flac")


def glide_file(src: str, cache_dir: str, name: str, start: float, end: float, at: float, length: float,
               s0: float, s1: float, reference: str = None, ref_ratio: float = 1.0) -> str:
    """render() into the cache (once per window and map); the last MAX_CACHED are kept."""
    os.makedirs(cache_dir, exist_ok=True)
    dst = glide_path(cache_dir, name, start, end, at, length, s0, s1)
    if not os.path.exists(dst):
        tmp = dst + ".part.flac"
        render(src, tmp, start, end, at, length, s0, s1, reference, ref_ratio)
        os.replace(tmp, dst)
    files = sorted(glob.glob(os.path.join(cache_dir, "*.flac")), key=os.path.getmtime)
    for old in files[:-MAX_CACHED]:
        if old != dst:
            os.remove(old)
    return dst
