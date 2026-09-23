"""
server.py - FastAPI Application Server for Pro DJ Console.
Handles audio uploads, track analysis, stem separation, mix rendering, presets, and audio streaming.
"""

import os
import uuid
import json
import shutil
import gc
from typing import Optional
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import numpy as np
import soundfile as sf

from .audio_analyzer import analyze_track, check_camelot_compatibility
from .dj_engine import render_pro_transition
from .stem_separator import separate_with_demucs, separate_fast_spectral
from .ai_advisor import generate_ai_dj_strategy
from .set_energy import SetEnergyManager, TECHNIQUE_ENERGY, ENERGY_ARC_TEMPLATES

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
OUTPUT_DIR = os.path.join(BASE_DIR, "outputs")
STEMS_DIR = os.path.join(BASE_DIR, "stems")
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")
CACHE_FILE = os.path.join(UPLOAD_DIR, "analysis_cache.json")

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(STEMS_DIR, exist_ok=True)

app = FastAPI(title="Professional DJ Console Engine")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load pre-analyzed tracks cache
ANALYSIS_CACHE = {}

def load_cache_from_disk():
    global ANALYSIS_CACHE
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, "r") as f:
                ANALYSIS_CACHE = json.load(f)
        except Exception as e:
            print("Failed to load analysis cache:", e)

def save_cache_to_disk():
    try:
        with open(CACHE_FILE, "w") as f:
            json.dump(ANALYSIS_CACHE, f, indent=2)
    except Exception as e:
        print("Failed to save analysis cache:", e)

load_cache_from_disk()

# Set-level energy manager (single instance per server, reset per set)
ENERGY_MGR: Optional[SetEnergyManager] = None

@app.post("/api/set-energy/init")
async def init_set_energy(request: Request):
    """Initialize or reset the set-level energy arc manager."""
    global ENERGY_MGR
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    arc = body.get("arc_template", "festival_mainstage")
    total = body.get("total_tracks", 15)
    ENERGY_MGR = SetEnergyManager(arc_template=arc, total_tracks=total)
    return JSONResponse(content={
        "status": "success",
        "state": ENERGY_MGR.get_state(),
        "available_arcs": list(ENERGY_ARC_TEMPLATES.keys()),
    })

@app.get("/api/set-energy/state")
async def get_set_energy_state():
    """Returns current set energy state."""
    if not ENERGY_MGR:
        return JSONResponse(content={"status": "inactive", "message": "No set energy arc active. POST /api/set-energy/init to start."})
    return JSONResponse(content={"status": "success", "state": ENERGY_MGR.get_state(), "history": ENERGY_MGR.history[-10:]})

@app.get("/api/set-energy/rank")
async def rank_techniques_energy(techniques: str = ""):
    """Rank candidate techniques by energy arc fit. Pass comma-separated technique names."""
    if not ENERGY_MGR:
        return JSONResponse(content={"status": "inactive", "message": "No set energy arc active."})
    candidates = [t.strip() for t in techniques.split(",") if t.strip() in TECHNIQUE_ENERGY]
    if not candidates:
        candidates = list(TECHNIQUE_ENERGY.keys())
    ranked = ENERGY_MGR.rank_techniques(candidates)
    return JSONResponse(content={"status": "success", "ranked": ranked, "state": ENERGY_MGR.get_state()})

@app.get("/api/presets")
async def get_presets():
    """Returns available pre-loaded club tracks and sets."""
    load_cache_from_disk()
    available_tracks = []
    for fn, data in ANALYSIS_CACHE.items():
        if os.path.exists(os.path.join(UPLOAD_DIR, fn)):
            available_tracks.append({
                "file_id": fn,
                "title": data.get("title", fn),
                "bpm": data.get("bpm", 128.0),
                "camelot": data.get("camelot", "--"),
                "key": data.get("key", "--"),
                "duration": data.get("duration", 180.0)
            })
        
    sets = []
    if os.path.exists(os.path.join(UPLOAD_DIR, "Laserpack.mp3")) and os.path.exists(os.path.join(UPLOAD_DIR, "Overworld.mp3")):
        sets.append({
            "id": "club_set_1",
            "name": "⚡ Club Peak-Time: Laserpack → Overworld (129 → 132 BPM)",
            "deck_1": "Laserpack.mp3",
            "deck_2": "Overworld.mp3",
            "description": "High energy club house transition with phrase-locked bass drop."
        })
    return JSONResponse(content={"status": "success", "tracks": available_tracks, "sets": sets})

