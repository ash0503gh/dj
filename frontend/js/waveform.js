/**
 * waveform.js - Professional VirtualDJ-Style 3-Band RGB Dynamic Waveform Visualizer
 *
 * Distinctive VirtualDJ Characteristics:
 * 1. High-Density Transient Spikes: Crisp 2px vertical slices with 1px dark separation slits (NO flat blocks).
 * 2. 3-Tier Multi-Band Color Layering:
 *    - Highs (Hats / Cymbals / Sibilance): Piercing Electric Cyan (#00f0ff) outer needles with white tips (#e0f7ff).
 *    - Mids (Vocals / Melodies / Synths): Vibrant Neon Lime Green (#00e676) body.
 *    - Lows (Kicks / 808 Sub): Blazing Crimson Red (#ff1744) core anchored around the center zero-crossing line.
 * 3. Authentic VirtualDJ Beatgrid with Beat Numbers:
 *    - Beat 1 (Downbeat): Prominent accent line + glowing deck-colored [ 1 ] badge.
 *    - Beats 2, 3, 4: Vertical grid ticks with crisp "2", "3", "4" numbers.
 *    - 16-Bar Phrases: Vivid purple accent lines with [16B] badge.
 * 4. Center Playhead Needle:
 *    - Crisp white glowing needle with top pointer (▼), bottom pointer (▲), and illuminated center pip.
 * 5. Mini Full-Track Overview Strip:
 *    - True 3-band energy overview with illuminated zoom window bracket and playhead scrubber.
 * 6. High-Density Synthesizer & Sub-Sample Interpolator:
 *    - Guarantees razor-sharp transient spikes even for fallback audio or coarse arrays.
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
    const parentW = this.canvas.parentElement.clientWidth || 800;
    this.canvas.width = Math.max(300, parentW);
    this.canvas.height = 90;
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
      const rect = this.canvas.getBoundingClientRect();
      const clientX = e.clientX !== undefined ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
      const clientY = e.clientY !== undefined ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const w = rect.width;
      const h = rect.height;
      const dur = this.trackData.duration;

      // Bottom 18px is the mini full-track overview strip
      if (y >= h - 18 || this.dragMode === 'overview') {
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
    const w = this.canvas.width;
    const h = this.canvas.height;
    const ctx = this.ctx;

    // Background: Deep VirtualDJ Carbon Slate
    ctx.fillStyle = '#07090e';
    ctx.fillRect(0, 0, w, h);

    const mainH = 72; // Top 72px: Main Scrolling Waveform
    const overviewY = 73; // Bottom 17px: Mini Full-Track Overview
    const overviewH = 17;
    const midY = 41; // Shift slightly down to leave room for VirtualDJ beat numbers at top
    const centerX = w * 0.5; // Locked center playhead line (50%)
    const maxBarH = 29; // ~29px max height above and below center line

    // If no track data, draw idle grid lines
    if (!this.trackData) {
      ctx.strokeStyle = '#131922';
      ctx.lineWidth = 1;
      for (let x = 0; x < w; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, mainH);
        ctx.stroke();
      }
      this.drawOverviewStrip(w, h, overviewY, overviewH);
      return;
    }

    const dur = Math.max(1, this.trackData.duration || 180);
    const visibleDur = this.getVisibleDuration();
    const isScrolling = (this.mode === 'scroll');

    // Calculate visible time window
    let viewStart, viewEnd;
    if (isScrolling) {
      viewStart = this.currentTime - visibleDur / 2;
      viewEnd = this.currentTime + visibleDur / 2;
    } else {
      viewStart = 0;
      viewEnd = dur;
    }

    // Helper: Map audio time to canvas X coordinate
    const timeToX = (t) => {
      if (isScrolling) {
        return centerX + ((t - this.currentTime) / visibleDur) * w;
      } else {
        return (t / dur) * w;
      }
    };

    // Helper: Map canvas X coordinate to audio time
    const xToTime = (x) => {
      if (isScrolling) {
        return this.currentTime + ((x - centerX) / w) * visibleDur;
      } else {
        return (x / w) * dur;
      }
    };

    // --- 1. Lead-In Pre-Track Silence (Hatched Grid) ---
    const startX = timeToX(0);
    if (startX > 0) {
      ctx.fillStyle = 'rgba(10, 14, 20, 0.95)';
      ctx.fillRect(0, 0, startX, mainH);
      ctx.strokeStyle = '#1c2533';
      ctx.lineWidth = 1;
      const step = 20;
      for (let x = (startX % step) - step; x < startX; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x + step, mainH);
        ctx.stroke();
      }
      // Track Start Line (0:00)
      ctx.strokeStyle = (this.deckNum === 1) ? '#00e5ff' : '#ff8c00';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(startX, 0);
      ctx.lineTo(startX, mainH);
      ctx.stroke();

      ctx.fillStyle = (this.deckNum === 1) ? '#00e5ff' : '#ff8c00';
      ctx.font = 'bold 9px monospace';
      ctx.fillText('START 0:00', startX + 4, 12);
    }

    // --- 2. Run-Out Post-Track Silence ---
    const endX = timeToX(dur);
    if (endX < w) {
      ctx.fillStyle = 'rgba(10, 14, 20, 0.95)';
      ctx.fillRect(endX, 0, w - endX, mainH);
      ctx.strokeStyle = '#1c2533';
      ctx.lineWidth = 1;
      const step = 20;
      for (let x = endX; x < w; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x + step, mainH);
        ctx.stroke();
      }
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(endX, 0);
      ctx.lineTo(endX, mainH);
      ctx.stroke();

      ctx.fillStyle = '#ef4444';
      ctx.font = 'bold 9px monospace';
      ctx.fillText('END', endX - 26, 12);
    }

    // --- 3. Render VirtualDJ Multi-Band Layered Waveform Slices ---
    // VirtualDJ Signature Geometry: 2.0px crisp vertical transient bars + 1.0px dark slit gap
    const sliceW = 2.0;
    const gap = 1.0;
    const sliceStep = sliceW + gap; // 3.0px total step per slice

    for (let x = 0; x < w; x += sliceStep) {
      const t = xToTime(x + sliceW / 2);
      if (t < 0 || t > dur) continue;

      const sample = this.sampleWaveformAt(t, dur);
      const tot = sample.tot;
      const r = sample.r;
      const g = sample.g;
      const b = sample.b;

      // Total bar height (symmetrical positive/negative)
      const totalH = Math.max(1.5, tot * maxBarH);

      // ─── LAYER 1: High Frequencies (Electric Cyan Needle Spikes) ───
      ctx.fillStyle = '#00f0ff';
      ctx.fillRect(x, midY - totalH, sliceW, totalH * 2);

      // Glowing needle crest caps (top & bottom tips)
      if (totalH > 6) {
        ctx.fillStyle = '#e0f7ff';
        ctx.fillRect(x, midY - totalH, sliceW, 1.5);
        ctx.fillRect(x, midY + totalH - 1.5, sliceW, 1.5);
      }

      // ─── LAYER 2: Mid Frequencies (Neon Lime Green / Body / Vocals) ───
      const midRatio = Math.max(0.15, Math.min(0.92, g / Math.max(0.01, tot)));
      const midH = Math.max(1, Math.min(totalH - 1, totalH * (0.32 + 0.68 * midRatio)));
      ctx.fillStyle = '#00e676';
      ctx.fillRect(x, midY - midH, sliceW, midH * 2);

      // ─── LAYER 3: Bass / Kicks / 808 Sub (Blazing Crimson Red Core) ───
      const lowRatio = Math.max(0.0, Math.min(1.0, r / Math.max(0.01, tot)));
      if (lowRatio > 0.12) {
        const lowH = Math.max(1, Math.min(midH - 1, totalH * (0.18 + 0.82 * lowRatio)));
        ctx.fillStyle = '#ff1744';
        ctx.fillRect(x, midY - lowH, sliceW, lowH * 2);
      }

      // ─── LAYER 4: VirtualDJ Center Zero-Crossing Hairline ───
      ctx.fillStyle = 'rgba(7, 9, 14, 0.75)';
      ctx.fillRect(x, midY - 0.5, sliceW, 1);
    }

    // --- 4. Transition Zone Shaded Highlight (on outgoing or incoming deck) ---
    if (this.transitionZone && this.transitionZone.duration > 0) {
      const zStart = this.transitionZone.start;
      const zEnd = zStart + this.transitionZone.duration;
      const zX1 = timeToX(zStart);
      const zX2 = timeToX(zEnd);

      if (zX2 > 0 && zX1 < w) {
        const drawX1 = Math.max(0, zX1);
        const drawX2 = Math.min(w, zX2);
        ctx.fillStyle = 'rgba(157, 78, 221, 0.20)';
        ctx.fillRect(drawX1, 0, drawX2 - drawX1, mainH);

        ctx.strokeStyle = 'rgba(192, 132, 252, 0.9)';
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.5;
        if (zX1 >= 0 && zX1 <= w) {
          ctx.beginPath(); ctx.moveTo(zX1, 0); ctx.lineTo(zX1, mainH); ctx.stroke();
        }
        if (zX2 >= 0 && zX2 <= w) {
          ctx.beginPath(); ctx.moveTo(zX2, 0); ctx.lineTo(zX2, mainH); ctx.stroke();
        }
        ctx.setLineDash([]);

        // Transition Label
        if (zX1 + 10 < w && zX2 > 10) {
          ctx.fillStyle = '#d8b4fe';
          ctx.font = 'bold 9px monospace';
          ctx.fillText('TRANSITION DROP WINDOW // BASS SWAP', Math.max(8, zX1 + 6), 25);
        }
      }
    }

    // --- 5. VirtualDJ Beatgrid Lines & Beat Numbers (1, 2, 3, 4) ---
    if (this.trackData.beat_times && this.trackData.beat_times.length > 0) {
      const downbeatSet = new Set(this.trackData.downbeat_times || []);
      const phraseSet = new Set(this.trackData.phrase_16_times || []);
      const beats = this.trackData.beat_times;

      let beatInBar = 1;

      for (let idx = 0; idx < beats.length; idx++) {
        const t = beats[idx];
        const isDownbeat = downbeatSet.has(t) || (idx % 4 === 0);
        const isPhrase = phraseSet.has(t) || (idx % 64 === 0);

        if (isDownbeat) {
          beatInBar = 1;
        }

        if (t >= viewStart - 0.5 && t <= viewEnd + 0.5) {
          const x = Math.round(timeToX(t));
          if (x >= -15 && x <= w + 15) {
            if (isPhrase) {
              // 16-Bar Phrase: Vivid Purple full line
              ctx.strokeStyle = '#c084fc';
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.moveTo(x, 14);
              ctx.lineTo(x, mainH);
              ctx.stroke();

              // VirtualDJ Phrase Pill Badge at top
              ctx.fillStyle = '#9333ea';
              ctx.fillRect(x - 12, 1, 24, 12);
              ctx.fillStyle = '#ffffff';
              ctx.font = 'bold 8px -apple-system, sans-serif';
              ctx.textAlign = 'center';
              ctx.fillText('16B', x, 10);
              ctx.textAlign = 'left';

            } else if (isDownbeat) {
              // Beat 1 (Downbeat): Deck Color Accent Line
              const deckColor = (this.deckNum === 1) ? '#00e5ff' : '#ff8c00';
              ctx.strokeStyle = deckColor;
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.moveTo(x, 14);
              ctx.lineTo(x, mainH);
              ctx.stroke();

              // VirtualDJ Downbeat [ 1 ] Badge
              ctx.fillStyle = deckColor;
              ctx.fillRect(x - 6, 1, 12, 12);
              ctx.fillStyle = '#000000';
              ctx.font = 'bold 9px -apple-system, sans-serif';
              ctx.textAlign = 'center';
              ctx.fillText('1', x, 10);
              ctx.textAlign = 'left';

            } else {
              // Beats 2, 3, 4: Clean vertical tick + number
              ctx.strokeStyle = 'rgba(255, 255, 255, 0.20)';
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(x, 14);
              ctx.lineTo(x, mainH - 2);
              ctx.stroke();

              // VirtualDJ Beat Number (2, 3, 4)
              ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
              ctx.font = 'bold 8px monospace';
              ctx.textAlign = 'center';
              ctx.fillText(String(beatInBar), x, 10);
              ctx.textAlign = 'left';
            }
          }
        }

        beatInBar = (beatInBar % 4) + 1;
      }
    }

    // --- 6. Hot Cues (1: INTRO, 2: VERSE, 3: DROP, 4: OUTRO) ---
    const cueDefs = [
      { key: 'cue_1', label: '1 INTRO', color: '#10b981' },
      { key: 'cue_2', label: '2 VERSE', color: '#0ea5e9' },
      { key: 'cue_3', label: '3 DROP',  color: '#ec4899' },
      { key: 'cue_4', label: '4 OUTRO', color: '#f97316' }
    ];

    const hotCues = this.trackData.hot_cues || {
      cue_1: (this.trackData.suggested_cue_intro !== undefined) ? this.trackData.suggested_cue_intro : 0,
      cue_2: (this.trackData.suggested_cue_verse !== undefined) ? this.trackData.suggested_cue_verse : ((this.trackData.duration || 180) * 0.25),
      cue_3: (this.trackData.suggested_cue_drop !== undefined) ? this.trackData.suggested_cue_drop : ((this.trackData.duration || 180) * 0.50),
      cue_4: (this.trackData.suggested_cue_outro !== undefined) ? this.trackData.suggested_cue_outro : Math.max(0, (this.trackData.duration || 180) - 30)
    };

    cueDefs.forEach(cd => {
      const t = hotCues[cd.key];
      if (t !== undefined && t !== null) {
        const x = timeToX(t);
        if (x >= -20 && x <= w + 20) {
          ctx.strokeStyle = cd.color;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x, 14);
          ctx.lineTo(x, mainH);
          ctx.stroke();

          ctx.fillStyle = cd.color;
          ctx.beginPath();
          ctx.moveTo(x - 5, 14);
          ctx.lineTo(x + 5, 14);
          ctx.lineTo(x, 21);
          ctx.fill();

          ctx.fillStyle = cd.color;
          ctx.fillRect(x + 2, 14, 42, 11);
          ctx.fillStyle = '#000000';
          ctx.font = 'bold 8px -apple-system, sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText(cd.label, x + 4, 22);
        }
      }
    });

    // --- 7. VirtualDJ Center Playhead Needle ---
    if (isScrolling) {
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur = 6;

      // Vertical White Needle
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(centerX, 0);
      ctx.lineTo(centerX, mainH);
      ctx.stroke();

      // Top White Pointer Triangle (pointing down ▼)
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(centerX - 6, 0);
      ctx.lineTo(centerX + 6, 0);
      ctx.lineTo(centerX, 8);
      ctx.closePath();
      ctx.fill();

      // Bottom White Pointer Triangle (pointing up ▲)
      ctx.beginPath();
      ctx.moveTo(centerX - 6, mainH);
      ctx.lineTo(centerX + 6, mainH);
      ctx.lineTo(centerX, mainH - 8);
      ctx.closePath();
      ctx.fill();

      ctx.shadowBlur = 0;

      // Illuminated Center Diamond / Pip
      const deckColor = (this.deckNum === 1) ? '#00e5ff' : '#ff8c00';
      ctx.fillStyle = deckColor;
      ctx.beginPath();
      ctx.arc(centerX, midY, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      // In overview mode, playhead travels across
      const playX = timeToX(this.currentTime);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.moveTo(playX, 0);
      ctx.lineTo(playX, mainH);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // --- 8. Mini Full-Track Overview Strip at Bottom ---
    this.drawOverviewStrip(w, h, overviewY, overviewH);
  }

  /**
   * Renders the mini full-track overview strip along the bottom 17px
   * in VirtualDJ 3-band colors with illuminated zoom bracket.
   */
  drawOverviewStrip(w, h, overviewY, overviewH) {
    const ctx = this.ctx;
    const dur = (this.trackData && this.trackData.duration) ? this.trackData.duration : 180;
    const visibleDur = this.getVisibleDuration();

    // Strip background
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, overviewY, w, overviewH);
    ctx.strokeStyle = '#121820';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, overviewY);
    ctx.lineTo(w, overviewY);
    ctx.stroke();

    if (!this.trackData || !this.trackData.waveform) return;

    const midY = overviewY + (overviewH / 2);
    const maxH = (overviewH / 2) - 1.5;

    // Mini compressed waveform in VirtualDJ 3-band colors
    const overviewStep = 2.0;
    for (let x = 0; x < w; x += overviewStep) {
      const t = (x / w) * dur;
      const sample = this.sampleWaveformAt(t, dur);
      const totH = Math.max(1, sample.tot * maxH);
      const lowH = Math.max(0, sample.r * maxH);

      // Mid/High background bar
      ctx.fillStyle = (this.deckNum === 1) ? 'rgba(0, 229, 255, 0.55)' : 'rgba(255, 140, 0, 0.55)';
      ctx.fillRect(x, midY - totH, 1.5, totH * 2);

      // Low kick core
      if (lowH > 0.5) {
        ctx.fillStyle = 'rgba(255, 23, 68, 0.85)';
        ctx.fillRect(x, midY - lowH, 1.5, lowH * 2);
      }
    }

    // Hot Cue markers on mini overview
    const overviewCues = this.trackData.hot_cues || {
      cue_1: (this.trackData.suggested_cue_intro !== undefined) ? this.trackData.suggested_cue_intro : 0,
      cue_2: (this.trackData.suggested_cue_verse !== undefined) ? this.trackData.suggested_cue_verse : (dur * 0.25),
      cue_3: (this.trackData.suggested_cue_drop !== undefined) ? this.trackData.suggested_cue_drop : (dur * 0.50),
      cue_4: (this.trackData.suggested_cue_outro !== undefined) ? this.trackData.suggested_cue_outro : Math.max(0, dur - 30)
    };
    const cueColors = { cue_1: '#10b981', cue_2: '#0ea5e9', cue_3: '#ec4899', cue_4: '#f97316' };
    Object.entries(overviewCues).forEach(([k, t]) => {
      if (t !== undefined && t !== null) {
        const cx = (t / dur) * w;
        ctx.fillStyle = cueColors[k] || '#10b981';
        ctx.fillRect(cx - 1.5, overviewY + 1, 3, overviewH - 2);
      }
    });

    // Visible window illuminated bracket in scrolling mode
    if (this.mode === 'scroll') {
      const winLeft = Math.max(0, ((this.currentTime - visibleDur / 2) / dur) * w);
      const winRight = Math.min(w, ((this.currentTime + visibleDur / 2) / dur) * w);
      const winW = Math.max(6, winRight - winLeft);

      ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.fillRect(winLeft, overviewY, winW, overviewH);

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(winLeft, overviewY, winW, overviewH);

      // Bracket handles
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(winLeft, overviewY, 2, overviewH);
      ctx.fillRect(winLeft + winW - 2, overviewY, 2, overviewH);
    }

    // Current playhead position cursor on mini overview
    const pipX = Math.max(0, Math.min(w, (this.currentTime / dur) * w));
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 4;
    ctx.fillRect(pipX - 1, overviewY, 2, overviewH);
    ctx.shadowBlur = 0;
  }
}

window.RGBWaveform = RGBWaveform;
