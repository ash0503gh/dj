/**
 * knobs.js - Bar sliders (EQ, filter, levels) and hardware faders over the console's range inputs.
 *
 * The <input type="range"> inside each .knob / .fader stays the source of truth: app.js reads and
 * writes its value and listens to its 'input' events, and it keeps keyboard control (arrow keys).
 * This only draws the control and turns pointer moves, swipes and double-clicks into input changes.
 *
 * A .knob is drawn as a wide horizontal bar, made for a trackpad: its value always shows beside its
 * name; a click or drag on the bar sets the value where the pointer is (with a catch at 0 dB / filter
 * off); a two-finger swipe left or right (or up and down) moves it as far as the fingers travel; a drag
 * on its name moves it relative to where it was (shift: fine); a double-click resets it. The fill runs
 * from the flat point to the value. Faders draw a slot, a scale and a cap. Browsers draw vertical
 * native sliders inconsistently, so faders never rely on that. Controls follow programmatic changes too
 * (transition automation moves EQs and faders), by redrawing every animation frame when a value changed.
 */
(() => {
  const DRAG_PX = 160;     // pixels of relative drag (right or up) for the full range
  const WHEEL_PX = 400;    // pixels of two-finger swipe (or wheel) for the full range
  const WHEEL_STEP = 24;   // a mouse wheel's big notch moves at most 1/WHEEL_STEP of the range
  const DETENT = 0.04;     // a click this near the flat point (share of the range) lands on it
  // macOS scrolls "naturally" by default (trackpad and mouse): content follows the fingers
  const NATURAL = /Mac/.test(navigator.platform || navigator.userAgent);

  /** How far a swipe or wheel moves a control, in pixels, more = positive: fingers to the right or up
   *  (as macOS's natural scrolling reports them; a wheel rolled up elsewhere), a big notch capped. */
  function swipePx(e) {
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;     // lines or pages to pixels
    const dx = e.deltaX * unit, dy = e.deltaY * unit;
    const horizontal = Math.abs(dx) > Math.abs(dy);
    const px = NATURAL ? (horizontal ? -dx : dy) : (horizontal ? dx : -dy);
    const cap = WHEEL_PX / WHEEL_STEP;
    return Math.max(-cap, Math.min(cap, px));
  }

  /** What a control reads: dB for EQs and levels, low-/high-pass for the filter, else the number. */
  function readout(input) {
    const v = parseFloat(input.value);
    if (/-eq-|-level$/.test(input.id)) return v <= parseFloat(input.min) ? 'KILL' : `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
    if (/-filter$/.test(input.id)) return v < 0 ? `LP ${Math.round(-v * 2)}` : v > 0 ? `HP ${Math.round(v * 2)}` : 'OFF';
    const step = parseFloat(input.step) || 1;
    return v.toFixed(step < 1 ? 1 : 0);
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
    ['knob-zero', 'knob-fill', 'knob-thumb'].forEach(c => {
      const part = document.createElement('span');
      part.className = c;
      el.append(part);
    });
    const target = el.closest('.knob-group') || el;
    const value = document.createElement('span');
    value.className = 'knob-value';
    target.append(value);
    const min = parseFloat(input.min), max = parseFloat(input.max), range = max - min;
    const zero = min < 0 && max > 0 ? 0 : parseFloat(input.defaultValue);
    const knob = { el, input, value, last: null, zero: (zero - min) / range };
    knobs.push(knob);

    // On the bar: the value where the pointer is. Elsewhere on its group (its name and value): moved
    // relative to where it was, as is any drag with shift held (fine)
    const mine = e => !e.target.closest('button');
    const at = e => {
      const r = el.getBoundingClientRect();
      const x = UI.local(e, el).x;
      let v = min + Math.max(0, Math.min(1, x / Math.max(1, r.width))) * range;
      if (Math.abs(v - zero) < DETENT * range) v = zero;
      return v;
    };
    let mode = null, startX = 0, startY = 0, startV = 0;
    target.addEventListener('pointerdown', (e) => {
      if (!mine(e)) return;
      e.preventDefault();
      input.focus({ preventScroll: true });
      target.setPointerCapture(e.pointerId);
      target.classList.add('turning');
      mode = el.contains(e.target) && !e.shiftKey ? 'absolute' : 'relative';
      const p = UI.local(e, el);
      startX = p.x;
      startY = p.y;
      startV = parseFloat(input.value);
      if (mode === 'absolute') setValue(input, at(e));
    });
    target.addEventListener('pointermove', (e) => {
      if (!target.hasPointerCapture(e.pointerId)) return;
      if (mode === 'absolute' && !e.shiftKey) {
        setValue(input, at(e));
        return;
      }
      const p = UI.local(e, el);
      setValue(input, startV + ((startY - p.y + p.x - startX) / DRAG_PX) * range * (e.shiftKey ? 0.25 : 1));
    });
    const release = (e) => {
      if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId);
      target.classList.remove('turning');
    };
    target.addEventListener('pointerup', release);
    target.addEventListener('pointercancel', release);
    target.addEventListener('dblclick', (e) => { if (mine(e)) setValue(input, parseFloat(input.defaultValue)); });
    let swiping = null;
    target.addEventListener('wheel', (e) => {
      if (!mine(e)) return;
      e.preventDefault();
      setValue(input, parseFloat(input.value) + (swipePx(e) / WHEEL_PX) * range * (e.shiftKey ? 0.25 : 1));
      target.classList.add('turning');
      clearTimeout(swiping);
      swiping = setTimeout(() => target.classList.remove('turning'), 400);
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
    // A two-finger swipe (or wheel) moves it too: fingers up or to the right raise it
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const range = parseFloat(input.max) - parseFloat(input.min);
      setValue(input, parseFloat(input.value) + (swipePx(e) / WHEEL_PX) * range * (e.shiftKey ? 0.25 : 1));
    }, { passive: false });
    if (el.dataset.reset !== undefined) {
      el.addEventListener('dblclick', () => setValue(input, parseFloat(el.dataset.reset)));
    }
  });

  function draw() {
    for (const k of knobs) {
      if (k.input.value === k.last) continue;
      k.last = k.input.value;
      const min = parseFloat(k.input.min), max = parseFloat(k.input.max);
      const v = (parseFloat(k.input.value) - min) / (max - min);
      k.el.style.setProperty('--z', k.zero.toFixed(4));
      k.el.style.setProperty('--v', v.toFixed(4));
      k.el.classList.toggle('at-zero', Math.abs(v - k.zero) < 1e-6);
      k.value.textContent = readout(k.input);
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
