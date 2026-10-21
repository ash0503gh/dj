"""
sfx.py - The transition sound-effects library: risers into a drop, impacts on the landing, sweeps,
downlifters, sub drops, cymbals, horns, scratches and shouts, in sfx/ beside the code (git ignores it).

Two sources, both free to use at paid gigs:
  generated   synthesised here (`generate`): risers, sweeps, downlifters, impacts, sub drops, crashes,
              reverse cymbals, zaps. Ours, so no licence at all.
  freesound   recorded sounds from Freesound under Creative Commons 0 only (public domain: commercial
              use, no attribution needed), fetched with a free Freesound API key (`download`), within a
              size budget (2 GB by default). The HQ previews (MP3) are taken: originals need OAuth.

Every sound has a role, which says how the console places it against the beat:
  build   ends on the downbeat it leads into (a riser, an upward sweep, a reverse cymbal)
  fall    starts on a downbeat and falls away (a downlifter, a downward sweep)
  hit     starts on a beat (an impact, a sub drop, a crash, a horn, a scratch, a shout)

    python -m backend.sfx generate
    python -m backend.sfx download [--key KEY] [--per-category 40] [--max-gb 2]
    python -m backend.sfx list
"""

import argparse
import json
import os
import re
import sys
import time
from typing import Any, Dict, List, Optional

import numpy as np

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SFX_DIR = os.path.join(BASE_DIR, "sfx")
MANIFEST = os.path.join(SFX_DIR, "manifest.json")
SR = 44100

# category -> (role, what to search Freesound for)
CATEGORIES = {
    "riser": ("build", "riser uplifter build up"),
    "sweep_up": ("build", "white noise sweep up"),
    "reverse_cymbal": ("build", "reverse cymbal"),
    "downlifter": ("fall", "downlifter"),
    "sweep_down": ("fall", "white noise sweep down"),
    "impact": ("hit", "impact boom hit"),
    "sub_drop": ("hit", "sub drop 808 bass drop"),
    "crash": ("hit", "crash cymbal"),
    "zap": ("hit", "laser zap"),
    "air_horn": ("hit", "air horn"),
    "scratch": ("hit", "dj scratch vinyl"),
    "vocal_shout": ("hit", "vocal shout hey"),
}
FREESOUND_SEARCH = "https://freesound.org/apiv2/search/text/"
CC0 = "Creative Commons 0"


# ── Generated sounds ──

def _noise(n: int, seed: int) -> np.ndarray:
    return np.random.default_rng(seed).standard_normal(n)


def _band_sweep(noise: np.ndarray, f0: float, f1: float, q: float = 1.2) -> np.ndarray:
    """Noise through a band-pass whose centre glides exponentially from f0 to f1 (block by block)."""
    from scipy.signal import butter, sosfilt, sosfilt_zi
    out = np.zeros_like(noise)
    block = 1024
    n = len(noise)
    zi = None
    for i in range(0, n, block):
        f = f0 * (f1 / f0) ** (i / max(1, n - 1))
        lo, hi = f / (1 + 0.5 / q), min(0.45 * SR, f * (1 + 0.5 / q))
        sos = butter(2, [lo, hi], btype="band", fs=SR, output="sos")
        if zi is None or zi.shape[0] != sos.shape[0]:
            zi = sosfilt_zi(sos) * 0.0
        out[i:i + block], zi = sosfilt(sos, noise[i:i + block], zi=zi)
    return out


def _glide(f0: float, f1: float, n: int, curve: float = 1.0) -> np.ndarray:
    """Phase of a tone gliding exponentially from f0 to f1 Hz over n samples (curve > 1: later)."""
    x = (np.arange(n) / max(1, n - 1)) ** curve
    return 2 * np.pi * np.cumsum(f0 * (f1 / f0) ** x) / SR


def _saw(phase: np.ndarray) -> np.ndarray:
    return 2 * ((phase / (2 * np.pi)) % 1.0) - 1


def _cymbal(n: int, seed: int) -> np.ndarray:
    """A metal crash: six detuned square partials (the classic 808 ratios) and bright noise, decaying."""
    from scipy.signal import butter, sosfilt
    t = np.arange(n) / SR
    tone = sum(np.sign(np.sin(2 * np.pi * f * t)) for f in (205.3, 304.4, 369.6, 522.7, 540.0, 800.0))
    tone = sosfilt(butter(4, [3000, 12000], btype="band", fs=SR, output="sos"), tone)
    hiss = sosfilt(butter(4, 5000, btype="high", fs=SR, output="sos"), _noise(n, seed))
    return (0.5 * tone / (np.abs(tone).max() + 1e-9) + hiss / (np.abs(hiss).max() + 1e-9)) * np.exp(-t / (n / SR / 4))