@app.post("/api/load-preset")
async def load_preset(file_id: str = Form(...), deck: str = Form("deck_1")):
    """Instantly loads a pre-analyzed track into Deck 1 or Deck 2."""
    import urllib.parse
    load_cache_from_disk()
    target_id = file_id
    if target_id not in ANALYSIS_CACHE:
        unquoted = urllib.parse.unquote(file_id)
        if unquoted in ANALYSIS_CACHE:
            target_id = unquoted

    if target_id in ANALYSIS_CACHE:
        data = dict(ANALYSIS_CACHE[target_id])
        data["deck"] = deck
        data["audio_url"] = f"/api/audio/{urllib.parse.quote(target_id)}"
        return JSONResponse(content={"status": "success", "track": data})
        
    path = os.path.join(UPLOAD_DIR, target_id)
    if not os.path.exists(path):
        path = os.path.join(UPLOAD_DIR, urllib.parse.unquote(target_id))
        if not os.path.exists(path):
            raise HTTPException(status_code=404, detail=f"Track {file_id} not found")
        
    an = analyze_track(path)
    an["file_id"] = target_id
    an["deck"] = deck
    an["audio_url"] = f"/api/audio/{urllib.parse.quote(target_id)}"
    ANALYSIS_CACHE[target_id] = an
    save_cache_to_disk()
    return JSONResponse(content={"status": "success", "track": an})

