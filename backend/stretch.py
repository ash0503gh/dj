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


def measure_offset(src: str, stretched: str, ratio: float, grid: dict):
    """Seconds by which `stretched` sits LATE versus src time / ratio, measured on the track's
    own kicks (the stretcher's delay depends on the audio: a synthetic calibration was 10-30 ms
    off on real tracks). None when the track has no clear kick transients."""
    import numpy as np
    from .audio_analyzer import load_mono, _refine_beat_offset, ANALYSIS_SR
    sr = ANALYSIS_SR
    yn = load_mono(src, sr)
    period, first = grid["period"], grid["first_beat"]
    n = int((len(yn) / sr - first) / period)
    if n < 24:
        return None
    beats = first + period * np.arange(4, n - 4)
    # Only beats with a real kick: pads and basslines stretch differently from transients
    from scipy.signal import butter, sosfiltfilt
    lo = np.abs(sosfiltfilt(butter(4, 200, btype='low', fs=sr, output='sos'), yn.astype(np.float64)))
    w = int(0.03 * sr)
    idx = (beats * sr).astype(int)
    rise = np.array([lo[i:i + w].max() - lo[max(0, i - w):i].mean() if i + w < len(lo) else 0.0 for i in idx])
    del lo
    beats = beats[rise >= np.percentile(rise, 50)]
    native = _refine_beat_offset(yn, sr, beats, period)
    del yn
    shifted = _refine_beat_offset(load_mono(stretched, sr), sr, beats / ratio, period / ratio)
    if native == 0.0 or shifted == 0.0:
        return None
    return shifted - native / ratio


def _align(path: str, late: float) -> None:
    """Shift a FLAC in place so its content moves `late` seconds earlier (negative = later)."""
    fix = (f"atrim=start={late:.6f},asetpts=PTS-STARTPTS" if late > 0
           else f"adelay={-late * 1000:.3f}:all=1")
    tmp = path + ".align.flac"
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', path, '-af', fix, '-c:a', 'flac', '-sample_fmt', 's16', tmp],
                   check=True)
    os.replace(tmp, path)


def stretched_path(src: str, ratio: float, cache_dir: str) -> str:
    key = hashlib.sha1(os.path.basename(src).encode()).hexdigest()[:12]
    return os.path.join(cache_dir, f"{key}_{ratio:.6f}_a2.flac")


def stretch_file(src: str, ratio: float, cache_dir: str, grid: dict = None) -> str:
    """Render `src` at `ratio` x tempo (pitch unchanged) into the cache; returns the FLAC path.
    With the track's beat `grid`, the result is aligned on the track's own kicks so native
    time t sits exactly at t / ratio."""
    os.makedirs(cache_dir, exist_ok=True)
    dst = stretched_path(src, ratio, cache_dir)
    if os.path.exists(dst):
        return dst
    tmp = dst + ".part.flac"
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-af', tempo_filter(ratio),
                    '-c:a', 'flac', '-sample_fmt', 's16', tmp], check=True)
    late = measure_offset(src, tmp, ratio, grid) if grid else None
    if late is None:
        late = stretch_latency(round(ratio, 6))
    if abs(late) > 0.0005:
        _align(tmp, late)
    os.replace(tmp, dst)
    # Keep the disk bounded (Render's disk is small and ephemeral)
    files = sorted(glob.glob(os.path.join(cache_dir, "*.flac")), key=os.path.getmtime)
    for old in files[:-MAX_CACHED]:
        if old != dst:
            os.remove(old)
    return dst
