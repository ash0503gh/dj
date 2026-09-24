/**
 * knobs.js - Rotary knobs and hardware faders over the console's range inputs.
 *
 * The <input type="range"> inside each .knob / .fader stays the source of truth: app.js reads and
 * writes its value and listens to its 'input' events, and it keeps keyboard control (arrow keys).
 * This only draws the control (knob pointer + value ring with 0 at twelve o'clock; fader slot,
 * scale and cap) and turns drags, wheel and double-clicks into input changes. Browsers draw
 * vertical native sliders inconsistently, so faders never rely on that. Controls follow
 * programmatic changes too (transition automation moves EQs and faders), by redrawing every
 * animation frame when a value changed.
 */
(() => {
  const SWEEP = 135;       // degrees either side of twelve o'clock
  const DRAG_PX = 160;     // pixels of vertical drag for the full range

  function angleOf(input) {
    const v = parseFloat(input.value), min = parseFloat(input.min), max = parseFloat(input.max);
    // Centered on 0 when the range spans it (EQ: -24..+6 dB, filter: -50..+50)
    if (min < 0 && max > 0) return v < 0 ? -SWEEP * (v / min) : SWEEP * (v / max);
    return -SWEEP + 2 * SWEEP * ((v - min) / (max - min));
  }

  function setValue(input, v) {
    const min = parseFloat(input.min), max = parseFloat(input.max);
    const step = parseFloat(input.step) || 1;
    const next = Math.round(Math.max(min, Math.min(max, v)) / step) * step;
    if (parseFloat(input.value) === next) return;
    input.value = next;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const knobs = [];
  document.querySelectorAll('.knob').forEach((el) => {
    const input = el.querySelector('input[type="range"]');
    if (!input) return;
    const ring = document.createElement('span');
    ring.className = 'knob-ring';
    const cap = document.createElement('span');
    cap.className = 'knob-cap';
    el.append(ring, cap);
    const knob = { el, input, last: null };
    knobs.push(knob);

    let startY = 0, startV = 0;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      input.focus({ preventScroll: true });
      el.setPointerCapture(e.pointerId);
      startY = UI.local(e, el).y;
      startV = parseFloat(input.value);
    });
    el.addEventListener('pointermove', (e) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      const range = parseFloat(input.max) - parseFloat(input.min);
      const fine = e.shiftKey ? 0.25 : 1;
      setValue(input, startV + ((startY - UI.local(e, el).y) / DRAG_PX) * range * fine);
    });
    el.addEventListener('pointerup', (e) => el.releasePointerCapture(e.pointerId));
    el.addEventListener('dblclick', () => setValue(input, 0));
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const range = parseFloat(input.max) - parseFloat(input.min);
      setValue(input, parseFloat(input.value) - Math.sign(e.deltaY) * range / 60);
    }, { passive: false });
  });

  // ── Faders: .fader wraps a range input; .fader-v runs bottom (min) to top (max) ──
  const faders = [];
  document.querySelectorAll('.fader').forEach((el) => {
    const input = el.querySelector('input[type="range"]');
    if (!input) return;
    const vertical = el.classList.contains('fader-v');
    const ticks = document.createElement('span');
    ticks.className = 'fader-ticks';
    const count = parseInt(el.dataset.ticks || '10', 10);
    for (let i = 0; i <= count; i++) {
      const t = document.createElement('span');
      t.style.setProperty('--at', (i / count).toFixed(4));
      if (el.dataset.center !== undefined && i === count / 2) t.className = 'major';
      ticks.append(t);
    }
    const slot = document.createElement('span');
    slot.className = 'fader-slot';
    const cap = document.createElement('span');
    cap.className = 'fader-cap';
    el.append(ticks, slot, cap);
    const fader = { el, input, last: null };
    faders.push(fader);

    let start = 0, startV = 0;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      input.focus({ preventScroll: true });
      el.setPointerCapture(e.pointerId);
      const p = UI.local(e, el);
      start = vertical ? p.y : p.x;
      startV = parseFloat(input.value);
    });
    el.addEventListener('pointermove', (e) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      const len = vertical ? el.clientHeight : el.clientWidth;
      const range = parseFloat(input.max) - parseFloat(input.min);
      const p = UI.local(e, el);
      const d = vertical ? start - p.y : p.x - start;
      setValue(input, startV + (d / Math.max(40, len - 24)) * range * (e.shiftKey ? 0.25 : 1));
    });
    el.addEventListener('pointerup', (e) => el.releasePointerCapture(e.pointerId));
    if (el.dataset.reset !== undefined) {
      el.addEventListener('dblclick', () => setValue(input, parseFloat(el.dataset.reset)));
    }
  });

  function draw() {
    for (const k of knobs) {
      if (k.input.value === k.last) continue;
      k.last = k.input.value;
      const a = angleOf(k.input);
      k.el.style.setProperty('--rot', a.toFixed(1));
      k.el.style.setProperty('--a0', Math.min(0, a).toFixed(1));
      k.el.style.setProperty('--span', Math.abs(a).toFixed(1));
    }
    for (const f of faders) {
      if (f.input.value === f.last) continue;
      f.last = f.input.value;
      const min = parseFloat(f.input.min), max = parseFloat(f.input.max);
      f.el.style.setProperty('--pos', ((parseFloat(f.input.value) - min) / (max - min)).toFixed(4));
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
})();
