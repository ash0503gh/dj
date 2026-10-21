"""
library.py - The local library: one folder of music, prepared before the gig (as Serato and rekordbox
prepare a collection).

Local mode is on when PULSE_LIBRARY names a folder. `python -m backend.library prepare` analyzes every
track in it once; the console lists and loads only tracks whose every stage has passed, and uploads
are off. Without PULSE_LIBRARY nothing here runs and the server works as before (uploads, bucket).

Index (SQLite, PULSE_DATA/library.db, ~/.pulsepro by default):
  files   every audio file seen: path, size, mtime and SHA-1 (hashed again only when size or mtime change)
  tracks  one row per audio content (SHA-1 of the audio alone, tags left out): renamed, moved,
          duplicated or re-tagged files are one track, so its analysis, grid fixes and labels survive.
          Each stage keeps the version it ran at: a newer analyzer re-runs only the stages that changed.
          A track whose file is gone is kept (missing): the same audio added again is ready at once.

Gemini (paid) listens to a song once in its life, never during a set: `listen` estimates the cost in
rupees, asks, keeps to a budget and saves each song's labels as it goes.

    python -m backend.library prepare [--library DIR] [--workers N] [--retry-failed]
    python -m backend.library listen [--yes] [--max-inr N]
    python -m backend.library status
"""

import argparse
import hashlib
import json
import math
import multiprocessing
import os
import re
import sqlite3
import subprocess
import time
import warnings
from concurrent.futures import ProcessPoolExecutor, as_completed
from contextlib import closing
from typing import Any, Dict, List, Optional

from .audio_analyzer import analyze_track, build_grid_times, ANALYSIS_VERSION
from .vocal_listen import carry_vocal_labels
from .grid_check import check_track, DRIFT_FLAG_MS
from . import beats_nn, key_detect, next_track, stems

AUDIO_EXTS = (".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac")

def _stages() -> Dict[str, int]:
    """Stage -> version, in the order they run. Bump a version to re-run that stage on the whole library
    at the next prepare. The neural beat tracker and the key extractor run when installed."""
    st = {"beats_nn": 1} if beats_nn.available() else {}
    st["analysis"] = ANALYSIS_VERSION
    if key_detect.available():
        st["key"] = 1
    st.update(loudness=2, grid_check=1)
    if stems.available():
        st.update(stems=1, vocals=1)
    return st


STAGES = _stages()
# A stage re-runs after one it builds on has run: the analysis takes the neural beats as a second
# opinion, the key replaces the analysis's, the grid check measures the analysis's grid
AFTER = {"analysis": ("beats_nn",), "key": ("analysis",), "grid_check": ("analysis",),
         "vocals": ("analysis", "stems")}   # the vocal stem labels the analysis's sections and bars
# Stages a track is ready without (it keeps the analyzer's own grid decisions, key and vocal guess):
# tried again at the next prepare when they fail
OPTIONAL = {"beats_nn", "key", "stems", "vocals"}
# Stages that fill the GPU and memory on their own: one track at a time, after the others
SEQUENTIAL = {"stems"}


class SkipStage(Exception):
    """A stage with nothing to work on yet (the vocals before the stems exist): neither run nor failed."""


def stems_folder(file_id: str) -> str:
    return os.path.join(os.path.dirname(db_path()), "stems", file_id)

# A grid that lands fewer of its strong beats within 20 ms than this is flagged for a check
# (provisional: tuned on the Phase 2 benchmark)
LOW_GRID_CONFIDENCE = 0.5
# A grid that fewer of the neural tracker's beats land on than this is flagged (provisional)
NN_AGREE_MIN = 0.6


def library_dir() -> str:
    return os.path.abspath(os.path.expanduser(os.environ["PULSE_LIBRARY"])) if enabled() else ""


def enabled() -> bool:
    return bool(os.environ.get("PULSE_LIBRARY", "").strip())


def db_path() -> str:
    data = os.path.expanduser(os.environ.get("PULSE_DATA", "").strip() or "~/.pulsepro")
    os.makedirs(data, exist_ok=True)
    return os.path.join(data, "library.db")


