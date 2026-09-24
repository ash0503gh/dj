/**
 * waveform.js - Scrolling deck waveforms in the console's deck colors.
 *
 * - Bars (3 px, 1 px apart): a softer outer body for the full level, a bright core for the bass
 *   share and light tips where the highs dominate. Deck A blue, deck B orange; the part already
 *   played is dimmed.
 * - Beat grid behind the bars: faint beats, brighter bar lines, deck-colored 16-bar phrase marks.
 * - Numbered hot cue flags, track start/end, a soft tint over the transition window (the page
 *   draws the playhead and the transition box/label as overlays across both decks).
 * - Full-track overview strip at the bottom: played part dimmed, cue ticks, visible window.
 * - Low-resolution waveform arrays get beat-synchronized transient detail (sampleWaveformAt).
 */

class RGBWaveform {
  constructor(canvasId, deckNumber, onSeek) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.deckNum = deckNumber;
    this.onSeek = onSeek;

    this.trackData = null;
    this.currentTime = 0;
    this.zoom = 1.0; // 1.0x = ~16s visible, 2.0x = ~8s, 4.0x = ~4s
    this.mode = 'scroll'; // 'scroll' (VirtualDJ CDJ style) or 'overview' (full track)
    this.isDragging = false;
    this.dragMode = null; // 'scrolling' or 'overview'

    this.transitionZone = null; // { start, duration, isOutgoing }

    this.setupEvents();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    if (!this.canvas || !this.canvas.parentElement) return;
    // Drawn in CSS pixels on a device-pixel backing store, so it stays sharp on retina screens
    const dpr = window.devicePixelRatio || 1;
    this.cssW = Math.max(300, this.canvas.parentElement.clientWidth || 800);
    this.cssH = Math.max(60, this.canvas.clientHeight || 90);   // the stylesheet sets the lane height
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  loadTrack(trackData) {
    this.trackData = trackData;
    this.currentTime = 0;
    if (this.trackData) {
      // Ensure high-density waveform exists or synthesize fallback immediately (50 bins/sec)
      if (!this.trackData.waveform || !this.trackData.waveform.overall || this.trackData.waveform.overall.length === 0) {
        this.trackData.waveform = this.synthesizeWaveform(
          this.trackData.duration || 180,
          this.trackData.bpm || 128
        );
      }
      // Ensure beatgrid exists or synthesize fallback immediately
      if (!this.trackData.beat_times || this.trackData.beat_times.length === 0) {
        const dur = this.trackData.duration || 180;
        const bpm = this.trackData.bpm || 128;
        const spb = 60.0 / Math.max(60, bpm);
        const beats = [];
        const downbeats = [];
        const phrases = [];
        for (let b = 0; b < Math.floor(dur / spb); b++) {
          const bt = Math.round(b * spb * 1000) / 1000;
          beats.push(bt);
          if (b % 4 === 0) downbeats.push(bt);
          if (b % 64 === 0) phrases.push(bt);
        }
        this.trackData.beat_times = beats;
        this.trackData.downbeat_times = downbeats;
        this.trackData.phrase_16_times = phrases;
      }
    }
    this.draw();
  }

  setTime(time) {
    this.currentTime = time;
    this.draw();
  }

  setTransitionZone(start, duration, isOutgoing = true) {
    this.transitionZone = { start, duration, isOutgoing };
  }

  getVisibleDuration() {
    if (this.mode === 'overview') {
      return (this.trackData && this.trackData.duration) ? this.trackData.duration : 180.0;
    }
    // Standard VirtualDJ view: 16.0 seconds visible at 1.0x (~8 bars / 32 beats at 128 BPM)
    const baseWindow = 16.0;
    return Math.max(2.0, baseWindow / Math.max(0.25, this.zoom));
  }