@app.post("/api/upload")
async def upload_track(file: UploadFile = File(...), deck: str = Form("deck_1")):
    """Uploads an audio file, analyzes BPM, Key, Beatgrid, and Waveform."""
    import urllib.parse
    try:
        clean_name = os.path.basename(file.filename)
        ext = os.path.splitext(clean_name)[1].lower()
        if ext not in [".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac"]:
            raise HTTPException(status_code=400, detail="Unsupported audio format")
            
        file_id = f"{deck}_{clean_name.replace(' ', '_')}"
        save_path = os.path.join(UPLOAD_DIR, file_id)
        
        # Purge prior temporary files for this deck to keep disk usage lean
        try:
            for existing in os.listdir(UPLOAD_DIR):
                if existing.startswith(f"{deck}_") and existing != file_id:
                    p = os.path.join(UPLOAD_DIR, existing)
                    if os.path.isfile(p):
                        os.remove(p)
        except Exception:
            pass

        with open(save_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        # Analyze track
        analysis = analyze_track(save_path)
        analysis["file_id"] = file_id
        analysis["title"] = clean_name
        analysis["deck"] = deck
        analysis["audio_url"] = f"/api/audio/{urllib.parse.quote(file_id)}"
        
        ANALYSIS_CACHE[file_id] = analysis
        
        # Keep cache lean (max 10 recent items)
        if len(ANALYSIS_CACHE) > 10:
            for k in list(ANALYSIS_CACHE.keys())[:-10]:
                ANALYSIS_CACHE.pop(k, None)

        save_cache_to_disk()
        gc.collect()
        return JSONResponse(content={"status": "success", "track": analysis})
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/compatibility")
async def get_compatibility(camelot_1: str, camelot_2: str, direction: str = "1_to_2"):
    """Calculates Camelot harmonic mixing relationship for the given direction."""
    if direction == "2_to_1":
        return check_camelot_compatibility(camelot_2, camelot_1)
    return check_camelot_compatibility(camelot_1, camelot_2)

@app.get("/api/ai-recommendation")
async def get_ai_recommendation(file_id_1: str, file_id_2: str, direction: str = "1_to_2"):
    """AI Live Decision Engine recommendation endpoint supporting bidirectional mixing."""
    track_1_path = os.path.join(UPLOAD_DIR, file_id_1)
    track_2_path = os.path.join(UPLOAD_DIR, file_id_2)
    if not os.path.exists(track_1_path) or not os.path.exists(track_2_path):
        raise HTTPException(status_code=404, detail="Tracks not found")

    an1 = ANALYSIS_CACHE.get(file_id_1)
    if not an1 or "acoustic_profile" not in an1:
        an1 = analyze_track(track_1_path)
        an1["file_id"] = file_id_1
        ANALYSIS_CACHE[file_id_1] = an1

    an2 = ANALYSIS_CACHE.get(file_id_2)
    if not an2 or "acoustic_profile" not in an2:
        an2 = analyze_track(track_2_path)
        an2["file_id"] = file_id_2
        ANALYSIS_CACHE[file_id_2] = an2

    from .dj_engine import ai_analyze_and_recommend_transition
    if direction == "2_to_1":
        rec = ai_analyze_and_recommend_transition(an2, an1)
    else:
        rec = ai_analyze_and_recommend_transition(an1, an2)
    return JSONResponse(content={"status": "success", "recommendation": rec})

@app.get("/api/ai-status")
async def get_ai_status():
    """Checks whether AI providers (Jev System One or Gemini) are configured via server environment."""
    from .ai_advisor import get_jev_api_key, get_gemini_api_key
    has_jev = bool(get_jev_api_key())
    has_gemini = bool(get_gemini_api_key())
    return JSONResponse(content={
        "status": "success",
        "jev_configured": has_jev,
        "gemini_configured": has_gemini,
        "active_engine": "jev" if has_jev else ("gemini" if has_gemini else "local")
    })

def slice_audio_file_to_b64(file_path: str, start_sec: float, duration_sec: float = 10.0) -> Optional[str]:
    """Slices a lightweight 10s audio segment from an audio file into base64 WAV for Gemini headphone audition."""
    import io
    import soundfile as sf
    import base64
    import numpy as np
    try:
        with sf.SoundFile(file_path) as f:
            sr = f.samplerate
            start_frame = int(max(0, start_sec) * sr)
            max_frames = int(duration_sec * sr)
            if start_frame < f.frames:
                f.seek(start_frame)
                data = f.read(frames=max_frames)
            else:
                f.seek(0)
                data = f.read(frames=max_frames)

            # Convert to mono if multi-channel
            if len(data.shape) > 1 and data.shape[1] > 1:
                data = data.mean(axis=1)

            # Sub-sample to 16kHz for fast, lightweight audition transmission
            target_sr = 16000
            if sr != target_sr:
                step = sr / target_sr
                indices = (np.arange(0, int(len(data) / step)) * step).astype(int)
                indices = indices[indices < len(data)]
                data = data[indices]
                sr = target_sr

            buf = io.BytesIO()
            sf.write(buf, data, sr, format='WAV', subtype='PCM_16')
            return base64.b64encode(buf.getvalue()).decode('utf-8')
    except Exception as e:
        print(f"Error slicing audio file {file_path}: {e}")
        return None

@app.post("/api/jev-blueprint")
async def get_jev_blueprint(request: Request):
    """
    Jev Autonomous DJ Brain:
    1. Gemini Multimodal Audio Audition (AI Headphones / PFL): listens to a 10s audio slice
       of the incoming track in its headphones and crafts a precision transition blueprint.
    2. Jev System One Typed Pipeline: runs 3-4 chained typed question passes.
    3. Resilient Local Acoustic Heuristics (0ms fallback).
    """
    from .ai_advisor import get_jev_api_key, get_gemini_api_key
    from .jev_blueprint import run_jev_pipeline, run_gemini_audition_pipeline, compile_local_fallback_blueprint

    try:
        body = await request.json()
    except Exception:
        return JSONResponse(content={"status": "error", "detail": "Invalid JSON body"}, status_code=400)

    profile_out = body.get("profile_out", {})
    profile_in = body.get("profile_in", {})
    provided_key = body.get("jev_api_key", None)
    provided_gemini_key = body.get("gemini_api_key", None)
    audio_b64 = body.get("audio_clip_b64", None)
    audio_mime = body.get("audio_mime", "audio/wav")
    file_id_in = body.get("file_id_in", None)
    cue_time = body.get("cue_time", None)

    # Server-side audio slicing if client didn't supply audio_clip_b64 but file_id_in exists on disk
    if not audio_b64 and file_id_in:
        try:
            target_path = os.path.join(UPLOAD_DIR, file_id_in)
            if not os.path.exists(target_path):
                target_path = os.path.join(UPLOAD_DIR, urllib.parse.unquote(file_id_in))
            if os.path.exists(target_path):
                audio_b64 = slice_audio_file_to_b64(target_path, float(cue_time or 0.0), 10.0)
                if audio_b64:
                    audio_mime = "audio/wav"
        except Exception as slice_err:
            print(f"Server-side audio slicing note: {slice_err}")

    gemini_key = get_gemini_api_key(provided_gemini_key or provided_key)
    jev_key = get_jev_api_key(provided_key)

    blueprint = None
    gemini_audition_note = None
    try:
        # Priority 1: Google Gemini Multimodal Audio Audition ("AI Headphones")
        if gemini_key:
            bp, g_err = run_gemini_audition_pipeline(
                profile_out, profile_in, gemini_key,
                audio_b64=audio_b64, audio_mime=audio_mime
            )
            if bp:
                blueprint = bp
            elif g_err:
                gemini_audition_note = g_err
                print(f"Gemini audition returned note ({g_err}), falling back to Jev/Local...")

        # Priority 2: TypeSafe Jev System One Typed Pipeline
        if not blueprint and jev_key:
            bp, j_err = run_jev_pipeline(profile_out, profile_in, jev_key)
            if bp:
                blueprint = bp
            elif j_err:
                print(f"Jev pipeline returned note ({j_err}), falling back to local blueprint...")

        # Priority 3: Local Resilient Heuristic Blueprint
        if not blueprint:
            blueprint = compile_local_fallback_blueprint(profile_out, profile_in)

        if blueprint and gemini_audition_note and "meta" in blueprint and not blueprint["meta"].get("ai_ears"):
            blueprint["meta"]["gemini_fallback_note"] = gemini_audition_note

    except Exception as exc:
        print(f"Blueprint exception ({exc}), compiling resilient local fallback")
        blueprint = compile_local_fallback_blueprint(profile_out, profile_in)
        blueprint["meta"]["jev_fallback_reason"] = str(exc)

    return JSONResponse(content={
        "status": "success",
        "blueprint": blueprint
    })

@app.post("/api/ai-strategy")
async def get_ai_strategy_endpoint(
    file_id_1: str = Form(...),
    file_id_2: str = Form(...),
    direction: str = Form("1_to_2"),
    gemini_api_key: Optional[str] = Form(None),
    jev_api_key: Optional[str] = Form(None),
    model: str = Form("jev-latest"),
    track_1_meta: Optional[str] = Form(None),
    track_2_meta: Optional[str] = Form(None)
):
    """Deep AI DJ Co-Pilot Strategy using Gemini LLM or Local Acoustic Engine."""
    import urllib.parse
    fid1 = urllib.parse.unquote(file_id_1)
    fid2 = urllib.parse.unquote(file_id_2)

    # 1. Resolve Track 1 Profile
    an1 = ANALYSIS_CACHE.get(fid1) or ANALYSIS_CACHE.get(file_id_1)
    if not an1:
        p1 = os.path.join(UPLOAD_DIR, fid1)
        if not os.path.exists(p1):
            p1 = os.path.join(UPLOAD_DIR, file_id_1)
        if os.path.exists(p1):
            try:
                an1 = analyze_track(p1)
                an1["file_id"] = fid1
                ANALYSIS_CACHE[fid1] = an1
            except Exception as e:
                print(f"Error analyzing {p1}: {e}")
                an1 = None

    if not an1 and track_1_meta:
        try:
            an1 = json.loads(track_1_meta)
        except Exception:
            an1 = None

    if not an1:
        an1 = {
            "file_id": fid1,
            "title": fid1.replace(".mp3", "").replace(".wav", "").replace("_", " "),
            "bpm": 128.0,
            "camelot": "8A",
            "key": "A Minor",
            "duration": 180.0,
            "suggested_cue_intro": 0.0,
            "suggested_cue_outro": 120.0,
            "phrase_16_times": [0.0, 30.0, 60.0, 90.0, 120.0],
            "acoustic_profile": {
                "intro_vocal_score": 0.1,
                "outro_vocal_score": 0.1,
                "intro_percussion": "driving_4_4",
                "outro_percussion": "driving_4_4"
            }
        }

    # 2. Resolve Track 2 Profile
    an2 = ANALYSIS_CACHE.get(fid2) or ANALYSIS_CACHE.get(file_id_2)
    if not an2:
        p2 = os.path.join(UPLOAD_DIR, fid2)
        if not os.path.exists(p2):
            p2 = os.path.join(UPLOAD_DIR, file_id_2)
        if os.path.exists(p2):
            try:
                an2 = analyze_track(p2)
                an2["file_id"] = fid2
                ANALYSIS_CACHE[fid2] = an2
            except Exception as e:
                print(f"Error analyzing {p2}: {e}")
                an2 = None

    if not an2 and track_2_meta:
        try:
            an2 = json.loads(track_2_meta)
        except Exception:
            an2 = None

    if not an2:
        an2 = {
            "file_id": fid2,
            "title": fid2.replace(".mp3", "").replace(".wav", "").replace("_", " "),
            "bpm": 128.0,
            "camelot": "8A",
            "key": "A Minor",
            "duration": 180.0,
            "suggested_cue_intro": 0.0,
            "suggested_cue_outro": 120.0,
            "phrase_16_times": [0.0, 30.0, 60.0, 90.0, 120.0],
            "acoustic_profile": {
                "intro_vocal_score": 0.1,
                "outro_vocal_score": 0.1,
                "intro_percussion": "driving_4_4",
                "outro_percussion": "driving_4_4"
            }
        }

    if direction == "2_to_1":
        info_out, info_in = an2, an1
    else:
        info_out, info_in = an1, an2

    strategy = generate_ai_dj_strategy(
        info_out=info_out,
        info_in=info_in,
        direction=direction,
        gemini_api_key=gemini_api_key,
        jev_api_key=jev_api_key,
        model_name=model
    )
    return JSONResponse(content={"status": "success", "strategy": strategy})

@app.post("/api/render-mix")
async def render_mix(
    file_id_1: str = Form(...),
    file_id_2: str = Form(...),
    direction: str = Form("1_to_2"),
    technique: str = Form("auto"),
    bars: int = Form(16),
    tempo_ramp: bool = Form(True),
    harmonic_lock: bool = Form(True),
    use_stems: bool = Form(False),
    cue_1: Optional[float] = Form(None),
    cue_2: Optional[float] = Form(None)
):
    """Renders pro-grade DJ transition between Track 1 and Track 2 in either direction."""
    track_1_path = os.path.join(UPLOAD_DIR, file_id_1)
    track_2_path = os.path.join(UPLOAD_DIR, file_id_2)
    
    if not os.path.exists(track_1_path) or not os.path.exists(track_2_path):
        raise HTTPException(status_code=404, detail="One or both tracks not found")
        
    mix_hash = uuid.uuid4().hex[:8]
    clean_id_1 = os.path.splitext(file_id_1)[0][:24].strip('_')
    clean_id_2 = os.path.splitext(file_id_2)[0][:24].strip('_')

    if direction == "2_to_1":
        out_path = track_2_path
        in_path = track_1_path
        out_cue = cue_2
        in_cue = cue_1
        clean_out = clean_id_2
        clean_in = clean_id_1
    else:
        out_path = track_1_path
        in_path = track_2_path
        out_cue = cue_1
        in_cue = cue_2
        clean_out = clean_id_1
        clean_in = clean_id_2

    mix_id = f"mix_{clean_out}_to_{clean_in}_{technique}_{bars}b_{mix_hash}.wav"
    output_path = os.path.join(OUTPUT_DIR, mix_id)
    
    try:
        result = render_pro_transition(
            track_1_path=out_path,
            track_2_path=in_path,
            output_path=output_path,
            technique=technique,
            bars=bars,
            tempo_ramp=tempo_ramp,
            harmonic_lock=harmonic_lock,
            use_stems=use_stems,
            custom_cue_1=out_cue,
            custom_cue_2=in_cue
        )
        result["mix_url"] = f"/api/outputs/{mix_id}"
        result["direction"] = direction

        used_technique = result.get("technique", technique)
        if ENERGY_MGR and used_technique in TECHNIQUE_ENERGY:
            ENERGY_MGR.apply_transition(used_technique)
            result["set_energy"] = ENERGY_MGR.get_state()

        gc.collect()
        return JSONResponse(content={"status": "success", "mix": result})
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/separate-stems")
async def separate_stems_endpoint(file_id: str = Form(...), mode: str = Form("fast")):
    """Separates audio into 4 stems (fast DSP or Demucs)."""
    track_path = os.path.join(UPLOAD_DIR, file_id)
    if not os.path.exists(track_path):
        raise HTTPException(status_code=404, detail="Track not found")
        
    try:
        if mode == "demucs":
            stems = separate_with_demucs(track_path, STEMS_DIR)
        else:
            stems = separate_fast_spectral(track_path, STEMS_DIR)
            
        stem_urls = {
            stem: f"/api/stems/{os.path.basename(path)}" 
            for stem, path in stems.items()
        }
        gc.collect()
        return JSONResponse(content={"status": "success", "stems": stem_urls})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/audio/{filename:path}")
async def get_audio(filename: str):
    import urllib.parse
    decoded = urllib.parse.unquote(filename)
    path = os.path.join(UPLOAD_DIR, decoded)
    if not os.path.exists(path):
        path = os.path.join(UPLOAD_DIR, filename)
        if not os.path.exists(path):
            raise HTTPException(status_code=404, detail=f"File not found: {decoded}")
            
    media = "audio/mpeg" if path.lower().endswith(".mp3") else "audio/wav"
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=86400"
    }
    return FileResponse(path, media_type=media, headers=headers)

