/**
 * knobs.js - Rotary knobs over the mixer's range inputs.
 *
 * The <input type="range"> inside each .knob stays the source of truth: app.js reads and writes
 * its value and listens to its 'input' events, and it keeps keyboard control (arrow keys). This
 * only draws the knob (pointer + value ring, 0 at twelve o'clock) and turns vertical drags and
 * double-clicks into input changes. Knobs follow programmatic changes too (transition automation
 * moves the EQs), by redrawing every animation frame when a value changed.
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
      startY = e.clientY;
      startV = parseFloat(input.value);
    });
    el.addEventListener('pointermove', (e) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      const range = parseFloat(input.max) - parseFloat(input.min);
      const fine = e.shiftKey ? 0.25 : 1;
      setValue(input, startV + ((startY - e.clientY) / DRAG_PX) * range * fine);
    });
    el.addEventListener('pointerup', (e) => el.releasePointerCapture(e.pointerId));
    el.addEventListener('dblclick', () => setValue(input, 0));
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const range = parseFloat(input.max) - parseFloat(input.min);
      setValue(input, parseFloat(input.value) - Math.sign(e.deltaY) * range / 60);
    }, { passive: false });
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
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
})();
