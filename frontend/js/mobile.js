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
    // Turned console: its height is the phone's width, which media queries don't see
    root.classList.toggle('short-phone', UI.rotated && window.innerWidth <= 380);
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

  // No pinch zoom on phones (iPhone Safari ignores user-scalable=no; double-tap zoom is off via
  // touch-action in the stylesheet)
  ['gesturestart', 'gesturechange'].forEach((type) => document.addEventListener(type, (e) => e.preventDefault()));

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

  // In-page pickers for selects. A phone's native picker ignores the turned console (it opens in
  // the phone's own orientation, i.e. sideways), so in the landscape console the deck track lists
  // and the AI engine menu open this list instead. The <select> stays the source of truth: app.js
  // fills it and listens to its 'change' events.
  function enhanceSelect(select) {
    const wrap = document.createElement('div');
    wrap.className = 'picker';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'picker-button';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    const label = document.createElement('span');
    label.className = 'picker-label';
    btn.append(label);
    const list = document.createElement('div');
    list.className = 'picker-list';
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    select.after(wrap);
    wrap.append(btn, list);
    const labelled = select.labels && select.labels[0];
    if (labelled) btn.setAttribute('aria-label', labelled.textContent.trim());

    const split = (text) => {
      const m = text.match(/^(.*) \(([^()]*)\)$/);
      return m ? [m[1], m[2]] : [text, ''];
    };
    const refreshLabel = () => {
      const opt = select.options[select.selectedIndex];
      label.textContent = opt && opt.value ? split(opt.textContent)[0] : 'Choose a track…';
      if (select.id === 'ai-model-select' && opt) label.textContent = opt.textContent;
    };
    const close = () => { list.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    const rebuild = () => {
      list.replaceChildren(...[...select.options].filter((o) => o.value).map((o) => {
        const [title, meta] = split(o.textContent);
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'picker-item';
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(o.value === select.value));
        const t = document.createElement('span'); t.textContent = title;
        const m = document.createElement('span'); m.className = 'picker-meta'; m.textContent = meta;
        item.append(t, m);
        item.addEventListener('click', () => {
          close();
          if (select.value !== o.value) {
            select.value = o.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
          refreshLabel();
          btn.focus();
        });
        return item;
      }));
      if (!list.children.length) {
        const empty = document.createElement('span');
        empty.className = 'picker-empty';
        empty.textContent = 'No tracks yet: upload one.';
        list.append(empty);
      }
      refreshLabel();
    };
    btn.addEventListener('click', () => {
      const open = list.hidden;
      document.querySelectorAll('.picker-list').forEach((l) => { l.hidden = true; });
      if (open) {
        rebuild();
        list.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        const sel = list.querySelector('[aria-selected="true"]') || list.querySelector('.picker-item');
        if (sel) sel.focus({ preventScroll: false });
      } else {
        close();
      }
    });
    list.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { close(); btn.focus(); }
    });
    document.addEventListener('pointerdown', (e) => { if (!wrap.contains(e.target)) close(); });
    select.addEventListener('change', refreshLabel);
    new MutationObserver(rebuild).observe(select, { childList: true });
    // app.js sets some values at startup without a change event: refresh once it has run
    document.addEventListener('DOMContentLoaded', () => setTimeout(refreshLabel, 0));
    rebuild();
  }
  document.querySelectorAll('.deck-source select, #ai-model-select').forEach(enhanceSelect);

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
