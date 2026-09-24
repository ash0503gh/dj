"""
transition_chooser.py - The AI picks one of the planner's transitions.

The browser's MixPlanner builds a few candidate transitions that are all technically safe
(master tempo, bass swapped in 30 ms on a downbeat, loudness matched, phrase-aligned). The AI
only makes the musical choice between them: which phrase to leave on, how long to blend, and
whether to echo out instead. The planner then performs the chosen one exactly as planned, so an
AI answer can never put a hole or a flam in the mix.

Gemini and Jev are asked in parallel; the answer of the engine preferred by
ai_advisor.engine_order (Gemini by default) wins if it arrives within the time budget. With no
usable answer the caller keeps the planner's own first choice.
"""

import functools
import json
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from typing import Any, Dict, List, Optional, Tuple

from .ai_advisor import (DEFAULT_GEMINI_MODEL, call_gemini_api, engine_order, get_gemini_api_key,
                         get_jev_api_key)


def _mmss(t: Any) -> str:
    try:
        t = float(t)
    except (TypeError, ValueError):
        return "?"
    return f"{int(t // 60)}:{int(t % 60):02d}"


def describe(c: Dict[str, Any]) -> str:
    """One line a DJ would read: what this candidate does and what it risks."""
    if c.get("technique") == "blend":
        what = f"{c.get('bars')}-bar blend"
        swap = "bass swaps on the incoming drop" if c.get("drop_aligned") else f"bass swaps at bar {c.get('swap_bar')}"
    else:
        what = str(c.get("technique", "cut")).replace("_", " ") + " (no overlap)"
        swap = "incoming drops in on the 1"
    parts = [
        f"{what} starting in {float(c.get('wait_s', 0)):.0f}s",
        f"leaves the outgoing at {_mmss(c.get('exit_at'))} ({c.get('exit_phrase', 'phrase')} line, "
        f"in its {c.get('exit_section', 'unknown')})",
        f"incoming enters at {_mmss(c.get('in_start_at'))} ({c.get('in_section', 'intro')})",
        swap,
    ]
    risks = []
    if c.get("vocal_clash"):
        risks.append("both tracks have vocals during the overlap")
    elif c.get("out_vocals"):
        risks.append("outgoing vocals during the overlap")
    if c.get("technique") == "blend" and c.get("key_clash"):
        risks.append("keys clash (mids swapped at the bass swap)")
    if c.get("bass_holes"):
        risks.append(f"the floor loses its bass for {c['bass_holes']} bar(s)")
    if c.get("out_bass_dropouts"):
        risks.append(f"outgoing bass drops out for {c['out_bass_dropouts']} bar(s) before the swap")
    if c.get("out_energy_falling"):
        parts.append("outgoing energy is winding down there")
    parts.append("risks: " + ("; ".join(risks) if risks else "none"))
    return ", ".join(parts)


def _track_lines(label: str, t: Dict[str, Any]) -> str:
    lines = [f"{label}: {t.get('title', '?')} | {float(t.get('bpm', 0)):.1f} BPM | key {t.get('camelot', '?')}"
             f" | length {_mmss(t.get('duration'))}"]
    if t.get("position") is not None:
        lines.append(f"  now playing at {_mmss(t.get('position'))}")
    for s in (t.get("sections") or [])[:14]:
        lines.append(f"  {_mmss(s.get('time'))} {s.get('type', '?')} energy {float(s.get('energy', 0)):.2f}"
                     f"{' vocals' if s.get('vocals') else ''}")
    return "\n".join(lines)


def _gemini_choice(out_t, in_t, cands, key, model, timeout) -> Tuple[Optional[Dict[str, str]], Optional[str]]:
    options = "\n".join(f"{c['id']}: {describe(c)}" for c in cands)
    prompt = f"""You are a headline club DJ deciding how to mix into the next record.

{_track_lines('OUTGOING (playing now)', out_t)}

{_track_lines('INCOMING (cued)', in_t)}

Every option below is already technically perfect: beatmatched at one master tempo, keylocked,
bass swapped on a downbeat with an isolator, loudness matched. Choose on musicality only:
phrasing, energy flow on the dancefloor, avoiding vocal or melody clashes, not cutting the
outgoing track's best moment short, and not waiting needlessly long. A blend keeps the floor
moving and is the default; an overlap-free echo-out is a reset a good DJ uses sparingly, when
blending would lay two lead vocals on top of each other.

OPTIONS:
{options}

Return JSON: {{"choice": "<option id>", "reason": "<one sentence a DJ would say>"}}"""
    res, err = call_gemini_api(prompt, key, model_name=model, timeout=timeout)
    if res and isinstance(res, dict) and res.get("choice"):
        return {"choice": str(res["choice"]).strip(), "reason": str(res.get("reason", ""))}, None
    return None, err or "Gemini returned no choice"