def _room(x: np.ndarray, seconds: float = 1.8, seed: int = 7) -> np.ndarray:
    """x with a decaying noise reverb tail mixed in."""
    from scipy.signal import fftconvolve
    n = int(seconds * SR)
    ir = _noise(n, seed) * np.exp(-6.9 * np.arange(n) / n)
    wet = fftconvolve(x, ir)
    out = np.zeros(len(wet))
    out[:len(x)] += x
    return out + 0.25 * wet / (np.abs(wet).max() + 1e-9) * np.abs(x).max()


def _fade(x: np.ndarray, attack: float = 0.005, release: float = 0.02) -> np.ndarray:
    a, r = int(attack * SR), int(release * SR)
    x = x.copy()
    x[:a] *= np.linspace(0, 1, a)
    x[-r:] *= np.linspace(1, 0, r)
    return x


def _stereo(x: np.ndarray, seed: int, width: float = 0.3) -> np.ndarray:
    """A stereo pair: x plus a little decorrelated noise-shaped difference (not mono in the middle)."""
    d = np.roll(x, int(0.0007 * SR + seed % 7))
    return np.vstack([x + width * (d - x) / 2, x - width * (d - x) / 2])


def _riser(sec: float, seed: int) -> np.ndarray:
    n = int(sec * SR)
    env = (np.arange(n) / n) ** 2.2
    noise = _band_sweep(_noise(n, seed), 300, 9000)
    tone = sum(_saw(_glide(110 * k, 880 * k, n, 1.6) + 0.3 * j) for j, k in enumerate((1.0, 1.005, 0.995)))
    x = (noise / np.abs(noise).max() + 0.35 * tone / 3) * env
    return _fade(x, 0.02, 0.01)


def _sweep(sec: float, seed: int, up: bool) -> np.ndarray:
    n = int(sec * SR)
    f0, f1 = (200, 10000) if up else (10000, 200)
    x = _band_sweep(_noise(n, seed), f0, f1, q=0.9)
    env = (np.arange(n) / n) ** 1.5 if up else (1 - np.arange(n) / n) ** 1.5
    return _fade(x / np.abs(x).max() * env, 0.02, 0.03)


def _downlifter(sec: float, seed: int) -> np.ndarray:
    n = int(sec * SR)
    env = (1 - np.arange(n) / n) ** 1.8
    noise = _band_sweep(_noise(n, seed), 8000, 150)
    tone = _saw(_glide(900, 60, n, 0.7))
    return _fade((noise / np.abs(noise).max() + 0.4 * tone) * env, 0.005, 0.05)


def _impact(seed: int, low: float) -> np.ndarray:
    n = int(1.6 * SR)
    t = np.arange(n) / SR
    boom = np.sin(_glide(low * 2.2, low, n, 0.25)) * np.exp(-t / 0.45)
    from scipy.signal import butter, sosfilt
    crack = sosfilt(butter(2, 2500, btype="low", fs=SR, output="sos"), _noise(n, seed)) * np.exp(-t / 0.08)
    return _fade(_room(boom + 0.6 * crack / np.abs(crack).max(), 1.8, seed), 0.001, 0.2)


def _sub_drop(sec: float) -> np.ndarray:
    n = int(sec * SR)
    t = np.arange(n) / SR
    return _fade(np.sin(_glide(75, 28, n, 0.6)) * np.exp(-t / (sec / 2.5)), 0.002, 0.1)


def _zap(seed: int) -> np.ndarray:
    n = int(0.35 * SR)
    t = np.arange(n) / SR
    x = np.tanh(2.5 * np.sin(_glide(2400 - 400 * (seed % 3), 70, n, 0.35))) * np.exp(-t / 0.15)
    return _fade(x, 0.001, 0.03)