def _connect() -> sqlite3.Connection:
    # The server reads while prepare writes: WAL lets both go on
    con = sqlite3.connect(db_path(), timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript("""
        CREATE TABLE IF NOT EXISTS files (
            path TEXT PRIMARY KEY, size INTEGER, mtime REAL, sha1 TEXT);
        CREATE TABLE IF NOT EXISTS tracks (
            file_id TEXT PRIMARY KEY, sha1 TEXT UNIQUE, path TEXT, title TEXT,
            status TEXT, stages TEXT DEFAULT '{}', flags TEXT DEFAULT '[]', error TEXT,
            bpm REAL, camelot TEXT, key TEXT, duration REAL, loudness_lufs REAL,
            analysis TEXT, updated REAL);
    """)
    return con


def _file_id(sha1: str, path: str) -> str:
    """Stable however the file is renamed or moved: from its audio, not its name."""
    return f"lib_{sha1[:16]}{os.path.splitext(path)[1].lower()}"


def _sha1_file(path: str) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


HASH_VERSION = 1   # what files.sha1 / tracks.sha1 hash: 0 the whole file, 1 its audio alone (audio_sha1)

# MPEG audio Layer III frame sizes: kbps by bitrate index (MPEG-1; MPEG-2 and 2.5), Hz by version bits
_KBPS = ((0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320),
         (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160))
_HZ = {3: (44100, 48000, 32000), 2: (22050, 24000, 16000), 0: (11025, 12000, 8000)}


def _info_frame_len(data: bytes, i: int) -> int:
    """Length of the MP3 frame at `i` when it is the encoder's Xing / Info / VBRI header (no music: a
    re-mux or tag tool may rewrite it), else 0."""
    if len(data) < i + 4:
        return 0
    h = int.from_bytes(data[i:i + 4], "big")
    version, layer, rate, hz, pad = (h >> 19) & 3, (h >> 17) & 3, (h >> 12) & 15, (h >> 10) & 3, (h >> 9) & 1
    if h >> 21 != 0x7FF or layer != 1 or version == 1 or rate in (0, 15) or hz == 3:
        return 0
    n = (144 if version == 3 else 72) * _KBPS[version != 3][rate] * 1000 // _HZ[version][hz] + pad
    frame = data[i:i + n]
    return n if any(tag in frame for tag in (b"Xing", b"Info", b"VBRI")) else 0


def audio_sha1(path: str) -> str:
    """SHA-1 of an MP3's audio alone: its ID3v2, APEv2 and ID3v1 tags and the encoder's Xing/Info header
    frame are left out, so editing tags (a title, cover art, a key from Mixed In Key, the analysis Serato
    writes into the file) or re-muxing it never makes it another track. Other formats: the whole file."""
    if not path.lower().endswith(".mp3"):
        return _sha1_file(path)
    with open(path, "rb") as f:
        data = f.read()
    start, end = 0, len(data)
    while data[start:start + 3] == b"ID3" and end - start >= 10:          # ID3v2 (possibly more than one)
        size = sum((data[start + 6 + i] & 0x7F) << (7 * (3 - i)) for i in range(4))
        start += 10 + size + (10 if data[start + 5] & 0x10 else 0)        # + footer
    start += _info_frame_len(data, start)
    if end - start >= 128 and data[end - 128:end - 125] == b"TAG":         # ID3v1
        end -= 128
    if end - start >= 32 and data[end - 32:end - 24] == b"APETAGEX":       # APEv2, with its header
        size = int.from_bytes(data[end - 20:end - 16], "little")
        end -= size + (32 if int.from_bytes(data[end - 12:end - 8], "little") & 0x80000000 else 0)
    return hashlib.sha1(data[start:end]).hexdigest()


def _migrate_hashes(con: sqlite3.Connection, log=print) -> None:
    """Tracks found by their whole file's hash are found by their audio's from now on. They keep their
    id, analysis, grid fixes and labels; two files that differed only in their tags become one track."""
    if con.execute("PRAGMA user_version").fetchone()[0] >= HASH_VERSION:
        return
    moved = 0
    for t in con.execute("SELECT file_id, path FROM tracks").fetchall():
        if t["path"] and os.path.exists(t["path"]):
            try:
                con.execute("UPDATE tracks SET sha1 = ? WHERE file_id = ?", (audio_sha1(t["path"]), t["file_id"]))
                moved += 1
            except sqlite3.IntegrityError:
                con.execute("UPDATE tracks SET status = 'missing' WHERE file_id = ?", (t["file_id"],))
    con.execute("DELETE FROM files")       # hashed again, by their audio, at this index
    con.execute(f"PRAGMA user_version = {HASH_VERSION}")
    con.commit()
    if moved:
        log(f"Fingerprints now cover the audio alone (tag edits don't make a new track): {moved} tracks kept")


def scan(root: str) -> List[str]:
    """Every audio file under `root` (hidden files and folders skipped), sorted."""
    found = []
    for d, dirs, names in os.walk(root):
        dirs[:] = [x for x in dirs if not x.startswith(".")]
        found += [os.path.join(d, n) for n in names
                  if not n.startswith(".") and n.lower().endswith(AUDIO_EXTS)]
    return sorted(found)


def measure_loudness(path: str) -> Dict[str, Any]:
    """Loudness by EBU R128 (ITU-R BS.1770: the K-weighted loudness the ear hears), measured by ffmpeg on
    the full-rate audio: integrated (LUFS), loudness range (LU), and short-term loudness every second
    (loudness_st[k]: the 3 s ending at k + 1 seconds, None where silent), and the body's loudness (the
    louder half of those seconds, power-averaged): what a DJ matches with the trim knob, the track's
    main sections rather than its quiet intro or breakdown."""
    out = subprocess.run(['ffmpeg', '-nostats', '-hide_banner', '-v', 'verbose', '-i', path, '-map', '0:a:0',
                          '-af', 'ebur128=framelog=verbose', '-f', 'null', '-'],
                         capture_output=True, text=True).stderr
    summary = out[out.rfind("Summary:"):]
    i = re.search(r"I:\s+(-?[\d.]+) LUFS", summary)
    lra = re.search(r"LRA:\s+([\d.]+) LU", summary)
    if not i:
        raise RuntimeError("loudness: no measurement (silent or undecodable audio)")
    st, last = [], 0
    for t, s in re.findall(r"t:\s*([\d.]+)\s+TARGET:.*?S:\s*(-?[\d.]+|-?inf|nan)", out):
        k = int(round(float(t)))
        if abs(float(t) - k) < 0.05 and k > last:   # one value a second, at whole seconds
            last = k
            v = float(s) if s not in ("inf", "-inf", "nan") else None
            st.append(round(v, 1) if v is not None and v > -70 else None)
    heard = sorted(v for v in st if v is not None)
    loud = heard[len(heard) // 2:]
    body = 10 * math.log10(sum(10 ** (v / 10) for v in loud) / len(loud)) if loud else None
    return {"loudness_lufs": float(i.group(1)), "loudness_range_lu": float(lra.group(1)) if lra else None,
            "loudness_st": st, "loudness_body_lufs": round(body, 2) if body is not None else None}


def flags_for(an: Dict[str, Any]) -> List[str]:
    """What a DJ should check before trusting this track in a mix (it still loads)."""
    g = an.get("grid") or {}
    flags = []
    if (g and not g.get("tempo_stable", True)) or (an.get("grid_err_spread_ms") or 0) > DRIFT_FLAG_MS:
        flags.append("grid_drift")       # the kicks wander off the grid: no single grid follows them
    if g.get("confidence") is not None and g["confidence"] < LOW_GRID_CONFIDENCE:
        flags.append("grid_fit")         # few beats land on the grid
    if g.get("tempo_conflict") or (g.get("nn_agree") is not None and g["nn_agree"] < NN_AGREE_MIN):
        flags.append("beats_disagree")   # the neural tracker hears other beats than the grid's
    return [] if an.get("grid_confirmed") else flags   # the DJ checked it (GRID OK)


# Fields of a previous key extraction: the analysis's own key replaces them until the key stage runs again
KEY_FIELDS = ("key_strength", "key_source")


def _keep_manual_grid(fresh: Dict[str, Any], prior: Optional[Dict[str, Any]]) -> None:
    """A grid the DJ fixed or confirmed survives a re-analysis that finds the same tempo; one that finds
    another tempo starts fresh, to be checked again."""
    if not prior or not prior.get("grid_manual") or not prior.get("grid"):
        return
    pg, fg = prior["grid"], fresh["grid"]
    if abs(pg["bpm"] - fg["bpm"]) <= 0.05:
        fresh["grid"] = dict(fg, first_beat=pg["first_beat"], downbeat_offset=pg["downbeat_offset"],
                             phrase_offset_bars=pg["phrase_offset_bars"])
        fresh.update(build_grid_times(fresh["grid"], fresh["duration"]))
        fresh.update(grid_manual=True, grid_confirmed=bool(prior.get("grid_confirmed")))
    else:
        fresh.update(grid_manual=False, grid_confirmed=False)


def _run_stage(stage: str, path: str, an: Dict[str, Any], prior: Optional[Dict[str, Any]],
               file_id: str) -> Dict[str, Any]:
    if stage == "beats_nn":
        an.update(beats_nn.track_beats(path))
    elif stage == "analysis":
        nn = {k: an[k] for k in ("nn_beats", "nn_downbeats", "nn_bpm") if an.get(k)} or None
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)   # numpy empty-slice noise on short sections
            fresh = analyze_track(path, nn)
        fresh["key_ks"] = fresh.get("camelot")               # the analyzer's own key, for comparison
        fresh["tags"] = key_detect.read_tags(path)           # the BPM and key the file's tags give
        carry_vocal_labels(fresh, prior)                     # Gemini's labels survive a re-analysis
        _keep_manual_grid(fresh, prior)
        # what the other stages measured stays until they run again
        fresh.update({k: v for k, v in an.items() if k not in fresh and k not in KEY_FIELDS})
        an = fresh
    elif stage == "key":
        an.update(key_detect.detect_key(path))
    elif stage == "loudness":
        an.update(measure_loudness(path))
    elif stage == "grid_check":
        an.update(check_track(path, an["grid"], an["duration"]))
    elif stage == "stems":
        an.update(stems.separate(path, stems_folder(file_id)))
    elif stage == "vocals":
        folder = stems_folder(file_id)
        if not stems.have(folder):
            raise SkipStage()
        stems.label_vocals(an, stems.sung_frames(stems.paths(folder)["vocals"], path))
    return an


def _prepare_one(path: str, todo: List[str], prior: Optional[Dict[str, Any]], file_id: str = ""):
    """Run one file's outdated stages (in a worker process), and every stage after one that ran and that
    it builds on. Returns (the new analysis, the stages that ran, {optional stage: why it failed},
    seconds it took)."""
    t0 = time.time()
    an = dict(prior or {})
    ran, failed = [], {}
    for stage in STAGES:
        if stage not in todo and not any(d in ran for d in AFTER.get(stage, ())):
            continue
        try:
            an = _run_stage(stage, path, an, prior, file_id)
            ran.append(stage)
        except SkipStage:
            continue
        except Exception as e:
            if stage not in OPTIONAL:
                raise
            failed[stage] = str(e) or type(e).__name__
    return an, ran, failed, time.time() - t0


def _uploaded_labels() -> Dict[str, Dict[str, Any]]:
    """Analyses from the upload console (uploads/analysis_cache.json) that carry Gemini's vocal labels,
    by audio SHA-1: a library track already uploaded once keeps its labels without another listen."""
    cache = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "uploads", "analysis_cache.json")
    try:
        with open(cache) as f:
            entries = json.load(f).values()
    except (OSError, ValueError):
        return {}
    return {an["content_sha1"]: an for an in entries
            if isinstance(an, dict) and an.get("content_sha1") and an.get("vocal_source")}


