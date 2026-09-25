/**
 * transition_lab.js - Render a planned transition offline and score it.
 *
 * Uses the SAME planner (MixPlanner.plan), deck graph (DJDeckAudio) and automation
 * (MixBlocks.perform / scheduleBlueprint) as the live console, rendered in an OfflineAudioContext
 * with the outgoing deck on channel 0 and the incoming deck on channel 1, then posts the stems
 * to /api/score-transition. Nothing runs unless called, e.g. from the devtools console:
 *
 *   await TransitionLab.run({ outId: 'lab1_a.mp3', inId: 'lab2_b.mp3', bars: 16 })
 *   await TransitionLab.benchmark({ outId: ..., inId: ... })   // which engine picks best
 */
const TransitionLab = (() => {
  const SR = 22050;

  async function loadTrack(fileId) {
    const form = new FormData();
    form.append('file_id', fileId);
    form.append('deck', 'lab');
    const res = await fetch('/api/load-preset', { method: 'POST', body: form });
    if (!res.ok) throw new Error(`load ${fileId}: HTTP ${res.status}`);
    return (await res.json()).track;
  }

  /** Gemini's vocal labels for the track (see /api/listen-vocals), when available. */
  async function listened(track) {
    if (track.vocal_source) return track;
    const res = await fetch('/api/listen-vocals', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                    body: JSON.stringify({ file_id: track.file_id }) });
    const data = res.ok ? await res.json() : {};
    return data.status === 'success'
      ? Object.assign(track, { section_map: data.section_map, vocal_source: data.vocal_source }) : track;
  }

  async function decode(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
    return new OfflineAudioContext(1, 1, SR).decodeAudioData(await res.arrayBuffer());
  }

  function camelotCompatible(a, b) {
    if (!a || !b) return true;
    const na = parseInt(a, 10), nb = parseInt(b, 10);
    const d = (nb - na + 12) % 12;
    return na === nb || (a.slice(-1) === b.slice(-1) && (d === 1 || d === 11));
  }

  function wav16(buffer) {
    const ch = buffer.numberOfChannels, n = buffer.length;
    const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
    out.setUint32(24, buffer.sampleRate, true); out.setUint32(28, buffer.sampleRate * ch * 2, true);
    out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); str(36, 'data'); out.setUint32(40, n * ch * 2, true);
    const data = [...Array(ch).keys()].map(c => buffer.getChannelData(c));
    let o = 44;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ch; c++) {
        const s = Math.max(-1, Math.min(1, data[c][i]));
        out.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        o += 2;
      }
    }
    return new Blob([out.buffer], { type: 'audio/wav' });
  }

  const near = (list, t, tol = 0.05) => (list || []).some(x => Math.abs(x - t) < tol);

  /**
   * Render a planned mix (any MixBlocks style) offline with the live deck graph and automation.
   * side: { buffer, tempoRatio, rate, trimDb } for each deck (buffer = what the deck plays).
   * The outgoing deck is `preroll` seconds before the plan's start at ctx time 0.
   * stems: channel 0 = outgoing, channel 1 = incoming; otherwise a normal stereo mix.
   * bands: 8 channels, outgoing/incoming as [0,1] full band, [2,3] bass (<150 Hz), [4,5] mids
   * (300 Hz-3 kHz), [6,7] highs (>3 kHz).
   */
  async function renderBlend({ out, inc, plan, blueprint = null, sr = SR, preroll = 16, tail = 16, stems = false,
                               bands = false }) {
    const p = Object.assign({}, plan, { startCtx: preroll });
    const outSpeed = out.tempoRatio * out.rate;
    const ctx = new OfflineAudioContext(bands ? 8 : 2, Math.ceil((preroll + MixBlocks.postSec(p) + tail) * sr), sr);
    let busOut, busIn;
    if (bands) {
      const merger = ctx.createChannelMerger(8);
      merger.connect(ctx.destination);
      const chain = (src, specs) => specs.reduce((node, [type, hz]) => {
        const f = ctx.createBiquadFilter();
        f.type = type;
        f.frequency.value = hz;
        f.Q.value = Math.SQRT1_2;
        node.connect(f);
        return f;
      }, src);
      busOut = ctx.createGain();
      busIn = ctx.createGain();
      [busOut, busIn].forEach((bus, i) => {
        bus.connect(merger, 0, i);
        chain(bus, [['lowpass', 150], ['lowpass', 150]]).connect(merger, 0, 2 + i);
        chain(bus, [['highpass', 300], ['highpass', 300], ['lowpass', 3000], ['lowpass', 3000]]).connect(merger, 0, 4 + i);
        chain(bus, [['highpass', 3000], ['highpass', 3000]]).connect(merger, 0, 6 + i);
      });
    } else if (stems) {
      const merger = ctx.createChannelMerger(2);
      merger.connect(ctx.destination);
      busOut = ctx.createGain();
      busIn = ctx.createGain();
      busOut.connect(merger, 0, 0);
      busIn.connect(merger, 0, 1);
    } else {
      busOut = busIn = ctx.createGain();
      busOut.connect(ctx.destination);
    }
    const decks = [[new DJDeckAudio(ctx, 1, busOut), out], [new DJDeckAudio(ctx, 2, busIn), inc]];
    for (const [deck, side] of decks) {
      deck.audio.buffer = side.buffer;
      deck.audio.nativeBuffer = { duration: side.buffer.duration * side.tempoRatio };
      deck.audio.tempoRatio = side.tempoRatio;
      deck.audio.playbackRate = side.rate;
      MixPlanner.setTrim(deck, side.trimDb || 0, 0);
    }
    const [outDeck, inDeck] = [decks[0][0], decks[1][0]];
    outDeck.audio.play(0, p.exitNative - preroll * outSpeed);
    const lead = p.inLeadSec || 0;  // a filter wash starts the incoming under it
    inDeck.audio.play(p.startCtx - lead, p.inStartNative - lead);
    const marks = blueprint ? MixPlanner.scheduleBlueprint(blueprint, p, outDeck, inDeck)
                            : MixBlocks.perform(p, outDeck, inDeck);
    return { rendered: await ctx.startRendering(), marks };
  }

  /** Level (dB) of each of the `beats` beats of a deck's buffer before native time `nativeEnd`,
   *  as it plays at its tempo ratio and rate (mono, no mixer): what the floor hears undisturbed. */
  function dryBeatsDb(side, nativeEnd, beats, beatSec) {
    const b = side.buffer;
    const chans = [...Array(b.numberOfChannels).keys()].map(c => b.getChannelData(c));
    const perBeat = beatSec * side.tempoRatio * side.rate;          // native seconds per beat
    const out = [];
    for (let k = beats; k > 0; k--) {
      const i0 = Math.max(0, Math.floor((nativeEnd - k * perBeat) / side.tempoRatio * b.sampleRate));
      const i1 = Math.min(b.length, Math.floor((nativeEnd - (k - 1) * perBeat) / side.tempoRatio * b.sampleRate));
      let e = 0;
      for (let i = i0; i < i1; i++) {
        let v = 0;
        for (const c of chans) v += c[i];
        v /= chans.length;
        e += v * v;
      }
      out.push(10 * Math.log10(e / Math.max(1, i1 - i0) + 1e-12));
    }
    return out;
  }

  /**
   * opts: { outId, inId, bars=16, outStart (native s where the outgoing deck is when the plan
   *         is made; default 24 s before its suggested outro), blueprint (optional AI blueprint) }
   */
  async function run(opts) {
    const bars = opts.bars || 16;
    const [outTrack, inTrack] = await Promise.all([loadTrack(opts.outId), loadTrack(opts.inId)]);
    const [outBuf, inBuf] = await Promise.all([decode(outTrack.audio_url), decode(inTrack.audio_url)]);
    const outStart = opts.outStart !== undefined ? opts.outStart : Math.max(0, outTrack.suggested_cue_outro - 24);

    // Same planner as the live console, with the outgoing deck at outStart at ctx time 0
    const planDeck = { audio: { timeAt: t => outStart + t, ctxTimeAt: n => n - outStart,
                                tempoRatio: 1, playbackRate: 1, duration: outBuf.duration } };
    const gap = Math.abs(outTrack.bpm / inTrack.bpm - 1);
    const blend = gap <= MixPlanner.MAX_STRETCH;
    const p = MixPlanner.plan(outTrack, planDeck, inTrack, bars, {
      now: 0, leadSec: 2, blend, phraseLock: true,
      keyClash: !camelotCompatible(outTrack.camelot, inTrack.camelot),
    });

    const t0 = performance.now();
    const stretched = blend ? await stretchedFor(inTrack, p.tempoRatio) : null;
    const stretchMs = Math.round(performance.now() - t0);
    const result = await renderAndScore({ outTrack, inTrack, outBuf, inBuf, stretched, plan: p, outStart,
                                          blueprint: opts.blueprint });
    return Object.assign(result, { stretch_ms: stretchMs });
  }

  const stretchedCache = new Map();
  function stretchedFor(inTrack, ratio) {
    if (Math.abs(ratio - 1) < 0.0005) return Promise.resolve(null);
    const url = `/api/stretched/${encodeURIComponent(inTrack.file_id)}?ratio=${Math.round(ratio * 1e6) / 1e6}`;
    if (!stretchedCache.has(url)) stretchedCache.set(url, decode(url));
    return stretchedCache.get(url);
  }

  /** Render one plan (blend, or a tempo-gap mix when plan.technique says so) and score it. */
  async function renderAndScore({ outTrack, inTrack, outBuf, inBuf, stretched, plan: p, outStart, blueprint }) {
    const blend = p.technique ? p.technique === 'blend' : Math.abs(outTrack.bpm / inTrack.bpm - 1) <= MixPlanner.MAX_STRETCH;
    if (!p.technique) p.technique = blend ? 'blend' : 'echo_freeze';
    const { rendered, marks } = await renderBlend({
      out: { buffer: outBuf, tempoRatio: 1, rate: 1 },
      inc: { buffer: blend && stretched || inBuf, tempoRatio: blend && stretched ? p.tempoRatio : 1, rate: 1 },
      plan: p, blueprint, preroll: p.startCtx, stems: true,
    });

    const form = new FormData();
    form.append('stems', wav16(rendered), 'stems.wav');
    form.append('start_sec', marks.start);
    form.append('end_sec', marks.end);
    form.append('swap_sec', marks.swap);
    form.append('beat_sec', p.beatSec);
    const score = await (await fetch('/api/score-transition', { method: 'POST', body: form })).json();

    const outBar = 4 * MixPlanner.gridOf(outTrack).period;
    const inBar = 4 * MixPlanner.gridOf(inTrack).period;
    return {
      pair: `${outTrack.title || outTrack.file_id} (${outTrack.bpm.toFixed(2)}, ${outTrack.camelot}) -> ` +
            `${inTrack.title || inTrack.file_id} (${inTrack.bpm.toFixed(2)}, ${inTrack.camelot})`,
      style: blend ? (blueprint ? 'ai-blueprint blend' : 'blend') : (p.technique || 'cut (tempo gap)'),
      bars: p.bars,
      tail_bars: p.tailBars || 0,
      swap_bar: p.swapBar,
      drop_swap: !!p.dropAligned,
      trim_db: +(p.inTrimDb || 0).toFixed(2),
      tempo_ratio: +p.tempoRatio.toFixed(5),
      exit_at: +p.exitNative.toFixed(2),
      exit_on_phrase16: near(outTrack.phrase_16_times, p.exitNative),
      exit_on_phrase32: near(outTrack.phrase_32_times, p.exitNative),
      landing_on_out_phrase16: near(outTrack.phrase_16_times, p.exitNative + p.bars * outBar),
      in_start_at: +p.inStartNative.toFixed(2),
      in_start_on_phrase8: near(inTrack.phrase_8_times, p.inStartNative),
      in_drop_lands_at_blend_end: near(inTrack.drop_times, p.inStartNative + p.bars * inBar, 0.1),
      vocal_clash: p.vocalClash,
      key_clash: p.keyClash,
      wait_s: +p.startCtx.toFixed(1),
      metrics: score.metrics,
    };
  }

  const QUICK_SR = 11025;

  /** RMS in dB of consecutive `n`-sample blocks. */
  function blockDb(x, n) {
    const out = [];
    for (let i = 0; i + n <= x.length; i += n) {
      let s = 0;
      for (let k = i; k < i + n; k++) s += x[k] * x[k];
      out.push(10 * Math.log10(Math.max(s / n, 1e-18)));
    }
    return out;
  }

  const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
  const med = a => pct(a, 0.5);

  /**
   * Measure a blend before it's played: render it offline from the exact buffers, plan and
   * automation the live console would use, and compute the same bass/mids/loudness scores as
   * /api/score-transition (kick flam aside: the grid is the same for every candidate).
   * out/inc: { buffer, tempoRatio, rate, trimDb }. ~0.1-0.3 s per candidate.
   */
  async function quickScore({ out, inc, plan }) {
    const beat = plan.beatSec;
    // 4 bars before (the "pre" level), plus whatever the mix does before its start (gap lead-ins)
    const preroll = 4 * 4 * beat + MixBlocks.preSec(plan);
    const { rendered, marks } = await renderBlend({ out, inc, plan, sr: QUICK_SR, preroll,
                                                     tail: 4 * 4 * beat + 0.5, bands: true });
    const ch = [0, 1, 2, 3, 4, 5, 6, 7].map(i => rendered.getChannelData(i));
    const nBeat = Math.floor(beat * QUICK_SR);
    const a0 = Math.floor(marks.start / beat), a1 = Math.floor(marks.end / beat);
    // Bass: a deck carries the floor on a beat when its lows are within 12 dB of its loud beats
    const lows = [ch[2], ch[3]].map(x => blockDb(x, nBeat));
    const active = lows.map(db => { const ref = pct(db, 0.95); return db.map(v => v > ref - 12 && v > -100); });
    let both = 0, neither = 0, clash = 0;
    const mids = [ch[4], ch[5]].map(x => blockDb(x, nBeat));
    const midOn = mids.map(db => { const ref = pct(db, 0.95); return db.map(v => v > ref - 10 && v > -100); });
    // Hats and percussion of two tempos heard together (beat-matched blends share a groove)
    const highs = [ch[6], ch[7]].map(x => blockDb(x, nBeat));
    const highOn = highs.map(db => { const ref = pct(db, 0.95); return db.map(v => v > ref - 10 && v > -100); });
    // Both decks' tonal midrange audible together (tails included): what clashing keys make dissonant
    const midHeard = mids.map(db => { const ref = pct(db, 0.95); return db.map(v => v > ref - 18 && v > -100); });
    const beatMatched = plan.technique === 'blend';
    // A deliberate build (MixBlocks marks it) empties the floor on purpose: not a hole or a gap
    const inBuild = b => marks.build && b >= Math.floor(marks.build[0] / beat) && b < Math.floor(marks.build[1] / beat);
    let highClash = 0, tonal = 0;
    for (let b = a0; b < Math.min(a1, lows[0].length); b++) {
      if (midHeard[0][b] && midHeard[1][b]) tonal++;
      if (active[0][b] && active[1][b]) both++;
      if (!active[0][b] && !active[1][b] && !inBuild(b)) neither++;
      if (midOn[0][b] && midOn[1][b] && Math.abs(mids[0][b] - mids[1][b]) < 6) clash++;
      if (!beatMatched && highOn[0][b] && highOn[1][b] && Math.abs(highs[0][b] - highs[1][b]) < 6) highClash++;
    }
    // Loudness per bar of the mix: the dip/bump against the level before and after
    const mix = new Float32Array(ch[0].length);
    for (let i = 0; i < mix.length; i++) mix[i] = ch[0][i] + ch[1][i];
    const bars = blockDb(mix, 4 * nBeat);
    const b0 = Math.round(marks.start / (4 * beat)), b1 = Math.round(marks.end / (4 * beat));
    const pre = med(bars.slice(Math.max(0, b0 - 4), b0));
    const post = med(bars.slice(b1, b1 + 4).length ? bars.slice(b1, b1 + 4) : bars.slice(-1));
    const span = bars.slice(b0, Math.max(b0 + 1, b1));
    const outsideBuild = span.filter((v, k) => !inBuild((b0 + k) * 4 + 3));
    const during = outsideBuild.length ? outsideBuild : span;
    // A hole at beat resolution: the quietest beat of the transition (and the beat after it) against
    // the outgoing's own level in the 16 beats before the switch, dry: the same yardstick for every
    // style at this moment, whatever it does before the switch
    const beatsDb = blockDb(mix, nBeat);
    const floorDb = med(dryBeatsDb(out, plan.exitNative, 16, beat)) + (out.trimDb || 0);
    const heard = beatsDb.slice(a0, Math.max(a0 + 1, a1 + 1)).filter((v, k) => !inBuild(a0 + k));
    const hole = heard.length ? floorDb - Math.min(...heard) : 0;
    const m = {
      hole_db: +Math.max(0, hole).toFixed(2),
      bass_overlap_s: +(both * beat).toFixed(2),
      bass_gap_s: +(neither * beat).toFixed(2),
      mid_clash_s: +(clash * beat).toFixed(2),
      high_clash_s: +(highClash * beat).toFixed(2),
      tonal_overlap_s: +(tonal * beat).toFixed(2),
      loudness_dip_db: +(Math.min(...during) - Math.min(pre, post)).toFixed(2),
      loudness_bump_db: +(Math.max(...during) - Math.max(pre, post)).toFixed(2),
    };
    return Object.assign(m, { penalty: penalty(m) });
  }

  const MEASURED = new Set(['blend', 'echo_freeze']);   // skeletons MixBlocks can perform in any style

  /** Measure every blend and tempo-gap candidate in place (c.measured). The incoming is `inc` for
   *  blends (at the master tempo) and `incNative` (its own tempo) otherwise. */
  async function measureAll(cands, out, inc, incNative = inc) {
    for (const c of cands) {
      if (!MEASURED.has(c.technique) || c.measured) continue;
      try {
        c.measured = await quickScore({ out, inc: c.technique === 'blend' ? inc : incNative, plan: c });
      } catch (err) {
        console.warn(`Could not measure candidate ${c.id}:`, err);
      }
    }
    return cands;
  }

  const ACCEPT_MARGIN = 3;  // penalty points a candidate may sit above the cleanest one

  /** Candidates that sound as clean as the cleanest, within the margin (unmeasured ones pass). */
  function acceptable(cands) {
    const scores = cands.filter(c => c.measured).map(c => c.measured.penalty);
    if (!scores.length) return cands;
    const best = Math.min(...scores);
    return cands.filter(c => !c.measured || c.measured.penalty <= best + ACCEPT_MARGIN);
  }

  /** The measured-cleanest candidate (planner order breaks ties; the first one if none measured). */
  function cleanest(cands) {
    return cands.filter(c => c.measured).sort((a, b) => a.measured.penalty - b.measured.penalty)[0] || cands[0];
  }

  // How the final choice weighs its signals, among candidates that passed the sound check
  const WEIGHTS = { jev: 0.45, gemini: 0.35, clean: 0.2, handover: 0.15 };

  /**
   * Final choice. Only candidates that passed the sound check can win; among them each gets
   * 45% Jev's mean rating (0-4 over phrasing, energy, vocals, crowd, overall), 35% if it is
   * Gemini's pick, 20% how close it sounds to the cleanest, 15% if it hands over gradually.
   * Without AI signals Jev counts as neutral. ai = { gemini: id, scores: {id: {mean}} }.
   * Returns { plan, verdict: 'ai' | 'combined' | 'rejected' | 'cleanest' | 'smoothest' | 'planner', totals }.
   */
  function settle(cands, ai = {}) {
    const ok = acceptable(cands);
    const measured = cands.some(c => c.measured);
    const scores = ai.scores || null;
    const gemini = cands.find(c => c.id === ai.gemini) ? ai.gemini : null;
    if (!measured && !scores && !gemini) return { plan: cands[0], verdict: 'planner', totals: {} };
    const penalties = ok.filter(c => c.measured).map(c => c.measured.penalty);
    const best = penalties.length ? Math.min(...penalties) : null;
    const totals = {};
    for (const c of cands) {
      if (!ok.includes(c)) { totals[c.id] = null; continue; }
      const jev = scores && scores[c.id] ? scores[c.id].mean / 4 : 0.5;
      const clean = c.measured && best !== null ? 1 - Math.min(1, (c.measured.penalty - best) / ACCEPT_MARGIN) : 1;
      totals[c.id] = +(WEIGHTS.jev * jev + WEIGHTS.gemini * (c.id === gemini ? 1 : 0) + WEIGHTS.clean * clean +
                       WEIGHTS.handover * (MixBlocks.prefKeys(c)[0] === 'handover' ? 1 : 0)).toFixed(3);
    }
    // Without AI signals only what was actually sound-checked can win
    const pool = !scores && !gemini ? ok.filter(c => c.measured) : ok;
    const plan = pool.reduce((a, b) => (totals[b.id] > totals[a.id] ? b : a));
    const verdict = !scores && !gemini ? (plan === cleanest(ok) ? 'cleanest' : 'smoothest')
      : gemini && totals[gemini] === null ? 'rejected' : plan.id === gemini ? 'ai' : 'combined';
    return { plan, verdict, totals };
  }

  // ── Confidence (0-100): how sure we are a candidate will sound good to this DJ ──
  // Sound: a clean render scores 100; every penalty point past 1.5 costs 5. Cutting the outgoing's
  // lead vocal before its line ends costs 0.25 points a second (c.vocalCutSec, up to 30 s), and with
  // clashing keys (c.keySeverity, 0-1) the two tracks' midrange heard together costs up to 0.5 points a
  // second. Taste: the DJ's ratings of this kind of mix (prefs = { key: [likes, ratings] }, keys from
  // MixBlocks.prefKeys), starting from a prior that gradual handovers are preferred to switches; half
  // Jev's rating when there is one.
  const TASTE_PRIOR = { handover: 0.7, switch: 0.5 };

  function taste(c, prefs = {}) {
    const [kind, ...details] = MixBlocks.prefKeys(c);
    const mean = (key, prior, weight) => {
      const [likes, n] = prefs[key] || [0, 0];
      return (likes + prior * weight) / (n + weight);
    };
    let v = mean(kind, TASTE_PRIOR[kind], 4);
    for (const key of details) v += (mean(key, 0.5, 4) - 0.5) / details.length;
    return Math.max(0, Math.min(1, v));
  }

  function soundScore(c) {
    if (!c.measured) return null;
    const penalty = c.measured.penalty + 0.25 * Math.min(30, c.vocalCutSec || 0)
      + 0.5 * (c.keySeverity || 0) * (c.measured.tonal_overlap_s || 0);
    return Math.max(0, Math.min(100, 100 - 5 * Math.max(0, penalty - 1.5)));
  }

  function confidence(c, prefs = {}) {
    const sound = soundScore(c);
    if (sound === null) return null;
    const t = typeof c.jev === 'number' ? 0.5 * taste(c, prefs) + 0.5 * c.jev / 4 : taste(c, prefs);
    return Math.round(0.6 * sound + 0.4 * 100 * t + (c.geminiPick ? 4 : 0));
  }

  /** One number for "how clean did it sound" (lower is better): flams, bass holes/mud, level
   *  dips/spikes and two leads fighting. Musical taste (phrasing, energy) isn't in here. */
  function penalty(m, cut = false) {
    if (!m) return null;
    // A cut never overlaps: its "flam" compares two tempos that are never heard together
    return +((cut ? 0 : (m.kick_flam_ms || 0) / 2) + 2 * (m.bass_gap_s || 0) + 2 * (m.bass_overlap_s || 0) +
             3 * Math.max(0, -(m.loudness_dip_db || 0) - 1.5) + 3 * Math.max(0, (m.loudness_bump_db || 0) - 1.5) +
             3 * Math.max(0, (m.hole_db || 0) - 4) + (m.mid_clash_s || 0) + (m.high_clash_s || 0)).toFixed(2);
  }

  /**
   * Which engine picks the best transition? For one track pair: build the live console's
   * candidates, render and score every one, then ask each engine to pick.
   * opts: { outId, inId, bars=16, outStart, models (any non-'planner' entry asks the AI once),
   *         listen=true (use Gemini's vocal labels) }
   */
  async function benchmark(opts) {
    const bars = opts.bars || 16;
    const models = opts.models || ['planner', 'gemini-3.8-flash', 'jev-latest'];
    let [outTrack, inTrack] = await Promise.all([loadTrack(opts.outId), loadTrack(opts.inId)]);
    if (opts.listen !== false) [outTrack, inTrack] = await Promise.all([listened(outTrack), listened(inTrack)]);
    const [outBuf, inBuf] = await Promise.all([decode(outTrack.audio_url), decode(inTrack.audio_url)]);
    const outStart = opts.outStart !== undefined ? opts.outStart : Math.max(0, outTrack.suggested_cue_outro - 40);
    const planDeck = { audio: { timeAt: t => outStart + t, ctxTimeAt: n => n - outStart,
                                tempoRatio: 1, playbackRate: 1, duration: outBuf.duration } };
    const blend = Math.abs(outTrack.bpm / inTrack.bpm - 1) <= MixPlanner.MAX_STRETCH;
    const cands = MixPlanner.candidates(outTrack, planDeck, inTrack, {
      now: 0, leadSec: 11, blend, phraseLock: true, cutTechnique: 'echo_freeze',
      barsOptions: bars >= 16 ? [bars, 8] : [bars, 16],
      keyClash: !camelotCompatible(outTrack.camelot, inTrack.camelot),
    });
    const stretched = blend && cands.length ? await stretchedFor(inTrack, cands[0].tempoRatio) : null;
    const scored = {};
    for (const c of cands) {
      const r = await renderAndScore({ outTrack, inTrack, outBuf, inBuf, stretched, plan: c, outStart });
      scored[c.id] = Object.assign(r, { id: c.id, technique: c.technique, penalty: penalty(r.metrics, c.technique !== 'blend'),
                                        features: MixPlanner.candidateFeatures(c, outTrack, inTrack, 0) });
    }
    const body = {
      budget_sec: 8,
      out: MixPlanner.trackSummary(outTrack, outTrack.bpm, outStart, outStart),
      in: MixPlanner.trackSummary(inTrack, inTrack.bpm),
      candidates: cands.map(c => scored[c.id].features),
    };
    // The live sound check: the same quick render + measurement the console runs before a mix
    await measureAll(cands, { buffer: outBuf, tempoRatio: 1, rate: 1 },
                     stretched ? { buffer: stretched, tempoRatio: cands[0].tempoRatio, rate: 1 }
                               : { buffer: inBuf, tempoRatio: 1, rate: 1 });
    // One AI call (Gemini picks, Jev rates) and every policy the console could follow with it
    let ai = { choice: null, gemini_choice: null, scores: null, engine: 'planner', errors: {} };
    if (cands.length > 1 && models.some(m => m !== 'planner')) {
      ai = await (await fetch('/api/ai-choose-transition', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ model: 'gemini-3.8-flash' }, body)),
      })).json();
    }
    const policy = (sig) => {
      const f = cands.length ? settle(cands, sig) : { plan: null, verdict: 'none', totals: {} };
      return { played: f.plan && f.plan.id, verdict: f.verdict, totals: f.totals };
    };
    const picks = {
      'planner-first (before)': { played: cands.length ? cands[0].id : null, verdict: 'planner' },
      'planner (cleanest)': policy({}),
      'gemini + sound check': policy({ gemini: ai.gemini_choice }),
      'jev + sound check': policy({ scores: ai.scores }),
      'combined (jev + gemini + sound check)': policy({ gemini: ai.gemini_choice, scores: ai.scores }),
    };
    const ranked = Object.values(scored).map(s => s.penalty).filter(v => v !== null).sort((a, b) => a - b);
    return {
      pair: `${outTrack.title || outTrack.file_id} -> ${inTrack.title || inTrack.file_id}`,
      out_start: outStart,
      ai: { gemini: ai.gemini_choice, gemini_reason: ai.gemini_reason, scores: ai.scores,
            latency: ai.engine_latency_ms, errors: ai.errors },
      best_penalty: ranked.length ? ranked[0] : null,
      candidates: Object.values(scored).map(s => ({ id: s.id, technique: s.technique, bars: s.bars,
        exit_at: s.exit_at, wait_s: s.wait_s, penalty: s.penalty, quick: (cands.find(c => c.id === s.id).measured || {}),
        features: s.features, metrics: s.metrics })),
      picks: Object.fromEntries(Object.entries(picks).map(([m, p]) => [m, Object.assign(p, {
        penalty: p.played && scored[p.played] ? scored[p.played].penalty : null })])),
    };
  }

  /**
   * Prompt A/B for one pair: does the compact prompt (only sections near the candidates) make
   * Gemini pick differently from the full prompt? Asks Gemini alone `repeats` times per variant
   * (its own run-to-run variation is the yardstick) and returns picks with token usage, plus how
   * many candidates passed the sound check (with fewer than 2, no AI call is needed at all).
   */
  async function promptAB({ outId, inId, repeats = 2, bars = 16 }) {
    let [outTrack, inTrack] = await Promise.all([loadTrack(outId), loadTrack(inId)]);
    [outTrack, inTrack] = await Promise.all([listened(outTrack), listened(inTrack)]);
    const [outBuf, inBuf] = await Promise.all([decode(outTrack.audio_url), decode(inTrack.audio_url)]);
    const outStart = Math.max(0, outTrack.suggested_cue_outro - 40);
    const planDeck = { audio: { timeAt: t => outStart + t, ctxTimeAt: n => n - outStart,
                                tempoRatio: 1, playbackRate: 1, duration: outBuf.duration } };
    const blend = Math.abs(outTrack.bpm / inTrack.bpm - 1) <= MixPlanner.MAX_STRETCH;
    const cands = MixPlanner.candidates(outTrack, planDeck, inTrack, {
      now: 0, leadSec: 11, blend, phraseLock: true, cutTechnique: 'echo_freeze',
      barsOptions: bars >= 16 ? [bars, 8] : [bars, 16],
      keyClash: !camelotCompatible(outTrack.camelot, inTrack.camelot),
    });
    const stretched = blend && cands.length ? await stretchedFor(inTrack, cands[0].tempoRatio) : null;
    await measureAll(cands, { buffer: outBuf, tempoRatio: 1, rate: 1 },
                     stretched ? { buffer: stretched, tempoRatio: cands[0].tempoRatio, rate: 1 }
                               : { buffer: inBuf, tempoRatio: 1, rate: 1 });
    const result = { pair: `${outTrack.title} -> ${inTrack.title}`, n: cands.length,
                     accepted: acceptable(cands).length, full: [], compact: [] };
    if (cands.length < 2) return result;
    const body = {
      model: 'gemini-3.8-flash', engines: ['gemini'], budget_sec: 15,
      out: MixPlanner.trackSummary(outTrack, outTrack.bpm, outStart, outStart),
      in: MixPlanner.trackSummary(inTrack, inTrack.bpm),
      candidates: cands.map(c => MixPlanner.candidateFeatures(c, outTrack, inTrack, 0)),
    };
    for (let r = 0; r < repeats; r++) {
      for (const variant of ['full', 'compact']) {
        let res = null;
        for (let attempt = 0; attempt < 2 && !(res && res.gemini_choice); attempt++) {
          if (attempt) await new Promise(ok => setTimeout(ok, 2500));
          res = await (await fetch('/api/ai-choose-transition', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({ compact: variant === 'compact' }, body)),
          })).json();
        }
        const u = res.gemini_usage || {};
        result[variant].push({ choice: res.gemini_choice, ms: res.engine_latency_ms && res.engine_latency_ms.gemini,
          prompt: u.promptTokenCount, output: u.candidatesTokenCount, thinking: u.thoughtsTokenCount,
          error: res.errors && res.errors.gemini });
      }
    }
    return result;
  }

  /** Export the blend that was just performed live: same buffers, plan and automation, 44.1 kHz. */
  async function exportPerformed(L) {
    const { rendered, marks } = await renderBlend({
      out: L.out, inc: L.inc, plan: L.plan, blueprint: L.blueprint, sr: 44100,
      preroll: 16 + MixBlocks.preSec(L.plan), tail: 16,
    });
    return { blob: wav16(rendered), duration: rendered.duration, marks };
  }

  return { run, benchmark, promptAB, quickScore, measureAll, acceptable, settle, renderBlend, exportPerformed,
           taste, soundScore, confidence };
})();

window.TransitionLab = TransitionLab;
