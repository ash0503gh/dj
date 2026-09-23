/**
 * audio_engine.js - Web Audio API High-Performance DJ Mixer Graph
 * Powers real-time interactive decks, 3-band EQs, Color FX sweeps, VU meters, and crossfader.
 */

/**
 * BufferTransport - sample-accurate deck transport on the AudioContext clock.
 *
 * Drop-in for the HTMLAudioElement the decks used before (currentTime, duration,
 * playbackRate, play/pause, events), but:
 *  - start/stop are scheduled with AudioBufferSourceNode.start(when, offset), so two decks
 *    started from the same clock stay locked with no PLL;
 *  - positions are computed from ctx.currentTime (no coarse/jittery element clock);
 *  - it can play a keylocked (server time-stretched) copy of the track: `tempoRatio` = how
 *    many times faster than native it runs. `currentTime` is always NATIVE track time, so
 *    beat grids and waveforms stay valid whatever buffer is playing.
 *  - playbackRate is vinyl-style (pitch follows), used for manual tempo moves and FX.
 */
class BufferTransport {
  constructor(ctx, output) {
    this.ctx = ctx;
    this.output = output;
    this.nativeBuffer = null;
    this.buffer = null;
    this.tempoRatio = 1.0;
    this.src = '';
    this.seeking = false;
    this.error = null;
    this._rate = 1.0;
    this._node = null;       // { src, gain }
    this._paused = true;
    this._pos = 0;           // native seconds at _t0 (or while paused)
    this._t0 = 0;            // ctx time the current node starts playing
    this._listeners = {};
    this._loadToken = 0;
    this.loaded = Promise.resolve(null);
  }

  addEventListener(type, fn, opts) {
    (this._listeners[type] = this._listeners[type] || []).push({ fn, once: !!(opts && opts.once) });
  }

  removeEventListener(type, fn) {
    this._listeners[type] = (this._listeners[type] || []).filter(l => l.fn !== fn);
  }

  _emit(type) {
    const ls = this._listeners[type] || [];
    this._listeners[type] = ls.filter(l => !l.once);
    ls.forEach(l => { try { l.fn({ type, target: this }); } catch (e) { console.error(e); } });
  }

  /** Fetch + decode a track. Resolves with the AudioBuffer (also emitted as 'loadedmetadata'). */
  load(url) {
    const token = ++this._loadToken;
    this._stopNode(this.ctx.currentTime);
    this._paused = true;
    this._pos = 0;
    this.src = url;
    this.nativeBuffer = this.buffer = null;
    this.tempoRatio = 1.0;
    this.loaded = fetch(url)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
      .then(ab => this.ctx.decodeAudioData(ab))
      .then(buf => {
        if (token !== this._loadToken) return null;
        this.nativeBuffer = this.buffer = buf;
        this._emit('loadedmetadata');
        return buf;
      })
      .catch(err => {
        if (token === this._loadToken) { this.error = err; this._emit('error'); }
        return null;
      });
    return this.loaded;
  }

  get duration() { return this.nativeBuffer ? this.nativeBuffer.duration : NaN; }
  get paused() { return this._paused; }

  /** Native track time at ctx time `t` (for a running deck, extrapolated at the current rate). */
  timeAt(t) {
    if (this._paused) return this._pos;
    const dt = Math.max(0, t - this._t0);
    return Math.min(this.duration || Infinity, this._pos + dt * this._rate * this.tempoRatio);
  }

  /** ctx time at which the deck will reach native time `native` (running decks only). */
  ctxTimeAt(native) {
    return this._t0 + (native - this._pos) / (this._rate * this.tempoRatio);
  }

  get currentTime() { return this.timeAt(this.ctx.currentTime); }
  set currentTime(t) { this.seek(t); }

  get playbackRate() { return this._rate; }
  set playbackRate(r) {
    r = Math.max(0.01, Math.min(4.0, r));
    const now = this.ctx.currentTime;
    if (!this._paused && now >= this._t0) {
      this._pos = this.timeAt(now);
      this._t0 = now;
    }
    this._rate = r;
    if (this._node) this._node.src.playbackRate.setValueAtTime(r, Math.max(now, this._t0));
  }

