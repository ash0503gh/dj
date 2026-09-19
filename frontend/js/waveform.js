/**
 * waveform.js - Pioneer Rekordbox 3-Band RGB Waveform Visualizer
 * Visualizes Low (Red), Mid (Green), High (Blue) frequency bands with
 * beat markers, downbeats, phrase boundaries, and live playback scrolling.
 */

class RGBWaveform {
  constructor(canvasId, deckNumber, onSeek) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');
    this.deckNum = deckNumber;
    this.onSeek = onSeek;
    
    this.trackData = null;
    this.currentTime = 0;
    this.zoom = 1.0; // 1.0 = overview, >1 = zoomed beatgrid
    this.isDragging = false;
    
    this.setupEvents();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    this.canvas.width = this.canvas.parentElement.clientWidth;
    this.draw();
  }

  loadTrack(trackData) {
    this.trackData = trackData;
    this.currentTime = 0;
    this.draw();
  }

  setTime(time) {
    this.currentTime = time;
    this.draw();
  }

  setupEvents() {
    const handleSeek = (e) => {
      if (!this.trackData || !this.trackData.duration) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, x / rect.width));

      // Map click position to actual time based on visible window
      const dur = this.trackData.duration;
      const visibleDur = dur / this.zoom;
      const center = Math.max(visibleDur / 2, Math.min(dur - visibleDur / 2, this.currentTime));
      const viewStart = center - visibleDur / 2;
      const targetTime = viewStart + ratio * visibleDur;
      if (this.onSeek) this.onSeek(Math.max(0, Math.min(dur, targetTime)));
    };

    this.canvas.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      handleSeek(e);
    });

    window.addEventListener('mousemove', (e) => {
      if (this.isDragging) handleSeek(e);
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
    });
  }

  draw() {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const ctx = this.ctx;

    ctx.fillStyle = '#080a0e';
    ctx.fillRect(0, 0, w, h);

    if (!this.trackData || !this.trackData.waveform) {
      // Empty grid lines
      ctx.strokeStyle = '#151b24';
      ctx.lineWidth = 1;
      for (let x = 0; x < w; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      return;
    }

    const wf = this.trackData.waveform;
    const bins = wf.overall.length;
    const midY = h / 2;
    const dur = this.trackData.duration;

    // Compute visible time window
    const visibleDur = dur / this.zoom;
    const center = Math.max(visibleDur / 2, Math.min(dur - visibleDur / 2, this.currentTime));
    const viewStart = center - visibleDur / 2;
    const viewEnd = viewStart + visibleDur;

    // Map bins to visible window
    const startBin = Math.floor((viewStart / dur) * bins);
    const endBin = Math.ceil((viewEnd / dur) * bins);
    const visibleBins = endBin - startBin;
    const barWidth = Math.max(1, w / visibleBins);

    // Draw RGB frequency peaks
    for (let i = startBin; i < endBin && i < bins; i++) {
      if (i < 0) continue;
      const x = ((i - startBin) / visibleBins) * w;

      const r = wf.low_red[i] || 0;
      const g = wf.mid_green[i] || 0;
      const b = wf.high_blue[i] || 0;
      const tot = wf.overall[i] || 0;

      const barHeight = Math.max(2, tot * (midY - 4));

      const redByte = Math.min(255, Math.floor(r * 255 * 1.3));
      const greenByte = Math.min(255, Math.floor(g * 255 * 1.1));
      const blueByte = Math.min(255, Math.floor(b * 255 * 1.4));

      ctx.fillStyle = `rgb(${redByte}, ${greenByte}, ${blueByte})`;
      ctx.fillRect(x, midY - barHeight, barWidth + 0.5, barHeight * 2);
    }

    // Draw Beatgrid lines (only those in visible window)
    if (this.trackData.beat_times) {
      const downbeats = new Set(this.trackData.downbeat_times || []);
      const phrases = new Set(this.trackData.phrase_16_times || []);

      for (let t of this.trackData.beat_times) {
        if (t < viewStart || t > viewEnd) continue;
        const x = ((t - viewStart) / visibleDur) * w;
        if (x < 0 || x > w) continue;

        if (phrases.has(t)) {
          ctx.strokeStyle = '#c084fc';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, h);
          ctx.stroke();
        } else if (downbeats.has(t)) {
          ctx.strokeStyle = this.deckNum === 1 ? '#00e5ff' : '#ff8c00';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x, 4);
          ctx.lineTo(x, h - 4);
          ctx.stroke();
        } else {
          // Only show quarter beats when zoomed in enough
          if (this.zoom >= 1.5) {
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, midY - 10);
            ctx.lineTo(x, midY + 10);
            ctx.stroke();
          }
        }
      }
    }

    // Draw Cue Points
    if (this.trackData.suggested_cue_intro) {
      const t = this.trackData.suggested_cue_intro;
      if (t >= viewStart && t <= viewEnd) {
        const introX = ((t - viewStart) / visibleDur) * w;
        ctx.fillStyle = '#10b981';
        ctx.fillRect(introX - 2, 0, 4, 14);
      }
    }
    if (this.trackData.suggested_cue_outro) {
      const t = this.trackData.suggested_cue_outro;
      if (t >= viewStart && t <= viewEnd) {
        const outroX = ((t - viewStart) / visibleDur) * w;
        ctx.fillStyle = '#ef4444';
        ctx.fillRect(outroX - 2, h - 14, 4, 14);
      }
    }

    // Draw Playhead
    if (dur > 0) {
      const playheadX = ((this.currentTime - viewStart) / visibleDur) * w;
      if (playheadX >= 0 && playheadX <= w) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.shadowColor = '#ffffff';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.moveTo(playheadX, 0);
        ctx.lineTo(playheadX, h);
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    }
  }
}

window.RGBWaveform = RGBWaveform;
