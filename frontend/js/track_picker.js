/**
 * track_picker.js - The decks' track browser. Every library track once (the server merges copies),
 * under a clean name, with search, A-Z or tempo order, the suggested next tracks on top, and how each
 * track's tempo sits with the other deck's: "BLENDS" within 12% (the console stretches it, keylocked),
 * "HALF-TIME" / "DOUBLE-TIME" when it blends at half or double its tempo, or how far apart. Tracks played
 * this session are dimmed.
 */
const TrackPicker = (() => {
  const BLEND_GAP = 0.12;   // MixPlanner.MAX_STRETCH

  /** "deck_1_07_-_Dj_Sanj_-_Das_Ja___(Mp3Hungama.com).mp3" -> "Dj Sanj - Das Ja" */
  function cleanTitle(raw) {
    let t = String(raw || '')
      .replace(/\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i, '')
      .replace(/^(deck_[12]_|lib_)/i, '')
      .replace(/_/g, ' ')
      .replace(/[[(]?\s*(www\.)?[a-z0-9-]+\.(com|net|org|in|co|info|pk)\s*[\])]?/gi, ' ')   // download sites
      .replace(/\(\s*\d{2,3}\s*k(bps)?\s*\)/gi, ' ')                                        // (192k)
      .replace(/^\s*0?\d{1,2}\s*[-–.]\s+/, '')                                                // "07 - "
      .replace(/^\s*0\d\s+/, '');                                                             // "06 "
    t = t.replace(/\(\s*\)|\[\s*\]/g, ' ').replace(/\s{2,}/g, ' ').replace(/^[\s\-–]+|[\s\-–]+$/g, '');
    return t || String(raw || '');
  }

  const fmtTime = s => (s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');

  /**
   * One deck's picker inside `root`. context() -> { otherBpm, currentId, played: Set } when it opens;
   * onPick(fileId, title) when a track is chosen.
   */
  function create({ root, deckNum, context, onPick }) {
    let library = [];
    let suggestions = [];
    let suggestedAfter = '';
    let order = 'az';
    const coarse = window.matchMedia('(pointer: coarse)').matches;

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'track-pick-button';
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', `Choose a track for deck ${deckNum === 1 ? 'A' : 'B'}`);
    const triggerLabel = document.createElement('span');
    triggerLabel.className = 'track-pick-label';
    triggerLabel.textContent = 'Choose a track…';
    trigger.append(triggerLabel);

    const panel = document.createElement('div');
    panel.className = 'track-pick-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', trigger.getAttribute('aria-label'));
    panel.hidden = true;
    const head = document.createElement('div');
    head.className = 'track-pick-head';
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'track-pick-search';
    search.placeholder = 'Search tracks';
    search.setAttribute('aria-label', 'Search tracks');
    const sorts = document.createElement('div');
    sorts.className = 'track-pick-sorts';
    const sortBtn = (value, text) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.dataset.order = value;
      b.addEventListener('click', () => { order = value; render(); });
      return b;
    };
    sorts.append(sortBtn('az', 'A–Z'), sortBtn('bpm', 'BPM'));
    head.append(search, sorts);
    const list = document.createElement('div');
    list.className = 'track-pick-list';
    panel.append(head, list);
    root.append(trigger, panel);

    function tempoHint(bpm, otherBpm) {
      if (!otherBpm || !bpm) return null;
      const fits = m => Math.abs(otherBpm / (bpm * m) - 1) <= BLEND_GAP;   // MixPlanner.tempoMultiple
      if (fits(1)) return { text: 'BLENDS', ok: true };
      if (fits(2)) return { text: 'HALF-TIME', ok: true };
      if (fits(0.5)) return { text: 'DOUBLE-TIME', ok: true };
      const gap = otherBpm / bpm - 1;
      return { text: `${gap > 0 ? '+' : '−'}${Math.round(Math.abs(gap) * 100)}%`, ok: false };
    }

    function row(t, ctx, extra = null) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'track-pick-row';
      b.dataset.fileId = t.file_id;
      if (t.file_id === ctx.currentId) b.setAttribute('aria-current', 'true');
      if (ctx.played && ctx.played.has(t.file_id)) b.classList.add('played');
      const main = document.createElement('span');
      main.className = 'tp-main';
      const title = document.createElement('span');
      title.className = 'tp-title';
      title.textContent = cleanTitle(t.title || t.file_id);
      main.append(title);
      if (extra) {
        const why = document.createElement('span');
        why.className = 'tp-why';
        why.textContent = extra;
        main.append(why);
      }
      const meta = document.createElement('span');
      meta.className = 'tp-meta';
      meta.textContent = [t.bpm ? Math.round(t.bpm) : null, t.camelot && t.camelot !== '--' ? t.camelot : null,
                          fmtTime(t.duration)].filter(Boolean).join(' · ');
      const hint = tempoHint(t.bpm, ctx.otherBpm);
      const tag = document.createElement('span');
      tag.className = `tp-tag${hint && hint.ok ? ' ok' : ''}`;
      tag.textContent = ctx.played && ctx.played.has(t.file_id) ? 'PLAYED' : hint ? hint.text : '';
      b.append(main, meta, tag);
      b.addEventListener('click', () => pick(t));
      return b;
    }

    function section(text) {
      const h = document.createElement('div');
      h.className = 'track-pick-section';
      h.textContent = text;
      return h;
    }

    function render() {
      const ctx = context();
      const q = search.value.trim().toLowerCase();
      const match = t => !q || cleanTitle(t.title || t.file_id).toLowerCase().includes(q)
        || (t.camelot || '').toLowerCase() === q || String(Math.round(t.bpm || 0)) === q;
      sorts.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.order === order)));
      const rows = [];
      const sug = suggestions.filter(match);
      if (sug.length && !q) {
        rows.push(section(`SUGGESTED NEXT${suggestedAfter ? ` · AFTER ${cleanTitle(suggestedAfter).toUpperCase()}` : ''}`));
        sug.forEach(s => rows.push(row(s, ctx, `★ ${s.score} · ${(s.reasons || []).slice(0, 2).join(', ')}`)));
      }
      const all = library.filter(match).sort(order === 'bpm'
        ? (a, b) => (a.bpm || 0) - (b.bpm || 0)
        : (a, b) => cleanTitle(a.title || a.file_id).localeCompare(cleanTitle(b.title || b.file_id)));
      rows.push(section(q ? `${all.length} MATCHING` : `ALL TRACKS · ${all.length}`));
      all.forEach(t => rows.push(row(t, ctx)));
      if (!all.length) {
        const empty = document.createElement('div');
        empty.className = 'track-pick-empty';
        empty.textContent = library.length ? 'No track matches.' : 'No tracks yet: upload one.';
        rows.push(empty);
      }
      list.replaceChildren(...rows);
      search.placeholder = `Search ${library.length} tracks`;
    }

    function pick(t) {
      close();
      triggerLabel.textContent = cleanTitle(t.title || t.file_id);
      onPick(t.file_id, t.title);
    }

    /** Room above and below the button, in the page or in the turned console (phones held sideways
     *  whose browser can't rotate get the console turned 90°: its own offsets still hold). */
    function roomAround() {
      const turned = document.documentElement.classList.contains('forced-landscape') && root.closest('.dj-console');
      if (!turned) {
        const r = trigger.getBoundingClientRect();
        return { above: r.top, below: window.innerHeight - r.bottom };
      }
      let y = 0;
      for (let e = trigger; e && e !== turned; e = e.offsetParent) y += e.offsetTop;
      y -= turned.scrollTop;
      return { above: y, below: turned.clientHeight - y - trigger.offsetHeight };
    }

    function open() {
      document.querySelectorAll('.track-pick-panel').forEach(p => { if (p !== panel) p.hidden = true; });
      search.value = '';
      render();
      panel.classList.remove('up');
      panel.style.maxHeight = '';
      panel.hidden = false;
      if (getComputedStyle(panel).position !== 'fixed') {   // a dropdown (not the phone's sheet): fit it
        const room = roomAround();
        const up = room.below < 240 && room.above > room.below;
        panel.classList.toggle('up', up);
        panel.style.maxHeight = `${Math.round(Math.max(160, Math.min(420, (up ? room.above : room.below) - 12)))}px`;
      }
      trigger.setAttribute('aria-expanded', 'true');
      // The deck's track in view (scrolling the list only: never the page)
      const current = list.querySelector('[aria-current="true"]');
      list.scrollTop = current ? Math.max(0, current.offsetTop - list.clientHeight / 2) : 0;
      if (!coarse) search.focus({ preventScroll: true });   // phones: no keyboard until they tap search
    }

    function close() {
      panel.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    }

    trigger.addEventListener('click', () => (panel.hidden ? open() : close()));
    search.addEventListener('input', render);
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = list.querySelector('.track-pick-row');
        if (first) first.click();
      } else if (e.key === 'ArrowDown') {
        const first = list.querySelector('.track-pick-row');
        if (first) { e.preventDefault(); first.focus(); }
      }
    });
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { close(); trigger.focus(); }
    });
    document.addEventListener('pointerdown', (e) => { if (!root.contains(e.target)) close(); });

    return {
      setLibrary(tracks) { library = tracks.slice(); if (!panel.hidden) render(); },
      setSuggestions(list2, afterTitle) {
        suggestions = list2.slice();
        suggestedAfter = afterTitle || '';
        if (!panel.hidden) render();
      },
      /** The trigger shows the deck's track (null: none loaded). */
      showTrack(title) { triggerLabel.textContent = title ? cleanTitle(title) : 'Choose a track…'; },
    };
  }

  return { create, cleanTitle };
})();

window.TrackPicker = TrackPicker;