@app.get("/api/outputs/{filename:path}")
async def get_output(filename: str):
    import urllib.parse
    decoded = urllib.parse.unquote(filename)
    path = os.path.join(OUTPUT_DIR, decoded)
    if not os.path.exists(path):
        path = os.path.join(OUTPUT_DIR, filename)
        if not os.path.exists(path):
            raise HTTPException(status_code=404, detail=f"Mix not found: {decoded}")
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Accept-Ranges": "bytes"
    }
    return FileResponse(path, filename=os.path.basename(path), media_type="audio/wav", headers=headers)

@app.get("/api/stems/{filename:path}")
async def get_stem(filename: str):
    import urllib.parse
    decoded = urllib.parse.unquote(filename)
    path = os.path.join(STEMS_DIR, decoded)
    if not os.path.exists(path):
        path = os.path.join(STEMS_DIR, filename)
        if not os.path.exists(path):
            raise HTTPException(status_code=404, detail=f"Stem not found: {decoded}")
    headers = {
        "Access-Control-Allow-Origin": "*",
        "Accept-Ranges": "bytes"
    }
    return FileResponse(path, media_type="audio/wav", headers=headers)

@app.post("/api/generate-demo-tracks")
async def generate_demo_tracks_endpoint():
    """Returns the pre-cached tracks if present on disk, otherwise signals empty state for local selection."""
    import urllib.parse
    load_cache_from_disk()
    t1 = ANALYSIS_CACHE.get("Laserpack.mp3")
    t2 = ANALYSIS_CACHE.get("Overworld.mp3")
    p1 = os.path.join(UPLOAD_DIR, "Laserpack.mp3")
    p2 = os.path.join(UPLOAD_DIR, "Overworld.mp3")
    
    if t1 and t2 and os.path.exists(p1) and os.path.exists(p2):
        t1_out = dict(t1)
        t1_out["deck"] = "deck_1"
        t1_out["audio_url"] = f"/api/audio/{urllib.parse.quote('Laserpack.mp3')}"
        
        t2_out = dict(t2)
        t2_out["deck"] = "deck_2"
        t2_out["audio_url"] = f"/api/audio/{urllib.parse.quote('Overworld.mp3')}"
        
        return JSONResponse(content={
            "status": "success",
            "track_1": t1_out,
            "track_2": t2_out
        })
    return JSONResponse(content={
        "status": "empty",
        "message": "Local-first mode active. Select local tracks or drop audio files onto Deck 1 and Deck 2."
    })

