"""
straighten.py - Live-played tracks put on a steady beat (Phase 5, part 2), as warp markers do in Ableton.

The analyzer fits one constant grid to a track. On a live-played or tempo-mapped track the kicks wander
off it (grid_check: grid_err_spread_ms past DRIFT_FLAG_MS), so no blend can stay beat-matched for long and
the mix search turns its blends into switches. Here the track's time map is built from where its kicks
really land, one point every bar (a line through the kicks of it and its neighbours, so one late kick can't
bend it), and Rubber Band renders the whole track once
along it, keylocked: between two points the tempo is the one that takes the first point's kick onto the
grid by the next, before the first and after the last the track plays as it was. The copy's beats then sit
on one constant grid; the prepare pipeline analyses the copy (library.py, the straighten stage) and the
console plays it and separates its stems from it.

The kicks are followed beat by beat (follow_kicks), not read against the one grid: a drift of a few BPM
moves them more than a quarter beat off it, where the grid check can't tell one kick from the next. The
tempo is stepped every 1024 input samples (23 ms) as for glides (glide.py). A bar more than MAX_DEV off
the average tempo is a misread, not drift: such a track is left as it is (and stays flagged).
"""

import os
import subprocess
import tempfile
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from .glide import SR, STEP
from .grid_check import DRIFT_FLAG_MS
from .stretch import tempo_filter

MIN_POINTS = 8          # bars with clear kicks a track needs to be straightened
MAX_DEV = 0.06          # a bar played this much faster or slower than the copy's tempo is a misread
FIT_BARS = 3            # each bar's point: a line through the kicks of it and its neighbours


def drifting(an: Dict[str, Any]) -> bool:
    """Whether a track's kicks wander off its grid enough to straighten it (and the DJ hasn't fixed or
    confirmed the grid by hand)."""
    return ((an.get("grid_err_spread_ms") or 0) > DRIFT_FLAG_MS and not an.get("grid_confirmed")
            and not an.get("grid_manual"))


def follow_kicks(y: np.ndarray, sr: int, first: float, period: float, duration: float) -> List[Tuple[float, bool]]:
    """Every beat from `first`, followed as a drummer's tempo moves: each beat is looked for within a
    quarter beat of where the last one and the local tempo put it, at its kick's 30% rise (the point the
    analyzer and the grid check anchor on); the local tempo is the median of the last 8 kick-to-kick
    beats. Where there is no clear kick (a breakdown) it carries on at that tempo.
    [(time, a kick was found)]."""
    from scipy.signal import butter, sosfiltfilt, hilbert
    sos = butter(4, 200, btype='low', fs=sr, output='sos')
    env = np.abs(hilbert(sosfiltfilt(sos, y.astype(np.float64))))
    # A kick, not a bass note: among the strong low hits on the analyzer's grid
    probe = [env[max(0, int((first + k * period - 0.25 * period) * sr)):int((first + k * period + 0.25 * period) * sr)].max()
             for k in range(int((duration - first) / period) - 1)]
    floor = 0.3 * float(np.percentile(probe, 75)) if probe else 0.0
    beats, intervals = [], []
    b, p = first, period
    while b < duration - period:
        c = int(round(b * sr))
        reach, pre = int(0.25 * p * sr), int(0.35 * p * sr)
        found = None
        if c - pre >= 0 and c + reach < len(env):
            j = c - reach + int(np.argmax(env[c - reach:c + reach]))
            base = float(np.percentile(env[c - pre:c - reach], 10))
            peak = float(env[j])
            if peak >= floor and peak >= 2.0 * base:
                thr = base + 0.3 * (peak - base)
                i = j
                while i > c - pre and env[i] > thr:
                    i -= 1
                frac = (thr - env[i]) / (env[i + 1] - env[i]) if env[i + 1] != env[i] else 0.0
                found = (i + frac) / sr
        if found is not None and beats and beats[-1][1]:
            intervals = (intervals + [found - beats[-1][0]])[-8:]
            p = float(np.clip(np.median(intervals), 0.92 * period, 1.08 * period))
        beats.append((found if found is not None else b, found is not None))
        b = beats[-1][0] + p
    return beats


FIT_TOL = 0.03          # a kick this far (s) off the line through its neighbours is a misread


def _robust_line(k: np.ndarray, t: np.ndarray):
    """(slope, intercept) of beat time against beat number, through the kicks that agree: the beat from
    the median gap between neighbouring kicks and the offset from the median (a run of misread kicks
    can't move either), then a straight fit of the kicks within FIT_TOL of that; None with fewer than 6."""
    if len(k) < 6:
        return None
    gaps = np.diff(t) / np.diff(k)
    slope = float(np.median(gaps))
    icept = float(np.median(t - slope * k))
    keep = np.abs(t - (slope * k + icept)) <= FIT_TOL
    if keep.sum() < 6:
        return None
    return tuple(np.polyfit(k[keep], t[keep], 1))