  /**
   * Generates high-density (50 bins/sec) authentic VirtualDJ transients:
   * Real exponential kick decays, snappy snares on beats 2 & 4, cyan hi-hat spikes,
   * and musical macro structure (breaks, risers, drops).
   */
  synthesizeWaveform(duration = 180, bpm = 128) {
    const binsPerSec = 50;
    const bins = Math.min(12000, Math.max(3600, Math.floor(duration * binsPerSec)));
    const spb = 60.0 / Math.max(60, bpm);

    const overall = [];
    const low = [];
    const mid = [];
    const high = [];

    for (let i = 0; i < bins; i++) {
      const t = (i / bins) * duration;
      const beatTime = t % spb;
      const beatProgress = beatTime / spb;
      const beatIndex = Math.floor(t / spb);
      const beatInBar = (beatIndex % 4) + 1; // 1, 2, 3, 4

      // Macro energy envelope (intro build, drop 1, breakdown, riser, drop 2, outro)
      const normT = t / duration;
      let macro = 0.65;
      let isBreakdown = false;

      if (normT < 0.12) {
        macro = 0.25 + (normT / 0.12) * 0.45; // Intro buildup
      } else if (normT < 0.42) {
        macro = 0.88; // Drop 1
      } else if (normT < 0.52) {
        macro = 0.38; // Melodic breakdown (kick cuts out)
        isBreakdown = true;
      } else if (normT < 0.58) {
        macro = 0.45 + ((normT - 0.52) / 0.06) * 0.45; // Tension riser
      } else if (normT < 0.86) {
        macro = 0.96; // Peak drop 2
      } else {
        macro = 0.85 - ((normT - 0.86) / 0.14) * 0.60; // Outro
      }

      // 1. Kick Drum: Steep exponential transient on every beat (unless in breakdown)
      let kick = 0;
      if (!isBreakdown) {
        // Extra punch on Beat 1 (downbeat)
        const kickWeight = (beatInBar === 1) ? 1.0 : 0.88;
        kick = Math.exp(-beatTime / 0.048) * kickWeight;
      }

      // 2. Snare / Clap: Sharp crack on beats 2 & 4
      let snare = 0;
      if (beatInBar === 2 || beatInBar === 4) {
        snare = Math.exp(-beatTime / 0.068) * 0.85;
      }

      // 3. Hi-Hats: 16th and 8th note ticks
      const hatCycle = beatTime % (spb / 2);
      const hat = Math.exp(-hatCycle / 0.024) * 0.65;

      // Micro acoustic jitter so each transient looks organically sculpted
      const jitter = (Math.sin(i * 13.37 + (i % 5) * 3.14) * 0.5 + 0.5) * 0.12;

      // 3-Band Frequency Calculation
      const lVal = Math.min(1.0, Math.max(0.02, (kick * 0.92 + (isBreakdown ? 0.05 : macro * 0.22)) * (1 + jitter * 0.4)));
      const mVal = Math.min(1.0, Math.max(0.04, (snare * 0.78 + macro * 0.52) * (1 + jitter * 0.8)));
      const hVal = Math.min(1.0, Math.max(0.03, (hat * 0.72 + snare * 0.35 + macro * 0.32) * (1 + jitter * 1.2)));

      const totVal = Math.min(1.0, Math.max(0.06, lVal * 0.85 + mVal * 0.72 + hVal * 0.55));

      overall.push(Math.round(totVal * 1000) / 1000);
      low.push(Math.round(lVal * 1000) / 1000);
      mid.push(Math.round(mVal * 1000) / 1000);
      high.push(Math.round(hVal * 1000) / 1000);
    }

    return {
      overall,
      low,
      mid,
      high,
      low_red: low,
      mid_green: mid,
      high_blue: high
    };
  }

