"""
next_track.py - Which library track to load next, after the one on air.

Scored from the stored analyses alone (no AI, no audio), the way the console will really mix it
(MixPlanner.mixTempo): how close the tempo is (at the track's own tempo up to GLIDE_MAX apart, the two
meeting halfway past GLIDE_FROM, by a glide; at half or double its tempo up to MAX_STRETCH, the
incoming stretched, never glided; with MIX SOON no glide at all; beyond that only a switch), how well
the keys sit together (Camelot: half as much for a switch, where they are never heard together), how
much room the track gives to blend in (instrumental intro before its lead vocal, and not much quieter
than its body), and how close its loudness is. A track the console can blend is always suggested
before one it can only switch to. The same song under several names or decks is suggested once.
"""

from typing import Any, Dict, Iterable, List, Optional

MAX_STRETCH = 0.12           # frontend MixPlanner.MAX_STRETCH: the gap the incoming alone can take
GLIDE_FROM = 0.04            # frontend MixPlanner.GLIDE_FROM: past it the outgoing glides to meet it halfway
GLIDE_MAX = 0.20             # frontend MixPlanner.GLIDE_MAX: tempo gap beyond which there is no blend
CLEAN_STRETCH = 0.08         # frontend MixPlanner.CLEAN_STRETCH: stretching past it costs a little
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
        "loudness_body_lufs": an.get("loudness_body_lufs"),
        "bar_sec": 4 * 60.0 / bpm,
        "intro_s": intro_s,
        "intro_energy": intro_energy,
        "songs": song_ids(an, title),
    }


def song_ids(an: Dict[str, Any], title: str) -> List[str]:
    """Ways the same song shows up under another name: its fingerprint, its audio (the same duration,
    tempo and key: an analysis of the same audio gives the same ones) and its name."""
    ids = ["name:" + song_key(title)]
    if an.get("duration") and an.get("bpm"):
        ids.append(f"audio:{float(an['duration']):.1f}|{float(an['bpm']):.2f}|{an.get('camelot')}")
    if an.get("content_sha1"):
        ids.append("sha1:" + str(an["content_sha1"]))
    return ids


def song_key(title: str) -> str:
    """The same song under another deck prefix or file name spelling."""
    t = (title or "").lower()
    for prefix in ("deck_1_", "deck_2_", "lib_"):
        if t.startswith(prefix):
            t = t[len(prefix):]
    t = t.rsplit(".", 1)[0]
    return "".join(ch for ch in t if ch.isalnum())


def tempo_fit(master_bpm: float, bpm: float, glide: bool = True):
    """(gap, multiple): the tempo gap at the multiple of its tempo a blend can match, as the console's
    MixPlanner.mixTempo decides (its own tempo first; 2: at half time, 0.5: at double time), or its own
    gap and None when no blend can. At its own tempo the two meet halfway by a glide, up to GLIDE_MAX
    apart either way round (`glide` False, MIX SOON: up to MAX_STRETCH); at half or double time the
    incoming alone takes the gap, up to MAX_STRETCH."""
    for m in (1, 2, 0.5):
        g = master_bpm / (bpm * m) - 1
        if abs(g) <= MAX_STRETCH or (m == 1 and glide and max(1 + g, 1 / (1 + g)) - 1 <= GLIDE_MAX):
            return g, m
    return master_bpm / bpm - 1, None


def score(out: Dict[str, Any], master_bpm: float, cand: Dict[str, Any], glide: bool = True) -> Dict[str, Any]:
    """0-100 for playing `cand` after `out` (on air at `master_bpm`), with the reasons in words.
    `glide` False: MIX SOON is on (no glide before a mix)."""
    gap, multiple = tempo_fit(master_bpm, cand["bpm"], glide)
    g = abs(gap)
    blend = multiple is not None
    if not blend:
        tempo = 0.0                       # a switch: no tempo to match
    elif g <= 0.02:
        tempo = 40.0
    elif g <= GLIDE_FROM:
        tempo = 40 - 4 * (g - 0.02) / (GLIDE_FROM - 0.02)          # the incoming keylocked, a little
    elif g <= MAX_STRETCH:
        tempo = 36 - 10 * (g - GLIDE_FROM) / (MAX_STRETCH - GLIDE_FROM)   # a short glide, or a stretch
    else:
        tempo = 26 - 10 * (g - MAX_STRETCH) / (GLIDE_MAX - MAX_STRETCH)   # a long glide: needs time
    if multiple in (2, 0.5):
        tempo -= 10                       # half or double time: the groove changes under the blend
    sev = key_severity(out.get("camelot"), cand.get("camelot"))
    key = (30 if blend else 15) * (1 - sev)   # a switch never plays the two keys together
    time = {2: " at half time", 0.5: " at double time"}.get(multiple, "")
    meet = ", meeting halfway" if g > GLIDE_FROM else ""
    reasons = [f"blends{time} ({g * 100:.1f}% tempo{meet})" if blend else f"tempo {g * 100:.0f}% away: switch only"]
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
    # Perceived loudness (LUFS) when both tracks are prepared, RMS otherwise: never one against the other
    level = "loudness_body_lufs" if out.get("loudness_body_lufs") is not None and \
        cand.get("loudness_body_lufs") is not None else "loudness_db"
    if out.get(level) is not None and cand.get(level) is not None:
        diff = abs(out[level] - cand[level])
        energy = max(0.0, 10 - 2.5 * max(0.0, diff - 2))
        if diff > 4:
            reasons.append(f"{diff:.0f} dB {'quieter' if cand[level] < out[level] else 'louder'}")
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
         exclude: Iterable[str] = (), limit: int = 6, glide: bool = True) -> List[Dict[str, Any]]:
    """The best `limit` tracks to play after `out`, one copy per song, never `out` itself or a song
    in `exclude` (file ids: the other deck's track, tracks already played). Tracks the console can
    blend come first, then those it can only switch to; by score within each."""
    lib = [c for c in library if c]
    ex = set(exclude)
    taken = set(out.get("songs") or []).union(*[c["songs"] for c in lib if c["file_id"] in ex])
    best = []
    scored = ((c, score(out, master_bpm, c, glide)) for c in lib)
    for c, s in sorted(scored, key=lambda cs: (not cs[1]["blend"], -cs[1]["score"])):
        if not taken.intersection(c["songs"]):   # the best-scoring copy of each song
            best.append(s)
        taken.update(c["songs"])
    return best[:limit]