def _recipes() -> List[Dict[str, Any]]:
    """What `generate` makes: (category, name, how). Seeds fixed: the same files every time."""
    r = []
    for sec in (4, 8, 16):
        for seed in (1, 2):
            r.append(("riser", f"Riser {sec}s {'AB'[seed - 1]}", lambda sec=sec, seed=seed: _riser(sec, seed)))
    for sec in (2, 4, 8):
        r.append(("sweep_up", f"Noise sweep up {sec}s", lambda sec=sec: _sweep(sec, 11 + sec, True)))
        r.append(("downlifter", f"Downlifter {sec}s", lambda sec=sec: _downlifter(sec, 21 + sec)))
    for sec in (2, 4):
        r.append(("sweep_down", f"Noise sweep down {sec}s", lambda sec=sec: _sweep(sec, 31 + sec, False)))
        r.append(("reverse_cymbal", f"Reverse cymbal {sec}s",
                  lambda sec=sec: _fade(_cymbal(int(sec * SR), 41 + sec)[::-1], 0.05, 0.005)))
        r.append(("crash", f"Crash {sec}s", lambda sec=sec: _fade(_cymbal(int(sec * SR), 51 + sec), 0.001, 0.1)))
    for i, low in enumerate((32, 40, 50)):
        r.append(("impact", f"Impact {'ABC'[i]}", lambda i=i, low=low: _impact(61 + i, low)))
    for sec in (1.5, 3):
        r.append(("sub_drop", f"Sub drop {sec:g}s", lambda sec=sec: _sub_drop(sec)))
    for seed in (1, 2):
        r.append(("zap", f"Zap {'AB'[seed - 1]}", lambda seed=seed: _zap(seed)))
    return [{"category": c, "name": n, "make": m} for c, n, m in r]


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")[:60]


def generate(log=print) -> int:
    """Synthesise the generated set into sfx/generated (16-bit stereo WAV, peaks at -1 dBFS)."""
    import soundfile as sf
    folder = os.path.join(SFX_DIR, "generated")
    os.makedirs(folder, exist_ok=True)
    made = 0
    for r in _recipes():
        path = os.path.join(folder, f"{r['category']}__{_slug(r['name'])}.wav")
        if os.path.exists(path):
            continue
        x = _stereo(r["make"](), len(r["name"]))
        x = x / (np.abs(x).max() + 1e-9) * 0.89
        sf.write(path, x.T.astype(np.float32), SR, subtype="PCM_16")
        made += 1
    log(f"Generated {made} new sounds in {folder}")
    build_manifest()
    return made


# ── Freesound (CC0 only) ──

def _folder_bytes(folder: str) -> int:
    return sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(folder) for f in fs)


def download(key: str, per_category: int = 40, max_bytes: int = 2 * 1024 ** 3, log=print, http=None,
             pause: float = 1.1) -> Dict[str, int]:
    """Fetch up to `per_category` CC0 sounds per category from Freesound (best rated first) into
    sfx/freesound/<category>/, never past `max_bytes` for the whole sfx folder. Resumable: sounds
    already there are skipped. Each sound's name, author, licence and page go into the index."""
    import requests
    http = http or requests
    folder = os.path.join(SFX_DIR, "freesound")
    os.makedirs(folder, exist_ok=True)
    index_path = os.path.join(folder, "index.json")
    index = json.load(open(index_path)) if os.path.exists(index_path) else {}
    used = _folder_bytes(SFX_DIR)
    got = {"downloaded": 0, "skipped": 0}
    for cat, (role, query) in CATEGORIES.items():
        have = [k for k, v in index.items() if v["category"] == cat]
        page = 1
        while len(have) < per_category:
            r = http.get(FREESOUND_SEARCH, params={
                "query": query, "filter": f'license:"{CC0}" duration:[0.1 TO 30]', "sort": "rating_desc",
                "fields": "id,name,username,license,duration,previews,url", "page_size": 50, "page": page,
                "token": key}, timeout=30)
            if r.status_code == 401:
                raise SystemExit("Freesound refused the API key (401): check it at https://freesound.org/apiv2/apply")
            r.raise_for_status()
            data = r.json()
            for s in data.get("results", []):
                if len(have) >= per_category:
                    break
                sid = str(s["id"])
                if sid in index:
                    got["skipped"] += 1
                    continue
                if s.get("license", "").rstrip("/").split("/")[-2:] != ["zero", "1.0"] and CC0 not in s.get("license", ""):
                    continue                     # CC0 only (licence URL .../publicdomain/zero/1.0/)
                url = (s.get("previews") or {}).get("preview-hq-mp3")
                if not url:
                    continue
                audio = http.get(url, timeout=60)
                audio.raise_for_status()
                if used + len(audio.content) > max_bytes:
                    log(f"Stopped at the {max_bytes / 1024 ** 3:.1f} GB budget")
                    json.dump(index, open(index_path, "w"), indent=1)
                    build_manifest()
                    return got
                os.makedirs(os.path.join(folder, cat), exist_ok=True)
                rel = os.path.join(cat, f"{sid}_{_slug(s['name'])}.mp3")
                with open(os.path.join(folder, rel), "wb") as f:
                    f.write(audio.content)
                used += len(audio.content)
                index[sid] = {"category": cat, "name": s["name"], "author": s.get("username"),
                              "license": s.get("license"), "page": s.get("url"), "file": rel,
                              "duration": s.get("duration")}
                have.append(sid)
                got["downloaded"] += 1
                time.sleep(pause)                # Freesound's API allows 60 requests a minute
            if not data.get("next"):
                break
            page += 1
        log(f"{cat}: {len(have)} sounds")
        json.dump(index, open(index_path, "w"), indent=1)
    build_manifest()
    log(f"Downloaded {got['downloaded']} sounds; the sfx folder holds {used / 1024 ** 2:.0f} MB")
    return got


