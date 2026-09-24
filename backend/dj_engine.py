"""
dj_engine.py - The Master DJ Transition Engine (v2.0 — 22 Techniques)

SMOOTH: bass_swap, filter_sweep, stutter_edit, drum_swap, seamless
BUILD:  noise_riser, loop_roll, tension_riser, beatmash_drop, festival_drop
BOLD:   spinback, hard_cut, rewind, backspin_slam, acapella_mashup, vocal_chop
BOMB:   power_cut, fake_drop, silence_drop, double_drop
DRAMATIC: echo_freeze, vinyl_brake, echo_dissolve
"""

import os
import numpy as np
import soundfile as sf
from .lazy import LazyModule
librosa = LazyModule("librosa")
import gc
from typing import Dict, Any, Optional

from .audio_analyzer import analyze_track, check_camelot_compatibility, load_stereo_window
from .audio_dsp import (
    pitch_shift_audio,
    time_stretch_audio,
    dynamic_tempo_ramp,
    split_3band,
    apply_hpf_sweep,
    apply_reverb_delay_tail,
    apply_echo_freeze,
    apply_vinyl_brake,
    apply_loop_roll_riser,
    apply_spinback_fx,
    apply_noise_riser,
    apply_vocal_ducking,
    apply_filter_sweep_blend,
    apply_stutter_chop,
    apply_tension_snare_roll,
    apply_rewind_fx,
    apply_sidechain_pump,
)
from .set_energy import SetEnergyManager, TECHNIQUE_ENERGY
from .stretch import stretch_file

# Keylock stretch beyond ±8% sounds processed: past that the tracks must not overlap
MAX_BLEND_STRETCH = 0.08

