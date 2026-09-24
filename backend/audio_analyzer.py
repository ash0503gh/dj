"""
audio_analyzer.py - High-precision musical analysis for professional DJ mixing.
Extracts BPM, beat grid, 4/4 downbeats, Camelot musical key, structural phrases, and 3-band RGB waveform peaks.
"""

import numpy as np
from .lazy import LazyModule
librosa = LazyModule("librosa")
import soundfile as sf
import os
import gc
from typing import Dict, Any, List, Tuple

CAMELOT_MAP = {
    # Minor keys (A)
    ('Ab', 'minor'): '1A', ('G#', 'minor'): '1A',
    ('Eb', 'minor'): '2A', ('D#', 'minor'): '2A',
    ('Bb', 'minor'): '3A', ('A#', 'minor'): '3A',
    ('F', 'minor'): '4A',
    ('C', 'minor'): '5A',
    ('G', 'minor'): '6A',
    ('D', 'minor'): '7A',
    ('A', 'minor'): '8A',
    ('E', 'minor'): '9A',
    ('B', 'minor'): '10A',
    ('F#', 'minor'): '11A', ('Gb', 'minor'): '11A',
    ('C#', 'minor'): '12A', ('Db', 'minor'): '12A',
    
    # Major keys (B)
    ('B', 'major'): '1B',
    ('F#', 'major'): '2B', ('Gb', 'major'): '2B',
    ('Db', 'major'): '3B', ('C#', 'major'): '3B',
    ('Ab', 'major'): '4B', ('G#', 'major'): '4B',
    ('Eb', 'major'): '5B', ('D#', 'major'): '5B',
    ('Bb', 'major'): '6B', ('A#', 'major'): '6B',
    ('F', 'major'): '7B',
    ('C', 'major'): '8B',
    ('G', 'major'): '9B',
    ('D', 'major'): '10B',
    ('A', 'major'): '11B',
    ('E', 'major'): '12B',
}

PITCH_CLASSES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

# Krumhansl-Schmuckler Key Profiles
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

def estimate_key(y: np.ndarray, sr: int) -> Tuple[str, str, str]:
    """
    Estimates key and mode using chromagram correlation with Krumhansl-Schmuckler profiles.
    Optimized: extracts a 45-second representative segment for ultra-fast CQT.
    Returns (key_name, mode, camelot_code).
    """
    dur_samples = len(y)
    if dur_samples < 2048:
        return 'C', 'major', '8B'
    start_sample = int(dur_samples * 0.15)
    end_sample = min(dur_samples, start_sample + int(45 * sr))
    snippet = y[start_sample:end_sample] if end_sample > start_sample else y
    if len(snippet) < 2048:
        snippet = y

    try:
        chroma = librosa.feature.chroma_cqt(y=snippet, sr=sr, bins_per_octave=12)
        chroma_mean = np.mean(chroma, axis=1)
    except Exception:
        return 'C', 'major', '8B'
    
    # Normalize
    norm_val = np.linalg.norm(chroma_mean)
    if norm_val > 0:
        chroma_mean = chroma_mean / norm_val
    else:
        return 'C', 'major', '8B'
        
    major_norm = MAJOR_PROFILE / np.linalg.norm(MAJOR_PROFILE)
    minor_norm = MINOR_PROFILE / np.linalg.norm(MINOR_PROFILE)
    
    best_corr = -float('inf')
    best_key = 'C'
    best_mode = 'major'
    
    for i, root in enumerate(PITCH_CLASSES):
        try:
            maj_corr = np.corrcoef(chroma_mean, np.roll(major_norm, i))[0, 1]
            min_corr = np.corrcoef(chroma_mean, np.roll(minor_norm, i))[0, 1]
            
            if not np.isnan(maj_corr) and maj_corr > best_corr:
                best_corr = maj_corr
                best_key = root
                best_mode = 'major'
                
            if not np.isnan(min_corr) and min_corr > best_corr:
                best_corr = min_corr
                best_key = root
                best_mode = 'minor'
        except Exception:
            continue
            
    camelot = CAMELOT_MAP.get((best_key, best_mode), '8A')
    display_key = f"{best_key} {best_mode.capitalize()}"
    return display_key, best_mode, camelot

def check_camelot_compatibility(camelot_a: str, camelot_b: str) -> Dict[str, Any]:
    """
    Computes harmonic compatibility between two Camelot keys.
    """
    num_a = int(camelot_a[:-1])
    letter_a = camelot_a[-1]
    
    num_b = int(camelot_b[:-1])
    letter_b = camelot_b[-1]
    
    is_same = (camelot_a == camelot_b)
    is_relative = (num_a == num_b and letter_a != letter_b)
    diff = (num_b - num_a) % 12
    is_adjacent_up = (diff == 1 and letter_a == letter_b)
    is_adjacent_down = (diff == 11 and letter_a == letter_b)
    
    score = 0
    relationship = "Key Clash (Pitch shift recommended)"
    pitch_shift_semitones = 0
    
    if is_same:
        score = 100
        relationship = "Exact Key Match (Harmonic resonance)"
    elif is_relative:
        score = 90
        relationship = "Relative Major/Minor (Mood change)"
    elif is_adjacent_up:
        score = 85
        relationship = "+1 Energy Boost"
    elif is_adjacent_down:
        score = 85
        relationship = "-1 Deepening / Chillout"
    else:
        score = 50
        relationship = "Dissonant (Harmonic Shift available)"
        pitch_shift_semitones = 1 if diff in [2, 3, 4] else (-1 if diff in [8, 9, 10] else 0)
        
    return {
        "score": score,
        "relationship": relationship,
        "recommended_pitch_shift": pitch_shift_semitones,
        "is_harmonically_compatible": score >= 80
    }

