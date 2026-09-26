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
 *     isolator (never two basslines at once), outgoing mids/highs/fader out last. The moves
 *     themselves (and the other styles a mix can take) are in mix_blocks.js.
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

  /** An automatic intro edit's loop: the incoming's first 4-bar section with no lead vocal by its labels
   *  (Gemini's: the spectral guess flags nearly everything) and a real groove (energy at least half the
   *  track's median), or null. */
  function introLoop(track, inBar) {
    if (!track.vocal_source) return null;
    const secs = track.section_map || [];
    const body = median(secs.map(x => x.energy || 0)) || 1;
    const s = secs.find(x => !(x.has_vocals && x.vocal_score > 0.35) && (x.energy || 0) >= 0.5 * body &&
                             x.duration >= 3.9 * inBar);
    return s ? { native: s.time, bars: 4 } : null;
  }

  function median(a) {
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  }

  /** Track-relative kick/bass level (dB) of the bar containing native time t, or null. */
  function barLevel(track, t) {
    const lv = track.bar_low_db;
    if (!lv || !lv.length || !track.grid) return null;
    const g = gridOf(track);
    const firstDownbeat = g.first + (track.grid.downbeat_offset || 0) * g.period;
    // Phrase/downbeat times are rounded to the ms and can sit a hair before the computed bar
    // line: a downbeat within 2% of a bar belongs to the bar it starts, not the one before
    const i = Math.floor((t - firstDownbeat) / (4 * g.period) + 0.02);
    return (i >= 0 && i < lv.length) ? lv[i] : null;
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

    // ── Incoming entry. Blends: planned backwards from its first drop, so the drop lands as the blend
    // ends (opts.entry 'drop', the default); from its intro ('intro'); or ending where its hook (the
    // phrase that comes back most) begins ('hook') ──
    const introCue = inTrack.suggested_cue_intro || (inTrack.downbeat_times || [0])[0] || 0;
    let inStart = introCue;
    let inBars = bars;
    const drop = (inTrack.drop_times || []).find(d => d >= introCue + 8 * inBar - 0.05);
    const entry = opts.entry || 'drop';
    if (opts.blend && entry === 'hook') {
      const hook = (inTrack.hook_times || []).find(h => h - bars * inBar >= introCue - 0.05);
      if (hook !== undefined) inStart = hook - bars * inBar;
    }
    // 'loop': an automatic intro edit, for tracks that start singing at once (as DJs use DJ-pool intro
    // edits): its beat-only bars loop under the outgoing through the blend, and the track itself comes
    // in at its hook (or first drop) on the bass swap. What it plays before that is never heard.
    let loop = null;
    if (opts.blend && entry === 'loop') {
      const land = (inTrack.hook_times || []).concat(drop !== undefined ? [drop] : [])
        .find(x => x - bars * inBar >= 0);
      loop = land !== undefined ? introLoop(inTrack, inBar) : null;
      if (loop) inStart = land - bars * inBar;
    }
    if (opts.blend && entry === 'drop' && drop !== undefined) {
      const introBars = Math.round((drop - introCue) / inBar);
      if (introBars < bars) inBars = Math.max(8, Math.floor(introBars / 8) * 8);
      inStart = Math.max(introCue, drop - inBars * inBar);
    }
    if (opts.blend) bars = inBars;
    // Overlap-free: nothing plays over the incoming's intro, which would leave the floor near
    // empty after a full groove. It lands on its first drop instead, where the bass comes in.
    if (!opts.blend) {
      const firstDrop = (inTrack.drop_times || []).find(d => d > introCue + 0.05);
      if (firstDrop !== undefined) inStart = firstDrop;
    }
    // Bass swap bar. When the incoming drop lands at the end of the blend, swap on it. Otherwise
    // swap on the first downbeat past half-way where the incoming track really has bass, so the
    // swap never leaves bars with no bass at all (intros are often bass-less).
    const dropAligned = opts.blend && (!!loop || (drop !== undefined && Math.abs(inStart + bars * inBar - drop) < 0.1));
    let swapBar = dropAligned ? bars : Math.max(1, Math.round(bars / 2));
    if (opts.blend && !dropAligned && inTrack.bar_low_db && inTrack.bar_low_db.length) {
      const ref = median(inTrack.bar_low_db) - 3;
      swapBar = bars;
      for (let b = Math.max(1, Math.round(bars / 2)); b <= bars; b++) {
        const lv = barLevel(inTrack, inStart + b * inBar);
        if (lv !== null && lv >= ref) { swapBar = b; break; }
      }
    }
    // Swapping at the very end: keep the outgoing going (bass killed) for a few more bars
    const tailBars = swapBar >= bars ? Math.min(4, Math.max(1, bars / 2)) : 0;
    // Holes: bars where the deck that should carry the floor has (almost) no kick/bass. Incoming
    // from the swap until 4 bars after the blend (it must not fall into its breakdown right away)
    const holeDb = 10;
    let inHoles = 0;
    if (opts.blend && inTrack.bar_low_db && inTrack.bar_low_db.length) {
      const ref = median(inTrack.bar_low_db) - holeDb;
      for (let b = swapBar; b < bars + tailBars + 4; b++) {
        const lv = barLevel(inTrack, inStart + b * inBar);
        if (lv !== null && lv < ref) inHoles++;
      }
    }
    // Trim: match the incoming track's body loudness to what the room hears now
    const inTrimDb = (outTrack.loudness_db != null && inTrack.loudness_db != null)
      ? Math.max(-6, Math.min(6, outTrack.loudness_db + (outDeck.trimDb || 0) - inTrack.loudness_db))
      : 0;

    // ── Exit point on the outgoing track: score its phrase starts ──
    const blendNative = (bars + tailBars) * outBar;
    const inVocal = !loop && hasVocals(inTrack, inStart, inStart + bars * inBar);
    const slots = opts.phraseLock === false ? outTrack.downbeat_times : outTrack.phrase_8_times;
    const cands = (slots || []).filter(t => t >= outNow && t + blendNative <= dur - 0.5);
    const exits = [];
    for (const t of cands) {
      let score = 0;
      if (nearTime(outTrack.phrase_16_times, t)) score += 20;
      if (nearTime(outTrack.phrase_32_times, t)) score += 10;
      // The incoming drop lands at t + blend: better on a big phrase line of the outgoing too
      if (nearTime(outTrack.phrase_16_times, t + blendNative)) score += 10;
      const secs = sectionsIn(outTrack, t, t + blendNative);
      if (secs.some(s => s.section_type === 'outro' || s.section_type === 'breakdown')) score += 20;
      if (secs.some(s => s.section_type === 'drop')) score -= 20;
      const energyFalling = secs.length >= 2 && secs[secs.length - 1].energy < secs[0].energy;
      if (energyFalling) score += 10;
      const outVocal = hasVocals(outTrack, t, t + blendNative);
      if (outVocal && inVocal) score -= 30;
      else if (outVocal) score -= 5;
      // The outgoing bass must carry the floor until the swap: penalize exits where it drops out
      let bassDropouts = 0;
      let outHoles = 0;
      if (outTrack.bar_low_db && outTrack.bar_low_db.length) {
        const med = median(outTrack.bar_low_db);
        for (let b = 0; b < Math.min(swapBar, bars); b++) {
          const lv = barLevel(outTrack, t + b * outBar);
          if (lv !== null && lv < med - 6) { score -= 8; bassDropouts++; }
          // A stop bar while the incoming is still held back: the floor falls silent
          if (opts.blend && lv !== null && lv < med - holeDb) { score -= 25; outHoles++; }
        }
      }
      const waitSec = (t - outNow) / speed;
      score -= Math.max(0, waitSec - 20) * 0.4;
      exits.push({ t, score, outVocal, bassDropouts, outHoles, energyFalling });
    }
    // Best first; ties keep the earliest exit
    exits.sort((a, b) => b.score - a.score || a.t - b.t);
    const chosen = (opts.exit !== undefined && exits.find(e => Math.abs(e.t - opts.exit) < 0.05)) || exits[0];
    let best = chosen ? chosen.t : null;

    // Near the end: take the next downbeat and shorten the blend to what's left
    if (best === null) {
      best = (outTrack.downbeat_times || []).find(t => t >= outNow);
      if (best === undefined) {
        const bp = beatPhase(outTrack, outNow);
        best = bp.beatTime + bp.period * Math.ceil((outNow - bp.beatTime) / bp.period);
      }
      const barsLeft = Math.floor((dur - best) / outBar);
      bars = Math.max(1, Math.min(bars + tailBars, barsLeft) - tailBars);
    }

    const beatSec = 60 / outBpm;
    const vocalClash = hasVocals(outTrack, best, best + bars * outBar) && inVocal;
    return {
      bars,
      tailBars,
      swapBar: Math.min(swapBar, bars),
      dropAligned,
      inTrimDb,
      tempoRatio,
      masterBpm: outBpm,
      inBarSec: inBar,            // the incoming's bar at its native tempo
      beatSec,
      blendSec: (bars + tailBars) * 4 * beatSec,
      exitNative: best,
      inStartNative: inStart,
      startCtx: outDeck.audio.ctxTimeAt(best),
      vocalClash,
      entry: opts.blend ? (entry !== 'loop' || loop ? entry : 'intro') : 'drop',
      loop,
      keyClash: !!opts.keyClash,
      outOfRange: Math.abs(outBpm / (inTrack.bpm || outBpm) - 1) > MAX_STRETCH,
      exit: chosen || null,       // the scored exit this plan uses (null: forced near the end)
      exits,                      // every scored exit, best first
      holes: (chosen ? chosen.outHoles : 0) + inHoles,  // bars the floor would lose its bass
    };
  }

  function sectionAt(track, t) {
    const s = (track.section_map || []).find(x => t >= x.time - 0.05 && t < x.time + x.duration);
    return s ? s.section_type : 'unknown';
  }

  /**
   * A few transitions that are all safe to perform (same planner, same automation), for the AI
   * to choose from. The planner's own choice is always first. opts = plan() opts plus
   *   barsOptions: blend lengths to offer (default [16, 8]), perBars: exits per length (default 3),
   *   cutTechnique: technique for overlap-free candidates, max: list size (default 5),
   *   extraExits: outgoing native times to offer as exits too (e.g. where a vocal line ends).
   * Each candidate is a plan with `technique` ('blend' or a cut technique) and `id` ('A', 'B', ...).
   * These are timing skeletons: MixBlocks.variants() dresses each in the styles worth trying.
   */
  function candidates(outTrack, outDeck, inTrack, opts) {
    const list = [];
    const seen = new Set();
    const add = (p, technique) => {
      // Too near the end for a real blend (it would last a bar or two): an echo out there instead
      if (technique === 'blend' && p.bars < 4) {
        p = plan(outTrack, outDeck, inTrack, p.bars, Object.assign({}, opts, { blend: false }));
        technique = opts.cutTechnique || 'echo_freeze';
      }
      const key = `${technique}@${p.bars}@${p.exitNative.toFixed(2)}@${p.inStartNative.toFixed(1)}@${p.loop ? 'loop' : ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      list.push(Object.assign(p, { technique }));
    };
    const barsOptions = opts.blend ? (opts.barsOptions || [16, 8]) : [(opts.barsOptions || [16])[0]];
    const perBars = opts.perBars || 3;
    // Blends also try the incoming's other entries (its intro, ending on its hook, or an automatic
    // intro edit), at their two best exits: a track whose first drop comes late would otherwise always
    // enter deep inside it. Every entry's best moment first, then their next ones (the list is capped)
    const entries = opts.blend ? [['drop', perBars], ['intro', 2], ['hook', 2], ['loop', 2]] : [['drop', perBars + 1]];
    const tech = opts.blend ? 'blend' : (opts.cutTechnique || 'echo_freeze');
    const bases = [];
    for (const [entry, exits] of entries) {
      for (const bars of barsOptions) {
        const base = plan(outTrack, outDeck, inTrack, bars, Object.assign({}, opts, { entry }));
        add(base, tech);
        bases.push([base, entry, bars, exits]);
      }
    }
    for (const [base, entry, bars, exits] of bases) {
      for (const e of base.exits.slice(1, exits)) {
        add(plan(outTrack, outDeck, inTrack, bars, Object.assign({}, opts, { exit: e.t, entry })), tech);
      }
    }
    // Moments asked for by the caller (planned there only if they are phrase lines still ahead), as
    // blends and as switches. They skip the hole rule below: the sound check hears any real hole.
    const requested = [];
    for (const e of opts.extraExits || []) {
      const kinds = opts.blend ? barsOptions.map(bars => [bars, true]).concat([[barsOptions[0], false]])
                               : [[barsOptions[0], false]];
      for (const [bars, blend] of kinds) {
        const p = plan(outTrack, outDeck, inTrack, bars, Object.assign({}, opts, { exit: e, blend }));
        if (p.exit && Math.abs(p.exitNative - e) < 0.05) {
          requested.push([Object.assign(p, { requested: true }), blend ? 'blend' : (opts.cutTechnique || 'echo_freeze')]);
        }
      }
    }
    // A clean, overlap-free exit when every blend would lay two lead vocals on top of each other
    // (key clashes are handled inside the blend: the mids swap together with the bass)
    if (opts.blend && list.length && list.every(c => c.vocalClash)) {
      add(plan(outTrack, outDeck, inTrack, barsOptions[0], Object.assign({}, opts, { blend: false })), 'echo_freeze');
    }
    // Never offer a transition with a hole in it while a hole-free one exists (the planner's own
    // first choice included): keep the fewest holes, planner order otherwise
    const fewest = Math.min(...list.map(c => c.holes || 0));
    const safe = list.filter(c => (c.holes || 0) === fewest).slice(0, opts.max || 5);
    requested.forEach(([p, technique]) => add(p, technique));
    return safe.concat(list.filter(c => c.requested))
      .map((c, i) => Object.assign(c, { id: String.fromCharCode(65 + i) }));
  }

  /** What the AI needs to judge a candidate: plain facts, in native track seconds. */
  function candidateFeatures(c, outTrack, inTrack, now) {
    const e = c.exit || {};
    const r = x => Math.round(x * 100) / 100;
    return {
      id: c.id,
      technique: c.technique,
      bars: c.bars,
      wait_s: r(c.startCtx - now),
      exit_at: r(c.exitNative),
      exit_phrase: nearTime(outTrack.phrase_32_times, c.exitNative) ? '32-bar'
        : nearTime(outTrack.phrase_16_times, c.exitNative) ? '16-bar' : '8-bar',
      exit_section: sectionAt(outTrack, c.exitNative),
      in_start_at: r(c.inStartNative),
      in_section: sectionAt(inTrack, c.inStartNative),
      drop_aligned: !!c.dropAligned,
      swap_bar: c.swapBar,
      vocal_clash: c.technique === 'blend' && !!c.vocalClash,
      out_vocals: c.technique === 'blend' && !!e.outVocal,
      key_clash: !!c.keyClash,
      out_bass_dropouts: e.bassDropouts || 0,
      out_vocal_cut_s: r(c.vocalCutSec || 0),
      in_vocal_mid_s: r(c.vocalInSec || 0),
      bass_holes: c.holes || 0,
      out_energy_falling: !!e.energyFalling,
      planner_score: e.score !== undefined ? r(e.score) : null,
    };
  }

  /** Compact track description for the AI (sections from `from` seconds on). */
  function trackSummary(track, bpm, position = null, from = 0) {
    return {
      title: track.title || track.filename || track.file_id,
      bpm: Math.round(bpm * 100) / 100,
      camelot: track.camelot,
      duration: track.duration,
      position,
      sections: (track.section_map || []).filter(s => s.time + s.duration > from).slice(0, 14).map(s => ({
        time: Math.round(s.time * 10) / 10, type: s.section_type, energy: Math.round((s.energy || 0) * 100) / 100,
        vocals: !!(s.has_vocals && s.vocal_score > 0.35),
      })),
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
            deck.lowCut1.frequency, deck.lowCut2.frequency, deck.filterHPF.frequency, deck.filterLPF.frequency,
            deck.echoSend.gain].concat(deck.reverbSend ? [deck.reverbSend.gain] : []);
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
    deck.filterLPF.frequency.setValueAtTime(Math.min(20000, deck.ctx.sampleRate / 2), t);
    deck.echoSend.gain.setValueAtTime(1, t);
    if (deck.reverbSend) deck.reverbSend.gain.setValueAtTime(0, t);
  }

  /** Bass swap downbeat: on the incoming drop when it's planned to land at the blend's end,
   *  otherwise half-way (the incoming track already carries bass from its start). */
  function swapTime(p) {
    const bar = 4 * p.beatSec;
    const swapBar = p.swapBar !== undefined ? p.swapBar : Math.max(1, Math.round(p.bars / 2));
    return p.startCtx + swapBar * bar;
  }

  /** Channel trim (dB) at ctx time t; the deck keeps it after the transition. */
  function setTrim(deck, db, t) {
    deck.trimDb = db;
    deck.source.gain.setValueAtTime(Math.pow(10, db / 20), t);
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
    setTrim(inDeck, p.inTrimDb || 0, T - 0.05);
    neutral(outDeck, T - 0.05, outDeck.faderGain.gain.value);
    apply(inDeck.eqHigh.gain, kf.incoming_eq_high, db);
    apply(inDeck.eqMid.gain, kf.incoming_eq_mid, db);
    apply(outDeck.eqHigh.gain, kf.outgoing_eq_high, db);
    apply(outDeck.eqMid.gain, kf.outgoing_eq_mid, db);
    apply(outDeck.filterHPF.frequency, kf.outgoing_hpf_hz, v => Math.max(20, v));
    apply(inDeck.faderGain.gain, kf.incoming_fader, v => Math.max(0, Math.min(1, v)));
    apply(outDeck.faderGain.gain, kf.outgoing_fader, v => Math.max(0, Math.min(1, v)));
    // The AI shapes hats/mids/faders, but never the bass: its low-EQ curves can cross-fade two
    // basslines for bars (mud). Bass always swaps with the isolator in 30 ms on a downbeat.
    const swap = swapTime(p);
    bassKill(inDeck, T - 0.01, true);
    bassKill(outDeck, swap, true);
    bassKill(inDeck, swap, false);
    return { start: T, swap, end: T + D };
  }

  return { MAX_STRETCH, setTrim, gridOf, beatPhase, deckBpm, deckSpeed, plan, candidates, candidateFeatures,
           trackSummary, scheduleBlueprint, neutral, clearAutomation, holdAutomation, cutAt, hasVocals,
           curve, bassKill, swapTime };
})();

window.MixPlanner = MixPlanner;
