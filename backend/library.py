"""
library.py - The local library: one folder of music, prepared before the gig (as Serato and rekordbox
prepare a collection).

Local mode is on when PULSE_LIBRARY names a folder. `python -m backend.library prepare` analyzes every
track in it once; the console lists and loads only tracks whose every stage has passed, and uploads
are off. Without PULSE_LIBRARY nothing here runs and the server works as before (uploads, bucket).

Index (SQLite, PULSE_DATA/library.db, ~/.pulsepro by default):
  files   every audio file seen: path, size, mtime and SHA-1 (hashed again only when size or mtime change)
  tracks  one row per audio content (SHA-1): renamed, moved or duplicated files are one track, so its
          analysis, grid fixes and labels survive. Each stage keeps the version it ran at: a newer
          analyzer re-runs only the stages that changed.

    python -m backend.library prepare [--library DIR] [--workers N] [--retry-failed]
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

from .audio_analyzer import analyze_track, ANALYSIS_VERSION
from .vocal_listen import carry_vocal_labels
from .grid_check import check_track, DRIFT_FLAG_MS
from . import next_track

AUDIO_EXTS = (".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac")

# Stage -> version, in the order they run. Bump a version to re-run that stage on the whole library at
# the next prepare. A stage re-runs too when one it builds on does (AFTER).
STAGES = {"analysis": ANALYSIS_VERSION, "loudness": 2, "grid_check": 1}
AFTER = {"grid_check": "analysis"}   # the grid check measures the analysis's grid

# A grid that lands fewer of its strong beats within 20 ms than this is flagged for a check
# (provisional: tuned on the Phase 2 benchmark)
LOW_GRID_CONFIDENCE = 0.5


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
    return flags


def _prepare_one(path: str, todo: List[str], prior: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Run the stages in `todo` on one file (in a worker process). Returns the new analysis."""
    an = dict(prior or {})
    if "analysis" in todo:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)   # numpy empty-slice noise on short sections
            fresh = analyze_track(path)
        carry_vocal_labels(fresh, prior)   # Gemini's labels survive a re-analysis
        for keep in ("loudness_lufs", "loudness_range_lu", "loudness_st"):
            if keep in an:
                fresh[keep] = an[keep]
        an = fresh
    if "loudness" in todo:
        an.update(measure_loudness(path))
    if "grid_check" in todo:
        an.update(check_track(path, an["grid"], an["duration"]))
    return an


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
    if all(stages.get(s) == v for s, v in STAGES.items()):
        return "ready"
    return "failed" if error else "pending"


def index(con: sqlite3.Connection, root: str, log=print) -> None:
    """Bring the index in line with the folder: hash new or changed files, one track per audio,
    follow renames and moves, and mark tracks whose files are all gone as missing."""
    paths = scan(root)
    known = {r["path"]: r for r in con.execute("SELECT * FROM files")}
    hashed = 0
    for p in paths:
        st = os.stat(p)
        r = known.get(p)
        if r and r["size"] == st.st_size and r["mtime"] == st.st_mtime:
            continue
        con.execute("INSERT OR REPLACE INTO files VALUES (?, ?, ?, ?)", (p, st.st_size, st.st_mtime, _sha1_file(p)))
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
        workers = max(1, min(6, (os.cpu_count() or 2) - 2))   # ~300 MB each while analyzing
    with closing(_connect()) as con:
        index(con, root, log)
        labelled = _uploaded_labels()
        jobs = []
        for t in con.execute("SELECT * FROM tracks WHERE status IN ('pending', 'failed', 'ready')"):
            if t["status"] == "failed" and not retry_failed:
                continue
            stages = json.loads(t["stages"] or "{}")
            todo = [s for s, v in STAGES.items() if stages.get(s) != v]
            todo = [s for s in STAGES if s in todo or AFTER.get(s) in todo]
            if todo:
                prior = json.loads(t["analysis"]) if t["analysis"] else labelled.get(t["sha1"])
                jobs.append((t["file_id"], t["path"], todo, prior, stages, t["sha1"], t["title"]))
        if not jobs:
            log("Everything is prepared.")
            return summary(con)
        log(f"Preparing {len(jobs)} tracks with {workers or 1} worker(s)...")

        def finish(job, an, err, n):
            file_id, _, todo, prior, stages, sha, title = job
            if err is None:
                stages = dict(stages, **{s: STAGES[s] for s in todo})
                an.update(file_id=file_id, title=title, content_sha1=sha)
            else:
                an = prior if prior and prior.get("file_id") == file_id else {}   # not an upload's labels
            _store(con, file_id, an, stages, err)
            what = (f"{float(an.get('bpm') or 0):.2f} BPM, {an.get('camelot', '--')}, {an.get('loudness_lufs', '?')} LUFS"
                    + (f", check: {', '.join(flags_for(an))}" if flags_for(an) else "")) if err is None else f"FAILED: {err}"
            log(f"[{n}/{len(jobs)}] {title} · {what}")

        if workers == 0:
            for n, job in enumerate(jobs, 1):
                try:
                    finish(job, _prepare_one(job[1], job[2], job[3]), None, n)
                except Exception as e:
                    finish(job, None, str(e) or type(e).__name__, n)
        else:
            with ProcessPoolExecutor(workers, mp_context=multiprocessing.get_context("spawn"),
                                     max_tasks_per_child=4) as ex:
                futs = {ex.submit(_prepare_one, j[1], j[2], j[3]): j for j in jobs}
                for n, fut in enumerate(as_completed(futs), 1):
                    try:
                        finish(futs[fut], fut.result(), None, n)
                    except Exception as e:
                        finish(futs[fut], None, str(e) or type(e).__name__, n)
        return summary(con)


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


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="python -m backend.library", description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prepare", help="analyze every new or changed track in the library folder")
    p.add_argument("--library", help="the music folder (default: $PULSE_LIBRARY)")
    p.add_argument("--workers", type=int, help="tracks at a time (0: in this process)")
    p.add_argument("--retry-failed", action="store_true", help="try tracks that failed before again")
    sub.add_parser("status", help="track counts, and tracks to check")
    args = ap.parse_args(argv)
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


if __name__ == "__main__":
    main()