def generate_rgb_waveform(mono: np.ndarray, sr: int, num_bins: int = 800) -> Dict[str, List[float]]:
    """
    Fast Rekordbox-style 3-band RGB waveform peak arrays:
    - Red: Low frequencies (< 250 Hz, Kick/Bass)
    - Green: Mid frequencies (250 Hz - 2.5 kHz, Vocals/Leads)
    - Blue: High frequencies (> 2.5 kHz, Hats/Cymbals)
    Downsampled to 8000 Hz for 20x faster filtering without visual quality loss.
    """
    target_sr = 8000
    step = max(1, sr // target_sr)
    downsampled = mono[::step]
    ds_sr = sr // step
    ds_bin_size = max(1, len(downsampled) // num_bins)
    
    from scipy.signal import butter, sosfilt
    
    sos_low = butter(2, 250, btype='low', fs=ds_sr, output='sos').astype(np.float32)
    sos_mid = butter(2, [250, min(2500, int(ds_sr / 2 - 50))], btype='bandpass', fs=ds_sr, output='sos').astype(np.float32)
    sos_high = butter(2, min(2500, int(ds_sr / 2 - 100)), btype='high', fs=ds_sr, output='sos').astype(np.float32)
    
    low_band = sosfilt(sos_low, downsampled)
    mid_band = sosfilt(sos_mid, downsampled)
    high_band = sosfilt(sos_high, downsampled)
    
    red_peaks = []
    green_peaks = []
    blue_peaks = []
    total_peaks = []
    
    for b in range(num_bins):
        start = b * ds_bin_size
        end = min(len(downsampled), start + ds_bin_size)
        if start >= end:
            break
        
        r_val = float(np.max(np.abs(low_band[start:end])))
        g_val = float(np.max(np.abs(mid_band[start:end])))
        b_val = float(np.max(np.abs(high_band[start:end])))
        tot_val = float(np.max(np.abs(downsampled[start:end])))
        
        red_peaks.append(round(r_val, 4))
        green_peaks.append(round(g_val, 4))
        blue_peaks.append(round(b_val, 4))
        total_peaks.append(round(tot_val, 4))
        
    max_tot = max(total_peaks) if total_peaks and max(total_peaks) > 0 else 1.0
    return {
        "low_red": [round(v / max_tot, 4) for v in red_peaks],
        "mid_green": [round(v / max_tot, 4) for v in green_peaks],
        "high_blue": [round(v / max_tot, 4) for v in blue_peaks],
        "overall": [round(v / max_tot, 4) for v in total_peaks]
    }

def extract_acoustic_profile(mono: np.ndarray, sr: int, duration: float, cue_intro: float, cue_outro: float) -> Dict[str, Any]:
    """
    Extracts true physical acoustic audio features using spectral filterbanks:
    - Vocal Formant Energy Ratio (300Hz - 3200Hz) vs sub-bass (<220Hz)
    - Spectral Flatness (harmonicity of vocal bands)
    - Percussion density & onset rate (detecting 4/4 driving beats vs ambient breakdowns)
    Specifically computes metrics for Intro window and Outro window to detect vocal presence at transition points.
    """
    from scipy.signal import butter, sosfilt
    
    sos_sub = butter(2, 220 / (sr / 2), btype='low', output='sos').astype(np.float32)
    sos_vocal = butter(2, [300 / (sr / 2), min(0.85, 3200 / (sr / 2))], btype='bandpass', output='sos').astype(np.float32)
    
    def analyze_chunk(chunk: np.ndarray) -> Dict[str, Any]:
        if len(chunk) < int(0.5 * sr):
            return {
                "has_vocals": False,
                "vocal_score": 0.0,
                "bass_ratio": 0.5,
                "vocal_ratio": 0.0,
                "percussion_density": "sparse_intro",
                "energy_db": -60.0
            }
            
        tot_energy = float(np.mean(chunk ** 2)) + 1e-7
        sub_chunk = sosfilt(sos_sub, chunk)
        vocal_chunk = sosfilt(sos_vocal, chunk)
        
        sub_energy = float(np.mean(sub_chunk ** 2))
        vocal_energy = float(np.mean(vocal_chunk ** 2))
        
        bass_ratio = min(1.0, sub_energy / tot_energy)
        vocal_ratio = min(1.0, vocal_energy / tot_energy)
        
        # Spectral Flatness in vocal band (vocals have sharp harmonic peaks -> lower flatness)
        try:
            flatness = float(np.mean(librosa.feature.spectral_flatness(y=vocal_chunk[:sr*10])))
        except Exception:
            flatness = 0.01
            
        raw_vocal_score = (vocal_ratio * 1.8) * (1.0 - min(0.8, flatness * 15.0))
        vocal_score = float(np.clip(raw_vocal_score, 0.0, 1.0))
        has_vocals = bool(vocal_score >= 0.22)
        
        # Percussion density in chunk
        try:
            onset_env = librosa.onset.onset_strength(y=sub_chunk, sr=sr)
            peaks = librosa.util.peak_pick(onset_env, pre_max=3, post_max=3, pre_avg=3, post_avg=3, delta=0.5, wait=10)
            chunk_sec = len(chunk) / sr
            onsets_per_sec = len(peaks) / max(0.1, chunk_sec)
            
            if onsets_per_sec >= 1.5:
                percussion_density = "driving_4_4"
            elif onsets_per_sec >= 0.7:
                percussion_density = "syncopated_groove"
            else:
                percussion_density = "melodic_breakdown"
        except Exception:
            percussion_density = "driving_4_4" if bass_ratio > 0.3 else "melodic_breakdown"
            
        energy_db = float(round(10.0 * np.log10(tot_energy), 1))
        
        return {
            "has_vocals": has_vocals,
            "vocal_score": round(vocal_score, 3),
            "vocal_ratio": round(vocal_ratio, 3),
            "bass_ratio": round(bass_ratio, 3),
            "percussion_density": percussion_density,
            "energy_db": energy_db
        }

    # Extract intro window (first 35s or around cue_intro)
    intro_end = min(len(mono), int(max(20.0, cue_intro + 20.0) * sr))
    intro_chunk = mono[:intro_end]
    
    # Extract outro window (last 35s or around cue_outro)
    outro_start = max(0, int(min(duration - 20.0, cue_outro - 10.0) * sr))
    outro_chunk = mono[outro_start:]
    
    intro_analysis = analyze_chunk(intro_chunk)
    outro_analysis = analyze_chunk(outro_chunk)
    
    return {
        "intro": intro_analysis,
        "outro": outro_analysis,
        "vocal_detected_intro": intro_analysis["has_vocals"],
        "vocal_detected_outro": outro_analysis["has_vocals"],
        "intro_vocal_score": intro_analysis["vocal_score"],
        "outro_vocal_score": outro_analysis["vocal_score"],
        "intro_percussion": intro_analysis["percussion_density"],
        "outro_percussion": outro_analysis["percussion_density"]
    }

def compute_section_map(mono: np.ndarray, sr: int, beat_times: List[float], bpm: float) -> List[Dict[str, Any]]:
    """
    Builds a per-4-bar-window map of energy, spectral density, and vocal activity.
    Each entry covers 16 beats (4 bars). Used by the frontend to make content-aware
    transition decisions: where to start blending, how to shape EQ curves, and
    whether vocals overlap.
    """
    from scipy.signal import butter, sosfilt

    if len(beat_times) < 16 or len(mono) < sr:
        return []

    spb = 60.0 / bpm
    sos_low = butter(2, min(0.95, 250 / (sr / 2)), btype='low', output='sos')
    sos_mid_upper = min(0.95, 2500 / (sr / 2))
    sos_mid_lower = min(sos_mid_upper - 0.01, 250 / (sr / 2))
    sos_mid = butter(2, [sos_mid_lower, sos_mid_upper], btype='bandpass', output='sos')
    sos_high = butter(2, min(0.95, 2500 / (sr / 2)), btype='high', output='sos')
    sos_vocal = butter(2, [min(0.95, 300 / (sr / 2)), min(0.95, 3200 / (sr / 2))], btype='bandpass', output='sos')

    # Filter each 4-bar chunk on its own (float32) instead of four full-length
    # float64 copies of the track, so full-track analysis fits in 512MB.
    sos_low, sos_mid, sos_high, sos_vocal = (s.astype(np.float32) for s in (sos_low, sos_mid, sos_high, sos_vocal))

    global_rms = float(np.sqrt(np.mean(mono ** 2))) + 1e-10

    sections = []
    window_beats = 16  # 4 bars

    for i in range(0, len(beat_times) - window_beats + 1, window_beats):
        t_start = beat_times[i]
        t_end = beat_times[min(i + window_beats, len(beat_times) - 1)]
        if i + window_beats < len(beat_times):
            t_end = beat_times[i + window_beats]
        else:
            t_end = t_start + window_beats * spb

        s0 = max(0, int(t_start * sr))
        s1 = min(len(mono), int(t_end * sr))
        if s1 - s0 < int(0.5 * sr):
            continue

        chunk = mono[s0:s1]
        rms = float(np.sqrt(np.mean(chunk ** 2)))
        energy = round(min(1.0, rms / global_rms), 3)

        bass_e = float(np.sqrt(np.mean(sosfilt(sos_low, chunk) ** 2)))
        mid_e = float(np.sqrt(np.mean(sosfilt(sos_mid, chunk) ** 2)))
        high_e = float(np.sqrt(np.mean(sosfilt(sos_high, chunk) ** 2)))
        band_total = bass_e + mid_e + high_e + 1e-10

        vocal_chunk = sosfilt(sos_vocal, chunk)
        vocal_e = float(np.sqrt(np.mean(vocal_chunk ** 2)))
        try:
            flatness = float(np.mean(librosa.feature.spectral_flatness(y=vocal_chunk)))
        except Exception:
            flatness = 0.01
        vocal_ratio = min(1.0, vocal_e / (rms + 1e-10))
        raw_vocal = (vocal_ratio * 1.8) * (1.0 - min(0.8, flatness * 15.0))
        vocal_score = round(float(np.clip(raw_vocal, 0.0, 1.0)), 3)

        sections.append({
            "time": round(t_start, 3),
            "duration": round(t_end - t_start, 3),
            "energy": energy,
            "bass_energy": round(bass_e / band_total, 3),
            "mid_energy": round(mid_e / band_total, 3),
            "high_energy": round(high_e / band_total, 3),
            "vocal_score": vocal_score,
            "has_vocals": vocal_score >= 0.22
        })

    if len(sections) >= 2:
        for i, sec in enumerate(sections):
            prev_e = sections[i - 1]["energy"] if i > 0 else sec["energy"]
            next_e = sections[i + 1]["energy"] if i < len(sections) - 1 else sec["energy"]
            e = sec["energy"]

            if e < 0.4 and sec["bass_energy"] < 0.3:
                sec["section_type"] = "breakdown"
            elif e > prev_e * 1.3 and e > 0.6:
                sec["section_type"] = "drop"
            elif next_e > e * 1.2 and e > 0.3:
                sec["section_type"] = "buildup"
            elif i <= 1:
                sec["section_type"] = "intro"
            elif i >= len(sections) - 2:
                sec["section_type"] = "outro"
            else:
                sec["section_type"] = "groove"

    return sections


# ─────────────────────────────────────────────────────────────────────────────
# Beat grid (v2): dance music is quantized, so instead of trusting per-beat
# tracker output we fit ONE constant-tempo grid (period + anchor) to the whole
# track, then find the bar phase and phrase phase from structural changes.
# ─────────────────────────────────────────────────────────────────────────────

ANALYSIS_VERSION = 5
ANALYSIS_SR = 16000
ONSET_HOP = 128            # 8 ms onset frames
BPM_RANGE = (85.0, 185.0)


def _fold_bpm(bpm: float) -> float:
    if not np.isfinite(bpm) or bpm <= 0:
        return 128.0
    while bpm < BPM_RANGE[0]:
        bpm *= 2.0
    while bpm >= BPM_RANGE[1]:
        bpm /= 2.0
    return bpm


def load_mono(path: str, sr: int = ANALYSIS_SR) -> np.ndarray:
    """Decode straight to mono float32 at `sr` with ffmpeg (the decoder browsers use too, so
    encoder-delay handling matches playback). librosa.load keeps the full-rate stereo decode
    plus resampler buffers: ~300 MB for a 6-minute MP3."""
    import subprocess
    try:
        out = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '1', '-ar', str(sr), '-'],
                             capture_output=True, check=True).stdout
        return np.frombuffer(out, dtype=np.float32).copy()
    except (FileNotFoundError, subprocess.CalledProcessError):
        y, _ = librosa.load(path, sr=sr, mono=True)
        return y


