/**
 * mix_planner.js - Plans a transition the way a club DJ does, then runs it on the audio clock.
 *
 *  1. One master tempo: the incoming track is keylock-stretched to the outgoing deck's
 *     current BPM *before* it starts, and stays there. Nothing changes tempo mid-blend.
 *  2. Plan backwards: pick where the incoming track's first drop should land, start it
 *     `bars` earlier, and put the start on a phrase boundary of the outgoing track.
 *  3. Every fader/EQ move is scheduled as AudioParam automation relative to one ctx start
 *     time, so the blend is sample-accurate and identical in an OfflineAudioContext (tests).
 *  4. Default blend: hats first, mids next, bass swapped in 30 ms on a downbeat with an
 *     isolator (never two basslines at once), outgoing mids/highs/fader out last.
 */
const MixPlanner = (() => {
  const MAX_STRETCH = 0.08;    // beyond ±8% a blend sounds wrong: use an overlap-free technique
  const KILL_HZ = 220;         // isolator bass-kill frequency
  const OPEN_HZ = 10;

  function gridOf(track) {
    if (track && track.grid && track.grid.period) {
      return { first: track.grid.first_beat, period: track.grid.period, measured: true };
    }
    const bpm = (track && track.bpm) || 128;
    const b0 = track && track.beat_times && track.beat_times.length ? track.beat_times[0] : 0;
    return { first: b0, period: 60 / bpm, measured: false };
  }

  /** Beat phase in [0,1) and the native time of the beat at/before `t`. */
  function beatPhase(track, t) {
    const g = gridOf(track);
    const pos = (t - g.first) / g.period;
    const k = Math.floor(pos);
    return { phase: pos - k, beatTime: g.first + k * g.period, period: g.period };
  }

  function deckSpeed(deck) {
    return deck.audio.tempoRatio * deck.audio.playbackRate;
  }

  function deckBpm(track, deck) {
    return (track.bpm || 128) * deckSpeed(deck);
  }

  function sectionsIn(track, t0, t1) {
    return (track.section_map || []).filter(s => s.time < t1 && s.time + s.duration > t0);
  }

  function hasVocals(track, t0, t1) {
    return sectionsIn(track, t0, t1).some(s => s.has_vocals && s.vocal_score > 0.35);
  }

  function nearTime(list, t, tol = 0.05) {
    return (list || []).some(x => Math.abs(x - t) < tol);
  }

  /**
   * Decide timing. All track times are NATIVE seconds; ctx times are AudioContext seconds.
   * opts: { now, leadSec, blend, keyClash }
   */
  function plan(outTrack, outDeck, inTrack, bars, opts) {
    const outBpm = deckBpm(outTrack, outDeck);
    const tempoRatio = opts.blend ? outBpm / (inTrack.bpm || outBpm) : 1.0;
    const outBar = 4 * gridOf(outTrack).period;
    const inBar = 4 * gridOf(inTrack).period;
    const speed = deckSpeed(outDeck);
    const outNow = outDeck.audio.timeAt(opts.now + opts.leadSec);
    const dur = outTrack.duration || outDeck.audio.duration || 0;

    // Key clash: keep the harmonic overlap short
    if (opts.blend && opts.keyClash) bars = Math.min(bars, 8);

    // ── Incoming entry, planned backwards from its first drop ──
    const introCue = inTrack.suggested_cue_intro || (inTrack.downbeat_times || [0])[0] || 0;
    let inStart = introCue;
    let inBars = bars;
    const drop = (inTrack.drop_times || []).find(d => d >= introCue + 8 * inBar - 0.05);
    if (opts.blend && drop !== undefined) {
      const introBars = Math.round((drop - introCue) / inBar);
      if (introBars < bars) inBars = Math.max(8, Math.floor(introBars / 8) * 8);
      inStart = Math.max(introCue, drop - inBars * inBar);
    }
    if (opts.blend) bars = inBars;

    // ── Exit point on the outgoing track: score its phrase starts ──
    const blendNative = bars * outBar;
    const inVocal = hasVocals(inTrack, inStart, inStart + bars * inBar);
    const slots = opts.phraseLock === false ? outTrack.downbeat_times : outTrack.phrase_8_times;
    const cands = (slots || []).filter(t => t >= outNow && t + blendNative <= dur - 0.5);
    let best = null;
    let bestScore = -Infinity;
    for (const t of cands) {
      let score = 0;
      if (nearTime(outTrack.phrase_16_times, t)) score += 20;
      if (nearTime(outTrack.phrase_32_times, t)) score += 10;
      // The incoming drop lands at t + blend: better on a big phrase line of the outgoing too
      if (nearTime(outTrack.phrase_16_times, t + blendNative)) score += 10;
      const secs = sectionsIn(outTrack, t, t + blendNative);
      if (secs.some(s => s.section_type === 'outro' || s.section_type === 'breakdown')) score += 20;
      if (secs.some(s => s.section_type === 'drop')) score -= 20;
      if (secs.length >= 2 && secs[secs.length - 1].energy < secs[0].energy) score += 10;
      const outVocal = hasVocals(outTrack, t, t + blendNative);
      if (outVocal && inVocal) score -= 30;
      else if (outVocal) score -= 5;
      const waitSec = (t - outNow) / speed;
      score -= Math.max(0, waitSec - 20) * 0.4;
      if (score > bestScore) { bestScore = score; best = t; }
    }

    // Near the end: take the next downbeat and shorten the blend to what's left
    if (best === null) {
      best = (outTrack.downbeat_times || []).find(t => t >= outNow);
      if (best === undefined) {
        const bp = beatPhase(outTrack, outNow);
        best = bp.beatTime + bp.period * Math.ceil((outNow - bp.beatTime) / bp.period);
      }
      const barsLeft = Math.floor((dur - best) / outBar);
      bars = Math.max(1, Math.min(bars, barsLeft));
    }

    const beatSec = 60 / outBpm;
    const vocalClash = hasVocals(outTrack, best, best + bars * outBar) && inVocal;
    return {
      bars,
      tempoRatio,
      masterBpm: outBpm,
      beatSec,
      blendSec: bars * 4 * beatSec,
      exitNative: best,
      inStartNative: inStart,
      startCtx: outDeck.audio.ctxTimeAt(best),
      vocalClash,
      keyClash: !!opts.keyClash,
      outOfRange: Math.abs(outBpm / (inTrack.bpm || outBpm) - 1) > MAX_STRETCH,
    };
  }

  // ── Automation helpers ──

  const smoother = t => { const c = Math.max(0, Math.min(1, t)); return c * c * c * (c * (c * 6 - 15) + 10); };

  /** param moves v0 -> v1 along a smootherstep between ctx times t0 and t1 (dense linear ramps). */
  function curve(param, t0, t1, v0, v1, steps = 24) {
    param.setValueAtTime(v0, t0);
    for (let i = 1; i <= steps; i++) {
      param.linearRampToValueAtTime(v0 + (v1 - v0) * smoother(i / steps), t0 + (t1 - t0) * (i / steps));
    }
  }

  /** Isolator bass kill on/off, finishing exactly at ctx time `t` (30 ms move). */
  function bassKill(deck, t, kill) {
    [deck.lowCut1, deck.lowCut2].forEach(f => {
      const from = kill ? OPEN_HZ : KILL_HZ;
      f.frequency.setValueAtTime(from, t - 0.03);
      f.frequency.exponentialRampToValueAtTime(kill ? KILL_HZ : OPEN_HZ, t);
    });
  }

  function deckParams(deck) {
    return [deck.faderGain.gain, deck.eqLow.gain, deck.eqMid.gain, deck.eqHigh.gain,
            deck.lowCut1.frequency, deck.lowCut2.frequency, deck.filterHPF.frequency, deck.filterLPF.frequency];
  }

  function clearAutomation(deck, t) {
    deckParams(deck).forEach(p => { p.cancelScheduledValues(t); });
  }

  /** Stop all scheduled moves but keep every knob where it is right now (manual takeover). */
  function holdAutomation(deck, t) {
    deckParams(deck).forEach(p => {
      const v = p.value;
      p.cancelScheduledValues(t);
      p.setValueAtTime(v, t);
    });
  }

  /** Outgoing silenced by its fader, landing on 0 exactly at ctx time t (3 ms, declicked). */
  function cutAt(deck, t) {
    const g = deck.faderGain.gain;
    g.cancelScheduledValues(t - 0.003);
    g.setValueAtTime(g.value, t - 0.003);
    g.linearRampToValueAtTime(0, t);
  }

  /** Put a deck's mixer in neutral at ctx time t (fader to `vol`). */
  function neutral(deck, t, vol = 1) {
    clearAutomation(deck, t);
    deck.faderGain.gain.setValueAtTime(vol, t);
    [deck.eqLow.gain, deck.eqMid.gain, deck.eqHigh.gain].forEach(p => p.setValueAtTime(0, t));
    [deck.lowCut1.frequency, deck.lowCut2.frequency].forEach(p => p.setValueAtTime(OPEN_HZ, t));
    deck.filterHPF.frequency.setValueAtTime(20, t);
    deck.filterLPF.frequency.setValueAtTime(20000, t);
  }

  /**
   * Schedule the default DJ blend. Incoming must be started at p.startCtx by the caller.
   * Returns ctx times of the landmarks.
   */
  function scheduleBlend(p, outDeck, inDeck) {
    const T = p.startCtx;
    const bar = 4 * p.beatSec;
    const end = T + p.bars * bar;
    const q = Math.max(1, p.bars / 4);                         // a quarter of the blend, in bars
    const swap = T + Math.max(1, Math.round(p.bars / 2)) * bar; // bass swap on the 1, half-way

    // Incoming: silent, bass killed, mids down, hats slightly down
    neutral(inDeck, T - 0.05, 0);
    bassKill(inDeck, T - 0.01, true);
    inDeck.eqMid.gain.setValueAtTime(-24, T - 0.01);
    inDeck.eqHigh.gain.setValueAtTime(-12, T - 0.01);
    const outVol = outDeck.faderGain.gain.value;
    neutral(outDeck, T - 0.05, outVol);

    // 1. Hats and groove in over the first quarter
    curve(inDeck.faderGain.gain, T, T + Math.min(4, q) * bar, 0, 1);
    curve(inDeck.eqHigh.gain, T, T + q * bar, -12, 0);
    // 2. Incoming mids up to the swap (kept low until the swap on a vocal/key clash)
    if (p.vocalClash || p.keyClash) {
      curve(inDeck.eqMid.gain, T, swap - bar, -24, -14);
      curve(inDeck.eqMid.gain, swap - p.beatSec, swap, -14, 0, 8);
    } else {
      curve(inDeck.eqMid.gain, T, swap, -24, 0);
    }
    // 3. Bass swap on the 1
    bassKill(outDeck, swap, true);
    bassKill(inDeck, swap, false);
    // 4. Outgoing mids out (at the swap on a clash, so the two vocals/harmonies never overlap)
    if (p.vocalClash || p.keyClash) {
      curve(outDeck.eqMid.gain, swap - p.beatSec, swap, 0, -24, 8);
    } else {
      curve(outDeck.eqMid.gain, swap, end - bar, 0, -24);
    }
    // 5. Outgoing hats and fader out over the last quarter
    curve(outDeck.eqHigh.gain, end - q * bar, end - 0.5 * bar, 0, -24);
    curve(outDeck.faderGain.gain, end - q * bar, end, outVol, 0);

    return { start: T, swap, end };
  }

  /**
   * Schedule an AI blueprint's keyframes ([[progress, value], ...]) over the planned blend.
   */
  function scheduleBlueprint(bp, p, outDeck, inDeck) {
    const T = p.startCtx;
    const D = p.blendSec;
    const kf = bp.keyframes;
    const apply = (param, frames, map = v => v) => {
      if (!frames || !frames.length) return;
      param.setValueAtTime(map(frames[0][1]), T);
      for (let i = 0; i < frames.length - 1; i++) {
        const [p0, v0] = frames[i];
        const [p1, v1] = frames[i + 1];
        if (p1 > p0) curve(param, T + p0 * D, T + p1 * D, map(v0), map(v1), 12);
      }
    };
    const db = v => Math.max(-40, Math.min(6, v));
    neutral(inDeck, T - 0.05, 0);
    neutral(outDeck, T - 0.05, 1);
    apply(inDeck.eqHigh.gain, kf.incoming_eq_high, db);
    apply(inDeck.eqMid.gain, kf.incoming_eq_mid, db);
    apply(inDeck.eqLow.gain, kf.incoming_eq_low, db);
    apply(outDeck.eqHigh.gain, kf.outgoing_eq_high, db);
    apply(outDeck.eqMid.gain, kf.outgoing_eq_mid, db);
    apply(outDeck.eqLow.gain, kf.outgoing_eq_low, db);
    apply(outDeck.filterHPF.frequency, kf.outgoing_hpf_hz, v => Math.max(20, v));
    apply(inDeck.faderGain.gain, kf.incoming_fader, v => Math.max(0, Math.min(1, v)));
    apply(outDeck.faderGain.gain, kf.outgoing_fader, v => Math.max(0, Math.min(1, v)));
    return { start: T, swap: T + D / 2, end: T + D };
  }

  return { MAX_STRETCH, gridOf, beatPhase, deckBpm, deckSpeed, plan, scheduleBlend, scheduleBlueprint,
           neutral, clearAutomation, holdAutomation, cutAt, hasVocals };
})();

window.MixPlanner = MixPlanner;
