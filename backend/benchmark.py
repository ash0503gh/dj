"""
benchmark.py - The yardstick for every change to the mixing (roadmap Phase 2). Run it before and after a
change and compare.

  Library      prepared tracks; whose kicks wander off their grid (grid check) and how far; how far
               apart the tracks' loudness sits (what the trim has to make up)
  Tags         against the BPM and key the files' own tags give (DJ software and stores write them):
               the grid's BPM, the key used for mixing and the analyzer's old key estimate
  Neural       what the neural beat tracker decided: downbeats it moved, tempos it refitted or disputed,
               how much of each track the grid and its beats agree on
  Pairs        every pair of prepared tracks: share that can blend (tempos within 12%, at their own,
               half or double tempo), share 12-20% apart (tempo ramps, Phase 5, would let them blend),
               share only a switch can join; keys that sit together among the blends; tracks with no
               track to blend with
  Played       the Auto mixes the DJ rated (GOOD / NOT FOR ME): share liked, by kind of mix; blends vs
               switches; kick flam and loudness jumps the sound check measured; reasons given

    python -m backend.benchmark [--json]          (local mode: PULSE_LIBRARY set)
"""

import argparse
import json
import os
from collections import Counter
from contextlib import closing
from typing import Any, Dict, List

import numpy as np

from . import library, next_track

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAMP_GAP = 0.20     # tempo gaps a ramp could bridge (roadmap Phase 5)


def _pct(xs: List[float], q: float):
    return round(float(np.percentile(xs, q)), 1) if xs else None


def library_report(analyses: List[Dict[str, Any]]) -> Dict[str, Any]:
    spreads = [a.get("grid_err_spread_ms") for a in analyses if a.get("grid_err_spread_ms") is not None]
    flagged = [a for a in analyses if "grid_drift" in library.flags_for(a)]
    body = [a["loudness_body_lufs"] for a in analyses if a.get("loudness_body_lufs") is not None]
    mid = float(np.median(body)) if body else None
    return {
        "tracks": len(analyses),
        "grid_checked": len(spreads),
        "grid_wander_ms": {"median": _pct(spreads, 50), "p90": _pct(spreads, 90), "max": _pct(spreads, 100)},
        "grid_drift_tracks": len(flagged),
        "worst_grids": [{"title": a.get("title"), "spread_ms": a.get("grid_err_spread_ms")}
                        for a in sorted(flagged, key=lambda a: -(a.get("grid_err_spread_ms") or 0))[:5]],
        "body_lufs": {"p10": _pct(body, 10), "median": _pct(body, 50), "p90": _pct(body, 90)},
        # The trim reaches 6 dB: a track further than that from the library's middle can't be matched to it
        "past_trim_reach": sum(1 for v in body if mid is not None and abs(v - mid) > 6),
    }


def tags_report(analyses: List[Dict[str, Any]]) -> Dict[str, Any]:
    keyed = [a for a in analyses if (a.get("tags") or {}).get("camelot")]
    timed = [a for a in analyses if (a.get("tags") or {}).get("bpm") and a.get("bpm")]

    def keys(field):
        hits = [a for a in keyed if a.get(field)]
        if not hits:
            return None
        same = sum(a[field] == a["tags"]["camelot"] for a in hits)
        mixes = sum(next_track.key_severity(a[field], a["tags"]["camelot"]) == 0 for a in hits)
        return {"tracks": len(hits), "same": round(same / len(hits), 3), "compatible": round(mixes / len(hits), 3)}

    bpm_ok = [any(abs(a["bpm"] * m / a["tags"]["bpm"] - 1) <= 0.01 for m in (1, 2, 0.5)) for a in timed]
    return {
        "key_tagged": len(keyed),
        "key_now": keys("camelot"),         # the key mixes use (Essentia's when it ran)
        "key_old": keys("key_ks"),          # the analyzer's own estimate
        "bpm_tagged": len(timed),
        "bpm_agree": round(sum(bpm_ok) / len(timed), 3) if timed else None,   # within 1%, or at half/double
        "bpm_disagree_titles": [a.get("title") for a, ok in zip(timed, bpm_ok) if not ok][:10],
    }