def load_stereo_window(path: str, sr: int, offset: float, duration: float) -> np.ndarray:
    """Decode only [offset, offset + duration) as stereo float32 (2 x N) with ffmpeg."""
    import subprocess
    try:
        out = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{offset:.6f}', '-t', f'{duration:.6f}', '-i', path,
                              '-f', 'f32le', '-ac', '2', '-ar', str(sr), '-'],
                             capture_output=True, check=True).stdout
        return np.frombuffer(out, dtype=np.float32).reshape(-1, 2).T.copy()
    except (FileNotFoundError, subprocess.CalledProcessError):
        y, _ = librosa.load(path, sr=sr, mono=False, offset=offset, duration=duration)
        return y if y.ndim == 2 else np.vstack([y, y])


def _band_power(y: np.ndarray, n_fft: int, hop: int, basis: np.ndarray) -> np.ndarray:
    """basis @ |STFT|^2 (centered Hann frames, like librosa), computed a block of frames at a
    time so the full complex spectrogram never exists in memory."""
    yp = np.pad(y, n_fft // 2)
    frames = np.lib.stride_tricks.sliding_window_view(yp, n_fft)[::hop]
    win = np.hanning(n_fft + 1)[:-1].astype(np.float32)
    out = np.empty((basis.shape[0], len(frames)), dtype=np.float32)
    block = max(64, 2 ** 20 // n_fft)
    for f0 in range(0, len(frames), block):
        spec = np.abs(np.fft.rfft(frames[f0:f0 + block] * win, axis=1)) ** 2
        with np.errstate(all='ignore'):  # macOS Accelerate raises spurious FP flags in float32 matmul
            out[:, f0:f0 + block] = basis @ spec.T
    return out


def _coarse_tempo(env: np.ndarray, fps: float) -> float:
    """Global tempo from the onset envelope's autocorrelation, with a log-normal prior at 120 BPM."""
    ac = librosa.autocorrelate(env - env.mean(), max_size=int(fps * 60.0 / 40.0))
    lags = np.arange(int(fps * 60.0 / 240.0), len(ac))
    bpms = 60.0 * fps / lags
    weight = np.exp(-0.5 * np.log2(bpms / 120.0) ** 2)
    return float(bpms[int(np.argmax(ac[lags] * weight))])


def _onset_envelopes(y: np.ndarray, sr: int):
    """Spectral-flux onset envelopes from a log-mel spectrogram.
    low: < 150 Hz (kick), lowmid: < 2.5 kHz (kick + snare/clap, no hats), full: all bands."""
    n_mels = 64
    S = _band_power(y, 1024, ONSET_HOP, librosa.filters.mel(sr=sr, n_fft=1024, n_mels=n_mels, fmin=20.0, fmax=sr / 2.0))
    freqs = librosa.mel_frequencies(n_mels=n_mels + 2, fmin=20.0, fmax=sr / 2.0)[1:-1]
    logS = librosa.power_to_db(S, ref=np.max).astype(np.float32)
    del S
    flux = np.maximum(0.0, np.diff(logS, axis=1, prepend=logS[:, :1]))
    low = flux[freqs < 150].mean(axis=0)
    lowmid = flux[freqs < 2500].mean(axis=0)
    full = flux.mean(axis=0)
    return logS, freqs, low, lowmid, full


def _fold(env: np.ndarray, period: float, nbins: int) -> np.ndarray:
    """Average `env` by phase within `period` (in frames)."""
    ph = np.mod(np.arange(len(env), dtype=np.float64), period) / period
    idx = np.minimum((ph * nbins).astype(np.int64), nbins - 1)
    s = np.bincount(idx, weights=env, minlength=nbins)
    c = np.bincount(idx, minlength=nbins)
    return s / np.maximum(c, 1)


def _circular_peak(hist: np.ndarray) -> float:
    """Sub-bin position of the maximum of a circular histogram (parabolic interpolation)."""
    j = int(np.argmax(hist))
    y0, y1, y2 = hist[j - 1], hist[j], hist[(j + 1) % len(hist)]
    den = y0 - 2 * y1 + y2
    d = 0.5 * (y0 - y2) / den if den != 0 else 0.0
    return (j + float(np.clip(d, -0.5, 0.5))) % len(hist)


def _fit_constant_grid(env: np.ndarray, fps: float, coarse_bpm: float) -> Dict[str, Any]:
    """Find the constant tempo + phase that best explains the onset envelope over the whole track."""
    # 1. Fine BPM search (0.01 BPM steps, ±3%): the right period stacks every beat of the
    #    track onto one phase bin; a period that is off by 1% smears them over 7+ beats.
    cands = np.arange(coarse_bpm * 0.97, coarse_bpm * 1.03, 0.01)
    kernel = np.array([0.25, 0.5, 0.25])
    best_bpm, best_score = coarse_bpm, -np.inf
    for b in cands:
        h = _fold(env, fps * 60.0 / b, 64)
        h = np.convolve(np.concatenate([h[-1:], h, h[:1]]), kernel, mode='valid')
        score = (h.max() - h.mean()) / (h.mean() + 1e-9)
        if score > best_score:
            best_bpm, best_score = float(b), score

    period = fps * 60.0 / best_bpm
    phase0 = _circular_peak(_fold(env, period, 128)) / 128.0 * period

    # 2. Find the actual onset near every predicted beat, then least-squares fit
    #    time = anchor + k * period, rejecting outliers (fills, breakdowns, swing).
    ks = np.arange(0, int((len(env) - 1 - phase0) / period) + 1)
    half = 0.12 * period
    det_t, det_s = [], []
    for k in ks:
        p = phase0 + k * period
        a, b = int(max(0, np.floor(p - half))), int(min(len(env) - 1, np.ceil(p + half)))
        seg = env[a:b + 1]
        if len(seg) < 3:
            det_t.append(p)
            det_s.append(0.0)
            continue
        j = int(np.argmax(seg))
        d = 0.0
        if 0 < j < len(seg) - 1:
            den = seg[j - 1] - 2 * seg[j] + seg[j + 1]
            d = 0.5 * (seg[j - 1] - seg[j + 1]) / den if den != 0 else 0.0
        det_t.append(a + j + float(np.clip(d, -0.5, 0.5)))
        det_s.append(float(seg[j]))
    det_t, det_s = np.array(det_t), np.array(det_s)

    mask = det_s >= np.percentile(det_s, 40) if len(det_s) > 8 else np.ones(len(det_s), bool)
    coef = np.array([phase0, period])
    for _ in range(4):
        if mask.sum() < 8:
            break
        A = np.vstack([np.ones(mask.sum()), ks[mask]]).T
        coef = np.linalg.lstsq(A, det_t[mask], rcond=None)[0]
        res = det_t - (coef[0] + coef[1] * ks)
        mad = 1.4826 * np.median(np.abs(res[mask])) + 1e-9
        mask = mask & (np.abs(res) < max(3.0 * mad, 1.0))

    res = det_t - (coef[0] + coef[1] * ks)
    strong = det_s >= np.percentile(det_s, 40) if len(det_s) > 8 else np.ones(len(det_s), bool)
    confidence = float(np.mean(np.abs(res[strong]) < 0.020 * fps)) if strong.any() else 0.0

    # Tempo stability: median residual per quarter of the track. A live-played or
    # tempo-mapped track shows a trend here that no single constant grid can follow.
    drift_ms = 0.0
    kept = np.where(mask)[0]
    if len(kept) >= 16:
        q = [np.median(res[c]) for c in np.array_split(kept, 4)]
        drift_ms = float((max(q) - min(q)) / fps * 1000.0)

    return {
        "period_frames": float(coef[1]),
        "anchor_frames": float(coef[0]),
        "beat_ks": ks,
        "kick_mask": mask,
        "confidence": confidence,
        "drift_ms": drift_ms,
    }


def _refine_beat_offset(y: np.ndarray, sr: int, beat_times: np.ndarray, period_sec: float) -> float:
    """Place the grid on the kick TRANSIENT rather than the spectral-flux frame.
    Averages the low-band (< 200 Hz) Hilbert envelope around every kick beat and returns
    the shift (s) from the predicted beat to the point where that average rises to 30%."""
    from scipy.signal import butter, sosfiltfilt, hilbert
    sos = butter(4, 200, btype='low', fs=sr, output='sos')
    w = int(0.3 * period_sec * sr)
    pad = int(0.05 * sr)
    acc = np.zeros(2 * w)
    n = 0
    for t in beat_times:
        c = int(round(t * sr))
        a, b = c - w - pad, c + w + pad
        if a < 0 or b > len(y):
            continue
        seg = sosfiltfilt(sos, y[a:b].astype(np.float64))
        acc += np.abs(hilbert(seg))[pad:pad + 2 * w]
        n += 1
    if n < 8:
        return 0.0
    E = acc / n
    r = int(0.2 * period_sec * sr)
    j = w - r + int(np.argmax(E[w - r:w + r]))
    base = float(np.percentile(E[max(0, j - int(0.25 * period_sec * sr)):j + 1], 10))
    if E[j] < 1.5 * base:
        return 0.0  # no clear transient on the beat (e.g. sustained bass): keep flux estimate
    thr = base + 0.3 * (E[j] - base)
    i = j
    while i > 0 and E[i] > thr:
        i -= 1
    frac = (thr - E[i]) / (E[i + 1] - E[i]) if E[i + 1] != E[i] else 0.0
    return (i + frac - w) / sr


def _sync_mean(feat: np.ndarray, fps: float, bounds_sec: np.ndarray) -> np.ndarray:
    """Mean of feature frames (d x T) inside each [bounds[i], bounds[i+1]) span -> d x (len-1)."""
    T = feat.shape[1]
    idx = np.clip(np.round(bounds_sec * fps).astype(int), 0, T)
    out = np.zeros((feat.shape[0], len(idx) - 1), dtype=np.float32)
    for i in range(len(idx) - 1):
        a, b = idx[i], max(idx[i] + 1, idx[i + 1])
        if a < T:
            out[:, i] = feat[:, a:min(b, T)].mean(axis=1)
    return out


def _boundary_novelty(F: np.ndarray, ctx: int, cosine: bool = False) -> np.ndarray:
    """Novelty at each boundary k (between unit k-1 and k): distance between the mean of
    the ctx units before and the ctx units after. F is d x N."""
    N = F.shape[1]
    nov = np.zeros(N)
    if N < 2 * ctx:
        return nov
    cs = np.concatenate([np.zeros((F.shape[0], 1)), np.cumsum(F, axis=1)], axis=1)
    for k in range(ctx, N - ctx + 1):
        a = (cs[:, k] - cs[:, k - ctx]) / ctx
        b = (cs[:, k + ctx] - cs[:, k]) / ctx
        if cosine:
            nov[k] = 1.0 - float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))
        else:
            nov[k] = float(np.linalg.norm(a - b))
    return nov