def _status(stages: Dict[str, int], error: Optional[str]) -> str:
    if all(stages.get(s) == v for s, v in STAGES.items() if s not in OPTIONAL):
        return "ready"
    return "failed" if error else "pending"


def index(con: sqlite3.Connection, root: str, log=print) -> None:
    """Bring the index in line with the folder: hash new or changed files, one track per audio,
    follow renames and moves, and mark tracks whose files are all gone as missing."""
    _migrate_hashes(con, log)
    paths = scan(root)
    known = {r["path"]: r for r in con.execute("SELECT * FROM files")}
    hashed = 0
    for p in paths:
        st = os.stat(p)
        r = known.get(p)
        if r and r["size"] == st.st_size and r["mtime"] == st.st_mtime:
            continue
        con.execute("INSERT OR REPLACE INTO files VALUES (?, ?, ?, ?)", (p, st.st_size, st.st_mtime, audio_sha1(p)))
        hashed += 1
    gone = set(known) - set(paths)
    con.executemany("DELETE FROM files WHERE path = ?", [(p,) for p in gone])

    by_sha = {}
    for r in con.execute("SELECT path, sha1 FROM files ORDER BY path"):
        by_sha.setdefault(r["sha1"], []).append(r["path"])
    tracks = {r["sha1"]: r for r in con.execute("SELECT * FROM tracks")}
    added = 0
    for sha, ps in by_sha.items():
        t = tracks.get(sha)
        if t is None:
            con.execute("INSERT INTO tracks (file_id, sha1, path, title, status, updated) VALUES (?, ?, ?, ?, ?, ?)",
                        (_file_id(sha, ps[0]), sha, ps[0], os.path.basename(ps[0]), "pending", time.time()))
            added += 1
        elif t["path"] not in ps or t["status"] == "missing":
            # Renamed or moved (or back again): same audio, same track
            stages = json.loads(t["stages"] or "{}")
            con.execute("UPDATE tracks SET path = ?, title = ?, status = ?, updated = ? WHERE sha1 = ?",
                        (ps[0], os.path.basename(ps[0]), _status(stages, t["error"]), time.time(), sha))
    lost = [sha for sha in tracks if sha not in by_sha and tracks[sha]["status"] != "missing"]
    con.executemany("UPDATE tracks SET status = 'missing', updated = ? WHERE sha1 = ?",
                    [(time.time(), sha) for sha in lost])
    con.commit()
    log(f"Library {root}: {len(paths)} files ({hashed} hashed), {len(by_sha)} tracks"
        f" ({added} new, {len(lost)} missing)")