def _jev_choice(out_t, in_t, cands, key, timeout) -> Tuple[Optional[Dict[str, str]], Optional[str]]:
    state = {
        "outgoing_track": {k: out_t.get(k) for k in ("title", "bpm", "camelot", "duration", "position")},
        "incoming_track": {k: in_t.get(k) for k in ("title", "bpm", "camelot", "duration")},
        "note": "All options are beatmatched, bass-swapped on a downbeat and loudness matched.",
    }
    payload = {
        "model": "jev-latest",
        "state": state,
        "questions": {
            "pick": {
                "type": "choice",
                "instructions": "Which transition sounds best on a club dancefloor: good phrasing and energy "
                                "flow, no vocal or melody clash, no needless waiting? Blends keep the floor "
                                "moving; an echo-out is a reset to use sparingly.",
                "criteria": {c["id"]: describe(c) for c in cands},
            }
        },
    }
    req = urllib.request.Request(
        "https://api.typesafe.ai/v1/systemone",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json",
                 "User-Agent": "PulseProDJ/1.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        ans = data.get("answers", data).get("pick", {})
        choice = ans.get("choice") or ans.get("value")
        if choice:
            return {"choice": str(choice).strip(), "reason": "Jev System One single-pass pick"}, None
        return None, "Jev returned no choice"
    except Exception as e:
        return None, str(e)


def choose_transition(out_t: Dict[str, Any], in_t: Dict[str, Any], candidates: List[Dict[str, Any]],
                      model: Optional[str] = None, budget_sec: float = 8.0,
                      gemini_api_key: Optional[str] = None, jev_api_key: Optional[str] = None) -> Dict[str, Any]:
    """Returns {choice, reason, engine, latency_ms, errors}; choice is None when no engine answered
    in time with a valid candidate id (the caller then keeps the planner's first candidate).
    All engines are asked at once; the first in engine_order(model) that answers validly within
    the budget wins, so a slow Gemini still leaves Jev's answer instead of nothing."""
    t0 = time.monotonic()
    ids = {c.get("id") for c in candidates}
    errors: Dict[str, str] = {}
    gemini_model = model if (model or "").lower().startswith("gemini") else DEFAULT_GEMINI_MODEL
    calls = {}
    for engine in engine_order(model) if len(candidates) > 1 else []:
        if engine == "gemini":
            key = get_gemini_api_key(gemini_api_key)
            if key:
                calls[engine] = (f"Gemini ({gemini_model})", functools.partial(
                    _gemini_choice, out_t, in_t, candidates, key, gemini_model, budget_sec))
        else:
            key = get_jev_api_key(jev_api_key)
            if key:
                calls[engine] = ("Jev System One", functools.partial(
                    _jev_choice, out_t, in_t, candidates, key, min(budget_sec, 4.0)))
    if calls:
        pool = ThreadPoolExecutor(max_workers=len(calls))
        futures = {engine: pool.submit(fn) for engine, (_, fn) in calls.items()}
        pool.shutdown(wait=False)
        for engine, (name, _) in calls.items():  # preference order
            try:
                res, err = futures[engine].result(timeout=max(0.0, budget_sec - (time.monotonic() - t0)))
            except FutureTimeout:
                res, err = None, "timed out"
            except Exception as e:  # noqa: BLE001 - any engine failure falls through to the next
                res, err = None, str(e)
            if res and res["choice"] in ids:
                return {"choice": res["choice"], "reason": res["reason"], "engine": name,
                        "latency_ms": int((time.monotonic() - t0) * 1000), "errors": errors}
            errors[engine] = err or f"invalid choice {res and res.get('choice')!r}"
    return {"choice": None, "reason": "", "engine": "planner",
            "latency_ms": int((time.monotonic() - t0) * 1000), "errors": errors}