def _z(x: np.ndarray) -> np.ndarray:
    return (x - x.mean()) / (x.std() + 1e-9) if len(x) else x


def _best_offset(nov: np.ndarray, modulus: int, choices) -> int:
    scores = {o: float(np.mean(nov[o::modulus])) if len(nov[o::modulus]) else -np.inf for o in choices}
    return max(scores, key=scores.get)


def _bass_entries(low_db: np.ndarray) -> np.ndarray:
    """Per bar: dB by which kick/bass comes in on this bar and stays at body level for 4 bars
    (beyond a 6 dB margin), else 0."""
    out = np.zeros(len(low_db))
    median = float(np.median(low_db)) if len(low_db) else 0.0
    for b in range(1, len(low_db) - 3):
        after = float(low_db[b:b + 4].min())
        if after > median:
            out[b] = max(0.0, after - float(low_db[b - 1]) - 6.0)
    return out


def build_grid_times(grid: Dict[str, Any], duration: float) -> Dict[str, List[float]]:
    """Expand grid parameters into the beat/downbeat/phrase time lists the frontend uses."""
    period = grid["period"]
    first = grid["first_beat"]
    n = max(1, int((duration - first) / period) + 1)
    beats = np.round(first + period * np.arange(n), 3)
    db0 = grid["downbeat_offset"]
    downbeats = beats[db0::4]
    bars = np.arange(len(downbeats))
    po = grid["phrase_offset_bars"]
    return {
        "beat_times": beats.tolist(),
        "downbeat_times": downbeats.tolist(),
        "phrase_8_times": downbeats[(bars - po) % 8 == 0].tolist(),
        "phrase_16_times": downbeats[(bars - po) % 16 == 0].tolist(),
        "phrase_32_times": downbeats[(bars - po) % 32 == 0].tolist(),
    }