def _finite(o):
    """NaN and infinity as None: JSON responses refuse them, and one odd field mustn't block a track."""
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, dict):
        return {k: _finite(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_finite(v) for v in o]
    return o


def _store(con: sqlite3.Connection, file_id: str, an: Dict[str, Any], stages: Dict[str, int],
           error: Optional[str]) -> None:
    an = _finite(an) if an else an
    con.execute("""UPDATE tracks SET status = ?, stages = ?, flags = ?, error = ?, bpm = ?, camelot = ?, key = ?,
                   duration = ?, loudness_lufs = ?, analysis = ?, updated = ? WHERE file_id = ?""",
                (_status(stages, error), json.dumps(stages), json.dumps(flags_for(an)), error,
                 an.get("bpm"), an.get("camelot"), an.get("key"), an.get("duration"), an.get("loudness_lufs"),
                 json.dumps(an) if an else None, time.time(), file_id))
    con.commit()


def prepare(root: Optional[str] = None, workers: Optional[int] = None, retry_failed: bool = False,
            log=print) -> Dict[str, int]:
    """Index the folder, then run every outdated stage of every track, `workers` tracks at a time
    (0: in this process). Safe to stop and run again: each finished track is saved as it ends."""
    root = os.path.abspath(os.path.expanduser(root or library_dir()))
    if not os.path.isdir(root):
        raise SystemExit(f"Library folder not found: {root}")
    if workers is None:
        # ~300 MB each while analyzing; the neural tracker adds PyTorch's
        workers = max(1, min(4 if "beats_nn" in STAGES else 6, (os.cpu_count() or 2) - 2))
    with closing(_connect()) as con:
        index(con, root, log)
        labelled = _uploaded_labels()

        def outdated(only=None):
            jobs = []
            for t in con.execute("SELECT * FROM tracks WHERE status IN ('pending', 'failed', 'ready')"):
                if t["status"] == "failed" and not retry_failed:
                    continue
                stages = json.loads(t["stages"] or "{}")
                if "stems" in stages and not stems.have(stems_folder(t["file_id"])):
                    stages = {k: v for k, v in stages.items() if k != "stems"}    # its files were deleted
                todo = [s for s, v in STAGES.items() if stages.get(s) != v and (only is None or s in only)]
                if todo:
                    # A new track uploaded to the console before (found by its whole file's hash there)
                    # brings Gemini's labels along
                    prior = json.loads(t["analysis"]) if t["analysis"] else (
                        labelled.get(t["sha1"]) or (labelled.get(_sha1_file(t["path"])) if labelled else None))
                    jobs.append((t["file_id"], t["path"], todo, prior, stages, t["sha1"], t["title"]))
            return jobs

        def without(jobs, drop):
            jobs = [(j[0], j[1], [s for s in j[2] if s not in drop]) + j[3:] for j in jobs]
            return [j for j in jobs if j[2]]

        def preload(module, what):
            try:
                module.load()
                log(f"{what} ready (on {module._device_used})")
                return True
            except Exception as e:
                log(f"{what} unavailable ({e}): preparing without it this time")
                return False

        # Every stage but the GPU-heavy ones, several tracks at a time. The neural tracker's weights
        # download once, here, rather than in every worker at once; without them (offline, say) this
        # prepare runs without it
        jobs = without(outdated(), SEQUENTIAL)
        if any("beats_nn" in j[2] for j in jobs) and not preload(beats_nn, "Neural beat tracker (Beat This!)"):
            jobs = without(jobs, {"beats_nn"})
        if jobs:
            log(f"Preparing {len(jobs)} tracks with {workers or 1} worker(s)...")
            _run_jobs(con, jobs, workers, log)
        # Then the stems, one track at a time in this process with the model loaded once (the vocals
        # are read from them as each track's are done)
        heavy = [j for j in outdated(SEQUENTIAL) if j[3]]   # tracks with an analysis to label
        if heavy and preload(stems, "Stem separation (Demucs)"):
            log(f"Separating stems of {len(heavy)} tracks, one at a time...")
            _run_jobs(con, heavy, 0, log)
        elif not jobs and not heavy:
            log("Everything is prepared.")
        return summary(con)


def _run_jobs(con: sqlite3.Connection, jobs: list, workers: int, log) -> None:
    """Run `jobs` (file_id, path, todo, prior, stages, sha1, title), `workers` at a time (0: in this
    process), saving each track as it ends."""
    def finish(job, result, err, n):
        file_id, _, todo, prior, stages, sha, title = job
        failed, secs = {}, 0.0
        if err is None:
            an, ran, failed, secs = result
            stages = dict(stages, **{s: STAGES[s] for s in ran})
            an.update(file_id=file_id, title=title, content_sha1=sha)
        else:
            an = prior if prior and prior.get("file_id") == file_id else {}   # not an upload's labels
        _store(con, file_id, an, stages, err)
        if err is not None:
            what = f"FAILED: {err}"
        elif "stems" in todo:
            sung = sum(bool(s.get("has_vocals")) for s in an.get("section_map", []))
            what = (f"stems in {secs:.0f} s, vocals in {sung}/{len(an.get('section_map', []))} sections"
                    if "stems" in ran else "no stems")
        else:
            what = (f"{float(an.get('bpm') or 0):.2f} BPM, {an.get('camelot', '--')}, {an.get('loudness_lufs', '?')} LUFS"
                    + (f", check: {', '.join(flags_for(an))}" if flags_for(an) else ""))
        what += "".join(f", {s} skipped: {why}" for s, why in failed.items()) if err is None else ""
        log(f"[{n}/{len(jobs)}] {title} · {what}")

    if workers == 0:
        for n, job in enumerate(jobs, 1):
            try:
                finish(job, _prepare_one(job[1], job[2], job[3], job[0]), None, n)
            except Exception as e:
                finish(job, None, str(e) or type(e).__name__, n)
        return
    with ProcessPoolExecutor(workers, mp_context=multiprocessing.get_context("spawn"),
                             max_tasks_per_child=4) as ex:
        futs = {ex.submit(_prepare_one, j[1], j[2], j[3], j[0]): j for j in jobs}
        for n, fut in enumerate(as_completed(futs), 1):
            try:
                finish(futs[fut], fut.result(), None, n)
            except Exception as e:
                finish(futs[fut], None, str(e) or type(e).__name__, n)


# ── Reads and writes for the server ──

def summary(con: Optional[sqlite3.Connection] = None) -> Dict[str, Any]:
    """Track counts by status, and the ready tracks flagged for a check."""
    own = con is None
    con = con or _connect()
    try:
        counts = {r["status"]: r["n"] for r in con.execute("SELECT status, COUNT(*) AS n FROM tracks GROUP BY status")}
        flagged = [{"file_id": r["file_id"], "title": r["title"], "flags": json.loads(r["flags"])}
                   for r in con.execute("SELECT file_id, title, flags FROM tracks WHERE status = 'ready' AND flags != '[]'")]
        failed = [{"file_id": r["file_id"], "title": r["title"], "error": r["error"]}
                  for r in con.execute("SELECT file_id, title, error FROM tracks WHERE status = 'failed'")]
        return {"counts": {s: counts.get(s, 0) for s in ("ready", "pending", "failed", "missing")},
                "flagged": flagged, "failed": failed}
    finally:
        if own:
            con.close()


def get(file_id: str) -> Optional[Dict[str, Any]]:
    """The track's row (status, path, flags) with its analysis, or None if it isn't in the library."""
    with closing(_connect()) as con:
        r = con.execute("SELECT * FROM tracks WHERE file_id = ?", (file_id,)).fetchone()
    if r is None:
        return None
    row = dict(r)
    row["flags"] = json.loads(row["flags"] or "[]")
    row["analysis"] = json.loads(row["analysis"]) if row["analysis"] else None
    return row


def path_of(file_id: str) -> Optional[str]:
    with closing(_connect()) as con:
        r = con.execute("SELECT path FROM tracks WHERE file_id = ? AND status != 'missing'", (file_id,)).fetchone()
    return r["path"] if r and os.path.exists(r["path"]) else None


def ready_tracks() -> List[Dict[str, Any]]:
    """What the track browser lists: every prepared track, once."""
    with closing(_connect()) as con:
        rows = con.execute("SELECT file_id, title, bpm, camelot, key, duration, flags FROM tracks "
                           "WHERE status = 'ready' ORDER BY title").fetchall()
    return [{"file_id": r["file_id"], "title": r["title"], "bpm": float(r["bpm"] or 128.0),
             "camelot": r["camelot"] or "--", "key": r["key"] or "--", "duration": float(r["duration"] or 0),
             "flags": json.loads(r["flags"] or "[]")} for r in rows]


def save_analysis(file_id: str, an: Dict[str, Any]) -> None:
    """Keep a change the console made to a prepared analysis (a grid fix, Gemini's vocal labels)."""
    with closing(_connect()) as con:
        r = con.execute("SELECT stages, error FROM tracks WHERE file_id = ?", (file_id,)).fetchone()
        if r is not None:
            _store(con, file_id, an, json.loads(r["stages"] or "{}"), r["error"])


_FEATURES: Dict[str, Any] = {}   # file_id -> (updated, next_track features): parsed once per change


def features_all() -> List[Dict[str, Any]]:
    """next_track features of every prepared track (for the next-track suggestions)."""
    with closing(_connect()) as con:
        live = {r["file_id"]: r["updated"] for r in con.execute("SELECT file_id, updated FROM tracks WHERE status = 'ready'")}
        for fid, updated in live.items():
            if _FEATURES.get(fid, (None,))[0] != updated:
                r = con.execute("SELECT analysis FROM tracks WHERE file_id = ?", (fid,)).fetchone()
                an = json.loads(r["analysis"]) if r and r["analysis"] else {}
                _FEATURES[fid] = (updated, next_track.features(dict(an, file_id=fid)) if an else None)
    for fid in [f for f in _FEATURES if f not in live]:
        _FEATURES.pop(fid, None)
    return [f for _, f in _FEATURES.values() if f]


# What Gemini charges for the model that listens (USD per million tokens: input with the audio, output
# with its thinking), in rupees: what `listen` estimates and reports. Introductory prices until
# 2026-12-31, doubling on 2027-01-01: update them then, and the rupee rate as it moves.
GEMINI_USD_PER_M = (0.75, 3.75)
INR_PER_USD = 96.0
AUDIO_TOKENS_PER_SEC = 32    # Gemini's audio tokens per second of audio (documented for earlier models)
EST_TOKENS_OUT = 3000        # labels and thinking per song: a guess, `listen` reports the real counts


def inr(tokens_in: float, tokens_out: float) -> float:
    return (tokens_in * GEMINI_USD_PER_M[0] + tokens_out * GEMINI_USD_PER_M[1]) / 1e6 * INR_PER_USD


def unlistened() -> List[Dict[str, Any]]:
    """Prepared songs Gemini hasn't listened to yet, with the estimated cost (₹) of each."""
    with closing(_connect()) as con:
        rows = con.execute("SELECT file_id, title, path, duration FROM tracks WHERE status = 'ready' "
                           "AND json_extract(analysis, '$.vocal_source') IS NULL").fetchall()
    return [dict(r, est_inr=inr(AUDIO_TOKENS_PER_SEC * (r["duration"] or 240) + 1000, EST_TOKENS_OUT)) for r in rows]


def listen(yes: bool = False, max_inr: Optional[float] = None, log=print, ask=input) -> Dict[str, Any]:
    """Gemini listens once to every prepared song it hasn't heard and marks where its lead vocal sings.
    Shows the estimated cost first and asks (unless `yes`), stops before going past `max_inr`, and saves
    each song as it's done: an interrupted run loses nothing, and no song is ever paid for twice."""
    from .ai_advisor import get_gemini_api_key, DEFAULT_GEMINI_MODEL
    from .vocal_listen import listen_for_vocals, apply_vocal_labels
    todo = unlistened()
    if not todo:
        log("Gemini has listened to every prepared song.")
        return {"listened": 0, "inr": 0.0}
    key = get_gemini_api_key()
    if not key:
        log("No Gemini key (GEMINI_API_KEY in .env): nothing listened to.")
        return {"listened": 0, "inr": 0.0}
    estimate = sum(t["est_inr"] for t in todo)
    log(f"{len(todo)} songs Gemini hasn't listened to: about ₹{estimate:.0f}, once (never again for these songs)"
        + (f"; budget ₹{max_inr:.0f}" if max_inr is not None else ""))
    if not yes and ask("Go ahead? [y/N] ").strip().lower() != "y":
        log("Nothing listened to.")
        return {"listened": 0, "inr": 0.0}
    spent, done = 0.0, 0
    for n, t in enumerate(todo, 1):
        if max_inr is not None and spent + t["est_inr"] > max_inr:
            log(f"Stopped at the ₹{max_inr:.0f} budget: {len(todo) - n + 1} songs left for next time")
            break
        row = get(t["file_id"])
        an = row["analysis"] if row else None
        if not an or not an.get("section_map"):
            continue
        usage: Dict[str, Any] = {}
        labels, err = listen_for_vocals(t["path"], an["section_map"], key, DEFAULT_GEMINI_MODEL, usage=usage)
        cost = inr(usage.get("promptTokenCount") or 0,
                   (usage.get("candidatesTokenCount") or 0) + (usage.get("thoughtsTokenCount") or 0))
        spent += cost
        if labels is None:
            log(f"[{n}/{len(todo)}] {t['title']} · not labelled ({err}) · ₹{cost:.2f}")
            continue
        apply_vocal_labels(an, labels, DEFAULT_GEMINI_MODEL)
        save_analysis(t["file_id"], an)
        done += 1
        log(f"[{n}/{len(todo)}] {t['title']} · lead vocal in {sum(labels)}/{len(labels)} sections · ₹{cost:.2f}")
    log(f"Gemini listened to {done} songs for ₹{spent:.2f}")
    return {"listened": done, "inr": round(spent, 2)}


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="python -m backend.library", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prepare", help="analyze every new or changed track in the library folder")
    p.add_argument("--library", help="the music folder (default: $PULSE_LIBRARY)")
    p.add_argument("--workers", type=int, help="tracks at a time (0: in this process)")
    p.add_argument("--retry-failed", action="store_true", help="try tracks that failed before again")
    li = sub.add_parser("listen", help="Gemini (paid) listens once to each prepared song it hasn't heard")
    li.add_argument("--yes", action="store_true", help="don't ask before spending")
    li.add_argument("--max-inr", type=float, help="stop before spending more than this many rupees")
    sub.add_parser("status", help="track counts, and tracks to check")
    args = ap.parse_args(argv)
    if args.cmd == "listen":
        listen(args.yes, args.max_inr, log=lambda m: print(m, flush=True))
        return
    if args.cmd == "prepare":
        if not (args.library or enabled()):
            ap.error("give --library DIR or set PULSE_LIBRARY")
        res = prepare(args.library, args.workers, args.retry_failed, log=lambda m: print(m, flush=True))
    else:
        res = summary()
    c = res["counts"]
    print(f"Ready {c['ready']} · pending {c['pending']} · failed {c['failed']} · missing {c['missing']}")
    for t in res["flagged"]:
        print(f"  check {t['title']}: {', '.join(t['flags'])}")
    for t in res["failed"]:
        print(f"  failed {t['title']}: {t['error']}")
    from .ai_advisor import get_gemini_api_key
    todo = unlistened() if get_gemini_api_key() else []
    if todo:
        print(f"  {len(todo)} songs Gemini hasn't listened to (about ₹{sum(t['est_inr'] for t in todo):.0f}, once): "
              "python -m backend.library listen")


if __name__ == "__main__":
    main()
