/**
 * transition_lab.js - Render a planned transition offline and score it.
 *
 * Uses the SAME planner (MixPlanner.plan), deck graph (DJDeckAudio) and automation
 * (scheduleBlend / scheduleBlueprint) as the live console, rendered in an OfflineAudioContext
 * with the outgoing deck on channel 0 and the incoming deck on channel 1, then posts the stems
 * to /api/score-transition. Nothing runs unless called, e.g. from the devtools console:
 *
 *   await TransitionLab.run({ outId: 'lab1_a.mp3', inId: 'lab2_b.mp3', bars: 16 })
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

    let stretched = null;
    const t0 = performance.now();
    if (blend && Math.abs(p.tempoRatio - 1) >= 0.0005) {
      stretched = await decode(`/api/stretched/${encodeURIComponent(inTrack.file_id)}?ratio=${Math.round(p.tempoRatio * 1e6) / 1e6}`);
    }
    const stretchMs = Math.round(performance.now() - t0);

    const tail = 16;
    const len = Math.ceil((p.startCtx + p.blendSec + tail) * SR);
    const ctx = new OfflineAudioContext(2, len, SR);
    const merger = ctx.createChannelMerger(2);
    merger.connect(ctx.destination);
    const busOut = ctx.createGain();
    const busIn = ctx.createGain();
    busOut.connect(merger, 0, 0);
    busIn.connect(merger, 0, 1);
    const outDeck = new DJDeckAudio(ctx, 1, busOut);
    const inDeck = new DJDeckAudio(ctx, 2, busIn);
    outDeck.audio.nativeBuffer = outDeck.audio.buffer = outBuf;
    inDeck.audio.nativeBuffer = inDeck.audio.buffer = inBuf;
    if (stretched) inDeck.audio.useBuffer(stretched, p.tempoRatio);

    outDeck.audio.play(0, outStart);
    let marks;
    if (blend) {
      inDeck.audio.play(p.startCtx, p.inStartNative);
      marks = opts.blueprint
        ? MixPlanner.scheduleBlueprint(opts.blueprint, p, outDeck, inDeck)
        : MixPlanner.scheduleBlend(p, outDeck, inDeck);
    } else {
      const intro = inTrack.suggested_cue_intro || 0;
      MixPlanner.neutral(inDeck, p.startCtx - 0.05, 1);
      MixPlanner.setTrim(inDeck, p.inTrimDb || 0, p.startCtx - 0.05);
      inDeck.audio.play(p.startCtx, intro);
      MixPlanner.cutAt(outDeck, p.startCtx);
      marks = { start: p.startCtx, swap: p.startCtx, end: p.startCtx + 4 * p.beatSec };
    }
    const rendered = await ctx.startRendering();

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
      style: blend ? (opts.blueprint ? 'ai-blueprint blend' : 'blend') : 'cut (tempo gap)',
      bars: p.bars,
      tail_bars: p.tailBars || 0,
      swap_bar: p.swapBar,
      drop_swap: !!p.dropAligned,
      trim_db: +(p.inTrimDb || 0).toFixed(2),
      tempo_ratio: +p.tempoRatio.toFixed(5),
      stretch_ms: stretchMs,
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

  return { run };
})();

window.TransitionLab = TransitionLab;
