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

- **Auto: searched, measured, played only when confident** (Auto technique):
  - Building blocks (`mix_blocks.js`): every move a DJ makes on the mixer — 3-band EQ, isolator bass swap,
    filters, fader, echo, reverb, accelerating loop roll — scheduled on the audio clock, identical live
    and in the offline sound check. A mix = a timing skeleton from the planner (where the outgoing leaves,
    where the incoming enters, when the bass hands over) + a style (plain data: how the mids hand over,
    how the outgoing leaves, how the incoming enters, how long the lead-in is). Nothing is tied to a
    song pair: the search decides.
  - Styles tried: beat-matched blends within 12% of tempo (at the incoming's own tempo, or at half or double
    time: a 90 BPM track under a 180 BPM dhol mix plays its beats on every other beat, planned with the
    incoming counted at that multiple), the incoming keylocked (past 8% a blend costs
    0.5 points per extra percent: the stretch starts to smear) (mids overlap, snap (change hands over the
    bar before the swap: the outgoing's mids go over its first three beats, the incoming's come over the
    last three, gradual but never both at full), crossfade, or "hats in": only the incoming's hats,
    high-passed at 4 kHz, until the bar before the swap, where its filter opens the same way as the
    outgoing's mids go; outgoing out by EQ, filter, echo or reverb;
    the incoming entering so its first drop lands as the blend ends, from its intro, so its hook lands
    as the blend ends, or over an automatic intro edit: its beat-only bars (no lead vocal by Gemini's
    labels) loop under the outgoing and the track drops in on its hook at the bass swap, as DJs use
    DJ-pool intro edits on tracks that start singing at once) and, when tempos are more than 12% apart, switches on a phrase line (echo, reverb, cut,
    vinyl brake or spinback, after a high-pass rise, a noise riser with an impact on the landing, a loop
    roll or a reverb swell) and filter washes (spectral crossfade), landing the incoming on its drop, on
    the build before it, on its hook (the 8-bar phrase that comes back most, found by the analyzer), on
    its intro, or as its first vocal line starts. Plain switches also come in a soft-landing version:
    the incoming rises in over two bars (fader from half, a 300 Hz high-pass opening) rather than at
    full volume, and the sound check allows that rise 9 dB.
    Brake and spinback exits are a last resort: searched after everything else (waiting for a clean
    moment included), played only when no other mix clears the bar and they beat the best one by 10.
  - Tempo: one constant grid fitted to the whole track; the tempo is checked against double/half and
    against 3/4, 4/3, 2/3 and 3/2 of itself (dancehall, reggaeton and trap rhythms read as a tempo a
    third off), keeping the grid that lands on the most kicks and snares and repeats most strongly
    every beat and bar. A re-analysis keeps Gemini's vocal labels (mapped onto the new sections).
  - Gemini listens to each audio file once: its labels are found again by the audio's fingerprint
    (other deck, other name, newer analyzer) before any new listen, and the fingerprint pointer in the
    bucket always stays on a labelled copy.
  - Memory (phones close tabs that hold too much): a deck that mixed out drops its keylocked copy,
    keylocked copies are kept only for tracks on the decks, and touch devices don't keep the last
    mix's buffers for export.
  - Search: the planner's best moments x every style (60-500 mixes) are rendered offline and measured a
    few at a time while the music plays (~0.15-0.35 s each, four renders at once on a computer, one on a
    phone; bass gaps/mud, holes against the outgoing's own level, level dips/spikes, mid and hat clashes
    of two tempos; deliberate builds excused). A mix that couldn't beat the best found even at its best
    case isn't measured: a flawless sound check, or for a blend whose family (same moment and style,
    another tail) has been measured, 6 penalty points cleaner than the family's cleanest (tails moved it
    at most 5.2 over 519 comparisons; a switch's exit moves it far more, so switches get no such bound).
  - Confidence (0-100): measured sound and taste — the DJ's ratings of similar mixes, kept per kind
    (blend, filter wash, switch) and per detail of the style (a GOOD /
    NOT FOR ME prompt after each Auto mix, stored per feature at `/api/feedback`), and Jev's rating once
    Jev has rated the leaders, weighed by how well Jev has agreed with the DJ: up to half of taste at 80%
    agreement (how often its score put a mix they liked above one they didn't), none at a coin flip or
    worse, half until 100 such pairs exist. At no weight the search doesn't wait for Jev; it still rates
    the mix that plays, so its agreement keeps being measured. A half- or double-time blend is rated in a
    situation of its own. Ratings are also kept per situation: how far apart the tempos were (up to
    12%, 12-20%, 20-50%, more) and, for a switch or wash, where it landed for that kind of mix; a
    situation starts from the overall rating and counts as much after 4 ratings of its own (washes are
    liked across wide tempo gaps and not between 12 and 20%: the same technique, another situation).
    After NOT FOR ME one optional tap says why (too sudden, clash, bad entry, energy drop, song choice):
    the rating then counts only against the parts of the mix that reason is about, and a song choice
    against none. Sound counts 60% for handovers (blends, washes: the check hears both
    tracks together) and 30% for switches (it can't hear whether a switch works musically). Taste starts
    at 0.85 for handovers, 0.8 for switches across a tempo gap and 0.5 for switches between tempos that
    could blend (blend when you can). Before any rating a flawless blend reads 94%, a switch across a
    tempo gap 86% (93% with Jev's top rating), a switch that could have been a blend 65%. Taste is
    capped at 1; what the cap takes from a style the DJ has liked a lot (a kind they like with details
    they like too) counts when choosing between mixes, never toward the bar ("YOUR LIKES DECIDED" when
    it changes the pick). A mix plays once one clears the bar (MIX AT 95 / 90 / 80 / 70%, 90 by default); otherwise the search goes on
    through more styles and later moments, and when it runs out the best one left plays, marked as under
    the bar.
  - Vocals: with Gemini's labels, a mix that fades or cuts the outgoing's lead vocal before its 16-bar
    phrase ends (checked where the fade starts and where the vocal is gone) loses confidence (0.25 points
    a second), and the phrase lines right after a vocal run ends are offered as extra moments; so are the
    outgoing's next hook, as it starts and right after it (hook to hook: leaving right after a hook
    doesn't count as cutting a line). An incoming that comes in partway through a sung line costs the
    same 0.25 points a second, and its rating key "in.midline" starts at 0.2 (a DJ avoids it).
  - Track lists: each deck's browser lists every song once (copies uploaded from both decks or under
    another name merged), under a clean name, with search, A-Z or BPM order, and each track's fit with
    the other deck's tempo ("BLENDS" within 12%, else how far apart); tracks mixed this session are dimmed.
  - Next track: the library tracks that mix best after the one on air top the other deck's track list,
    and the best one shows as its "UP NEXT" line with a one-tap LOAD. Scored on the server from the
    stored analyses (no AI, `/api/suggest-next`): tempo within the 12% a blend allows, at the track's own
    tempo or at half or double time (40 points, 5 fewer at half or double time),
    matching keys (30), an instrumental intro before its vocals that isn't much quieter than the
    track (20), similar loudness (10). One copy per song; the track on the other deck and tracks
    already mixed this session are left out.
  - Waiting: a mix starts within 60 s of pressing MIX. When nothing there clears the bar, the search
    looks on to moments up to 2 minutes away (e.g. the end of the singer's line); a clean mix a little
    later beats a poor one now. The panel says only "SEARCHING 11/200" while it searches, then the mix,
    its confidence and when it starts ("8-BAR BLEND, HATS IN · 94% · STARTS IN 36 S").
  - Keys: with clashing keys (severity from the Camelot distance, 0-1), every second both tracks'
    midrange is heard together, FX tails included, costs up to 0.5 points.
  - AI: Jev rates every measured mix (free, 48 a request) while its ratings count; Gemini only breaks a near tie
    between confident mixes when there is time (at most one call per mix, often none). Gemini also
    listens to each track once and marks which sections really carry a lead vocal.
  - `TransitionLab.benchmark({ outId, inId })` renders the planner's candidates, scores them, and shows what
    each engine picked.

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
