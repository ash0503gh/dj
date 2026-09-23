"""
real_tracks_report.py - How well does each grid sit on the real kicks?

No ground truth exists for real tracks, so this measures the grid against an
independent kick detector (low-band envelope slope peaks):
  on-beat %   strong low-band onsets within ±20 ms of a grid beat
  |err| ms    median distance of those onsets from the grid (grid tightness)
  spread ms   IQR of signed error (a wandering grid spreads out)
  late/early  signed error in the first vs last 30% of the track (a wrong BPM drifts)

    python tests/real_tracks_report.py                 # new analyzer vs cached (old) grids
"""

import os
import sys
import json
import glob

import numpy as np
import librosa
from scipy.signal import butter, sosfiltfilt, hilbert, find_peaks

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from backend.audio_analyzer import analyze_track  # noqa: E402


def kick_onsets(path, sr=22050):
    y, _ = librosa.load(path, sr=sr, mono=True)
    lo = sosfiltfilt(butter(4, 150, btype='low', fs=sr, output='sos'), y)
    env = np.abs(hilbert(lo))
    env = env[: len(env) // 22 * 22].reshape(-1, 22).mean(axis=1)  # ~1 ms frames
    fps = sr / 22.0
    slope = np.maximum(0, np.diff(env, prepend=env[0]))
    peaks, props = find_peaks(slope, distance=int(0.2 * fps), height=np.percentile(slope, 99))
    # strongest 60% of candidate onsets = kicks / bass hits
    keep = props["peak_heights"] >= np.percentile(props["peak_heights"], 40)
    return peaks[keep] / fps, len(y) / sr


def score(onsets, beat_times, bpm, max_t=None):
    bt = np.asarray(beat_times)
    on = onsets if max_t is None else onsets[onsets < max_t]
    on = on[(on > bt[0] - 0.1) & (on < bt[-1] + 0.1)]
    if len(on) == 0 or len(bt) < 2:
        return None
    i = np.clip(np.searchsorted(bt, on), 1, len(bt) - 1)
    near = np.where(np.abs(bt[i - 1] - on) < np.abs(bt[i] - on), bt[i - 1], bt[i])
    err = (on - near) * 1000.0
    hit = np.abs(err) < 20
    q = int(len(err) * 0.3)
    return {
        "on_beat": float(np.mean(hit)),
        "abs_ms": float(np.median(np.abs(err[hit]))) if hit.any() else float('nan'),
        "spread_ms": float(np.subtract(*np.percentile(err[hit], [75, 25]))) if hit.sum() > 4 else float('nan'),
        "early_ms": float(np.median(err[:q][hit[:q]])) if hit[:q].any() else float('nan'),
        "late_ms": float(np.median(err[-q:][hit[-q:]])) if hit[-q:].any() else float('nan'),
        "coverage_s": float(bt[-1]),
    }


def fmt(name, bpm, s):
    if s is None:
        return f"  {name:4s} {bpm:8.2f}   (no beats)"
    return (f"  {name:4s} {bpm:8.2f}  on-beat {s['on_beat']:5.0%}  |err| {s['abs_ms']:4.1f}  "
            f"spread {s['spread_ms']:4.1f}  early {s['early_ms']:+5.1f} late {s['late_ms']:+5.1f}  "
            f"grid to {s['coverage_s']:5.0f}s")


if __name__ == "__main__":
    cache = json.load(open(os.path.join(ROOT, "uploads", "analysis_cache.json")))
    for path in sorted(glob.glob(os.path.join(ROOT, "uploads", "*.mp3"))):
        name = os.path.basename(path)
        onsets, dur = kick_onsets(path)
        new = analyze_track(path)
        print(f"{name[:70]}  ({dur:.0f}s, grid conf {new['grid']['confidence']:.2f}, drift {new['grid']['drift_ms']} ms)")
        old = cache.get(name)
        if old:
            print(fmt("old", old["bpm"], score(onsets, old["beat_times"], old["bpm"])))
        print(fmt("new", new["bpm"], score(onsets, new["beat_times"], new["bpm"])))
