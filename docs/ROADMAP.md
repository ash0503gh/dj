# Pulse Pro roadmap

Goal: mixes a dance floor never has to stop for. No missed downbeat, no flam, no silent beat, no
loudness jump, no two vocals fighting, and as few hard switches as the music allows.

Plan: build and perfect it on one machine first (MacBook Pro, M5) with a library prepared before the
gig, Serato/rekordbox style. Take it online afterwards on the same code.

## Principles

- **One codebase.** Local and online are two settings of the same server and page, not two products.
- **Prepared, not improvised.** Every track is fully analyzed (later: stems, neural grid, key) before it
  can go on a deck. Slow, accurate analysis is affordable because it happens before the gig.
- **What is measured is what plays.** Mixes are rendered and measured offline from the exact buffers and
  automation the live console plays. Every change below keeps that true.
- **Every change is measured.** A benchmark of real track pairs from the library is the yardstick
  (Phase 2). A change that doesn't move it doesn't ship.

## Where mixes go wrong today

| # | Problem | Where |
|---|---------|-------|
| 1 | Tempo gaps over 12% can only switch (echo, cut, brake): the main source of abrupt transitions | `mix_planner.js` (one fixed tempo per track), `stretch.py` |
| 2 | The set stays at the first track's tempo for good; every track after it is stretched for its whole length | `app.js` (no return to native tempo) |
| 3 | If the keylocked copy isn't ready, the incoming plays pitched (up to ~2 semitones) for the rest of the track | `app.js` runTransition |
| 4 | Grid drift and confidence are measured but never used; live-played tracks flam through long blends | `audio_analyzer.py` `drift_ms`, `confidence`, `tempo_stable` |
| 5 | The sound check doesn't measure kick flam, so a wrong grid can still score 94% | `transition_lab.js` quickScore |
| 6 | Loudness matching uses plain RMS (bass-dominated), not perceived loudness | `audio_analyzer.py` `loudness_db` |
| 7 | No stems while mixing: vocal clashes are only ducked with EQ | `stem_separator.py` (export only, no torch) |
| 8 | Key from a 45-second snippet with fixed profiles: often wrong, so key-clash penalties mislead | `audio_analyzer.py` `estimate_key` |

## Improvement tiers (from the review) and where they land

| Tier | What | Phase |
|------|------|-------|
| 1 | Flam check, grid-quality gating, no vinyl fallback, LUFS matching | 1 (LUFS measured), 2 |
| 2 | Variable tempo: ramps into and out of mixes, straightening drifting tracks | 5 |
| 3 | Better analysis models: neural beats/downbeats and key, stems, a learned judge from ratings | 3, 4, 6 |
| 4 | Program the set: plan several tracks ahead, transitions computed before the gig | 6 |

## Phases

Effort is a rough size (S: days, M: 1-2 weeks, L: several weeks), to be revised as each phase starts.

### Phase 1: Local-first foundation (S-M) · in progress

- A library folder (`PULSE_LIBRARY`) and a resumable, parallel `prepare` command.
- SQLite library index keyed by audio fingerprint (SHA-1 of the file): renamed, moved or duplicated
  files are one track; ratings and labels survive renames.
- Per-stage status and version: a newer analyzer re-runs only the stages that changed.
- Stages: the current analysis, plus integrated loudness (EBU R128 LUFS) and loudness range.
- Readiness rule: a track can't go on a deck until every stage has passed. Tracks whose grid drifts or
  fits poorly are flagged for a check.
- In local mode uploads are off; one script prepares new tracks, starts the server and opens Chrome.
- The online setup (Render / Cloud Run, uploads, bucket) keeps working unchanged.

Done when: the whole library prepares unattended, a re-run only touches new or changed files, and the
console lists and loads only prepared tracks.

### Phase 2: Accuracy fixes, Tier 1 (S-M)

- **Benchmark first**: ~30 real pairs from the library (extend `tests/real_tracks_report.py`). Metrics:
  kick flam (ms), loudness step (LU), share of pairs that blend vs switch, share rated GOOD.
