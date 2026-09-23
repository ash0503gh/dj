"""
jev_blueprint.py - Jev Autonomous DJ Brain Pipeline & Blueprint Compiler.

Runs a 3-4 call decision pipeline against TypeSafe Jev System One,
producing a complete TransitionBlueprint JSON with keyframe arrays
that the frontend executor reads directly.

Key Enhancements:
- Crossfader locked permanently at 50% (channel fader-only mixing)
- Automatic Hot Cue targeting (Cue 1 Intro, Cue 2 Breakdown, Cue 3 Drop, Cue 4 Outro)
- 4-Stem isolation mashup (drums, bass, vocals, melody)
- Turntable pitch bends (vinyl slowdown, rising pitch ramp, tape stop)
- Flanger & Beat-masher DSP modulation
"""

import json
import math
import os
import time
import urllib.request
import urllib.error
from typing import Dict, Any, Optional, Tuple

from .ai_advisor import get_jev_api_key
from .audio_analyzer import check_camelot_compatibility


# ═══════════════════════════════════════════════════════════════
# GENERIC JEV API CALLER
# ═══════════════════════════════════════════════════════════════

def call_jev_batch(
    state: dict,
    questions: dict,
    api_key: str,
    timeout: float = 5.0
) -> Tuple[Optional[dict], Optional[str]]:
    """
    Calls TypeSafe Jev System One with arbitrary batched questions.
    Returns (answers_dict, error_string_or_None).
    """
    payload = {
        "model": "jev-latest",
        "state": state,
        "questions": questions
    }
    req = urllib.request.Request(
        "https://api.typesafe.ai/v1/systemone",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "PulseProDJ/2.0-Blueprint"
        },
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("answers", data), None
    except urllib.error.HTTPError as he:
        try:
            err_body = he.read().decode("utf-8")
            err_json = json.loads(err_body)
            msg = err_json.get("error", {}).get("message", str(he))
        except Exception:
            msg = str(he)
        return None, msg
    except Exception as e:
        return None, str(e)


# ═══════════════════════════════════════════════════════════════
# ANSWER PARSERS
# ═══════════════════════════════════════════════════════════════

def _parse_noul(answers: dict, key: str, default: bool = False) -> bool:
    obj = answers.get(key, {})
    if not isinstance(obj, dict):
        return default
    noul_val = obj.get("noul")
    if noul_val is not None:
        return float(noul_val) >= 0.5
    return bool(obj.get("value", default))


def _parse_choice(answers: dict, key: str, default: str = "") -> str:
    obj = answers.get(key, {})
    if not isinstance(obj, dict):
        return default
    return str(obj.get("choice") or obj.get("value") or default)


def _parse_score(answers: dict, key: str, default: float = 2.0, scale: int = 4) -> float:
    obj = answers.get(key, {})
    if not isinstance(obj, dict):
        return default
    raw = obj.get("score") if obj.get("score") is not None else obj.get("value", default)
    try:
        return max(0.0, min(float(scale), float(raw)))
    except Exception:
        return default


def _parse_score_norm(answers: dict, key: str, default: float = 0.5) -> float:
    """Parse score and normalize to 0.0-1.0 range (4-point scale)."""
    return _parse_score(answers, key, default * 4.0) / 4.0


def _safe_float(val: Any, default: float = 0.0) -> float:
    """Safely converts any value to float, handling None, NaN, inf, and invalid types."""
    if val is None:
        return default
    try:
        f = float(val)
        return default if (math.isnan(f) or math.isinf(f)) else f
    except (ValueError, TypeError):
        return default


def _lerp(a: float, b: float, t: float) -> float:
    """Linear interpolation between a and b."""
    return a + (b - a) * max(0.0, min(1.0, t))


# ═══════════════════════════════════════════════════════════════
# JEV DECISION PIPELINE (3-4 CHAINED CALLS)
# ═══════════════════════════════════════════════════════════════

