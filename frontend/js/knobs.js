/**
 * knobs.js - Rotary knobs and hardware faders over the console's range inputs.
 *
 * The <input type="range"> inside each .knob / .fader stays the source of truth: app.js reads and
 * writes its value and listens to its 'input' events, and it keeps keyboard control (arrow keys).
 * This only draws the control (knob pointer + value ring with 0 at twelve o'clock; fader slot,
 * scale and cap) and turns drags, wheel and double-clicks into input changes. Made for a trackpad as
 * much as a mouse: a two-finger swipe turns a knob as far as the fingers travel, a drag works up or to
 * the right, the knob's label is part of the target, and the value shows while it turns. Browsers draw
 * vertical native sliders inconsistently, so faders never rely on that. Controls follow
 * programmatic changes too (transition automation moves EQs and faders), by redrawing every
 * animation frame when a value changed.
 */
(() => {
  const SWEEP = 135;       // degrees either side of twelve o'clock
  const DRAG_PX = 160;     // pixels of drag (up or right) for the full range
  const WHEEL_PX = 400;    // pixels of two-finger swipe (or wheel) for the full range
  const WHEEL_STEP = 24;   // a mouse wheel's big notch moves at most 1/WHEEL_STEP of the range

  /** Scroll distance in pixels, up = positive; a notch of a mouse wheel capped to a small step. */
  function wheelPx(e) {
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;     // lines or pages to pixels
    const px = -e.deltaY * unit;
    const cap = WHEEL_PX / WHEEL_STEP;
    return Math.max(-cap, Math.min(cap, px));
  }

  /** What a knob reads while it turns: dB for EQs, low-/high-pass for the filter, else the number. */
  function readout(input) {
    const v = parseFloat(input.value);
    if (/-eq-/.test(input.id)) return `${v > 0 ? '+' : ''}${v.toFixed(1)}dB`;
    if (/-filter$/.test(input.id)) return v < 0 ? `LP ${Math.round(-v * 2)}` : v > 0 ? `HP ${Math.round(v * 2)}` : 'OFF';
    const step = parseFloat(input.step) || 1;
    return v.toFixed(step < 1 ? 1 : 0);
  }

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

    // The knob and its label are one target (its KILL button keeps its own clicks)
    const target = el.closest('.knob-group') || el;
    const label = target.querySelector('.knob-label');
    const name = label ? label.textContent : '';
    let showing = null;
    const show = () => {               // the value in place of the label while it turns
      if (!label) return;
      target.classList.add('turning');
      label.textContent = readout(input);
      clearTimeout(showing);
      showing = setTimeout(() => { label.textContent = name; target.classList.remove('turning'); }, 900);
    };
    const mine = e => !e.target.closest('button');

    let startX = 0, startY = 0, startV = 0;
    target.addEventListener('pointerdown', (e) => {
      if (!mine(e)) return;
      e.preventDefault();
      input.focus({ preventScroll: true });
      target.setPointerCapture(e.pointerId);
      const p = UI.local(e, el);
      startX = p.x;
      startY = p.y;
      startV = parseFloat(input.value);
      show();
    });
    target.addEventListener('pointermove', (e) => {
      if (!target.hasPointerCapture(e.pointerId)) return;
      const range = parseFloat(input.max) - parseFloat(input.min);
      const fine = e.shiftKey ? 0.25 : 1;
      const p = UI.local(e, el);
      setValue(input, startV + ((startY - p.y + p.x - startX) / DRAG_PX) * range * fine);
      show();
    });
    target.addEventListener('pointerup', (e) => target.releasePointerCapture(e.pointerId));
    target.addEventListener('dblclick', (e) => { if (mine(e)) { setValue(input, 0); show(); } });
    target.addEventListener('wheel', (e) => {
      if (!mine(e)) return;
      e.preventDefault();
      const range = parseFloat(input.max) - parseFloat(input.min);
      setValue(input, parseFloat(input.value) + (wheelPx(e) / WHEEL_PX) * range * (e.shiftKey ? 0.25 : 1));
      show();
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
    // A two-finger swipe (or wheel) moves it too: up raises a vertical fader, right moves a horizontal one
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const range = parseFloat(input.max) - parseFloat(input.min);
      const px = vertical ? wheelPx(e) : Math.max(-WHEEL_PX / WHEEL_STEP, Math.min(WHEEL_PX / WHEEL_STEP, -e.deltaX || wheelPx(e)));
      setValue(input, parseFloat(input.value) + (px / WHEEL_PX) * range * (e.shiftKey ? 0.25 : 1));
    }, { passive: false });
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
