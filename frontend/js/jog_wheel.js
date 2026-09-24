/**
 * jog_wheel.js - Pioneer CDJ-3000 Style Interactive Jog Wheel
 * Renders rotating platter, touch bezel, and handles vinyl scratch & nudge.
 */

class JogWheel {
  constructor(canvasId, deckNumber, onScratch, onNudge) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');
    this.deckNum = deckNumber;
    this.onScratch = onScratch;
    this.onNudge = onNudge;
    
    this.angle = 0; // Current rotation angle in radians
    this.isDragging = false;
    this.lastAngle = 0;
    this.accentColor = deckNumber === 1 ? '#3ea6ff' : '#ff8a1f';
    
    this.setupEvents();
    this.draw();
  }

  setupEvents() {
    const getAngle = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      return Math.atan2(clientY - cy, clientX - cx);
    };

    const onStart = (e) => {
      this.isDragging = true;
      this.lastAngle = getAngle(e);
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!this.isDragging) return;
      const currentAngle = getAngle(e);
      let delta = currentAngle - this.lastAngle;
      
      // Handle wrap-around
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;
      
      this.angle += delta;
      this.lastAngle = currentAngle;
      this.draw();
      
      if (this.onScratch) {
        this.onScratch(delta);
      }
      e.preventDefault();
    };

    const onEnd = () => {
      this.isDragging = false;
    };

    this.canvas.addEventListener('mousedown', onStart);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onEnd);
    
    this.canvas.addEventListener('touchstart', onStart, { passive: false });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
  }

  updatePlayback(dt, bpm = 124, isPlaying = false) {
    if (isPlaying && !this.isDragging) {
      // 33.33 RPM standard vinyl speed or proportional to BPM (approx 1 rev per 2 beats)
      const rps = (bpm / 60) / 2;
      this.angle += rps * Math.PI * 2 * dt;
      this.draw();
    }
  }

  draw() {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const radius = w / 2 - 6;
    const ctx = this.ctx;

    ctx.clearRect(0, 0, w, h);

    // Outer Silver/Charcoal Bezel (Knurled ring)
    const gradBezel = ctx.createLinearGradient(0, 0, w, h);
    gradBezel.addColorStop(0, '#2a2a30');
    gradBezel.addColorStop(0.5, '#1b1b1f');
    gradBezel.addColorStop(1, '#121214');

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = gradBezel;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#34343a';
    ctx.stroke();

    // Grooved Vinyl Platter
    ctx.beginPath();
    ctx.arc(cx, cy, radius - 14, 0, Math.PI * 2);
    ctx.fillStyle = '#0e0e10';
    ctx.fill();

    // Vinyl grooves
    ctx.lineWidth = 1;
    for (let r = radius - 20; r > 45; r -= 6) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
      ctx.stroke();
    }

    // Illuminated Neon Ring (Pioneer Jog Ring)
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this.angle);

    ctx.beginPath();
    ctx.arc(0, 0, radius - 15, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 4;
    ctx.stroke();

    // Illuminated marker (playhead cue indicator)
    const markerAngle = 0;
    ctx.beginPath();
    ctx.arc(0, 0, radius - 15, -0.2, 0.2);
    ctx.strokeStyle = this.accentColor;
    ctx.lineWidth = 5;
    ctx.shadowColor = this.accentColor;
    ctx.shadowBlur = 12;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 4 LED tick marks along perimeter
    for (let i = 0; i < 4; i++) {
      ctx.rotate(Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(radius - 22, 0);
      ctx.lineTo(radius - 16, 0);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.restore();
  }
}

window.JogWheel = JogWheel;