- **Flam check in the sound check**: cross-correlate both decks' low-band onsets in the overlap. Correct
  the offset by the measured lag when it is small and consistent; reject the blend above ~10 ms.
- **Grid-quality gating**: drifting or low-confidence grids get shorter blends or a switch on the phrase
  line, never a 32-bar blend.
- **No vinyl fallback** beyond ~2-3%: wait or shorten the mix. Stretch the blend window first and the
  rest of the track in the background.
- **Loudness trim in LUFS**, measured locally around the exit and entry points, not over the whole track.

Done when: no benchmark blend has a flam over 10 ms, loudness steps stay within ~1 LU, and a pitched
incoming never plays.

### Phase 3: Better analysis models, Tier 3a (M)

- Neural beat and downbeat tracker (e.g. Beat This!, ISMIR 2024) as a prepare stage, on the Mac's GPU
  (PyTorch MPS). The constant-grid fit stays for quantized tracks, where it is more precise; the neural
  tempo map takes over when drift is high. The main win is correct downbeats.
- Neural key detection over the whole track, later on the harmonic stem.
- A grid check view for flagged tracks: listen, nudge, confirm (builds on `/api/grid-adjust`).

Done when: downbeat errors on a hand-checked set of library tracks are near zero, and key agreement
with a reference (Mixed In Key, rekordbox) is clearly above today's.

### Phase 4: Stems, Tier 3b (M-L)

- Demucs v4 (htdemucs) as a prepare stage on the GPU, cached as compressed stems (~30 MB per track).
- Stem-aware mix blocks: hand over the outgoing vocal stem instead of ducking mids, bring the incoming
  in as drums only, acapella over instrumental, cleaner bass swap.
- Vocal activity measured from the vocal stem, replacing Gemini's labels: exact timing, offline, free.
- Browser memory: load stems only for the blend window.

Done when: no benchmark mix has two lead vocals at full level together, and the console needs no
network to mix.

### Phase 5: Variable tempo, Tier 2 (M-L)

- Keylocked tempo ramps rendered with Rubber Band time maps (`rubberband --timemap`): the outgoing eases
  toward the incoming over the 16-32 bars before a mix, and the incoming eases back to its own tempo
  after. Buffers stay pre-rendered, so the sound check still hears exactly what plays.
- The same time maps straighten drifting, live-played tracks onto a constant grid (like Ableton's warp
  markers).
- Raise the blend limit from 12% toward ~20% for ramped mixes; half/double-time blends cover more.
- Later option: a real-time stretcher in an AudioWorklet (Signalsmith Stretch or Rubber Band WASM) for
  live keylocked pitch faders, if it keeps offline/live parity.

Done when: benchmark pairs 12-20% apart blend instead of switching, and tracks return to their own
tempo after each mix.

### Phase 6: Program the set, Tier 4 + learned judge (M)

- Score every compatible pair in the library overnight with the full sound check: pressing MIX plays an
  already-verified mix almost at once, and far more styles and moments can be searched.
- `suggest-next` plans 3-5 tracks ahead along a tempo, key and energy path that ramps can bridge.
- A small model trained on the DJ's GOOD / NOT FOR ME ratings over the measured features replaces the
  hand-tuned taste weights once a few hundred ratings exist. Gemini and Jev stay out of timing decisions.

### Phase 7: Desktop app and gig hardening (S-M)

- Package as a Mac app (Tauri or Electron) around the same server and page.
- Fully offline mode, crash recovery mid-set, audio device and controller checks before a set.

### Phase 8: Online (L)

- The same prepare pipeline as a server job (GPU worker for stems), the library index synced to the
  cloud by fingerprint.
- Licensing and storage for users' music decided before launch.

## Limits

- No processing makes a 90 to 128 BPM pair a seamless beat-matched blend. Past ~20% the right moves are
  a half/double-time blend or a well-timed switch: on the 1, on a phrase line, with no silent beat.
- Keylocked stretching past ~8-10% degrades vocals with any algorithm.
- Low-bitrate rips limit every stage, stems most of all.
