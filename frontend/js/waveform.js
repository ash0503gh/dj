/**
 * waveform.js - Pioneer Rekordbox 3-Band RGB Dynamic Waveform Visualizer
 * Features:
 * - Real-Time 60 FPS Continuous Scrolling Waveform under Center Playhead (50%)
 * - 3-Band RGB Frequency Separation (Deep Bass Red, Mid Vocal Green, High Air Blue)
 * - Dynamic Beatgrid Tracking (Quarter Beats, Downbeat Bar Starts, 16-Bar Phrases)
 * - Cue Markers (Intro Green, Outro Red) and Transition Zone Highlight
 * - Built-in Mini Full-Track Overview Strip with Position Scrubber
 * - Lead-In (Pre-Track) and Run-Out (Post-Track) Hatch Rendering
 * - Seamless Zoom (0.5x, 1.0x, 1.5x, 2.0x, 3.0x, 4.0x) and Full Overview Mode
 * - Fallback Synthesizer: Guarantees immediate rich waveform display without blank state
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
    this.mode = 'scroll'; // 'scroll' (CDJ style) or 'overview' (full track)
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
    // Ensure waveform exists or synthesize fallback immediately
    if (this.trackData && (!this.trackData.waveform || !this.trackData.waveform.overall || this.trackData.waveform.overall.length === 0)) {
      this.trackData.waveform = this.synthesizeWaveform(
        this.trackData.duration || 180,
        this.trackData.bpm || 128
      );
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
    // Standard Pioneer CDJ club view: 16.0 seconds visible at 1.0x (~8 bars / 32 beats at 128 BPM)
    const baseWindow = 16.0;
    return Math.max(2.0, baseWindow / Math.max(0.25, this.zoom));
  }

  synthesizeWaveform(duration = 180, bpm = 128) {
    const bins = 800;
    const spb = 60.0 / Math.max(60, bpm);
    const overall = [];
    const low = [];
    const mid = [];
    const high = [];

    for (let i = 0; i < bins; i++) {
      const t = (i / bins) * duration;
      const beatProgress = (t % spb) / spb;
      
      // Kick drum transient on beat 1 of each beat
      const kick = beatProgress < 0.18 ? Math.cos(beatProgress * Math.PI * 2.7) : 0;
      // Snare on offbeats
      const snare = (beatProgress > 0.45 && beatProgress < 0.65) ? 0.65 : 0;
      // High hat ticks
      const hihat = (beatProgress > 0.22 && beatProgress < 0.32) || (beatProgress > 0.72 && beatProgress < 0.82) ? 0.4 : 0;
      
      // Macro energy envelope (intro, verse, drop, breakdown, drop 2, outro)
      const normT = t / duration;
      let macro = 0.55;
      if (normT < 0.15) macro = 0.2 + (normT / 0.15) * 0.4; // Intro build
      else if (normT < 0.45) macro = 0.85; // Drop 1
      else if (normT < 0.55) macro = 0.35; // Breakdown
      else if (normT < 0.85) macro = 0.95; // Peak Drop 2
      else macro = 0.85 - ((normT - 0.85) / 0.15) * 0.6; // Outro fade

      const totVal = Math.min(1.0, Math.max(0.08, (macro * 0.6 + kick * 0.35 + snare * 0.2 + hihat * 0.15)));
      overall.push(Math.round(totVal * 1000) / 1000);
      low.push(Math.round(Math.min(1.0, (kick * 0.85 + macro * 0.4)) * 1000) / 1000);
      mid.push(Math.round(Math.min(1.0, (snare * 0.75 + macro * 0.5)) * 1000) / 1000);
      high.push(Math.round(Math.min(1.0, (hihat * 0.7 + macro * 0.3)) * 1000) / 1000);
    }
    return { overall, low, mid, high };
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

    // Background fill
    ctx.fillStyle = '#080a0e';
    ctx.fillRect(0, 0, w, h);

    const mainH = 74; // Top 74px: Main Scrolling Waveform
    const overviewY = 74; // Bottom 16px: Mini Full-Track Overview
    const overviewH = 16;
    const midY = mainH / 2;
    const centerX = w * 0.5; // Locked center playhead line (50%)

    // If no track data, draw idle grid lines
    if (!this.trackData) {
      ctx.strokeStyle = '#151b24';
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

    // Helper: Map time to X coordinate on canvas
    const timeToX = (t) => {
      if (isScrolling) {
        return centerX + ((t - this.currentTime) / visibleDur) * w;
      } else {
        return (t / dur) * w;
      }
    };

    // --- 1. Lead-In Pre-Track Silence (Hatched Grid) ---
    const startX = timeToX(0);
    if (startX > 0) {
      ctx.fillStyle = 'rgba(12, 16, 24, 0.95)';
      ctx.fillRect(0, 0, startX, mainH);
      ctx.strokeStyle = '#1e293b';
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
      ctx.fillStyle = 'rgba(12, 16, 24, 0.95)';
      ctx.fillRect(endX, 0, w - endX, mainH);
      ctx.strokeStyle = '#1e293b';
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
      ctx.fillText('END', endX - 25, 12);
    }

    // --- 3. Render 3-Band RGB Frequency Waveform Bars ---
    let wf = this.trackData.waveform;
    if (!wf || !wf.overall || wf.overall.length === 0) {
      wf = this.synthesizeWaveform(dur, this.trackData.bpm || 128);
      this.trackData.waveform = wf;
    }

    const bins = wf.overall.length;
    const dtPerBin = dur / bins;
    const binPixelWidth = isScrolling 
      ? Math.max(1.5, (dtPerBin / visibleDur) * w) 
      : Math.max(1.0, w / bins);

    const startBin = Math.max(0, Math.floor((viewStart / dur) * bins));
    const endBin = Math.min(bins, Math.ceil((viewEnd / dur) * bins) + 1);

    const maxBarH = midY - 6;

    for (let i = startBin; i < endBin; i++) {
      const t = (i / bins) * dur;
      const x = timeToX(t);
      if (x + binPixelWidth < 0 || x > w) continue;

      const tot = wf.overall[i] || 0;
      const r = wf.low_red[i] || 0;
      const g = wf.mid_green[i] || 0;
      const b = wf.high_blue[i] || 0;

      const barH = Math.max(2, tot * maxBarH);

      // Rekordbox 3-Band RGB blend
      const redByte = Math.min(255, Math.floor((r * 0.75 + tot * 0.35) * 255 * 1.3));
      const greenByte = Math.min(255, Math.floor((g * 0.75 + tot * 0.25) * 255 * 1.1));
      const blueByte = Math.min(255, Math.floor((b * 0.75 + tot * 0.35) * 255 * 1.4));

      ctx.fillStyle = `rgb(${redByte}, ${greenByte}, ${blueByte})`;
      ctx.fillRect(x, midY - barH, binPixelWidth, barH * 2);

      // Low frequency punch core (warm red/orange interior)
      if (r > 0.15) {
        const lowH = Math.max(1, r * (maxBarH * 0.55));
        ctx.fillStyle = 'rgba(255, 45, 85, 0.85)';
        ctx.fillRect(x, midY - lowH, binPixelWidth, lowH * 2);
      }
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
        ctx.fillStyle = 'rgba(157, 78, 221, 0.16)';
        ctx.fillRect(drawX1, 0, drawX2 - drawX1, mainH);

        ctx.strokeStyle = 'rgba(157, 78, 221, 0.8)';
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.5;
        if (zX1 >= 0 && zX1 <= w) {
          ctx.beginPath(); ctx.moveTo(zX1, 0); ctx.lineTo(zX1, mainH); ctx.stroke();
        }
        if (zX2 >= 0 && zX2 <= w) {
          ctx.beginPath(); ctx.moveTo(zX2, 0); ctx.lineTo(zX2, mainH); ctx.stroke();
        }
        ctx.setLineDash([]);

        // Label
        if (zX1 + 10 < w && zX2 > 10) {
          ctx.fillStyle = '#c084fc';
          ctx.font = 'bold 9px monospace';
          ctx.fillText('TRANSITION ZONE // BASS SWAP', Math.max(6, zX1 + 6), 24);
        }
      }
    }

    // --- 5. Beatgrid Lines (Quarter Beats, Downbeats, 16-Bar Phrases) ---
    if (this.trackData.beat_times && this.trackData.beat_times.length > 0) {
      const downbeats = new Set(this.trackData.downbeat_times || []);
      const phrases = new Set(this.trackData.phrase_16_times || []);

      for (let t of this.trackData.beat_times) {
        if (t < viewStart - 0.5 || t > viewEnd + 0.5) continue;
        const x = timeToX(t);
        if (x < -2 || x > w + 2) continue;

        if (phrases.has(t)) {
          // 16-Bar Phrase Boundary: Vivid Purple
          ctx.strokeStyle = '#c084fc';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, mainH);
          ctx.stroke();

          ctx.fillStyle = '#c084fc';
          ctx.font = 'bold 9px monospace';
          ctx.fillText('16B', x + 3, 10);
        } else if (downbeats.has(t)) {
          // Downbeat (Bar 1): Deck Accent Color (Deck 1 Cyan, Deck 2 Orange)
          ctx.strokeStyle = (this.deckNum === 1) ? '#00e5ff' : '#ff8c00';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x, 4);
          ctx.lineTo(x, mainH - 4);
          ctx.stroke();
        } else {
          // Regular quarter beat ticks
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, midY - 10);
          ctx.lineTo(x, midY + 10);
          ctx.stroke();
        }
      }
    }

    // --- 6. Cue Markers (Green IN, Red OUT) ---
    if (this.trackData.suggested_cue_intro !== undefined) {
      const t = this.trackData.suggested_cue_intro;
      const x = timeToX(t);
      if (x >= -10 && x <= w + 10) {
        ctx.fillStyle = '#10b981';
        ctx.fillRect(x - 2, 0, 4, 15);
        ctx.beginPath();
        ctx.moveTo(x - 6, 0);
        ctx.lineTo(x + 6, 0);
        ctx.lineTo(x, 8);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 8px sans-serif';
        ctx.fillText('IN', x + 4, 11);
      }
    }

    if (this.trackData.suggested_cue_outro !== undefined) {
      const t = this.trackData.suggested_cue_outro;
      const x = timeToX(t);
      if (x >= -10 && x <= w + 10) {
        ctx.fillStyle = '#ef4444';
        ctx.fillRect(x - 2, mainH - 15, 4, 15);
        ctx.beginPath();
        ctx.moveTo(x - 6, mainH);
        ctx.lineTo(x + 6, mainH);
        ctx.lineTo(x, mainH - 8);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 8px sans-serif';
        ctx.fillText('OUT', x + 4, mainH - 3);
      }
    }

    // --- 7. Playhead Indicators ---
    if (isScrolling) {
      // In scrolling mode, center line is playhead
      ctx.fillStyle = (this.deckNum === 1) ? '#00e5ff' : '#ff8c00';
      // Top playhead arrow
      ctx.beginPath();
      ctx.moveTo(centerX - 5, 0);
      ctx.lineTo(centerX + 5, 0);
      ctx.lineTo(centerX, 7);
      ctx.fill();

      // Bottom playhead arrow
      ctx.beginPath();
      ctx.moveTo(centerX - 5, mainH);
      ctx.lineTo(centerX + 5, mainH);
      ctx.lineTo(centerX, mainH - 7);
      ctx.fill();
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

  drawOverviewStrip(w, h, overviewY, overviewH) {
    const ctx = this.ctx;
    const dur = (this.trackData && this.trackData.duration) ? this.trackData.duration : 180;
    const visibleDur = this.getVisibleDuration();

    // Strip background
    ctx.fillStyle = '#06080d';
    ctx.fillRect(0, overviewY, w, overviewH);
    ctx.strokeStyle = '#161d27';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, overviewY);
    ctx.lineTo(w, overviewY);
    ctx.stroke();

    if (!this.trackData || !this.trackData.waveform) return;

    const wf = this.trackData.waveform;
    const bins = wf.overall.length;
    const barW = Math.max(1, w / bins);
    const midY = overviewY + (overviewH / 2);
    const maxH = (overviewH / 2) - 1;

    // Mini compressed waveform
    ctx.fillStyle = (this.deckNum === 1) ? 'rgba(0, 229, 255, 0.45)' : 'rgba(255, 140, 0, 0.45)';
    for (let i = 0; i < bins; i++) {
      const x = (i / bins) * w;
      const tot = wf.overall[i] || 0;
      const bH = Math.max(1, tot * maxH);
      ctx.fillRect(x, midY - bH, barW, bH * 2);
    }

    // Cue dots on mini overview
    if (this.trackData.suggested_cue_intro) {
      const inX = (this.trackData.suggested_cue_intro / dur) * w;
      ctx.fillStyle = '#10b981';
      ctx.fillRect(inX - 1.5, overviewY + 2, 3, overviewH - 4);
    }
    if (this.trackData.suggested_cue_outro) {
      const outX = (this.trackData.suggested_cue_outro / dur) * w;
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(outX - 1.5, overviewY + 2, 3, overviewH - 4);
    }

    // Visible window bracket in scrolling mode
    if (this.mode === 'scroll') {
      const winLeft = Math.max(0, ((this.currentTime - visibleDur / 2) / dur) * w);
      const winRight = Math.min(w, ((this.currentTime + visibleDur / 2) / dur) * w);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.fillRect(winLeft, overviewY, winRight - winLeft, overviewH);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(winLeft, overviewY, Math.max(4, winRight - winLeft), overviewH);
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
