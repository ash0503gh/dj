/**
 * controller.js - A hardware DJ controller over Web MIDI (Chrome and Edge on a computer; not Safari):
 * the Numark Mixtrack Platinum. Its buttons, knobs, faders and jog wheels play the console the way the
 * screen's own controls do (it presses the same buttons and moves the same sliders), and its lights,
 * level meter and jog-wheel screens show the decks. A knob or fader picks up where the screen is: it does
 * nothing until it reaches the on-screen value (no jumps), and one moved during an Auto mix takes over.
 *
 * MIDI layout from the controller's published mapping (Mixxx's): decks 1-4 on channels 1-4 (3 and 4,
 * its layer buttons, play decks A and B here), pads on 5-8, the FX units on 9-10, and browse, shift,
 * crossfader, master and headphones on 16. Its sound card has four outputs: master on 1-2, headphones
 * on 3-4 (DJAudioEngine.routeOutputs).
 */
const DJController = (() => {
  const DECK = { play: 0x00, cue: 0x01, sync: 0x02, shiftSync: 0x03, shiftPlay: 0x04, shiftCue: 0x05,
                 jogTouch: 0x06, bendUp: 0x0B, bendDown: 0x0C, load: 0x10, pfl: 0x1B };
  const KNOB = { jog: 0x06, pitchMsb: 0x09, pitchLsb: 0x77, gain: 0x16, hi: 0x17, mid: 0x18, low: 0x19,
                 filter: 0x1A, volume: 0x1C, ring: 0x3F };
  const HOTCUE_PADS = [0x18, 0x19, 0x1A, 0x1B];
  const FX_BUTTONS = [0x00, 0x01, 0x02];      // echo, flanger, loop roll
  const FX_DRYWET = 0x03;
  const MAIN = { channel: 0x0F, browse: 0x00, browsePush: 0x1F, shift: 0x32, crossfader: 0x08, master: 0x0A,
                 headGain: 0x0C, headMix: 0x0D, vuLeft: 0x44, vuRight: 0x45 };
  const HELLO = [0xF0, 0x00, 0x01, 0x3F, 0x7F, 0x3A, 0x60, 0x00, 0x04, 0x04, 0x01, 0x00, 0x00, 0xF7];  // ends its demo lights
  const BYE = [0xF0, 0x00, 0x20, 0x7F, 0x02, 0xF7];
  const ON = 0x7F, DIM = 0x01, OFF = 0x00;
  const TICK_SEC = 1.8 / 1240;   // a jog tick: 1240 to a turn, a turn at 33 1/3 rpm is 1.8 s of the record
  const NUDGE_PER_TICK = 0.004;  // playing: each tick speeds the deck up (or down) 0.4% while the wheel turns
  const BEND = 0.04;             // pitch bend buttons: 4% while held
  const PICKUP = 0.03;           // a knob takes over within 3% of the screen's value, or when it passes it
  const TEMPO_RANGE = 16;        // the screen's tempo faders: ±16%
  const TRIM_RANGE = 12;         // gain knob: ±12 dB
  const isMixtrack = port => /mixtrack\s*platinum/i.test(port.name || '');

  let bridge = null;       // what the console lends it (app.js)
  let access = null;
  let input = null;
  let output = null;
  let sysex = false;
  let shift = false;
  let refreshTimer = null;
  const sent = new Map();                 // last value sent to each light and screen: only changes go out
  const pickups = {};                     // per knob and fader: taken over yet?
  const pitchHalves = { 1: [64, 0], 2: [64, 0] };
  const nudges = {};
  const bends = {};
  const fxWet = { 1: 0.5, 2: 0.5 };
  let lastScrub = 0;
  const ui = {};                          // the controller panel's elements

  // ── Output: lights, screens, level meter ──

  function send(bytes) {
    if (!output) return;
    try { output.send(bytes); } catch (e) { /* unplugged */ }
  }

  /** A light or a meter (note-on or control change), sent only when it changes. */
  function light(status, data1, value) {
    const k = `${status}:${data1}`;
    if (sent.get(k) === value) return;
    sent.set(k, value);
    send([status, data1, value]);
  }

  /** The jog screens take numbers as eight nibbles, the first one a sign (8: positive). */
  function nibbles(n) {
    const a = [];
    for (let s = 28; s >= 0; s -= 4) a.push((n >> s) & 0x0F);
    a[0] = n < 0 ? 0x07 : 0x08;
    return a;
  }

  function screen(deckNum, field, digits) {
    const k = `screen:${deckNum}:${field}`;
    const v = digits.join(',');
    if (sent.get(k) === v) return;
    sent.set(k, v);
    send([0xF0, 0x00, 0x20, 0x7F, deckNum, field].concat(digits, [0xF7]));
  }

  function refresh() {
    if (!output || !bridge) return;
    for (const n of [1, 2]) {
      const deck = bridge.deck(n);
      const loaded = !!(bridge.track(n) && deck.audio.buffer);
      const ch = n - 1;
      const playing = !!deck.isPlaying;
      [DECK.play, DECK.shiftPlay].forEach(x => light(0x90 | ch, x, playing ? ON : DIM));
      [DECK.cue, DECK.shiftCue].forEach(x => light(0x90 | ch, x, loaded && !playing ? ON : DIM));
      [DECK.sync, DECK.shiftSync].forEach(x => light(0x90 | ch, x, bridge.synced(n) ? ON : DIM));
      light(0x90 | ch, DECK.pfl, deck.isCueActive ? ON : DIM);
      HOTCUE_PADS.forEach(x => light(0x94 | ch, x, loaded ? ON : OFF));
      light(0x98 | ch, FX_BUTTONS[0], deck._echoEngaged ? ON : DIM);
      light(0x98 | ch, FX_BUTTONS[1], deck._flangerEngaged ? ON : DIM);
      light(0x98 | ch, FX_BUTTONS[2], DIM);
      if (!loaded) continue;
      // Jog screen: position ring (0-52), spinner (64-115: a turn of the record every 1.8 s), BPM, time
      const dur = deck.audio.duration || 0;
      const pos = Math.max(0, deck.audio.currentTime || 0);
      light(0xB0 | ch, KNOB.ring, dur ? Math.min(52, Math.round((pos / dur) * 52)) : 0);
      light(0xB0 | ch, KNOB.jog, 64 + Math.round(((pos % 1.8) / 1.8) * 51));
      if (sysex) {
        screen(n, 0x01, nibbles(Math.round((bridge.bpm(n) || 0) * 100)).slice(2));
        screen(n, 0x03, nibbles(Math.max(0, Math.round(dur * 1000) - 1)));
        screen(n, 0x04, nibbles(Math.round(pos * 10) * 100));    // tenths: fewer messages
      }
    }
    const level = Math.round(bridge.engine.getMasterLevel() * 80);
    light(0xB0 | MAIN.channel, MAIN.vuLeft, level);
    light(0xB0 | MAIN.channel, MAIN.vuRight, level);
  }

  // ── Input ──

  function click(id) {
    const el = document.getElementById(id);
    if (el) el.click();
  }

  function setRange(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function rangeValue(id) {
    const el = document.getElementById(id);
    return el ? parseFloat(el.value) : 0;
  }

  function touched(what) {
    if (ui.last) ui.last.textContent = what;
  }

  /** A knob or fader at `v` (0-1) moves `name` only once it has reached where the screen is (`now`, 0-1)
   *  or passed it: no jumps. `mixer`: moving it during an Auto mix takes over from the mix. */
  function pickUp(key, name, v, now, apply, mixer = true) {
    const p = pickups[key] || (pickups[key] = { held: false, last: null, set: null });
    if (p.held && p.set !== null && Math.abs(now - p.set) > PICKUP) p.held = false;   // the screen moved it since
    if (!p.held && (Math.abs(v - now) <= PICKUP || (p.last !== null && (p.last - now) * (v - now) <= 0))) p.held = true;
    p.last = v;
    if (!p.held) {
      touched(`${name}: turn it to ${Math.round(now * 100)}% to pick up`);
      return;
    }
    if (mixer && bridge.mixing()) bridge.takeOver();
    p.set = v;
    apply(v);
    touched(`${name} · ${Math.round(v * 100)}%`);
  }

  // Knob positions (0-1, centre 0.5) and the screen's values
  const eqDb = k => (k < 0.5 ? -24 + (k / 0.5) * 24 : ((k - 0.5) / 0.5) * 6);
  const eqKnob = db => (db <= 0 ? 0.5 * (db + 24) / 24 : 0.5 + 0.5 * (db / 6));

  function deckMessage(n, type, d1, d2, on) {
    const id = x => `d${n}-${x}`;
    const name = n === 1 ? 'DECK A' : 'DECK B';
    if (type === 0xB0) {
      const k = d2 / 127;
      if (d1 === KNOB.jog) return jog(n, d2 < 64 ? d2 : d2 - 128);
      if (d1 === KNOB.pitchMsb || d1 === KNOB.pitchLsb) {
        pitchHalves[n][d1 === KNOB.pitchMsb ? 0 : 1] = d2;
        const v = ((pitchHalves[n][0] << 7) | pitchHalves[n][1]) / 16383;
        // Towards the player is faster, as on the screen
        return pickUp(`tempo${n}`, `${name} TEMPO`, v, 0.5 - rangeValue(id('tempo-fader')) / (2 * TEMPO_RANGE),
                      x => setRange(id('tempo-fader'), ((0.5 - x) * 2 * TEMPO_RANGE).toFixed(1)));
      }
      const eq = { [KNOB.hi]: 'hi', [KNOB.mid]: 'mid', [KNOB.low]: 'low' }[d1];
      if (eq) {
        return pickUp(`${eq}${n}`, `${name} ${eq.toUpperCase()} EQ`, k, eqKnob(rangeValue(id(`eq-${eq}`))),
                      x => setRange(id(`eq-${eq}`), eqDb(x).toFixed(1)));
      }
      if (d1 === KNOB.filter) {
        return pickUp(`filter${n}`, `${name} FILTER`, k, (rangeValue(id('filter')) + 50) / 100,
                      x => setRange(id('filter'), Math.round(x * 100 - 50)));
      }
      if (d1 === KNOB.volume) {
        return pickUp(`volume${n}`, `${name} FADER`, k, rangeValue(id('vol-fader')) / 100,
                      x => setRange(id('vol-fader'), Math.round(x * 100)));
      }
      if (d1 === KNOB.gain) {
        return pickUp(`gain${n}`, `${name} GAIN`, k, 0.5 + bridge.trim(n) / (2 * TRIM_RANGE),
                      x => bridge.setTrim(n, (x - 0.5) * 2 * TRIM_RANGE));
      }
      return;
    }
    if (d1 === DECK.bendUp || d1 === DECK.bendDown) return bend(n, d1 === DECK.bendUp ? 1 : -1, on);
    if (!on) return;
    bridge.unlock();
    if (d1 === DECK.play || d1 === DECK.shiftPlay) { click(id('btn-play')); touched(`${name} PLAY`); }
    else if (d1 === DECK.cue || d1 === DECK.shiftCue) { click(id('btn-cue')); touched(`${name} CUE`); }
    else if (d1 === DECK.sync || d1 === DECK.shiftSync) { click(id('btn-sync')); touched(`${name} SYNC`); }
    else if (d1 === DECK.pfl) { click(id('btn-pfl')); touched(`${name} HEADPHONE CUE`); }
    else if (d1 === DECK.load) load(n);
  }

  /** Playing: the wheel nudges the deck (faster or slower while it turns). Paused: it moves through the
   *  track, heard as short snippets; with shift, a fast search either way. */
  function jog(n, ticks) {
    const deck = bridge.deck(n);
    const a = deck.audio;
    if (!a.buffer || !ticks) return;
    if (deck.isPlaying && !shift) {
      const nd = nudges[n] || (nudges[n] = { base: a.playbackRate, timer: null });
      clearTimeout(nd.timer);
      a.playbackRate = nd.base * (1 + Math.max(-0.1, Math.min(0.1, ticks * NUDGE_PER_TICK)));
      nd.timer = setTimeout(() => { a.playbackRate = nd.base; delete nudges[n]; }, 60);
      touched(`${n === 1 ? 'DECK A' : 'DECK B'} JOG · nudge`);
      return;
    }
    a.currentTime = Math.max(0, a.currentTime + ticks * TICK_SEC * (shift ? 20 : 1));
    const now = performance.now();
    if (!deck.isPlaying && now - lastScrub > 45) {
      lastScrub = now;
      a.playSlice(bridge.engine.ctx.currentTime, a.currentTime, 0.05);
    }
    touched(`${n === 1 ? 'DECK A' : 'DECK B'} JOG · ${shift ? 'search' : 'scrub'} ${a.currentTime.toFixed(1)} s`);
  }

  function bend(n, dir, on) {
    const a = bridge.deck(n).audio;
    if (on && bends[n] === undefined) {
      bends[n] = a.playbackRate;
      a.playbackRate = bends[n] * (1 + dir * BEND);
      touched(`${n === 1 ? 'DECK A' : 'DECK B'} PITCH BEND ${dir > 0 ? '+' : '−'}`);
    } else if (!on && bends[n] !== undefined) {
      a.playbackRate = bends[n];
      delete bends[n];
    }
  }

  /** LOAD: the track the browse knob is on, or (none) this deck's list, to browse. */
  function load(n) {
    const fileId = bridge.browsed();
    if (fileId) {
      bridge.load(n, fileId);
      touched(`LOAD ${n === 1 ? 'A' : 'B'}`);
    } else {
      bridge.browse(0, n);
      touched('Turn the browse knob to pick a track');
    }
  }

  function padMessage(n, d1, on) {
    const i = HOTCUE_PADS.indexOf(d1);
    if (!on || i < 0) return;
    bridge.unlock();
    click(`d${n}-cue-${i + 1}`);
    touched(`${n === 1 ? 'DECK A' : 'DECK B'} PAD ${i + 1}`);
  }

  /** FX 1 echo, FX 2 flanger (on/off), FX 3 a one-bar loop roll; the knob sets how much is heard. */
  function fxMessage(n, type, d1, d2, on) {
    const deck = bridge.deck(n);
    const bpm = bridge.bpm(n) || 128;
    const name = n === 1 ? 'FX A' : 'FX B';
    if (type === 0xB0 && d1 === FX_DRYWET) {
      fxWet[n] = d2 / 127;
      const now = bridge.engine.ctx.currentTime;
      if (deck._echoEngaged) deck.delayWetGain.gain.setTargetAtTime(0.6 * fxWet[n], now, 0.05);
      if (deck._flangerEngaged) deck.flangerWetGain.gain.setTargetAtTime(0.8 * fxWet[n], now, 0.05);
      touched(`${name} AMOUNT · ${Math.round(fxWet[n] * 100)}%`);
      return;
    }
    if (!on) return;
    bridge.unlock();
    if (d1 === FX_BUTTONS[0]) {
      if (deck._echoEngaged) deck.disengageSubtleEcho(1.0); else deck.engageSubtleEcho(bpm, 0.6 * fxWet[n]);
      touched(`${name} ECHO ${deck._echoEngaged ? 'ON' : 'OFF'}`);
    } else if (d1 === FX_BUTTONS[1]) {
      if (deck._flangerEngaged) deck.disengageFlanger(0.5); else deck.engageFlanger('medium', 0.6, 0.5, 0.8 * fxWet[n]);
      touched(`${name} FLANGER ${deck._flangerEngaged ? 'ON' : 'OFF'}`);
    } else if (d1 === FX_BUTTONS[2]) {
      deck.triggerLoopRoll(bpm, 1);
      touched(`${name} LOOP ROLL`);
    }
  }

  function mainMessage(type, d1, d2, on, off) {
    if (type === 0xB0) {
      const k = d2 / 127;
      if (d1 === MAIN.browse) {
        bridge.browse(d2 === 127 ? -1 : d2 === 1 ? 1 : (d2 < 64 ? d2 : d2 - 128));
        touched('BROWSE');
      } else if (d1 === MAIN.crossfader) {
        pickUp('crossfader', 'CROSSFADER', k, rangeValue('crossfader') / 100, x => setRange('crossfader', Math.round(x * 100)));
      } else if (d1 === MAIN.master) {
        bridge.engine.setMasterVolume(k * k);      // only the knob sets it: nothing on screen to pick up from
        touched(`MASTER · ${Math.round(k * 100)}%`);
      } else if (d1 === MAIN.headGain) {
        bridge.engine.setHeadVolume(k);
        touched(`HEADPHONES · ${Math.round(k * 100)}%`);
      } else if (d1 === MAIN.headMix) {
        bridge.engine.setHeadMix(k);
        touched(`CUE MIX · ${Math.round(k * 100)}% master`);
      }
      return;
    }
    if (d1 === MAIN.shift) { shift = on; return; }
    if (d1 === MAIN.browsePush && on) {
      bridge.unlock();
      if (shift) { bridge.abort(); touched('ABORT'); } else { bridge.mix(); touched('AUTO MIX'); }
    }
  }

  /** One MIDI message from the controller. */
  function handle(status, d1, d2 = 0) {
    if (!bridge) return;
    const type = status & 0xF0;
    const ch = status & 0x0F;
    if (type !== 0x90 && type !== 0x80 && type !== 0xB0) return;
    const on = type === 0x90 && d2 > 0;
    const off = type === 0x80 || (type === 0x90 && d2 === 0);
    if (ch <= 3) deckMessage((ch % 2) + 1, type, d1, d2, on);
    else if (ch <= 7) padMessage(((ch - 4) % 2) + 1, d1, on);
    else if (ch === 8 || ch === 9) fxMessage(ch - 7, type, d1, d2, on);
    else if (ch === MAIN.channel) mainMessage(type, d1, d2, on, off);
  }

  // ── Connection ──

  function attach() {
    const ins = access ? [...access.inputs.values()].filter(p => p.state === 'connected' && isMixtrack(p)) : [];
    const outs = access ? [...access.outputs.values()].filter(p => p.state === 'connected' && isMixtrack(p)) : [];
    const nextIn = ins[0] || null;
    if (input && input !== nextIn) input.onmidimessage = null;
    input = nextIn;
    output = outs[0] || null;
    if (input) input.onmidimessage = e => handle(e.data[0], e.data[1], e.data[2]);
    if (output) {
      sent.clear();
      if (sysex) send(HELLO);
      refresh();
    }
    if (!refreshTimer) refreshTimer = setInterval(refresh, 50);
    render();
  }

  /** Ask for the controller (Web MIDI; sysex for its screens), and keep it on reloads. */
  async function connect() {
    if (!navigator.requestMIDIAccess) {
      render('This browser can\'t use MIDI controllers: use Chrome or Edge on a computer.');
      return;
    }
    try {
      access = await navigator.requestMIDIAccess({ sysex: true });
      sysex = true;
    } catch (e) {
      try { access = await navigator.requestMIDIAccess(); sysex = false; } catch (e2) {
        render('MIDI access was not allowed: allow it in the address bar and try again.');
        return;
      }
    }
    try { localStorage.setItem('pp_controller', 'on'); } catch (e) { /* storage blocked */ }
    access.onstatechange = attach;
    attach();
  }

  function goodbye() {
    if (!output) return;
    for (const ch of [0, 1]) {
      [DECK.play, DECK.cue, DECK.sync, DECK.pfl].forEach(x => send([0x90 | ch, x, DIM]));
      HOTCUE_PADS.forEach(x => send([0x94 | ch, x, OFF]));
    }
    if (sysex) send(BYE);
  }

  // ── The controller panel: status, sound output, the last control touched (a test), the map ──

  function render(message = null) {
    if (ui.chip) ui.chip.classList.toggle('on', !!input);
    if (!ui.status) return;
    ui.status.textContent = message || (input ? `${input.name}: connected${sysex ? '' : ' (no jog screens: MIDI sysex not allowed)'}`
      : access ? 'No Mixtrack Platinum found: plug it in by USB.' : 'Not connected.');
    ui.connect.hidden = !!access;
    renderOutput();
  }

  function renderOutput() {
    if (!ui.outputNote || !bridge) return;
    ui.outputNote.textContent = bridge.engine.headphonesOwnOutputs
      ? 'Headphones on the controller\'s outputs 3-4, master on 1-2.'
      : 'Headphone cue plays with the master: choose the controller as sound output for its headphones.';
  }

  async function listOutputs() {
    if (!ui.output || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput');
    const labelled = devices.some(d => d.label);
    ui.output.replaceChildren(...[{ deviceId: '', label: 'System default' }].concat(devices.filter(d => d.deviceId !== 'default'))
      .map((d, i) => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || `Output ${i}`; return o; }));
    ui.devices.hidden = labelled;
    const mixtrack = devices.find(d => /mixtrack/i.test(d.label));
    if (mixtrack && !ui.output.dataset.chosen) {
      ui.output.value = mixtrack.deviceId;
      await chooseOutput(mixtrack.deviceId);
    }
  }

  async function chooseOutput(deviceId) {
    ui.output.dataset.chosen = '1';
    try {
      await bridge.engine.setOutputDevice(deviceId);
    } catch (e) {
      ui.outputNote.textContent = `Couldn't switch the sound output: ${e.message}`;
      return;
    }
    renderOutput();
  }

  function setUpPanel() {
    ['chip', 'modal', 'close', 'status', 'connect', 'output', 'outputNote', 'devices', 'last'].forEach(k => {
      ui[k] = document.getElementById({ chip: 'btn-controller', modal: 'controller-modal', close: 'btn-close-controller',
        status: 'ctl-status', connect: 'ctl-connect', output: 'ctl-output', outputNote: 'ctl-output-note',
        devices: 'ctl-devices', last: 'ctl-last' }[k]);
    });
    if (!ui.chip || !ui.modal) return;
    ui.chip.addEventListener('click', () => { ui.modal.classList.remove('hidden'); render(); listOutputs(); });
    ui.close.addEventListener('click', () => ui.modal.classList.add('hidden'));
    ui.modal.addEventListener('click', e => { if (e.target === ui.modal) ui.modal.classList.add('hidden'); });
    ui.connect.addEventListener('click', () => { bridge.unlock(); connect(); });
    ui.output.addEventListener('change', () => chooseOutput(ui.output.value));
    ui.devices.addEventListener('click', async () => {
      // Chrome names sound cards only once the page may use a microphone: asked once, closed at once
      try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach(t => t.stop()); } catch (e) { /* declined */ }
      listOutputs();
    });
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', () => { if (!ui.modal.classList.contains('hidden')) listOutputs(); });
    }
    render();
  }

  /**
   * bridge: { engine, deck(n), track(n), bpm(n), synced(n), mixing(), mix(), abort(), takeOver(), trim(n),
   *   setTrim(n, db), browse(delta, deckNum?), browsed(), load(n, fileId), unlock() }
   */
  function init(b) {
    bridge = b;
    setUpPanel();
    window.addEventListener('pagehide', goodbye);
    // Back on a reload once it was connected (no prompt: the permission is kept)
    let wanted = false;
    try { wanted = localStorage.getItem('pp_controller') === 'on'; } catch (e) { /* storage blocked */ }
    if (wanted && navigator.permissions && navigator.requestMIDIAccess) {
      navigator.permissions.query({ name: 'midi', sysex: true })
        .then(p => { if (p.state === 'granted') connect(); })
        .catch(() => {});
    }
  }

  // Tests drive it without a device: handle() plays a message, setOutput() takes one that records
  return { init, connect, handle, refresh, setOutput: (o, withSysex = true) => { output = o; sysex = withSysex; sent.clear(); } };
})();

window.DJController = DJController;
