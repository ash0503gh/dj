/**
 * sfx_pads.js - The sound-effects library on the console (/api/sfx, backend/sfx.py).
 *
 * SfxLibrary: the sounds, decoded on first use, and the ones an Auto mix may use (MixBlocks: a library
 * riser into a switch and an impact on its landing, a crash on a blend's bass swap). Only sounds already
 * decoded are offered to a mix, so the sound check renders exactly what would play.
 *
 * SfxPads: eight pads under the transition controls, each a kind of sound (its › button steps through
 * the sounds of that kind). A pad fires on the beat of the deck on air: a build (riser, sweep up,
 * reverse cymbal) ends on the next 4-bar line, a fall (downlifter, sweep down) starts on the next
 * downbeat, a hit on the next beat. With no deck playing it fires at once. The controller's pads fire
 * them too (any pad mode but hot cues: deck A's four, then deck B's).
 */
const SfxLibrary = (() => {
  let ctx = null;
  let sounds = [];
  const loading = new Map();     // id -> Promise<AudioBuffer|null>
  const decoded = new Map();     // id -> AudioBuffer

  async function init(audioCtx) {
    ctx = audioCtx;
    try {
      sounds = (await (await fetch('/api/sfx')).json()).sounds || [];
    } catch (e) {
      sounds = [];
    }
    // What an Auto mix may use, decoded ahead (a few seconds of audio each)
    ['riser', 'impact', 'crash'].forEach(cat => sounds.filter(s => s.category === cat).forEach(s => load(s.id)));
    return sounds;
  }

  function load(id) {
    const s = sounds.find(x => x.id === id);
    if (!s || !ctx) return Promise.resolve(null);
    if (!loading.has(id)) {
      loading.set(id, fetch(s.url).then(r => r.arrayBuffer()).then(ab => ctx.decodeAudioData(ab))
        .then(buf => { decoded.set(id, buf); return buf; })
        .catch(err => { console.warn(`Sound ${s.name} unavailable:`, err); return null; }));
    }
    return loading.get(id);
  }

  const of = cats => sounds.filter(s => cats.includes(s.category));

  /** Sounds for an Auto mix, decoded already: a riser at least `buildSec` long (the shortest such, else
   *  the longest), an impact, and a crash (an impact when there's none). null when there's nothing. */
  function forMix(buildSec) {
    const ready = cat => of([cat]).filter(s => decoded.has(s.id)).map(s => ({ id: s.id, name: s.name, buffer: decoded.get(s.id) }));
    const risers = ready('riser').sort((a, b) => a.buffer.duration - b.buffer.duration);
    const build = risers.find(r => r.buffer.duration >= buildSec) || risers[risers.length - 1] || null;
    const hit = ready('impact')[0] || null;
    const crash = ready('crash')[0] || hit;
    return build || hit ? { build, hit, crash } : null;
  }

  return { init, load, of, forMix, buffer: id => decoded.get(id) || null, sounds: () => sounds };
})();

