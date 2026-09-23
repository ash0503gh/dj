"""
transition_metrics.py - Objective scores for a rendered transition, from per-deck stems.

  kick alignment   lag (ms) between the two decks' onset envelopes, per 4-bar window of the
                   overlap. >10 ms starts to flam, >20 ms is a trainwreck.
  bass overlap     seconds where BOTH decks carry full bass (two kicks/basslines = mud).
  loudness         per-bar level of the mix across the transition versus each track alone:
                   a dip is a hole in the dancefloor, a bump is a volume spike.
"""

import numpy as np
import librosa
from scipy.signal import butter, sosfiltfilt


def _db(x):
    return 20.0 * np.log10(np.maximum(x, 1e-9))


def kick_alignment(out_stem, in_stem, sr, start, end, beat_sec):
    hop = 64
    envs = [librosa.onset.onset_strength(y=s.astype(np.float32), sr=sr, hop_length=hop) for s in (out_stem, in_stem)]
    fps = sr / hop
    win = int(16 * beat_sec * fps)
    max_lag = int(0.25 * beat_sec * fps)
    lags = []
    for a in range(int(start * fps), int(end * fps) - win + 1, win):
        x, y = envs[0][a:a + win], envs[1][a:a + win]
        # Only where both decks are actually playing something
        if x.max() <= 0.05 * envs[0].max() or y.max() <= 0.05 * envs[1].max():
            continue
        x = x - x.mean()
        y = y - y.mean()
        cc = [np.dot(x[max(0, -k):win - max(0, k)], y[max(0, k):win - max(0, -k)]) for k in range(-max_lag, max_lag + 1)]
        j = int(np.argmax(cc))
        d = 0.0
        if 0 < j < len(cc) - 1:
            den = cc[j - 1] - 2 * cc[j] + cc[j + 1]
            d = 0.5 * (cc[j - 1] - cc[j + 1]) / den if den != 0 else 0.0
        lags.append((j - max_lag + d) / fps * 1000.0)
    lags = np.array(lags)
    return {
        "kick_align_median_ms": round(float(np.median(np.abs(lags))), 2) if len(lags) else None,
        "kick_align_max_ms": round(float(np.max(np.abs(lags))), 2) if len(lags) else None,
        "kick_align_windows": int(len(lags)),
    }


def bass_overlap(out_stem, in_stem, sr, start, end, beat_sec):
    sos = butter(4, 150, btype='low', fs=sr, output='sos')
    n = int(beat_sec * sr)
    active = []
    for s in (out_stem, in_stem):
        lo = sosfiltfilt(sos, s.astype(np.float64))
        rms = np.array([np.sqrt(np.mean(lo[i:i + n] ** 2)) for i in range(0, len(lo) - n, n)])
        ref = np.percentile(rms, 95)
        active.append((_db(rms) > _db(ref) - 12.0) & (rms > 1e-5))
    a0, a1 = int(start / beat_sec), int(end / beat_sec)
    both = active[0][a0:a1] & active[1][a0:a1]
    return {"bass_overlap_s": round(float(both.sum() * beat_sec), 2)}


def loudness_profile(mix, sr, start, end, beat_sec):
    n = int(4 * beat_sec * sr)
    bars = np.array([np.sqrt(np.mean(mix[i:i + n] ** 2)) for i in range(0, len(mix) - n, n)])
    db = _db(bars)
    b0, b1 = int(start / (4 * beat_sec)), int(end / (4 * beat_sec))
    pre = np.median(db[max(0, b0 - 4):b0]) if b0 > 0 else db[b0]
    post = np.median(db[b1:b1 + 4]) if b1 < len(db) else db[-1]
    during = db[b0:b1] if b1 > b0 else db[b0:b0 + 1]
    return {
        "loudness_dip_db": round(float(during.min() - min(pre, post)), 2),
        "loudness_bump_db": round(float(during.max() - max(pre, post)), 2),
        "level_pre_db": round(float(pre), 2),
        "level_post_db": round(float(post), 2),
    }


def score_transition(out_stem, in_stem, sr, start, end, beat_sec):
    """out_stem / in_stem: each deck's contribution to the mix (mono, same length)."""
    mix = out_stem + in_stem
    result = {}
    result.update(kick_alignment(out_stem, in_stem, sr, start, end, beat_sec))
    result.update(bass_overlap(out_stem, in_stem, sr, start, end, beat_sec))
    result.update(loudness_profile(mix, sr, start, end, beat_sec))
    return result
