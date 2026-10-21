# Pulse Pro roadmap

Goal: mixes a dance floor never has to stop for. No missed downbeat, no flam, no silent beat, no
loudness jump, no two vocals fighting, and as few hard switches as the music allows.

Plan: build and perfect it on one machine first (MacBook Pro, M5) with a library prepared before the
gig, Serato/rekordbox style. Take it online afterwards on the same code.

## Principles

- **One codebase.** Local and online are two settings of the same server and page, not two products.
- **Prepared, not improvised.** Every track is fully analyzed (later: stems, neural grid, key) before it
  can go on a deck. Slow, accurate analysis is affordable because it happens before the gig.
- **Once per song, and nothing paid without asking.** Songs are fingerprinted on their audio, so tag
  edits and renames never re-process them; anything paid (Gemini listening) runs only on request, with
  its cost shown first and a budget.
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

### Phase 1: Local-first foundation (S-M) · built, to verify on the real library

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

### Phase 2: Accuracy fixes, Tier 1 (S-M) · built, to verify on the real library

- **Benchmark**: `python -m backend.benchmark`. Library (grids that wander, loudness spread), pairs
  (share that blend, 12-20% apart, switch only; tracks with no blend partner) and played mixes (share
  rated GOOD by kind, kick flam, loudness jumps, reasons).
- **Grid check** (prepare stage): each beat's kick against the grid, a median per 4 bars. Within 1-3 ms of
  the truth on synthetic tracks, breakdowns left out. It caught a track drifting 0.5 BPM (kicks 137 ms
  off) that the analyzer's own `drift_ms` called stable.
- **Flam correction and gating**: the planner predicts where both tracks' kicks land over the overlap,
  starts the incoming by their median offset, shortens a blend whose kicks would still drift more than
  10 ms apart, and makes it a switch when no length holds. The sound check counts the rest as flam.
- **No vinyl fallback** past 2%: the mix waits for the keylocked copy and moves to a later phrase, or is
  cancelled cleanly if the stretch fails.
- **Trim in LUFS**: each track's body loudness (the louder half of its short-term loudness), also used by
  the next-track suggestions. Matching local windows around the exit and entry was dropped: it would turn
  an incoming drop down to an outgoing outro's level for the rest of the track.

Learned: an incoming that drifts in its intro can't blend even for 8 bars (its kicks move ~18 ms every
4 bars), so it gets a switch. Phase 5's time maps, straightening its grid, are what let it blend.

Done when: no benchmark blend has a flam over 10 ms, loudness steps stay within ~1 LU, and a pitched
incoming never plays.

### Phase 3: Better analysis models, Tier 3a (M) · built, the neural model to verify on the Mac

- **Neural beats** (Beat This!, ISMIR 2024) as an optional prepare stage on the Mac's GPU (PyTorch MPS,
  CPU fallback). The constant grid stays the grid; the neural beats choose its downbeat when they agree
  on one phase, refit it when they hear the tempo at an odd ratio and the kicks fit that grid at least
  80% as well (otherwise the track is flagged), and measure how much of the track the grid follows.
  Tested with given beats (true and deliberately wrong) on synthetic tracks; the model itself couldn't
  run in the build environment (its weights host is blocked there), so its first real run is the Mac's.
- **Key** over the whole track with Essentia's EDM profile, the old estimate kept as `key_ks`. On
  synthetic tracks it named the right Camelot number every time (as the relative major of a minor
  progression: 8B for 8A), the old one 4 of 5. Real tracks are judged against their files' key tags.
- **File tags**: BPM and key from ID3 (Mixed In Key, rekordbox, Beatport), in every common notation
  including Open Key, compared in the benchmark.
- **Grid review**: CHECK GRID on the deck's GRID chip with the reason, GRID OK to confirm; fixed or
  confirmed grids survive re-analysis at the same tempo. Drift can only be confirmed for now: Phase 5's
  time maps straighten it.
