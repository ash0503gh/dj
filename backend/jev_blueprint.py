"""
jev_blueprint.py - Jev Autonomous DJ Brain Pipeline & Blueprint Compiler.

Runs a 3-4 call decision pipeline against TypeSafe Jev System One,
producing a complete TransitionBlueprint JSON with keyframe arrays
that the frontend executor reads directly.

Each call batches multiple questions in parallel against the same state.
Total pipeline latency: ~300-500ms for 28-32 decisions.
"""

import json
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

    # ─── Build rich state from both track profiles ───
    bpm_out = float(profile_out.get("bpm", 128.0))
    bpm_in = float(profile_in.get("bpm", 128.0))
    delta_bpm = round(abs(bpm_out - bpm_in), 1)
    camelot_out = str(profile_out.get("camelot", "8A"))
    camelot_in = str(profile_in.get("camelot", "8A"))
    camelot_info = check_camelot_compatibility(camelot_out, camelot_in)

    vocal_out = float(profile_out.get("vocal_presence", 0.0))
    vocal_in = float(profile_in.get("vocal_presence", 0.0))

    base_state = {
        "outgoing_track": {
            "title": profile_out.get("title", "Track A"),
            "bpm": bpm_out,
            "camelot_key": camelot_out,
            "key": profile_out.get("key", "Unknown"),
            "vocal_presence_pct": round(vocal_out * 100, 1),
            "energy_low": round(float(profile_out.get("energy_low", 0.5)), 3),
            "energy_mid": round(float(profile_out.get("energy_mid", 0.5)), 3),
            "energy_high": round(float(profile_out.get("energy_high", 0.5)), 3),
            "spectral_centroid": round(float(profile_out.get("spectral_centroid", 0.33)), 3),
            "transient_density": round(float(profile_out.get("transient_density", 0.5)), 3),
            "energy_trajectory": profile_out.get("energy_trajectory", "sustain"),
            "duration_sec": float(profile_out.get("duration", 180.0)),
        },
        "incoming_track": {
            "title": profile_in.get("title", "Track B"),
            "bpm": bpm_in,
            "camelot_key": camelot_in,
            "key": profile_in.get("key", "Unknown"),
            "vocal_presence_pct": round(vocal_in * 100, 1),
            "energy_low": round(float(profile_in.get("energy_low", 0.5)), 3),
            "energy_mid": round(float(profile_in.get("energy_mid", 0.5)), 3),
            "energy_high": round(float(profile_in.get("energy_high", 0.5)), 3),
            "spectral_centroid": round(float(profile_in.get("spectral_centroid", 0.33)), 3),
            "transient_density": round(float(profile_in.get("transient_density", 0.5)), 3),
            "energy_trajectory": profile_in.get("energy_trajectory", "building"),
            "duration_sec": float(profile_in.get("duration", 180.0)),
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
    # CALL 1: Building Block Selection (12 batched questions)
    # ═══════════════════════════════════════════════════════
    q1 = {
        "use_bass_swap": {
            "type": "noul",
            "instructions": (
                "Should an equal-power Linkwitz-Riley bass crossover be used to smoothly "
                "hand off the low end between tracks? Best when keys are harmonically "
                "compatible and both tracks have strong bass."
            )
        },
        "use_echo_wash": {
            "type": "noul",
            "instructions": (
                "Should a synchronized echo/delay tail be engaged on the outgoing track "
                "to create spacious dissolution and fill the perceptual gap as it thins?"
            )
        },
        "use_hpf_sweep": {
            "type": "noul",
            "instructions": (
                "Should a high-pass filter progressively sweep upward on the outgoing "
                "track to naturally thin it during the transition?"
            )
        },
        "use_loop_roll": {
            "type": "noul",
            "instructions": (
                "Should an accelerating beat-repeat stutter (loop roll) be used on the "
                "outgoing track to build rhythmic tension before the drop?"
            )
        },
        "use_noise_riser": {
            "type": "noul",
            "instructions": (
                "Should a white noise riser be layered under the mix to build "
                "anticipation and energy before the incoming track's drop?"
            )
        },
        "use_vinyl_brake": {
            "type": "noul",
            "instructions": (
                "Should the outgoing track decelerate like a turntable motor stopping, "
                "creating a dramatic slowdown exit?"
            )
        },
        "use_predrop_gap": {
            "type": "noul",
            "instructions": (
                "Should there be a brief moment of silence (anticipation gap) just "
                "before the incoming track's drop for maximum dramatic impact?"
            )
        },
        "use_drop_impact": {
            "type": "noul",
            "instructions": (
                "Should a sub-bass boom and crash cymbal hit on Beat 1 of the incoming "
                "track's drop to emphasize the moment?"
            )
        },
        "vocal_ducking": {
            "type": "noul",
            "instructions": (
                "Should the outgoing track's vocal/mid-range frequencies be ducked "
                "during the overlap to prevent vocal clashing?"
            )
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
    decisions["use_bass_swap"] = _parse_noul(a1, "use_bass_swap", True)
    decisions["use_echo_wash"] = _parse_noul(a1, "use_echo_wash", True)
    decisions["use_hpf_sweep"] = _parse_noul(a1, "use_hpf_sweep", True)
    decisions["use_loop_roll"] = _parse_noul(a1, "use_loop_roll", False)
    decisions["use_noise_riser"] = _parse_noul(a1, "use_noise_riser", False)
    decisions["use_vinyl_brake"] = _parse_noul(a1, "use_vinyl_brake", False)
    decisions["use_predrop_gap"] = _parse_noul(a1, "use_predrop_gap", False)
    decisions["use_drop_impact"] = _parse_noul(a1, "use_drop_impact", False)
    decisions["vocal_ducking"] = _parse_noul(a1, "vocal_ducking", vocal_out > 0.2 or vocal_in > 0.2)
    try:
        decisions["transition_bars"] = int(_parse_choice(a1, "transition_bars", "16"))
    except ValueError:
        decisions["transition_bars"] = 16
    decisions["energy_intent"] = _parse_choice(a1, "energy_intent", "sustain")
    decisions["blend_quality"] = _parse_score(a1, "blend_quality", 3.0)

    # ═══════════════════════════════════════════════════════
    # CALL 2: Timing & Positioning (8 batched questions)
    # ═══════════════════════════════════════════════════════
    active_blocks = [k.replace("use_", "") for k, v in decisions.items()
                     if k.startswith("use_") and v is True]

    state_2 = {
        **base_state,
        "jev_call1_decisions": {
            "active_building_blocks": active_blocks,
            "transition_bars": decisions["transition_bars"],
            "energy_intent": decisions["energy_intent"],
            "blend_quality_score": round(decisions["blend_quality"], 2),
            "vocal_ducking_active": decisions["vocal_ducking"]
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
        "loop_roll_start": {
            "type": "score",
            "instructions": "When should the loop roll stutter begin?",
            "criteria": [
                "Early (30%) — long build stutter.",
                "Mid (50%) — balanced positioning.",
                "Late (65%) — shorter intense build.",
                "Very late (80%) — brief final stutter.",
                "Final bars (90%) — ultra-short rapid stutter."
            ]
        },
        "noise_riser_start": {
            "type": "score",
            "instructions": "When should the white noise riser begin building?",
            "criteria": [
                "Early (20%) — long gradual build.",
                "Mid (40%) — moderate build length.",
                "Standard (60%) — typical riser timing.",
                "Late (75%) — short intense riser.",
                "Final bars (85%) — very short sharp riser."
            ]
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
    decisions["loop_roll_start"] = _parse_score_norm(a2, "loop_roll_start", 0.5)
    decisions["noise_riser_start"] = _parse_score_norm(a2, "noise_riser_start", 0.5)
    decisions["outgoing_dissolve"] = _parse_score_norm(a2, "outgoing_dissolve", 0.5)

    # ═══════════════════════════════════════════════════════
    # CALL 3: Intensity & Character (8 batched questions)
    # ═══════════════════════════════════════════════════════
    state_3 = {
        **base_state,
        "jev_decisions_so_far": {
            "active_building_blocks": active_blocks,
            "transition_bars": decisions["transition_bars"],
            "energy_intent": decisions["energy_intent"],
            "eq_intro_order": decisions["eq_intro_order"],
            "bass_swap_center": f"{decisions['bass_swap_position'] * 100:.0f}%",
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
        "crossfader_curve": {
            "type": "choice",
            "instructions": "What crossfader curve for the volume blend?",
            "criteria": {
                "linear": "Linear — constant-rate blend.",
                "equal_power": "Equal power — maintains constant perceived loudness.",
                "sharp_cut": "Sharp cut — holds loud, quick crossover in middle.",
                "slow_start": "Slow start — gentle entry, accelerates, gentle exit."
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
    decisions["crossfader_curve"] = _parse_choice(a3, "crossfader_curve", "equal_power")
    decisions["incoming_fader_curve"] = _parse_choice(a3, "incoming_fader_curve", "gradual")
    decisions["vocal_duck_depth"] = _parse_score_norm(a3, "vocal_duck_depth", 0.5)

    # ═══════════════════════════════════════════════════════
    # CALL 4: Festival/Complex Params (conditional)
    # ═══════════════════════════════════════════════════════
    needs_c4 = decisions["use_loop_roll"] or decisions["use_predrop_gap"] or decisions["use_drop_impact"]

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
                "noise_riser", "vinyl_brake", "predrop_gap", "drop_impact"]:
        if d.get(f"use_{key}", False):
            active_blocks.append(key)
    if d.get("vocal_ducking", False):
        active_blocks.append("vocal_ducking")

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

    # ═══════ FADER KEYFRAMES ═══════
    fc = d.get("incoming_fader_curve", "gradual")
    if fc == "s_curve":
        in_fader = [[0.00, 0.0], [0.20, 0.05], [0.50, 0.5], [0.80, 0.95], [1.00, 1.0]]
        out_fader = [[0.00, 1.0], [0.20, 0.95], [0.50, 0.5], [0.80, 0.05], [1.00, 0.0]]
    elif fc == "late_bloom":
        in_fader = [[0.00, 0.0], [0.60, 0.15], [0.80, 0.7], [1.00, 1.0]]
        out_fader = [[0.00, 1.0], [0.40, 0.85], [0.80, 0.3], [1.00, 0.0]]
    elif fc == "instant":
        in_fader = [[0.00, 0.7], [0.20, 0.9], [1.00, 1.0]]
        out_fader = [[0.00, 1.0], [0.80, 0.1], [1.00, 0.0]]
    else:  # gradual
        in_fader = [[0.00, 0.0], [0.50, 0.5], [1.00, 1.0]]
        out_fader = [[0.00, 1.0], [0.50, 0.5], [1.00, 0.0]]

    # ═══════ CROSSFADER KEYFRAMES ═══════
    cc = d.get("crossfader_curve", "equal_power")
    if cc == "equal_power":
        xf = [[0.00, 0], [0.25, 15], [0.50, 50], [0.75, 85], [1.00, 100]]
    elif cc == "sharp_cut":
        xf = [[0.00, 0], [0.40, 5], [0.50, 50], [0.60, 95], [1.00, 100]]
    elif cc == "slow_start":
        xf = [[0.00, 0], [0.30, 10], [0.60, 40], [0.85, 80], [1.00, 100]]
    else:  # linear
        xf = [[0.00, 0], [1.00, 100]]

    # ═══════ EFFECTS ═══════
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

    # ═══════ ASSEMBLE ═══════
    blend_q = d.get("blend_quality", 3.0)
    blend_score = round(max(1.0, min(100.0, (blend_q / 4.0) * 100.0)), 1)

    return {
        "meta": {
            "active_blocks": active_blocks,
            "transition_bars": bars,
            "energy_intent": d.get("energy_intent", "sustain"),
            "blend_score": blend_score,
            "aggression": round(aggression, 3),
            "crossfader_curve": cc,
            "eq_intro_order": d.get("eq_intro_order", "highs_first"),
            "bpm": float(profile_out.get("bpm", 128.0)),
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
    bpm_out = float(profile_out.get("bpm", 128.0))
    bpm_in = float(profile_in.get("bpm", 128.0))
    delta_bpm = abs(bpm_out - bpm_in)

    vocal_out = float(profile_out.get("vocal_presence", 0.0))
    vocal_in = float(profile_in.get("vocal_presence", 0.0))

    camelot_out = str(profile_out.get("camelot", "8A"))
    camelot_in = str(profile_in.get("camelot", "8A"))
    camelot_info = check_camelot_compatibility(camelot_out, camelot_in)
    harmonic = camelot_info.get("is_harmonically_compatible", True)

    decisions = {
        "use_bass_swap": harmonic and delta_bpm < 8,
        "use_echo_wash": True,
        "use_hpf_sweep": True,
        "use_loop_roll": not harmonic and delta_bpm > 5,
        "use_noise_riser": not harmonic,
        "use_vinyl_brake": delta_bpm > 12,
        "use_predrop_gap": not harmonic,
        "use_drop_impact": not harmonic or delta_bpm > 8,
        "vocal_ducking": vocal_out > 0.2 and vocal_in > 0.2,
        "transition_bars": 32 if (harmonic and delta_bpm < 3) else (16 if delta_bpm < 8 else 8),
        "energy_intent": "sustain",
        "blend_quality": 4.0 if harmonic else 2.0,
        "eq_intro_order": "highs_first",
        "bass_swap_position": 0.5,
        "bass_swap_width": 0.5,
        "hpf_start_point": 0.5,
        "echo_engage_point": 0.6,
        "loop_roll_start": 0.6,
        "noise_riser_start": 0.5,
        "outgoing_dissolve": 0.5,
        "aggression": 0.3 if harmonic else 0.7,
        "echo_delay_style": "three_quarter",
        "echo_feedback": 0.5,
        "echo_wet_level": 0.4,
        "hpf_ceiling_hz": 1500,
        "crossfader_curve": "equal_power",
        "incoming_fader_curve": "gradual",
        "vocal_duck_depth": 0.5,
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
