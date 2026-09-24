"""
transition_metrics.py - Objective scores for a rendered transition, from per-deck stems.

  kick phase       each deck's kicks measured against the shared master grid (outgoing before
                   the bass swap, incoming after it). The difference is the flam you'd hear:
                   >10 ms starts to smear, >20 ms is a trainwreck.
  bass overlap     seconds where BOTH decks carry full bass (two kicks/basslines = mud).
  bass gap         seconds inside the transition where NEITHER deck carries bass (a hole).
  loudness         per-bar level of the mix across the transition versus each track alone:
                   a dip is a hole in the dancefloor, a bump is a volume spike.
"""

import numpy as np
from scipy.signal import butter, sosfiltfilt, hilbert, find_peaks


def _db(x):
    return 20.0 * np.log10(np.maximum(x, 1e-9))


def _kick_onsets(stem, sr, t0, t1):
    """Kick/bass-hit onset times (s) in [t0, t1): peaks of the low-band envelope slope."""
    a, b = max(0, int(t0 * sr)), min(len(stem), int(t1 * sr))
    if b - a < sr:
        return np.array([])
    lo = sosfiltfilt(butter(4, 150, btype='low', fs=sr, output='sos'), stem[a:b].astype(np.float64))
    hop = max(1, sr // 1000)
    env = np.abs(hilbert(lo))
    env = env[: len(env) // hop * hop].reshape(-1, hop).mean(axis=1)
    slope = np.maximum(0, np.diff(env, prepend=env[0]))
    if slope.max() <= 1e-6:
        return np.array([])
    peaks, props = find_peaks(slope, distance=150, height=0.25 * np.percentile(slope, 99.5))
    return t0 + peaks * hop / sr


def kick_phase(out_stem, in_stem, sr, grid0, beat_sec, start, swap, end):
    def offset(stem, t0, t1):
        on = _kick_onsets(stem, sr, t0, t1)
        if len(on) == 0:
            return None, 0
        err = (on - grid0) / beat_sec
        err = (err - np.round(err)) * beat_sec * 1000.0
        on_beat = err[np.abs(err) < 0.25 * beat_sec * 1000.0]
        return (float(np.median(on_beat)) if len(on_beat) else None), int(len(on_beat))

    def folded(stem, t0, t1):
        # Same definition as the analyzer's grid anchor: 30% rise of the kick envelope averaged
        # over every beat in the region (robust to syncopated bass hits in sparse intros)
        from .audio_analyzer import _refine_beat_offset
        k0, k1 = int(np.ceil((t0 - grid0) / beat_sec)), int(np.floor((t1 - grid0) / beat_sec))
        if k1 - k0 < 8:
            return None
        return _refine_beat_offset(stem.astype(np.float32), sr, grid0 + beat_sec * np.arange(k0, k1), beat_sec) * 1000.0

    bar = 4 * beat_sec
    out_ms, n_out = offset(out_stem, max(0.0, start - 8 * bar), swap)
    in_ms, n_in = offset(in_stem, swap, end + 8 * bar)
    out_f = folded(out_stem, max(0.0, start - 8 * bar), swap)
    in_f = folded(in_stem, swap, end + 8 * bar)
    return {
        "kick_flam_ms": round(abs(in_f - out_f), 2) if out_f is not None and in_f is not None else None,
        "kick_out_vs_grid_ms": None if out_f is None else round(out_f, 2),
        "kick_in_vs_grid_ms": None if in_f is None else round(in_f, 2),
        "onset_flam_ms": round(abs(in_ms - out_ms), 2) if out_ms is not None and in_ms is not None else None,
        "kick_onsets_counted": [n_out, n_in],
    }


def bass_activity(out_stem, in_stem, sr, start, end, beat_sec):
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
    neither = ~active[0][a0:a1] & ~active[1][a0:a1]
    return {"bass_overlap_s": round(float(both.sum() * beat_sec), 2),
            "bass_gap_s": round(float(neither.sum() * beat_sec), 2)}


def loudness_profile(out_stem, in_stem, sr, start, end, beat_sec):
    n = int(4 * beat_sec * sr)
    mix = out_stem + in_stem

    def bars(x):
        return _db(np.array([np.sqrt(np.mean(x[i:i + n] ** 2)) for i in range(0, len(x) - n, n)]))

    db, db_out, db_in = bars(mix), bars(out_stem), bars(in_stem)
    b0, b1 = int(round(start / (4 * beat_sec))), int(round(end / (4 * beat_sec)))
    pre = np.median(db[max(0, b0 - 4):b0]) if b0 > 0 else db[b0]
    post = np.median(db[b1:b1 + 4]) if b1 < len(db) else db[-1]
    during = db[b0:b1] if b1 > b0 else db[b0:b0 + 1]
    lo, hi = max(0, b0 - 2), min(len(db), b1 + 3)
    return {
        "loudness_dip_db": round(float(during.min() - min(pre, post)), 2),
        "loudness_bump_db": round(float(during.max() - max(pre, post)), 2),
        "level_pre_db": round(float(pre), 2),
        "level_post_db": round(float(post), 2),
        "bars_from": lo - b0,
        "bar_mix_db": [round(float(v), 1) for v in db[lo:hi]],
        "bar_out_db": [round(float(v), 1) for v in db_out[lo:hi]],
        "bar_in_db": [round(float(v), 1) for v in db_in[lo:hi]],
    }


def score_transition(out_stem, in_stem, sr, start, end, beat_sec, swap=None):
    """out_stem / in_stem: each deck's contribution to the mix (mono, same length).
    start/swap/end: ctx seconds of blend start, bass swap and blend end (grid starts at `start`)."""
    swap = (start + end) / 2 if swap is None else swap
    result = {}
    result.update(kick_phase(out_stem, in_stem, sr, start, beat_sec, start, swap, end))
    result.update(bass_activity(out_stem, in_stem, sr, start, end, beat_sec))
    result.update(loudness_profile(out_stem, in_stem, sr, start, end, beat_sec))
    return result
