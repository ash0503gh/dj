"""
audio_analyzer.py - High-precision musical analysis for professional DJ mixing.
Extracts BPM, beat grid, 4/4 downbeats, Camelot musical key, structural phrases, and 3-band RGB waveform peaks.
"""

import numpy as np
import librosa
import soundfile as sf
import os
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
    
    sos_low = butter(2, 250, btype='low', fs=ds_sr, output='sos')
    sos_mid = butter(2, [250, min(2500, int(ds_sr / 2 - 50))], btype='bandpass', fs=ds_sr, output='sos')
    sos_high = butter(2, min(2500, int(ds_sr / 2 - 100)), btype='high', fs=ds_sr, output='sos')
    
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
    
    sos_sub = butter(2, 220 / (sr / 2), btype='low', output='sos')
    sos_vocal = butter(2, [300 / (sr / 2), min(0.85, 3200 / (sr / 2))], btype='bandpass', output='sos')
    
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

def analyze_track(file_path: str) -> Dict[str, Any]:
    """
    Full professional track analysis (optimized for low-latency cloud execution).
    """
    try:
        duration = float(librosa.get_duration(path=file_path))
    except Exception:
        duration = 180.0
        
    # Cloud-optimized: Fast loading at 16kHz capped at 90s to prevent Render 512MB OOM crashes
    analysis_dur = min(90.0, duration) if duration > 0 else 90.0
    y, sr = librosa.load(file_path, sr=16000, mono=True, duration=analysis_dur)
    mono = y
    
    tempo, beat_frames = librosa.beat.beat_track(y=mono, sr=sr, units='frames', tightness=100)
    bpm = float(tempo[0] if isinstance(tempo, (np.ndarray, list)) else tempo)
    if np.isnan(bpm) or bpm <= 0:
        bpm = 128.0
    while bpm < 85.0:
        bpm *= 2.0
    while bpm > 185.0:
        bpm /= 2.0
    beat_times = librosa.frames_to_time(beat_frames, sr=sr).tolist()
    if not beat_times:
        spb = 60.0 / bpm
        beat_times = [round(i * spb, 3) for i in range(max(1, int(duration / spb)))]
    
    # Identify downbeats (approx 4 beats per bar)
    if len(beat_times) >= 8:
        kick_env = librosa.onset.onset_strength(y=mono, sr=sr)
        frame_energies = [kick_env[min(f, len(kick_env)-1)] for f in beat_frames[:16]]
        best_phase = 0
        best_phase_energy = -1
        for phase in range(4):
            phase_energy = sum(frame_energies[phase::4])
            if phase_energy > best_phase_energy:
                best_phase_energy = phase_energy
                best_phase = phase
    else:
        best_phase = 0

    downbeat_indices = list(range(best_phase, len(beat_times), 4))
    downbeat_times = [round(beat_times[i], 3) for i in downbeat_indices if i < len(beat_times)]
    
    # 2. Key and Camelot
    display_key, mode, camelot = estimate_key(mono, sr)
    
    # 3. Phrasing and Cue detection
    phrase_8_indices = list(range(best_phase, len(beat_times), 8 * 4)) # 8 bars = 32 beats
    phrase_8_times = [round(beat_times[i], 3) for i in phrase_8_indices if i < len(beat_times)]

    phrase_16_indices = list(range(best_phase, len(beat_times), 16 * 4)) # 16 bars = 64 beats
    phrase_16_times = [round(beat_times[i], 3) for i in phrase_16_indices if i < len(beat_times)]

    phrase_32_indices = list(range(best_phase, len(beat_times), 32 * 4)) # 32 bars = 128 beats
    phrase_32_times = [round(beat_times[i], 3) for i in phrase_32_indices if i < len(beat_times)]
    
    cue_intro = phrase_16_times[0] if phrase_16_times else (downbeat_times[0] if downbeat_times else 0.0)
    
    if len(phrase_16_times) > 4:
        cue_outro = phrase_16_times[-4]
    elif len(phrase_16_times) > 2:
        cue_outro = phrase_16_times[-2]
    elif phrase_8_times and len(phrase_8_times) > 2:
        cue_outro = phrase_8_times[-2]
    else:
        cue_outro = max(0.0, duration - 20.0)

    # 4. Waveform peaks
    waveform_data = generate_rgb_waveform(mono, sr, num_bins=800)

    # 5. True physical acoustic profile
    acoustic_data = extract_acoustic_profile(mono, sr, duration, cue_intro, cue_outro)
    
    return {
        "filename": os.path.basename(file_path),
        "duration": round(duration, 2),
        "sample_rate": sr,
        "bpm": round(bpm, 2),
        "key": display_key,
        "mode": mode,
        "camelot": camelot,
        "total_beats": len(beat_times),
        "beat_times": [round(t, 3) for t in beat_times],
        "downbeat_times": downbeat_times,
        "phrase_8_times": phrase_8_times,
        "phrase_16_times": phrase_16_times,
        "phrase_32_times": phrase_32_times,
        "suggested_cue_intro": round(cue_intro, 3),
        "suggested_cue_outro": round(cue_outro, 3),
        "waveform": waveform_data,
        "acoustic_profile": acoustic_data
    }
