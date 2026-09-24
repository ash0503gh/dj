/**
 * mobile.js - Phone helpers.
 *
 * Landscape console: <html class="landscape-ui"> switches the compact side-by-side layout on. It
 * is on when the phone really is sideways (landscape, <= 520 px tall), or when the DJ taps
 * "Switch to landscape": the browser's fullscreen + orientation lock where it allows it (Android
 * Chrome), otherwise the console itself is turned 90 degrees (<html class="forced-landscape">), which
 * works everywhere, including iPhones and phones with rotation lock on.
 *
 * UI.local(event, element) gives a pointer position in the element's own (unrotated) axes, so knobs,
 * faders, waveforms and jog wheels behave the same whether or not the console is turned.
 *
 * MIX button in the top bar (landscape): the transition trigger stays one tap away.
 */
(() => {
  const root = document.documentElement;
  const phoneLandscape = window.matchMedia('(orientation: landscape) and (max-height: 520px)');

  const UI = {
    get rotated() { return root.classList.contains('forced-landscape'); },
    /** Pointer position relative to `el`, in content axes: { x, y, w, h }. */
    local(e, el) {
      const p = e.touches && e.touches[0] ? e.touches[0] : (e.changedTouches && e.changedTouches[0]) || e;
      const r = el.getBoundingClientRect();
      if (!UI.rotated) return { x: p.clientX - r.left, y: p.clientY - r.top, w: r.width, h: r.height };
      // Turned 90 degrees clockwise: content right = screen down, content down = screen left
      return { x: p.clientY - r.top, y: r.right - p.clientX, w: r.height, h: r.width };
    },
  };
  window.UI = UI;

  function applyLayout() {
    if (phoneLandscape.matches && UI.rotated) root.classList.remove('forced-landscape');  // really sideways now
    root.classList.toggle('landscape-ui', phoneLandscape.matches || UI.rotated);
    window.dispatchEvent(new Event('resize'));  // waveforms re-measure their lanes
  }
  phoneLandscape.addEventListener('change', applyLayout);
  applyLayout();

  function setForced(on) {
    root.classList.toggle('forced-landscape', on);
    try { sessionStorage.setItem('pp_forced_landscape', on ? '1' : ''); } catch (e) { /* storage blocked */ }
    applyLayout();
    window.scrollTo(0, 0);
  }
  let restore = false;
  try { restore = sessionStorage.getItem('pp_forced_landscape') === '1'; } catch (e) { /* storage blocked */ }
  if (restore && !phoneLandscape.matches) setForced(true);
  const exit = document.getElementById('btn-exit-landscape');
  if (exit) exit.addEventListener('click', () => setForced(false));

  const trigger = document.getElementById('btn-trigger-transition');
  const mini = document.getElementById('btn-mini-trigger');
  if (trigger && mini) {
    mini.addEventListener('click', () => trigger.click());
    const sync = () => {
      const on = trigger.classList.contains('in-transition');
      mini.classList.toggle('in-transition', on);
      mini.textContent = on ? 'MIXING' : 'MIX';
    };
    new MutationObserver(sync).observe(trigger, { attributes: true, attributeFilter: ['class'] });
  }

  const hint = document.getElementById('rotate-hint');
  if (!hint) return;
  let dismissed = false;
  try { dismissed = localStorage.getItem('pp_rotate_hint') === 'off'; } catch (e) { /* storage blocked */ }
  if (dismissed) hint.hidden = true;
  document.getElementById('btn-rotate-close').addEventListener('click', () => {
    hint.hidden = true;
    try { localStorage.setItem('pp_rotate_hint', 'off'); } catch (e) { /* storage blocked */ }
  });
  document.getElementById('btn-landscape').addEventListener('click', async () => {
    // Native rotation first (Android Chrome); iPhones and rotation-locked phones get the turned console
    const native = screen.orientation && screen.orientation.lock && root.requestFullscreen;
    if (native) {
      try {
        if (!document.fullscreenElement) await root.requestFullscreen({ navigationUI: 'hide' });
        await screen.orientation.lock('landscape');
        return;
      } catch (e) {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      }
    }
    setForced(true);
  });
})();
