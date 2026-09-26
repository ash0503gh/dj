"""
next_track.py - Which library track to load next, after the one on air.

Scored from the stored analyses alone (no AI, no audio): how close the tempo is (within
MAX_STRETCH the console can beat-match and blend; beyond it only switch), how well the keys sit
together (Camelot), how much room the track gives to blend in (instrumental intro before its lead
vocal, and not much quieter than its body), and how close its loudness is. The same song uploaded
under several names or decks is suggested once.
"""

from typing import Any, Dict, Iterable, List, Optional

MAX_STRETCH = 0.08           # frontend MixPlanner.MAX_STRETCH: tempo gap beyond which there is no blend
INTRO_BARS_FULL = 16         # an instrumental intro this long is all the room a blend needs


def _camelot(key: Optional[str]):
    try:
        return int(key[:-1]), key[-1].upper()
    except (TypeError, ValueError, IndexError):
        return None


def key_severity(a: Optional[str], b: Optional[str]) -> float:
    """How badly two Camelot keys clash, 0 (same, adjacent or relative) to 1 (opposite sides of the
    wheel); 0 when either is unknown. Same scale as the console's (app.js keySeverity)."""
    ka, kb = _camelot(a), _camelot(b)
    if not ka or not kb:
        return 0.0
    (na, la), (nb, lb) = ka, kb
    d = (nb - na) % 12
    if (na == nb) or (la == lb and d in (1, 11)):
        return 0.0
    steps = min(d, 12 - d) + (1 if la != lb else 0)
    return min(1.0, max(0.0, (steps - 1) / 5))


def features(an: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """What the ranking needs from one analysis, or None for something that isn't a playable song."""
    bpm, dur = float(an.get("bpm") or 0), float(an.get("duration") or 0)
    if bpm <= 0 or dur < 60:
        return None
    sections = an.get("section_map") or []
    labelled = bool(an.get("vocal_source"))
    intro = float(an.get("suggested_cue_intro") or 0)
    intro_s = intro_energy = None
    if labelled and sections:
        sung = [s["time"] for s in sections
                if s.get("has_vocals") and s.get("vocal_score", 0) > 0.35 and s["time"] + s["duration"] > intro]
        first = max(intro, min(sung)) if sung else dur
        intro_s = max(0.0, first - intro)
        energies = sorted(s.get("energy", 0) for s in sections)
        body = energies[len(energies) // 2] or 1.0
        before = [s.get("energy", 0) for s in sections if intro - 0.05 <= s["time"] < first]
        intro_energy = (sum(before) / len(before)) / body if before else None
    title = an.get("title") or an.get("filename") or an.get("file_id") or ""
    return {
        "file_id": an.get("file_id"),
        "title": title,
        "bpm": bpm,
        "camelot": an.get("camelot"),
        "loudness_db": an.get("loudness_db"),
        "bar_sec": 4 * 60.0 / bpm,
        "intro_s": intro_s,
        "intro_energy": intro_energy,
        "song": an.get("content_sha1") or song_key(title),
    }


def song_key(title: str) -> str:
    """The same song under another deck prefix or file name spelling."""
    t = (title or "").lower()
    for prefix in ("deck_1_", "deck_2_", "lib_"):
        if t.startswith(prefix):
            t = t[len(prefix):]
    t = t.rsplit(".", 1)[0]
    return "".join(ch for ch in t if ch.isalnum())


def score(out: Dict[str, Any], master_bpm: float, cand: Dict[str, Any]) -> Dict[str, Any]:
    """0-100 for playing `cand` after `out` (on air at `master_bpm`), with the reasons in words."""
    gap = master_bpm / cand["bpm"] - 1
    g = abs(gap)
    blend = g <= MAX_STRETCH
    if g <= 0.02:
        tempo = 40.0
    elif blend:
        tempo = 40 - 15 * (g - 0.02) / (MAX_STRETCH - 0.02)
    else:
        tempo = max(0.0, 15 - 100 * (g - MAX_STRETCH))
    sev = key_severity(out.get("camelot"), cand.get("camelot"))
    key = 30 * (1 - sev)
    reasons = [f"blends ({g * 100:.1f}% tempo)" if blend else f"tempo {g * 100:.0f}% away: switch only"]
    reasons.append("keys match" if sev == 0 else f"keys {'clash' if sev >= 0.6 else 'rub'} ({out.get('camelot')}→{cand.get('camelot')})")
    intro_bars = None
    if not blend:
        room = 10.0                       # lands on its drop: the intro doesn't matter
    elif cand.get("intro_s") is None:
        room = 10.0                       # no vocal labels: unknown
    else:
        intro_bars = int(cand["intro_s"] / cand["bar_sec"])
        room = 20 * min(1.0, intro_bars / INTRO_BARS_FULL)
        if cand.get("intro_energy") is not None:
            room *= min(1.0, cand["intro_energy"] / 0.8)   # a quiet intro drops the floor at the swap
        if intro_bars >= 8:
            reasons.append(f"{intro_bars}-bar intro before its vocals")
    energy = 10.0
    if out.get("loudness_db") is not None and cand.get("loudness_db") is not None:
        diff = abs(out["loudness_db"] - cand["loudness_db"])
        energy = max(0.0, 10 - 2.5 * max(0.0, diff - 2))
        if diff > 4:
            reasons.append(f"{diff:.0f} dB {'quieter' if cand['loudness_db'] < out['loudness_db'] else 'louder'}")
    return {
        "file_id": cand["file_id"],
        "title": cand["title"],
        "bpm": round(cand["bpm"], 2),
        "camelot": cand.get("camelot"),
        "score": int(round(tempo + key + room + energy)),
        "blend": blend,
        "tempo_pct": round(-gap * 100, 1),
        "key_severity": round(sev, 2),
        "intro_bars": intro_bars,
        "reasons": reasons,
    }


def rank(out: Dict[str, Any], master_bpm: float, library: Iterable[Dict[str, Any]],
         exclude: Iterable[str] = (), limit: int = 6) -> List[Dict[str, Any]]:
    """The best `limit` tracks to play after `out`, one copy per song, never `out` itself or a song
    in `exclude` (file ids: the other deck's track, tracks already played)."""
    lib = [c for c in library if c]
    ex = set(exclude)
    excluded = {c["song"] for c in lib if c["file_id"] in ex} | {out.get("song")}
    best: Dict[str, Dict[str, Any]] = {}
    for c in lib:
        if c["song"] in excluded:
            continue
        s = score(out, master_bpm, c)
        if c["song"] not in best or s["score"] > best[c["song"]]["score"]:
            best[c["song"]] = s
    return sorted(best.values(), key=lambda s: -s["score"])[:limit]
