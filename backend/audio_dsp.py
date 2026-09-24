"""
audio_dsp.py - Professional DJ Audio DSP Engine
Provides:
- Pitch-preserving time-stretching and smooth tempo ramp
- Camelot harmonic pitch-shifting
- 4th-order Linkwitz-Riley 3-band crossover (Low, Mid, High)
- Professional DJ bass-swap automation & filter sweeps
- Studio-grade reverb/delay washout tail
"""

import numpy as np
from .lazy import LazyModule
signal = LazyModule("scipy.signal")
librosa = LazyModule("librosa")
from typing import Tuple, Dict, Any, Optional

def pitch_shift_audio(y: np.ndarray, sr: int, semitones: float) -> np.ndarray:
    """
    Shifts pitch by semitones without changing duration.
    Supports mono or stereo (2, N).
    """
    if abs(semitones) < 0.01:
        return y
    if y.ndim == 2:
        left = librosa.effects.pitch_shift(y=y[0], sr=sr, n_steps=semitones)
        right = librosa.effects.pitch_shift(y=y[1], sr=sr, n_steps=semitones)
        return np.vstack([left, right])
    return librosa.effects.pitch_shift(y=y, sr=sr, n_steps=semitones)

def time_stretch_audio(y: np.ndarray, rate: float) -> np.ndarray:
    """
    Stretches audio by rate factor (rate > 1 speeds up, rate < 1 slows down).
    Preserves pitch.
    """
    if abs(rate - 1.0) < 0.001:
        return y
    if y.ndim == 2:
        left = librosa.effects.time_stretch(y=y[0], rate=rate)
        right = librosa.effects.time_stretch(y=y[1], rate=rate)
        # Ensure identical lengths
        min_len = min(len(left), len(right))
        return np.vstack([left[:min_len], right[:min_len]])
    return librosa.effects.time_stretch(y=y, rate=rate)

def create_linkwitz_riley_3band(sr: int, f_low: float = 250.0, f_high: float = 2500.0):
    """
    Creates 4th order Linkwitz-Riley crossover filters (cascaded Butterworth 2nd order)
    at f_low (<250Hz) and f_high (>2500Hz).
    Sum of bands has flat magnitude response and zero phase distortion when properly summed.
    """
    nyq = sr / 2.0
    
    # 2nd order Butterworth squared = 4th order Linkwitz-Riley
    # Low pass
    sos_lp = signal.butter(2, f_low / nyq, btype='low', output='sos')
    # High pass for mid
    sos_hp_mid = signal.butter(2, f_low / nyq, btype='high', output='sos')
    # Low pass for mid
    sos_lp_mid = signal.butter(2, f_high / nyq, btype='low', output='sos')
    # High pass
    sos_hp = signal.butter(2, f_high / nyq, btype='high', output='sos')
    
    return sos_lp, sos_hp_mid, sos_lp_mid, sos_hp

