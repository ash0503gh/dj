"""
grid_check.py - Where the kicks really sit against a track's grid, all along the track.

The analyzer fits one constant grid to the whole track. On a quantized track every kick sits on it; on a
live-played or tempo-mapped one the kicks wander off it, more in some parts than in others. Each beat's
kick is found on its own (the 30% rise of its low-band envelope, the point the analyzer anchors the grid
on) and the beats of each 4-bar window give one median offset. Two tracks' curves tell the mix search
where their kicks will land against each other over any overlap: the flam it would hear, how much of it
starting the incoming a few ms earlier or later corrects, and what is left (mix_planner.js flamCheck).
"""

from typing import Any, Dict, List, Optional

import numpy as np

from .audio_analyzer import load_mono, build_grid_times, ANALYSIS_SR

WINDOW_BARS = 4
MIN_KICKS = 6           # kicks a window needs (of its 16 beats) to be measured
DRIFT_FLAG_MS = 20.0    # kicks wander this far across the track: no single grid follows them


def beat_offsets(y: np.ndarray, sr: int, beats: np.ndarray, period: float) -> List[Optional[float]]:
    """Each beat's kick offset from the grid (s, + late), None where the beat has no clear kick.
    Searched within a quarter beat of the grid: a kick further off than that can't be told from the
    next beat's (and is far past audible anyway)."""
    from scipy.signal import butter, sosfiltfilt, hilbert
    sos = butter(4, 200, btype='low', fs=sr, output='sos')
    reach, pre, pad = int(0.25 * period * sr), int(0.35 * period * sr), int(0.05 * sr)
    hits = []   # (offset s, peak) or None
    for b in beats:
        c = int(round(b * sr))
        if c - pre - pad < 0 or c + reach + pad > len(y):
            hits.append(None)
            continue
        env = np.abs(hilbert(sosfiltfilt(sos, y[c - pre - pad:c + reach + pad].astype(np.float64))))[pad:-pad]
        j = pre - reach + int(np.argmax(env[pre - reach:pre + reach]))
        base = float(np.percentile(env[:pre - reach], 10))
        peak = float(env[j])
        if peak <= 0 or peak < 2.0 * base:
            hits.append(None)       # nothing rises on this beat (a breakdown, a held bass note)
            continue
        # back from the peak to its 30% rise: the point the analyzer anchors the grid on
        thr = base + 0.3 * (peak - base)
        i = j
        while i > 0 and env[i] > thr:
            i -= 1
        frac = (thr - env[i]) / (env[i + 1] - env[i]) if env[i + 1] != env[i] else 0.0
        hits.append(((i + frac - pre) / sr, peak))
    # A kick, not a soft bass note or pad swell: among the track's strong low hits
    peaks = np.array([h[1] for h in hits if h])
    if not len(peaks):
        return [None] * len(beats)
    floor = 0.3 * float(np.percentile(peaks, 75))
    return [h[0] if h and h[1] >= floor else None for h in hits]


def grid_error(y: np.ndarray, sr: int, grid: Dict[str, Any], duration: float) -> Dict[str, Any]:
    """{start, window_sec, ms}: the kicks' median offset from the grid (ms, + late) in each 4-bar window
    from the first downbeat, None where the window has too few clear kicks (a breakdown, a beatless intro)."""
    times = build_grid_times(grid, duration)
    period = grid["period"]
    beats = np.asarray(times["beat_times"])
    downbeats = times["downbeat_times"]
    window = WINDOW_BARS * 4 * period
    offs = beat_offsets(y, sr, beats, period)
    ms = []
    for t0 in downbeats[::WINDOW_BARS]:
        inside = [o for b, o in zip(beats, offs) if t0 - 1e-6 <= b < t0 + window - 1e-6 and o is not None]
        ms.append(round(float(np.median(inside)) * 1000.0, 1) if len(inside) >= MIN_KICKS else None)
    return {"start": round(float(downbeats[0]), 4) if downbeats else 0.0,
            "window_sec": round(window, 5), "ms": ms}


def check_track(path: str, grid: Dict[str, Any], duration: float) -> Dict[str, Any]:
    """The grid_err curve of one prepared track, and how far its kicks wander across it (ms)."""
    sr = ANALYSIS_SR
    err = grid_error(load_mono(path, sr), sr, grid, duration)
    known = [v for v in err["ms"] if v is not None]
    return {"grid_err": err, "grid_err_spread_ms": round(max(known) - min(known), 1) if len(known) > 1 else 0.0}
