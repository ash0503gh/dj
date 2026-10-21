/**
 * mix_log.js - What each mix did, and how it sounded live.
 *
 * For every mix the console performs: the two tracks, the style and its confidence, the incoming's
 * loudness match (trim), the tempos (a glide or not), MIX SOON, and what the sound check measured. While
 * it plays, the master's level and each deck's are metered every 100 ms (analysers tapped off the live
 * graph, nothing heard changes), and from them:
 *   entry rise   the loudest second while the incoming comes in, against the 4 s before the mix
 *   sharpest     the biggest jump of the master from one second to the next, and when it happened
 *   swap step    the level just after the bass swap against just before
 *   after        the level once the incoming is alone, against before the mix
 * A mix whose master jumps 4 dB or more from one second to the next is marked ABRUPT, and each deck is
 * metered too, so the jump is put down to the deck that added more of the power it gained: the INCOMING
 * (coming in too fast or too loud) or the OUTGOING's own music (its drop arriving as the mix starts, say).
 * Entries go to the server
 * (/api/mix-log, a file next to the ratings) and show in the MIX LOG panel; DOWNLOAD saves them.
 */
const MixLog = (() => {
  const STEP_MS = 100;
  const ABRUPT_DB = 4;          // as the sound check (TransitionLab: rise_before_swap_db past 4 dB costs)
  let engine = null;
  let meters = null;
  let entries = [];
  const ui = {};

  function setUpMeters() {
    const make = node => {
      const a = engine.ctx.createAnalyser();
      a.fftSize = 4096;            // ~90 ms of audio per reading
      node.connect(a);
      return a;
    };
    meters = { master: make(engine.masterGain), 1: make(engine.deck1.cfGain), 2: make(engine.deck2.cfGain) };
  }

  function levelDb(an) {
    const d = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(d);
    let e = 0;
    for (let i = 0; i < d.length; i++) e += d[i] * d[i];
    return 10 * Math.log10(e / d.length + 1e-12);
  }

  /** Mean level (power average, dB) of samples with ctx times in [t0, t1); null with none. */
  function meanDb(samples, key, t0, t1) {
    const xs = samples.filter(s => s.t >= t0 && s.t < t1).map(s => Math.pow(10, s[key] / 10));
    return xs.length ? 10 * Math.log10(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  }

  const r1 = x => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);

  /**
   * Start metering a mix. info: what it is (tracks, style, trims...); times: { start, swap, end, entryEnd }
   * as ctx times, and the decks { outNum, inNum }.
   */
  function begin(info, times) {
    if (!engine) return;
    if (!meters) setUpMeters();
    const samples = [];
    const stopAt = times.end + 6;
    const timer = setInterval(() => {
      const t = engine.ctx.currentTime;
      samples.push({ t, master: levelDb(meters.master), out: levelDb(meters[times.outNum]), in: levelDb(meters[times.inNum]) });
      if (t >= stopAt) {
        clearInterval(timer);
        finish(info, times, samples);
      }
    }, STEP_MS);
  }

  function finish(info, times, samples) {
    const { start, swap, end, entryEnd } = times;
    const before = meanDb(samples, 'master', start - 4, start);
    // The loudest second while the incoming comes in, and the sharpest one-second jump of the mix
    let entryMax = null;
    for (let t = start; t + 1 <= entryEnd + 1; t += 0.25) {
      const v = meanDb(samples, 'master', t, t + 1);
      if (v !== null && (entryMax === null || v > entryMax)) entryMax = v;
    }
    let sharpest = null, sharpestAt = null;
    for (let t = start - 1; t + 2 <= end + 3; t += 0.25) {
      const a = meanDb(samples, 'master', t, t + 1), b = meanDb(samples, 'master', t + 1, t + 2);
      if (a !== null && b !== null && (sharpest === null || b - a > sharpest)) { sharpest = b - a; sharpestAt = t + 1 - start; }
    }
    const swapStep = swap ? (meanDb(samples, 'master', swap, swap + 2) - meanDb(samples, 'master', swap - 2, swap)) : null;
    // Each deck's part: the outgoing's own change as the mix starts, the incoming's sharpest audible leap
    const outBefore = meanDb(samples, 'out', start - 4, start);
    let outMax = null;
    for (let t = start; t + 1 <= entryEnd + 1; t += 0.25) {
      const v = meanDb(samples, 'out', t, t + 1);
      if (v !== null && (outMax === null || v > outMax)) outMax = v;
    }
    // The incoming's sharpest gain while it comes in (before the swap or landing, which may be sudden by
    // design), over what was there: its previous second, or 20 dB under the outgoing or the room before
    let inJump = null, inJumpAt = null;
    const floorDb = (before ?? -60) - 20;
    for (let t = start - 1; t + 2 <= (swap || end); t += 0.25) {
      const a = meanDb(samples, 'in', t, t + 1), b = meanDb(samples, 'in', t + 1, t + 2);
      const o = meanDb(samples, 'out', t + 1, t + 2);
      if (a === null || b === null || o === null) continue;
      const jump = b - Math.max(a, o - 20, floorDb);
      if (inJump === null || jump > inJump) { inJump = jump; inJumpAt = t + 1 - start; }
    }
    if (inJump !== null) inJump = Math.max(0, inJump);
    const after = meanDb(samples, 'master', end + 2, end + 6);
    const live = {
      before_db: r1(before),
      entry_rise_db: r1(entryMax !== null && before !== null ? entryMax - before : null),
      sharpest_rise_db: r1(sharpest),
      sharpest_at_s: r1(sharpestAt),
      swap_step_db: r1(swapStep),
      after_vs_before_db: r1(after !== null && before !== null ? after - before : null),
      // How loud each deck was 2 s into the mix (after their faders and EQs), the incoming against the outgoing
      in_vs_out_at_entry_db: r1(meanDb(samples, 'in', start + 1.5, start + 2.5) - meanDb(samples, 'out', start + 1.5, start + 2.5)),
      in_vs_out_at_swap_db: swap ? r1(meanDb(samples, 'in', swap, swap + 1) - meanDb(samples, 'out', swap, swap + 1)) : null,
      out_own_change_db: r1(outMax !== null && outBefore !== null ? outMax - outBefore : null),
      in_jump_db: r1(inJump),
      in_jump_at_s: r1(inJumpAt),
    };
    // Who made the sharpest jump: the deck whose power grew more over that second
    live.cause = null;
    if (sharpest !== null && sharpest >= ABRUPT_DB) {
      const t1 = start + sharpestAt;
      const gain = key => Math.pow(10, (meanDb(samples, key, t1, t1 + 1) ?? -120) / 10)
        - Math.pow(10, (meanDb(samples, key, t1 - 1, t1) ?? -120) / 10);
      const gi = gain('in'), go = gain('out');
      live.cause = gi <= 0 && go <= 0 ? 'unclear' : gi >= go ? 'incoming' : 'outgoing';
    }
    live.abrupt = !!live.cause;
    const entry = Object.assign({}, info, { live });
    console.info(`Mix log: ${info.label} ${live.abrupt ? `ABRUPT (${live.cause}) ` : ''}entry ${live.entry_rise_db} dB, sharpest ` +
                 `${live.sharpest_rise_db} dB at ${live.sharpest_at_s} s, incoming leap ${live.in_jump_db} dB, outgoing own ` +
                 `${live.out_own_change_db} dB, swap ${live.swap_step_db} dB, trim in ${info.in_trim_db} dB`);
    entries.unshift(entry);
    render();
    fetch('/api/mix-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) })
      .catch(() => {});
  }

  const fmt = (x, unit = ' dB') => (x === null || x === undefined ? '–' : `${x > 0 ? '+' : ''}${x}${unit}`);

  function render() {
    if (!ui.list) return;
    if (!entries.length) {
      ui.list.textContent = 'No mixes yet this session or on record.';
      return;
    }
    ui.list.replaceChildren(...entries.slice(0, 60).map(e => {
      const row = document.createElement('div');
      row.className = `mixlog-row${e.live && e.live.abrupt ? ' abrupt' : ''}`;
      const head = document.createElement('div');
      head.className = 'mixlog-head';
      const when = new Date(e.at || Date.now());
      head.textContent = `${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${e.out_title} → ${e.in_title}`;
      const what = document.createElement('div');
      what.className = 'mixlog-what';
      what.textContent = [e.label, e.confidence !== null && e.confidence !== undefined ? `${e.confidence}%` : null,
                          e.glide ? `glide to ${e.glide_bpm} BPM` : null, e.mix_soon ? 'MIX SOON' : null,
                          e.live && e.live.abrupt ? `ABRUPT: ${{ incoming: 'THE INCOMING LEAPT', outgoing: "THE OUTGOING'S OWN MUSIC",
                                                                  unclear: 'CAUSE UNCLEAR' }[e.live.cause] || 'JUMP'}` : null]
        .filter(Boolean).join(' · ');
      const nums = document.createElement('div');
      nums.className = 'mixlog-nums';
      const l = e.live || {};
      nums.textContent = `entry ${fmt(l.entry_rise_db)} · sharpest ${fmt(l.sharpest_rise_db)}` +
        `${l.sharpest_at_s !== null && l.sharpest_at_s !== undefined ? ` at ${l.sharpest_at_s} s` : ''}` +
        ` · incoming leap ${fmt(l.in_jump_db)} · outgoing own ${fmt(l.out_own_change_db)}` +
        ` · swap ${fmt(l.swap_step_db)} · after ${fmt(l.after_vs_before_db)}` +
        ` · trim in ${fmt(e.in_trim_db)} · sound check bump ${fmt(e.check_bump_db)}`;
      row.append(head, what, nums);
      return row;
    }));
  }

  function download() {
    const blob = new Blob([JSON.stringify(entries, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pulse-mix-log-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function init(eng) {
    engine = eng;
    ['open', 'modal', 'close', 'list', 'download'].forEach(k => {
      ui[k] = document.getElementById({ open: 'btn-mix-log', modal: 'mix-log-modal', close: 'btn-close-mix-log',
                                        list: 'mix-log-list', download: 'btn-download-mix-log' }[k]);
    });
    if (ui.open && ui.modal) {
      ui.open.addEventListener('click', () => { ui.modal.classList.remove('hidden'); render(); });
      ui.close.addEventListener('click', () => ui.modal.classList.add('hidden'));
      ui.modal.addEventListener('click', e => { if (e.target === ui.modal) ui.modal.classList.add('hidden'); });
      ui.download.addEventListener('click', download);
    }
    fetch('/api/mix-log?limit=100').then(r => (r.ok ? r.json() : null))
      .then(d => { if (d && d.entries) { entries = entries.concat(d.entries); render(); } }).catch(() => {});
  }

  return { init, begin, entries: () => entries };
})();

window.MixLog = MixLog;