def eq_sculpt_blend(s1: np.ndarray, s2: np.ndarray, sr: int,
                    bass_swap_at: float = 0.5, hi_in_speed: float = 0.35,
                    vocal_duck: bool = True, vocal_duck_db: float = 8.0) -> np.ndarray:
    """3-band EQ sculpted blend: hi arrives first, bass swaps with equal-power crossover."""
    N = min(s1.shape[1], s2.shape[1])
    s1 = s1[:, :N]
    s2 = s2[:, :N]
    low_1, mid_1, high_1 = split_3band(s1, sr)
    low_2, mid_2, high_2 = split_3band(s2, sr)

    if vocal_duck and vocal_duck_db > 0:
        mid_1 = apply_vocal_ducking(mid_1, mid_2, sr, max_duck_db=vocal_duck_db)

    swap = int(bass_swap_at * N)
    hi_full = int(hi_in_speed * N)

    high_f1 = np.ones(N)
    high_f1[:swap] = np.linspace(1.0, 0.85, swap)
    high_f1[swap:] = np.linspace(0.85, 0.0, N - swap) ** 1.5
    high_f2 = np.ones(N)
    high_f2[:hi_full] = np.linspace(0.25, 1.0, hi_full) ** 1.2

    mid_f1 = np.ones(N)
    mid_f1[:swap] = np.linspace(1.0, 0.90, swap)
    mid_f1[swap:] = np.linspace(0.90, 0.0, N - swap) ** 1.8
    mid_f2 = np.ones(N)
    mid_f2[:swap] = np.linspace(0.38, 0.65, swap)
    mid_f2[swap:] = 1.0

    xw = min(int(8 * N / 32), N // 3)
    xs = max(0, swap - xw // 2)
    xe = min(N, xs + xw)
    aw = xe - xs
    low_f1 = np.ones(N)
    low_f1[xe:] = 0.0
    low_f2 = np.zeros(N)
    low_f2[xe:] = 1.0
    if aw > 0:
        k = np.linspace(0, 1, aw)
        low_f1[xs:xe] = np.cos(k * np.pi * 0.5)
        low_f2[xs:xe] = np.sin(k * np.pi * 0.5)

    return ((low_1 * low_f1 + low_2 * low_f2) +
            (mid_1 * mid_f1 + mid_2 * mid_f2) +
            (high_1 * high_f1 + high_2 * high_f2))


def compute_dynamic_eq_params(
    y_out: np.ndarray, y_in: np.ndarray, sr: int,
    info_out: Dict[str, Any], info_in: Dict[str, Any],
    technique: str,
) -> Dict[str, Any]:
    """
    Analyze actual audio at transition zone to compute per-pair EQ blend parameters.
    Returns dict with bass_swap_at, hi_in_speed, vocal_duck, vocal_duck_db,
    hpf_end_hz, incoming_bass_ramp.
    """
    from scipy.signal import welch

    N = min(y_out.shape[1], y_in.shape[1], sr * 30)
    seg_out = y_out[:, :N].mean(axis=0)
    seg_in = y_in[:, :N].mean(axis=0)

    nperseg = min(4096, N)
    freqs, psd_out = welch(seg_out, fs=sr, nperseg=nperseg)
    _, psd_in = welch(seg_in, fs=sr, nperseg=nperseg)

    bass_mask = freqs < 200
    mid_mask = (freqs >= 200) & (freqs < 4000)
    hi_mask = freqs >= 4000

    bass_out = np.sum(psd_out[bass_mask]) + 1e-12
    bass_in = np.sum(psd_in[bass_mask]) + 1e-12
    mid_out = np.sum(psd_out[mid_mask]) + 1e-12
    mid_in = np.sum(psd_in[mid_mask]) + 1e-12
    hi_out = np.sum(psd_out[hi_mask]) + 1e-12
    hi_in_pwr = np.sum(psd_in[hi_mask]) + 1e-12

    bass_ratio = bass_in / bass_out
    mid_ratio = mid_in / mid_out
    hi_ratio = hi_in_pwr / hi_out

    ac_out = info_out.get('acoustic_profile', {})
    ac_in = info_in.get('acoustic_profile', {})
    vocal_out = ac_out.get('vocal_detected_outro', False)
    vocal_in = ac_in.get('vocal_detected_intro', False)
    vocal_score_out = ac_out.get('outro_vocal_score', 0.0)
    vocal_score_in = ac_in.get('intro_vocal_score', 0.0)
    energy_out = ac_out.get('energy', 0.5)
    energy_in = ac_in.get('energy', 0.5)

    camelot_info = check_camelot_compatibility(
        info_out.get('camelot', '8A'), info_in.get('camelot', '8A'))
    is_harmonic = camelot_info['is_harmonically_compatible']

    if bass_ratio > 1.5:
        bass_swap_at = 0.35
    elif bass_ratio < 0.6:
        bass_swap_at = 0.6
    else:
        bass_swap_at = 0.5

    if energy_in > 0.7:
        bass_swap_at = max(0.2, bass_swap_at - 0.1)

    if hi_ratio > 2.0:
        hi_in_speed = 0.45
    elif hi_ratio < 0.5:
        hi_in_speed = 0.15
    else:
        hi_in_speed = 0.3

    if not is_harmonic:
        hi_in_speed = max(0.1, hi_in_speed - 0.1)
        bass_swap_at = max(0.2, bass_swap_at - 0.1)

    should_duck = vocal_out and vocal_in
    duck_db = 0.0
    if should_duck:
        overlap_intensity = (vocal_score_out + vocal_score_in) / 2.0
        duck_db = min(12.0, 4.0 + overlap_intensity * 12.0)
        hi_in_speed = max(0.1, hi_in_speed - 0.1)

    hpf_end = 1500.0
    if energy_out > 0.7:
        hpf_end = 2500.0 + (energy_out - 0.7) * 5000.0
    elif energy_out < 0.3:
        hpf_end = 800.0

    incoming_bass_ramp = 0.5
    if bass_ratio > 1.5:
        incoming_bass_ramp = 0.3
    elif bass_ratio < 0.6:
        incoming_bass_ramp = 0.7

    return {
        'bass_swap_at': round(float(np.clip(bass_swap_at, 0.15, 0.75)), 3),
        'hi_in_speed': round(float(np.clip(hi_in_speed, 0.05, 0.6)), 3),
        'vocal_duck': should_duck,
        'vocal_duck_db': round(float(duck_db), 1),
        'hpf_end_hz': round(float(np.clip(hpf_end, 600, 8000)), 0),
        'incoming_bass_ramp': round(float(np.clip(incoming_bass_ramp, 0.2, 0.8)), 2),
        'bass_ratio': round(float(bass_ratio), 2),
        'mid_ratio': round(float(mid_ratio), 2),
        'hi_ratio': round(float(hi_ratio), 2),
        'is_harmonic': is_harmonic,
    }


def soft_limit(y: np.ndarray, threshold: float = 0.95) -> np.ndarray:
    """Soft knee saturation / limiter to avoid digital clipping."""
    max_val = np.max(np.abs(y))
    if max_val > threshold:
        return np.tanh(y / max_val * 1.2) * threshold
    return y

def ai_analyze_and_recommend_transition(
    info_1: Dict[str, Any],
    info_2: Dict[str, Any],
    energy_mgr: Optional[SetEnergyManager] = None,
) -> Dict[str, Any]:
    """
    AI Live Decision Engine v2.0 — 22 techniques with set-energy awareness.
    Selects technique based on acoustic analysis, then re-ranks using energy arc.
    """
    bpm_1 = float(info_1['bpm'])
    bpm_2 = float(info_2['bpm'])
    delta_bpm = abs(bpm_1 - bpm_2)

    camelot_info = check_camelot_compatibility(info_1['camelot'], info_2['camelot'])
    is_harmonic = camelot_info['is_harmonically_compatible']

    ac_1 = info_1.get('acoustic_profile', {})
    ac_2 = info_2.get('acoustic_profile', {})

    vocal_outro_1 = ac_1.get('vocal_detected_outro', False)
    vocal_score_1 = ac_1.get('outro_vocal_score', 0.0)
    vocal_intro_2 = ac_2.get('vocal_detected_intro', False)
    vocal_score_2 = ac_2.get('intro_vocal_score', 0.0)
    perc_outro_1 = ac_1.get('outro_percussion', 'driving_4_4')
    perc_intro_2 = ac_2.get('intro_percussion', 'driving_4_4')

    # Build candidate list with acoustic scores
    candidates = []

    def add(tech, conf, reason, bars=16, **extra):
        candidates.append({
            "recommended_technique": tech,
            "confidence": conf,
            "reasoning": reason,
            "recommended_bars": bars,
            "acoustic_analysis": extra,
        })

    # Club DJs blend almost every transition. Effects/cuts are for when a blend can't work:
    # tempos too far apart to run both at one keylocked master tempo.
    tempo_gap = abs(bpm_1 / bpm_2 - 1.0) if bpm_2 else 1.0
    can_blend = tempo_gap <= MAX_BLEND_STRETCH

    # --- VOCAL CLASH → short blend; mids swap together with the bass so vocals never overlap ---
    if vocal_outro_1 and vocal_intro_2 and can_blend:
        add("bass_swap", 0.97,
            f"Both sides have vocals ({vocal_score_1*100:.0f}%/{vocal_score_2*100:.0f}%): 8-bar blend, "
            f"incoming mids held low and swapped with the bass on the 1, so the vocals never overlap.",
            bars=8, vocal_clash_risk="HANDLED_BY_MID_SWAP")
    if vocal_outro_1 and vocal_intro_2:
        add("echo_freeze", 0.80,
            f"Vocal clash ({vocal_score_1*100:.0f}%/{vocal_score_2*100:.0f}%) alternative: echo out Deck 1 and drop Deck 2 with zero overlap.",
            bars=8, vocal_clash_risk="CRITICAL")

    # --- VOCAL OUTRO + CLEAN INTRO → blend techniques ---
    if vocal_outro_1 and not vocal_intro_2 and can_blend:
        add("bass_swap", 0.96,
            f"Deck 1 vocals ({vocal_score_1*100:.0f}%) over Deck 2's clean {perc_intro_2} groove. Bass swap with vocal ducking.",
            bars=16)
        if is_harmonic:
            add("acapella_mashup", 0.88,
                f"Harmonic match — vocal stem of Deck 1 floats over Deck 2's full mix.",
                bars=16)
            add("filter_sweep", 0.84,
                f"Frequency-domain crossover — HPF sweeps Deck 1 up while LPF brings Deck 2 down.",
                bars=16)

    # --- TEMPO GAP TOO WIDE TO BLEND → overlap-free exits (tempo resets on the drop) ---
    if not can_blend:
        add("echo_freeze", 0.95,
            f"Tempo gap {tempo_gap*100:.0f}% (Δ{delta_bpm:.1f} BPM) is too wide to run both tracks at one tempo: "
            f"echo out Deck 1 and drop Deck 2 on the 1 at its own tempo.",
            bars=8, tempo_friction="EXTREME" if tempo_gap > 0.15 else "WIDE")
        add("hard_cut", 0.90,
            f"Tempo gap {tempo_gap*100:.0f}%: clean cut on a phrase boundary, no overlap.",
            bars=8)
        add("spinback", 0.82,
            f"Tempo gap {tempo_gap*100:.0f}%: spinback resets the room before Deck 2.",
            bars=8)

    # --- BREAKDOWN → DROP: a build is an option, not the default ---
    if perc_outro_1 == "melodic_breakdown" and perc_intro_2 == "driving_4_4":
        add("festival_drop", 0.80,
            f"Breakdown → drop: build (roll + riser) and slam Deck 2 on the 1.",
            bars=16)
        add("noise_riser", 0.78,
            f"Breakdown → drop: 4-bar white noise riser into Deck 2.",
            bars=16)

    # --- KEY CLASH → short blend so the harmonies barely overlap ---
    if not is_harmonic and can_blend:
        add("bass_swap", 0.90,
            f"Key clash ({info_1['camelot']}→{info_2['camelot']}): 8-bar blend with the mids swapped on the 1, "
            f"keeping the clashing harmony overlap to a minimum.",
            bars=8)
        add("echo_freeze", 0.78,
            f"Key clash alternative: echo out Deck 1, no harmonic overlap at all.",
            bars=8)

    # --- HARMONIC + CLOSE TEMPO → long blend ---
    if is_harmonic and can_blend:
        add("bass_swap", 0.96,
            f"Harmonic match ({info_1['camelot']}→{info_2['camelot']}), Δ{delta_bpm:.1f} BPM. Smooth bass swap.",
            bars=32)
        add("filter_sweep", 0.88,
            f"Harmonic match — frequency-domain crossover blend.",
            bars=16)
        add("drum_swap", 0.85,
            f"Harmonic match — swap drums first, bring melody later for layered transition.",
            bars=16)
        add("stutter_edit", 0.82,
            f"Harmonic match — 1/16th stutter chops on Deck 1 while Deck 2 fades in.",
            bars=16)
        add("double_drop", 0.80,
            f"Harmonic match — both tracks drop simultaneously for massive energy spike.",
            bars=8)
        add("beatmash_drop", 0.78,
            f"Harmonic match — rapid beat-repeat (1/2→1/4→1/8→1/16) then slam.",
            bars=8)

    # Fallback
    if not candidates:
        add("bass_swap", 0.86,
            f"Phrase-aligned 16-bar blend with a bass swap on the 1.",
            bars=16)

    # --- ENERGY ARC RE-RANKING ---
    if energy_mgr:
        for c in candidates:
            energy_score = energy_mgr.score_technique(c["recommended_technique"])
            c["energy_score"] = energy_score
            c["confidence"] = min(0.99, c["confidence"] * (0.5 + energy_score * 0.5))
    candidates.sort(key=lambda x: x["confidence"], reverse=True)

    best = candidates[0]
    seen = {best["recommended_technique"]}
    alternatives = []
    for c in candidates[1:]:
        if c["recommended_technique"] not in seen and len(alternatives) < 3:
            seen.add(c["recommended_technique"])
            alternatives.append({"technique": c["recommended_technique"], "confidence": round(c["confidence"], 2)})
    best["alternatives"] = alternatives
    if energy_mgr:
        best["set_energy"] = energy_mgr.get_state()

    from .ai_advisor import _compute_eq_sculpt, _compute_color_fx
    energy_out = ac_1.get('energy', 0.5)
    energy_in = ac_2.get('energy', 0.5)
    best["eq_sculpt"] = _compute_eq_sculpt(
        best["recommended_technique"], vocal_outro_1, vocal_intro_2, energy_out, energy_in)
    best["color_fx"] = _compute_color_fx(
        best["recommended_technique"], bpm_1, energy_out)

    return best

EXPORT_LEAD_IN_SEC = 16.0
EXPORT_TAIL_SEC = 16.0


def _map_track_times(info: Dict[str, Any], fn) -> Dict[str, Any]:
    out = dict(info)
    for key in ('beat_times', 'downbeat_times', 'phrase_8_times', 'phrase_16_times',
                'phrase_32_times', 'drop_times', 'section_boundaries'):
        if info.get(key):
            out[key] = [fn(t) for t in info[key]]
    for key in ('suggested_cue_intro', 'suggested_cue_outro'):
        if info.get(key) is not None:
            out[key] = fn(info[key])
    if info.get('section_map'):
        out['section_map'] = [dict(s, time=fn(s['time']), duration=fn(s['time'] + s['duration']) - fn(s['time']))
                              for s in info['section_map']]
    return out


def scale_track_times(info: Dict[str, Any], ratio: float) -> Dict[str, Any]:
    """Analysis of a track played `ratio` x faster: every time divides by ratio, BPM multiplies."""
    out = _map_track_times(info, lambda t: t / ratio)
    out['bpm'] = info['bpm'] * ratio
    out['duration'] = info.get('duration', 0.0) / ratio
    return out


def shift_track_times(info: Dict[str, Any], offset: float) -> Dict[str, Any]:
    """Analysis re-expressed for audio loaded from `offset` seconds into the track."""
    return _map_track_times(info, lambda t: t - offset)


def render_pro_transition(
    track_1_path: str,
    track_2_path: str,
    output_path: str,
    technique: str = "auto", # 'auto', 'bass_swap', 'echo_freeze', 'stem_mashup', 'loop_roll', 'vinyl_brake'
    bars: int = 16,
    tempo_ramp: bool = True,
    harmonic_lock: bool = True,
    use_stems: bool = False,
    custom_cue_1: Optional[float] = None,
    custom_cue_2: Optional[float] = None,
    progress_cb = None,
    info_1: Optional[Dict[str, Any]] = None,
    info_2: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Renders a professional DJ mix transitioning from Track 1 to Track 2 using the specified technique.
    Pass cached analyses as info_1 / info_2 to skip re-analyzing both tracks.
    """
    if progress_cb: progress_cb(0.05, "Analyzing audio tracks...")

    info_1 = info_1 or analyze_track(track_1_path)
    info_2 = info_2 or analyze_track(track_2_path)

    # One master tempo: Track 2 is keylock-stretched to Track 1's BPM for the WHOLE render,
    # so both tracks run at the same tempo throughout the overlap and nothing jumps after it.
    tempo_ratio = float(info_1['bpm']) / float(info_2['bpm'])
    if abs(tempo_ratio - 1.0) > 0.0005 and 0.8 <= tempo_ratio <= 1.25:
        if progress_cb: progress_cb(0.10, f"Keylock-stretching Track 2 to {info_1['bpm']:.2f} BPM...")
        track_2_path = stretch_file(track_2_path, round(tempo_ratio, 6),
                                    os.path.join(os.path.dirname(output_path), "stretch"), info_2.get('grid'))
        info_2 = scale_track_times(info_2, tempo_ratio)
        if custom_cue_2 is not None:
            custom_cue_2 = custom_cue_2 / tempo_ratio
    
    # Resolve AI Auto Recommendation
    ai_choice = ai_analyze_and_recommend_transition(info_1, info_2)
    selected_technique = ai_choice["recommended_technique"] if technique == "auto" else technique
    
    sr = 44100
    bpm_1 = info_1['bpm']
    bpm_2 = info_2['bpm']
    camelot_info = check_camelot_compatibility(info_1['camelot'], info_2['camelot'])

    # Cue points with 16-bar phrase quantization
    cue_1_sec = custom_cue_1 if custom_cue_1 and custom_cue_1 > 0 else info_1['suggested_cue_outro']
    cue_2_sec = custom_cue_2 if custom_cue_2 and custom_cue_2 >= 0 else info_2['suggested_cue_intro']
    
    phrases_1 = info_1.get('phrase_16_times') or info_1.get('phrase_8_times')
    if phrases_1 and not custom_cue_1:
        idx_p1 = np.argmin(np.abs(np.array(phrases_1) - cue_1_sec))
        cue_1_sec = phrases_1[idx_p1]
    elif info_1.get('downbeat_times'):
        downbeats_1 = info_1['downbeat_times']
        idx_1 = np.argmin(np.abs(np.array(downbeats_1) - cue_1_sec))
        cue_1_sec = downbeats_1[idx_1]
    
    phrases_2 = info_2.get('phrase_16_times') or info_2.get('phrase_8_times')
    if phrases_2 and not custom_cue_2:
        idx_p2 = np.argmin(np.abs(np.array(phrases_2) - cue_2_sec))
        cue_2_sec = phrases_2[idx_p2]
    elif info_2.get('downbeat_times'):
        downbeats_2 = info_2['downbeat_times']
        idx_2 = np.argmin(np.abs(np.array(downbeats_2) - cue_2_sec))
        cue_2_sec = downbeats_2[idx_2]

    # Export the transition window only (16 s lead-in, the blend, 30 s of the new track), not
    # both full tracks: ~2 minutes of stereo audio instead of ~10 keeps an export inside 512 MB.
    window_beats = max(bars, 16) * 4
    offset_1 = max(0.0, cue_1_sec - EXPORT_LEAD_IN_SEC)
    offset_2 = max(0.0, cue_2_sec - 8.0)
    y1 = load_stereo_window(track_1_path, sr, offset_1,
                            (cue_1_sec - offset_1) + window_beats * 60.0 / bpm_1 + 20.0)
    y2 = load_stereo_window(track_2_path, sr, offset_2,
                            (cue_2_sec - offset_2) + window_beats * 60.0 / bpm_2 + EXPORT_TAIL_SEC)
    cue_1_sec -= offset_1
    cue_2_sec -= offset_2
    info_1 = shift_track_times(info_1, offset_1)
    info_2 = shift_track_times(info_2, offset_2)

    # Harmonic pitch shifting if enabled
    pitch_shift_semitones = 0
    if harmonic_lock and camelot_info['recommended_pitch_shift'] != 0 and selected_technique != "echo_freeze":
        pitch_shift_semitones = camelot_info['recommended_pitch_shift']
        if progress_cb: progress_cb(0.15, f"Pitch-shifting Track 2 by {pitch_shift_semitones:+d} semitones...")
        y2 = pitch_shift_audio(y2, sr, pitch_shift_semitones)

    seconds_per_beat_1 = 60.0 / bpm_1
    seconds_per_beat_2 = 60.0 / bpm_2

    # Compute per-pair dynamic EQ parameters from actual audio content
    s1_cue = int(cue_1_sec * sr)
    s2_cue = int(cue_2_sec * sr)
    eq_zone_out = y1[:, max(0, s1_cue - int(16 * seconds_per_beat_1 * sr)):s1_cue]
    eq_zone_in = y2[:, s2_cue:s2_cue + int(16 * seconds_per_beat_2 * sr)]
    if eq_zone_out.shape[1] > 0 and eq_zone_in.shape[1] > 0:
        eq_p = compute_dynamic_eq_params(eq_zone_out, eq_zone_in, sr, info_1, info_2, selected_technique)
    else:
        eq_p = {'bass_swap_at': 0.5, 'hi_in_speed': 0.3, 'vocal_duck': False,
                'vocal_duck_db': 0.0, 'hpf_end_hz': 1500.0, 'incoming_bass_ramp': 0.5}

    # -------------------------------------------------------------
    # TECHNIQUE 1: ECHO FREEZE & DROP ON THE 1
    # -------------------------------------------------------------
    if selected_technique == "echo_freeze":
        if progress_cb: progress_cb(0.40, "Rendering Echo Freeze wash & Track 2 drop...")
        s1_cut_sample = int(cue_1_sec * sr)
        s1_pre = y1[:, :s1_cut_sample]
        
        # Capture the beat preceding the cut for echo freeze
        exit_chunk = s1_pre[:, max(0, s1_cut_sample - int(2 * seconds_per_beat_1 * sr)):].copy()
        echo_tail = apply_echo_freeze(exit_chunk, sr, bpm=bpm_1, tail_sec=5.0)
        
        # Clean 20ms anti-click micro-fade at cut
        fade_len = int(0.02 * sr)
        if s1_pre.shape[1] > fade_len:
            s1_pre[:, -fade_len:] *= np.linspace(1, 0, fade_len)

        # Track 2 enters immediately on beat 1 with 100% full energy
        s2_in_sample = int(cue_2_sec * sr)
        s2_play = y2[:, s2_in_sample:]
        
        # Blend echo tail over Track 2's start
        tail_len = min(echo_tail.shape[1], s2_play.shape[1])
        s2_with_tail = np.copy(s2_play)
        if s2_with_tail.shape[1] > int(0.005 * sr):
            s2_with_tail[:, :int(0.005*sr)] *= np.linspace(0, 1, int(0.005*sr))
            
        s2_with_tail[:, :tail_len] += echo_tail[:, :tail_len] * 0.75
        
        master_mix = np.hstack([s1_pre, s2_with_tail])
        mix_start_sec = cue_1_sec
        mix_swap_sec = cue_1_sec
        mix_end_sec = cue_1_sec + 5.0

    # -------------------------------------------------------------
    # TECHNIQUE 2: VINYL BRAKE & DROP
    # -------------------------------------------------------------
    elif selected_technique == "vinyl_brake":
        if progress_cb: progress_cb(0.40, "Rendering turntable motor-off brake & sub drop...")
        s1_pre_sample = int(cue_1_sec * sr)
        s1_pre = y1[:, :s1_pre_sample]
        
        brake_chunk = y1[:, s1_pre_sample: s1_pre_sample + int(1.5 * sr)]
        brake_audio = apply_vinyl_brake(brake_chunk, sr, brake_duration_sec=1.5)
        
        s2_in_sample = int(cue_2_sec * sr)
        s2_play = y2[:, s2_in_sample:]
        
        # Sub drop impact boom on beat 1
        t_boom = np.linspace(0, 0.8, int(0.8 * sr), endpoint=False)
        boom_freq = 70.0 * np.exp(-t_boom * 12.0) + 35.0
        boom = np.sin(2 * np.pi * np.cumsum(boom_freq) / sr) * np.exp(-t_boom * 5.0) * 0.5
        boom_stereo = np.vstack([boom, boom])
        
        s2_with_boom = np.copy(s2_play)
        b_len = min(boom_stereo.shape[1], s2_with_boom.shape[1])
        s2_with_boom[:, :b_len] += boom_stereo[:, :b_len]
        
        master_mix = np.hstack([s1_pre, brake_audio, s2_with_boom])
        mix_start_sec = cue_1_sec
        mix_swap_sec = cue_1_sec + 1.5
        mix_end_sec = cue_1_sec + 2.5

    # -------------------------------------------------------------
    # TECHNIQUE 3: STUTTER LOOP ROLL & RISER
    # -------------------------------------------------------------
    elif selected_technique == "loop_roll":
        if progress_cb: progress_cb(0.40, "Building 1/16 loop roll riser & filter tension...")
        s1_pre_sample = int(cue_1_sec * sr)
        s1_pre = y1[:, :s1_pre_sample]
        
        roll_source = y1[:, max(0, s1_pre_sample - int(2*sr)): s1_pre_sample]
        roll_audio = apply_loop_roll_riser(roll_source, sr, bpm=bpm_1, bars=4)
        
        s2_in_sample = int(cue_2_sec * sr)
        s2_play = y2[:, s2_in_sample:]
        
        master_mix = np.hstack([s1_pre, roll_audio, s2_play])
        roll_dur = roll_audio.shape[1] / sr
        mix_start_sec = cue_1_sec
        mix_swap_sec = cue_1_sec + roll_dur
        mix_end_sec = cue_1_sec + roll_dur + 4.0

    # -------------------------------------------------------------
    # TECHNIQUE 4: VINYL SPINBACK (BACKSPIN) & DROP
    # -------------------------------------------------------------
    elif selected_technique == "spinback":
        if progress_cb: progress_cb(0.40, "Rendering physical vinyl backspin scrub & drop...")
        s1_pre_sample = int(cue_1_sec * sr)
        s1_pre = y1[:, :s1_pre_sample]

        spin_source = s1_pre[:, max(0, s1_pre_sample - int(1.5 * sr)):].copy()
        spin_audio = apply_spinback_fx(spin_source, sr, duration_sec=1.2)

        s2_in_sample = int(cue_2_sec * sr)
        s2_play = y2[:, s2_in_sample:]

        # Sub drop impact boom on beat 1
        t_boom = np.linspace(0, 0.8, int(0.8 * sr), endpoint=False)
        boom_freq = 75.0 * np.exp(-t_boom * 14.0) + 32.0
        boom = np.sin(2 * np.pi * np.cumsum(boom_freq) / sr) * np.exp(-t_boom * 5.0) * 0.55
        boom_stereo = np.vstack([boom, boom])

        s2_with_boom = np.copy(s2_play)
        b_len = min(boom_stereo.shape[1], s2_with_boom.shape[1])
        s2_with_boom[:, :b_len] += boom_stereo[:, :b_len]

        master_mix = np.hstack([s1_pre, spin_audio, s2_with_boom])
        mix_start_sec = cue_1_sec
        mix_swap_sec = cue_1_sec + 1.2
        mix_end_sec = cue_1_sec + 2.5

    # -------------------------------------------------------------
    # TECHNIQUE 5: WHITE NOISE HPF RISER & DROP
    # -------------------------------------------------------------
    elif selected_technique == "noise_riser":
        if progress_cb: progress_cb(0.40, "Synthesizing 4-bar white noise tension riser & silence drop...")
        spb = 60.0 / bpm_1
        riser_beats = 4 * 4 # 4 bars = 16 beats
        riser_samples = int(riser_beats * spb * sr)

        s1_cut_sample = int(cue_1_sec * sr)
        s1_pre_riser = y1[:, :max(0, s1_cut_sample - riser_samples)]

        # Track 1 audio during riser
        s1_riser_chunk = y1[:, max(0, s1_cut_sample - riser_samples):s1_cut_sample].copy()
        s1_riser_chunk = apply_hpf_sweep(s1_riser_chunk, sr, start_freq=40.0, end_freq=2200.0)

        # Generate synthesized white noise riser
        noise = apply_noise_riser(sr, bpm=bpm_1, bars=4)
        n_len = min(s1_riser_chunk.shape[1], noise.shape[1])
        s1_riser_chunk[:, :n_len] += noise[:, :n_len] * 0.80

        # Anticipation gap: Silence the final beat before Beat 1
        gap_samples = int(spb * sr)
        if s1_riser_chunk.shape[1] > gap_samples:
            s1_riser_chunk[:, -gap_samples:] = 0.0

        s2_in_sample = int(cue_2_sec * sr)
        s2_play = y2[:, s2_in_sample:]

        master_mix = np.hstack([s1_pre_riser, s1_riser_chunk, s2_play])
        mix_start_sec = max(0, cue_1_sec - (riser_samples / sr))
        mix_swap_sec = cue_1_sec
        mix_end_sec = cue_1_sec + 4.0

    # -------------------------------------------------------------
    # TECHNIQUE 6: FESTIVAL BUILD & DROP (Multi-Technique Composite)
    # -------------------------------------------------------------
    elif selected_technique == "festival_drop":
        if progress_cb: progress_cb(0.40, "Building Festival Drop: HPF sweep + loop roll stutter + noise riser...")
        spb = 60.0 / bpm_1
        build_bars = min(bars, 8)
        build_beats = build_bars * 4
        build_samples = int(build_beats * spb * sr)

        s1_cut_sample = int(cue_1_sec * sr)
        s1_pre_build = y1[:, :max(0, s1_cut_sample - build_samples)]
        
        # Track 1 chunk during build
        s1_build_chunk = y1[:, max(0, s1_cut_sample - build_samples):s1_cut_sample].copy()
        
        # Layer 1: HPF sweep on outgoing track
        s1_build_chunk = apply_hpf_sweep(s1_build_chunk, sr, start_freq=35.0, end_freq=3000.0)

        # Layer 2: Synthesized white noise riser
        noise = apply_noise_riser(sr, bpm=bpm_1, bars=build_bars)
        n_len = min(s1_build_chunk.shape[1], noise.shape[1])
        s1_build_chunk[:, :n_len] += noise[:, :n_len] * 0.85

        # Layer 3: Accelerating stutter loop roll in final 4 bars
        roll_bars = min(build_bars, 4)
        roll_samples = int(roll_bars * 4 * spb * sr)
        if s1_build_chunk.shape[1] >= roll_samples:
            roll_src = s1_build_chunk[:, -roll_samples:].copy()
            stutter = apply_loop_roll_riser(roll_src, sr, bpm=bpm_1, bars=roll_bars)
            st_len = min(roll_samples, stutter.shape[1])
            s1_build_chunk[:, -roll_samples:-roll_samples+st_len] = 0.5 * s1_build_chunk[:, -roll_samples:-roll_samples+st_len] + 0.5 * stutter[:, :st_len]

        # Anticipation gap: Silence the final beat before Beat 1
        gap_samples = int(spb * sr)
        if s1_build_chunk.shape[1] > gap_samples:
            s1_build_chunk[:, -gap_samples:] = 0.0

        s2_in_sample = int(cue_2_sec * sr)
        s2_play = y2[:, s2_in_sample:]

        # Drop impact boom on Beat 1
        t_boom = np.linspace(0, 0.8, int(0.8 * sr), endpoint=False)
        boom_freq = 75.0 * np.exp(-t_boom * 14.0) + 32.0
        boom = np.sin(2 * np.pi * np.cumsum(boom_freq) / sr) * np.exp(-t_boom * 5.0) * 0.55
        boom_stereo = np.vstack([boom, boom])

        s2_with_boom = np.copy(s2_play)
        b_len = min(boom_stereo.shape[1], s2_with_boom.shape[1])
        s2_with_boom[:, :b_len] += boom_stereo[:, :b_len]

        master_mix = np.hstack([s1_pre_build, s1_build_chunk, s2_with_boom])
        mix_start_sec = max(0, cue_1_sec - (build_samples / sr))
        mix_swap_sec = cue_1_sec
        mix_end_sec = cue_1_sec + 4.0

    # -------------------------------------------------------------
    # TECHNIQUE 6B: HARD CUT (INSTANT DOWNBEAT SNAP)
    # -------------------------------------------------------------
    elif selected_technique == "hard_cut":
        if progress_cb: progress_cb(0.40, "Executing instantaneous 0ms downbeat cut...")
        s1_cut_sample = int(cue_1_sec * sr)
        s1_pre = y1[:, :s1_cut_sample].copy()

        # 5ms anti-click micro de-click fade out
        fade_len = min(int(0.005 * sr), s1_pre.shape[1])
        if fade_len > 0:
            s1_pre[:, -fade_len:] *= np.linspace(1.0, 0.0, fade_len)

        s2_in_sample = int(cue_2_sec * sr)
        s2_play = y2[:, s2_in_sample:].copy()
        if fade_len > 0 and s2_play.shape[1] >= fade_len:
            s2_play[:, :fade_len] *= np.linspace(0.0, 1.0, fade_len)

        # Subtle sub drop boom on the 1 for punch
        t_boom = np.linspace(0, 0.5, int(0.5 * sr), endpoint=False)
        boom_freq = 65.0 * np.exp(-t_boom * 16.0) + 30.0
        boom = np.sin(2 * np.pi * np.cumsum(boom_freq) / sr) * np.exp(-t_boom * 6.0) * 0.35
        boom_stereo = np.vstack([boom, boom])
        b_len = min(boom_stereo.shape[1], s2_play.shape[1])
        s2_play[:, :b_len] += boom_stereo[:, :b_len]

        master_mix = np.hstack([s1_pre, s2_play])
        mix_start_sec = max(0, cue_1_sec - 1.0)
        mix_swap_sec = cue_1_sec
        mix_end_sec = cue_1_sec + 4.0

    # -------------------------------------------------------------
    # TECHNIQUE 7: POWER CUT (Silence Gap → Slam)
    # -------------------------------------------------------------
    elif selected_technique == "power_cut":
        if progress_cb: progress_cb(0.40, "Rendering power cut: HPF sweep → silence → slam drop...")
        s1_cut_sample = int(cue_1_sec * sr)
        s1_pre = y1[:, :s1_cut_sample].copy()

        sweep_len = min(int(2 * seconds_per_beat_1 * sr), s1_pre.shape[1])
        if sweep_len > 0:
            s1_pre[:, -sweep_len:] = apply_hpf_sweep(s1_pre[:, -sweep_len:], sr, 35.0, eq_p['hpf_end_hz'])

        fade_len = int(0.015 * sr)
        if s1_pre.shape[1] > fade_len:
            s1_pre[:, -fade_len:] *= np.linspace(1.0, 0.0, fade_len)

        gap_sec = seconds_per_beat_1 * 2
        gap_samples = int(gap_sec * sr)
        silence = np.zeros((2, gap_samples))

        s2_in_sample = int(cue_2_sec * sr)
        s2_play = y2[:, s2_in_sample:]

        t_boom = np.linspace(0, 0.8, int(0.8 * sr), endpoint=False)
        boom_freq = 80.0 * np.exp(-t_boom * 14.0) + 30.0
        boom = np.sin(2 * np.pi * np.cumsum(boom_freq) / sr) * np.exp(-t_boom * 4.5) * 0.55
        boom_stereo = np.vstack([boom, boom])
        s2_with_boom = np.copy(s2_play)
        b_len = min(boom_stereo.shape[1], s2_with_boom.shape[1])
        s2_with_boom[:, :b_len] += boom_stereo[:, :b_len]

        master_mix = np.hstack([s1_pre, silence, s2_with_boom])
        mix_start_sec = cue_1_sec
        mix_swap_sec = cue_1_sec + gap_sec
        mix_end_sec = cue_1_sec + gap_sec + 4.0

    # -------------------------------------------------------------
    # TECHNIQUE 8: FAKE DROP (Build → Silence → Drop)
    # -------------------------------------------------------------
    elif selected_technique == "fake_drop":
        if progress_cb: progress_cb(0.40, "Building fake drop: tension riser → silence → SLAM...")
        spb = 60.0 / bpm_1
        build_bars = min(bars, 8)
        build_samples = int(build_bars * 4 * spb * sr)

        s1_cut_sample = int(cue_1_sec * sr)
        s1_pre_build = y1[:, :max(0, s1_cut_sample - build_samples)]

        s1_build = y1[:, max(0, s1_cut_sample - build_samples):s1_cut_sample].copy()
        s1_build = apply_hpf_sweep(s1_build, sr, 35.0, eq_p['hpf_end_hz'])

        noise = apply_noise_riser(sr, bpm=bpm_1, bars=build_bars)
        n_len = min(s1_build.shape[1], noise.shape[1])
        s1_build[:, :n_len] += noise[:, :n_len] * 0.75

        snare = apply_tension_snare_roll(sr, bpm_1, bars=build_bars)
        sn_len = min(s1_build.shape[1], snare.shape[1])
        s1_build[:, :sn_len] += snare[:, :sn_len] * 0.5

        gap_samples = int(spb * 2 * sr)
        if s1_build.shape[1] > gap_samples:
            s1_build[:, -gap_samples:] = 0.0

        s2_in_sample = int(cue_2_sec * sr)
        s2_play = y2[:, s2_in_sample:]

        sculpt_len = min(int(4 * spb * sr), s2_play.shape[1])
        low_2, mid_2, high_2 = split_3band(s2_play[:, :sculpt_len], sr)
        bass_ramp_exp = eq_p['incoming_bass_ramp']
        bass_in = np.linspace(0.0, 1.0, sculpt_len) ** bass_ramp_exp
        s2_sculpted = low_2 * bass_in + mid_2 + high_2
        s2_with_impact = np.copy(s2_play)
        s2_with_impact[:, :sculpt_len] = s2_sculpted

        t_boom = np.linspace(0, 1.0, int(1.0 * sr), endpoint=False)
        boom_freq = 80.0 * np.exp(-t_boom * 12.0) + 30.0
        boom = np.sin(2 * np.pi * np.cumsum(boom_freq) / sr) * np.exp(-t_boom * 3.5) * 0.6
        boom_stereo = np.vstack([boom, boom])
        b_len = min(boom_stereo.shape[1], s2_with_impact.shape[1])
        s2_with_impact[:, :b_len] += boom_stereo[:, :b_len]

        master_mix = np.hstack([s1_pre_build, s1_build, s2_with_impact])
        mix_start_sec = max(0, cue_1_sec - build_samples / sr)
        mix_swap_sec = cue_1_sec
        mix_end_sec = cue_1_sec + 4.0

    # -------------------------------------------------------------
    # TECHNIQUE 9: SILENCE DROP (Extended Silence → Massive Drop)
    # -------------------------------------------------------------
    elif selected_technique == "silence_drop":
        if progress_cb: progress_cb(0.40, "Rendering silence drop: HPF sweep → silence → massive impact...")
        s1_cut_sample = int(cue_1_sec * sr)
        s1_pre = y1[:, :s1_cut_sample].copy()

        sweep_len = min(int(4 * seconds_per_beat_1 * sr), s1_pre.shape[1])
        if sweep_len > 0:
            s1_pre[:, -sweep_len:] = apply_hpf_sweep(s1_pre[:, -sweep_len:], sr, 35.0, eq_p['hpf_end_hz'])

        fade_len = int(0.5 * sr)
        if s1_pre.shape[1] > fade_len:
            s1_pre[:, -fade_len:] *= np.linspace(1.0, 0.0, fade_len) ** 2

        gap_beats = 4
        gap_samples = int(gap_beats * seconds_per_beat_1 * sr)
        silence = np.zeros((2, gap_samples))

        s2_in_sample = int(cue_2_sec * sr)
        s2_play = y2[:, s2_in_sample:]

        t_boom = np.linspace(0, 1.2, int(1.2 * sr), endpoint=False)
        boom_freq = 90.0 * np.exp(-t_boom * 10.0) + 28.0
        boom = np.sin(2 * np.pi * np.cumsum(boom_freq) / sr) * np.exp(-t_boom * 3.0) * 0.65
        boom_stereo = np.vstack([boom, boom])
        s2_with_boom = np.copy(s2_play)
        b_len = min(boom_stereo.shape[1], s2_with_boom.shape[1])
        s2_with_boom[:, :b_len] += boom_stereo[:, :b_len]

        master_mix = np.hstack([s1_pre, silence, s2_with_boom])
        mix_start_sec = cue_1_sec
        mix_swap_sec = cue_1_sec + gap_beats * seconds_per_beat_1
        mix_end_sec = mix_swap_sec + 4.0

    # -------------------------------------------------------------
    # TECHNIQUE 10: REWIND / PULL-UP
    # -------------------------------------------------------------
    elif selected_technique == "rewind":
        if progress_cb: progress_cb(0.40, "Rendering vinyl rewind: HPF sweep → pull-up...")
        s1_cut_sample = int(cue_1_sec * sr)
        s1_pre = y1[:, :s1_cut_sample].copy()

        sweep_len = min(int(2 * seconds_per_beat_1 * sr), s1_pre.shape[1])
        if sweep_len > 0:
            s1_pre[:, -sweep_len:] = apply_hpf_sweep(s1_pre[:, -sweep_len:], sr, 35.0, eq_p['hpf_end_hz'])

        rewind_source = s1_pre[:, max(0, s1_cut_sample - int(2 * sr)):].copy()
        rewind_audio = apply_rewind_fx(rewind_source, sr, duration_sec=1.5)

        gap_samples = int(0.3 * sr)
        silence = np.zeros((2, gap_samples))

        s2_in_sample = int(cue_2_sec * sr)
        s2_play = y2[:, s2_in_sample:]

        master_mix = np.hstack([s1_pre, rewind_audio, silence, s2_play])
        mix_start_sec = cue_1_sec
        mix_swap_sec = cue_1_sec + 1.8
        mix_end_sec = cue_1_sec + 3.0

    # -------------------------------------------------------------
    # TECHNIQUE 11: DOUBLE DROP (Both tracks drop simultaneously)
    # -------------------------------------------------------------
    elif selected_technique == "double_drop":
        if progress_cb: progress_cb(0.40, "Rendering double drop: both tracks slam on Beat 1...")
        spb = 60.0 / bpm_1
        build_bars = min(bars, 4)
        build_samples = int(build_bars * 4 * spb * sr)

        s1_cut_sample = int(cue_1_sec * sr)
        s1_pre = y1[:, :max(0, s1_cut_sample - build_samples)]
        s1_build = y1[:, max(0, s1_cut_sample - build_samples):s1_cut_sample].copy()
        s1_build = apply_hpf_sweep(s1_build, sr, 35.0, eq_p['hpf_end_hz'])

        noise = apply_noise_riser(sr, bpm=bpm_1, bars=build_bars)
        n_len = min(s1_build.shape[1], noise.shape[1])
        s1_build[:, :n_len] += noise[:, :n_len] * 0.6

        s2_in_sample = int(cue_2_sec * sr)
        s2_drop = y2[:, s2_in_sample:]

        s1_drop = y1[:, s1_cut_sample:]
        drop_len = min(s1_drop.shape[1], s2_drop.shape[1], int(16 * spb * sr))
        mixed_drop = eq_sculpt_blend(s1_drop[:, :drop_len], s2_drop[:, :drop_len], sr,
                                     bass_swap_at=eq_p['bass_swap_at'], hi_in_speed=eq_p['hi_in_speed'],
                                     vocal_duck=eq_p['vocal_duck'], vocal_duck_db=eq_p['vocal_duck_db'])
        s2_tail = s2_drop[:, drop_len:]

        master_mix = np.hstack([s1_pre, s1_build, mixed_drop, s2_tail])
        mix_start_sec = max(0, cue_1_sec - build_samples / sr)
        mix_swap_sec = cue_1_sec
        mix_end_sec = cue_1_sec + drop_len / sr

    # -------------------------------------------------------------
    # TECHNIQUE 12: BEATMASH DROP (Rapid beat-repeat → slam)
    # -------------------------------------------------------------
    elif selected_technique == "beatmash_drop":
        if progress_cb: progress_cb(0.40, "Rendering beatmash: 1/2→1/4→1/8→1/16 stutter → drop...")
        spb = 60.0 / bpm_1
        s1_cut_sample = int(cue_1_sec * sr)
        mash_source = y1[:, max(0, s1_cut_sample - int(spb * sr)):s1_cut_sample].copy()

        mash_audio = apply_stutter_chop(mash_source, sr, bpm_1, total_beats=16, final_div=16)
        mash_audio = apply_hpf_sweep(mash_audio, sr, 60.0, eq_p['hpf_end_hz'])

        s1_pre = y1[:, :max(0, s1_cut_sample - int(spb * sr))]

        gap_samples = int(spb * sr)
        silence = np.zeros((2, gap_samples))

        s2_in_sample = int(cue_2_sec * sr)
        s2_play = y2[:, s2_in_sample:]

        sculpt_len = min(int(4 * spb * sr), s2_play.shape[1])
        low_2, mid_2, high_2 = split_3band(s2_play[:, :sculpt_len], sr)
        bass_in = np.linspace(0.0, 1.0, sculpt_len) ** eq_p['incoming_bass_ramp']
        s2_sculpted = low_2 * bass_in + mid_2 + high_2
        s2_with_impact = np.copy(s2_play)
        s2_with_impact[:, :sculpt_len] = s2_sculpted

        t_boom = np.linspace(0, 0.8, int(0.8 * sr), endpoint=False)
        boom = np.sin(2 * np.pi * np.cumsum(75.0 * np.exp(-t_boom * 14.0) + 32.0) / sr) * np.exp(-t_boom * 5.0) * 0.55
        boom_stereo = np.vstack([boom, boom])
        b_len = min(boom_stereo.shape[1], s2_with_impact.shape[1])
        s2_with_impact[:, :b_len] += boom_stereo[:, :b_len]

        master_mix = np.hstack([s1_pre, mash_audio, silence, s2_with_impact])
        mix_start_sec = max(0, cue_1_sec - spb)
        mix_swap_sec = cue_1_sec + mash_audio.shape[1] / sr
        mix_end_sec = mix_swap_sec + spb + 4.0

    # -------------------------------------------------------------
    # TECHNIQUE 13: BACKSPIN SLAM
    # -------------------------------------------------------------
    elif selected_technique == "backspin_slam":
        if progress_cb: progress_cb(0.40, "Rendering backspin slam: HPF sweep → reverse → impact...")
        s1_cut_sample = int(cue_1_sec * sr)
        s1_pre = y1[:, :s1_cut_sample].copy()

        sweep_len = min(int(2 * seconds_per_beat_1 * sr), s1_pre.shape[1])
        if sweep_len > 0:
            s1_pre[:, -sweep_len:] = apply_hpf_sweep(s1_pre[:, -sweep_len:], sr, 35.0, eq_p['hpf_end_hz'])

        spin_source = s1_pre[:, max(0, s1_cut_sample - int(2.0 * sr)):].copy()
        spin_audio = apply_spinback_fx(spin_source, sr, duration_sec=1.0)

        s2_in_sample = int(cue_2_sec * sr)
        s2_play = y2[:, s2_in_sample:]

        t_boom = np.linspace(0, 1.0, int(1.0 * sr), endpoint=False)
        boom_freq = 85.0 * np.exp(-t_boom * 12.0) + 30.0
        boom = np.sin(2 * np.pi * np.cumsum(boom_freq) / sr) * np.exp(-t_boom * 3.5) * 0.6
        boom_stereo = np.vstack([boom, boom])
        s2_with_boom = np.copy(s2_play)
        b_len = min(boom_stereo.shape[1], s2_with_boom.shape[1])
        s2_with_boom[:, :b_len] += boom_stereo[:, :b_len]

        master_mix = np.hstack([s1_pre, spin_audio, s2_with_boom])
        mix_start_sec = cue_1_sec
        mix_swap_sec = cue_1_sec + 1.0
        mix_end_sec = cue_1_sec + 2.5

    # -------------------------------------------------------------
    # TECHNIQUE 14: TENSION RISER (Snare Roll + Filter + Noise → Drop)
    # -------------------------------------------------------------
    elif selected_technique == "tension_riser":
        if progress_cb: progress_cb(0.40, "Building tension: snare roll + filter sweep + noise riser...")
        spb = 60.0 / bpm_1
        build_bars = min(bars, 8)
        build_samples = int(build_bars * 4 * spb * sr)

        s1_cut_sample = int(cue_1_sec * sr)
        s1_pre = y1[:, :max(0, s1_cut_sample - build_samples)]
        s1_build = y1[:, max(0, s1_cut_sample - build_samples):s1_cut_sample].copy()
        s1_build = apply_hpf_sweep(s1_build, sr, 35.0, eq_p['hpf_end_hz'])

        noise = apply_noise_riser(sr, bpm=bpm_1, bars=build_bars)
        n_len = min(s1_build.shape[1], noise.shape[1])
        s1_build[:, :n_len] += noise[:, :n_len] * 0.7

        snare = apply_tension_snare_roll(sr, bpm_1, bars=build_bars)
        sn_len = min(s1_build.shape[1], snare.shape[1])
        s1_build[:, :sn_len] += snare[:, :sn_len] * 0.55

        s1_build = apply_sidechain_pump(s1_build, sr, bpm_1, depth=0.5)

        gap_samples = int(spb * sr)
        if s1_build.shape[1] > gap_samples:
            s1_build[:, -gap_samples:] = 0.0

        s2_in_sample = int(cue_2_sec * sr)
        s2_play = y2[:, s2_in_sample:]

        sculpt_len = min(int(4 * spb * sr), s2_play.shape[1])
        low_2, mid_2, high_2 = split_3band(s2_play[:, :sculpt_len], sr)
        bass_in = np.linspace(0.0, 1.0, sculpt_len) ** eq_p['incoming_bass_ramp']
        s2_sculpted = low_2 * bass_in + mid_2 + high_2
        s2_with_impact = np.copy(s2_play)
        s2_with_impact[:, :sculpt_len] = s2_sculpted

        t_boom = np.linspace(0, 1.0, int(1.0 * sr), endpoint=False)
        boom_freq = 85.0 * np.exp(-t_boom * 12.0) + 30.0
        boom = np.sin(2 * np.pi * np.cumsum(boom_freq) / sr) * np.exp(-t_boom * 3.5) * 0.6
        boom_stereo = np.vstack([boom, boom])
        b_len = min(boom_stereo.shape[1], s2_with_impact.shape[1])
        s2_with_impact[:, :b_len] += boom_stereo[:, :b_len]

        master_mix = np.hstack([s1_pre, s1_build, s2_with_impact])
        mix_start_sec = max(0, cue_1_sec - build_samples / sr)
        mix_swap_sec = cue_1_sec
        mix_end_sec = cue_1_sec + 4.0

    # -------------------------------------------------------------
    # TECHNIQUE 15: STUTTER EDIT (1/16th chops + incoming fade)
    # -------------------------------------------------------------
    elif selected_technique == "stutter_edit":
        if progress_cb: progress_cb(0.40, "Rendering stutter edit: rapid chops + 3-band EQ blend...")
        spb = 60.0 / bpm_1
        stutter_beats = min(bars * 4, 16)
        stutter_dur = stutter_beats * spb

        s1_cut_sample = int(cue_1_sec * sr)
        s1_pre = y1[:, :s1_cut_sample]

        stutter_source = y1[:, max(0, s1_cut_sample - int(spb * sr)):s1_cut_sample].copy()
        stutter_audio = apply_stutter_chop(stutter_source, sr, bpm_1, total_beats=stutter_beats, final_div=16)
        stutter_audio = apply_hpf_sweep(stutter_audio, sr, 80.0, eq_p['hpf_end_hz'])

        s2_in_sample = int(cue_2_sec * sr)
        stutter_len = stutter_audio.shape[1]
        s2_blend = y2[:, s2_in_sample:s2_in_sample + stutter_len]
        if s2_blend.shape[1] < stutter_len:
            s2_blend = np.hstack([s2_blend, np.zeros((2, stutter_len - s2_blend.shape[1]))])

        blend_len = min(stutter_len, s2_blend.shape[1])
        mixed = eq_sculpt_blend(stutter_audio[:, :blend_len], s2_blend[:, :blend_len], sr,
                                bass_swap_at=eq_p['bass_swap_at'], hi_in_speed=eq_p['hi_in_speed'],
                                vocal_duck=eq_p['vocal_duck'], vocal_duck_db=eq_p['vocal_duck_db'])

        s2_post = y2[:, s2_in_sample + stutter_len:]

        master_mix = np.hstack([s1_pre, mixed, s2_post])
        mix_start_sec = cue_1_sec
        mix_swap_sec = cue_1_sec + stutter_dur * 0.5
        mix_end_sec = cue_1_sec + stutter_dur

    # -------------------------------------------------------------
    # TECHNIQUE 16: FILTER SWEEP BLEND
    # -------------------------------------------------------------
    elif selected_technique == "filter_sweep":
        if progress_cb: progress_cb(0.40, "Rendering filter sweep: HPF out ↔ LPF in crossover...")
        transition_dur = bars * 4 * seconds_per_beat_1

        s1_cut_sample = int(cue_1_sec * sr)
        s1_pre = y1[:, :s1_cut_sample]

        trans_samples = int(transition_dur * sr)
        s1_trans = y1[:, s1_cut_sample:s1_cut_sample + trans_samples]
        if s1_trans.shape[1] < trans_samples:
            s1_trans = np.hstack([s1_trans, np.zeros((2, trans_samples - s1_trans.shape[1]))])

        s2_in_sample = int(cue_2_sec * sr)
        s2_trans = y2[:, s2_in_sample:s2_in_sample + trans_samples]
        if s2_trans.shape[1] < trans_samples:
            s2_trans = np.hstack([s2_trans, np.zeros((2, trans_samples - s2_trans.shape[1]))])

        if tempo_ramp and abs(bpm_1 - bpm_2) > 0.8:
            s2_trans = dynamic_tempo_ramp(s2_trans, sr, start_rate=bpm_1 / bpm_2, end_rate=1.0)
        min_len = min(s1_trans.shape[1], s2_trans.shape[1])
        mixed = apply_filter_sweep_blend(s1_trans[:, :min_len], s2_trans[:, :min_len], sr)

        s2_post = y2[:, s2_in_sample + trans_samples:]
        master_mix = np.hstack([s1_pre, mixed, s2_post])
        mix_start_sec = cue_1_sec
        mix_swap_sec = cue_1_sec + transition_dur * 0.5
        mix_end_sec = cue_1_sec + transition_dur

    # -------------------------------------------------------------
    # TECHNIQUE 17: ECHO DISSOLVE (Increasing delay feedback → melt)
    # -------------------------------------------------------------
    elif selected_technique == "echo_dissolve":
        if progress_cb: progress_cb(0.40, "Rendering echo dissolve: feedback melt into Deck 2...")
        s1_cut_sample = int(cue_1_sec * sr)
        s1_pre = y1[:, :s1_cut_sample]

        exit_chunk = y1[:, max(0, s1_cut_sample - int(3 * sr)):s1_cut_sample].copy()
        echo_tail = apply_echo_freeze(exit_chunk, sr, bpm=bpm_1, tail_sec=6.0)

        vol_env = np.linspace(1.0, 0.0, echo_tail.shape[1]) ** 0.8
        echo_tail *= vol_env

        s2_in_sample = int(cue_2_sec * sr)
        s2_play = y2[:, s2_in_sample:]

        tail_len = min(echo_tail.shape[1], s2_play.shape[1])
        low_e, mid_e, high_e = split_3band(echo_tail[:, :tail_len], sr)
        low_2, mid_2, high_2 = split_3band(s2_play[:, :tail_len], sr)

        hi_in = np.linspace(0.3, 1.0, tail_len) ** 0.8
        mid_in = np.linspace(0.2, 1.0, tail_len)
        bass_swap = int(tail_len * eq_p['bass_swap_at'])
        low_in = np.zeros(tail_len)
        low_in[bass_swap:] = np.linspace(0.0, 1.0, tail_len - bass_swap)
        low_out = np.ones(tail_len)
        low_out[bass_swap:] = np.linspace(1.0, 0.0, tail_len - bass_swap)

        s2_sculpted = (high_2 * hi_in + mid_2 * mid_in + low_2 * low_in +
                       high_e * 0.6 + mid_e * 0.4 + low_e * low_out * 0.5)

        s2_with_dissolve = np.copy(s2_play)
        s2_with_dissolve[:, :tail_len] = s2_sculpted
        if s2_play.shape[1] > tail_len:
            s2_with_dissolve[:, tail_len:] = s2_play[:, tail_len:]

        fade_len = int(0.02 * sr)
        if s1_pre.shape[1] > fade_len:
            s1_pre[:, -fade_len:] *= np.linspace(1, 0, fade_len)

        master_mix = np.hstack([s1_pre, s2_with_dissolve])
        mix_start_sec = cue_1_sec
        mix_swap_sec = cue_1_sec
        mix_end_sec = cue_1_sec + 6.0

    # -------------------------------------------------------------
    # TECHNIQUE 18: DRUM SWAP (Drums first, melody later)
    # -------------------------------------------------------------
    elif selected_technique == "drum_swap":
        if progress_cb: progress_cb(0.40, "Rendering drum swap: percussion first, melody follows...")
        transition_dur = bars * 4 * seconds_per_beat_1
        trans_samples = int(transition_dur * sr)

        s1_cut_sample = int(cue_1_sec * sr)
        s1_pre = y1[:, :s1_cut_sample]

        s1_trans = y1[:, s1_cut_sample:s1_cut_sample + trans_samples]
        if s1_trans.shape[1] < trans_samples:
            s1_trans = np.hstack([s1_trans, np.zeros((2, trans_samples - s1_trans.shape[1]))])

        s2_in_sample = int(cue_2_sec * sr)
        s2_trans = y2[:, s2_in_sample:s2_in_sample + trans_samples]
        if s2_trans.shape[1] < trans_samples:
            s2_trans = np.hstack([s2_trans, np.zeros((2, trans_samples - s2_trans.shape[1]))])

        if tempo_ramp and abs(bpm_1 - bpm_2) > 0.8:
            s2_trans = dynamic_tempo_ramp(s2_trans, sr, start_rate=bpm_1 / bpm_2, end_rate=1.0)

        min_len = min(s1_trans.shape[1], s2_trans.shape[1])
        s1_trans = s1_trans[:, :min_len]
        s2_trans = s2_trans[:, :min_len]

        low_1, mid_1, high_1 = split_3band(s1_trans, sr)
        low_2, mid_2, high_2 = split_3band(s2_trans, sr)
        if eq_p['vocal_duck'] and eq_p['vocal_duck_db'] > 0:
            mid_1 = apply_vocal_ducking(mid_1, mid_2, sr, max_duck_db=eq_p['vocal_duck_db'])

        N = min_len
        half = N // 2

        low_fade_1 = np.ones(N)
        low_fade_1[half // 2:half] = np.linspace(1.0, 0.0, half - half // 2)
        low_fade_1[half:] = 0.0

        low_fade_2 = np.zeros(N)
        low_fade_2[half // 2:half] = np.linspace(0.0, 1.0, half - half // 2)
        low_fade_2[half:] = 1.0

        high_fade_1 = np.ones(N)
        high_fade_1[:half] = np.linspace(1.0, 0.3, half)
        high_fade_1[half:] = np.linspace(0.3, 0.0, N - half) ** 1.5

        high_fade_2 = np.zeros(N)
        high_fade_2[:half] = np.linspace(0.0, 0.7, half)
        high_fade_2[half:] = np.linspace(0.7, 1.0, N - half)

        mid_fade_1 = np.ones(N)
        mid_fade_1[half:] = np.linspace(1.0, 0.0, N - half) ** 1.5

        mid_fade_2 = np.zeros(N)
        mid_fade_2[half:] = np.linspace(0.0, 1.0, N - half) ** 1.2

        mixed = (low_1 * low_fade_1 + low_2 * low_fade_2 +
                 mid_1 * mid_fade_1 + mid_2 * mid_fade_2 +
                 high_1 * high_fade_1 + high_2 * high_fade_2)

        s2_post = y2[:, s2_in_sample + trans_samples:]
        master_mix = np.hstack([s1_pre, mixed, s2_post])
        mix_start_sec = cue_1_sec
        mix_swap_sec = cue_1_sec + transition_dur * 0.5
        mix_end_sec = cue_1_sec + transition_dur

    # -------------------------------------------------------------
    # TECHNIQUE 19: ACAPELLA MASHUP (Vocal stem over incoming beat)
    # -------------------------------------------------------------
    elif selected_technique == "acapella_mashup":
        if progress_cb: progress_cb(0.40, "Rendering acapella mashup: vocals over incoming beat...")
        transition_dur = bars * 4 * seconds_per_beat_1
        trans_samples = int(transition_dur * sr)

        s1_cut_sample = int(cue_1_sec * sr)
        s1_pre = y1[:, :s1_cut_sample]

        s1_vocal = y1[:, s1_cut_sample:s1_cut_sample + trans_samples]
        if s1_vocal.shape[1] < trans_samples:
            s1_vocal = np.hstack([s1_vocal, np.zeros((2, trans_samples - s1_vocal.shape[1]))])
        _, s1_mid, _ = split_3band(s1_vocal, sr, f_low=300, f_high=3500)

        s2_in_sample = int(cue_2_sec * sr)
        s2_trans = y2[:, s2_in_sample:s2_in_sample + trans_samples]
        if s2_trans.shape[1] < trans_samples:
            s2_trans = np.hstack([s2_trans, np.zeros((2, trans_samples - s2_trans.shape[1]))])

        if tempo_ramp and abs(bpm_1 - bpm_2) > 0.8:
            s2_trans = dynamic_tempo_ramp(s2_trans, sr, start_rate=bpm_1 / bpm_2, end_rate=1.0)

        min_len = min(s1_mid.shape[1], s2_trans.shape[1])

        _, s2_mid, _ = split_3band(s2_trans[:, :min_len], sr, f_low=300, f_high=3500)
        duck_db = max(eq_p['vocal_duck_db'], 6.0)
        s2_mid_ducked = apply_vocal_ducking(s2_mid, s1_mid[:, :min_len], sr, max_duck_db=duck_db)
        s2_sculpted = s2_trans[:, :min_len] - s2_mid + s2_mid_ducked

        vocal_env = np.ones(min_len)
        fade_out_start = int(min_len * 0.6)
        vocal_env[fade_out_start:] = np.linspace(1.0, 0.0, min_len - fade_out_start)

        mixed = s2_sculpted + s1_mid[:, :min_len] * vocal_env * 0.7

        s2_post = y2[:, s2_in_sample + trans_samples:]
        master_mix = np.hstack([s1_pre, mixed, s2_post])
        mix_start_sec = cue_1_sec
        mix_swap_sec = cue_1_sec + transition_dur * 0.5
        mix_end_sec = cue_1_sec + transition_dur

    # -------------------------------------------------------------
    # TECHNIQUE 20: VOCAL CHOP BRIDGE
    # -------------------------------------------------------------
    elif selected_technique == "vocal_chop":
        if progress_cb: progress_cb(0.40, "Rendering vocal chop bridge...")
        spb = 60.0 / bpm_1

        s1_cut_sample = int(cue_1_sec * sr)
        s1_pre = y1[:, :s1_cut_sample]

        vocal_source = y1[:, max(0, s1_cut_sample - int(2 * spb * sr)):s1_cut_sample]
        _, vocal_mid, _ = split_3band(vocal_source, sr, f_low=300, f_high=3500)

        chop_beats = 8
        chop_samples = int(chop_beats * spb * sr)
        chop_audio = apply_stutter_chop(vocal_mid, sr, bpm_1, total_beats=chop_beats, final_div=8)
        chop_len = min(chop_audio.shape[1], chop_samples)
        chop_audio = chop_audio[:, :chop_len]

        s2_in_sample = int(cue_2_sec * sr)
        s2_play = y2[:, s2_in_sample:]
        blend_len = min(chop_len, s2_play.shape[1])

        mixed = eq_sculpt_blend(chop_audio[:, :blend_len], s2_play[:, :blend_len], sr,
                                bass_swap_at=eq_p['bass_swap_at'], hi_in_speed=eq_p['hi_in_speed'],
                                vocal_duck=eq_p['vocal_duck'], vocal_duck_db=eq_p['vocal_duck_db'])
        s2_tail = s2_play[:, blend_len:]

        master_mix = np.hstack([s1_pre, mixed, s2_tail])
        mix_start_sec = cue_1_sec
        mix_swap_sec = cue_1_sec + chop_len / sr * 0.5
        mix_end_sec = cue_1_sec + chop_len / sr

    # -------------------------------------------------------------
    # TECHNIQUE 21 & 22: BASS SWAP & STEM MASHUP (16/32 BARS)
    # -------------------------------------------------------------
    else: # bass_swap, stem_mashup, or seamless
        if progress_cb: progress_cb(0.30, f"Tempo matching & 3-band crossover (Transition: {bars} bars)...")
        beats_in_transition = bars * 4
        transition_dur_sec = beats_in_transition * seconds_per_beat_1
        swap_beat = beats_in_transition // 2
        swap_offset_sec = swap_beat * seconds_per_beat_1
        
        s1_pre_samples = int(cue_1_sec * sr)
        s1_pre = y1[:, :s1_pre_samples]
        
        s1_trans_samples = int(transition_dur_sec * sr)
        s1_trans_end = min(y1.shape[1], s1_pre_samples + s1_trans_samples)
        s1_trans = y1[:, s1_pre_samples:s1_trans_end]
        if s1_trans.shape[1] < s1_trans_samples:
            pad = np.zeros((2, s1_trans_samples - s1_trans.shape[1]))
            s1_trans = np.hstack([s1_trans, pad])
            
        s2_in_samples = int(cue_2_sec * sr)
        t2_needed_native_sec = beats_in_transition * seconds_per_beat_2
        t2_needed_samples = int(t2_needed_native_sec * sr)
        t2_trans_end = min(y2.shape[1], s2_in_samples + t2_needed_samples)
        s2_trans_native = y2[:, s2_in_samples:t2_trans_end]
        if s2_trans_native.shape[1] < t2_needed_samples:
            pad = np.zeros((2, t2_needed_samples - s2_trans_native.shape[1]))
            s2_trans_native = np.hstack([s2_trans_native, pad])
            
        # Smooth continuous tempo ramp: glide Track 2 rate from Track 1 BPM to native
        if tempo_ramp and abs(bpm_1 - bpm_2) > 0.8:
            s2_trans = dynamic_tempo_ramp(s2_trans_native, sr, start_rate=bpm_1 / bpm_2, end_rate=1.0)
        else:
            rate_2_to_1 = bpm_1 / bpm_2
            s2_trans = time_stretch_audio(s2_trans_native, rate_2_to_1)
        
        min_trans_len = min(s1_trans.shape[1], s2_trans.shape[1])
        s1_trans = s1_trans[:, :min_trans_len]
        s2_trans = s2_trans[:, :min_trans_len]
        
        swap_sample = int(swap_offset_sec * sr)
        swap_sample = min(swap_sample, min_trans_len - 100)
        
        # Linkwitz-Riley 3-Band Crossover
        low_1, mid_1, high_1 = split_3band(s1_trans, sr)
        low_2, mid_2, high_2 = split_3band(s2_trans, sr)

        # Smart vocal ducking: duck Track 1 mids whenever Track 2 mids are loud
        mid_1 = apply_vocal_ducking(mid_1, mid_2, sr, max_duck_db=8.0)
        
        # Content-aware fader automation using section_map
        N = min_trans_len
        section_map_1 = info_1.get('section_map', [])
        section_map_2 = info_2.get('section_map', [])

        # Compute adaptive bass swap position from incoming track's bass energy
        bass_swap_ratio = 0.5  # default: midpoint
        if section_map_2:
            intro_sections = [s for s in section_map_2
                              if cue_2_sec <= s['time'] < cue_2_sec + transition_dur_sec * 0.5]
            if intro_sections:
                avg_bass = sum(s['bass_energy'] for s in intro_sections) / len(intro_sections)
                if avg_bass < 0.2:
                    bass_swap_ratio = 0.6
                elif avg_bass > 0.45:
                    bass_swap_ratio = 0.4

        # The swap lands on the 1: snap to the nearest bar line of the blend
        bar_samples = 4 * seconds_per_beat_1 * sr
        swap_sample = int(round(bass_swap_ratio * min_trans_len / bar_samples) * bar_samples)
        swap_sample = min(swap_sample, min_trans_len - 100)

        # Check for vocal presence in outgoing exit zone
        out_has_vocals = False
        if section_map_1:
            exit_sections = [s for s in section_map_1
                             if cue_1_sec <= s['time'] < cue_1_sec + transition_dur_sec]
            out_has_vocals = any(s.get('has_vocals', False) for s in exit_sections)

        # 1. High frequencies: adaptive entry speed
        hi_full_ratio = 0.4
        if section_map_2:
            in_hi_secs = [s for s in section_map_2
                          if cue_2_sec <= s['time'] < cue_2_sec + transition_dur_sec * 0.5]
            if in_hi_secs:
                avg_hi = sum(s['high_energy'] for s in in_hi_secs) / len(in_hi_secs)
                if avg_hi > 0.4:
                    hi_full_ratio = 0.25

        hi_full_sample = int(hi_full_ratio * N)
        high_fade_1 = np.ones(N)
        high_fade_1[:swap_sample] = np.linspace(1.0, 0.85, swap_sample)
        high_fade_1[swap_sample:] = np.linspace(0.85, 0.0, N - swap_sample) ** 1.5

        high_fade_2 = np.ones(N)
        high_fade_2[:hi_full_sample] = np.linspace(0.25, 1.0, hi_full_sample) ** 1.2
        high_fade_2[hi_full_sample:] = 1.0

        # 2. Mid frequencies: gentle duck when outgoing has vocals
        mid_duck_depth = 0.05 if out_has_vocals else 0.0
        mid_fade_1 = np.ones(N)
        mid_fade_1[:swap_sample] = np.linspace(1.0, 0.90 - mid_duck_depth, swap_sample)
        mid_fade_1[swap_sample:] = np.linspace(0.90 - mid_duck_depth, 0.0, N - swap_sample) ** 1.8

        mid_fade_2 = np.ones(N)
        mid_start = 0.38 if out_has_vocals else 0.40
        mid_fade_2[:swap_sample] = np.linspace(mid_start, 0.65, swap_sample)
        mid_fade_2[swap_sample:] = 1.0

        # 3. Low frequencies: isolator-style swap in 30 ms ending exactly on the downbeat,
        #    so only one kick and one bassline ever play (no double-bass mud)
        xfade_width = int(0.03 * sr)
        xfade_start = max(0, swap_sample - xfade_width)
        xfade_end = min(N, xfade_start + xfade_width)
        actual_width = xfade_end - xfade_start

        low_fade_1 = np.ones(N)
        low_fade_1[xfade_end:] = 0.0
        if actual_width > 0:
            k = np.linspace(0, 1, actual_width)
            low_fade_1[xfade_start:xfade_end] = np.cos(k * np.pi * 0.5)

        low_fade_2 = np.zeros(N)
        low_fade_2[xfade_end:] = 1.0
        if actual_width > 0:
            low_fade_2[xfade_start:xfade_end] = np.sin(k * np.pi * 0.5)
            
        # HPF sweep on Track 1 pre-drop
        sweep_start = max(0, swap_sample - int(4 * seconds_per_beat_1 * sr))
        if sweep_start < swap_sample:
            pre_drop_1 = mid_1[:, sweep_start:swap_sample]
            mid_1[:, sweep_start:swap_sample] = apply_hpf_sweep(pre_drop_1, sr, 20.0, 1000.0)
            
        proc_1 = (low_1 * low_fade_1) + (mid_1 * mid_fade_1) + (high_1 * high_fade_1)
        proc_2 = (low_2 * low_fade_2) + (mid_2 * mid_fade_2) + (high_2 * high_fade_2)
        
        # Reverb Washout on Track 1 exit
        exit_chunk = s1_trans[:, max(0, swap_sample - int(0.5*sr)):swap_sample]
        reverb_wash = apply_reverb_delay_tail(exit_chunk, sr, delay_sec=seconds_per_beat_1 * 0.75, decay=0.45, feedback_count=4)
        
        mixed_trans = proc_1 + proc_2
        wash_len = min(reverb_wash.shape[1], mixed_trans.shape[1] - swap_sample)
        if wash_len > 0:
            mixed_trans[:, swap_sample:swap_sample+wash_len] += reverb_wash[:, :wash_len] * 0.35
            
        s2_post_start = s2_in_samples + t2_needed_samples
        s2_post = y2[:, s2_post_start:] if s2_post_start < y2.shape[1] else np.zeros((2, 0))
        
        master_mix = np.hstack([s1_pre, mixed_trans, s2_post])
        mix_start_sec = cue_1_sec
        mix_swap_sec = cue_1_sec + swap_offset_sec
        mix_end_sec = cue_1_sec + (min_trans_len / sr)

    # Apply soft limiter to master mix
    if progress_cb: progress_cb(0.90, "Applying peak limiter and exporting 24-bit WAV...")
    master_mix = soft_limit(master_mix.astype(np.float32, copy=False), threshold=0.96)
    
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    sf.write(output_path, master_mix.T, sr, subtype='PCM_16')
    
    total_dur = master_mix.shape[1] / sr
    del master_mix
    gc.collect()

    if progress_cb: progress_cb(1.0, "Mix complete!")
    
    return {
        "output_file": os.path.basename(output_path),
        "technique": selected_technique,
        "ai_recommendation": ai_choice,
        "eq_params": eq_p,
        "total_duration": round(total_dur, 2),
        "mix_start_sec": round(mix_start_sec, 2),
        "mix_swap_sec": round(mix_swap_sec, 2),
        "mix_end_sec": round(mix_end_sec, 2),
        "bpm_track_1": round(bpm_1, 2),
        "bpm_track_2": round(bpm_2, 2),
        "pitch_shift_semitones": pitch_shift_semitones,
        "camelot_compatibility": camelot_info,
        "bars": bars
    }