  /**
   * Smoothly samples the waveform at time t with sub-bin linear interpolation.
   * If the underlying array has low resolution (< 2500 bins), applies beat-synchronized
   * transient modulation so the waveform NEVER renders as flat blocks.
   */
  sampleWaveformAt(t, dur) {
    if (!this.trackData || !this.trackData.waveform) {
      return { tot: 0.1, r: 0.05, g: 0.05, b: 0.05 };
    }
    const wf = this.trackData.waveform;
    const overall = wf.overall || [];
    const N = overall.length;
    if (N === 0) return { tot: 0.1, r: 0.05, g: 0.05, b: 0.05 };

    const normT = Math.max(0, Math.min(1, t / dur));
    const fIndex = normT * (N - 1);
    const i0 = Math.floor(fIndex);
    const i1 = Math.min(N - 1, i0 + 1);
    const frac = fIndex - i0;

    const lowArr = wf.low_red || wf.low || overall;
    const midArr = wf.mid_green || wf.mid || overall;
    const highArr = wf.high_blue || wf.high || overall;

    let tot = (1 - frac) * overall[i0] + frac * overall[i1];
    let r = (1 - frac) * lowArr[i0] + frac * lowArr[i1];
    let g = (1 - frac) * midArr[i0] + frac * midArr[i1];
    let b = (1 - frac) * highArr[i0] + frac * highArr[i1];

    // Beat-synchronized transient modulation for low-resolution source arrays (< 2500 bins)
    if (N < 2500 && this.trackData.bpm) {
      const spb = 60.0 / this.trackData.bpm;
      const bTime = t % spb;
      const kickEnv = Math.exp(-bTime / 0.052);
      const hatEnv = Math.exp(-(bTime % (spb / 2)) / 0.032);
      const modKick = 0.65 + 0.35 * kickEnv;
      const modHat = 0.75 + 0.25 * hatEnv;

      tot = Math.min(1.0, tot * modKick);
      r = Math.min(1.0, r * (0.35 + 0.65 * kickEnv));
      g = Math.min(1.0, g * 0.92);
      b = Math.min(1.0, b * modHat);
    }

    return { tot, r, g, b };
  }

