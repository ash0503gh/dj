/**
 * mobile.js - Phone helpers.
 *
 * - MIX button in the top bar (landscape phones): the transition trigger stays one tap away while
 *   the full transition bar sits below the decks.
 * - Phones held upright get a dismissible tip to turn sideways. "Switch to landscape" goes
 *   fullscreen and locks landscape where the browser allows it (Android Chrome); elsewhere
 *   (iPhone Safari cannot lock orientation) it asks the DJ to rotate the phone.
 */
(() => {
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
  if (dismissed) {
    hint.remove();
    return;
  }
  document.getElementById('btn-rotate-close').addEventListener('click', () => {
    hint.remove();
    try { localStorage.setItem('pp_rotate_hint', 'off'); } catch (e) { /* storage blocked */ }
  });
  const btn = document.getElementById('btn-landscape');
  const text = document.getElementById('rotate-hint-text');
  const canTry = !!(screen.orientation && screen.orientation.lock && document.documentElement.requestFullscreen);
  if (!canTry) {
    btn.hidden = true;
    return;
  }
  btn.addEventListener('click', async () => {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      await screen.orientation.lock('landscape');
    } catch (e) {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      btn.hidden = true;
      text.textContent = 'This browser can’t rotate the page: turn your phone sideways.';
    }
  });
})();
