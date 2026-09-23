"""
stretch.py - Keylocked (pitch-preserving) tempo change of a whole track via ffmpeg.

A deck playing a track stretched by `ratio` runs `ratio` times faster than native:
native time t plays at stretched time t / ratio. Output is FLAC (lossless, no encoder
delay) so that mapping stays exact to the sample.
"""

import os
import glob
import hashlib
import subprocess
from functools import lru_cache

MAX_CACHED = 8


@lru_cache(maxsize=1)
def has_rubberband() -> bool:
    try:
        out = subprocess.run(['ffmpeg', '-hide_banner', '-filters'], capture_output=True, text=True).stdout
        return ' rubberband ' in out
    except FileNotFoundError:
        return False


def tempo_filter(ratio: float) -> str:
    if has_rubberband():
        # Offline-quality settings: crisp transients keep kicks tight, which is what beatmatching hears
        return f"rubberband=tempo={ratio:.6f}:transients=crisp:detector=percussive:window=standard:pitchq=quality"
    return f"atempo={ratio:.6f}"


@lru_cache(maxsize=64)
def stretch_latency(ratio: float) -> float:
    """Seconds by which the stretcher's output kicks land LATE versus native_time / ratio
    (negative = early; atempo drops ~20 ms at the start). Measured on a synthetic kick loop,
    so it works for any track, including ones without clear kicks."""
    import tempfile
    import numpy as np
    import soundfile as sf
    from .audio_analyzer import load_mono, _refine_beat_offset, ANALYSIS_SR

    sr, period, first, n = 44100, 0.5, 0.25, 24
    t = np.arange(int(0.3 * sr)) / sr
    kick = np.sin(2 * np.pi * np.cumsum(50 + 100 * np.exp(-t / 0.03)) / sr) * np.exp(-t / 0.18)
    y = np.zeros(int((first + n * period + 1.0) * sr), dtype=np.float32)
    for k in range(n):
        s = int(round((first + k * period) * sr))
        y[s:s + len(kick)] += kick
    beats = first + period * np.arange(2, n - 2)  # skip the edges
    with tempfile.TemporaryDirectory() as d:
        src, dst = os.path.join(d, "k.wav"), os.path.join(d, "k_out.wav")
        sf.write(src, y * 0.8, sr)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-af', tempo_filter(ratio), dst], check=True)
        native = _refine_beat_offset(load_mono(src), ANALYSIS_SR, beats, period)
        stretched = _refine_beat_offset(load_mono(dst), ANALYSIS_SR, beats / ratio, period / ratio)
    return stretched - native / ratio


def stretched_path(src: str, ratio: float, cache_dir: str) -> str:
    key = hashlib.sha1(os.path.basename(src).encode()).hexdigest()[:12]
    return os.path.join(cache_dir, f"{key}_{ratio:.6f}.flac")


def stretch_file(src: str, ratio: float, cache_dir: str) -> str:
    """Render `src` at `ratio` x tempo (pitch unchanged) into the cache; returns the FLAC path."""
    os.makedirs(cache_dir, exist_ok=True)
    dst = stretched_path(src, ratio, cache_dir)
    if os.path.exists(dst):
        return dst
    tmp = dst + ".part.flac"
    # Compensate the stretcher's latency so native time t sits exactly at t / ratio
    lat = stretch_latency(round(ratio, 6))
    fix = (f",adelay={-lat * 1000:.3f}:all=1" if lat < 0
           else f",atrim=start={lat:.6f},asetpts=PTS-STARTPTS")
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-af', tempo_filter(ratio) + fix,
                    '-c:a', 'flac', '-sample_fmt', 's16', tmp], check=True)
    os.replace(tmp, dst)
    # Keep the disk bounded (Render's disk is small and ephemeral)
    files = sorted(glob.glob(os.path.join(cache_dir, "*.flac")), key=os.path.getmtime)
    for old in files[:-MAX_CACHED]:
        if old != dst:
            os.remove(old)
    return dst