  setupEvents() {
    const handleInteraction = (e) => {
      if (!this.trackData || !this.trackData.duration) return;
      // In the canvas's own axes (the console may be turned sideways on phones)
      const { x, y, w, h } = UI.local(e, this.canvas);
      const dur = this.trackData.duration;

      // The bottom strip is the full-track overview
      if (y >= h - 16 || this.dragMode === 'overview') {
        this.dragMode = 'overview';
        const ratio = Math.max(0, Math.min(1, x / w));
        const targetTime = ratio * dur;
        if (this.onSeek) this.onSeek(Math.max(0, Math.min(dur, targetTime)));
        return;
      }

      // Top area is the dynamic scrolling waveform
      this.dragMode = 'scrolling';
      if (this.mode === 'overview') {
        const ratio = Math.max(0, Math.min(1, x / w));
        const targetTime = ratio * dur;
        if (this.onSeek) this.onSeek(Math.max(0, Math.min(dur, targetTime)));
      } else {
        const visibleDur = this.getVisibleDuration();
        const deltaX = x - (w / 2);
        const deltaTime = (deltaX / w) * visibleDur;
        const targetTime = this.currentTime + deltaTime;
        if (this.onSeek) this.onSeek(Math.max(0, Math.min(dur, targetTime)));
      }
    };

    this.canvas.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      handleInteraction(e);
    });

    window.addEventListener('mousemove', (e) => {
      if (this.isDragging) handleInteraction(e);
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
      this.dragMode = null;
    });

    // Touch support for mobile / tablet DJing
    this.canvas.addEventListener('touchstart', (e) => {
      this.isDragging = true;
      handleInteraction(e);
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      if (this.isDragging) handleInteraction(e);
    }, { passive: true });

    window.addEventListener('touchend', () => {
      this.isDragging = false;
      this.dragMode = null;
    });
  }

  draw() {
    if (!this.canvas || !this.ctx) return;
    const ctx = this.ctx;
    const w = this.cssW || this.canvas.width;
    const H = this.cssH || 90;
    const OV_H = H >= 80 ? 14 : 11;        // full-track overview strip at the bottom
    const OV_Y = H - OV_H - 1;
    const MAIN_H = OV_Y - 5;               // scrolling waveform above it
    const midY = MAIN_H / 2 + 1;
    const maxBarH = MAIN_H / 2 - 5;
    const rgb = this.deckNum === 1 ? [62, 166, 255] : [255, 138, 31];
    const col = (a) => `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;

    ctx.fillStyle = '#0b0b0c';
    ctx.fillRect(0, 0, w, H);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.fillRect(0, midY - 0.5, w, 1);

    if (!this.trackData) {
      this.drawOverviewStrip(w, OV_Y, OV_H, rgb);
      return;
    }

    const dur = Math.max(1, this.trackData.duration || 180);
    const visibleDur = this.getVisibleDuration();
    const scrolling = this.mode === 'scroll';
    const centerX = w / 2;
    const timeToX = (t) => (scrolling ? centerX + ((t - this.currentTime) / visibleDur) * w : (t / dur) * w);
    const xToTime = (x) => (scrolling ? this.currentTime + ((x - centerX) / w) * visibleDur : (x / w) * dur);
    const viewStart = xToTime(0), viewEnd = xToTime(w);

    // Transition window: a soft tint (the page draws its box and label on top)
    const tz = this.transitionZone;
    if (tz && tz.duration > 0) {
      const x1 = Math.max(0, timeToX(tz.start)), x2 = Math.min(w, timeToX(tz.start + tz.duration));
      if (x2 > x1) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.045)';
        ctx.fillRect(x1, 0, x2 - x1, MAIN_H);
      }
    }

    // Beat grid behind the bars: faint beats, brighter bar lines, deck-colored 16-bar phrases
    const beats = this.trackData.beat_times || [];
    if (beats.length) {
      const downbeats = new Set(this.trackData.downbeat_times || []);
      const phrases = new Set(this.trackData.phrase_16_times || []);
      const pxPerBeat = (w / visibleDur) * (60 / (this.trackData.bpm || 120));
      for (let i = 0; i < beats.length; i++) {
        const t = beats[i];
        if (t < viewStart - 1 || t > viewEnd + 1) continue;
        const x = Math.round(timeToX(t)) + 0.5;
        if (phrases.has(t)) {
          ctx.fillStyle = col(0.55);
          ctx.fillRect(x - 1, 0, 2, MAIN_H);
          ctx.beginPath();
          ctx.moveTo(x - 4, 0); ctx.lineTo(x + 4, 0); ctx.lineTo(x, 5); ctx.closePath();
          ctx.fill();
        } else if (downbeats.has(t)) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.13)';
          ctx.fillRect(x - 0.5, 0, 1, MAIN_H);
        } else if (pxPerBeat > 7) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
          ctx.fillRect(x - 0.5, 6, 1, MAIN_H - 12);
        }
      }
    }

    // Bars: 3 px wide, 1 px apart. Outer body = full level (softer); bright core = the bass share;
    // light tips where the highs dominate. The part already played is dimmed.
    const BAR = 3, STEP = 4;
    const played = scrolling ? centerX : timeToX(this.currentTime);
    for (let x = 0; x < w; x += STEP) {
      const t = xToTime(x + BAR / 2);
      if (t < 0 || t > dur) continue;
      const s = this.sampleWaveformAt(t, dur);
      const h = Math.max(1, s.tot * maxBarH);
      const lowShare = Math.min(1, s.r / Math.max(0.01, s.tot));
      const highShare = Math.min(1, s.b / Math.max(0.01, s.tot));
      const dim = x + BAR <= played ? 0.42 : 1;
      ctx.fillStyle = col((0.38 + 0.2 * highShare) * dim);
      ctx.fillRect(x, midY - h, BAR, h * 2);
      const core = Math.max(1, Math.min(h, h * (0.25 + 0.75 * lowShare)));
      ctx.fillStyle = col(0.95 * dim);
      ctx.fillRect(x, midY - core, BAR, core * 2);
      if (highShare > 0.45 && h > 6) {
        ctx.fillStyle = `rgba(255, 255, 255, ${0.55 * dim})`;
        ctx.fillRect(x, midY - h, BAR, 1.5);
        ctx.fillRect(x, midY + h - 1.5, BAR, 1.5);
      }
    }

    // Track start / end
    ctx.font = '600 9px "JetBrains Mono", monospace';
    const sx = timeToX(0);
    if (sx > 0 && sx < w) {
      ctx.fillStyle = col(0.8);
      ctx.fillRect(sx, 4, 1, MAIN_H - 8);
      ctx.fillText('0:00', sx + 4, MAIN_H - 5);
    }
    const ex = timeToX(dur);
    if (ex > 0 && ex < w) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.fillRect(ex, 4, 1, MAIN_H - 8);
      ctx.fillText('END', ex - 24, MAIN_H - 5);
    }

    // Hot cues: thin line + numbered flag
    const cues = this.cuePoints(dur);
    ctx.font = '700 9px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    cues.forEach(({ t, n, color }) => {
      const x = Math.round(timeToX(t));
      if (x < -16 || x > w + 16) return;
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.75;
      ctx.fillRect(x, 0, 1, MAIN_H);
      ctx.globalAlpha = 1;
      ctx.fillRect(x, MAIN_H - 13, 13, 13);
      ctx.fillStyle = '#0b0b0c';
      ctx.fillText(String(n), x + 6.5, MAIN_H - 3.5);
    });
    ctx.textAlign = 'left';

    // Overview mode has no page playhead: draw it here
    if (!scrolling) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(Math.round(played) - 1, 0, 2, MAIN_H);
    }

    this.drawOverviewStrip(w, OV_Y, OV_H, rgb);
  }

  /** Hot cue times from the track (same fallbacks as the cue buttons). */
  cuePoints(dur) {
    const td = this.trackData;
    const hc = td.hot_cues || {
      cue_1: td.suggested_cue_intro !== undefined ? td.suggested_cue_intro : 0,
      cue_2: td.suggested_cue_verse !== undefined ? td.suggested_cue_verse : dur * 0.25,
      cue_3: td.suggested_cue_drop !== undefined ? td.suggested_cue_drop : dur * 0.5,
      cue_4: td.suggested_cue_outro !== undefined ? td.suggested_cue_outro : Math.max(0, dur - 30),
    };
    const colors = ['#10b981', '#0ea5e9', '#ec4899', '#f97316'];
    return [1, 2, 3, 4].map((n) => ({ n, t: hc[`cue_${n}`], color: colors[n - 1] }))
      .filter((c) => c.t !== undefined && c.t !== null);
  }

  /** Full-track overview: played part dimmed, cue ticks, the visible window and the playhead. */
  drawOverviewStrip(w, y, h, rgb) {
    const ctx = this.ctx;
    ctx.fillStyle = '#121214';
    ctx.fillRect(0, y, w, h);
    if (!this.trackData || !this.trackData.waveform) return;
    const dur = Math.max(1, this.trackData.duration || 180);
    const mid = y + h / 2;
    const maxH = h / 2 - 1;
    const playX = Math.max(0, Math.min(w, (this.currentTime / dur) * w));
    for (let x = 0; x < w; x += 2) {
      const s = this.sampleWaveformAt((x / w) * dur, dur);
      const bh = Math.max(0.5, s.tot * maxH);
      ctx.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${x < playX ? 0.3 : 0.75})`;
      ctx.fillRect(x, mid - bh, 1.5, bh * 2);
    }
    this.cuePoints(dur).forEach(({ t, color }) => {
      ctx.fillStyle = color;
      ctx.fillRect(Math.round((t / dur) * w) - 1, y, 2, h);
    });
    if (this.mode === 'scroll') {
      const vis = this.getVisibleDuration();
      const x1 = Math.max(0, ((this.currentTime - vis / 2) / dur) * w);
      const x2 = Math.min(w, ((this.currentTime + vis / 2) / dur) * w);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.fillRect(x1, y, Math.max(4, x2 - x1), h);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x1 + 0.5, y + 0.5, Math.max(4, x2 - x1) - 1, h - 1);
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(playX - 1, y, 2, h);
  }
}

window.RGBWaveform = RGBWaveform;