  _startNode(when, native) {
    if (!this.buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this._rate;
    const gain = this.ctx.createGain();
    src.connect(gain).connect(this.output);
    // 3 ms declick ramp (only noticeable on seeks, never on a kick)
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(1, when + 0.003);
    const offset = Math.max(0, native / this.tempoRatio);
    const node = { src, gain };
    src.onended = () => {
      if (this._node === node) {
        this._node = null;
        this._pos = this.duration || this._pos;
        this._paused = true;
        this._emit('pause');
        this._emit('ended');
      }
    };
    if (offset < this.buffer.duration) src.start(when, offset);
    this._node = node;
  }

  _stopNode(when) {
    const node = this._node;
    this._node = null;
    if (!node) return;
    try {
      node.gain.gain.cancelScheduledValues(when);
      node.gain.gain.setValueAtTime(node.gain.gain.value, when);
      node.gain.gain.linearRampToValueAtTime(0, when + 0.004);
      node.src.stop(when + 0.005);
    } catch (e) { /* never started */ }
  }

  /** Start playing at ctx time `when` (default: now) from the current position, or from `native`. */
  play(when = null, native = null) {
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (!this.buffer) return Promise.reject(new Error('No track loaded in deck'));
    const now = this.ctx.currentTime;
    const t = Math.max(now, when === null ? now : when);
    const pos = native === null ? this.timeAt(t) : native;
    this._stopNode(t);
    this._pos = pos;
    this._t0 = t;
    this._paused = false;
    this._startNode(t, pos);
    this._emit('play');
    return Promise.resolve();
  }

  pause() {
    const t = this.ctx.currentTime;
    if (this._paused) return;
    this._pos = this.timeAt(t);
    this._paused = true;
    this._stopNode(t);
    this._emit('pause');
  }

  seek(native) {
    native = Math.max(0, Math.min(native, (this.duration || Infinity) - 0.01));
    if (this._paused) { this._pos = native; return; }
    this.play(null, native);
  }

  /**
   * Switch to another rendering of the same track (e.g. a keylocked stretch) at ctx time
   * `when` without a jump in native position. tempoRatio = how much faster than native it runs.
   */
  useBuffer(buffer, tempoRatio, when = null) {
    const t = Math.max(this.ctx.currentTime + 0.02, when === null ? 0 : when);
    if (this._paused) {
      this.buffer = buffer;
      this.tempoRatio = tempoRatio;
      return;
    }
    const pos = this.timeAt(t);
    this._stopNode(t);
    this.buffer = buffer;
    this.tempoRatio = tempoRatio;
    this._pos = pos;
    this._t0 = t;
    this._startNode(t, pos);
  }

  /** Play [native, native+lenSec) of the current buffer once at ctx time `when` (loop/stutter FX). */
  playSlice(when, native, lenSec) {
    if (!this.buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this._rate;
    const g = this.ctx.createGain();
    src.connect(g).connect(this.output);
    const len = lenSec * this._rate;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(1, when + 0.002);
    g.gain.setValueAtTime(1, when + Math.max(0.003, lenSec - 0.003));
    g.gain.linearRampToValueAtTime(0, when + lenSec);
    src.start(when, native / this.tempoRatio, len);
    return src;
  }

  /** Mute the main (slip) playback between two ctx times, e.g. while a roll plays slices. */
  muteBetween(t0, t1) {
    if (!this._node) return;
    const g = this._node.gain.gain;
    g.setValueAtTime(1, t0);
    g.linearRampToValueAtTime(0, t0 + 0.003);
    g.setValueAtTime(0, t1 - 0.003);
    g.linearRampToValueAtTime(1, t1);
  }

  unmute() {
    if (!this._node) return;
    const g = this._node.gain.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(1, now + 0.003);
  }
}

class DJDeckAudio {
  constructor(ctx, deckNum, destination) {
    this.ctx = ctx;
    this.deckNum = deckNum;
    this.destination = destination;

    this.source = this.ctx.createGain();
    this.audio = new BufferTransport(this.ctx, this.source);

    this.audio.addEventListener('play', () => { this.isPlaying = true; });
    this.audio.addEventListener('pause', () => { this.isPlaying = false; });
    this.audio.addEventListener('ended', () => { this.isPlaying = false; });
    this.audio.addEventListener('error', () => {
      console.warn(`Deck ${this.deckNum} audio load error:`, this.audio.error);
      this.isPlaying = false;
    });

    // Isolator-style bass kill for the bass swap: two cascaded high-passes parked at 10 Hz
    // (inaudible); moved to 220 Hz they remove kick + bassline (-45 dB at 60 Hz), which a
    // -24 dB low-shelf EQ cannot.
    this.lowCut1 = this.ctx.createBiquadFilter();
    this.lowCut1.type = 'highpass';
    this.lowCut1.frequency.value = 10;
    this.lowCut1.Q.value = 0.707;
    this.lowCut2 = this.ctx.createBiquadFilter();
    this.lowCut2.type = 'highpass';
    this.lowCut2.frequency.value = 10;
    this.lowCut2.Q.value = 0.707;

    // 3-Band Equalizer Nodes
    this.eqLow = this.ctx.createBiquadFilter();
    this.eqLow.type = 'lowshelf';
    this.eqLow.frequency.value = 250;
    this.eqLow.gain.value = 0;

    this.eqMid = this.ctx.createBiquadFilter();
    this.eqMid.type = 'peaking';
    this.eqMid.frequency.value = 1000;
    this.eqMid.Q.value = 0.7;
    this.eqMid.gain.value = 0;

    this.eqHigh = this.ctx.createBiquadFilter();
    this.eqHigh.type = 'highshelf';
    this.eqHigh.frequency.value = 2500;
    this.eqHigh.gain.value = 0;

    // Color FX / Filter (HPF / LPF)
    this.filterLPF = this.ctx.createBiquadFilter();
    this.filterLPF.type = 'lowpass';
    this.filterLPF.frequency.value = 20000;

    this.filterHPF = this.ctx.createBiquadFilter();
    this.filterHPF.type = 'highpass';
    this.filterHPF.frequency.value = 20;

    // Channel Gain Fader
    this.faderGain = this.ctx.createGain();
    this.faderGain.gain.value = 1.0;

    // Echo / Delay Freeze FX loop (Pioneer DJM-900NXS2 Echo Emulation)
    this.echoSend = this.ctx.createGain();
    this.echoSend.gain.value = 1.0;

    this.delayInputGate = this.ctx.createGain();
    this.delayInputGate.gain.value = 1.0;

    this.delayNode = this.ctx.createDelay(3.0);
    this.delayNode.delayTime.value = 0.375; // 3/4 beat default

    this.delayFeedback = this.ctx.createGain();
    this.delayFeedback.gain.value = 0.0;

    this.delayFilter = this.ctx.createBiquadFilter();
    this.delayFilter.type = 'bandpass';
    this.delayFilter.frequency.value = 1600;
    this.delayFilter.Q.value = 0.8;

    this.delayWetGain = this.ctx.createGain();
    this.delayWetGain.gain.value = 0.0;

    // Resonant LFO Flanger FX
    this.flangerDelay = this.ctx.createDelay(0.02);
    this.flangerDelay.delayTime.value = 0.003;
    this.flangerFeedback = this.ctx.createGain();
    this.flangerFeedback.gain.value = 0.0;
    this.flangerLFO = this.ctx.createOscillator();
    this.flangerLFO.type = 'sine';
    this.flangerLFO.frequency.value = 0.35;
    this.flangerLFOGain = this.ctx.createGain();
    this.flangerLFOGain.gain.value = 0.002;
    this.flangerLFO.connect(this.flangerLFOGain);
    this.flangerLFOGain.connect(this.flangerDelay.delayTime);
    try { this.flangerLFO.start(); } catch (e) {}
    this.flangerWetGain = this.ctx.createGain();
    this.flangerWetGain.gain.value = 0.0;

    // Crossfader contribution gain: initialized to 1.0 (50% center club curve)
    this.cfGain = this.ctx.createGain();
    this.cfGain.gain.value = 1.0;

    // Analyser for VU Meter
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 64;

    // Real-Time Neural/Spectral 4-Band Parallel Stem Crossover Isolator Network
    this.stems = {
      vocals: true,
      drums: true,
      bass: true,
      other: true
    };

    // 1. Direct Master Pristine Path (Active when all 4 stems are on)
    this.masterDirectGain = this.ctx.createGain();
    this.masterDirectGain.gain.value = 1.0;

    // 2. Parallel Stems Sum Bus (Active when any stem is muted or soloed)
    this.stemsSumGain = this.ctx.createGain();
    this.stemsSumGain.gain.value = 0.0;

    // --- STEM 1: BASS (Cascaded 24dB/oct LPF @ 220Hz + 65Hz Punch) ---
    this.bassLPF1 = this.ctx.createBiquadFilter();
    this.bassLPF1.type = 'lowpass';
    this.bassLPF1.frequency.value = 220;
    this.bassLPF1.Q.value = 0.707;

    this.bassLPF2 = this.ctx.createBiquadFilter();
    this.bassLPF2.type = 'lowpass';
    this.bassLPF2.frequency.value = 220;
    this.bassLPF2.Q.value = 0.707;

    this.bassSubPunch = this.ctx.createBiquadFilter();
    this.bassSubPunch.type = 'peaking';
    this.bassSubPunch.frequency.value = 65;
    this.bassSubPunch.Q.value = 1.0;
    this.bassSubPunch.gain.value = 2.0;

    this.stemGainBass = this.ctx.createGain();
    this.stemGainBass.gain.value = 1.0;

    // --- STEM 2: VOCALS (Cascaded 24dB/oct Bandpass 260Hz - 4.5kHz + Formants) ---
    this.vocalHPF1 = this.ctx.createBiquadFilter();
    this.vocalHPF1.type = 'highpass';
    this.vocalHPF1.frequency.value = 260;
    this.vocalHPF1.Q.value = 0.707;

    this.vocalHPF2 = this.ctx.createBiquadFilter();
    this.vocalHPF2.type = 'highpass';
    this.vocalHPF2.frequency.value = 260;
    this.vocalHPF2.Q.value = 0.707;

    this.vocalLPF1 = this.ctx.createBiquadFilter();
    this.vocalLPF1.type = 'lowpass';
    this.vocalLPF1.frequency.value = 4500;
    this.vocalLPF1.Q.value = 0.707;

    this.vocalLPF2 = this.ctx.createBiquadFilter();
    this.vocalLPF2.type = 'lowpass';
    this.vocalLPF2.frequency.value = 4500;
    this.vocalLPF2.Q.value = 0.707;

    this.vocalKickNotch = this.ctx.createBiquadFilter();
    this.vocalKickNotch.type = 'notch';
    this.vocalKickNotch.frequency.value = 100;
    this.vocalKickNotch.Q.value = 2.0;

    this.vocalFormant1 = this.ctx.createBiquadFilter();
    this.vocalFormant1.type = 'peaking';
    this.vocalFormant1.frequency.value = 950;
    this.vocalFormant1.Q.value = 1.1;
    this.vocalFormant1.gain.value = 3.5;

    this.vocalFormant2 = this.ctx.createBiquadFilter();
    this.vocalFormant2.type = 'peaking';
    this.vocalFormant2.frequency.value = 2800;
    this.vocalFormant2.Q.value = 1.3;
    this.vocalFormant2.gain.value = 4.0;

    this.stemGainVocals = this.ctx.createGain();
    this.stemGainVocals.gain.value = 1.0;

    // --- STEM 3: DRUMS (Kick Transient, Snare Snap, Hi-Hat Sizzle with Vocal Rejection) ---
    this.drumHPF = this.ctx.createBiquadFilter();
    this.drumHPF.type = 'highpass';
    this.drumHPF.frequency.value = 45;
    this.drumHPF.Q.value = 0.707;

    this.drumKickPunch = this.ctx.createBiquadFilter();
    this.drumKickPunch.type = 'peaking';
    this.drumKickPunch.frequency.value = 75;
    this.drumKickPunch.Q.value = 1.4;
    this.drumKickPunch.gain.value = 4.0;

    this.drumSnareCrack = this.ctx.createBiquadFilter();
    this.drumSnareCrack.type = 'peaking';
    this.drumSnareCrack.frequency.value = 2200;
    this.drumSnareCrack.Q.value = 1.2;
    this.drumSnareCrack.gain.value = 3.0;

    this.drumHiHats = this.ctx.createBiquadFilter();
    this.drumHiHats.type = 'highshelf';
    this.drumHiHats.frequency.value = 6500;
    this.drumHiHats.gain.value = 3.5;

    this.drumVocalCut = this.ctx.createBiquadFilter();
    this.drumVocalCut.type = 'peaking';
    this.drumVocalCut.frequency.value = 1100;
    this.drumVocalCut.Q.value = 1.0;
    this.drumVocalCut.gain.value = -18.0;

    this.stemGainDrums = this.ctx.createGain();
    this.stemGainDrums.gain.value = 1.0;

    // --- STEM 4: OTHER (Melodic Synths, Pads, Guitars, Ambient Air) ---
    this.otherHPF = this.ctx.createBiquadFilter();
    this.otherHPF.type = 'highpass';
    this.otherHPF.frequency.value = 300;
    this.otherHPF.Q.value = 0.707;

    this.otherVocalDip = this.ctx.createBiquadFilter();
    this.otherVocalDip.type = 'peaking';
    this.otherVocalDip.frequency.value = 1300;
    this.otherVocalDip.Q.value = 0.9;
    this.otherVocalDip.gain.value = -12.0;

    this.otherAir = this.ctx.createBiquadFilter();
    this.otherAir.type = 'highshelf';
    this.otherAir.frequency.value = 4000;
    this.otherAir.gain.value = 3.5;

    this.stemGainOther = this.ctx.createGain();
    this.stemGainOther.gain.value = 1.0;

    // Connect audio signal chain:
    // Source -> Bass Isolator -> EQLow -> EQMid -> EQHigh
    this.source.connect(this.lowCut1);
    this.lowCut1.connect(this.lowCut2);
    this.lowCut2.connect(this.eqLow);
    this.eqLow.connect(this.eqMid);
    this.eqMid.connect(this.eqHigh);

    // 1. Pristine Direct Bypass Path:
    this.eqHigh.connect(this.masterDirectGain);
    this.masterDirectGain.connect(this.filterLPF);

    // 2. Parallel Stems Path:
    // Bass Branch:
    this.eqHigh.connect(this.bassLPF1);
    this.bassLPF1.connect(this.bassLPF2);
    this.bassLPF2.connect(this.bassSubPunch);
    this.bassSubPunch.connect(this.stemGainBass);
    this.stemGainBass.connect(this.stemsSumGain);

    // Vocal Branch:
    this.eqHigh.connect(this.vocalHPF1);
    this.vocalHPF1.connect(this.vocalHPF2);
    this.vocalHPF2.connect(this.vocalLPF1);
    this.vocalLPF1.connect(this.vocalLPF2);
    this.vocalLPF2.connect(this.vocalKickNotch);
    this.vocalKickNotch.connect(this.vocalFormant1);
    this.vocalFormant1.connect(this.vocalFormant2);
    this.vocalFormant2.connect(this.stemGainVocals);
    this.stemGainVocals.connect(this.stemsSumGain);

    // Drums Branch:
    this.eqHigh.connect(this.drumHPF);
    this.drumHPF.connect(this.drumKickPunch);
    this.drumKickPunch.connect(this.drumSnareCrack);
    this.drumSnareCrack.connect(this.drumHiHats);
    this.drumHiHats.connect(this.drumVocalCut);
    this.drumVocalCut.connect(this.stemGainDrums);
    this.stemGainDrums.connect(this.stemsSumGain);

    // Other Branch:
    this.eqHigh.connect(this.otherHPF);
    this.otherHPF.connect(this.otherVocalDip);
    this.otherVocalDip.connect(this.otherAir);
    this.otherAir.connect(this.stemGainOther);
    this.stemGainOther.connect(this.stemsSumGain);

    // Stems Sum -> Color Filters -> Channel Fader
    this.stemsSumGain.connect(this.filterLPF);
    this.filterLPF.connect(this.filterHPF);
    this.filterHPF.connect(this.faderGain);

    // Pre-Fade Listen (PFL) Headphone Tap (Pre-Fader / Pre-Crossfader)
    this.pflSend = this.ctx.createGain();
    this.pflSend.gain.value = 0.0;
    this.isCueActive = false;
    this.filterHPF.connect(this.pflSend);

    // Dry path: faderGain -> echoSend -> cfGain -> analyser -> destination
    this.faderGain.connect(this.echoSend);
    this.echoSend.connect(this.cfGain);
    this.cfGain.connect(this.analyser);
    this.analyser.connect(this.destination);

    // Wet Echo path: faderGain -> delayInputGate -> delayNode
    // Feedback loop: delayNode -> delayFilter -> delayFeedback -> delayNode
    // Wet output: delayFilter -> delayWetGain -> destination (Bypasses crossfader!)
    this.faderGain.connect(this.delayInputGate);
    this.delayInputGate.connect(this.delayNode);
    this.delayNode.connect(this.delayFilter);
    this.delayFilter.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delayNode);
    this.delayFilter.connect(this.delayWetGain);
    this.delayWetGain.connect(this.destination);

    // Flanger loop & wet routing
    this.faderGain.connect(this.flangerDelay);
    this.flangerDelay.connect(this.flangerFeedback);
    this.flangerFeedback.connect(this.flangerDelay);
    this.flangerDelay.connect(this.flangerWetGain);
    this.flangerWetGain.connect(this.cfGain);

    this.isPlaying = false;
    this.cuePosition = 0;
  }

  triggerEchoFreeze(bpm = 128.0, tailSec = 4.5) {
    const now = this.ctx.currentTime;
    const spb = 60.0 / bpm;
    // Set 3/4 beat delay time
    this.delayNode.delayTime.setValueAtTime(spb * 0.75, now);

    // Immediately open wet output to master bus
    this.delayWetGain.gain.cancelScheduledValues(now);
    this.delayWetGain.gain.setValueAtTime(0.85, now);
    this.delayWetGain.gain.exponentialRampToValueAtTime(0.001, now + tailSec);

    // Engage feedback and smooth exponential decay
    this.delayFeedback.gain.cancelScheduledValues(now);
    this.delayFeedback.gain.setValueAtTime(0.74, now);
    this.delayFeedback.gain.exponentialRampToValueAtTime(0.001, now + tailSec);

    // Close input gate immediately (15ms anti-click) so NO NEW AUDIO enters the delay loop
    this.delayInputGate.gain.cancelScheduledValues(now);
    this.delayInputGate.gain.setValueAtTime(1.0, now);
    this.delayInputGate.gain.linearRampToValueAtTime(0.0, now + 0.015);

    // Mute dry path cleanly (15ms anti-click ramp)
    this.echoSend.gain.cancelScheduledValues(now);
    this.echoSend.gain.setValueAtTime(1.0, now);
    this.echoSend.gain.linearRampToValueAtTime(0.0, now + 0.015);

    // Pause the incoming track after 25ms so vocal track stops immediately
    setTimeout(() => {
      this.pause();
    }, 25);

    // Reset loop after tail decays
    setTimeout(() => {
      const resetNow = this.ctx.currentTime;
      this.delayWetGain.gain.setValueAtTime(0.0, resetNow);
      this.delayFeedback.gain.setValueAtTime(0.0, resetNow);
      this.delayInputGate.gain.setValueAtTime(1.0, resetNow);
      this.echoSend.gain.setValueAtTime(1.0, resetNow);
    }, (tailSec + 0.5) * 1000);
  }

  /** Fetch + decode into the deck. Resolves with the native AudioBuffer (null on failure). */
  loadTrack(url) {
    this.cuePosition = 0;
    this.isPlaying = false;
    this.audioBuffer = null;
    return this.audio.load(url).then(buf => {
      if (buf) this.audioBuffer = buf;
      return buf;
    });
  }

  /** Start now, or sample-accurately at ctx time `when` (optionally from native time `native`). */
  play(when = null, native = null) {
    if (!this.audio.buffer) {
      this.isPlaying = false;
      return Promise.reject(new Error("No track loaded in deck (still decoding?)"));
    }
    return this.audio.play(when, native);
  }

  pause() {
    this.audio.pause();
    this.isPlaying = false;
  }

  setCue() {
    this.pause();
    this.audio.currentTime = this.cuePosition;
  }

  setPlaybackRate(rate) {
    this.audio.playbackRate = Math.max(0.5, Math.min(2.0, rate));
  }

  triggerSpinback(durationSec = 1.2, onComplete = null) {
    const originalRate = this.audio.playbackRate;
    const now = this.ctx.currentTime;
    
    // Ramping filter up to simulate needle drag & vinyl friction
    this.filterHPF.frequency.cancelScheduledValues(now);
    this.filterHPF.frequency.setValueAtTime(20, now);
    this.filterHPF.frequency.exponentialRampToValueAtTime(3200, now + durationSec * 0.85);

    // Fade out volume sharply near the end of the backspin
    this.faderGain.gain.cancelScheduledValues(now);
    this.faderGain.gain.setValueAtTime(1.0, now);
    this.faderGain.gain.setValueAtTime(1.0, now + durationSec * 0.7);
    this.faderGain.gain.linearRampToValueAtTime(0.001, now + durationSec);

    const startTime = performance.now();
    const interval = setInterval(() => {
      const elapsed = (performance.now() - startTime) / 1000;
      if (elapsed >= durationSec) {
        clearInterval(interval);
        this.pause();
        this.faderGain.gain.setValueAtTime(1.0, this.ctx.currentTime);
        this.filterHPF.frequency.setValueAtTime(20, this.ctx.currentTime);
        this.setPlaybackRate(originalRate);
        if (onComplete) onComplete();
      } else {
        const p = elapsed / durationSec;
        const scrubRate = Math.max(0.15, 1.8 * Math.cos(p * Math.PI * 0.5));
        this.setPlaybackRate(scrubRate);
      }
    }, 40);
  }

  duckMids(targetDb = -8.0, durationSec = 0.05) {
    this.eqMid.gain.setTargetAtTime(targetDb, this.ctx.currentTime, durationSec);
  }

  unduckMids(durationSec = 0.3) {
    this.eqMid.gain.setTargetAtTime(0.0, this.ctx.currentTime, durationSec);
  }

  setEQLow(dB) {
    this.eqLow.gain.setTargetAtTime(dB, this.ctx.currentTime, 0.015);
  }

  setEQMid(dB) {
    this.eqMid.gain.setTargetAtTime(dB, this.ctx.currentTime, 0.015);
  }

  setEQHigh(dB) {
    this.eqHigh.gain.setTargetAtTime(dB, this.ctx.currentTime, 0.015);
  }

  setColorFilter(val) {
    // val ranges from -50 (full LPF) to +50 (full HPF), 0 = neutral
    const now = this.ctx.currentTime;
    if (val < 0) {
      // Low-pass filter active
      const norm = Math.abs(val) / 50.0;
      const cutoff = 20000 * Math.pow(0.01, norm); // 20000Hz down to 200Hz
      this.filterLPF.frequency.setTargetAtTime(cutoff, now, 0.02);
      this.filterHPF.frequency.setTargetAtTime(20, now, 0.02);
    } else if (val > 0) {
      // High-pass filter active
      const norm = val / 50.0;
      const cutoff = 20 * Math.pow(150, norm); // 20Hz up to 3000Hz
      this.filterHPF.frequency.setTargetAtTime(cutoff, now, 0.02);
      this.filterLPF.frequency.setTargetAtTime(20000, now, 0.02);
    } else {
      this.filterLPF.frequency.setTargetAtTime(20000, now, 0.02);
      this.filterHPF.frequency.setTargetAtTime(20, now, 0.02);
    }
  }

  // --- Real-Time Neural / Spectral Stem Isolation Engine ---
  setStem(stemName, isActive) {
    if (this.stems.hasOwnProperty(stemName)) {
      this.stems[stemName] = !!isActive;
      this.updateStemFilters();
    }
  }

  toggleStem(stemName) {
    if (this.stems.hasOwnProperty(stemName)) {
      this.stems[stemName] = !this.stems[stemName];
      this.updateStemFilters();
      return this.stems[stemName];
    }
    return true;
  }

  soloStem(stemName) {
    Object.keys(this.stems).forEach(k => {
      this.stems[k] = (k === stemName);
    });
    this.updateStemFilters();
  }

  resetStems() {
    Object.keys(this.stems).forEach(k => {
      this.stems[k] = true;
    });
    this.updateStemFilters();
  }

  updateStemFilters() {
    const now = this.ctx.currentTime;
    const { vocals, drums, bass, other } = this.stems;
    const activeCount = (vocals ? 1 : 0) + (drums ? 1 : 0) + (bass ? 1 : 0) + (other ? 1 : 0);

    // Case 1: All active (100% transparent bit-perfect direct studio audio)
    if (activeCount === 4) {
      this.masterDirectGain.gain.setTargetAtTime(1.0, now, 0.015);
      this.stemsSumGain.gain.setTargetAtTime(0.0, now, 0.015);
      this.stemGainVocals.gain.setTargetAtTime(1.0, now, 0.015);
      this.stemGainDrums.gain.setTargetAtTime(1.0, now, 0.015);
      this.stemGainBass.gain.setTargetAtTime(1.0, now, 0.015);
      this.stemGainOther.gain.setTargetAtTime(1.0, now, 0.015);
      return;
    }

    // Case 2: All muted
    if (activeCount === 0) {
      this.masterDirectGain.gain.setTargetAtTime(0.0, now, 0.015);
      this.stemsSumGain.gain.setTargetAtTime(0.0, now, 0.015);
      return;
    }

    // Smoothly crossfade from Direct Path to Stems Matrix
    this.masterDirectGain.gain.setTargetAtTime(0.0, now, 0.015);
    this.stemsSumGain.gain.setTargetAtTime(1.0, now, 0.015);

    // Case 3: Solo Mode (Exactly 1 active stem)
    if (activeCount === 1) {
      // In solo mode, apply optimal acoustic isolation & clarity gain boost
      this.stemGainVocals.gain.setTargetAtTime(vocals ? 1.40 : 0.0001, now, 0.015);
      this.stemGainDrums.gain.setTargetAtTime(drums ? 1.25 : 0.0001, now, 0.015);
      this.stemGainBass.gain.setTargetAtTime(bass ? 1.30 : 0.0001, now, 0.015);
      this.stemGainOther.gain.setTargetAtTime(other ? 1.20 : 0.0001, now, 0.015);
      return;
    }

    // Case 4: Mute / Multi-stem Mode (2 or 3 active stems)
    this.stemGainVocals.gain.setTargetAtTime(vocals ? 1.0 : 0.0001, now, 0.015);
    this.stemGainDrums.gain.setTargetAtTime(drums ? 1.0 : 0.0001, now, 0.015);
    this.stemGainBass.gain.setTargetAtTime(bass ? 1.0 : 0.0001, now, 0.015);
    this.stemGainOther.gain.setTargetAtTime(other ? 1.0 : 0.0001, now, 0.015);
  }

  setVolume(pct) {
    this.faderGain.gain.setTargetAtTime(pct / 100.0, this.ctx.currentTime, 0.02);
  }

  getVULevel() {
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i];
    }
    return sum / (data.length * 255);
  }

  // --- SUBTLE ECHO WASH (adds wet delay over dry without pausing the deck) ---
  engageSubtleEcho(bpm = 128.0, wetLevel = 0.35) {
    const now = this.ctx.currentTime;
    const spb = 60.0 / bpm;
    this.delayNode.delayTime.setValueAtTime(spb * 0.75, now);
    this.delayFeedback.gain.cancelScheduledValues(now);
    this.delayFeedback.gain.setValueAtTime(0.45, now);
    this.delayWetGain.gain.cancelScheduledValues(now);
    this.delayWetGain.gain.setValueAtTime(0.0, now);
    this.delayWetGain.gain.linearRampToValueAtTime(wetLevel, now + 0.8);
    this._echoEngaged = true;
  }

  disengageSubtleEcho(fadeSec = 2.5) {
    const now = this.ctx.currentTime;
    this.delayWetGain.gain.cancelScheduledValues(now);
    this.delayWetGain.gain.setValueAtTime(this.delayWetGain.gain.value, now);
    this.delayWetGain.gain.exponentialRampToValueAtTime(0.001, now + fadeSec);
    this.delayFeedback.gain.cancelScheduledValues(now);
    this.delayFeedback.gain.setValueAtTime(this.delayFeedback.gain.value, now);
    this.delayFeedback.gain.exponentialRampToValueAtTime(0.001, now + fadeSec);
    this._echoEngaged = false;
    setTimeout(() => {
      const resetNow = this.ctx.currentTime;
      this.delayWetGain.gain.setValueAtTime(0.0, resetNow);
      this.delayFeedback.gain.setValueAtTime(0.0, resetNow);
      this.delayInputGate.gain.setValueAtTime(1.0, resetNow);
      this.echoSend.gain.setValueAtTime(1.0, resetNow);
    }, (fadeSec + 0.5) * 1000);
  }

  // --- Scheduled slice repeats (loop roll / beat masher): every repeat is placed on the audio
  //     clock, so the stutter stays exactly on the grid. Main playback keeps running muted
  //     underneath (slip mode) and comes back in time when the roll ends. ---
  _scheduleRepeats(t0, totalSec, spb, divAt) {
    const anchor = this.audio.timeAt(t0);
    this._rollSources = [];
    let t = t0;
    while (t < t0 + totalSec - 1e-4) {
      const div = divAt((t - t0) / totalSec);
      const len = Math.min(div * spb, t0 + totalSec - t);
      const src = this.audio.playSlice(t, anchor, len);
      if (src) this._rollSources.push(src);
      t += div * spb;
    }
    this.audio.muteBetween(t0, t0 + totalSec);
  }

  _cancelRepeats() {
    const now = this.ctx.currentTime;
    (this._rollSources || []).forEach(s => { try { s.stop(now); } catch (e) {} });
    this._rollSources = [];
    this.audio.unmute();
  }

  // --- LOOP ROLL: accelerating 1 bar -> 1/16 beat repeats ---
  triggerLoopRoll(bpm = 128.0, totalBars = 4, onComplete = null, when = null) {
    const spb = 60.0 / bpm;
    const totalSec = totalBars * 4 * spb;
    const t0 = Math.max(this.ctx.currentTime + 0.01, when === null ? 0 : when);
    this._loopRollActive = true;
    this._scheduleRepeats(t0, totalSec, spb, p =>
      p < 0.25 ? 4 : p < 0.45 ? 2 : p < 0.65 ? 1 : p < 0.80 ? 0.5 : 0.25);

    // HPF sweep for tension riser feel
    this.filterHPF.frequency.cancelScheduledValues(t0);
    this.filterHPF.frequency.setValueAtTime(20, t0);
    this.filterHPF.frequency.exponentialRampToValueAtTime(2500, t0 + totalSec);

    clearTimeout(this._rollTimer);
    this._rollTimer = setTimeout(() => {
      this._loopRollActive = false;
      if (onComplete) onComplete();
    }, (t0 + totalSec - this.ctx.currentTime) * 1000);
  }

  cancelLoopRoll() {
    this._loopRollActive = false;
    clearTimeout(this._rollTimer);
    this._cancelRepeats();
    const now = this.ctx.currentTime;
    this.filterHPF.frequency.cancelScheduledValues(now);
    this.filterHPF.frequency.setValueAtTime(20, now);
  }

  // --- PRE-DROP SILENCE GAP: Momentary gain cut for anticipation ---
  triggerPreDropGap(durationSec = 0.3) {
    const now = this.ctx.currentTime;
    this.faderGain.gain.cancelScheduledValues(now);
    this.faderGain.gain.setValueAtTime(1.0, now);
    this.faderGain.gain.linearRampToValueAtTime(0.001, now + 0.008);
    this.faderGain.gain.setValueAtTime(0.001, now + durationSec - 0.008);
    this.faderGain.gain.linearRampToValueAtTime(1.0, now + durationSec);
  }

  // --- RESONANT LFO FLANGER FX ---
  engageFlanger(speed = 'medium', depth = 0.6, feedback = 0.5, wet = 0.4) {
    const now = this.ctx.currentTime;
    const rateHz = (speed === 'fast') ? 1.0 : ((speed === 'slow') ? 0.12 : 0.4);
    this.flangerLFO.frequency.setValueAtTime(rateHz, now);
    this.flangerLFOGain.gain.setValueAtTime(0.001 + (depth * 0.002), now);
    this.flangerFeedback.gain.cancelScheduledValues(now);
    this.flangerFeedback.gain.linearRampToValueAtTime(Math.min(0.85, feedback * 0.8), now + 0.3);
    this.flangerWetGain.gain.cancelScheduledValues(now);
    this.flangerWetGain.gain.linearRampToValueAtTime(wet, now + 0.3);
    this._flangerEngaged = true;
  }

  disengageFlanger(fadeSec = 1.0) {
    const now = this.ctx.currentTime;
    this.flangerWetGain.gain.cancelScheduledValues(now);
    this.flangerWetGain.gain.linearRampToValueAtTime(0.001, now + fadeSec);
    this.flangerFeedback.gain.cancelScheduledValues(now);
    this.flangerFeedback.gain.linearRampToValueAtTime(0.0, now + fadeSec);
    this._flangerEngaged = false;
  }

  // --- BEAT-SYNCED MASHER / STUTTER ---
  triggerBeatMasher(bpm = 128.0, division = '1/16', totalBars = 2, onComplete = null) {
    const spb = 60.0 / bpm;
    const divBeats = (division === '1/32') ? 0.125 : ((division === '1/16') ? 0.25 : ((division === '1/8') ? 0.5 : 1.0));
    const totalSec = totalBars * 4 * spb;
    const t0 = this.ctx.currentTime + 0.01;
    this._beatMasherActive = true;
    this._scheduleRepeats(t0, totalSec, spb, () => divBeats);
    clearTimeout(this._masherTimer);
    this._masherTimer = setTimeout(() => {
      this._beatMasherActive = false;
      if (onComplete) onComplete();
    }, totalSec * 1000);
  }

  cancelBeatMasher() {
    if (!this._beatMasherActive) return;
    this._beatMasherActive = false;
    clearTimeout(this._masherTimer);
    this._cancelRepeats();
  }

  // --- TURNTABLE PITCH BEND ---
  triggerPitchBend(semitones = -4, durationSec = 2.0, style = 'turntable_slowdown', onComplete = null) {
    const startRate = this.audio.playbackRate;
    const startPerf = performance.now();
    this._pitchBendActive = true;

    const targetMult = Math.pow(2, semitones / 12);
    const targetRate = (style === 'turntable_slowdown') ? 0.05 : Math.max(0.2, startRate * targetMult);

    const bendFrame = () => {
      if (!this._pitchBendActive) return;
      const elapsed = (performance.now() - startPerf) / 1000;
      const progress = Math.min(1.0, elapsed / durationSec);

      const ease = progress * progress * (3 - 2 * progress);
      this.audio.playbackRate = startRate + (targetRate - startRate) * ease;

      if (progress < 1.0) {
        requestAnimationFrame(bendFrame);
      } else {
        this._pitchBendActive = false;
        if (onComplete) onComplete();
      }
    };
    requestAnimationFrame(bendFrame);
  }

  resetPitchBend() {
    this._pitchBendActive = false;
    this.audio.playbackRate = 1.0;
  }

  // --- SMOOTH STEM LEVEL AUTOMATION ---
  setStemLevels(stemMap, rampSec = 0.1) {
    const now = this.ctx.currentTime;
    if (stemMap.vocals !== undefined) {
      this.stemGainVocals.gain.cancelScheduledValues(now);
      this.stemGainVocals.gain.setTargetAtTime(Math.max(0.0001, stemMap.vocals), now, rampSec);
      this.stems.vocals = stemMap.vocals > 0.1;
    }
    if (stemMap.drums !== undefined) {
      this.stemGainDrums.gain.cancelScheduledValues(now);
      this.stemGainDrums.gain.setTargetAtTime(Math.max(0.0001, stemMap.drums), now, rampSec);
      this.stems.drums = stemMap.drums > 0.1;
    }
    if (stemMap.bass !== undefined) {
      this.stemGainBass.gain.cancelScheduledValues(now);
      this.stemGainBass.gain.setTargetAtTime(Math.max(0.0001, stemMap.bass), now, rampSec);
      this.stems.bass = stemMap.bass > 0.1;
    }
    if (stemMap.other !== undefined) {
      this.stemGainOther.gain.cancelScheduledValues(now);
      this.stemGainOther.gain.setTargetAtTime(Math.max(0.0001, stemMap.other), now, rampSec);
      this.stems.other = stemMap.other > 0.1;
    }
    const isCustom = Object.values(stemMap).some(v => v !== undefined && v < 0.95);
    if (isCustom) {
      this.masterDirectGain.gain.setTargetAtTime(0.0, now, 0.02);
      this.stemsSumGain.gain.setTargetAtTime(1.0, now, 0.02);
    }
  }

  // --- RESET ALL FX TO NEUTRAL ---
  resetAllFX() {
    const now = this.ctx.currentTime;
    this.filterLPF.frequency.cancelScheduledValues(now);
    this.filterLPF.frequency.setValueAtTime(20000, now);
    this.filterHPF.frequency.cancelScheduledValues(now);
    this.filterHPF.frequency.setValueAtTime(20, now);
    this.faderGain.gain.cancelScheduledValues(now);
    this.faderGain.gain.setValueAtTime(1.0, now);
    this.delayWetGain.gain.cancelScheduledValues(now);
    this.delayWetGain.gain.setValueAtTime(0.0, now);
    this.delayFeedback.gain.cancelScheduledValues(now);
    this.delayFeedback.gain.setValueAtTime(0.0, now);
    this.delayInputGate.gain.setValueAtTime(1.0, now);
    this.echoSend.gain.setValueAtTime(1.0, now);
    this.flangerWetGain.gain.cancelScheduledValues(now);
    this.flangerWetGain.gain.setValueAtTime(0.0, now);
    this.flangerFeedback.gain.cancelScheduledValues(now);
    this.flangerFeedback.gain.setValueAtTime(0.0, now);
    [this.lowCut1, this.lowCut2].forEach(f => {
      f.frequency.cancelScheduledValues(now);
      f.frequency.setValueAtTime(10, now);
    });
    clearTimeout(this._rollTimer);
    clearTimeout(this._masherTimer);
    this._cancelRepeats();
    this._loopRollActive = false;
    this._echoEngaged = false;
    this._flangerEngaged = false;
    this._beatMasherActive = false;
    this._pitchBendActive = false;
    this.audio.playbackRate = 1.0;
    this.resetStems();
  }

  // --- PRE-FADE LISTEN (PFL) HEADPHONE CUE ---
  setHeadphoneCue(active) {
    this.isCueActive = !!active;
    const now = this.ctx.currentTime;
    this.pflSend.gain.cancelScheduledValues(now);
    this.pflSend.gain.setValueAtTime(this.isCueActive ? 1.0 : 0.0, now);
    return this.isCueActive;
  }

  // --- EXTRACT 10-12s AUDITION SLICE AS BASE64 PCM WAV (< 5ms) ---
  sliceAuditionWavBase64(startSec, durationSec = 10.0, targetSr = 16000) {
    if (!this.audioBuffer) return null;
    try {
      const origSr = this.audioBuffer.sampleRate;
      const startSample = Math.floor(Math.max(0, startSec) * origSr);
      const totalSamples = Math.min(this.audioBuffer.length - startSample, Math.floor(durationSec * origSr));
      if (totalSamples <= 0) return null;

      const srcData = this.audioBuffer.getChannelData(0); // Mono
      const step = origSr / targetSr;
      const outSamples = Math.floor(totalSamples / step);

      const buffer = new ArrayBuffer(44 + outSamples * 2);
      const view = new DataView(buffer);

      const writeStr = (offset, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
      };

      writeStr(0, 'RIFF');
      view.setUint32(4, 36 + outSamples * 2, true);
      writeStr(8, 'WAVE');
      writeStr(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true); // PCM format
      view.setUint16(22, 1, true); // Mono channel
      view.setUint32(24, targetSr, true);
      view.setUint32(28, targetSr * 2, true); // byte rate (sr * 1 * 16/8)
      view.setUint16(32, 2, true); // block align
      view.setUint16(34, 16, true); // 16 bits per sample
      writeStr(36, 'data');
      view.setUint32(40, outSamples * 2, true);

      let offset = 44;
      for (let i = 0; i < outSamples; i++) {
        const srcIdx = startSample + Math.floor(i * step);
        const s = Math.max(-1, Math.min(1, srcData[srcIdx] || 0));
        const val = s < 0 ? s * 0x8000 : s * 0x7FFF;
        view.setInt16(offset, val, true);
        offset += 2;
      }

      let binary = '';
      const bytes = new Uint8Array(buffer);
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return btoa(binary);
    } catch (err) {
      console.warn('sliceAuditionWavBase64 error:', err);
      return null;
    }
  }
}