def run_jev_pipeline(
    profile_out: Dict[str, Any],
    profile_in: Dict[str, Any],
    api_key: str
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """
    Runs the full 3-4 call Jev decision pipeline and compiles the blueprint.
    Returns (blueprint_dict, error_string_or_None).
    """
    t0 = time.time()

    # ─── Build rich state from both track profiles safely ───
    bpm_out = _safe_float(profile_out.get("bpm"), 128.0)
    bpm_in = _safe_float(profile_in.get("bpm"), 128.0)
    delta_bpm = round(abs(bpm_out - bpm_in), 1)
    camelot_out = str(profile_out.get("camelot") or "8A")
    camelot_in = str(profile_in.get("camelot") or "8A")
    camelot_info = check_camelot_compatibility(camelot_out, camelot_in)

    vocal_out = _safe_float(profile_out.get("vocal_presence"), 0.0)
    vocal_in = _safe_float(profile_in.get("vocal_presence"), 0.0)

    base_state = {
        "outgoing_track": {
            "title": profile_out.get("title") or "Track A",
            "bpm": bpm_out,
            "camelot_key": camelot_out,
            "key": profile_out.get("key") or "Unknown",
            "vocal_presence_pct": round(vocal_out * 100, 1),
            "energy_low": round(_safe_float(profile_out.get("energy_low"), 0.5), 3),
            "energy_mid": round(_safe_float(profile_out.get("energy_mid"), 0.5), 3),
            "energy_high": round(_safe_float(profile_out.get("energy_high"), 0.5), 3),
            "spectral_centroid": round(_safe_float(profile_out.get("spectral_centroid"), 0.33), 3),
            "transient_density": round(_safe_float(profile_out.get("transient_density"), 0.5), 3),
            "energy_trajectory": profile_out.get("energy_trajectory") or "sustain",
            "duration_sec": _safe_float(profile_out.get("duration"), 180.0),
        },
        "incoming_track": {
            "title": profile_in.get("title") or "Track B",
            "bpm": bpm_in,
            "camelot_key": camelot_in,
            "key": profile_in.get("key") or "Unknown",
            "vocal_presence_pct": round(vocal_in * 100, 1),
            "energy_low": round(_safe_float(profile_in.get("energy_low"), 0.5), 3),
            "energy_mid": round(_safe_float(profile_in.get("energy_mid"), 0.5), 3),
            "energy_high": round(_safe_float(profile_in.get("energy_high"), 0.5), 3),
            "spectral_centroid": round(_safe_float(profile_in.get("spectral_centroid"), 0.33), 3),
            "transient_density": round(_safe_float(profile_in.get("transient_density"), 0.5), 3),
            "energy_trajectory": profile_in.get("energy_trajectory") or "building",
            "duration_sec": _safe_float(profile_in.get("duration"), 180.0),
            "hot_cues": profile_in.get("hot_cues") or {}
        },
        "mix_context": {
            "bpm_delta": delta_bpm,
            "camelot_relationship": camelot_info.get("description", "Unknown"),
            "harmonic_compatible": camelot_info.get("is_harmonically_compatible", True),
            "vocal_clash_risk": (
                "HIGH" if (vocal_out > 0.3 and vocal_in > 0.3) else
                "MODERATE" if (vocal_out > 0.2 or vocal_in > 0.2) else
                "SAFE"
            )
        }
    }

    decisions = {}
    total_latency_ms = 0
    call_count = 0

    # ═══════════════════════════════════════════════════════
    # CALL 1: Building Block & Hot Cue Selection (16 batched questions)
    # ═══════════════════════════════════════════════════════
    q1 = {
        "cue_target": {
            "type": "choice",
            "instructions": "Which structural Hot Cue of the incoming track should playback snap to and start from?",
            "criteria": {
                "cue_1_intro": "Intro downbeat — first kick/hat groove for seamless phrase-matched blends.",
                "cue_2_breakdown": "Breakdown/verse — vocal or melodic entry for atmospheric handoffs.",
                "cue_3_drop": "Main drop — peak energetic transient drop for instant power swaps.",
                "cue_4_outro": "Outro groove — rhythmic exit section for quick cut transitions."
            }
        },
        "use_bass_swap": {
            "type": "noul",
            "instructions": "Should an equal-power Linkwitz-Riley bass crossover be used to hand off the low end?"
        },
        "use_echo_wash": {
            "type": "noul",
            "instructions": "Should a synchronized echo/delay tail be engaged on the outgoing track?"
        },
        "use_hpf_sweep": {
            "type": "noul",
            "instructions": "Should a high-pass filter progressively sweep upward on the outgoing track?"
        },
        "use_loop_roll": {
            "type": "noul",
            "instructions": "Should an accelerating beat-repeat stutter (loop roll) build rhythmic tension?"
        },
        "use_noise_riser": {
            "type": "noul",
            "instructions": "Should a white noise riser build anticipation before the drop?"
        },
        "use_vinyl_brake": {
            "type": "noul",
            "instructions": "Should the outgoing track decelerate like a turntable motor stopping?"
        },
        "use_rewind": {
            "type": "noul",
            "instructions": "Should a vinyl rewind pull-up effect reset the mix before the incoming track drops?"
        },
        "use_stutter_chop": {
            "type": "noul",
            "instructions": "Should a progressive stutter chop (1/2→1/4→1/8→1/16) build rhythmic tension?"
        },
        "use_tension_snare": {
            "type": "noul",
            "instructions": "Should an accelerating snare roll build physical tension before the drop?"
        },
        "use_sidechain_pump": {
            "type": "noul",
            "instructions": "Should sidechain compression pump the outgoing track for rhythmic tension?"
        },
        "use_filter_sweep_blend": {
            "type": "noul",
            "instructions": "Should HPF sweep up on outgoing while LPF sweeps down on incoming for equal-power crossover?"
        },
        "use_predrop_gap": {
            "type": "noul",
            "instructions": "Should there be an anticipation silence gap just before the drop?"
        },
        "use_drop_impact": {
            "type": "noul",
            "instructions": "Should a sub-bass boom and crash hit on Beat 1 of the drop?"
        },
        "vocal_ducking": {
            "type": "noul",
            "instructions": "Should outgoing vocal/mid frequencies be ducked to prevent vocal clashing?"
        },
        "use_stem_mashup": {
            "type": "noul",
            "instructions": "Should 4-stem isolation (drums, bass, vocals, melody) be automated during the transition?"
        },
        "use_flanger": {
            "type": "noul",
            "instructions": "Should a resonant LFO flanger sweep be applied on the outgoing track?"
        },
        "use_beat_masher": {
            "type": "noul",
            "instructions": "Should a beat-synced masher stutter the groove in rapid subdivisions?"
        },
        "use_pitch_bend": {
            "type": "noul",
            "instructions": "Should a vinyl pitch bend or turntable speed glide be applied?"
        },
        "transition_bars": {
            "type": "choice",
            "instructions": "How many 4/4 musical bars should this transition span?",
            "criteria": {
                "8": "Short punchy transition for high-energy club tracks or large BPM differences.",
                "16": "Standard club blend matching common 16-bar phrase boundaries.",
                "32": "Extended progressive blend for deep house, techno, or trance.",
                "64": "Ultra-long ambient blend for minimal techno or atmospheric transitions."
            }
        },
        "energy_intent": {
            "type": "choice",
            "instructions": "What energy trajectory should this transition achieve?",
            "criteria": {
                "build": "Rising energy — incoming track is higher energy than outgoing.",
                "sustain": "Maintain current energy level — seamless handoff.",
                "drop": "Controlled energy descent — incoming track is calmer.",
                "crash": "Dramatic sudden shift — abrupt energy change for impact."
            }
        },
        "blend_quality": {
            "type": "score",
            "instructions": "Rate overall harmonic, rhythmic, and timbral compatibility.",
            "criteria": [
                "Severe clash — dissonant keys, incompatible BPMs.",
                "Rough mix — requires heavy EQ surgery.",
                "Average — workable with adjustments.",
                "Smooth — harmonically compatible, natural handoff.",
                "Flawless — perfect key match, similar BPM, complementary timbres."
            ]
        }
    }

    t1 = time.time()
    a1, err1 = call_jev_batch(base_state, q1, api_key)
    t1_end = time.time()
    if err1:
        return None, f"Jev Call 1 failed: {err1}"
    call_count += 1
    total_latency_ms += int((t1_end - t1) * 1000)

    # Parse Call 1
    decisions["cue_target"] = _parse_choice(a1, "cue_target", "cue_1_intro")
    decisions["use_bass_swap"] = _parse_noul(a1, "use_bass_swap", True)
    decisions["use_echo_wash"] = _parse_noul(a1, "use_echo_wash", True)
    decisions["use_hpf_sweep"] = _parse_noul(a1, "use_hpf_sweep", True)
    decisions["use_loop_roll"] = _parse_noul(a1, "use_loop_roll", False)
    decisions["use_noise_riser"] = _parse_noul(a1, "use_noise_riser", False)
    decisions["use_vinyl_brake"] = _parse_noul(a1, "use_vinyl_brake", False)
    decisions["use_rewind"] = _parse_noul(a1, "use_rewind", False)
    decisions["use_stutter_chop"] = _parse_noul(a1, "use_stutter_chop", False)
    decisions["use_tension_snare"] = _parse_noul(a1, "use_tension_snare", False)
    decisions["use_sidechain_pump"] = _parse_noul(a1, "use_sidechain_pump", False)
    decisions["use_filter_sweep_blend"] = _parse_noul(a1, "use_filter_sweep_blend", False)
    decisions["use_predrop_gap"] = _parse_noul(a1, "use_predrop_gap", False)
    decisions["use_drop_impact"] = _parse_noul(a1, "use_drop_impact", False)
    decisions["vocal_ducking"] = _parse_noul(a1, "vocal_ducking", vocal_out > 0.2 or vocal_in > 0.2)
    decisions["use_stem_mashup"] = _parse_noul(a1, "use_stem_mashup", False)
    decisions["use_flanger"] = _parse_noul(a1, "use_flanger", False)
    decisions["use_beat_masher"] = _parse_noul(a1, "use_beat_masher", False)
    decisions["use_pitch_bend"] = _parse_noul(a1, "use_pitch_bend", False)

    try:
        decisions["transition_bars"] = int(_parse_choice(a1, "transition_bars", "16"))
    except ValueError:
        decisions["transition_bars"] = 16
    decisions["energy_intent"] = _parse_choice(a1, "energy_intent", "sustain")
    decisions["blend_quality"] = _parse_score(a1, "blend_quality", 3.0)

    # ═══════════════════════════════════════════════════════
    # CALL 2: Timing, Fader Curves & Stem Routing (10 batched questions)
    # ═══════════════════════════════════════════════════════
    active_blocks = [k.replace("use_", "") for k, v in decisions.items()
                     if k.startswith("use_") and v is True]

    state_2 = {
        **base_state,
        "jev_call1_decisions": {
            "active_building_blocks": active_blocks,
            "chosen_cue": decisions["cue_target"],
            "transition_bars": decisions["transition_bars"],
            "energy_intent": decisions["energy_intent"],
            "blend_quality_score": round(decisions["blend_quality"], 2),
        }
    }

    q2 = {
        "eq_intro_order": {
            "type": "choice",
            "instructions": "In what order should the incoming track's EQ bands be introduced?",
            "criteria": {
                "highs_first": "Hi-hats/cymbals first (maintains rhythmic continuity), then mids, then bass.",
                "mids_first": "Melodies/vocals first (good for vocal-driven tracks), then highs, then bass.",
                "full_spectrum": "All frequencies together at reduced volume (simple blend).",
                "filtered_in": "Heavy HPF on incoming, sweep down to full spectrum (filter build)."
            }
        },
        "bass_swap_position": {
            "type": "score",
            "instructions": "Where in the transition should the bass crossover center?",
            "criteria": [
                "Very early (around 20%) — quick bass handoff.",
                "Early (around 35%) — moderate early handoff.",
                "Center (around 50%) — balanced, standard.",
                "Late (around 65%) — bass stays on outgoing longer.",
                "Very late (around 80%) — extended outgoing bass."
            ]
        },
        "bass_swap_width": {
            "type": "score",
            "instructions": "How wide (gradual) should the bass crossover zone be?",
            "criteria": [
                "Razor sharp (2 bars) — near-instant bass swap.",
                "Narrow (4 bars) — quick but smooth.",
                "Standard (6 bars) — typical club blend.",
                "Wide (8 bars) — extended smooth crossover.",
                "Ultra-wide (12 bars) — very gradual, imperceptible."
            ]
        },
        "hpf_start_point": {
            "type": "score",
            "instructions": "When should the outgoing track's HPF sweep begin?",
            "criteria": [
                "Very early (15%) — start thinning early.",
                "Early (25%) — moderate early start.",
                "Standard (35%) — typical timing.",
                "Late (50%) — delayed thinning.",
                "Very late (65%) — keep outgoing full longer."
            ]
        },
        "echo_engage_point": {
            "type": "score",
            "instructions": "When should the echo tail engage on the outgoing track?",
            "criteria": [
                "Early (40%) — long echo wash.",
                "Mid (55%) — moderate echo presence.",
                "Standard (70%) — echo in final third.",
                "Late (80%) — brief echo at end.",
                "Very late (90%) — minimal echo touch."
            ]
        },
        "outgoing_fader_decay": {
            "type": "choice",
            "instructions": "How should the outgoing channel volume fader descend to 0%?",
            "criteria": {
                "smooth_linear": "Smooth linear descent from 100% to 0%.",
                "delayed_drop": "Hold 100% until 70% of transition, then drop steeply.",
                "exponential": "Early gentle drop with a long subtle tail to 0%."
            }
        },
        "incoming_stem_focus": {
            "type": "choice",
            "instructions": "Which stems of the incoming track should lead the introduction?",
            "criteria": {
                "full": "All stems together at balanced levels.",
                "drums_first": "Drums only first to lock the groove before harmony arrives.",
                "vocals_first": "Acapella/vocal leads first over outgoing rhythm.",
                "bass_and_drums": "Rhythm and bass foundation lead."
            }
        },
        "outgoing_stem_mute": {
            "type": "choice",
            "instructions": "Which stem of the outgoing track should exit earliest to create space?",
            "criteria": {
                "bass_first": "Kill low-end bass immediately to prevent muddiness.",
                "vocals_first": "Mute vocal immediately to prevent lyric clashing.",
                "all_gradual": "Fade all stems down evenly."
            }
        },
        "outgoing_dissolve": {
            "type": "score",
            "instructions": "When should the outgoing track fully dissolve?",
            "criteria": [
                "Quick exit (70%) — outgoing leaves early.",
                "Standard (80%) — typical dissolve point.",
                "Lingering (88%) — outgoing hangs longer.",
                "Very late (93%) — extended presence.",
                "Last moment (97%) — present almost to the end."
            ]
        }
    }

    t2 = time.time()
    a2, err2 = call_jev_batch(state_2, q2, api_key)
    t2_end = time.time()
    if err2:
        return None, f"Jev Call 2 failed: {err2}"
    call_count += 1
    total_latency_ms += int((t2_end - t2) * 1000)

    # Parse Call 2
    decisions["eq_intro_order"] = _parse_choice(a2, "eq_intro_order", "highs_first")
    decisions["bass_swap_position"] = _parse_score_norm(a2, "bass_swap_position", 0.5)
    decisions["bass_swap_width"] = _parse_score_norm(a2, "bass_swap_width", 0.5)
    decisions["hpf_start_point"] = _parse_score_norm(a2, "hpf_start_point", 0.5)
    decisions["echo_engage_point"] = _parse_score_norm(a2, "echo_engage_point", 0.5)
    decisions["outgoing_fader_decay"] = _parse_choice(a2, "outgoing_fader_decay", "smooth_linear")
    decisions["incoming_stem_focus"] = _parse_choice(a2, "incoming_stem_focus", "full")
    decisions["outgoing_stem_mute"] = _parse_choice(a2, "outgoing_stem_mute", "bass_first")
    decisions["outgoing_dissolve"] = _parse_score_norm(a2, "outgoing_dissolve", 0.5)

    # ═══════════════════════════════════════════════════════
    # CALL 3: Intensity & Character (8 batched questions)
    # ═══════════════════════════════════════════════════════
    state_3 = {
        **base_state,
        "jev_decisions_so_far": {
            "active_building_blocks": active_blocks,
            "cue_target": decisions["cue_target"],
            "transition_bars": decisions["transition_bars"],
            "energy_intent": decisions["energy_intent"],
            "eq_intro_order": decisions["eq_intro_order"],
            "outgoing_fader_decay": decisions["outgoing_fader_decay"]
        }
    }

    q3 = {
        "aggression": {
            "type": "score",
            "instructions": "How aggressive or dramatic should this transition feel?",
            "criteria": [
                "Whisper gentle — barely noticeable, ultra-smooth ambient blend.",
                "Soft blend — gentle and smooth, subtle EQ movements.",
                "Standard club — typical professional DJ blend.",
                "Aggressive punch — sharp movements, dramatic sweeps.",
                "Festival slam — maximum energy, hard cuts, dramatic effects."
            ]
        },
        "echo_delay_style": {
            "type": "choice",
            "instructions": "What rhythmic subdivision for the echo delay?",
            "criteria": {
                "quarter_beat": "1/4 beat — tight, rhythmic echo.",
                "half_beat": "1/2 beat — moderate spacing, common in house.",
                "three_quarter": "3/4 beat — triplet-like tension (Pioneer DJM classic).",
                "dotted_eighth": "Dotted 1/8 — galloping, rolling effect.",
                "one_beat": "Full beat — spacious, ambient wash."
            }
        },
        "echo_feedback": {
            "type": "score",
            "instructions": "How much feedback/regeneration for the echo?",
            "criteria": [
                "Dry (10%) — single subtle repeat.",
                "Light (25%) — a few gentle repeats.",
                "Standard (40%) — clear echo trail.",
                "Washy (55%) — prominent sustained echo.",
                "Drenched (70%) — long self-sustaining wash."
            ]
        },
        "echo_wet_level": {
            "type": "score",
            "instructions": "How loud should the echo be relative to dry signal?",
            "criteria": [
                "Barely audible (10%) — subliminal ghost echo.",
                "Subtle (20%) — present but understated.",
                "Balanced (35%) — clearly audible alongside dry.",
                "Prominent (50%) — echo is a major element.",
                "Dominant (65%) — echo overwhelms dry signal."
            ]
        },
        "hpf_ceiling_hz": {
            "type": "choice",
            "instructions": "Max frequency for outgoing track's HPF sweep?",
            "criteria": {
                "500": "500 Hz — subtle warmth removal.",
                "1000": "1000 Hz — removes bass and lower mids.",
                "1500": "1500 Hz — standard DJ HPF sweep.",
                "2500": "2500 Hz — aggressive, only highs remain.",
                "4000": "4000 Hz — extreme, almost fully washed out."
            }
        },
        "incoming_fader_curve": {
            "type": "choice",
            "instructions": "How should the incoming track's volume be introduced?",
            "criteria": {
                "gradual": "Gradual — smooth even rise from 0 to full.",
                "s_curve": "S-curve — slow start, quick middle, slow end.",
                "late_bloom": "Late bloom — stays quiet, rises rapidly in final third.",
                "instant": "Instant — comes in at near-full volume immediately."
            }
        },
        "vocal_duck_depth": {
            "type": "score",
            "instructions": "How deeply should outgoing vocals be ducked?",
            "criteria": [
                "-3 dB — gentle, subtle ducking.",
                "-5 dB — moderate ducking.",
                "-8 dB — standard ducking.",
                "-12 dB — deep ducking.",
                "-18 dB — near-complete vocal removal."
            ]
        }
    }

    t3 = time.time()
    a3, err3 = call_jev_batch(state_3, q3, api_key)
    t3_end = time.time()
    if err3:
        return None, f"Jev Call 3 failed: {err3}"
    call_count += 1
    total_latency_ms += int((t3_end - t3) * 1000)

    # Parse Call 3
    decisions["aggression"] = _parse_score_norm(a3, "aggression", 0.5)
    decisions["echo_delay_style"] = _parse_choice(a3, "echo_delay_style", "three_quarter")
    decisions["echo_feedback"] = _parse_score_norm(a3, "echo_feedback", 0.5)
    decisions["echo_wet_level"] = _parse_score_norm(a3, "echo_wet_level", 0.5)
    try:
        decisions["hpf_ceiling_hz"] = int(_parse_choice(a3, "hpf_ceiling_hz", "1500"))
    except ValueError:
        decisions["hpf_ceiling_hz"] = 1500
    decisions["incoming_fader_curve"] = _parse_choice(a3, "incoming_fader_curve", "gradual")
    decisions["vocal_duck_depth"] = _parse_score_norm(a3, "vocal_duck_depth", 0.5)

    # ═══════════════════════════════════════════════════════
    # CALL 4: Special FX (Loop roll / Gap / Impact / Flanger / Masher / Pitch Bend)
    # ═══════════════════════════════════════════════════════
    needs_c4 = (
        decisions["use_loop_roll"] or decisions["use_predrop_gap"] or
        decisions["use_drop_impact"] or decisions["use_flanger"] or
        decisions["use_beat_masher"] or decisions["use_pitch_bend"] or
        decisions["use_rewind"] or decisions["use_stutter_chop"] or
        decisions["use_tension_snare"]
    )

    if needs_c4:
        q4 = {}
        if decisions["use_loop_roll"]:
            q4["loop_acceleration"] = {
                "type": "choice",
                "instructions": "How should the loop roll beat divisions accelerate?",
                "criteria": {
                    "gradual": "Gradual — 1 bar → 1/2 → 1/4 → 1/8 over full duration.",
                    "aggressive": "Aggressive — quickly reaches 1/16 divisions.",
                    "exponential": "Exponential — slow start, rapid acceleration at end."
                }
            }
            q4["loop_roll_bars"] = {
                "type": "choice",
                "instructions": "How many bars should the loop roll last?",
                "criteria": {
                    "2": "2 bars — short punchy stutter.",
                    "4": "4 bars — standard build length.",
                    "8": "8 bars — extended dramatic build."
                }
            }
        if decisions["use_predrop_gap"]:
            q4["predrop_gap_beats"] = {
                "type": "choice",
                "instructions": "How long should the silence gap before the drop be?",
                "criteria": {
                    "half_beat": "Half beat — very brief micro-gap.",
                    "one_beat": "One full beat — standard dramatic pause.",
                    "two_beats": "Two beats — extended silence for maximum anticipation."
                }
            }
        if decisions["use_drop_impact"]:
            q4["drop_impact_style"] = {
                "type": "choice",
                "instructions": "What type of impact on Beat 1 of the drop?",
                "criteria": {
                    "sub_boom": "Sub-bass boom only — deep low-end thud.",
                    "crash_only": "Crash cymbal only — bright top-end splash.",
                    "boom_and_crash": "Sub-bass boom + crash — full-spectrum impact.",
                    "silent_drop": "No impact — let incoming track's own drop speak."
                }
            }
        if decisions["use_flanger"]:
            q4["flanger_speed"] = {
                "type": "choice",
                "instructions": "What LFO speed for the flanger sweep?",
                "criteria": {
                    "slow": "Slow hypnotic sweep (2-4 bars).",
                    "medium": "Medium rhythmic sweep (1 bar).",
                    "fast": "Rapid laser-like flanger wobble (1/2 bar)."
                }
            }
        if decisions["use_beat_masher"]:
            q4["beat_masher_division"] = {
                "type": "choice",
                "instructions": "What subdivision for the beat masher stutter?",
                "criteria": {
                    "quarter": "1/4 beat stutter.",
                    "eighth": "1/8 beat stutter.",
                    "sixteenth": "1/16 beat rapid stutter.",
                    "thirty_second": "1/32 beat glitch flutter."
                }
            }
        if decisions["use_pitch_bend"]:
            q4["pitch_bend_style"] = {
                "type": "choice",
                "instructions": "What turntable pitch bend curve should be applied?",
                "criteria": {
                    "turntable_slowdown": "Authentic turntable motor deceleration to a dead stop.",
                    "rising_pitch_ramp": "Pitch ramp upwards (+2 semitones) for tension build.",
                    "quick_dive": "Quick 1-beat downward pitch dive on the exit."
                }
            }

        if q4:
            t4 = time.time()
            a4, err4 = call_jev_batch(state_3, q4, api_key)
            t4_end = time.time()
            if err4:
                print(f"Jev Call 4 warning: {err4} — using defaults")
                a4 = {}
            else:
                call_count += 1
                total_latency_ms += int((t4_end - t4) * 1000)

            if decisions["use_loop_roll"]:
                decisions["loop_acceleration"] = _parse_choice(a4, "loop_acceleration", "gradual")
                try:
                    decisions["loop_roll_bars"] = int(_parse_choice(a4, "loop_roll_bars", "4"))
                except ValueError:
                    decisions["loop_roll_bars"] = 4
            if decisions["use_predrop_gap"]:
                decisions["predrop_gap_beats"] = _parse_choice(a4, "predrop_gap_beats", "one_beat")
            if decisions["use_drop_impact"]:
                decisions["drop_impact_style"] = _parse_choice(a4, "drop_impact_style", "boom_and_crash")
            if decisions["use_flanger"]:
                decisions["flanger_speed"] = _parse_choice(a4, "flanger_speed", "medium")
            if decisions["use_beat_masher"]:
                decisions["beat_masher_division"] = _parse_choice(a4, "beat_masher_division", "sixteenth")
            if decisions["use_pitch_bend"]:
                decisions["pitch_bend_style"] = _parse_choice(a4, "pitch_bend_style", "turntable_slowdown")

    # ═══════════════════════════════════════════════════════
    # COMPILE INTO BLUEPRINT
    # ═══════════════════════════════════════════════════════
    blueprint = compile_blueprint(decisions, profile_out, profile_in)
    blueprint["meta"]["jev_calls"] = call_count
    blueprint["meta"]["jev_latency_ms"] = total_latency_ms
    blueprint["meta"]["total_pipeline_ms"] = int((time.time() - t0) * 1000)
    blueprint["meta"]["jev_decisions"] = decisions
    blueprint["meta"]["engine"] = f"TypeSafe Jev System One ({call_count} calls, {total_latency_ms}ms)"

    return blueprint, None


# ═══════════════════════════════════════════════════════════════
# BLUEPRINT COMPILER
# ═══════════════════════════════════════════════════════════════

def compile_blueprint(
    d: Dict[str, Any],
    profile_out: Dict[str, Any],
    profile_in: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Compile Jev decisions into a complete TransitionBlueprint.
    Each keyframe is [progress, value] where progress is 0.0-1.0.
    Values are in native units: dB for EQ, Hz for HPF, 0-1 for faders, 0-100 for crossfader.
    """
    aggression = float(d.get("aggression", 0.5))
    bars = int(d.get("transition_bars", 16))

    # ─── Active blocks ───
    active_blocks = []
    for key in ["bass_swap", "echo_wash", "hpf_sweep", "loop_roll",
                "noise_riser", "vinyl_brake", "rewind", "stutter_chop",
                "tension_snare", "sidechain_pump", "filter_sweep_blend",
                "predrop_gap", "drop_impact",
                "stem_mashup", "flanger", "beat_masher", "pitch_bend"]:
        if d.get(f"use_{key}", False):
            active_blocks.append(key)
    if d.get("vocal_ducking", False):
        active_blocks.append("vocal_ducking")

    # ─── Resolve Hot Cue Target & Exact Timestamp ───
    cue_target = d.get("cue_target", "cue_1_intro")
    hot_cues_in = profile_in.get("hot_cues") or {}
    dur_in = _safe_float(profile_in.get("duration"), 180.0)

    if cue_target == "cue_2_breakdown":
        chosen_cue_time = _safe_float(hot_cues_in.get("cue_2"), dur_in * 0.25)
    elif cue_target == "cue_3_drop":
        chosen_cue_time = _safe_float(hot_cues_in.get("cue_3"), dur_in * 0.50)
    elif cue_target == "cue_4_outro":
        chosen_cue_time = _safe_float(hot_cues_in.get("cue_4"), max(0.0, dur_in - 30.0))
    else:  # cue_1_intro
        chosen_cue_time = _safe_float(hot_cues_in.get("cue_1"), _safe_float(profile_in.get("suggested_cue_intro"), 0.0))

    # ─── Bass swap geometry ───
    bs_center = _lerp(0.20, 0.80, d.get("bass_swap_position", 0.5))
    bs_hw = _lerp(0.05, 0.25, d.get("bass_swap_width", 0.5))
    bs_start = max(0.05, bs_center - bs_hw)
    bs_end = min(0.95, bs_center + bs_hw)

    # ─── Dissolve point ───
    dissolve = _lerp(0.70, 0.97, d.get("outgoing_dissolve", 0.5))

    # ─── EQ start dB values (modulated by aggression) ───
    start_hi = _lerp(-14, -6, aggression)
    start_mid = _lerp(-22, -12, aggression)

    # ═══════ INCOMING EQ KEYFRAMES ═══════
    eq_order = d.get("eq_intro_order", "highs_first")

    if eq_order == "highs_first":
        hi_arrive = _lerp(0.20, 0.30, 1.0 - aggression)
        mid_start = _lerp(0.10, 0.20, 1.0 - aggression)
        mid_arrive = _lerp(0.45, 0.65, 1.0 - aggression)
        in_eq_hi = [[0.00, start_hi], [0.05, start_hi + 3], [round(hi_arrive, 3), 0.0]]
        in_eq_mid = [
            [0.00, start_mid],
            [round(mid_start, 3), start_mid + 4],
            [round(_lerp(mid_start, mid_arrive, 0.5), 3), start_mid / 2],
            [round(mid_arrive, 3), 0.0]
        ]
    elif eq_order == "mids_first":
        mid_arrive = _lerp(0.20, 0.35, 1.0 - aggression)
        hi_arrive = _lerp(0.30, 0.50, 1.0 - aggression)
        in_eq_hi = [[0.00, start_hi], [0.10, start_hi], [round(hi_arrive, 3), 0.0]]
        in_eq_mid = [[0.00, start_mid + 6], [round(mid_arrive, 3), 0.0]]
    elif eq_order == "full_spectrum":
        arrive = _lerp(0.30, 0.50, 1.0 - aggression)
        in_eq_hi = [[0.00, -8], [round(arrive, 3), 0.0]]
        in_eq_mid = [[0.00, -8], [round(arrive, 3), 0.0]]
    else:  # filtered_in
        arrive = _lerp(0.40, 0.60, 1.0 - aggression)
        in_eq_hi = [[0.00, -18], [round(arrive * 0.5, 3), -8], [round(arrive, 3), 0.0]]
        in_eq_mid = [[0.00, -18], [round(arrive * 0.7, 3), -6], [round(arrive, 3), 0.0]]

    # Incoming bass: controlled by bass swap or simple ramp
    if d.get("use_bass_swap", True):
        in_eq_low = [
            [0.00, -24],
            [round(bs_start, 3), -24],
            [round(bs_center, 3), -6],
            [round(bs_end, 3), 0.0]
        ]
    else:
        bass_a = _lerp(0.40, 0.70, 1.0 - aggression)
        in_eq_low = [[0.00, -24], [round(bass_a * 0.5, 3), -18], [round(bass_a, 3), 0.0]]

    # ═══════ OUTGOING EQ KEYFRAMES ═══════
    if d.get("use_bass_swap", True):
        out_eq_low = [
            [0.00, 0.0],
            [round(bs_start, 3), 0.0],
            [round(bs_center, 3), -6],
            [round(bs_end, 3), -24]
        ]
    else:
        out_eq_low = [
            [0.00, 0.0],
            [round(dissolve * 0.6, 3), 0.0],
            [round(dissolve * 0.8, 3), -12],
            [round(dissolve, 3), -24]
        ]

    mid_duck_s = _lerp(0.20, 0.35, 1.0 - aggression)
    mid_duck_m = _lerp(0.40, 0.55, 1.0 - aggression)
    mid_dissolve = _lerp(dissolve * 0.85, dissolve, aggression)
    out_eq_mid = [
        [0.00, 0.0],
        [round(mid_duck_s, 3), 0.0],
        [round(mid_duck_m, 3), round(_lerp(-3, -8, aggression), 1)],
        [round(mid_dissolve, 3), -24]
    ]

    out_eq_hi = [
        [0.00, 0.0],
        [round(dissolve * 0.6, 3), 0.0],
        [round(dissolve, 3), -24]
    ]

    # ═══════ HPF SWEEP ═══════
    if d.get("use_hpf_sweep", True):
        hpf_s = _lerp(0.15, 0.65, d.get("hpf_start_point", 0.5))
        hpf_ceil = int(d.get("hpf_ceiling_hz", 1500))
        hpf_e = min(0.95, dissolve)
        out_hpf = [[0.00, 20], [round(hpf_s, 3), 20], [round(hpf_e, 3), hpf_ceil]]
    else:
        out_hpf = [[0.00, 20], [1.00, 20]]

    # ═══════ VERTICAL CHANNEL FADER KEYFRAMES ═══════
    # Incoming Channel Fader
    fc = d.get("incoming_fader_curve", "gradual")
    if fc == "s_curve":
        in_fader = [[0.00, 0.0], [0.20, 0.05], [0.50, 0.5], [0.80, 0.95], [1.00, 1.0]]
    elif fc == "late_bloom":
        in_fader = [[0.00, 0.0], [0.60, 0.15], [0.80, 0.7], [1.00, 1.0]]
    elif fc == "instant":
        in_fader = [[0.00, 0.7], [0.20, 0.9], [1.00, 1.0]]
    else:  # gradual
        in_fader = [[0.00, 0.0], [0.50, 0.5], [1.00, 1.0]]

    # Outgoing Channel Fader (decided by Jev's outgoing_fader_decay)
    fd = d.get("outgoing_fader_decay", "smooth_linear")
    if fd == "delayed_drop":
        out_fader = [[0.00, 1.0], [0.65, 0.90], [0.85, 0.25], [1.00, 0.0]]
    elif fd == "exponential":
        out_fader = [[0.00, 1.0], [0.25, 0.60], [0.60, 0.20], [1.00, 0.0]]
    else:  # smooth_linear
        out_fader = [[0.00, 1.0], [0.50, 0.50], [1.00, 0.0]]

    # ═══════ CROSSFADER KEYFRAMES (LOCKED AT 50% CENTER) ═══════
    # Per pro club standard: Crossfader remains permanently centered (50%)
    # All attenuation/blend is driven by independent channel volume faders
    xf = [[0.00, 50], [1.00, 50]]

    # ═══════ EFFECTS SPECIFICATION ═══════
    effects = {}

    # Echo wash
    if d.get("use_echo_wash", False):
        engage = _lerp(0.40, 0.90, d.get("echo_engage_point", 0.5))
        delay_map = {
            "quarter_beat": 0.25, "half_beat": 0.5, "three_quarter": 0.75,
            "dotted_eighth": 0.375, "one_beat": 1.0
        }
        effects["echo_wash"] = {
            "engage_at": round(engage, 3),
            "delay_beats": delay_map.get(d.get("echo_delay_style", "three_quarter"), 0.75),
            "feedback": round(_lerp(0.10, 0.70, d.get("echo_feedback", 0.5)), 3),
            "wet_level": round(_lerp(0.10, 0.65, d.get("echo_wet_level", 0.5)), 3),
            "fade_out_sec": 2.0
        }
    else:
        effects["echo_wash"] = None

    # Vocal ducking
    if d.get("vocal_ducking", False):
        duck_db = round(_lerp(-3, -18, d.get("vocal_duck_depth", 0.5)), 1)
        effects["vocal_ducking"] = {
            "start_at": 0.15,
            "end_at": round(dissolve * 0.9, 3),
            "duck_db": duck_db
        }
    else:
        effects["vocal_ducking"] = None

    # Loop roll
    if d.get("use_loop_roll", False):
        lr_s = _lerp(0.30, 0.90, d.get("loop_roll_start", 0.5))
        effects["loop_roll"] = {
            "start_at": round(lr_s, 3),
            "total_bars": d.get("loop_roll_bars", 4),
            "acceleration": d.get("loop_acceleration", "gradual")
        }
    else:
        effects["loop_roll"] = None

    # Noise riser
    if d.get("use_noise_riser", False):
        nr_s = _lerp(0.20, 0.85, d.get("noise_riser_start", 0.5))
        nr_bars = max(2, int((0.95 - nr_s) * bars))
        effects["noise_riser"] = {
            "start_at": round(nr_s, 3),
            "bars": nr_bars
        }
    else:
        effects["noise_riser"] = None

    # Pre-drop gap
    if d.get("use_predrop_gap", False):
        gap_map = {"half_beat": 0.5, "one_beat": 1.0, "two_beats": 2.0}
        effects["predrop_gap"] = {
            "trigger_at": 0.96,
            "duration_beats": gap_map.get(d.get("predrop_gap_beats", "one_beat"), 1.0)
        }
    else:
        effects["predrop_gap"] = None

    # Drop impact
    if d.get("use_drop_impact", False):
        effects["drop_impact"] = {
            "trigger_at": 0.99,
            "style": d.get("drop_impact_style", "boom_and_crash")
        }
    else:
        effects["drop_impact"] = None

    # Vinyl brake
    if d.get("use_vinyl_brake", False):
        effects["vinyl_brake"] = {
            "start_at": round(_lerp(0.70, 0.90, aggression), 3),
            "duration_sec": round(_lerp(3.0, 1.0, aggression), 2)
        }
    else:
        effects["vinyl_brake"] = None

    # Rewind pull-up
    if d.get("use_rewind", False):
        effects["rewind"] = {
            "start_at": round(_lerp(0.85, 0.95, aggression), 3),
            "duration_sec": 1.5
        }
    else:
        effects["rewind"] = None

    # Stutter chop
    if d.get("use_stutter_chop", False):
        effects["stutter_chop"] = {
            "start_at": round(_lerp(0.50, 0.80, aggression), 3),
            "total_beats": 16,
            "final_div": 16
        }
    else:
        effects["stutter_chop"] = None

    # Tension snare roll
    if d.get("use_tension_snare", False):
        effects["tension_snare"] = {
            "start_at": round(_lerp(0.40, 0.70, aggression), 3),
            "bars": 4
        }
    else:
        effects["tension_snare"] = None

    # Sidechain pump
    if d.get("use_sidechain_pump", False):
        effects["sidechain_pump"] = {
            "start_at": round(_lerp(0.30, 0.60, aggression), 3),
            "depth": round(_lerp(0.4, 0.8, aggression), 2)
        }
    else:
        effects["sidechain_pump"] = None

    # Filter sweep blend
    if d.get("use_filter_sweep_blend", False):
        effects["filter_sweep_blend"] = {
            "start_at": 0.0,
            "chunks": 48
        }
    else:
        effects["filter_sweep_blend"] = None

    # 4-Stem Mashup
    if d.get("use_stem_mashup", False):
        effects["stem_mashup"] = {
            "incoming_focus": d.get("incoming_stem_focus", "drums_first"),
            "outgoing_mute": d.get("outgoing_stem_mute", "bass_first"),
            "switch_at": round(_lerp(0.3, 0.6, aggression), 3)
        }
    else:
        effects["stem_mashup"] = None

    # Flanger
    if d.get("use_flanger", False):
        effects["flanger"] = {
            "start_at": round(_lerp(0.35, 0.70, aggression), 3),
            "speed": d.get("flanger_speed", "medium"),
            "depth": round(_lerp(0.3, 0.8, aggression), 2),
            "wet": round(_lerp(0.2, 0.5, aggression), 2)
        }
    else:
        effects["flanger"] = None

    # Beat Masher
    if d.get("use_beat_masher", False):
        div_map = {
            "quarter": "1/4", "eighth": "1/8", "sixteenth": "1/16", "thirty_second": "1/32"
        }
        effects["beat_masher"] = {
            "start_at": round(_lerp(0.60, 0.85, aggression), 3),
            "division": div_map.get(d.get("beat_masher_division", "sixteenth"), "1/16"),
            "bars": 2
        }
    else:
        effects["beat_masher"] = None

    # Turntable Pitch Bend
    if d.get("use_pitch_bend", False):
        effects["pitch_bend"] = {
            "start_at": round(_lerp(0.75, 0.90, aggression), 3),
            "style": d.get("pitch_bend_style", "turntable_slowdown"),
            "semitones": -4
        }
    else:
        effects["pitch_bend"] = None

    # ═══════ ASSEMBLE ═══════
    blend_q = d.get("blend_quality", 3.0)
    blend_score = round(max(1.0, min(100.0, (blend_q / 4.0) * 100.0)), 1)

    cue_names = {
        "cue_1_intro": "INTRO (Downbeat)",
        "cue_2_breakdown": "BREAKDOWN (Verse)",
        "cue_3_drop": "MAIN DROP (Peak Energy)",
        "cue_4_outro": "OUTRO (Mix Point)"
    }

    return {
        "meta": {
            "active_blocks": active_blocks,
            "transition_bars": bars,
            "bars": bars,
            "energy_intent": d.get("energy_intent", "sustain"),
            "blend_score": blend_score,
            "aggression": round(aggression, 3),
            "crossfader_curve": "center_locked_50",
            "eq_intro_order": d.get("eq_intro_order", "highs_first"),
            "bpm": _safe_float(profile_out.get("bpm"), 128.0),
            "cue_target": cue_target,
            "cue_target_name": cue_names.get(cue_target, "INTRO"),
            "chosen_cue_time": round(chosen_cue_time, 2)
        },
        "keyframes": {
            "incoming_eq_high": in_eq_hi,
            "incoming_eq_mid": in_eq_mid,
            "incoming_eq_low": in_eq_low,
            "outgoing_eq_high": out_eq_hi,
            "outgoing_eq_mid": out_eq_mid,
            "outgoing_eq_low": out_eq_low,
            "outgoing_hpf_hz": out_hpf,
            "incoming_fader": in_fader,
            "outgoing_fader": out_fader,
            "crossfader": xf,
        },
        "effects": effects,
    }


# ═══════════════════════════════════════════════════════════════
# LOCAL FALLBACK BLUEPRINT (no Jev API needed)
# ═══════════════════════════════════════════════════════════════

def compile_local_fallback_blueprint(
    profile_out: Dict[str, Any],
    profile_in: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Generates a blueprint using local acoustic heuristics when no Jev key is available.
    Same keyframe format as Jev-compiled blueprints — the frontend executor is identical.
    """
    bpm_out = _safe_float(profile_out.get("bpm"), 128.0)
    bpm_in = _safe_float(profile_in.get("bpm"), 128.0)
    delta_bpm = abs(bpm_out - bpm_in)

    vocal_out = _safe_float(profile_out.get("vocal_presence"), 0.0)
    vocal_in = _safe_float(profile_in.get("vocal_presence"), 0.0)

    camelot_out = str(profile_out.get("camelot") or "8A")
    camelot_in = str(profile_in.get("camelot") or "8A")
    camelot_info = check_camelot_compatibility(camelot_out, camelot_in)
    harmonic = camelot_info.get("is_harmonically_compatible", True)

    decisions = {
        "cue_target": "cue_3_drop" if delta_bpm > 10 else "cue_1_intro",
        "use_bass_swap": harmonic and delta_bpm < 8,
        "use_echo_wash": True,
        "use_hpf_sweep": True,
        "use_loop_roll": not harmonic and delta_bpm > 5,
        "use_noise_riser": not harmonic,
        "use_vinyl_brake": delta_bpm > 12,
        "use_predrop_gap": not harmonic,
        "use_drop_impact": not harmonic or delta_bpm > 8,
        "vocal_ducking": vocal_out > 0.2 and vocal_in > 0.2,
        "use_stem_mashup": True,
        "use_flanger": not harmonic and delta_bpm < 6,
        "use_beat_masher": delta_bpm > 8,
        "use_pitch_bend": delta_bpm > 12,
        "transition_bars": 32 if (harmonic and delta_bpm < 3) else (16 if delta_bpm < 8 else 8),
        "energy_intent": "sustain",
        "blend_quality": 4.0 if harmonic else 2.0,
        "eq_intro_order": "highs_first",
        "bass_swap_position": 0.5,
        "bass_swap_width": 0.5,
        "hpf_start_point": 0.5,
        "echo_engage_point": 0.6,
        "outgoing_fader_decay": "smooth_linear",
        "incoming_stem_focus": "drums_first" if harmonic else "full",
        "outgoing_stem_mute": "bass_first",
        "outgoing_dissolve": 0.5,
        "aggression": 0.3 if harmonic else 0.7,
        "echo_delay_style": "three_quarter",
        "echo_feedback": 0.5,
        "echo_wet_level": 0.4,
        "hpf_ceiling_hz": 1500,
        "incoming_fader_curve": "gradual",
        "vocal_duck_depth": 0.5,
        "flanger_speed": "medium",
        "beat_masher_division": "sixteenth",
        "pitch_bend_style": "turntable_slowdown"
    }

    if decisions["use_loop_roll"]:
        decisions["loop_acceleration"] = "gradual"
        decisions["loop_roll_bars"] = 4
    if decisions["use_predrop_gap"]:
        decisions["predrop_gap_beats"] = "one_beat"
    if decisions["use_drop_impact"]:
        decisions["drop_impact_style"] = "boom_and_crash"

    bp = compile_blueprint(decisions, profile_out, profile_in)
    bp["meta"]["jev_calls"] = 0
    bp["meta"]["jev_latency_ms"] = 0
    bp["meta"]["total_pipeline_ms"] = 0
    bp["meta"]["jev_decisions"] = decisions
    bp["meta"]["engine"] = "Local Acoustic Heuristic (0ms)"

    return bp


def run_gemini_audition_pipeline(
    profile_out: Dict[str, Any],
    profile_in: Dict[str, Any],
    gemini_api_key: str,
    audio_b64: Optional[str] = None,
    audio_mime: str = "audio/wav",
    model_name: str = "gemini-3.8-flash"
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """
    Runs Gemini Multimodal Audition Pipeline:
    Sends an actual audio audition slice (10-12s around the Hot Cue) to Google Gemini
    so the AI model 'hears' the incoming track in its DJ headphones (PFL / Pre-Fade Listen)
    without playing it on the main speakers.
    Gemini listens to kick transients, bass weight, synth timbres, and vocals,
    then generates a full TransitionBlueprint with zero guesswork.
    """
    from .ai_advisor import call_gemini_api
    import time

    start_time = time.time()
    
    bpm_out = _safe_float(profile_out.get("bpm"), 128.0)
    bpm_in = _safe_float(profile_in.get("bpm"), 128.0)
    camelot_out = profile_out.get("camelot", "8A")
    camelot_in = profile_in.get("camelot", "8A")
    title_out = profile_out.get("title", "Track 1")
    title_in = profile_in.get("title", "Track 2")
    pos_out = _safe_float(profile_out.get("current_position"), 0.0)

    cue_target_hint = "cue_1_intro"
    hot_cues_in = profile_in.get("hot_cues") or {}
    if "cue_3" in hot_cues_in or "DROP" in hot_cues_in:
        cue_target_hint = "cue_3_drop"

    has_audio = bool(audio_b64 and len(audio_b64) > 100)

    audio_listening_instructions = (
        "🎧 [HEADPHONE AUDITION ACTIVE]: You have an audio clip attached to this message. "
        "This is an exact 10-second audition snippet of the incoming track taken at its cue point. "
        "LISTEN CAREFULLY TO THE AUDIO IN YOUR HEADPHONES: "
        "- What kick drum punch, sub-bass frequency, or percussion do you hear? "
        "- Are there vocals present or is it instrumental? "
        "- How does the rhythmic energy compare to the outgoing track? "
        "Describe what you literally hear in the 'audition_heard' field."
        if has_audio else
        "🎧 [HEADPHONE AUDITION ACTIVE]: Auditioning incoming track via high-resolution spectral and transient telemetry."
    )

    prompt = f"""
You are Jev, a World-Champion DJ and Master Audio Engineer headlining Tomorrowland and Ultra Music Festival.
You are wearing DJ headphones (PFL / Pre-Fade Listen Bus).
The audience is currently listening to Track 1 (Outgoing) live on the main speakers.
Track 2 (Incoming) is in your headphones, MUTED from the main speakers (Volume Fader = 0%).

{audio_listening_instructions}

LIVE OUTGOING TRACK (Currently playing to the audience on main speakers):
- Title: {title_out}
- BPM: {bpm_out}
- Camelot Key: {camelot_out}
- Current Live Playhead: {pos_out:.1f}s

INCOMING TRACK (In your headphones):
- Title: {title_in}
- BPM: {bpm_in}
- Camelot Key: {camelot_in}
- Energy Profile: Low={profile_in.get('energy_low', 0.5)}, Mid={profile_in.get('energy_mid', 0.5)}, High={profile_in.get('energy_high', 0.5)}
- Available Hot Cues: {json.dumps(hot_cues_in)}

Based on what you hear in your headphones, formulate the perfect transition plan.
Return ONLY valid JSON matching this exact structure:
{{
  "audition_heard": "1-2 sentences vividly describing the exact sounds, drums, instruments, and vocal texture you heard in your headphones",
  "cue_target": "cue_1_intro" | "cue_2_breakdown" | "cue_3_drop" | "cue_4_outro",
  "transition_bars": 8 | 16 | 32,
  "energy_intent": "sustain" | "boost" | "drop",
  "blend_quality": 1.0 to 5.0,
  "use_bass_swap": true,
  "use_echo_wash": true,
  "use_hpf_sweep": true,
  "use_loop_roll": false,
  "use_predrop_gap": false,
  "use_drop_impact": false,
  "vocal_ducking": true,
  "use_stem_mashup": true,
  "use_flanger": false,
  "use_beat_masher": false,
  "use_pitch_bend": false,
  "eq_intro_order": "highs_first" | "mids_first" | "full_punch",
  "bass_swap_position": 0.3 to 0.7,
  "bass_swap_width": 0.2 to 0.6,
  "outgoing_dissolve": 0.6 to 0.95,
  "aggression": 0.1 to 0.9,
  "tactical_advice": "One high-level pro tip on why this blend will rock the dancefloor"
}}
"""

    gemini_resp, err = call_gemini_api(
        prompt=prompt,
        api_key=gemini_api_key,
        model_name=model_name,
        audio_b64=audio_b64 if has_audio else None,
        audio_mime=audio_mime
    )

    if err or not gemini_resp or not isinstance(gemini_resp, dict):
        return None, err or "Invalid Gemini response format"

    # Merge decisions with defaults
    decisions = {
        "cue_target": gemini_resp.get("cue_target", cue_target_hint),
        "transition_bars": int(gemini_resp.get("transition_bars", 16)),
        "energy_intent": gemini_resp.get("energy_intent", "sustain"),
        "blend_quality": float(gemini_resp.get("blend_quality", 4.0)),
        "use_bass_swap": bool(gemini_resp.get("use_bass_swap", True)),
        "use_echo_wash": bool(gemini_resp.get("use_echo_wash", True)),
        "use_hpf_sweep": bool(gemini_resp.get("use_hpf_sweep", True)),
        "use_loop_roll": bool(gemini_resp.get("use_loop_roll", False)),
        "use_predrop_gap": bool(gemini_resp.get("use_predrop_gap", False)),
        "use_drop_impact": bool(gemini_resp.get("use_drop_impact", False)),
        "vocal_ducking": bool(gemini_resp.get("vocal_ducking", True)),
        "use_stem_mashup": bool(gemini_resp.get("use_stem_mashup", True)),
        "use_flanger": bool(gemini_resp.get("use_flanger", False)),
        "use_beat_masher": bool(gemini_resp.get("use_beat_masher", False)),
        "use_pitch_bend": bool(gemini_resp.get("use_pitch_bend", False)),
        "eq_intro_order": gemini_resp.get("eq_intro_order", "highs_first"),
        "bass_swap_position": float(gemini_resp.get("bass_swap_position", 0.5)),
        "bass_swap_width": float(gemini_resp.get("bass_swap_width", 0.5)),
        "outgoing_dissolve": float(gemini_resp.get("outgoing_dissolve", 0.85)),
        "aggression": float(gemini_resp.get("aggression", 0.35)),
        "audition_heard": gemini_resp.get("audition_heard", "Auditioned in background PFL headphones"),
        "tactical_advice": gemini_resp.get("tactical_advice", ""),
    }

    if decisions["use_loop_roll"]:
        decisions["loop_acceleration"] = "gradual"
        decisions["loop_roll_bars"] = 4
    if decisions["use_predrop_gap"]:
        decisions["predrop_gap_beats"] = "one_beat"
    if decisions["use_drop_impact"]:
        decisions["drop_impact_style"] = "boom_and_crash"

    bp = compile_blueprint(decisions, profile_out, profile_in)
    latency_ms = int((time.time() - start_time) * 1000)
    bp["meta"]["jev_calls"] = 1
    bp["meta"]["jev_latency_ms"] = latency_ms
    bp["meta"]["total_pipeline_ms"] = latency_ms
    bp["meta"]["jev_decisions"] = decisions
    bp["meta"]["engine"] = f"Gemini Multimodal DJ Ear ({model_name})"
    bp["meta"]["ai_ears"] = True
    bp["meta"]["audio_auditioned"] = has_audio
    bp["meta"]["audition_heard"] = decisions["audition_heard"]
    bp["meta"]["tactical_advice"] = decisions["tactical_advice"]

    return bp, None

