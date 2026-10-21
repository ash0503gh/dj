"""
key_detect.py - The track's key over the whole track, and the BPM and key its file's tags already give.

The analyzer's own estimate (Krumhansl profiles on 45 seconds from 15% in) is kept as `key_ks`; the key
used for mixing comes from Essentia's key extractor over the whole track with its EDM profile ('edma',
Faraldo et al. 2016), when Essentia is installed. On synthetic tracks it named the right Camelot number
every time (the relative major of a minor progression: 8B for 8A, which mix together) where the old
estimate put one a wrong number. Real tracks are judged against their files' key tags (Mixed In Key,
rekordbox, Beatport write them), which `python -m backend.benchmark` compares with both estimates.
"""

import importlib.util
import json
import re
import subprocess
from typing import Any, Dict, Optional

from .audio_analyzer import CAMELOT_MAP, PITCH_CLASSES, load_mono

SR = 44100
FLATS = {"DB": "C#", "EB": "D#", "GB": "F#", "AB": "G#", "BB": "A#", "CB": "B", "FB": "E", "E#": "F", "B#": "C"}


def available() -> bool:
    return importlib.util.find_spec("essentia") is not None


def _pitch_class(name: str) -> Optional[str]:
    """"C", "C#", "Db", "Cs", "C♯" ... as one of PITCH_CLASSES (sharps); None when it isn't a note name."""
    n = name.strip().replace("♯", "#").replace("♭", "b")
    if not n or n[0].upper() not in "ABCDEFG":
        return None
    root, acc = n[0].upper(), n[1:]
    if acc == "":
        return root
    if acc in ("#", "s"):
        return root + "#" if root + "#" in PITCH_CLASSES else FLATS.get(root + "#")   # E# is F, B# is C
    if acc == "b":
        return FLATS.get(root + "B")
    return None


def camelot_of(root: str, mode: str) -> Optional[str]:
    pc = _pitch_class(root)
    return CAMELOT_MAP.get((pc, mode)) if pc else None


def tag_camelot(raw: Optional[str]) -> Optional[str]:
    """A key tag in any of the usual notations as Camelot: "8A", "08A", "1m" / "1d" (Open Key), "Am",
    "A minor", "Amin", "F#m", "Bbmaj", "C" (major). None when it can't be read."""
    if not raw:
        return None
    s = str(raw).strip()
    m = re.fullmatch(r"0?(1[0-2]|[1-9])\s*([ABab])", s)
    if m:
        return f"{int(m.group(1))}{m.group(2).upper()}"
    m = re.fullmatch(r"0?(1[0-2]|[1-9])\s*([mdMD])", s)
    if m:   # Open Key: 1m = A minor = 8A, 1d = C major = 8B
        return f"{(int(m.group(1)) + 6) % 12 + 1}{'A' if m.group(2).lower() == 'm' else 'B'}"
    m = re.fullmatch(r"([A-Ga-g])\s*([#♯b♭s]?)\s*(m|min|minor|moll|maj|major|dur)?", s, flags=re.I)
    if m:
        mode = "minor" if (m.group(3) or "").lower() in ("m", "min", "minor", "moll") else "major"
        return camelot_of(m.group(1) + m.group(2), mode)
    return None


def read_tags(path: str) -> Dict[str, Any]:
    """The BPM and key the file's tags give (DJ software and stores write them), as read by ffprobe."""
    out = subprocess.run(['ffprobe', '-v', 'quiet', '-show_entries', 'format_tags:stream_tags', '-of', 'json', path],
                         capture_output=True, text=True).stdout
    tags = {}
    try:
        data = json.loads(out or "{}")
        for block in [data.get("format", {})] + data.get("streams", []):
            tags.update({k.lower(): v for k, v in (block.get("tags") or {}).items()})
    except ValueError:
        pass
    bpm = None
    for k in ("tbpm", "bpm", "tempo"):
        try:
            bpm = float(str(tags[k]).replace(",", "."))
            break
        except (KeyError, ValueError):
            continue
    key = next((tags[k] for k in ("tkey", "initialkey", "initial key", "key") if tags.get(k)), None)
    return {"bpm": bpm if bpm and 40 <= bpm <= 250 else None, "key": key, "camelot": tag_camelot(key)}


def detect_key(path: str) -> Dict[str, Any]:
    """The whole track's key by Essentia's EDM profile: display name, mode, Camelot and strength (0-1)."""
    import essentia
    essentia.log.infoActive = False
    import essentia.standard as es
    key, scale, strength = es.KeyExtractor(profileType="edma", sampleRate=SR)(load_mono(path, SR))
    pc = _pitch_class(key)
    if pc is None or scale not in ("major", "minor"):
        raise RuntimeError(f"key: unreadable result {key} {scale}")
    return {"key": f"{pc} {scale.capitalize()}", "mode": scale, "camelot": CAMELOT_MAP[(pc, scale)],
            "key_strength": round(float(strength), 3), "key_source": "essentia-edma"}