- Not done: the neural tempo map isn't used to follow drift yet (Phase 5 uses it); a neural key model
  (added only if the TAGS line shows Essentia's falls short); key on the harmonic stem (after Phase 4).

Done when: downbeat errors on a hand-checked set of library tracks are near zero, and key agreement
with the files' tags is clearly above the old estimate's (the benchmark's TAGS line).

### Phase 4: Stems, Tier 3b (M-L) · built, to verify on the Mac (Demucs and live stem mixes)

Part 1, built: Demucs v4 (htdemucs) separates each track once, one at a time after the other stages, on
the Mac's GPU; the stems are kept as Ogg Opus (~13 MB a song; sample-aligned, checked in Chromium).
The vocal stem labels every section and bar (`vocal_bars`): on a synthetic track with a known sung line,
24 of 24 sections right, and an instrumental's residue marks nothing. Songs with stems need no Gemini;
labels Gemini gave before are kept to compare (the benchmark's STEMS line). Demucs couldn't run in the
build environment (its weights host is blocked there): its first real separation is the Mac's.

Part 2, built: decks can play a track as its stems (vocals, drums, rest) during a mix. The server
renders a window of them at the deck's tempo and lines it up with the deck's own audio (kicks within
0.12 ms, stretched or not); the deck crossfades to them and back seamlessly (null test: -70 dB with all
stems up), live and in the sound check alike. Two blend styles use them, offered only where both decks'
windows cover the moment: "vocals swap" (the outgoing vocal goes over the beat before the bass swap,
the incoming's comes in on it) and "drums in" (the incoming's drums alone until the bar before the
swap). Every blend now counts the seconds two lead vocals are heard together, by the vocal stems
(0.5 points a second), so the search moves away from vocal clashes. Windows are prefetched where mixes
happen (the outgoing's last 150 s, the incoming's first 150 s) and only on a computer (~1 MB a second
in memory). Seen working offline end to end; a stem style winning a live Auto mix is still to be heard
on real songs on the Mac.

The original plan:
- Demucs v4 (htdemucs) as a prepare stage on the GPU, cached as compressed stems (~30 MB per track).
- Stem-aware mix blocks: hand over the outgoing vocal stem instead of ducking mids, bring the incoming
  in as drums only, acapella over instrumental, cleaner bass swap.
- Vocal activity measured from the vocal stem, replacing Gemini's labels: exact timing, offline, free.
- Browser memory: load stems only for the blend window.

Done when: no benchmark mix has two lead vocals at full level together, and the console needs no
network to mix.

### Phase 5: Variable tempo, Tier 2 (M-L) · part 1 built (glides), part 2 (straightening drift) next

Part 1, built: tempo glides. Tempos more than 4% apart (up to 20%, either way round) meet halfway: the
outgoing glides to the geometric mean of the two tempos over the 8-32 bars before the blend (at most 0.5%
a bar), keylocked; the incoming is stretched only the rest of the way (≤ ~9.5% each, inside the clean
8%-ish zone for most pairs); after the mix the incoming glides back to its own tempo, and so does a deck
whose mix was called off. The server renders each glide as a short window (`backend/glide.py`, ffmpeg's
Rubber Band with its tempo stepped every 23 ms; the exact time map is computed in closed form on both
sides, and the change in the stretcher's own delay is compensated): on synthetic tracks every kick lands
within 2 ms of the map along a 9% glide, and in Chromium the deck's kicks follow it within 0.5 ms
through both buffer switches. The deck's transport now follows a time map (`TimeMap`) instead of one
tempo ratio; the planner plans on the deck as it will run after the glide, so the sound check still
renders exactly what plays (the outgoing's keylocked copy at the mix tempo). Track suggestions and the
benchmark's PAIRS line count blends up to 20% apart. A glide is a ~30-60 s window, rendered outside the
queue of whole-track renders; one that isn't in time cancels the mix (the deck plays on).

The original plan:
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