@app.post("/api/cue-preview")
async def cue_preview(
    file_id: str = Form(...),
    cue_sec: Optional[float] = Form(None),
    bars: int = Form(4),
    bpm: Optional[float] = Form(None),
    eq_hi: float = Form(1.0),
    eq_mid: float = Form(1.0),
    eq_low: float = Form(1.0),
    hpf: float = Form(0.0),
    lpf: float = Form(0.0),
):
    """PFL / headphone CUE preview: renders a short segment from cue point with EQ sculpting."""
    import urllib.parse, librosa
    from .dj_engine import split_3band
    decoded = urllib.parse.unquote(file_id)
    path = os.path.join(UPLOAD_DIR, decoded)
    if not os.path.exists(path):
        path = os.path.join(UPLOAD_DIR, file_id)
        if not os.path.exists(path):
            raise HTTPException(status_code=404, detail=f"Track not found: {file_id}")

    y, sr_native = librosa.load(path, sr=None, mono=False)
    if y.ndim == 1:
        y = np.vstack([y, y])
    sr = sr_native

    an = ANALYSIS_CACHE.get(decoded) or ANALYSIS_CACHE.get(file_id) or {}
    track_bpm = bpm or an.get("bpm", 120.0)
    spb = 60.0 / track_bpm

    if cue_sec is None:
        cue_sec = an.get("cue_point", 0.0)

    start_sample = int(cue_sec * sr)
    preview_samples = int(bars * 4 * spb * sr)
    segment = y[:, start_sample:start_sample + preview_samples]
    if segment.shape[1] == 0:
        raise HTTPException(status_code=400, detail="Cue point beyond track length")

    if eq_hi != 1.0 or eq_mid != 1.0 or eq_low != 1.0:
        low, mid, high = split_3band(segment, sr)
        segment = low * eq_low + mid * eq_mid + high * eq_hi

    if hpf > 0.0:
        from scipy.signal import butter, sosfilt
        freq = max(20.0, min(hpf, sr * 0.45))
        sos = butter(4, freq, btype='high', fs=sr, output='sos')
        segment = sosfilt(sos, segment, axis=1)

    if lpf > 0.0:
        from scipy.signal import butter, sosfilt
        freq = max(20.0, min(lpf, sr * 0.45))
        sos = butter(4, freq, btype='low', fs=sr, output='sos')
        segment = sosfilt(sos, segment, axis=1)

    preview_name = f"pfl_preview_{uuid.uuid4().hex[:8]}.wav"
    preview_path = os.path.join(OUTPUT_DIR, preview_name)
    sf.write(preview_path, segment.T, sr, subtype="PCM_16")

    return JSONResponse(content={
        "status": "success",
        "audio_url": f"/api/outputs/{urllib.parse.quote(preview_name)}",
        "cue_sec": cue_sec,
        "duration_sec": segment.shape[1] / sr,
        "bpm": track_bpm,
        "eq": {"hi": eq_hi, "mid": eq_mid, "low": eq_low},
    })

# Mount frontend files
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("backend.server:app", host="0.0.0.0", port=port)

