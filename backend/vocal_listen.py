"""
vocal_listen.py - Gemini listens to a whole track once and marks which sections carry a lead vocal.

The spectral vocal score flags almost every section of a dance track (percussive mids and pads look
like voices to it). In a check against Gemini's judgement of 8-second clips, it agreed 69% of the
time; one Gemini pass over the full track, asked about each analysed section, agreed 84%. The
labels replace has_vocals/vocal_score in the section map (the spectral score is kept as
vocal_score_dsp), so the planner, the AI chooser and the lab all use them. Runs once per track
and is stored with the analysis.
"""

import base64
import subprocess
from typing import Any, Dict, List, Optional, Tuple

from .ai_advisor import DEFAULT_GEMINI_MODEL, call_gemini_api


def listen_for_vocals(path: str, sections: List[Dict[str, Any]], api_key: str,
                      model: str = DEFAULT_GEMINI_MODEL) -> Tuple[Optional[List[bool]], Optional[str]]:
    """One bool per section (True: lead vocal audible for a good part of it), or (None, error)."""
    if not sections:
        return None, "no sections"
    # Small mono MP3 (a 5 min track is ~1 MB); -vn drops embedded cover art
    mp3 = subprocess.run(['ffmpeg', '-v', 'quiet', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '24k',
                          '-f', 'mp3', '-'], capture_output=True).stdout
    if not mp3:
        return None, "could not decode audio"
    listing = "\n".join(f"{i}: {s['time']:.1f}s - {s['time'] + s['duration']:.1f}s" for i, s in enumerate(sections))
    usage: Dict[str, Any] = {}
    res, err = call_gemini_api(
        "Listen to this whole dance track. For EACH numbered section below, say whether a human LEAD VOCAL "
        "(sung or rapped words, not instrumental, pads or one short vocal chop) is audible for a good part "
        "of it.\n" + listing + '\nReturn JSON {"sections": [{"i": 0, "lead_vocal": true|false}, ...]}',
        api_key, model_name=model, audio_b64=base64.b64encode(mp3).decode(), audio_mime="audio/mp3", timeout=90,
        usage=usage)
    if usage:  # real spend, visible in the Cloud Run logs
        print(f"[listen-vocals] gemini tokens: prompt {usage.get('promptTokenCount')} output "
              f"{usage.get('candidatesTokenCount')} thinking {usage.get('thoughtsTokenCount')}", flush=True)
    if not res:
        return None, err or "Gemini returned nothing"
    labels = {d.get("i"): d.get("lead_vocal") for d in res.get("sections", []) if isinstance(d, dict)}
    out = [labels.get(i) for i in range(len(sections))]
    if sum(v is None for v in out) > len(sections) // 4:
        return None, f"Gemini labelled only {len(sections) - sum(v is None for v in out)}/{len(sections)} sections"
    return [bool(v) for v in out], None


def apply_vocal_labels(an: Dict[str, Any], labels: List[bool], model: str) -> None:
    for s, v in zip(an.get("section_map", []), labels):
        if "vocal_score_dsp" not in s:
            s["vocal_score_dsp"] = s.get("vocal_score", 0.0)
        s["has_vocals"] = v
        s["vocal_score"] = 1.0 if v else 0.0
    an["vocal_source"] = f"gemini:{model}"
