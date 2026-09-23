"""
synth.py - Synthetic dance tracks with a KNOWN beat grid, for measuring analyzer accuracy.

Every track has:
  - a kick whose first sample is exactly on each beat (the ground-truth beat time)
  - claps on 2 and 4, loud open hats and an 8th-note bassline on the OFF-beats
    (the things that pull a naive tracker half a beat late)
  - a chord change on every downbeat
  - optional pickup beats (audio starts mid-bar) and pre-roll bars (phrases don't start at bar 0)
  - 16-bar sections: intro / verse / breakdown (no kick) / drop x2 / outro
"""

import numpy as np

SR = 44100
CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]  # Am F C G (MIDI)


def _midi_hz(m):
    return 440.0 * 2 ** ((m - 69) / 12.0)


def _add(buf, start, sig):
    s = int(round(start * SR))
    if s >= len(buf) or s + len(sig) <= 0:
        return
    a = max(0, -s)
    e = min(len(buf), s + len(sig))
    buf[s + a:e] += sig[a:e - s]


def _kick():
    t = np.arange(int(0.3 * SR)) / SR
    f = 50 + 100 * np.exp(-t / 0.03)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.18)


def _noise_hit(rng, dur, decay, lo, hi):
    from scipy.signal import butter, sosfilt
    n = rng.standard_normal(int(dur * SR))
    sos = butter(4, [lo, hi], btype='band', fs=SR, output='sos') if hi else butter(4, lo, btype='high', fs=SR, output='sos')
    return sosfilt(sos, n) * np.exp(-np.arange(len(n)) / SR / decay)


def make_track(bpm=126.0, first_beat=0.0, pickup_beats=0, pre_bars=0, hat_gain=0.9, seed=0):
    """Returns (audio, truth) where truth has beat_times, downbeat_times, phrase_16_times."""
    rng = np.random.default_rng(seed)
    P = 60.0 / bpm
    sections = [('intro', 16), ('verse', 16), ('breakdown', 16), ('drop', 32), ('outro', 16)]
    n_bars = pre_bars + sum(b for _, b in sections)
    total_beats = pickup_beats + 4 * n_bars
    dur = first_beat + total_beats * P + 1.0
    buf = np.zeros(int(dur * SR))

    kick = _kick()
    clap = _noise_hit(rng, 0.2, 0.06, 900, 4000) * 0.5
    hat = _noise_hit(rng, 0.12, 0.04, 6000, None) * hat_gain

    bar_section = ['pre'] * pre_bars
    for name, bars in sections:
        bar_section += [name] * bars

    for k in range(total_beats):
        t = first_beat + k * P
        if k < pickup_beats:
            sec, bar, beat_in_bar = 'pre', -1, 4 - pickup_beats + k
        else:
            bar = (k - pickup_beats) // 4
            beat_in_bar = (k - pickup_beats) % 4
            sec = bar_section[bar]
        drums = sec in ('intro', 'verse', 'drop', 'outro')
        full = sec in ('verse', 'drop')
        if drums:
            _add(buf, t, kick)
            _add(buf, t + P / 2, hat)
        if full and beat_in_bar in (1, 3):
            _add(buf, t, clap)
        if full or sec == 'breakdown' or sec == 'pre':
            chord = CHORDS[bar % 4] if bar >= 0 else CHORDS[3]
            if beat_in_bar == 0 or k == 0:
                ln = int(4 * P * SR)
                tt = np.arange(ln) / SR
                env = np.minimum(1, tt / 0.01) * np.exp(-tt / (3 * P))
                pad = sum(np.sin(2 * np.pi * _midi_hz(m) * tt) for m in chord) * env * 0.12
                _add(buf, t, pad)
            if full:  # offbeat bassline on the chord root
                ln = int(0.45 * P * SR)
                tt = np.arange(ln) / SR
                note = np.sin(2 * np.pi * _midi_hz(chord[0] - 24) * tt) * np.minimum(1, tt / 0.004) * np.exp(-tt / 0.12) * 0.6
                _add(buf, t + P / 2, note)

    buf /= np.max(np.abs(buf)) + 1e-9
    beats = first_beat + P * np.arange(total_beats)
    downbeats = beats[pickup_beats::4]
    bar_idx = np.arange(len(downbeats))
    phrase16 = downbeats[(bar_idx - pre_bars) % 16 == 0]
    truth = {"bpm": bpm, "beat_times": beats, "downbeat_times": downbeats,
             "phrase_16_times": phrase16, "drop_time": downbeats[pre_bars + 48]}
    return (buf * 0.8).astype(np.float32), truth
