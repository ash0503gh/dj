/**
 * mix_blocks.js - A mix, built from the moves a DJ makes on a two-deck mixer.
 *
 * A candidate mix is a timing skeleton from MixPlanner (where the outgoing leaves, where the
 * incoming enters, when the bass hands over) plus a `style`: plain data saying how each deck moves
 * (3-band EQ, isolator bass swap, filters, fader, echo, reverb, loop roll) and for how long.
 * `perform` schedules a style as AudioParam automation on the audio clock: the same code live and
 * in the offline sound check, so what was measured is exactly what plays. `variants` dresses a
 * skeleton in every style worth trying; the search (app.js) renders, measures and ranks them. Nothing
 * here knows which style suits which songs: the measurements, Jev and the DJ's ratings decide.
 *
 * Two kinds of skeleton:
 *  - blend (tempos within MixPlanner.MAX_STRETCH, beat-matched): p.startCtx is where the incoming
 *    starts; the bass swaps on a downbeat (p.swapBar); the outgoing has left by the end.
 *  - gap (tempos too far apart to beat-match): p.startCtx is the switch, where the incoming lands
 *    (on its drop, or on the build before it) as the outgoing's last beat goes. The two beats
 *    only overlap with the spectrum split between the decks.
 */
const MixBlocks = (() => {
  const { curve, neutral, setTrim, bassKill, swapTime, cutAt, gridOf } = MixPlanner;
  const ECHO_TAIL_BEATS = 8;
  const REVERB_TAIL_SEC = 3.0;   // roomImpulse() length (audio_engine.js)

  // ── Moves on one deck ──

  /** Filter cutoff from f0 to f1 (exponential, as a DJ turns the knob) between t0 and t1. */
  function sweep(param, t0, t1, f0, f1) {
    param.setValueAtTime(f0, t0);
    param.exponentialRampToValueAtTime(f1, t1);
  }

  /** Reverb throw: the send opens over [t0, t] and closes at t as the dry signal goes, so the
   *  room rings on over what comes next. Returns how long it rings. */
  function reverbOut(deck, t0, t) {
    deck.ensureReverb();
    const g = deck.reverbSend.gain;
    curve(g, t0, t, 0, 1, 12);
    g.linearRampToValueAtTime(0, t + 0.03);
    deck.echoSend.gain.setValueAtTime(1, t - 0.03);
    deck.echoSend.gain.linearRampToValueAtTime(0, t);
    return deck.reverbTailSec;
  }

  /** Beat repeat that speeds up: the beat at t0 repeats as 1-beat slices, then 1/2, 1/4 and 1/8
   *  of a beat (a quarter of the roll each) until t; the main playback is muted meanwhile. */
  function roll(deck, t0, t, beatSec) {
    const anchor = deck.audio.timeAt(t0);
    const sources = [];
    for (let x = t0; x < t - 1e-4;) {
      const f = (x - t0) / (t - t0);
      const div = f < 0.25 ? 1 : f < 0.5 ? 0.5 : f < 0.75 ? 0.25 : 0.125;
      const src = deck.audio.playSlice(x, anchor, Math.min(div * beatSec, t - x));
      if (src) sources.push(src);
      x += div * beatSec;
    }
    deck.audio.muteBetween(t0, t);
    deck._rollSources = (deck._rollSources || []).concat(sources);  // resetAllFX() stops them
  }

  // ── Performing a style ──

  /** Beat-matched blend. Defaults ('overlap' mids, 'eq' tail) are the classic DJ blend: hats first,
   *  mids next, bass swapped in 30 ms on a downbeat (never two basslines), outgoing out last. */
  function performBlend(p, s, outDeck, inDeck) {
    const T = p.startCtx;
    const bar = 4 * p.beatSec;
    const end = T + (p.bars + (p.tailBars || 0)) * bar;
    const q = Math.max(1, p.bars / 4);                         // a quarter of the blend, in bars
    const swap = swapTime(p);

    // Incoming: silent, bass killed, mids down, hats slightly down
    neutral(inDeck, T - 0.05, 0);
    setTrim(inDeck, p.inTrimDb || 0, T - 0.05);
    bassKill(inDeck, T - 0.01, true);
    inDeck.eqMid.gain.setValueAtTime(-24, T - 0.01);
    inDeck.eqHigh.gain.setValueAtTime(-12, T - 0.01);
    const outVol = outDeck.faderGain.gain.value;
    neutral(outDeck, T - 0.05, outVol);

    // Hats and groove in over the first quarter
    curve(inDeck.faderGain.gain, T, T + Math.min(4, q) * bar, 0, 1);
    curve(inDeck.eqHigh.gain, T, T + q * bar, -12, 0);
    // Mids: 'overlap' rise to the swap and fall after it; 'snap' change hands on the swap's beat
    // (two vocals or clashing keys never overlap); 'crossfade' trade places over the bar either side
    const around = [Math.max(T, swap - bar), Math.min(end, swap + bar)];
    if (s.mids === 'snap') {
      curve(inDeck.eqMid.gain, T, swap - bar, -24, -14);
      curve(inDeck.eqMid.gain, swap - p.beatSec, swap, -14, 0, 8);
    } else if (s.mids === 'crossfade') {
      curve(inDeck.eqMid.gain, around[0], around[1], -24, 0);
    } else {
      curve(inDeck.eqMid.gain, T, swap, -24, 0);
    }
    // Bass swap on the 1
    bassKill(outDeck, swap, true);
    bassKill(inDeck, swap, false);
    if (s.mids === 'snap') {
      curve(outDeck.eqMid.gain, swap - p.beatSec, swap, 0, -24, 8);
    } else if (s.mids === 'crossfade') {
      curve(outDeck.eqMid.gain, around[0], around[1], 0, -24);
    } else {
      curve(outDeck.eqMid.gain, swap, end - (p.tailBars ? 0.5 : 1) * bar, 0, -24);
    }
    // The outgoing leaves: hats and fader down ('eq'), a rising high-pass ('filter'), or its last
    // beat thrown into the echo or the reverb
    const fadeFrom = p.tailBars ? swap : end - q * bar;
    let stop = end;
    if (s.tail === 'filter') {
      sweep(outDeck.filterHPF.frequency, fadeFrom, end, 20, 3000);
      curve(outDeck.faderGain.gain, fadeFrom, end, outVol, 0);
    } else if (s.tail === 'echo') {
      outDeck.triggerEchoFreeze(p.masterBpm, end, ECHO_TAIL_BEATS);
      stop = end + ECHO_TAIL_BEATS * p.beatSec;
    } else if (s.tail === 'reverb') {
      stop = end + reverbOut(outDeck, end - p.beatSec, end);
    } else {
      curve(outDeck.eqHigh.gain, fadeFrom, end - 0.5 * bar, 0, -24);
      curve(outDeck.faderGain.gain, fadeFrom, end, outVol, 0);
    }
    return { start: T, swap, end: stop };
  }

  /** Tempo gap. The incoming lands at the switch; before it the outgoing either plays on dry,
   *  rises through a high-pass, rolls, swells into the reverb ('at' entry), or shares the
   *  spectrum with the incoming ('split': outgoing under a closing low-pass, incoming above the
   *  same split, which glides from 3 kHz to 150 Hz). After it the outgoing's last beat echoes,
   *  rings in the reverb, or just stops. The incoming must be started p.inLeadSec before. */
  function performGap(p, s, outDeck, inDeck) {
    const T = p.startCtx;
    const beat = p.beatSec;
    const lead = (s.leadBars || 0) * 4 * beat;
    const inLead = p.inLeadSec || 0;
    const inFrom = T - inLead;
    const outVol = outDeck.faderGain.gain.value;
    neutral(outDeck, T - Math.max(lead, beat) - 0.05, outVol);
    neutral(inDeck, inFrom - 0.05, s.entry === 'split' ? 0.5 : 0.7);
    setTrim(inDeck, p.inTrimDb || 0, inFrom - 0.05);

    if (s.entry === 'split') {
      const outF = outDeck.filterLPF.frequency, inF = inDeck.filterHPF.frequency;
      outF.setValueAtTime(Math.min(20000, outDeck.ctx.sampleRate / 2), T - lead);
      outF.exponentialRampToValueAtTime(3000, Math.max(T - lead + 0.05, inFrom));
      outF.exponentialRampToValueAtTime(150, T);
      inF.setValueAtTime(3000, inFrom);
      inF.exponentialRampToValueAtTime(150, T - 0.03);
      inF.exponentialRampToValueAtTime(20, T);
      curve(inDeck.faderGain.gain, inFrom, T, 0.5, 1);
    } else {
      inDeck.faderGain.gain.linearRampToValueAtTime(1, T + p.inBarSec);
      if (s.before === 'hpf') {
        sweep(outDeck.filterHPF.frequency, T - lead, T, 20, 1500);
      } else if (s.before === 'roll') {
        roll(outDeck, T - lead, T, beat);
        sweep(outDeck.filterHPF.frequency, T - lead, T, 20, 1500);
      }
    }
    let tail = beat;
    if (s.before === 'verb' || s.after === 'reverb') {
      tail = Math.max(tail, reverbOut(outDeck, s.before === 'verb' ? T - lead : T - beat, T));
    }
    if (s.after === 'echo') {
      outDeck.triggerEchoFreeze(p.masterBpm, T, ECHO_TAIL_BEATS);
      tail = Math.max(tail, ECHO_TAIL_BEATS * beat);
    } else if (s.after === 'cut') {
      cutAt(outDeck, T);
    }
    // A rising high-pass, a roll or a reverb swell empties the floor on purpose: the sound check
    // doesn't count that stretch as a hole (clashes and everything after the switch still count)
    const build = ['hpf', 'roll', 'verb'].includes(s.before) ? [T - lead, T] : null;
    return { start: T - Math.max(lead, inLead, beat), swap: T, end: T + tail, build };
  }

  /** The default style of a planner skeleton (what the console did before styles existed). */
  function defaultStyle(p) {
    if (p.technique === 'blend' || p.technique === undefined) {
      return { kind: 'blend', mids: p.vocalClash || p.keyClash ? 'snap' : 'overlap', tail: 'eq' };
    }
    return { kind: 'gap', entry: 'at', before: 'none', after: 'echo', leadBars: 0, inPreBars: 0 };
  }

  /** Schedule a candidate on two decks (the incoming started by the caller, p.inLeadSec before
   *  p.startCtx at p.inStartNative - p.inLeadSec). Returns ctx times { start, swap, end }. */
  function perform(p, outDeck, inDeck) {
    const s = p.style || defaultStyle(p);
    return s.kind === 'gap' ? performGap(p, s, outDeck, inDeck) : performBlend(p, s, outDeck, inDeck);
  }

  /** Seconds the mix starts before p.startCtx (outgoing FX or the incoming's early entry). */
  function preSec(p) {
    const s = p.style || defaultStyle(p);
    if (s.kind !== 'gap') return 0;
    return Math.max((s.leadBars || 0) * 4 * p.beatSec, p.inLeadSec || 0, p.beatSec);
  }

  /** Seconds the mix lasts after p.startCtx, echo and reverb tails included. */
  function postSec(p) {
    const s = p.style || defaultStyle(p);
    const tail = { echo: ECHO_TAIL_BEATS * p.beatSec, reverb: REVERB_TAIL_SEC };
    if (s.kind === 'gap') return Math.max(p.beatSec, tail[s.after] || 0, s.before === 'verb' ? REVERB_TAIL_SEC : 0);
    return (p.bars + (p.tailBars || 0)) * 4 * p.beatSec + (tail[s.tail] || 0);
  }

  // ── The styles worth trying ──

  /** One candidate per style for a skeleton: plan clones with `style`, and for a gap the
   *  incoming's entry (its drop, or 8 bars before it) and early start (split). */
  function variants(p, inTrack) {
    const out = [];
    const add = (style, extra = {}) => out.push(Object.assign({}, p, extra, { style }));
    if (p.technique === 'blend') {
      const clash = p.vocalClash || p.keyClash;
      for (const mids of clash ? ['snap', 'crossfade'] : ['overlap', 'crossfade', 'snap']) {
        for (const tail of ['eq', 'filter', 'echo', 'reverb']) add({ kind: 'blend', mids, tail });
      }
      return out;
    }
    const inBar = 4 * gridOf(inTrack).period;
    const beat = p.beatSec;
    for (const inPreBars of [0, 8]) {
      const land = p.inStartNative - inPreBars * inBar;     // where the incoming is at the switch
      if (land < 0) continue;
      const at = (before, leadBars, after) =>
        add({ kind: 'gap', entry: 'at', before, leadBars, after, inPreBars },
            { inStartNative: land, inLeadSec: 0 });
      for (const after of ['echo', 'reverb', 'cut']) at('none', 0, after);
      for (const leadBars of [2, 4]) for (const after of ['echo', 'reverb']) at('hpf', leadBars, after);
      for (const leadBars of [1, 2]) for (const after of ['echo', 'reverb', 'cut']) at('roll', leadBars, after);
      for (const leadBars of [2, 4]) at('verb', leadBars, 'reverb');
      // Spectral crossfade: the incoming starts under the split for half its length (in its own
      // bars), never before the wash or before the track's start
      for (const leadBars of [4, 8]) {
        const inLeadSec = Math.min((leadBars / 2) * inBar, land, leadBars * 4 * beat);
        for (const after of ['echo', 'reverb']) {
          add({ kind: 'gap', entry: 'split', before: 'split', leadBars, after, inPreBars },
              { inStartNative: land, inLeadSec });
        }
      }
    }
    return out;
  }

  /** A few words for the console (banner, countdown, sound-check rows). */
  function label(p) {
    const s = p.style || defaultStyle(p);
    if (s.kind === 'blend') {
      return `${p.bars}-bar blend` + ({ snap: ', mids snap', crossfade: ', mids crossfade' }[s.mids] || '') +
             ({ filter: ', filter out', echo: ', echo out', reverb: ', reverb out' }[s.tail] || '');
    }
    const after = { echo: 'echo out', reverb: 'reverb out', cut: 'cut' }[s.after];
    const land = s.inPreBars ? ' into its build' : '';
    if (s.entry === 'split') return `${s.leadBars}-bar filter wash, ${after}${land}`;
    const before = { none: '', hpf: `${s.leadBars}-bar high-pass, `, roll: `${s.leadBars}-bar loop roll, `,
                     verb: `${s.leadBars}-bar reverb swell, ` }[s.before];
    return `${before}${after}${land}`;
  }

  /** What a style does, in a DJ's words (for the AI and the sound-check panel). */
  function describe(p) {
    const s = p.style || defaultStyle(p);
    if (s.kind === 'blend') {
      const mids = { overlap: 'mids blend gradually', snap: 'mids swap on the bass swap',
                     crossfade: 'mids crossfade over the bar either side of the bass swap' }[s.mids];
      const tail = { eq: 'outgoing hats and fader down', filter: 'outgoing leaves through a rising high-pass',
                     echo: 'outgoing last beat echoes out', reverb: 'outgoing thrown into the reverb' }[s.tail];
      return `${p.bars}-bar EQ blend, bass swapped on a downbeat, ${mids}, ${tail}`;
    }
    const where = s.inPreBars ? `${s.inPreBars} bars before its drop (its build)` : 'on its drop';
    const after = { echo: 'its last beat echoes out', reverb: 'it rings out in the reverb', cut: 'it stops dead' }[s.after];
    if (s.entry === 'split') {
      return `${s.leadBars}-bar filter wash across the tempo gap (spectral crossfade: outgoing under a closing ` +
             `low-pass, incoming above the same split) landing the incoming ${where}; then ${after}`;
    }
    const before = {
      none: 'outgoing plays to the switch', hpf: `outgoing rises through a high-pass for ${s.leadBars} bars`,
      roll: `outgoing loop-rolls for ${s.leadBars} bar${s.leadBars > 1 ? 's' : ''}, faster and faster, under a rising high-pass`,
      verb: `outgoing swells into the reverb for ${s.leadBars} bars`,
    }[s.before];
    return `tempo-gap switch: ${before}, incoming lands ${where}; ${after}`;
  }

  /** Feature keys the DJ's ratings are kept under. 'handover' mixes hand the floor over gradually
   *  (blends, washes); 'switch' mixes change track at one moment. */
  function prefKeys(p) {
    const s = p.style || defaultStyle(p);
    if (s.kind === 'blend') return ['handover', `blend.mids.${s.mids}`, `blend.tail.${s.tail}`];
    const keys = [s.entry === 'split' ? 'handover' : 'switch', `gap.entry.${s.entry}`, `gap.after.${s.after}`,
                  `gap.land.${s.inPreBars ? 'build' : 'drop'}`];
    if (s.entry !== 'split') keys.push(`gap.before.${s.before}`);
    return keys;
  }

  return { perform, preSec, postSec, variants, defaultStyle, label, describe, prefKeys };
})();

window.MixBlocks = MixBlocks;