def neural_report(analyses: List[Dict[str, Any]]) -> Dict[str, Any]:
    run = [a for a in analyses if a.get("nn_beats")]
    grids = [a.get("grid") or {} for a in run]
    agree = [g["nn_agree"] for g in grids if g.get("nn_agree") is not None]
    return {
        "tracks": len(run),
        "downbeat_by_neural": sum(g.get("downbeat_source") == "neural" for g in grids),
        "tempo_refitted": sum(g.get("tempo_source") == "neural" for g in grids),
        "tempo_conflict": sum(bool(g.get("tempo_conflict")) for g in grids),
        "agree": {"median": round(float(np.median(agree)), 3) if agree else None,
                  "p10": round(float(np.percentile(agree, 10)), 3) if agree else None},
    }


def pairs_report(analyses: List[Dict[str, Any]]) -> Dict[str, Any]:
    tracks = [a for a in analyses if (a.get("bpm") or 0) > 0]
    n = blend = near = switch = keys_ok = 0
    partners = Counter()
    for a in tracks:
        for b in tracks:
            if a is b:
                continue
            n += 1
            gap, multiple = next_track.tempo_fit(a["bpm"], b["bpm"])
            if multiple is not None:
                blend += 1
                partners[a.get("title")] += 1
                keys_ok += next_track.key_severity(a.get("camelot"), b.get("camelot")) == 0
            elif min(abs(a["bpm"] / (b["bpm"] * m) - 1) for m in (1, 2, 0.5)) <= RAMP_GAP:
                near += 1
            else:
                switch += 1
    share = (lambda k: round(k / n, 3)) if n else (lambda k: None)
    orphans = [a.get("title") for a in tracks if not partners[a.get("title")]]
    return {
        "pairs": n,
        "blend": share(blend), "ramp_12_20": share(near), "switch_only": share(switch),
        "blend_keys_together": round(keys_ok / blend, 3) if blend else None,
        "no_blend_partner": len(orphans), "no_blend_partner_titles": orphans[:10],
    }