# ── The library as the console sees it ──

def build_manifest() -> List[Dict[str, Any]]:
    """Every sound in sfx/ with its id, category, role, name, source and licence, into manifest.json."""
    items = []
    gen = os.path.join(SFX_DIR, "generated")
    if os.path.isdir(gen):
        names = {f"{r['category']}__{_slug(r['name'])}.wav": r for r in _recipes()}
        for f in sorted(os.listdir(gen)):
            r = names.get(f)
            if r:
                items.append({"id": f"gen-{f[:-4]}", "category": r["category"], "role": CATEGORIES[r["category"]][0],
                              "name": r["name"], "source": "generated", "license": "own (generated)",
                              "file": os.path.join("generated", f)})
    index_path = os.path.join(SFX_DIR, "freesound", "index.json")
    if os.path.exists(index_path):
        for sid, v in sorted(json.load(open(index_path)).items(), key=lambda kv: (kv[1]["category"], kv[0])):
            path = os.path.join(SFX_DIR, "freesound", v["file"])
            if os.path.exists(path):
                items.append({"id": f"fs-{sid}", "category": v["category"], "role": CATEGORIES[v["category"]][0],
                              "name": v["name"], "source": "freesound", "license": "CC0", "author": v.get("author"),
                              "page": v.get("page"), "file": os.path.join("freesound", v["file"])})
    os.makedirs(SFX_DIR, exist_ok=True)
    with open(MANIFEST, "w") as f:
        json.dump(items, f, indent=1)
    return items


def library() -> List[Dict[str, Any]]:
    if not os.path.exists(MANIFEST):
        return build_manifest() if os.path.isdir(SFX_DIR) else []
    with open(MANIFEST) as f:
        return json.load(f)


def path_of(sound_id: str) -> Optional[str]:
    item = next((s for s in library() if s["id"] == sound_id), None)
    return os.path.join(SFX_DIR, item["file"]) if item else None


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="python -m backend.sfx", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("generate", help="synthesise the generated set (no licence needed)")
    d = sub.add_parser("download", help="fetch CC0 sounds from Freesound (free API key)")
    d.add_argument("--key", help="Freesound API key (default: FREESOUND_API_KEY in .env)")
    d.add_argument("--per-category", type=int, default=40)
    d.add_argument("--max-gb", type=float, default=2.0)
    sub.add_parser("list", help="what the library holds")
    args = ap.parse_args(argv)
    if args.cmd == "generate":
        generate()
    elif args.cmd == "download":
        try:
            from dotenv import load_dotenv
            load_dotenv(os.path.join(BASE_DIR, ".env"))
        except ImportError:
            pass
        key = args.key or os.environ.get("FREESOUND_API_KEY", "").strip()
        if not key:
            sys.exit("No Freesound API key: get one free at https://freesound.org/apiv2/apply and put "
                     "FREESOUND_API_KEY=... in .env (or pass --key)")
        download(key, args.per_category, int(args.max_gb * 1024 ** 3))
    items = build_manifest()
    by = {}
    for s in items:
        by.setdefault(s["category"], []).append(s)
    print(f"{len(items)} sounds, {_folder_bytes(SFX_DIR) / 1024 ** 2:.0f} MB in {SFX_DIR}")
    for cat, ss in by.items():
        print(f"  {cat:15s} {len(ss):4d}  ({', '.join(sorted({s['source'] for s in ss}))})")


if __name__ == "__main__":
    main()