class DJAudioEngine {
  constructor() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioCtx();

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 1.0;
    this.masterGain.connect(this.ctx.destination);

    this.deck1 = new DJDeckAudio(this.ctx, 1, this.masterGain);
    this.deck2 = new DJDeckAudio(this.ctx, 2, this.masterGain);

    // Pre-Fade Listen (PFL) Headphone Bus
    this.pflBusGain = this.ctx.createGain();
    this.pflBusGain.gain.value = 1.0;
    this.deck1.pflSend.connect(this.pflBusGain);
    this.deck2.pflSend.connect(this.pflBusGain);

    this.pflAnalyser = this.ctx.createAnalyser();
    this.pflAnalyser.fftSize = 64;
    this.pflBusGain.connect(this.pflAnalyser);
    this.pflBusGain.connect(this.ctx.destination);

    this.setCrossfader(50, 'club');
  }

  setHeadphonePflVolume(val) { // 0 - 100
    const norm = Math.max(0, Math.min(1, val / 100));
    this.pflBusGain.gain.setValueAtTime(norm, this.ctx.currentTime);
  }

  getPflVULevel() {
    const data = new Uint8Array(this.pflAnalyser.frequencyBinCount);
    this.pflAnalyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    return Math.min(100, Math.round((sum / data.length / 255) * 100 * 1.5));
  }

  setCrossfader(val, curve = 'club') {
    // val from 0 (all Deck 1) to 100 (all Deck 2)
    const t = Math.max(0, Math.min(100, val)) / 100.0;
    const now = this.ctx.currentTime;
    
    let gain1, gain2;
    if (curve === 'club') {
      // Pioneer DJM Club Curve: preserves full loudness across center blend
      gain1 = Math.min(1.0, Math.SQRT2 * Math.cos(t * 0.5 * Math.PI));
      gain2 = Math.min(1.0, Math.SQRT2 * Math.sin(t * 0.5 * Math.PI));
    } else {
      // Standard Equal-power crossfade curve
      gain1 = Math.cos(t * 0.5 * Math.PI);
      gain2 = Math.sin(t * 0.5 * Math.PI);
    }
    this.deck1.cfGain.gain.setTargetAtTime(gain1, now, 0.015);
    this.deck2.cfGain.gain.setTargetAtTime(gain2, now, 0.015);
  }

  triggerNoiseRiser(bpm = 128.0, bars = 4, onComplete = null) {
    const spb = 60.0 / bpm;
    const totalSec = bars * 4 * spb;
    const now = this.ctx.currentTime;
    
    // Create white noise buffer
    const bufferSize = Math.floor(this.ctx.sampleRate * totalSec);
    const noiseBuffer = this.ctx.createBuffer(2, bufferSize, this.ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = noiseBuffer.getChannelData(ch);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1) * 0.35;
      }
    }

    const noiseSrc = this.ctx.createBufferSource();
    noiseSrc.buffer = noiseBuffer;

    // HPF Filter sweep from 150Hz to 8500Hz
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.setValueAtTime(150, now);
    filter.frequency.exponentialRampToValueAtTime(8500, now + totalSec - spb);

    // Rhythmic pump gain (ducking on downbeats)
    const pumpGain = this.ctx.createGain();
    pumpGain.gain.setValueAtTime(0.3, now);
    const totalBeats = bars * 4;
    for (let b = 0; b < totalBeats - 1; b++) {
      const beatStart = now + b * spb;
      pumpGain.gain.setValueAtTime(0.25, beatStart);
      pumpGain.gain.linearRampToValueAtTime(0.95, beatStart + spb * 0.85);
    }
    // Drop silence on the very last beat
    pumpGain.gain.setValueAtTime(0.0, now + totalSec - spb);

    // Master volume swell
    const riserGain = this.ctx.createGain();
    riserGain.gain.setValueAtTime(0.1, now);
    riserGain.gain.exponentialRampToValueAtTime(0.85, now + totalSec - spb);
    riserGain.gain.setValueAtTime(0.0, now + totalSec - spb);

    noiseSrc.connect(filter);
    filter.connect(pumpGain);
    pumpGain.connect(riserGain);
    riserGain.connect(this.masterGain);

    noiseSrc.start(now);
    noiseSrc.stop(now + totalSec);

    setTimeout(() => {
      if (onComplete) onComplete();
    }, totalSec * 1000);
  }

  // --- DROP IMPACT: Sub-bass boom + crash splash on the 1 ---
  triggerDropImpact(bpm = 128.0) {
    const now = this.ctx.currentTime;
    const sr = this.ctx.sampleRate;

    // Sub-bass boom: pitch-swept sine 70Hz → 35Hz
    const boomDur = 0.8;
    const boomLen = Math.floor(sr * boomDur);
    const boomBuf = this.ctx.createBuffer(2, boomLen, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = boomBuf.getChannelData(ch);
      let phaseAcc = 0;
      for (let i = 0; i < boomLen; i++) {
        const t = i / sr;
        const freq = 70.0 * Math.exp(-t * 8.0) + 35.0;
        phaseAcc += (2 * Math.PI * freq) / sr;
        d[i] = Math.sin(phaseAcc) * Math.exp(-t * 4.0) * 0.4;
      }
    }
    const boomSrc = this.ctx.createBufferSource();
    boomSrc.buffer = boomBuf;
    const boomLPF = this.ctx.createBiquadFilter();
    boomLPF.type = 'lowpass';
    boomLPF.frequency.value = 120;
    const boomGain = this.ctx.createGain();
    boomGain.gain.setValueAtTime(0.45, now);
    boomGain.gain.exponentialRampToValueAtTime(0.001, now + boomDur);
    boomSrc.connect(boomLPF);
    boomLPF.connect(boomGain);
    boomGain.connect(this.masterGain);
    boomSrc.start(now);
    boomSrc.stop(now + boomDur);

    // High-frequency crash / reverb splash
    const crashDur = 1.5;
    const crashLen = Math.floor(sr * crashDur);
    const crashBuf = this.ctx.createBuffer(2, crashLen, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = crashBuf.getChannelData(ch);
      for (let i = 0; i < crashLen; i++) {
        const t = i / sr;
        d[i] = (Math.random() * 2 - 1) * Math.exp(-t * 3.5) * 0.12;
      }
    }
    const crashSrc = this.ctx.createBufferSource();
    crashSrc.buffer = crashBuf;
    const crashHPF = this.ctx.createBiquadFilter();
    crashHPF.type = 'highpass';
    crashHPF.frequency.value = 5000;
    const crashGain = this.ctx.createGain();
    crashGain.gain.setValueAtTime(0.20, now);
    crashGain.gain.exponentialRampToValueAtTime(0.001, now + crashDur);
    crashSrc.connect(crashHPF);
    crashHPF.connect(crashGain);
    crashGain.connect(this.masterGain);
    crashSrc.start(now);
    crashSrc.stop(now + crashDur);
  }
}

window.DJAudioEngine = DJAudioEngine;
