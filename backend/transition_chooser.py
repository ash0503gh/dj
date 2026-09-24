"""
transition_chooser.py - The AI picks one of the planner's transitions.

The browser's MixPlanner builds a few candidate transitions that are all technically safe
(master tempo, bass swapped in 30 ms on a downbeat, loudness matched, phrase-aligned). The AI
only makes the musical choice between them: which phrase to leave on, how long to blend, and
whether to echo out instead. The planner then performs the chosen one exactly as planned, so an
AI answer can never put a hole or a flam in the mix.

Gemini and Jev are asked in parallel within a time budget: Gemini picks one candidate and
explains why; Jev (a fast classifier that answers many typed questions in one request) rates
every candidate on phrasing, energy, vocals, crowd and overall. The console combines both with
its own sound-check measurements. With no usable answer the planner's own choice stands.
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


# What Jev rates for every candidate, each on a 0-4 scale (criteria = what each level means)
JEV_CRITERIA = {
    "phrasing": ["Cuts across a phrase or leaves mid-idea", "Weak phrase alignment", "Acceptable phrasing",
                 "Leaves and lands on phrase lines", "Perfect: major phrase out, phrase start in"],
    "energy": ["Energy crashes or spikes awkwardly", "Noticeable energy dip or jump", "Neutral energy flow",
               "Energy carries smoothly into the new track", "Energy lifts the floor exactly when it should"],
    "vocals": ["Two lead vocals or melodies collide", "Likely clash", "Some overlap, manageable",
               "Mostly clean", "No vocal or melody collision at all"],
    "crowd": ["The dancefloor would stall", "Loses the room a little", "Holds the room",
              "Keeps the floor moving", "Builds excitement, crowd-pleasing"],
    "overall": ["Poor transition", "Below average", "Fine", "Very good", "Excellent: a headline DJ would pick it"],
}


def _jev_scores(out_t, in_t, cands, key, timeout) -> Tuple[Optional[Dict[str, Dict[str, float]]], Optional[str]]:
    """One Jev request rating every candidate on every criterion (candidates x 5 questions).
    Returns {id: {criterion: 0-4}} or (None, error)."""
    state = {
        "outgoing_track": {k: out_t.get(k) for k in ("title", "bpm", "camelot", "duration", "position")},
        "incoming_track": {k: in_t.get(k) for k in ("title", "bpm", "camelot", "duration")},
        "candidates": {c["id"]: describe(c) for c in cands},
        "note": "All candidates are beatmatched, bass-swapped on a downbeat and loudness matched. "
                "Blends keep the floor moving; an echo-out is a reset to use sparingly.",
    }
    questions = {}
    for c in cands:
        for crit, levels in JEV_CRITERIA.items():
            questions[f"{c['id']}_{crit}"] = {
                "type": "score",
                "instructions": f"Club DJ transition, candidate {c['id']}: {describe(c)}. Rate its {crit}.",
                "criteria": levels,
            }
    payload = {"model": "jev-latest", "state": state, "questions": questions}
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
    except Exception as e:  # noqa: BLE001 - network/API failure: no scores this time
        return None, str(e)
    answers = data.get("answers", data)
    scores: Dict[str, Dict[str, float]] = {}
    for c in cands:
        row = {}
        for crit in JEV_CRITERIA:
            ans = answers.get(f"{c['id']}_{crit}") or {}
            val = ans.get("score") if isinstance(ans, dict) and ans.get("score") is not None else (
                ans.get("value") if isinstance(ans, dict) else ans)
            try:
                row[crit] = round(max(0.0, min(4.0, float(val))), 2)
            except (TypeError, ValueError):
                continue
        if row:
            row["mean"] = round(sum(row.values()) / len(row), 2)
            scores[c["id"]] = row
    if len(scores) < len(cands):
        return None, f"Jev scored {len(scores)}/{len(cands)} candidates"
    return scores, None


def choose_transition(out_t: Dict[str, Any], in_t: Dict[str, Any], candidates: List[Dict[str, Any]],
                      model: Optional[str] = None, budget_sec: float = 8.0,
                      gemini_api_key: Optional[str] = None, jev_api_key: Optional[str] = None) -> Dict[str, Any]:
    """Gemini picks one candidate while Jev rates every candidate on five criteria, in parallel and
    within the time budget. Returns {choice, reason, engine, gemini_choice, scores, latency_ms,
    errors}: choice is the preferred engine's pick (Gemini by default; Jev's best-rated when Jev is
    selected or Gemini has no answer), None when neither answered. The console combines the
    Gemini pick, the Jev scores and its own sound check into the final choice."""
    t0 = time.monotonic()
    ids = [c.get("id") for c in candidates]
    errors: Dict[str, str] = {}
    order = engine_order(model) if len(candidates) > 1 else []
    gemini_model = model if (model or "").lower().startswith("gemini") else DEFAULT_GEMINI_MODEL
    calls = {}
    if "gemini" in order and get_gemini_api_key(gemini_api_key):
        calls["gemini"] = functools.partial(_gemini_choice, out_t, in_t, candidates,
                                            get_gemini_api_key(gemini_api_key), gemini_model, budget_sec)
    if "jev" in order and get_jev_api_key(jev_api_key):
        calls["jev"] = functools.partial(_jev_scores, out_t, in_t, candidates,
                                         get_jev_api_key(jev_api_key), min(budget_sec, 5.0))
    results: Dict[str, Any] = {}
    latency: Dict[str, int] = {}
    def timed(engine, fn):
        try:
            return fn()
        finally:
            latency[engine] = int((time.monotonic() - t0) * 1000)

    if calls:
        pool = ThreadPoolExecutor(max_workers=len(calls))
        futures = {engine: pool.submit(timed, engine, fn) for engine, fn in calls.items()}
        pool.shutdown(wait=False)
        for engine, fut in futures.items():
            try:
                res, err = fut.result(timeout=max(0.0, budget_sec - (time.monotonic() - t0)))
            except FutureTimeout:
                res, err = None, "timed out"
            except Exception as e:  # noqa: BLE001 - any engine failure: carry on without it
                res, err = None, str(e)
            if engine == "gemini" and res and res["choice"] not in ids:
                res, err = None, f"invalid choice {res['choice']!r}"
            if res:
                results[engine] = res
            else:
                errors[engine] = err or f"{engine} gave no answer"

    gemini = results.get("gemini")
    scores = results.get("jev")
    jev_best = max(ids, key=lambda i: (scores[i]["mean"], -ids.index(i))) if scores else None
    picks = {
        "gemini": gemini and (gemini["choice"], gemini["reason"], f"Gemini ({gemini_model})"),
        "jev": jev_best and (jev_best, f"highest Jev rating ({scores[jev_best]['mean']:.1f}/4)", "Jev System One"),
    }
    choice, reason, engine = None, "", "planner"
    for name in order:
        if picks.get(name):
            choice, reason, engine = picks[name]
            break
    return {"choice": choice, "reason": reason, "engine": engine,
            "gemini_choice": gemini["choice"] if gemini else None,
            "gemini_reason": gemini["reason"] if gemini else "",
            "scores": scores, "latency_ms": int((time.monotonic() - t0) * 1000),
            "engine_latency_ms": latency, "errors": errors}
