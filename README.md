# PULSE PRO // Professional AI DJ Console

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

Pulse Pro is a full-stack, browser-based professional DJ mixing console engineered for seamless, imperceptible track transitions. It combines a 60 FPS Web Audio physical DSP engine with an intelligent acoustic decision brain.

---

## Key Features

- **Phase-Locked Loop (PLL) Engine**:
  - Closed-loop proportional pitch nudging operating at 60 FPS ($16.6\text{ ms}$).
  - Pioneer CDJ-3000 style visual phase meter HUD showing real-time offset in milliseconds ($\pm 2.0\text{ ms}$ locked target).
  - Sub-millisecond quantized beat phase snapping on play/sync.

- **Pro Multi-Technique Layered Transitions**:
  - **Quintic Smootherstep ($6t^5 - 15t^4 + 10t^3$)**: Faders and rotary EQ knobs start and stop with zero jerk and zero audible clicks.
  - **Highs-First-In / Highs-Last-Out**: 16th-note hi-hats lead the mix (Bars 1–8) to seed the groove; outgoing highs stay active through 92% of the transition to maintain tempo momentum.
  - **Linkwitz-Riley 40% Equal-Power Bass Crossover**: Smooth $\cos/\sin$ power curve handoff over 6–8 bars eliminating double-kick mud and energy dips.
  - **Gradual HPF Washout & 3/4-Beat Echo Tail**: Thins low-mids on outgoing track before catching the exit in a spacious delay wash.
  - **Stem-Aware Vocal Formant Protection**: Prevents vocal collisions by ducking outgoing mids up to $-8\text{ dB}$ when singing is detected.
  - **Loop Roll Stutter (`loop_roll`)**: Accelerating $1/2 \to 1/4 \to 1/8 \to 1/16$ beat division repeats with anti-click envelopes.
  - **Festival Build & Drop (`festival_drop`)**: Multi-technique composite (HPF sweep + loop roll + white noise riser $\to$ 1-beat silence gap $\to$ $70\text{ Hz}\to 35\text{ Hz}$ sub-drop impact boom).

- **Physical Acoustic Decision Engine**:
  - Pre-computed Librosa spectral profiles for 40 club tracks (BPM, Downbeats, Camelot Keys, Vocal Formants, Percussion Density).
  - Real-time tactical technique recommendations (`/api/ai-strategy`).

- **Lossless 24-Bit WAV Exporter**:
  - Offline mix rendering pipeline mirroring physical mixer knob motions.

---

## Architecture Overview

```
Browser Client (100% Client-Side Audio DSP)
├── Web Audio API Graph (Source → 3-Band EQ → 4-Band Stems → Color FX → Fader → Delay → Crossfader)
├── 60 FPS RequestAnimationFrame Loop (PLL Phase-Lock Steering)
└── Canvas Beat-Grid Waveforms & Rotary Jog Wheels
       ▲
       │ HTTP / JSON API
       ▼
FastAPI Backend (Python 3.11)
├── Librosa Physical Acoustic Analyzer (BPM, Downbeats, Camelot Keys, Vocal Ratios)
├── AI Strategic Conductor (/api/ai-strategy)
└── Lossless 24-Bit WAV Audio Engine (/api/render-mix)
```

---

## Local Quickstart

### Prerequisites
- Python 3.10+
- `ffmpeg` and `libsndfile1` (e.g. `brew install ffmpeg libsndfile` on macOS, or `apt-get install ffmpeg libsndfile1` on Ubuntu)

### Installation
```bash
# Clone the repository
git clone https://github.com/ash0503gh/dj.git
cd dj

# Create and activate virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Start the server
uvicorn backend.server:app --host 127.0.0.1 --port 8000 --reload
```

Open [http://localhost:8000](http://localhost:8000) in your browser.

---

## Deploy to Google Cloud Run (recommended)

2 vCPU / 4 GB, scale to zero, request-based billing in `us-central1` (Cloud Run's free monthly
quota applies). Uploaded tracks, analyses and keylocked renders are kept in a Cloud Storage bucket,
so the library survives restarts.

```bash
gcloud auth login                                   # once
export GEMINI_API_KEY=...  JEV_API_KEY=...          # optional, stored in Secret Manager
PROJECT=<your-project-id> ./deploy/cloudrun.sh
```

The script enables the APIs, creates the bucket (keylocked renders expire after 30 days), a service
account with access to that bucket only, and deploys the Dockerfile with `GCS_BUCKET` set.
Without `GCS_BUCKET` (local runs, Render) everything stays on local disk.

## Deploy to Render.com

This repository includes a production-ready `render.yaml` Blueprint and an optimized `Dockerfile`.

### 1-Click Deployment via Blueprint:
1. Log in to [Render.com](https://dashboard.render.com).
2. Click **New +** → **Blueprint**.
3. Connect your GitHub repository (`ash0503gh/dj`).
4. Click **Apply**. Render will automatically build the Docker image with system audio libraries and deploy the service.

### Manual Web Service Setup:
- **Environment**: Docker
- **Branch**: `main`
- **Plan**: Free
- **Health Check Path**: `/api/presets`

---

## License
MIT