def split_3band(y: np.ndarray, sr: int, f_low: float = 250.0, f_high: float = 2500.0) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Splits mono or stereo audio into (low_band, mid_band, high_band) using Linkwitz-Riley crossover.
    """
    # float32 filters keep the bands float32 (half the memory of float64 on a 512 MB server)
    sos_lp, sos_hp_mid, sos_lp_mid, sos_hp = (s.astype(np.float32) for s in create_linkwitz_riley_3band(sr, f_low, f_high))
    y = y.astype(np.float32, copy=False)

    def apply_band(ch):
        # 4th order Linkwitz-Riley: run sosfilt twice in forward direction
        low = signal.sosfilt(sos_lp, signal.sosfilt(sos_lp, ch))
        mid = signal.sosfilt(sos_hp_mid, signal.sosfilt(sos_hp_mid, ch))
        mid = signal.sosfilt(sos_lp_mid, signal.sosfilt(sos_lp_mid, mid))
        high = signal.sosfilt(sos_hp, signal.sosfilt(sos_hp, ch))
        return low, mid, high

    if y.ndim == 2:
        low_l, mid_l, high_l = apply_band(y[0])
        low_r, mid_r, high_r = apply_band(y[1])
        return (np.vstack([low_l, low_r]), 
                np.vstack([mid_l, mid_r]), 
                np.vstack([high_l, high_r]))
    else:
        return apply_band(y)

def apply_reverb_delay_tail(y: np.ndarray, sr: int, delay_sec: float = 0.375, decay: float = 0.5, feedback_count: int = 4) -> np.ndarray:
    """
    Generates a synchronized ping-pong delay / reverb wash tail for smooth track exit.
    """
    delay_samples = int(delay_sec * sr)
    tail_len = delay_samples * feedback_count
    
    if y.ndim == 2:
        out = np.zeros((2, y.shape[1] + tail_len), dtype=y.dtype)
        out[:, :y.shape[1]] = y
        for i in range(1, feedback_count + 1):
            offset = i * delay_samples
            vol = decay ** i
            if offset < out.shape[1]:
                avail = min(y.shape[1], out.shape[1] - offset)
                # Alternate left and right for ping-pong effect
                if i % 2 == 1:
                    out[0, offset:offset+avail] += y[1, :avail] * vol
                    out[1, offset:offset+avail] += y[0, :avail] * (vol * 0.8)
                else:
                    out[0, offset:offset+avail] += y[0, :avail] * vol
                    out[1, offset:offset+avail] += y[1, :avail] * vol
        return out
    else:
        out = np.zeros(len(y) + tail_len, dtype=y.dtype)
        out[:len(y)] = y
        for i in range(1, feedback_count + 1):
            offset = i * delay_samples
            vol = decay ** i
            if offset < len(out):
                avail = min(len(y), len(out) - offset)
                out[offset:offset+avail] += y[:avail] * vol
        return out

def apply_hpf_sweep(y: np.ndarray, sr: int, start_freq: float = 20.0, end_freq: float = 1200.0) -> np.ndarray:
    """
    Applies a dynamic High-Pass Filter sweep across the audio buffer.
    Simulates a Pioneer DJM Color FX filter knob turned clockwise.
    """
    num_samples = y.shape[-1]
    num_chunks = 32
    chunk_size = num_samples // num_chunks
    out = np.zeros_like(y)
    
    freqs = np.geomspace(max(20.0, start_freq), min(sr/2.1, end_freq), num_chunks)
    
    for i in range(num_chunks):
        s = i * chunk_size
        e = num_samples if i == num_chunks - 1 else (i + 1) * chunk_size
        cutoff = freqs[i]
        sos = signal.butter(2, cutoff / (sr / 2.0), btype='high', output='sos')
        if y.ndim == 2:
            out[0, s:e] = signal.sosfilt(sos, y[0, s:e])
            out[1, s:e] = signal.sosfilt(sos, y[1, s:e])
        else:
            out[s:e] = signal.sosfilt(sos, y[s:e])
            
    return out

def dynamic_tempo_ramp(y: np.ndarray, sr: int, start_rate: float, end_rate: float, num_steps: int = 16) -> np.ndarray:
    """
    Performs a smooth tempo acceleration or deceleration over the duration of audio buffer `y`.
    Divides audio into slices and smoothly shifts stretch rate from start_rate to end_rate.
    """
    if abs(start_rate - end_rate) < 0.005:
        return time_stretch_audio(y, start_rate)
        
    num_samples = y.shape[-1]
    rates = np.linspace(start_rate, end_rate, num_steps)
    step_samples = num_samples // num_steps
    stretched_pieces = []
    
    crossfade_len = int(0.05 * sr) # 50ms crossfade
    
    for i in range(num_steps):
        s = i * step_samples
        e = num_samples if i == num_steps - 1 else (i + 1) * step_samples
        chunk = y[:, s:e] if y.ndim == 2 else y[s:e]
        stretched_chunk = time_stretch_audio(chunk, rates[i])
        stretched_pieces.append(stretched_chunk)
        
    # Concatenate with small smooth crossfades
    total_len = sum(p.shape[-1] for p in stretched_pieces)
    if y.ndim == 2:
        out = np.zeros((2, total_len), dtype=y.dtype)
        curr = 0
        for p in stretched_pieces:
            p_len = p.shape[1]
            out[:, curr:curr+p_len] = p
            curr += p_len
        return out[:, :curr]
    else:
        out = np.zeros(total_len, dtype=y.dtype)
        curr = 0
        for p in stretched_pieces:
            p_len = len(p)
            out[curr:curr+p_len] = p
            curr += p_len
        return out[:curr]

def apply_echo_freeze(y_exit: np.ndarray, sr: int, bpm: float = 128.0, tail_sec: float = 4.0) -> np.ndarray:
    """
    Echo Freeze / Reverb Washout ("Drop on the 1").
    Captures the final beat into a 3/4-beat ping-pong delay with a 4-second decaying reverb tail.
    """
    spb = 60.0 / bpm
    delay_samples = int(spb * 0.75 * sr)
    tail_samples = int(tail_sec * sr)
    
    # Extract last beat
    last_beat_samples = min(int(spb * sr), y_exit.shape[-1])
    freeze_chunk = y_exit[:, -last_beat_samples:] if y_exit.ndim == 2 else y_exit[-last_beat_samples:]
    
    num_channels = 2 if y_exit.ndim == 2 else 1
    if num_channels == 2:
        out = np.zeros((2, tail_samples), dtype=np.float32)
        # Repeated feedback taps with low-pass damping
        taps = int(tail_sec / (spb * 0.75))
        for i in range(taps):
            offset = i * delay_samples
            if offset >= tail_samples:
                break
            decay = 0.75 ** (i + 1)
            avail = min(freeze_chunk.shape[1], tail_samples - offset)
            # Alternate channels for stereo ping-pong
            if i % 2 == 0:
                out[0, offset:offset+avail] += freeze_chunk[0, :avail] * decay
                out[1, offset:offset+avail] += freeze_chunk[1, :avail] * (decay * 0.7)
            else:
                out[0, offset:offset+avail] += freeze_chunk[1, :avail] * (decay * 0.7)
                out[1, offset:offset+avail] += freeze_chunk[0, :avail] * decay
                
        # Diffuse with mild high-cut to simulate room decay
        sos = signal.butter(2, 3500 / (sr / 2), btype='low', output='sos')
        out[0] = signal.sosfilt(sos, out[0])
        out[1] = signal.sosfilt(sos, out[1])
        return out
    else:
        out = np.zeros(tail_samples, dtype=np.float32)
        taps = int(tail_sec / (spb * 0.75))
        for i in range(taps):
            offset = i * delay_samples
            if offset >= tail_samples: break
            decay = 0.75 ** (i + 1)
            avail = min(len(freeze_chunk), tail_samples - offset)
            out[offset:offset+avail] += freeze_chunk[:avail] * decay
        sos = signal.butter(2, 3500 / (sr / 2), btype='low', output='sos')
        return signal.sosfilt(sos, out)

def apply_vinyl_brake(y_chunk: np.ndarray, sr: int, brake_duration_sec: float = 1.2) -> np.ndarray:
    """
    Simulates a turntable motor-off vinyl brake (tape stop).
    Decelerates playback speed quadratically to zero.
    """
    brake_samples = int(brake_duration_sec * sr)
    if y_chunk.shape[-1] < brake_samples:
        pad_len = brake_samples - y_chunk.shape[-1]
        if y_chunk.ndim == 2:
            y_chunk = np.pad(y_chunk, ((0,0), (0, pad_len)))
        else:
            y_chunk = np.pad(y_chunk, (0, pad_len))
            
    # Quadratic speed envelope: speed(t) = (1 - t/T)^2
    # Audio position is integral of speed: x(t) = integral_0^t (1 - s/T)^2 ds
    t = np.linspace(0, brake_duration_sec, brake_samples, endpoint=False)
    # Integral = t - t^2/T + t^3/(3*T^2) normalized so at T it reaches max pos
    integral = t - (t**2 / brake_duration_sec) + (t**3 / (3 * brake_duration_sec**2))
    integral_norm = integral / (brake_duration_sec / 3.0) # max is T/3
    
    source_indices = integral_norm * (brake_samples * 0.45)
    source_indices = np.clip(source_indices, 0, y_chunk.shape[-1] - 1)
    
    if y_chunk.ndim == 2:
        out_l = np.interp(source_indices, np.arange(y_chunk.shape[1]), y_chunk[0])
        out_r = np.interp(source_indices, np.arange(y_chunk.shape[1]), y_chunk[1])
        # Smooth fade-out at the very end
        fade = np.cos(np.linspace(0, np.pi/2, brake_samples))
        return np.vstack([out_l * fade, out_r * fade])
    else:
        out = np.interp(source_indices, np.arange(len(y_chunk)), y_chunk)
        fade = np.cos(np.linspace(0, np.pi/2, brake_samples))
        return out * fade

def apply_loop_roll_riser(y_source: np.ndarray, sr: int, bpm: float = 128.0, bars: int = 4) -> np.ndarray:
    """
    EDM Festival Stutter Loop Roll & Pitch Riser.
    Divisions: 1-beat (Bar 1) -> 1/2-beat (Bar 2) -> 1/4-beat (Bar 3) -> 1/16-beat (Bar 4).
    Simultaneously applies HPF sweep and pitch riser.
    """
    spb = 60.0 / bpm
    total_beats = bars * 4
    total_samples = int(total_beats * spb * sr)
    
    # Loop piece (1 beat from source)
    one_beat_samples = int(spb * sr)
    seed = y_source[:, -one_beat_samples:] if y_source.ndim == 2 else y_source[-one_beat_samples:]
    
    # Build stutter divisions
    # Bar 1 (4 beats): 1-beat loop x 4
    # Bar 2 (4 beats): 1/2-beat loop x 8
    # Bar 3 (4 beats): 1/4-beat loop x 16
    # Bar 4 (3 beats): 1/8-beat loop x 24, last beat is silence / drop riser!
    out_pieces = []
    
    # Bar 1
    for _ in range(4):
        out_pieces.append(seed)
    # Bar 2 (1/2 beat)
    half = seed[:, :one_beat_samples//2] if seed.ndim == 2 else seed[:one_beat_samples//2]
    for _ in range(8):
        out_pieces.append(half)
    # Bar 3 (1/4 beat)
    quarter = seed[:, :one_beat_samples//4] if seed.ndim == 2 else seed[:one_beat_samples//4]
    for _ in range(16):
        out_pieces.append(quarter)
    # Bar 4 (1/16 beat rapid stutter)
    sixteenth = seed[:, :one_beat_samples//16] if seed.ndim == 2 else seed[:one_beat_samples//16]
    for _ in range(3 * 16): # 3 beats
        out_pieces.append(sixteenth)
        
    # Last beat: Drop silence
    silence = np.zeros((2, one_beat_samples) if seed.ndim == 2 else one_beat_samples)
    out_pieces.append(silence)
    
    # Concatenate
    if seed.ndim == 2:
        rolled = np.hstack(out_pieces)
    else:
        rolled = np.concatenate(out_pieces)
        
    # Apply HPF filter sweep from 60Hz to 3000Hz across the roll
    rolled = apply_hpf_sweep(rolled, sr, start_freq=60.0, end_freq=3200.0)
    return rolled

def apply_spinback_fx(y_chunk: np.ndarray, sr: int, duration_sec: float = 1.0) -> np.ndarray:
    """
    Simulates a physical vinyl spinback (backspin).
    Fast reverse playback accelerating backwards, high-pass filtered,
    with vinyl friction decay ending right before Beat 1 drop.
    """
    num_samples = int(duration_sec * sr)
    if y_chunk.shape[-1] < num_samples:
        pad_len = num_samples - y_chunk.shape[-1]
        pad = np.zeros((2, pad_len) if y_chunk.ndim == 2 else pad_len)
        y_chunk = np.hstack([pad, y_chunk])

    # Reverse acceleration envelope:
    # t goes from 0 to 1; speed goes backwards faster and faster
    t = np.linspace(0, 1, num_samples, endpoint=False)
    # Quadratic reverse trajectory
    rev_progress = t ** 1.8
    chunk_len = y_chunk.shape[-1]
    # Sample backwards from the end of the chunk
    rev_indices = np.clip((1.0 - rev_progress) * (chunk_len - 1), 0, chunk_len - 1)

    if y_chunk.ndim == 2:
        out_l = np.interp(rev_indices, np.arange(chunk_len), y_chunk[0])
        out_r = np.interp(rev_indices, np.arange(chunk_len), y_chunk[1])
        out = np.vstack([out_l, out_r])
    else:
        out = np.interp(rev_indices, np.arange(chunk_len), y_chunk)

    # HPF filter sweep from 250Hz up to 3500Hz
    out = apply_hpf_sweep(out, sr, start_freq=250.0, end_freq=3500.0)

    # Fade out last 100ms for sharp drop silence
    fade_len = int(0.10 * sr)
    fade = np.linspace(1.0, 0.0, fade_len)
    if out.ndim == 2:
        out[:, -fade_len:] *= fade
    else:
        out[-fade_len:] *= fade

    return out

def apply_noise_riser(sr: int, bpm: float = 128.0, bars: int = 4) -> np.ndarray:
    """
    Builds a professional 4-bar white noise tension riser:
    - 4-on-the-floor rhythmic sidechain pumping
    - Exponential HPF sweep (150Hz -> 9000Hz)
    - 1-beat silence gap on bar 4.4 right before the drop
    """
    spb = 60.0 / bpm
    total_beats = bars * 4
    total_samples = int(total_beats * spb * sr)
    one_beat_samples = int(spb * sr)

    # Generate stereo white noise
    noise_l = np.random.uniform(-0.45, 0.45, total_samples).astype(np.float32)
    noise_r = np.random.uniform(-0.45, 0.45, total_samples).astype(np.float32)
    noise = np.vstack([noise_l, noise_r])

    # 4-on-the-floor sidechain ducking curve per beat
    beat_t = np.linspace(0, 1, one_beat_samples, endpoint=False)
    # Pump envelope: drops on beat 1, ramps up smoothly over beat
    pump_curve = 0.2 + 0.8 * (beat_t ** 1.5)

    for b in range(total_beats):
        s = b * one_beat_samples
        e = min(total_samples, s + one_beat_samples)
        cur_len = e - s
        noise[:, s:e] *= pump_curve[:cur_len]

    # Exponential HPF sweep across the riser
    noise = apply_hpf_sweep(noise, sr, start_freq=150.0, end_freq=9000.0)

    # Progressive volume swell
    vol_envelope = np.linspace(0.15, 1.0, total_samples) ** 1.2
    noise *= vol_envelope

    # Silence the final beat (anticipation drop gap)
    silence_start = max(0, total_samples - one_beat_samples)
    noise[:, silence_start:] = 0.0

    return noise

def apply_filter_sweep_blend(y1: np.ndarray, y2: np.ndarray, sr: int) -> np.ndarray:
    """
    Filter sweep crossover blend: HPF sweeps up on track 1 while LPF sweeps down on track 2.
    They cross at midpoint, creating a frequency-domain handoff.
    """
    N = min(y1.shape[-1], y2.shape[-1])
    y1 = y1[:, :N] if y1.ndim == 2 else y1[:N]
    y2 = y2[:, :N] if y2.ndim == 2 else y2[:N]

    num_chunks = 48
    chunk_size = N // num_chunks
    out = np.zeros_like(y1)

    hpf_freqs = np.geomspace(20.0, min(sr / 2.1, 6000.0), num_chunks)
    lpf_freqs = np.geomspace(min(sr / 2.1, 18000.0), 200.0, num_chunks)

    for i in range(num_chunks):
        s = i * chunk_size
        e = N if i == num_chunks - 1 else (i + 1) * chunk_size
        p = i / (num_chunks - 1)

        sos_hp = signal.butter(2, hpf_freqs[i] / (sr / 2.0), btype='high', output='sos')
        sos_lp = signal.butter(2, lpf_freqs[i] / (sr / 2.0), btype='low', output='sos')

        vol1 = np.cos(p * np.pi * 0.5)
        vol2 = np.sin(p * np.pi * 0.5)

        if y1.ndim == 2:
            chunk1_l = signal.sosfilt(sos_hp, y1[0, s:e]) * vol1
            chunk1_r = signal.sosfilt(sos_hp, y1[1, s:e]) * vol1
            chunk2_l = signal.sosfilt(sos_lp, y2[0, s:e]) * vol2
            chunk2_r = signal.sosfilt(sos_lp, y2[1, s:e]) * vol2
            out[0, s:e] = chunk1_l + chunk2_l
            out[1, s:e] = chunk1_r + chunk2_r
        else:
            out[s:e] = signal.sosfilt(sos_hp, y1[s:e]) * vol1 + signal.sosfilt(sos_lp, y2[s:e]) * vol2

    return out


def apply_stutter_chop(y: np.ndarray, sr: int, bpm: float, total_beats: int = 16, final_div: int = 16) -> np.ndarray:
    """
    Rapid stutter chop: progressively shorter slices (1/2 → 1/4 → 1/8 → 1/16 beat).
    Each division repeats the same slice from the anchor point.
    """
    spb = 60.0 / bpm
    one_beat = int(spb * sr)
    anchor = y[:, :one_beat] if y.ndim == 2 else y[:one_beat]
    pieces = []

    beats_done = 0
    for div in [2, 4, 8, final_div]:
        chunk_len = max(1, one_beat // div)
        seed = anchor[:, :chunk_len] if anchor.ndim == 2 else anchor[:chunk_len]
        reps_per_beat = div
        beats_this_phase = total_beats // 4
        total_reps = reps_per_beat * beats_this_phase
        for _ in range(total_reps):
            pieces.append(seed)
        beats_done += beats_this_phase

    if y.ndim == 2:
        return np.hstack(pieces)
    return np.concatenate(pieces)


def apply_tension_snare_roll(sr: int, bpm: float, bars: int = 4) -> np.ndarray:
    """
    Synthesized snare roll that accelerates from quarter notes to 32nd notes.
    Creates tension before a drop.
    """
    spb = 60.0 / bpm
    total_beats = bars * 4
    total_samples = int(total_beats * spb * sr)
    out = np.zeros((2, total_samples), dtype=np.float32)

    snare_len = int(0.03 * sr)
    snare = np.random.uniform(-1, 1, snare_len).astype(np.float32)
    snare *= np.exp(-np.linspace(0, 8, snare_len))
    sos = signal.butter(2, [200 / (sr / 2), 8000 / (sr / 2)], btype='bandpass', output='sos')
    snare = signal.sosfilt(sos, snare)

    divisions = [(1.0, 0.25), (0.5, 0.25), (0.25, 0.25), (0.125, 0.15), (0.0625, 0.10)]

    pos = 0
    for div_beats, phase_frac in divisions:
        phase_samples = int(phase_frac * total_samples)
        hit_interval = int(div_beats * spb * sr)
        if hit_interval < snare_len:
            hit_interval = snare_len
        while pos < min(pos + phase_samples, total_samples):
            vol = 0.15 + 0.55 * (pos / total_samples)
            end = min(pos + snare_len, total_samples)
            n = end - pos
            out[0, pos:end] += snare[:n] * vol
            out[1, pos:end] += snare[:n] * vol
            pos += hit_interval
            if pos >= total_samples:
                break

    return out


def apply_rewind_fx(y: np.ndarray, sr: int, duration_sec: float = 1.5) -> np.ndarray:
    """
    DJ rewind / pull-up effect: plays audio backwards with accelerating speed
    and a characteristic rising pitch whine.
    """
    num_samples = int(duration_sec * sr)
    if y.shape[-1] < num_samples:
        pad = np.zeros((2, num_samples - y.shape[-1]) if y.ndim == 2 else num_samples - y.shape[-1])
        y = np.hstack([pad, y]) if y.ndim == 2 else np.concatenate([pad, y])

    t = np.linspace(0, 1, num_samples, endpoint=False)
    rev_speed = 1.0 + t * 2.5
    rev_progress = np.cumsum(rev_speed) / np.sum(rev_speed)
    chunk_len = y.shape[-1]
    rev_indices = np.clip((1.0 - rev_progress) * (chunk_len - 1), 0, chunk_len - 1)

    if y.ndim == 2:
        out_l = np.interp(rev_indices, np.arange(chunk_len), y[0])
        out_r = np.interp(rev_indices, np.arange(chunk_len), y[1])
        out = np.vstack([out_l, out_r])
    else:
        out = np.interp(rev_indices, np.arange(chunk_len), y)

    fade = np.exp(-t * 3.0)
    out *= fade

    return out


def apply_sidechain_pump(y: np.ndarray, sr: int, bpm: float, depth: float = 0.7) -> np.ndarray:
    """
    Simulates sidechain compression pumping effect synced to kick pattern.
    """
    spb = 60.0 / bpm
    one_beat = int(spb * sr)
    N = y.shape[-1]
    envelope = np.ones(N, dtype=np.float32)

    beat_t = np.linspace(0, 1, one_beat, endpoint=False)
    pump = (1.0 - depth) + depth * (beat_t ** 1.8)

    for b in range(N // one_beat + 1):
        s = b * one_beat
        e = min(N, s + one_beat)
        n = e - s
        envelope[s:e] = pump[:n]

    return y * envelope


def apply_vocal_ducking(mid_1: np.ndarray, mid_2: np.ndarray, sr: int, max_duck_db: float = 8.0) -> np.ndarray:
    """
    Sidechain vocal anti-clash ducking:
    Monitors mid-band (250Hz - 2.5kHz) vocal energy in Track 2.
    Smoothly ducks Track 1 mids by up to -8dB to allow Track 2 vocals
    to cut through with 100% clarity.
    """
    N = min(mid_1.shape[-1], mid_2.shape[-1])
    m1 = mid_1[:, :N] if mid_1.ndim == 2 else mid_1[:N]
    m2 = mid_2[:, :N] if mid_2.ndim == 2 else mid_2[:N]

    # Calculate smoothed energy envelope of Track 2 mids (100ms window)
    window_samples = int(0.10 * sr)
    mono_m2 = np.mean(m2, axis=0) if m2.ndim == 2 else m2
    energy = np.abs(mono_m2)

    # Moving average box filter
    box = np.ones(window_samples) / window_samples
    smooth_energy = signal.fftconvolve(energy, box, mode='same')  # direct convolve: ~6e9 MACs per 32 s

    # Normalize energy to [0, 1]
    peak = np.percentile(smooth_energy, 95) if len(smooth_energy) > 0 else 1.0
    if peak > 1e-4:
        norm_energy = np.clip(smooth_energy / peak, 0.0, 1.0)
    else:
        norm_energy = np.zeros_like(smooth_energy)

    # Compute ducking gain in linear scale
    duck_gain_db = - (max_duck_db * norm_energy)
    duck_gain_linear = 10.0 ** (duck_gain_db / 20.0)

    out = m1 * duck_gain_linear
    return out