def time_map(beats: List[Tuple[float, bool]]) -> Optional[List[Tuple[float, float]]]:
    """[(time in the track, time in the straightened copy)] at every bar line with clear kicks around it:
    the track's time from a line through its kicks over FIT_BARS bars (misread kicks left out), the copy's on one grid at the
    track's average tempo, through the first point (so the copy starts as the track does). None when
    too few bars have kicks, or a bar would play more than MAX_DEV off that tempo (a misread)."""
    kicks = [(k, t) for k, (t, hit) in enumerate(beats) if hit]
    if len(kicks) < 4 * MIN_POINTS:
        return None
    idx = np.array([k for k, _ in kicks], dtype=float)
    tim = np.array([t for _, t in kicks])
    tempo = float(np.polyfit(idx, tim, 1)[0])            # the copy's beat: the track's average
    pts = []
    for bar in range(len(beats) // 4):
        k0 = 4 * bar
        near = (idx >= k0 - 4 * (FIT_BARS // 2)) & (idx < k0 + 4 * (FIT_BARS // 2 + 1))
        line = _robust_line(idx[near], tim[near])
        if line is not None:
            pts.append((k0, float(line[0] * k0 + line[1])))
    if len(pts) < MIN_POINTS:
        return None
    k_first, t_first = pts[0]
    m = [(t, t_first + (k - k_first) * tempo) for k, t in pts]
    for (a0, b0), (a1, b1) in zip(m, m[1:]):
        if b1 <= b0 or abs((a1 - a0) / (b1 - b0) - 1) > MAX_DEV:
            return None
    return m


def speed_at(t: float, m: List[Tuple[float, float]]) -> float:
    """How fast the track plays (track seconds a second of the copy) at track time t."""
    for (a0, b0), (a1, b1) in zip(m, m[1:]):
        if a0 <= t < a1:
            return (a1 - a0) / (b1 - b0)
    return 1.0


def copy_time(t, m: List[Tuple[float, float]]):
    """Where track time(s) t land in the copy (the map: linear between points, unchanged speed outside)."""
    a = np.array([p[0] for p in m])
    b = np.array([p[1] for p in m])
    t = np.asarray(t, dtype=np.float64)
    inner = np.interp(t, a, b)
    return np.where(t < a[0], t + (b[0] - a[0]), np.where(t > a[-1], t + (b[-1] - a[-1]), inner))


def commands(duration: float, m: List[Tuple[float, float]], target: str) -> str:
    """asendcmd lines: the tempo for each STEP of input samples, where it changes."""
    lines, last = [], None
    for i in range(0, int(duration * SR) + STEP, STEP):
        s = speed_at((i + STEP / 2) / SR, m)
        if last is None or abs(s - last) > 1e-7:
            lines.append(f"{i / SR:.6f} {target} tempo {s:.7f};")
            last = s
    return "\n".join(lines)


def render(src: str, dst: str, m: List[Tuple[float, float]], duration: float) -> None:
    """The whole track along the map, keylocked, as 16-bit FLAC at SR."""
    base = tempo_filter(1.0)
    kind = base.split('=', 1)[0]
    target = f"{kind}@straight"
    with tempfile.TemporaryDirectory() as d:
        cmd_file = os.path.join(d, "tempo.cmd")
        with open(cmd_file, "w") as f:
            f.write(commands(duration, m, target))
        chain = f"aresample={SR},asetnsamples=n={STEP}:p=0,asendcmd=f={cmd_file},{target}={base.split('=', 1)[1]}"
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-af', chain, '-ac', '2', '-c:a', 'flac',
                        '-sample_fmt', 's16', dst], check=True)


def straighten(src: str, dst: str, an: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Render `src` straightened into `dst`, following its kicks from its analysis's grid; what was
    done, or None when it can't be (too few clear kicks, or a misread)."""
    from .audio_analyzer import load_mono, ANALYSIS_SR
    g = an["grid"]
    first = g["first_beat"] + (g.get("downbeat_offset") or 0) * g["period"]
    beats = follow_kicks(load_mono(src, ANALYSIS_SR), ANALYSIS_SR, first, g["period"], float(an["duration"]))
    m = time_map(beats)
    if m is None:
        return None
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = dst + ".part.flac"
    render(src, tmp, m, float(an.get("duration") or 0))
    os.replace(tmp, dst)
    speeds = [(a1 - a0) / (b1 - b0) for (a0, b0), (a1, b1) in zip(m, m[1:])]
    return {"points": len(m), "spread_before_ms": an.get("grid_err_spread_ms"),
            "max_change_pct": round(100 * max(abs(s - 1) for s in speeds), 2),
            "kicks_followed": sum(1 for _, hit in beats if hit), "beats": len(beats)}
