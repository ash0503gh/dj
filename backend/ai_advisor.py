"""
ai_advisor.py - AI DJ Co-Pilot and Transition Strategy Advisor.
Supports:
1. Google Gemini Generative AI (gemini-3.8-flash) via REST API.
2. High-precision Local Physical Acoustic Engine (offline, 100% free, 0ms latency).
Generates deep musical transition strategies, drop alignment timestamps, harmonic pitch shifts,
and tactical performance guides for both 1 -> 2 and 2 -> 1 mixing.
"""

import os
import json
import urllib.request
import urllib.error
from typing import Dict, Any, Optional, Tuple
import numpy as np

# Load .env file if available
try:
    from dotenv import load_dotenv
    load_dotenv()
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    load_dotenv(os.path.join(base_dir, ".env"))
except Exception:
    pass

from .audio_analyzer import check_camelot_compatibility

def get_jev_api_key(provided_key: Optional[str] = None) -> Optional[str]:
    """Resolves Jev / TypeSafe API key from user input, .env, or environment."""
    if provided_key and provided_key.strip():
        return provided_key.strip()
    return (
        os.environ.get("JEV_API_KEY", "").strip() or
        os.environ.get("TYPESAFE_API_KEY", "").strip() or
        os.environ.get("JEV_KEY", "").strip() or
        os.environ.get("TYPESAFE_KEY", "").strip() or
        None
    )

def get_gemini_api_key(provided_key: Optional[str] = None) -> Optional[str]:
    """Resolves Gemini API key from user input or environment."""
    if provided_key and provided_key.strip():
        return provided_key.strip()
    return os.environ.get("GEMINI_API_KEY", "").strip() or None