const SfxPads = (() => {
  const PADS = [
    [['riser'], 'RISER'], [['sweep_up'], 'SWEEP UP'], [['reverse_cymbal'], 'REV CYMBAL'], [['downlifter', 'sweep_down'], 'DOWN'],
    [['impact'], 'IMPACT'], [['sub_drop'], 'SUB DROP'], [['crash'], 'CRASH'], [['air_horn', 'vocal_shout', 'scratch', 'zap'], 'HORN · FX'],
  ];
  const STORE = 'sfx_pad_choice';
  let engine = null;
  let onAir = () => null;
  const pads = [];

  function saved() {
    try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch (e) { return {}; }
  }

  function remember() {
    try { localStorage.setItem(STORE, JSON.stringify(Object.fromEntries(pads.map((p, i) => [i, p.choice])))); } catch (e) { /* private window */ }
  }

  /** ctx time to fire a sound of `role` lasting `sec` on the deck on air, and the offset into it. */
  function placement(role, sec) {
    const now = engine.ctx.currentTime + 0.03;
    const air = onAir();
    if (!air || !air.track || !air.track.grid) return { at: now, offset: 0 };
    const { deck, track } = air;
    const g = MixPlanner.gridOf(track);
    const native = deck.audio.timeAt(now);
    const speed = MixPlanner.deckSpeed(deck);
    const bar = 4 * g.period;
    const downbeat0 = g.first + (track.grid.downbeat_offset || 0) * g.period;
    if (role === 'hit') {
      const next = g.first + Math.ceil((native - g.first) / g.period - 0.02) * g.period;
      return { at: Math.max(now, deck.audio.ctxTimeAt(next)), offset: 0 };
    }
    const barNo = Math.ceil((native - downbeat0) / bar - 0.02);
    if (role === 'fall') return { at: Math.max(now, deck.audio.ctxTimeAt(downbeat0 + barNo * bar)), offset: 0 };
    // build: the next 4-bar line (of the track's phrases) at least a bar, and half the sound, away
    const phase = ((track.grid.phrase_offset_bars || 0) % 4 + 4) % 4;
    let b = barNo;
    while (((b - phase) % 4 + 4) % 4 !== 0 || downbeat0 + b * bar < native + Math.max(bar, 0.5 * sec * speed)) b++;
    const end = deck.audio.ctxTimeAt(downbeat0 + b * bar);
    const start = end - sec;
    return { at: Math.max(now, start), offset: Math.max(0, now - start) };
  }

  async function fire(i) {
    const pad = pads[i];
    if (!pad || !pad.list.length) return;
    const s = pad.list[pad.choice % pad.list.length];
    const buffer = await SfxLibrary.load(s.id);
    if (!buffer) return;
    if (engine.ctx.state === 'suspended') engine.ctx.resume();
    const { at, offset } = placement(s.role, buffer.duration);
    if (pad.src) try { pad.src.stop(at); } catch (e) { /* ended */ }
    const src = engine.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(engine.sfxBus);
    src.start(at, offset);
    pad.src = src;
    pad.el.classList.add('armed');
    setTimeout(() => pad.el.classList.replace('armed', 'live'), Math.max(0, (at - engine.ctx.currentTime) * 1000));
    src.onended = () => { if (pad.src === src) { pad.el.classList.remove('live', 'armed'); pad.src = null; } };
  }

  function show(pad) {
    const s = pad.list[pad.choice % pad.list.length];
    pad.name.textContent = s ? s.name : 'none yet';
    pad.el.disabled = !s;
    pad.el.title = s ? `${s.name} (${s.source === 'freesound' ? `Freesound, CC0, by ${s.author}` : 'generated'})` : '';
  }

  /** Build the pads in `root`. opts: { engine, onAir: () => ({ deck, track }) or null, level: range input (dB) } */
  async function init(root, opts) {
    engine = opts.engine;
    onAir = opts.onAir;
    const sounds = await SfxLibrary.init(engine.ctx);
    const choice = saved();
    PADS.forEach(([cats, label], i) => {
      const wrap = document.createElement('div');
      wrap.className = 'sfx-pad-wrap';
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'sfx-pad';
      const kind = document.createElement('span');
      kind.className = 'sfx-kind';
      kind.textContent = label;
      const name = document.createElement('span');
      name.className = 'sfx-name';
      el.append(kind, name);
      const next = document.createElement('button');
      next.type = 'button';
      next.className = 'sfx-next';
      next.textContent = '›';
      next.setAttribute('aria-label', `Next ${label.toLowerCase()} sound`);
      wrap.append(el, next);
      root.append(wrap);
      const pad = { el, name, list: SfxLibrary.of(cats), choice: choice[i] || 0, src: null };
      pads.push(pad);
      show(pad);
      el.addEventListener('click', () => fire(i));
      next.addEventListener('click', () => {
        pad.choice = (pad.choice + 1) % Math.max(1, pad.list.length);
        show(pad);
        remember();
        if (pad.list.length) SfxLibrary.load(pad.list[pad.choice].id);
      });
    });
    if (opts.level) {
      const apply = () => engine.sfxBus.gain.setTargetAtTime(Math.pow(10, parseFloat(opts.level.value) / 20) * SFX_BUS,
                                                             engine.ctx.currentTime, 0.02);
      opts.level.addEventListener('input', apply);
      apply();
    }
    if (!sounds.length) root.classList.add('empty');
    return pads.length;
  }

  return { init, fire, placement };
})();

window.SfxLibrary = SfxLibrary;
window.SfxPads = SfxPads;