def played_report(ratings: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not ratings:
        return {"rated": 0}
    kinds = Counter()
    liked = Counter()
    for r in ratings:
        kind = (r.get("keys") or ["?"])[0]
        kinds[kind] += 1
        liked[kind] += r.get("rating", 0)
    blends = [r.get("measured") or {} for r in ratings if (r.get("keys") or [""])[0] == "blend"]
    flam = [m["kick_flam_ms"] for m in blends if isinstance(m.get("kick_flam_ms"), (int, float))]
    jumps = [max(m.get("loudness_bump_db") or 0, -(m.get("loudness_dip_db") or 0))
             for r in ratings for m in [r.get("measured") or {}] if m]
    return {
        "rated": len(ratings),
        "good": round(sum(r.get("rating", 0) for r in ratings) / len(ratings), 3),
        "by_kind": {k: {"rated": kinds[k], "good": round(liked[k] / kinds[k], 3)} for k in kinds},
        "blend_share": round(kinds["blend"] / len(ratings), 3),
        "kick_flam_ms": {"median": _pct(flam, 50), "p90": _pct(flam, 90), "over_10": sum(v > 10 for v in flam)},
        "loudness_jump_db": {"median": _pct(jumps, 50), "p90": _pct(jumps, 90)},
        "reasons": dict(Counter(r["reason"] for r in ratings if r.get("reason"))),
    }


def load_ratings() -> List[Dict[str, Any]]:
    try:
        with open(os.path.join(BASE_DIR, "uploads", "feedback.json")) as f:
            return list(json.load(f).get("ratings") or [])
    except (OSError, ValueError):
        return []


def report() -> Dict[str, Any]:
    with closing(library._connect()) as con:
        rows = con.execute("SELECT analysis FROM tracks WHERE status = 'ready' AND analysis IS NOT NULL").fetchall()
    analyses = [json.loads(r["analysis"]) for r in rows]
    return {"library": library_report(analyses), "tags": tags_report(analyses), "neural": neural_report(analyses),
            "pairs": pairs_report(analyses), "played": played_report(load_ratings())}


def _fmt(rep: Dict[str, Any]) -> str:
    L, T, N, P, R = rep["library"], rep["tags"], rep["neural"], rep["pairs"], rep["played"]
    pc = lambda v: "-" if v is None else f"{100 * v:.0f}%"  # noqa: E731
    lines = [
        f"LIBRARY  {L['tracks']} tracks, {L['grid_checked']} grid-checked",
        f"  kicks off the grid across a track: median {L['grid_wander_ms']['median']} ms, "
        f"p90 {L['grid_wander_ms']['p90']} ms, worst {L['grid_wander_ms']['max']} ms; "
        f"{L['grid_drift_tracks']} tracks flagged",
    ] + [f"    {w['title']}: {w['spread_ms']} ms" for w in L["worst_grids"]] + [
        f"  body loudness: p10 {L['body_lufs']['p10']} / median {L['body_lufs']['median']} / "
        f"p90 {L['body_lufs']['p90']} LUFS; {L['past_trim_reach']} tracks past the trim's 6 dB",
        (f"TAGS  key tags on {T['key_tagged']} tracks: key now "
         + (f"{pc(T['key_now']['same'])} same, {pc(T['key_now']['compatible'])} mix together" if T["key_now"] else "-")
         + "; old estimate "
         + (f"{pc(T['key_old']['same'])} same, {pc(T['key_old']['compatible'])} mix together" if T["key_old"] else "-")),
        f"  BPM tags on {T['bpm_tagged']} tracks: grid agrees on {pc(T['bpm_agree'])}"
        + (f" (not: {', '.join(T['bpm_disagree_titles'])})" if T["bpm_disagree_titles"] else ""),
        (f"NEURAL  {N['tracks']} tracks: downbeat set by it on {N['downbeat_by_neural']}, tempo refitted on "
         f"{N['tempo_refitted']}, disputed on {N['tempo_conflict']}; its beats on the grid: median "
         f"{pc(N['agree']['median'])}, p10 {pc(N['agree']['p10'])}")
        if N["tracks"] else "NEURAL  not run (install requirements-local.txt: ./setup_mac.sh)",
        f"PAIRS  {P['pairs']} ordered pairs: blend {pc(P['blend'])}, 12-20% apart {pc(P['ramp_12_20'])}, "
        f"switch only {pc(P['switch_only'])}; keys together in {pc(P['blend_keys_together'])} of blends",
        f"  {P['no_blend_partner']} tracks with no track to blend with"
        + (f": {', '.join(P['no_blend_partner_titles'])}" if P["no_blend_partner_titles"] else ""),
    ]
    if R["rated"]:
        kinds = ", ".join(f"{k} {v['rated']} ({pc(v['good'])} good)" for k, v in R["by_kind"].items())
        lines += [
            f"PLAYED  {R['rated']} rated mixes, {pc(R['good'])} GOOD; {kinds}",
            f"  blends: kick flam median {R['kick_flam_ms']['median']} ms, p90 {R['kick_flam_ms']['p90']} ms, "
            f"{R['kick_flam_ms']['over_10']} over 10 ms",
            f"  loudness jump: median {R['loudness_jump_db']['median']} dB, p90 {R['loudness_jump_db']['p90']} dB",
        ] + ([f"  reasons: {R['reasons']}"] if R["reasons"] else [])
    else:
        lines.append("PLAYED  no rated mixes yet (rate Auto mixes GOOD / NOT FOR ME)")
    return "\n".join(lines)


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="python -m backend.benchmark", description=__doc__.split("\n\n")[0])
    ap.add_argument("--json", action="store_true", help="print the report as JSON")
    args = ap.parse_args(argv)
    if not library.enabled():
        ap.error("set PULSE_LIBRARY (local mode)")
    rep = report()
    print(json.dumps(rep, indent=2) if args.json else _fmt(rep))


if __name__ == "__main__":
    main()