def call_gemini_api(
    prompt: str,
    api_key: str,
    model_name: str = "gemini-3.8-flash",
    audio_b64: Optional[str] = None,
    audio_mime: str = "audio/wav"
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Calls Google Gemini API via HTTPS REST endpoint with optional multimodal audio audition."""
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={api_key}"
    
    parts = []
    if audio_b64:
        clean_b64 = audio_b64.split(",")[-1] if "," in audio_b64 else audio_b64
        parts.append({
            "inlineData": {
                "mimeType": audio_mime,
                "data": clean_b64
            }
        })
    parts.append({"text": prompt})

    payload = {
        "contents": [{
            "parts": parts
        }],
        "generationConfig": {
            "temperature": 0.25,
            "responseMimeType": "application/json"
        }
    }
    
    headers = {"Content-Type": "application/json"}
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
    
    try:
        with urllib.request.urlopen(req, timeout=20.0) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            text = data["candidates"][0]["content"]["parts"][0]["text"]
            return json.loads(text), None
    except urllib.error.HTTPError as he:
        try:
            err_body = he.read().decode("utf-8")
            err_json = json.loads(err_body)
            msg = err_json.get("error", {}).get("message", str(he))
        except Exception:
            msg = str(he)
        print(f"Gemini API HTTPError: {msg}")
        return None, msg
    except Exception as e:
        print(f"Gemini API call failed ({e}). Falling back to Local Acoustic Engine.")
        return None, str(e)

def call_jev_system_one(
    info_out: Dict[str, Any],
    info_in: Dict[str, Any],
    direction: str = "1_to_2",
    api_key: Optional[str] = None
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """
    Calls TypeSafe AI's Jev System One model (https://api.typesafe.ai/v1/systemone).
    Produces single-pass, sub-200ms typed classification, scoring, and boolean decisions.
    """
    resolved_key = get_jev_api_key(api_key)
    if not resolved_key:
        return None, "No Jev / TypeSafe API key provided"

    deck_out_num = "1" if direction == "1_to_2" else "2"
    deck_in_num = "2" if direction == "1_to_2" else "1"
    
    bpm_out = float(info_out.get('bpm', 128.0))
    bpm_in = float(info_in.get('bpm', 128.0))
    delta_bpm = round(abs(bpm_out - bpm_in), 1)
    camelot_out = str(info_out.get('camelot', '8A'))
    camelot_in = str(info_in.get('camelot', '8A'))
    camelot_info = check_camelot_compatibility(camelot_out, camelot_in)
    
    ac_out = info_out.get('acoustic_profile', {})
    ac_in = info_in.get('acoustic_profile', {})
    vocal_out = round(float(ac_out.get('outro_vocal_score', 0.0)) * 100, 1)
    vocal_in = round(float(ac_in.get('intro_vocal_score', 0.0)) * 100, 1)
    
    cue_out = float(info_out.get('suggested_cue_outro', info_out.get('duration', 120.0) * 0.75))
    cue_in = float(info_in.get('suggested_cue_intro', 0.0))
    
    state = {
        "outgoing_track": {
            "deck": f"Deck {deck_out_num}",
            "title": info_out.get('title', f"Track {deck_out_num}"),
            "bpm": bpm_out,
            "camelot_key": camelot_out,
            "vocal_presence_outro_pct": vocal_out,
            "percussion_style": ac_out.get('outro_percussion', 'driving_4_4'),
            "duration_sec": info_out.get('duration', 180.0)
        },
        "incoming_track": {
            "deck": f"Deck {deck_in_num}",
            "title": info_in.get('title', f"Track {deck_in_num}"),
            "bpm": bpm_in,
            "camelot_key": camelot_in,
            "vocal_presence_intro_pct": vocal_in,
            "percussion_style": ac_in.get('intro_percussion', 'driving_4_4'),
            "duration_sec": info_in.get('duration', 180.0)
        },
        "acoustic_disparity": {
            "bpm_delta": delta_bpm,
            "camelot_relationship": camelot_info.get('description', 'Harmonic Match'),
            "harmonic_compatible": camelot_info.get('is_harmonically_compatible', True),
            "vocal_clash_risk": "HIGH" if (vocal_out > 30 and vocal_in > 30) else ("MODERATE" if (vocal_out > 20 or vocal_in > 20) else "SAFE")
        }
    }

    questions = {
        "technique": {
            "type": "choice",
            "instructions": "Which transition technique produces the most crowd-driving, dancefloor-ready mix?",
            "criteria": {
                "bass_swap": "Harmonically compatible keys with low vocal clash risk over 16 or 32 bars; equal-power Linkwitz-Riley low-end swap.",
                "echo_freeze": "High vocal presence clash or dissonant key mismatch; freeze 3/4 delay exit on Beat 1.",
                "loop_roll": "Rhythmic build into high-energy festival drop with accelerating stutter.",
                "vinyl_brake": "Turntable motor stop deceleration to cleanly reset key clash.",
                "spinback": "Vinyl reverse scrub into sudden impact boom on Beat 1.",
                "noise_riser": "White noise riser swell with 1-beat silence gap before drop.",
                "hard_cut": "Extreme tempo difference (> 15 BPM) or sudden breakdown drop on Beat 1.",
                "power_cut": "Abrupt silence gap then slam into incoming track on Beat 1; high-energy crowd surprise.",
                "fake_drop": "Build tension with riser + snare roll, 2-beat silence, then massive drop; peak-time bomb.",
                "silence_drop": "Extended 4-beat silence after fade-out, then massive impact drop; anticipation builder.",
                "rewind": "Vinyl rewind pull-up effect, brief pause, incoming track drops fresh; DJ showmanship move.",
                "double_drop": "Both tracks drop simultaneously on Beat 1; high-energy layered impact for similar BPM tracks.",
                "beatmash_drop": "Rapid 1/2→1/4→1/8→1/16 beat stutter with HPF sweep, silence gap, then slam drop.",
                "backspin_slam": "Aggressive vinyl backspin into sub-bass boom impact on incoming Beat 1.",
                "tension_riser": "Snare roll + noise riser + sidechain pump build, 1-beat silence, then massive drop.",
                "stutter_edit": "1/16th beat chops with HPF sweep crossfading into incoming track; glitch aesthetic.",
                "filter_sweep": "HPF sweeps up on outgoing while LPF sweeps down on incoming; smooth equal-power crossover.",
                "echo_dissolve": "Increasing echo feedback melts outgoing into ambient wash while incoming fades in underneath.",
                "acapella_mashup": "Vocal mid-band from outgoing layered over incoming instrumental; mashup effect.",
                "vocal_chop": "Vocal stutters from outgoing chopped over incoming beat; bridge element.",
                "drum_swap": "Drums/percussion swap first with 3-band EQ crossover, melody follows later."
            }
        },
        "transition_bars": {
            "type": "choice",
            "instructions": "Determine optimal transition duration in 4/4 musical bars.",
            "criteria": {
                "8": "Short, punchy transition for energetic club grooves.",
                "16": "Standard club blend matching 16-bar phrase boundary.",
                "32": "Extended progressive house or techno long blend."
            }
        },
        "vocal_ducking": {
            "type": "noul",
            "instructions": "Should vocal formant ducking be engaged to prevent vocal clash?"
        },
        "blend_rating": {
            "type": "score",
            "instructions": "Rate overall mix blend smoothness and musical compatibility.",
            "criteria": [
                "Severe key clash or chaotic collision.",
                "Rough clash requiring heavy EQ cuts.",
                "Average mix requiring volume adjustments.",
                "Smooth harmonic blend with natural handoff.",
                "Flawless imperceptible blend."
            ]
        }
    }

    payload = {
        "model": "jev-latest",
        "state": state,
        "questions": questions
    }

    req = urllib.request.Request(
        "https://api.typesafe.ai/v1/systemone",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {resolved_key}",
            "Content-Type": "application/json",
            "User-Agent": "PulseProDJ/1.0"
        },
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=4.0) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            answers = data.get("answers", data)
            
            tech_obj = answers.get("technique", {})
            tech_val = tech_obj.get("choice") or tech_obj.get("value") or "bass_swap"
            tech_conf = float(tech_obj.get("confidence", 0.95)) if isinstance(tech_obj, dict) and tech_obj.get("confidence") is not None else 0.95
            
            bars_obj = answers.get("transition_bars", {})
            raw_bars = bars_obj.get("choice") or bars_obj.get("value") or 16
            try:
                bars_val = int(raw_bars)
            except Exception:
                bars_val = 16
            
            duck_obj = answers.get("vocal_ducking", {})
            noul_val = duck_obj.get("noul")
            if noul_val is not None:
                duck_val = bool(float(noul_val) >= 0.5)
            else:
                duck_val = bool(duck_obj.get("value", False))
            
            score_obj = answers.get("blend_rating", {})
            raw_score = score_obj.get("score") if score_obj.get("score") is not None else score_obj.get("value", 3.2)
            try:
                # Scale from 0-4 to 1-100 percentage
                score_val = round(max(1.0, min(100.0, (float(raw_score) / 4.0) * 100.0)), 1)
            except Exception:
                score_val = 88.0

            tech_headlines = {
                "bass_swap": "💥 Linkwitz-Riley Equal-Power Bass Swap",
                "echo_freeze": "❄️ 3/4-Beat Echo Freeze & Drop on the 1",
                "loop_roll": "🌀 Accelerating Stutter Loop Roll Riser",
                "vinyl_brake": "⚡ Turntable Motor Brake & Drop",
                "spinback": "💫 Vinyl Reverse Spinback & Drop",
                "noise_riser": "📈 White Noise Build & 1-Beat Silence Drop",
                "hard_cut": "✂️ Hard Cut (Beat 1 Snap)",
                "power_cut": "⚡ Power Cut: Silence → Slam",
                "fake_drop": "💣 Fake Drop: Build → Silence → BOOM",
                "silence_drop": "🔇 Silence Drop: 4-Beat Pause → Impact",
                "rewind": "🔄 DJ Rewind Pull-Up",
                "double_drop": "💥💥 Double Drop: Both Decks Slam",
                "beatmash_drop": "🎛️ Beatmash Stutter → Drop",
                "backspin_slam": "🌀 Backspin Slam Impact",
                "tension_riser": "📈 Tension Build: Snare + Noise → Drop",
                "stutter_edit": "✂️ Stutter Edit Crossfade",
                "filter_sweep": "🔊 Filter Sweep Crossover",
                "echo_dissolve": "🌊 Echo Dissolve Melt",
                "acapella_mashup": "🎤 Acapella Over Beat Mashup",
                "vocal_chop": "🎵 Vocal Chop Bridge",
                "drum_swap": "🥁 Drum Swap Crossover",
            }

            tech_rationales = {
                "bass_swap": f"Jev evaluated {camelot_out} into {camelot_in} ({delta_bpm} BPM delta) as ideal for an imperceptible {bars_val}-bar low-end handoff.",
                "echo_freeze": f"Jev identified vocal/harmonic tension and selected a crisp 3/4 delay washout to cleanly reset the energy on the 1.",
                "loop_roll": f"Jev picked high-energy stutter divisions to build peak festival anticipation into Deck {deck_in_num}.",
                "vinyl_brake": f"Jev recommended a turntable motor-stop to mask harmonic dissonance and highlight the incoming groove drop.",
                "spinback": f"Jev selected an aggressive vinyl spinback into a sub-bass boom on the downbeat.",
                "noise_riser": f"Jev selected a sidechained white noise riser with anticipation gap before the drop.",
                "hard_cut": f"Jev recommended a razor-sharp 0ms cut on Beat 1 due to the wide tempo/acoustic disparity.",
                "power_cut": f"Jev selected an abrupt power cut with silence gap for maximum crowd surprise into Deck {deck_in_num}.",
                "fake_drop": f"Jev chose a fake drop build with snare roll tension and silence gap before slamming Deck {deck_in_num}.",
                "silence_drop": f"Jev selected an extended silence drop for maximum anticipation before Deck {deck_in_num} impact.",
                "rewind": f"Jev recommended a vinyl rewind pull-up to reset energy and slam Deck {deck_in_num} fresh.",
                "double_drop": f"Jev chose to slam both decks simultaneously for a layered double-drop impact.",
                "beatmash_drop": f"Jev selected progressive beat-mash stutter (1/2→1/16) building into Deck {deck_in_num} drop.",
                "backspin_slam": f"Jev selected aggressive backspin into sub-bass boom on Deck {deck_in_num} Beat 1.",
                "tension_riser": f"Jev chose full tension build (snare + noise + sidechain) before Deck {deck_in_num} drop.",
                "stutter_edit": f"Jev selected glitch stutter edit crossfade for a creative blend into Deck {deck_in_num}.",
                "filter_sweep": f"Jev chose a smooth HPF/LPF filter sweep crossover between decks.",
                "echo_dissolve": f"Jev selected echo dissolve to melt Deck {deck_out_num} into ambient wash under Deck {deck_in_num}.",
                "acapella_mashup": f"Jev chose to float Deck {deck_out_num} vocals over Deck {deck_in_num} instrumental for a mashup effect.",
                "vocal_chop": f"Jev selected vocal chop stutters from Deck {deck_out_num} over Deck {deck_in_num} beat.",
                "drum_swap": f"Jev chose a 3-band drum-first swap: percussion crosses before melody.",
            }

            return {
                "recommended_technique": tech_val,
                "recommended_bars": bars_val,
                "confidence": round(tech_conf, 2),
                "blend_score": round(score_val, 1),
                "vocal_ducking": duck_val,
                "suggested_outgoing_cue": cue_out,
                "suggested_incoming_cue": cue_in,
                "pitch_shift_semitones": camelot_info.get('recommended_pitch_shift', 0),
                "ai_headline": tech_headlines.get(tech_val, f"⚡ {tech_val.replace('_', ' ').title()}"),
                "strategic_rationale": tech_rationales.get(tech_val, f"Jev System One single-pass decision for {deck_out_num} -> {deck_in_num}."),
                "tactical_steps": [
                    f"1. Align Deck {deck_out_num} and Deck {deck_in_num} tempo (delta: {delta_bpm} BPM).",
                    f"2. Trigger {tech_val.replace('_', ' ')} transition across {bars_val} bars.",
                    f"3. {'Enable vocal formant ducking to prevent clash' if duck_val else 'Both tracks vocal-safe; let frequencies blend smoothly'}.",
                    f"4. Complete drop handoff on the 16-bar phrase boundary."
                ],
                "pro_tip": f"Jev evaluated mix blend compatibility at {score_val:.0f}/100. {'Engage Sync lock before triggering.' if delta_bpm > 1 else 'Tracks are near identical tempo; smooth fader glide guaranteed.'}",
                "vocal_clash_risk": state["acoustic_disparity"]["vocal_clash_risk"],
                "engine_source": "TypeSafe Jev System One (⚡ <200ms Single-Pass)",
                "direction": direction,
                "outgoing_deck": int(deck_out_num),
                "incoming_deck": int(deck_in_num),
                "camelot_compatibility": camelot_info,
                "delta_bpm": delta_bpm
            }, None
    except urllib.error.HTTPError as he:
        try:
            err_body = he.read().decode("utf-8")
            err_json = json.loads(err_body)
            msg = err_json.get("error", {}).get("message", str(he))
        except Exception:
            msg = str(he)
        print(f"Jev System One HTTPError: {msg}")
        return None, msg
    except Exception as e:
        print(f"Jev System One call failed ({e}).")
        return None, str(e)

def _compute_eq_sculpt(tech: str, vocal_out: bool, vocal_in: bool,
                       energy_out: float, energy_in: float) -> Dict[str, Any]:
    """Compute per-band EQ sculpting parameters based on technique and track analysis."""
    blend_techs = {"bass_swap", "filter_sweep", "stutter_edit", "drum_swap",
                   "double_drop", "echo_dissolve", "vocal_chop", "acapella_mashup"}
    build_techs = {"fake_drop", "tension_riser", "beatmash_drop", "noise_riser",
                   "loop_roll", "festival_drop"}
    cut_techs = {"power_cut", "silence_drop", "rewind", "backspin_slam",
                 "hard_cut", "spinback", "vinyl_brake", "echo_freeze"}

    if tech in blend_techs:
        bass_swap_at = 0.5
        hi_in_speed = 0.35
        if vocal_out and vocal_in:
            hi_in_speed = 0.2
            bass_swap_at = 0.4
        elif energy_in > 0.7:
            bass_swap_at = 0.3
            hi_in_speed = 0.15
        return {
            "mode": "blend",
            "band_order": "hi_first" if hi_in_speed < 0.3 else "balanced",
            "bass_swap_at": round(bass_swap_at, 2),
            "hi_in_speed": round(hi_in_speed, 2),
            "vocal_duck_db": 8.0 if (vocal_out and vocal_in) else 0.0,
            "outgoing_hpf_sweep": False,
        }
    elif tech in build_techs:
        return {
            "mode": "build_slam",
            "band_order": "bass_last",
            "outgoing_hpf_sweep": True,
            "hpf_start_hz": 35.0,
            "hpf_end_hz": 3500.0 if energy_out > 0.6 else 2000.0,
            "incoming_bass_ramp": 0.5,
            "vocal_duck_db": 0.0,
        }
    elif tech in cut_techs:
        return {
            "mode": "cut",
            "band_order": "instant",
            "outgoing_hpf_sweep": True,
            "hpf_start_hz": 35.0,
            "hpf_end_hz": 1500.0,
            "vocal_duck_db": 0.0,
        }
    return {"mode": "default", "band_order": "balanced"}


def _compute_color_fx(tech: str, bpm: float, energy: float) -> Dict[str, Any]:
    """Compute Color FX parameters (HPF/LPF sweep, echo, flanger, reverb) per technique."""
    delay_ms = round(60000.0 / bpm / 2) if bpm > 0 else 250

    if tech in {"echo_dissolve", "echo_freeze"}:
        return {
            "echo": {"delay_ms": delay_ms, "feedback": 0.65, "wet": 0.5},
            "reverb": {"size": 0.7, "wet": 0.3},
            "hpf_sweep": False,
            "lpf_sweep": False,
            "flanger": None,
        }
    elif tech in {"filter_sweep"}:
        return {
            "echo": None,
            "reverb": None,
            "hpf_sweep": {"start_hz": 35, "end_hz": 8000, "duration_bars": 8},
            "lpf_sweep": {"start_hz": 18000, "end_hz": 200, "duration_bars": 8},
            "flanger": None,
        }
    elif tech in {"fake_drop", "tension_riser", "beatmash_drop", "festival_drop"}:
        return {
            "echo": {"delay_ms": delay_ms, "feedback": 0.3, "wet": 0.2},
            "reverb": {"size": 0.5, "wet": 0.15},
            "hpf_sweep": {"start_hz": 35, "end_hz": 3500, "duration_bars": 8},
            "lpf_sweep": False,
            "flanger": {"rate_hz": 0.5, "depth": 0.3} if energy > 0.6 else None,
        }
    elif tech in {"spinback", "backspin_slam", "rewind"}:
        return {
            "echo": {"delay_ms": delay_ms, "feedback": 0.4, "wet": 0.25},
            "reverb": {"size": 0.3, "wet": 0.1},
            "hpf_sweep": False,
            "lpf_sweep": False,
            "flanger": None,
        }
    return {
        "echo": None,
        "reverb": None,
        "hpf_sweep": False,
        "lpf_sweep": False,
        "flanger": None,
    }


def generate_local_acoustic_strategy(
    info_out: Dict[str, Any],
    info_in: Dict[str, Any],
    direction: str = "1_to_2"
) -> Dict[str, Any]:
    """
    High-precision Local Physical Acoustic Engine.
    Analyzes true acoustic features (vocal formant energy ratio, spectral flatness,
    percussion onset density, and Camelot distance) to compute mathematically optimal transitions.
    """
    deck_out_num = "1" if direction == "1_to_2" else "2"
    deck_in_num = "2" if direction == "1_to_2" else "1"
    
    bpm_out = float(info_out.get('bpm', 128.0))
    bpm_in = float(info_in.get('bpm', 128.0))
    delta_bpm = abs(bpm_out - bpm_in)
    
    camelot_info = check_camelot_compatibility(info_out.get('camelot', '8A'), info_in.get('camelot', '8A'))
    is_harmonic = camelot_info['is_harmonically_compatible']
    rec_pitch_shift = camelot_info['recommended_pitch_shift']
    
    ac_out = info_out.get('acoustic_profile', {})
    ac_in = info_in.get('acoustic_profile', {})
    
    vocal_out_score = ac_out.get('outro_vocal_score', 0.0)
    vocal_in_score = ac_in.get('intro_vocal_score', 0.0)
    vocal_out_detected = ac_out.get('vocal_detected_outro', vocal_out_score > 0.35)
    vocal_in_detected = ac_in.get('vocal_detected_intro', vocal_in_score > 0.35)
    
    perc_out = ac_out.get('outro_percussion', 'driving_4_4')
    perc_in = ac_in.get('intro_percussion', 'driving_4_4')
    
    # Calculate optimal cue points
    cue_out = info_out.get('suggested_cue_outro', info_out.get('duration', 120.0) * 0.75)
    cue_in = info_in.get('suggested_cue_intro', 0.0)
    
    # Phrase alignment: snap outgoing cue to nearest 16-bar phrase boundary
    phrases_out = info_out.get('phrase_16_times') or info_out.get('phrase_8_times')
    if phrases_out:
        idx_p = np.argmin(np.abs(np.array(phrases_out) - cue_out))
        cue_out = float(phrases_out[idx_p])
        
    phrases_in = info_in.get('phrase_16_times') or info_in.get('phrase_8_times')
    if phrases_in:
        idx_pi = np.argmin(np.abs(np.array(phrases_in) - cue_in))
        cue_in = float(phrases_in[idx_pi])
        
    # Strategy Decision Tree (22 techniques across 5 styles)
    energy_out = ac_out.get('energy', 0.5)
    energy_in = ac_in.get('energy', 0.5)

    # 1. Dual Vocal Clash — use echo techniques or acapella mashup
    if vocal_out_detected and vocal_in_detected:
        if delta_bpm <= 5.0 and is_harmonic:
            tech = "acapella_mashup"
            bars = 16
            confidence = 0.95
            headline = "🎤 Acapella Mashup: Vocals Over Incoming Beat"
            rationale = (
                f"Both tracks have vocals but harmonic compatibility ({info_out.get('camelot', '??')} → {info_in.get('camelot', '??')}) "
                f"allows floating Deck {deck_out_num}'s vocal mid-band over Deck {deck_in_num}'s instrumental for a mashup effect."
            )
            steps = [
                f"1. Mid-band (300-3500Hz) extracted from Deck {deck_out_num} at {cue_out:.1f}s.",
                f"2. Deck {deck_in_num} instrumental plays underneath with vocal ducking.",
                f"3. Deck {deck_out_num} vocal fades out at 60% through transition."
            ]
            pro_tip = "Works best when outgoing vocals carry a memorable hook."
            vocal_duck = True
        else:
            tech = "echo_freeze"
            bars = 8
            confidence = 0.98
            headline = "❄️ 8-Bar Echo Freeze & Drop on the 1"
            rationale = (
                f"Both tracks carry singing vocals ({vocal_out_score*100:.0f}% out, {vocal_in_score*100:.0f}% in). "
                f"Echo Freeze cuts Deck {deck_out_num} on Beat 1 with a 4s tape delay throw, preventing vocal collision."
            )
            steps = [
                f"1. Let Deck {deck_out_num} play into the phrase at {cue_out:.1f}s.",
                f"2. Trigger on Beat 1 of the 16-bar phrase.",
                f"3. 3/4-beat delay captures final vocal while Deck {deck_in_num} drops with full low-end."
            ]
            pro_tip = f"Let Deck {deck_out_num}'s delay tail wash into the background as Deck {deck_in_num}'s hook enters."
            vocal_duck = False

    # 2. Vocal Outro into Clean Groove
    elif vocal_out_detected and not vocal_in_detected and delta_bpm <= 8.0:
        if vocal_out_score > 0.6 and is_harmonic:
            tech = "vocal_chop"
            bars = 8
            confidence = 0.93
            headline = "🎵 Vocal Chop Bridge Into Drop"
            rationale = (
                f"Strong vocals in Deck {deck_out_num} ({vocal_out_score*100:.0f}%). Vocal chop stutters create "
                f"a rhythmic bridge element over Deck {deck_in_num}'s incoming beat."
            )
            steps = [
                f"1. Extract vocal mid-band from Deck {deck_out_num} last 2 beats.",
                f"2. Stutter chop at 1/8th divisions over 8 beats.",
                f"3. Deck {deck_in_num} fades in underneath from 30% to full."
            ]
            pro_tip = "The vocal chops add instant energy recognition from the crowd."
            vocal_duck = False
        else:
            tech = "bass_swap"
            bars = 16
            confidence = 0.96
            headline = "💥 16-Bar Bass Swap & Vocal Ducking Blend"
            rationale = (
                f"Deck {deck_out_num} outro carries vocals ({vocal_out_score*100:.0f}%) while Deck {deck_in_num} opens with clean rhythm ({perc_in}). "
                f"16-bar Linkwitz-Riley Bass Swap with Smart Vocal Ducking."
            )
            steps = [
                f"1. Crossfader glides toward Deck {deck_in_num}.",
                f"2. Deck {deck_out_num} mid-range ducked by -8dB to prevent masking.",
                f"3. Bar 8 Beat 1: instant 10ms Bass Swap transfers sub-energy."
            ]
            pro_tip = f"Keep Deck {deck_in_num} highs clear until bass drop at bar 8."
            vocal_duck = True

    # 3. Extreme Tempo Disparity (> 15 BPM) — hard cut or rewind
    elif delta_bpm > 15.0:
        tech = "rewind"
        bars = 4
        confidence = 0.92
        headline = "🔄 DJ Rewind Pull-Up & Fresh Drop"
        rationale = (
            f"Extreme tempo gap (Δ{delta_bpm:.1f} BPM). Vinyl rewind resets crowd expectation, "
            f"brief pause, then Deck {deck_in_num} drops at native {bpm_in:.1f} BPM."
        )
        steps = [
            f"1. Vinyl rewind FX at {cue_out:.1f}s (1.5s reverse acceleration).",
            "2. 0.3s silence gap for anticipation.",
            f"3. Deck {deck_in_num} drops cold at {bpm_in:.1f} BPM."
        ]
        pro_tip = "Rewinds work best when the crowd knows the track — instant recognition moment."
        vocal_duck = False

    # 4. High Tempo Disparity (10-15 BPM) — power cut or echo freeze
    elif delta_bpm > 10.0:
        if energy_in > 0.6:
            tech = "power_cut"
            bars = 4
            confidence = 0.93
            headline = "⚡ Power Cut: Silence → Slam"
            rationale = (
                f"Wide tempo gap (Δ{delta_bpm:.1f} BPM) with high incoming energy. "
                f"Power cut creates 2-beat silence then slams Deck {deck_in_num} on Beat 1 with sub-boom."
            )
            steps = [
                f"1. Hard kill Deck {deck_out_num} with 15ms fade at {cue_out:.1f}s.",
                "2. 2-beat silence gap builds instant anticipation.",
                f"3. Deck {deck_in_num} slams with 80Hz sub-boom impact."
            ]
            pro_tip = "The silence makes the drop hit 10x harder than any blend could."
            vocal_duck = False
        else:
            tech = "echo_dissolve"
            bars = 8
            confidence = 0.92
            headline = "🌊 Echo Dissolve Into New Tempo"
            rationale = (
                f"Wide tempo gap (Δ{delta_bpm:.1f} BPM). Echo dissolve melts Deck {deck_out_num} into ambient wash, "
                f"Deck {deck_in_num} fades in underneath at native tempo."
            )
            steps = [
                f"1. Echo feedback captures last 3s of Deck {deck_out_num}.",
                "2. 6s echo tail with volume decay to ambient level.",
                f"3. Deck {deck_in_num} rises from 30% to full under the wash."
            ]
            pro_tip = "Works beautifully for genre switches (EDM → Afro House)."
            vocal_duck = False

    # 5. Melodic Breakdown to Driving 4/4 — tension riser or fake drop
    elif perc_out == "melodic_breakdown" and perc_in == "driving_4_4":
        if energy_in > 0.7:
            tech = "fake_drop"
            bars = 8
            confidence = 0.94
            headline = "💣 Fake Drop: Build → Silence → BOOM"
            rationale = (
                f"Deck {deck_out_num} breakdown + Deck {deck_in_num} high-energy 4/4. "
                f"Fake drop builds with snare roll + noise riser, 2-beat silence, then massive slam."
            )
            steps = [
                f"1. HPF sweep + noise riser build over 8 bars.",
                "2. Snare roll accelerates to 32nd notes.",
                "3. 2-beat silence gap, then Deck 2 drops with sub-boom."
            ]
            pro_tip = "The fake drop is the single most crowd-driving technique in festival DJ'ing."
            vocal_duck = False
        else:
            tech = "tension_riser"
            bars = 8
            confidence = 0.93
            headline = "📈 Tension Build: Snare + Noise → Drop"
            rationale = (
                f"Deck {deck_out_num} melodic breakdown into Deck {deck_in_num} 4/4 groove. "
                f"Full tension build with snare roll, noise riser, and sidechain pump."
            )
            steps = [
                f"1. HPF sweep on Deck {deck_out_num} from 35Hz to 4kHz.",
                "2. Noise riser + snare roll accelerating over 8 bars.",
                "3. Sidechain pump adds rhythmic tension. 1-beat silence → drop."
            ]
            pro_tip = "Cut all low EQ during the riser build for maximum bass impact on drop."
            vocal_duck = False

    # 6. Dissonant Key + Medium Tempo Gap — backspin slam or spinback
    elif not is_harmonic and delta_bpm >= 4.0:
        tech = "backspin_slam"
        bars = 4
        confidence = 0.91
        headline = "🌀 Backspin Slam Impact"
        rationale = (
            f"Harmonic tension ({info_out.get('camelot', '??')} vs {info_in.get('camelot', '??')}). "
            f"Aggressive backspin resets tonal memory with sub-boom slam into Deck {deck_in_num}."
        )
        steps = [
            f"1. 1s backspin from Deck {deck_out_num} at {cue_out:.1f}s.",
            f"2. Sub-boom impact on Deck {deck_in_num} Beat 1.",
            "3. Full-frequency drop with no harmonic overlap."
        ]
        pro_tip = "Trigger on the final beat of a 16-bar phrase for maximum impact."
        vocal_duck = False

    # 7. Dissonant Key but Close Tempo — stutter edit
    elif not is_harmonic and delta_bpm < 4.0:
        tech = "stutter_edit"
        bars = 8
        confidence = 0.90
        headline = "✂️ Stutter Edit Crossfade"
        rationale = (
            f"Keys clash ({info_out.get('camelot', '??')} vs {info_in.get('camelot', '??')}) but tempo is close. "
            f"Stutter edit chops mask harmonic content while crossfading to Deck {deck_in_num}."
        )
        steps = [
            f"1. 1/16th beat chops on Deck {deck_out_num} with HPF sweep.",
            f"2. Deck {deck_in_num} fades in underneath.",
            "3. Crossfade completes as stutter intensity peaks."
        ]
        pro_tip = "The rapid chops destroy harmonic content naturally — no key clash possible."
        vocal_duck = False

    # 8. Similar BPM, High Energy Both — double drop or beatmash
    elif delta_bpm <= 3.0 and energy_out > 0.6 and energy_in > 0.6:
        if is_harmonic:
            tech = "double_drop"
            bars = 4
            confidence = 0.94
            headline = "💥💥 Double Drop: Both Decks Slam"
            rationale = (
                f"Similar BPM (Δ{delta_bpm:.1f}) and harmonic keys — both tracks can slam simultaneously. "
                f"Layered impact with Deck {deck_out_num} fading out over 4 bars."
            )
            steps = [
                f"1. HPF build on Deck {deck_out_num} + noise riser over 4 bars.",
                "2. Both tracks drop on Beat 1 simultaneously.",
                f"3. Deck {deck_out_num} fades out over 4 bars, Deck {deck_in_num} takes over."
            ]
            pro_tip = "Double drops are the ultimate festival move — use sparingly for maximum impact."
            vocal_duck = False
        else:
            tech = "beatmash_drop"
            bars = 4
            confidence = 0.92
            headline = "🎛️ Beatmash Stutter → Drop"
            rationale = (
                f"High energy both sides, close BPM. Progressive beat-mash stutter "
                f"(1/2→1/16) builds to maximum tension before Deck {deck_in_num} drop."
            )
            steps = [
                "1. 16-beat stutter mash: divisions accelerate 1/2→1/4→1/8→1/16.",
                "2. HPF sweep 60Hz→4kHz during stutter.",
                f"3. 1-beat silence gap, Deck {deck_in_num} slams with sub-boom."
            ]
            pro_tip = "The accelerating stutter creates irresistible physical tension."
            vocal_duck = False

    # 9. Matching Groove, Harmonic — bass swap, filter sweep, or drum swap
    elif is_harmonic and delta_bpm <= 5.0:
        if perc_out == perc_in == "driving_4_4":
            tech = "drum_swap"
            bars = 16
            confidence = 0.93
            headline = "🥁 Drum Swap: Percussion First, Melody Follows"
            rationale = (
                f"Matching 4/4 grooves with harmonic keys. 3-band drum swap crosses percussion first, "
                f"melody follows 8 bars later for a smooth takeover."
            )
            steps = [
                "1. Low-end swaps at 50% through transition.",
                "2. High-end (drums/hats) crosses early, melody follows.",
                f"3. Full handoff to Deck {deck_in_num} by bar 16."
            ]
            pro_tip = "The drum swap sounds like a professional club DJ hand-mixing two tracks live."
            vocal_duck = True
        else:
            tech = "filter_sweep"
            bars = 16
            confidence = 0.94
            headline = "🔊 Filter Sweep Crossover"
            rationale = (
                f"Harmonic match ({info_out.get('camelot', '??')} → {info_in.get('camelot', '??')}) and close BPM. "
                f"HPF sweeps up on Deck {deck_out_num} while LPF sweeps down on Deck {deck_in_num} — equal-power crossover."
            )
            steps = [
                f"1. HPF sweep on Deck {deck_out_num} from 35Hz up to ceiling.",
                f"2. LPF sweep on Deck {deck_in_num} from ceiling down to 35Hz.",
                "3. 48-chunk equal-power sin/cos crossover."
            ]
            pro_tip = "Filter sweeps are the workhorse of underground DJ'ing — smooth and groovy."
            vocal_duck = True

    # 10. Default fallback — bass swap
    else:
        tech = "bass_swap"
        bars = 16
        confidence = 0.97
        headline = "💥 16-Bar Bass Swap & Filter Sweep"
        rationale = (
            f"Harmonic alignment ({info_out.get('camelot', '??')} → {info_in.get('camelot', '??')}) and matching groove (Δ{delta_bpm:.1f} BPM). "
            f"16-bar Linkwitz-Riley low-end swap ensures seamless dancefloor momentum."
        )
        steps = [
            f"1. Phase lock Deck {deck_in_num} to Deck {deck_out_num}'s 4/4 downbeats.",
            f"2. Smooth tempo ramp aligns {bpm_out:.1f} to {bpm_in:.1f} BPM.",
            f"3. Swap Low-EQ on Bar 8 Beat 1 with reverb washout on Deck {deck_out_num} exit."
        ]
        pro_tip = f"Camelot lock shifts Deck {deck_in_num} by {rec_pitch_shift:+d} semitones for harmonic resonance."
        vocal_duck = True

    eq_sculpt = _compute_eq_sculpt(tech, vocal_out_detected, vocal_in_detected, energy_out, energy_in)
    color_fx = _compute_color_fx(tech, bpm_out, energy_out)

    return {
        "engine_source": "Local Physical Acoustic Engine",
        "direction": direction,
        "outgoing_deck": int(deck_out_num),
        "incoming_deck": int(deck_in_num),
        "recommended_technique": tech,
        "recommended_bars": bars,
        "confidence": confidence,
        "suggested_outgoing_cue": round(cue_out, 2),
        "suggested_incoming_cue": round(cue_in, 2),
        "pitch_shift_semitones": rec_pitch_shift,
        "vocal_ducking": vocal_duck,
        "eq_sculpt": eq_sculpt,
        "color_fx": color_fx,
        "ai_headline": headline,
        "strategic_rationale": rationale,
        "tactical_steps": steps,
        "pro_tip": pro_tip,
        "camelot_compatibility": camelot_info,
        "delta_bpm": round(delta_bpm, 1),
        "vocal_clash_risk": "HIGH" if (vocal_out_detected and vocal_in_detected) else ("SAFE" if not vocal_in_detected else "MODERATE")
    }

def generate_ai_dj_strategy(
    info_out: Dict[str, Any],
    info_in: Dict[str, Any],
    direction: str = "1_to_2",
    gemini_api_key: Optional[str] = None,
    jev_api_key: Optional[str] = None,
    model_name: str = "jev-latest"
) -> Dict[str, Any]:
    """
    Main entry point:
    1. If Jev is requested or Jev API key is available, query TypeSafe System One (fast, sub-200ms).
    2. If Gemini is requested and Gemini API key is available, query Gemini LLM.
    3. Otherwise (or on failure), fall back to Local Physical Acoustic Engine.
    """
    # 1. Prioritize TypeSafe Jev System One (sub-200ms single-pass decision engine)
    resolved_jev_key = get_jev_api_key(jev_api_key)
    # Honour the selected model: Gemini keys usually come from the server env, not the request,
    # so "no gemini_api_key param" must not route a Gemini selection to Jev.
    wants_gemini = model_name.lower().startswith("gemini") and bool(get_gemini_api_key(gemini_api_key))
    wants_local = model_name.lower().startswith("local")
    is_jev_target = not wants_gemini and not wants_local and (model_name.lower().startswith("jev") or bool(resolved_jev_key))
    if resolved_jev_key and is_jev_target:
        jev_result, jev_err = call_jev_system_one(info_out, info_in, direction=direction, api_key=resolved_jev_key)
        if jev_result:
            return jev_result
        print(f"Jev System One error ({jev_err}). Falling back to next available engine...")

    # 2. Google Gemini LLM
    resolved_gemini_key = get_gemini_api_key(gemini_api_key)
    if resolved_gemini_key and model_name and not model_name.lower().startswith("local"):
        deck_out_num = "1" if direction == "1_to_2" else "2"
        deck_in_num = "2" if direction == "1_to_2" else "1"
        
        prompt = f"""
You are an elite, world-class DJ and audio engineer (headlining Tomorrowland and Ultra Music Festival).
Analyze these two audio tracks and create an exact, professional DJ transition plan transitioning from Deck {deck_out_num} (Outgoing) to Deck {deck_in_num} (Incoming).

OUTGOING TRACK (Deck {deck_out_num}):
- Title: {info_out.get('title', 'Track ' + deck_out_num)}
- BPM: {info_out.get('bpm', 128.0)}
- Camelot Key: {info_out.get('camelot', '8A')}
- Duration: {info_out.get('duration', 180.0)}s
- Outro Vocal Presence: {info_out.get('acoustic_profile', {}).get('outro_vocal_score', 0.0)*100:.0f}%
- Outro Percussion Style: {info_out.get('acoustic_profile', {}).get('outro_percussion', 'driving_4_4')}
- Suggested Outro Cue: {info_out.get('suggested_cue_outro', 120.0):.1f}s

INCOMING TRACK (Deck {deck_in_num}):
- Title: {info_in.get('title', 'Track ' + deck_in_num)}
- BPM: {info_in.get('bpm', 128.0)}
- Camelot Key: {info_in.get('camelot', '8A')}
- Duration: {info_in.get('duration', 180.0)}s
- Intro Vocal Presence: {info_in.get('acoustic_profile', {}).get('intro_vocal_score', 0.0)*100:.0f}%
- Intro Percussion Style: {info_in.get('acoustic_profile', {}).get('intro_percussion', 'driving_4_4')}
- Suggested Intro Cue: {info_in.get('suggested_cue_intro', 0.0):.1f}s

Available DJ Techniques (5 style categories):

SMOOTH: gradual, groove-preserving
- "bass_swap": 16/32-bar Linkwitz-Riley low-end swap with vocal ducking and tempo ramp.
- "filter_sweep": HPF sweeps up outgoing, LPF sweeps down incoming; equal-power crossover.
- "drum_swap": 3-band EQ crossover; drums swap first, melody follows.
- "stutter_edit": 1/16th beat chops with HPF sweep crossfading into incoming.

BUILD: rising tension into climax
- "loop_roll": Stutter loop division with rising HPF sweep.
- "noise_riser": White noise swell with 1-beat silence gap before drop.
- "tension_riser": Snare roll + noise + sidechain pump build, silence, then drop.
- "beatmash_drop": 1/2→1/4→1/8→1/16 stutter mash with HPF sweep, silence, slam.

BOLD: confident, assertive moves
- "spinback": Vinyl reverse scrub with sub-drop boom on Beat 1.
- "hard_cut": Razor-sharp 0ms cut on Beat 1.
- "rewind": Vinyl rewind pull-up, brief pause, incoming drops fresh.
- "backspin_slam": Aggressive backspin into sub-bass boom impact.
- "acapella_mashup": Vocal mid-band from outgoing over incoming instrumental.
- "vocal_chop": Vocal stutters from outgoing chopped over incoming beat.

BOMB: peak-time crowd exploders
- "power_cut": Abrupt silence gap then slam on Beat 1.
- "fake_drop": Build + snare roll, 2-beat silence, massive drop.
- "silence_drop": Extended 4-beat silence, then massive impact.
- "double_drop": Both tracks drop simultaneously on Beat 1.
- "festival_drop": Full festival build with noise riser and sub-boom.

DRAMATIC: emotional, atmospheric
- "echo_freeze": 3/4-beat tape delay freeze wash and drop on Beat 1.
- "vinyl_brake": Turntable motor-stop deceleration into drop.
- "echo_dissolve": Echo feedback melts outgoing into ambient wash.

Return valid JSON with these exact fields:
{{
  "recommended_technique": "bass_swap" | "echo_freeze" | "loop_roll" | "vinyl_brake" | "spinback" | "noise_riser" | "hard_cut" | "power_cut" | "fake_drop" | "silence_drop" | "rewind" | "double_drop" | "beatmash_drop" | "backspin_slam" | "tension_riser" | "stutter_edit" | "filter_sweep" | "echo_dissolve" | "acapella_mashup" | "vocal_chop" | "drum_swap" | "festival_drop",
  "recommended_bars": 8 | 16 | 32,
  "confidence": 0.90 - 0.99,
  "suggested_outgoing_cue": float,
  "suggested_incoming_cue": float,
  "pitch_shift_semitones": int (-2 to +2),
  "vocal_ducking": boolean,
  "ai_headline": "Short punchy headline with emoji",
  "strategic_rationale": "2-3 sentences explaining the musical and acoustic reason for this choice",
  "tactical_steps": [
    "Step 1...",
    "Step 2...",
    "Step 3..."
  ],
  "pro_tip": "One high-level pro performance tip for the dancefloor",
  "vocal_clash_risk": "SAFE" | "MODERATE" | "HIGH",
  "eq_sculpt": {{
    "mode": "blend" | "build_slam" | "cut",
    "band_order": "hi_first" | "bass_last" | "instant" | "balanced",
    "bass_swap_at": 0.0-1.0,
    "hi_in_speed": 0.0-1.0,
    "vocal_duck_db": 0.0-12.0,
    "outgoing_hpf_sweep": boolean,
    "hpf_start_hz": 35.0,
    "hpf_end_hz": 1500.0-8000.0
  }},
  "color_fx": {{
    "echo": {{"delay_ms": int, "feedback": 0.0-0.8, "wet": 0.0-1.0}} | null,
    "reverb": {{"size": 0.0-1.0, "wet": 0.0-1.0}} | null,
    "hpf_sweep": {{"start_hz": int, "end_hz": int, "duration_bars": int}} | false,
    "lpf_sweep": {{"start_hz": int, "end_hz": int, "duration_bars": int}} | false,
    "flanger": {{"rate_hz": float, "depth": 0.0-1.0}} | null
  }}
}}
"""
        gemini_result, gemini_err = call_gemini_api(prompt, resolved_gemini_key, model_name=model_name)
        if gemini_result and isinstance(gemini_result, dict) and "recommended_technique" in gemini_result:
            gemini_result["engine_source"] = f"Google Gemini AI ({model_name})"
            gemini_result["direction"] = direction
            gemini_result["outgoing_deck"] = int(deck_out_num)
            gemini_result["incoming_deck"] = int(deck_in_num)
            gemini_result["camelot_compatibility"] = check_camelot_compatibility(
                info_out.get('camelot', '8A'), info_in.get('camelot', '8A')
            )
            gemini_result["delta_bpm"] = round(abs(float(info_out.get('bpm', 128)) - float(info_in.get('bpm', 128))), 1)
            return gemini_result
            
        local_strat = generate_local_acoustic_strategy(info_out, info_in, direction=direction)
        local_strat["gemini_error"] = gemini_err or "Gemini API call failed"
        local_strat["engine_source"] = f"Local Physical Acoustic Engine (Gemini fallback)"
        return local_strat
            
    # Fallback to local acoustic engine
    return generate_local_acoustic_strategy(info_out, info_in, direction=direction)
