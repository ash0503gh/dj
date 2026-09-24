"""
stem_separator.py - Neural and Fast Stem Separation for Professional DJ Mixing.
Supports:
1. Deep learning stem separation via Demucs (Vocals, Drums, Bass, Other).
2. Fast spectral crossover fallback for instantaneous preview.
"""

import os
import soundfile as sf
import numpy as np
from .lazy import LazyModule
librosa = LazyModule("librosa")
import gc
from typing import Dict, Any, Callable, Optional

def separate_with_demucs(audio_path: str, output_dir: str, progress_callback: Optional[Callable[[float, str], None]] = None) -> Dict[str, str]:
    """
    Separates an audio track into 4 stems using Meta's Demucs (htdemucs).
    Returns dictionary mapping stem name -> file path.
    """
    os.makedirs(output_dir, exist_ok=True)
    base_name = os.path.splitext(os.path.basename(audio_path))[0]
    stem_files = {
        'vocals': os.path.join(output_dir, f"{base_name}_vocals.wav"),
        'drums': os.path.join(output_dir, f"{base_name}_drums.wav"),
        'bass': os.path.join(output_dir, f"{base_name}_bass.wav"),
        'other': os.path.join(output_dir, f"{base_name}_other.wav"),
    }
    
    # Check if already cached
    if all(os.path.exists(p) for p in stem_files.values()):
        if progress_callback:
            progress_callback(1.0, "Stems loaded from cache.")
        return stem_files

    if progress_callback:
        progress_callback(0.1, "Initializing Demucs model...")

    try:
        import torch
        from demucs.pretrained import get_model
        from demucs.apply import apply_model
        
        device = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
        model = get_model('htdemucs')
        model.to(device)
        model.eval()

        if progress_callback:
            progress_callback(0.3, "Loading audio...")
            
        y, sr = librosa.load(audio_path, sr=model.samplerate, mono=False)
        if y.ndim == 1:
            y = np.stack([y, y])
            
        wav = torch.tensor(y, dtype=torch.float32).unsqueeze(0).to(device)
        
        if progress_callback:
            progress_callback(0.5, "Running neural stem separation...")
            
        with torch.no_grad():
            sources = apply_model(model, wav, device=device, split=True, overlap=0.25)[0]
            
        # sources shape: (sources, channels, samples)
        # model.sources is usually ['drums', 'bass', 'other', 'vocals']
        if progress_callback:
            progress_callback(0.85, "Saving isolated stems...")
            
        for idx, source_name in enumerate(model.sources):
            if source_name in stem_files:
                stem_audio = sources[idx].cpu().numpy()
                sf.write(stem_files[source_name], stem_audio.T, model.samplerate)
                
        if progress_callback:
            progress_callback(1.0, "Stem separation complete!")
            
        return stem_files
        
    except Exception as e:
        print(f"Demucs failed or unavailable ({e}). Falling back to fast spectral separation...")
        return separate_fast_spectral(audio_path, output_dir, progress_callback)

def separate_fast_spectral(audio_path: str, output_dir: str, progress_callback: Optional[Callable[[float, str], None]] = None) -> Dict[str, str]:
    """
    High-speed DSP / spectral separation fallback for immediate live response.
    Splits into Bass, Drums/Percussion, Vocals/Leads, and Air/Highs.
    """
    os.makedirs(output_dir, exist_ok=True)
    base_name = os.path.splitext(os.path.basename(audio_path))[0]
    stem_files = {
        'vocals': os.path.join(output_dir, f"{base_name}_vocals.wav"),
        'drums': os.path.join(output_dir, f"{base_name}_drums.wav"),
        'bass': os.path.join(output_dir, f"{base_name}_bass.wav"),
        'other': os.path.join(output_dir, f"{base_name}_other.wav"),
    }
    
    if progress_callback:
        progress_callback(0.2, "Extracting harmonic and percussive components...")
        
    y, sr = librosa.load(audio_path, sr=44100, mono=False)
    if y.ndim == 1:
        y = np.vstack([y, y])
        
    # Harmonic/Percussive separation
    y_harm_l, y_perc_l = librosa.effects.hpss(y[0])
    y_harm_r, y_perc_r = librosa.effects.hpss(y[1])
    
    y_harm = np.vstack([y_harm_l, y_harm_r])
    y_perc = np.vstack([y_perc_l, y_perc_r])
    
    if progress_callback:
        progress_callback(0.6, "Filtering bass and vocal frequency zones...")
        
    from scipy.signal import butter, sosfilt
    # Bass (< 200 Hz from harmonic)
    sos_bass = butter(3, 200 / (sr / 2), btype='low', output='sos')
    bass_l = sosfilt(sos_bass, y_harm[0])
    bass_r = sosfilt(sos_bass, y_harm[1])
    bass = np.vstack([bass_l, bass_r])
    
    # Vocals (300 Hz - 3500 Hz from harmonic)
    sos_vocal = butter(3, [300 / (sr / 2), 3500 / (sr / 2)], btype='bandpass', output='sos')
    vocal_l = sosfilt(sos_vocal, y_harm[0])
    vocal_r = sosfilt(sos_vocal, y_harm[1])
    vocals = np.vstack([vocal_l, vocal_r])
    
    # Drums is percussive
    drums = y_perc
    
    # Other is air & synths (high harmonic)
    sos_other = butter(2, 3500 / (sr / 2), btype='high', output='sos')
    other_l = sosfilt(sos_other, y_harm[0])
    other_r = sosfilt(sos_other, y_harm[1])
    other = np.vstack([other_l, other_r])
    
    sf.write(stem_files['bass'], bass.T, sr)
    sf.write(stem_files['drums'], drums.T, sr)
    sf.write(stem_files['vocals'], vocals.T, sr)
    sf.write(stem_files['other'], other.T, sr)
    
    # Explicit memory cleanup
    del y, y_harm, y_perc, bass, vocals, drums, other
    gc.collect()

    if progress_callback:
        progress_callback(1.0, "Stems ready!")
        
    return stem_files