def estimate_grid(y: np.ndarray, sr: int, duration: float) -> Dict[str, Any]:
    """Full-track grid: BPM (0.01), kick-aligned anchor, downbeat phase, phrase phase,
    structural boundaries and drops."""
    fps = sr / ONSET_HOP
    logS, freqs, env_low, env_lowmid, env_full = _onset_envelopes(y, sr)

    coarse = _fold_bpm(_coarse_tempo(env_full, fps))
    if coarse * 2 < BPM_RANGE[1]:
        # Octave check (e.g. 87 vs 174): if kick/snare hits land as strongly half-way
        # between the "beats" as on them, the real beat is twice as fast.
        h = _fold(env_lowmid, fps * 60.0 / coarse, 64)
        h = h - np.median(h)
        j = int(np.argmax(h))
        opposite = max(h[(j + 32 + d) % 64] for d in (-2, -1, 0, 1, 2))
        if h[j] > 0 and opposite / h[j] > 0.6:
            coarse *= 2
    # Kick + snare envelope (no hats), so the grid locks to the beat, not the off-beat hat.
    fit = _fit_constant_grid(env_lowmid, fps, coarse)
    period = fit["period_frames"] / fps
    # Flux frame i measures the change from frame i-1 to i: centre it half a hop earlier.
    anchor = (fit["anchor_frames"] - 0.5) / fps
    bpm = 60.0 / period

    kick_beats = anchor + period * fit["beat_ks"][fit["kick_mask"]]
    anchor += _refine_beat_offset(y, sr, kick_beats, period)
    # Earliest grid beat; allow up to -15 ms so a kick right at 0.000 isn't pushed a beat later
    first_beat = anchor - np.floor((anchor + 0.015) / period) * period

    n_beats = max(1, int((duration - first_beat) / period) + 1)
    beat_t = first_beat + period * np.arange(n_beats + 1)

    # ── Downbeat: harmony and texture change on the 1 ──
    beat_mel = _sync_mean(logS, fps, beat_t)
    chroma = _band_power(y, 4096, 1024, librosa.filters.chroma(sr=sr, n_fft=4096))
    beat_chroma = _sync_mean(chroma, sr / 1024.0, beat_t)
    del chroma
    nov_beat = (_z(_boundary_novelty(beat_chroma, 1, cosine=True))
                + _z(_boundary_novelty(beat_chroma, 2, cosine=True))
                + _z(_boundary_novelty(beat_mel, 4)))
    downbeat_offset = _best_offset(nov_beat, 4, range(4)) if n_beats >= 16 else 0

    # ── Phrases: sections change on 8/16/32-bar boundaries ──
    bar_t = beat_t[downbeat_offset::4]
    phrase_offset = 0
    boundaries, drops, bar_low_db = [], [], []

    # Track body loudness (mean RMS of its louder half of bars): what a DJ matches with the trim knob
    bar_rms_db = np.array([20 * np.log10(np.sqrt(np.mean(y[int(a * sr):int(b * sr)] ** 2)) + 1e-9)
                           for a, b in zip(bar_t[:-1], bar_t[1:]) if b * sr <= len(y)])
    loudness_db = float(np.mean(np.sort(bar_rms_db)[len(bar_rms_db) // 2:])) if len(bar_rms_db) else -20.0

    if len(bar_t) >= 17:
        bar_mel = _sync_mean(logS, fps, bar_t)
        bar_chroma = _sync_mean(beat_chroma, 1.0, np.arange(downbeat_offset, len(beat_t), 4, dtype=float))
        nov_bar = _z(_boundary_novelty(bar_mel, 4)) + 0.5 * _z(_boundary_novelty(bar_chroma, 4, cosine=True))
        # Where the bass comes back in and stays is the 1 of a phrase. Texture novelty alone also
        # peaks on the one-bar mute before a drop, which put phrases a bar early on such tracks.
        phrase_score = nov_bar + _bass_entries(bar_mel[freqs < 150].mean(axis=0)) / 5.0
        o8 = _best_offset(phrase_score, 8, range(8))
        o16 = _best_offset(phrase_score, 16, (o8, o8 + 8))
        phrase_offset = _best_offset(phrase_score, 32, (o16, o16 + 16))

        # Structural boundaries: clear local novelty peaks
        thr = nov_bar.mean() + 0.75 * nov_bar.std()
        for b in range(2, len(nov_bar) - 2):
            if nov_bar[b] >= thr and nov_bar[b] == nov_bar[max(0, b - 3):b + 4].max():
                boundaries.append(round(float(bar_t[b]), 3))

        # Drops: a 4-bar-aligned point where kick/bass energy jumps and STAYS high for 8 bars
        # (a 4-bar hit followed by a breakdown is not somewhere to land a mix)
        low_db = bar_mel[freqs < 150].mean(axis=0)
        bar_low_db = [round(float(v), 1) for v in low_db]
        median_low = float(np.median(low_db))
        for b in range(4, len(low_db) - 7):
            if (b - phrase_offset) % 4 or bar_t[b] > 0.5 * duration:
                continue  # a "drop" in the second half is where the track ends, not where to mix in
            after, before = float(low_db[b:b + 8].mean()), float(low_db[b - 4:b].mean())
            if after - before > 6.0 and after > median_low and low_db[b:b + 8].min() > median_low - 3.0:
                drops.append(round(float(bar_t[b]), 3))

    del logS
    return {
        "grid": {
            "bpm": round(bpm, 4),
            "period": period,
            "first_beat": round(float(first_beat), 5),
            "downbeat_offset": int(downbeat_offset),
            "phrase_offset_bars": int(phrase_offset),
            "confidence": round(fit["confidence"], 3),
            "drift_ms": round(fit["drift_ms"], 1),
            "tempo_stable": fit["drift_ms"] < 25.0,
        },
        "section_boundaries": boundaries,
        "drop_times": drops,
        "bar_low_db": bar_low_db,          # kick/bass level per bar from the first downbeat
        "loudness_db": round(loudness_db, 2),
    }


def analyze_track(file_path: str) -> Dict[str, Any]:
    """
    Full professional track analysis over the WHOLE track (16 kHz mono, ~23 MB for 6 min).
    """
    sr = ANALYSIS_SR
    y = load_mono(file_path, sr)
    mono = y
    duration = len(y) / sr

    est = estimate_grid(mono, sr, duration)
    grid = est["grid"]
    bpm = grid["bpm"]
    times = build_grid_times(grid, duration)
    beat_times = times["beat_times"]
    downbeat_times = times["downbeat_times"]

    # 2. Key and Camelot
    display_key, mode, camelot = estimate_key(mono, sr)
    
    # 3. Phrasing and Cue detection (phrases come from the fitted grid's phrase phase)
    phrase_8_times = times["phrase_8_times"]
    phrase_16_times = times["phrase_16_times"]
    phrase_32_times = times["phrase_32_times"]
    bar_sec = 4 * grid["period"]

    # Intro cue: first phrase start that isn't near-silence
    cue_intro = phrase_8_times[0] if phrase_8_times else (downbeat_times[0] if downbeat_times else 0.0)
    peak = float(np.max(np.abs(mono))) + 1e-9
    for t in phrase_8_times:
        s0, s1 = int(t * sr), int((t + bar_sec) * sr)
        if s1 <= len(mono) and np.sqrt(np.mean(mono[s0:s1] ** 2)) > 0.03 * peak:
            cue_intro = t
            break

    # Outro cue: last 8-bar phrase that still leaves room for a 32-bar blend
    outro_candidates = [t for t in phrase_8_times if duration - t >= 32 * bar_sec]
    if outro_candidates:
        cue_outro = outro_candidates[-1]
    elif len(phrase_8_times) > 2:
        cue_outro = phrase_8_times[-2]
    else:
        cue_outro = max(0.0, duration - 20.0)

    # 4. Waveform peaks (~10 bins per second so the full track stays sharp when zoomed)
    waveform_data = generate_rgb_waveform(mono, sr, num_bins=int(min(4000, max(800, duration * 10))))

    # 5. True physical acoustic profile
    acoustic_data = extract_acoustic_profile(mono, sr, duration, cue_intro, cue_outro)

    # 6. Section map: per-4-bar energy, spectral density, and vocal activity,
    #    with windows aligned to the phrase grid (start on a 4-bar phrase boundary)
    first_4bar = grid["downbeat_offset"] + 4 * (grid["phrase_offset_bars"] % 4)
    section_map = compute_section_map(mono, sr, beat_times[first_4bar:], bpm)

    # Explicit memory cleanup
    del y, mono
    gc.collect()

    return {
        "analysis_version": ANALYSIS_VERSION,
        "filename": os.path.basename(file_path),
        "duration": round(duration, 2),
        "sample_rate": sr,
        "bpm": bpm,
        "grid": grid,
        "section_boundaries": est["section_boundaries"],
        "drop_times": est["drop_times"],
        "bar_low_db": est["bar_low_db"],
        "loudness_db": est["loudness_db"],
        "key": display_key,
        "mode": mode,
        "camelot": camelot,
        "total_beats": len(beat_times),
        "beat_times": beat_times,
        "downbeat_times": downbeat_times,
        "phrase_8_times": phrase_8_times,
        "phrase_16_times": phrase_16_times,
        "phrase_32_times": phrase_32_times,
        "suggested_cue_intro": round(cue_intro, 3),
        "suggested_cue_outro": round(cue_outro, 3),
        "waveform": waveform_data,
        "acoustic_profile": acoustic_data,
        "section_map": section_map
    }
