/**
 * track_picker.js - The decks' track browser. Every library track once (the server merges copies),
 * under a clean name, with search, A-Z or tempo order, the suggested next tracks on top, and how each
 * track's tempo sits with the other deck's: "BLENDS" within 20% (the console stretches it, keylocked,
 * the tempos meeting halfway), "HALF-TIME" / "DOUBLE-TIME" when it blends at half or double its tempo,
 * or how far apart. Tracks played this session are dimmed.
 *
 * Crates, down the left (across the top on a phone): every track; smart crates (FITS NOW: blends with
 * the other deck's tempo and key; new in the last 30 days; never played; played tonight); the music
 * folder's sub-folders; tempo bands; sung and instrumental tracks. Filter chips over the list narrow any
 * crate (BLENDS, KEY MATCH, UNPLAYED, VOCAL, INSTRUMENTAL). Search looks through every track, chips
 * still applied. The crate and chips are remembered per deck, plays across sessions in this browser.
 */
const TrackPicker = (() => {
  const BLEND_GAP = 0.20;   // MixPlanner.GLIDE_MAX (tempos past 4% apart meet halfway, gliding)
  const NEW_DAYS = 30;
  const BANDS = [[0, 85], [85, 100], [100, 115], [115, 130], [130, 999]];
  const SUNG = 0.25;        // a track sung over at least this share of it is "vocal"; under INSTRUMENTAL
  const INSTRUMENTAL = 0.1;
  const HISTORY = 'pp_play_history';

  const store = {
    get(k, fallback) { try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private window */ } },
  };
  let history = store.get(HISTORY, {});          // file_id -> last time it was mixed (ms)

  /** Tracks mixed (in or out): remembered in this browser, for NEVER PLAYED. */
  function markPlayed(ids) {
    ids.filter(Boolean).forEach(id => { history[id] = Date.now(); });
    store.set(HISTORY, history);
  }

  /** Keys that sit together on the Camelot wheel (same, one step around, or relative major/minor). */
  function keysFit(a, b) {
    if (!a || !b || a === '--' || b === '--') return false;
    const na = parseInt(a, 10), nb = parseInt(b, 10);
    const d = (nb - na + 12) % 12;
    return na === nb || (a.slice(-1) === b.slice(-1) && (d === 1 || d === 11));
  }

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
    let highlightId = null;     // the row a DJ controller's browse knob is on
    let emptyText = 'No tracks yet: upload one.';
    let crate = store.get(`pp_crate_${deckNum}`, 'all');
    let chips = new Set(store.get(`pp_chips_${deckNum}`, []));
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
    const chipRow = document.createElement('div');
    chipRow.className = 'track-pick-chips';
    const CHIPS = [['blends', 'BLENDS'], ['key', 'KEY MATCH'], ['unplayed', 'UNPLAYED'], ['vocal', 'VOCAL'],
                   ['instrumental', 'INSTRUMENTAL']];
    CHIPS.forEach(([id, text]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.dataset.chip = id;
      b.addEventListener('click', () => {
        if (chips.has(id)) chips.delete(id);
        else {
          chips.add(id);
          if (id === 'vocal') chips.delete('instrumental');
          if (id === 'instrumental') chips.delete('vocal');
        }
        store.set(`pp_chips_${deckNum}`, [...chips]);
        render();
      });
      chipRow.append(b);
    });
    const body = document.createElement('div');
    body.className = 'track-pick-body';
    const crates = document.createElement('nav');
    crates.className = 'track-pick-crates';
    crates.setAttribute('aria-label', 'Crates');
    const list = document.createElement('div');
    list.className = 'track-pick-list';
    body.append(crates, list);
    panel.append(head, chipRow, body);
    root.append(trigger, panel);

    /** The crates there are, with their tracks: [{ id, name, group, tracks }] (empty ones left out). */
    function crateList(ctx) {
      const fits = t => { const h = tempoHint(t.bpm, ctx.otherBpm); return !!(h && h.ok); };
      const out = [{ id: 'all', name: 'All tracks', tracks: library }];
      if (ctx.otherBpm) {
        out.push({ id: 'fits', name: 'Fits now', tracks: library.filter(t => t.file_id !== ctx.otherId && fits(t) && (!ctx.otherKey || keysFit(t.camelot, ctx.otherKey))) });
      }
      const since = Date.now() / 1000 - NEW_DAYS * 86400;
      out.push({ id: 'new', name: `New · ${NEW_DAYS} days`, tracks: library.filter(t => (t.added || 0) >= since) });
      out.push({ id: 'unplayed', name: 'Never played', tracks: library.filter(t => !history[t.file_id] && !(ctx.played && ctx.played.has(t.file_id))) });
      out.push({ id: 'tonight', name: 'Played tonight', tracks: library.filter(t => ctx.played && ctx.played.has(t.file_id)) });
      const folders = [...new Set(library.map(t => t.folder || ''))].sort((a, b) => a.localeCompare(b));
      if (folders.length > 1) {
        folders.forEach(f => out.push({ id: `folder:${f}`, name: f || '(top level)', group: 'FOLDERS',
                                        tracks: library.filter(t => (t.folder || '') === f) }));
      }
      BANDS.forEach(([lo, hi]) => out.push({
        id: `bpm:${lo}`, group: 'TEMPO', name: lo === 0 ? `Under ${hi}` : hi > 900 ? `${lo}+ BPM` : `${lo}–${hi} BPM`,
        tracks: library.filter(t => t.bpm >= lo && t.bpm < hi) }));
      if (library.some(t => t.sung !== null && t.sung !== undefined)) {
        out.push({ id: 'sung', group: 'VOCALS', name: 'Sung', tracks: library.filter(t => t.sung >= SUNG) });
        out.push({ id: 'instr', group: 'VOCALS', name: 'Instrumental', tracks: library.filter(t => t.sung !== null && t.sung !== undefined && t.sung < INSTRUMENTAL) });
      }
      return out.filter(c => c.id === 'all' || c.tracks.length || c.id === crate);
    }

    /** The chips' filter over a list of tracks. */
    function chipFilter(ctx) {
      return t => (!chips.has('blends') || (tempoHint(t.bpm, ctx.otherBpm) || {}).ok)
        && (!chips.has('key') || keysFit(t.camelot, ctx.otherKey))
        && (!chips.has('unplayed') || (!history[t.file_id] && !(ctx.played && ctx.played.has(t.file_id))))
        && (!chips.has('vocal') || t.sung >= SUNG)
        && (!chips.has('instrumental') || (t.sung !== null && t.sung !== undefined && t.sung < INSTRUMENTAL));
    }

    function renderCrates(all) {
      const items = [];
      let group = null;
      all.forEach(c => {
        if (c.group && c.group !== group) {
          group = c.group;
          const h = document.createElement('div');
          h.className = 'tp-crate-group';
          h.textContent = group;
          items.push(h);
        }
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tp-crate';
        b.setAttribute('aria-pressed', String(c.id === crate));
        const name = document.createElement('span');
        name.className = 'tp-crate-name';
        name.textContent = c.name;
        name.title = c.name;
        const n = document.createElement('span');
        n.className = 'tp-crate-n';
        n.textContent = c.tracks.length;
        b.append(name, n);
        b.addEventListener('click', () => {
          crate = c.id;
          store.set(`pp_crate_${deckNum}`, crate);
          search.value = '';
          render();
          list.scrollTop = 0;
        });
        items.push(b);
      });
      crates.replaceChildren(...items);
    }

    function tempoHint(bpm, otherBpm) {
      if (!otherBpm || !bpm) return null;
      const fits = m => Math.max(otherBpm / (bpm * m), bpm * m / otherBpm) - 1 <= BLEND_GAP;   // MixPlanner.mixTempo
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
      // A prepared library track whose grid drifts or fits poorly (local mode): worth a check
      meta.textContent = [t.bpm ? Math.round(t.bpm) : null, t.camelot && t.camelot !== '--' ? t.camelot : null,
                          fmtTime(t.duration), t.flags && t.flags.length ? 'CHECK GRID' : null].filter(Boolean).join(' · ');
      const hint = tempoHint(t.bpm, ctx.otherBpm);
      const tag = document.createElement('span');
      tag.className = `tp-tag${hint && hint.ok ? ' ok' : ''}`;
      // A played track still says how it fits the other deck's tempo
      tag.textContent = [ctx.played && ctx.played.has(t.file_id) ? 'PLAYED' : null, hint ? hint.text : null]
        .filter(Boolean).join(' · ');
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
      chipRow.querySelectorAll('button').forEach(b => {
        b.setAttribute('aria-pressed', String(chips.has(b.dataset.chip)));
        // BLENDS and KEY MATCH need a track on the other deck;
        // VOCAL and INSTRUMENTAL tracks with vocal labels (stems or Gemini)
        b.disabled = (b.dataset.chip === 'blends' && !ctx.otherBpm) || (b.dataset.chip === 'key' && !ctx.otherKey)
          || (['vocal', 'instrumental'].includes(b.dataset.chip) && !library.some(t => t.sung !== null && t.sung !== undefined));
      });
      const all0 = crateList(ctx);
      const current = all0.find(c => c.id === crate) || all0[0];
      crate = current.id;
      renderCrates(all0);
      const chipOk = chipFilter(ctx);
      const rows = [];
      const inCrate = new Set(current.tracks.map(t => t.file_id));
      const sug = suggestions.filter(match).filter(chipOk).filter(t => crate === 'all' || inCrate.has(t.file_id));
      if (sug.length && !q && (crate === 'all' || crate === 'fits')) {
        rows.push(section(`SUGGESTED NEXT${suggestedAfter ? ` · AFTER ${cleanTitle(suggestedAfter).toUpperCase()}` : ''}`));
        sug.forEach(s => rows.push(row(s, ctx, `★ ${s.score} · ${(s.reasons || []).slice(0, 2).join(', ')}`)));
      }
      // Search looks through every track; otherwise the crate's
      const all = (q ? library : current.tracks).filter(t => match(t) && chipOk(t)).sort(order === 'bpm'
        ? (a, b) => (a.bpm || 0) - (b.bpm || 0)
        : (a, b) => cleanTitle(a.title || a.file_id).localeCompare(cleanTitle(b.title || b.file_id)));
      const filtered = chips.size ? ' · FILTERED' : '';
      rows.push(section(q ? `${all.length} MATCHING IN ALL TRACKS${filtered}` : `${current.name.toUpperCase()} · ${all.length}${filtered}`));
      all.forEach(t => rows.push(row(t, ctx)));
      if (!all.length) {
        const empty = document.createElement('div');
        empty.className = 'track-pick-empty';
        empty.textContent = !library.length ? emptyText
          : chips.size ? 'No track here passes the filters: turn a chip off.' : 'No track matches.';
        rows.push(empty);
      }
      list.replaceChildren(...rows);
      search.placeholder = `Search ${library.length} tracks`;
      markHighlight();
    }

    function markHighlight() {
      const rows = [...list.querySelectorAll('.track-pick-row')];
      rows.forEach(r => r.classList.remove('hl'));
      const r = rows.find(x => x.dataset.fileId === highlightId);
      if (!r) return null;
      r.classList.add('hl');
      // In view: the list scrolls, never the page
      if (r.offsetTop < list.scrollTop) list.scrollTop = r.offsetTop - 8;
      else if (r.offsetTop + r.offsetHeight > list.scrollTop + list.clientHeight) {
        list.scrollTop = r.offsetTop + r.offsetHeight - list.clientHeight + 8;
      }
      return r;
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
      setEmptyText(text) { emptyText = text; if (!panel.hidden) render(); },
      setSuggestions(list2, afterTitle) {
        suggestions = list2.slice();
        suggestedAfter = afterTitle || '';
        if (!panel.hidden) render();
      },
      /** The trigger shows the deck's track (null: none loaded). */
      showTrack(title) { triggerLabel.textContent = title ? cleanTitle(title) : 'Choose a track…'; },
      /** A DJ controller's browse knob: opens the list and moves its highlight `delta` rows. */
      browse(delta) {
        if (panel.hidden) open();
        const rows = [...list.querySelectorAll('.track-pick-row')];
        if (!rows.length) return;
        const i = rows.findIndex(x => x.dataset.fileId === highlightId);
        highlightId = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + delta))].dataset.fileId;
        markHighlight();
      },
      /** The highlighted track's file id while the list is open, else null. */
      highlighted() { return panel.hidden ? null : highlightId; },
      close,
    };
  }

  return { create, cleanTitle, markPlayed, keysFit };
})();

window.TrackPicker = TrackPicker;
