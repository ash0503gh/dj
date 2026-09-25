/**
 * app.js - Main Controller for PULSE PRO DJ Console
 * Features:
 * - Direct file picker trigger & full Drag-and-Drop on deck panels
 * - Instant pre-loaded club sets (Laserpack -> Overworld, Club Diver -> Disco Medusae)
 * - 5 Professional Transition Techniques (Bass Swap, Echo Freeze, Loop Roll, Vinyl Brake, Stem Mashup)
 * - AI Live DJ Brain Recommendation Engine
 * - Real-time animated 4/4 phrase alignment, HPF filter sweep, and 100% bass swap
 * - Web Audio low-latency playback with 3-band EQs and VU peak meters
 */

document.addEventListener('DOMContentLoaded', () => {
  const engine = new DJAudioEngine();
  
  let track1Data = null;
  let track2Data = null;
  let selectedBars = 16;
  let selectedTechnique = 'auto';
  let isTransitioning = false;
  let lastRenderedMix = null;
  let lastTransitionCues = null;
  let lastPerformed = null;
  let currentAIRec = null;
  let serverHasJev = false;
  let serverHasGemini = false;

  // iPhones mute web audio with the ring/silent switch unless the page says it plays media
  // (Audio Session API, Safari 16.4+)
  if (navigator.audioSession) {
    try { navigator.audioSession.type = 'playback'; } catch (e) { /* older Safari */ }
  }
  // Browsers start audio suspended until a user gesture, and phones suspend it again after the
  // screen locks or another app takes the audio: resume on any tap/key whenever it isn't running
  const unlockAudio = () => {
    if (engine.ctx.state !== 'running') {
      engine.ctx.resume().then(() => console.log('AudioContext running.')).catch(() => {});
    }
  };
  ['pointerdown', 'touchend', 'click', 'keydown'].forEach((type) => {
    window.addEventListener(type, unlockAudio, { capture: true, passive: true });
  });

  // Initialize Waveforms
  const wave1 = new RGBWaveform('canvas-wave-deck1', 1, (targetTime) => {
    engine.deck1.audio.currentTime = targetTime;
  });
  const wave2 = new RGBWaveform('canvas-wave-deck2', 2, (targetTime) => {
    engine.deck2.audio.currentTime = targetTime;
  });

  // Initialize Jog Wheels
  const jog1 = new JogWheel('jog-deck-1', 1, 
    (delta) => { engine.deck1.audio.currentTime += delta * 0.25; },
    (delta) => { engine.deck1.audio.currentTime += delta * 0.05; }
  );

  const jog2 = new JogWheel('jog-deck-2', 2,
    (delta) => { engine.deck2.audio.currentTime += delta * 0.25; },
    (delta) => { engine.deck2.audio.currentTime += delta * 0.05; }
  );

  // --- UI Elements ---
  const masterBpmEl = document.getElementById('master-bpm');
  const camelotStatusEl = document.getElementById('camelot-status');
  const btnExportMix = document.getElementById('btn-export-mix');
  const btnTriggerTransition = document.getElementById('btn-trigger-transition');
  const transitionStatusBanner = document.getElementById('transition-status-banner');
  const transitionStateSub = document.getElementById('transition-state-sub');
  const transitionOverlay = document.getElementById('transition-zone-overlay');

  // Phase Meter HUD Elements
  const phaseCursor = document.getElementById('phase-cursor');
  const phaseStatus = document.getElementById('phase-status');

  // Beat-sync state
  let isDeck1SyncLocked = false;
  let isDeck2SyncLocked = false;

  // AI Live Card
  const aiRecTechnique = document.getElementById('ai-rec-technique');
  const aiRecReason = document.getElementById('ai-rec-reason');
  const aiRecConfidence = document.getElementById('ai-rec-confidence');

  // Deck 1
  const deck1Panel = document.getElementById('deck-1-panel');
  const d1Title = document.getElementById('d1-title');
  const d1Time = document.getElementById('d1-time');
  const d1Bpm = document.getElementById('d1-bpm');
  const d1Key = document.getElementById('d1-key');
  const d1PitchVal = document.getElementById('d1-pitch-val');
  const d1VocalVal = document.getElementById('d1-vocal-val');
  const d1DynamicVal = document.getElementById('d1-dynamic-val');
  const d1PhraseVal = document.getElementById('d1-phrase-val');
  const d1TempoFader = document.getElementById('d1-tempo-fader');
  const d1BtnUpload = document.getElementById('d1-btn-upload');
  const d1FileInput = document.getElementById('d1-file-input');
  const d1BtnPlay = document.getElementById('d1-btn-play');
  const d1BtnCue = document.getElementById('d1-btn-cue');
  const d1BtnSync = document.getElementById('d1-btn-sync');
  const d1QuickSelect = document.getElementById('d1-quick-select');

  // Deck 2
  const deck2Panel = document.getElementById('deck-2-panel');
  const d2Title = document.getElementById('d2-title');
  const d2Time = document.getElementById('d2-time');
  const d2Bpm = document.getElementById('d2-bpm');
  const d2Key = document.getElementById('d2-key');
  const d2PitchVal = document.getElementById('d2-pitch-val');
  const d2VocalVal = document.getElementById('d2-vocal-val');
  const d2DynamicVal = document.getElementById('d2-dynamic-val');
  const d2PhraseVal = document.getElementById('d2-phrase-val');
  const d2TempoFader = document.getElementById('d2-tempo-fader');
  const d2BtnUpload = document.getElementById('d2-btn-upload');
  const d2FileInput = document.getElementById('d2-file-input');
  const d2BtnPlay = document.getElementById('d2-btn-play');
  const d2BtnCue = document.getElementById('d2-btn-cue');
  const d2BtnSync = document.getElementById('d2-btn-sync');
  const d2QuickSelect = document.getElementById('d2-quick-select');

  // Mixer
  const crossfader = document.getElementById('crossfader');
  if (crossfader) {
    crossfader.value = 50;
  }
  engine.setCrossfader(50, 'club');
  const d1VolFader = document.getElementById('d1-vol-fader');
  const d2VolFader = document.getElementById('d2-vol-fader');
  const d1EqHi = document.getElementById('d1-eq-hi');
  const d1EqMid = document.getElementById('d1-eq-mid');
  const d1EqLow = document.getElementById('d1-eq-low');
  const d1Filter = document.getElementById('d1-filter');
  const d2EqHi = document.getElementById('d2-eq-hi');
  const d2EqMid = document.getElementById('d2-eq-mid');
  const d2EqLow = document.getElementById('d2-eq-low');
  const d2Filter = document.getElementById('d2-filter');


  // Phrase Countdown HUD
  const phraseHud = document.getElementById('phrase-countdown-hud');
  const phraseHudCounter = document.getElementById('phrase-hud-counter');
  const phraseHudProgress = document.getElementById('phrase-hud-progress');
  const togglePhraseLock = document.getElementById('toggle-phrase-lock');
  const toggleVocalDuck = document.getElementById('toggle-vocal-duck');

  // Modals
  const mixModal = document.getElementById('mix-modal');
  const btnCloseModal = document.getElementById('btn-close-modal');
  const modalAudioPlayer = document.getElementById('modal-audio-player');
  const modalDownloadLink = document.getElementById('modal-download-link');
  const modalStatsGrid = document.getElementById('modal-stats-grid');
  
  // Shortcuts Modal Elements
  const btnShortcuts = document.getElementById('btn-shortcuts');
  const shortcutsModal = document.getElementById('shortcuts-modal');
  const btnCloseShortcuts = document.getElementById('btn-close-shortcuts');
  
  // Direction Selector State (Bidirectional Mixing)
  let transitionDirection = '1_to_2'; // '1_to_2' or '2_to_1'
  const dirPill1To2 = document.getElementById('dir-pill-1-2');
  const dirPill2To1 = document.getElementById('dir-pill-2-1');
  const btnSwapDir = document.getElementById('btn-swap-dir');
  const wfTagDeck1 = document.getElementById('wf-tag-deck-1');
  const wfTagDeck2 = document.getElementById('wf-tag-deck-2');

  // AI Co-Pilot Modal Elements
  const btnAICopilot = document.getElementById('btn-ai-copilot');
  const aiModal = document.getElementById('ai-modal');
  const btnCloseAI = document.getElementById('btn-close-ai');
  const aiRecCard = document.getElementById('ai-rec-card');
  const jevKeyInput = document.getElementById('jev-key-input');
  const btnSaveJevKey = document.getElementById('btn-save-jev-key');
  const geminiKeyInput = document.getElementById('gemini-key-input');
  const btnSaveGeminiKey = document.getElementById('btn-save-gemini-key');
  const aiModelSelect = document.getElementById('ai-model-select');
  const btnRefreshAI = document.getElementById('btn-refresh-ai');
  const btnApplyAIStrategy = document.getElementById('btn-apply-ai-strategy');

  // AI Strategy Sheet Elements
  const aiFlowBadge = document.getElementById('ai-flow-badge');
  const aiSourceBadge = document.getElementById('ai-source-badge');
  const aiHeadlineBox = document.getElementById('ai-headline-box');
  const aiRationaleText = document.getElementById('ai-rationale-text');
  const aiMetricTech = document.getElementById('ai-metric-tech');
  const aiMetricBars = document.getElementById('ai-metric-bars');
  const aiMetricPitch = document.getElementById('ai-metric-pitch');
  const aiMetricVocalRisk = document.getElementById('ai-metric-vocal-risk');
  const aiTacticalSteps = document.getElementById('ai-tactical-steps');
  const aiProTipText = document.getElementById('ai-pro-tip-text');

  let currentAIStrategy = null;
  // The Co-Pilot strategy (a Gemini call, ~₹0.9) is advice for the panel only: transitions never
  // read it. Changes just mark it stale; it's fetched when the panel is open or opened.
  let strategyStale = true;

  // Load stored Jev key, Gemini key, and model
  if (jevKeyInput) {
    jevKeyInput.value = localStorage.getItem('jev_api_key') || '';
  }
  if (geminiKeyInput) {
    geminiKeyInput.value = localStorage.getItem('gemini_api_key') || '';
  }
  if (aiModelSelect) {
    const savedModel = localStorage.getItem('ai_dj_model') || 'gemini-3.8-flash';
    // Saved choices of retired Gemini models (1.5 / 2.x) move to the current Flash model
    aiModelSelect.value = savedModel.startsWith('gemini-') ? 'gemini-3.8-flash' : savedModel;
    aiModelSelect.addEventListener('change', () => {
      localStorage.setItem('ai_dj_model', aiModelSelect.value);
      updateEngineChip();
      strategyInputsChanged();
    });
  }
  function updateEngineChip() {
    const chip = document.getElementById('ai-engine-chip');
    if (!chip || !aiModelSelect) return;
    chip.textContent = {
      'gemini-3.8-flash': 'Gemini 3.8 Flash · Jev fallback',
      'jev-latest': 'Jev System One · Gemini fallback',
      local: 'Local engine (no AI)',
    }[aiModelSelect.value] || aiModelSelect.value;
  }
  updateEngineChip();
  if (btnSaveJevKey && jevKeyInput) {
    btnSaveJevKey.addEventListener('click', () => {
      const keyVal = jevKeyInput.value.trim();
      localStorage.setItem('jev_api_key', keyVal);
      btnSaveJevKey.textContent = 'SAVED!';
      setTimeout(() => { btnSaveJevKey.textContent = 'SAVE'; }, 1500);
      strategyInputsChanged();
    });
  }
  if (btnSaveGeminiKey && geminiKeyInput) {
    btnSaveGeminiKey.addEventListener('click', () => {
      const keyVal = geminiKeyInput.value.trim();
      localStorage.setItem('gemini_api_key', keyVal);
      btnSaveGeminiKey.textContent = 'SAVED!';
      setTimeout(() => { btnSaveGeminiKey.textContent = 'SAVE'; }, 1500);
      strategyInputsChanged();
    });
  }

  function strategyInputsChanged() {
    strategyStale = true;
    if (aiModal && !aiModal.classList.contains('hidden')) {
      strategyStale = false;
      fetchAIStrategy();
    }
  }

  function toggleAIModal(forceState = null) {
    if (!aiModal) return;
    const shouldOpen = (forceState !== null) ? forceState : aiModal.classList.contains('hidden');
    if (shouldOpen) {
      aiModal.classList.remove('hidden');
      if (strategyStale) {
        strategyStale = false;
        fetchAIStrategy();
      }
    } else {
      aiModal.classList.add('hidden');
    }
  }

  function toggleShortcutsModal(forceState = null) {
    if (!shortcutsModal) return;
    const shouldOpen = (forceState !== null) ? forceState : shortcutsModal.classList.contains('hidden');
    if (shouldOpen) {
      shortcutsModal.classList.remove('hidden');
    } else {
      shortcutsModal.classList.add('hidden');
    }
  }

  function closeAllModals() {
    if (mixModal) {
      mixModal.classList.add('hidden');
      if (modalAudioPlayer) modalAudioPlayer.pause();
    }
    if (shortcutsModal) {
      shortcutsModal.classList.add('hidden');
    }
    if (aiModal) {
      aiModal.classList.add('hidden');
    }
  }

  if (btnShortcuts) btnShortcuts.addEventListener('click', () => toggleShortcutsModal(true));
  if (btnCloseShortcuts) btnCloseShortcuts.addEventListener('click', () => toggleShortcutsModal(false));
  if (btnAICopilot) btnAICopilot.addEventListener('click', () => toggleAIModal(true));
  if (btnCloseAI) btnCloseAI.addEventListener('click', () => toggleAIModal(false));
  if (aiRecCard) {
    aiRecCard.addEventListener('click', () => toggleAIModal(true));
    aiRecCard.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleAIModal(true); }
    });
  }

  // Status texts are built all over this file with emoji; the hardware theme shows plain text
  const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]+\s*/gu;
  ['transition-status-banner', 'ai-rec-technique', 'ai-rec-reason', 'ai-rec-confidence', 'ai-headline-box',
   'ai-source-badge', 'transition-state-sub', 'phrase-hud-counter'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const clean = () => {
      const t = el.textContent;
      const plain = t.replace(EMOJI, '').trim();
      if (plain !== t) el.textContent = plain;
    };
    new MutationObserver(clean).observe(el, { childList: true, characterData: true, subtree: true });
    clean();
  });
  if (btnRefreshAI) btnRefreshAI.addEventListener('click', () => fetchAIStrategy());

  // Direction Switcher Handlers
  function setTransitionDirection(dir) {
    transitionDirection = dir;
    if (dir === '1_to_2') {
      if (dirPill1To2) dirPill1To2.classList.add('active');
      if (dirPill2To1) dirPill2To1.classList.remove('active');
      if (wfTagDeck1) {
        wfTagDeck1.textContent = 'DECK 1 (OUTGOING)';
        wfTagDeck1.className = 'legend-tag tag-deck-1 is-outgoing';
      }
      if (wfTagDeck2) {
        wfTagDeck2.textContent = 'DECK 2 (INCOMING)';
        wfTagDeck2.className = 'legend-tag tag-deck-2 is-incoming';
      }
      if (aiFlowBadge) aiFlowBadge.textContent = 'DECK 1 ➔ DECK 2';
    } else {
      if (dirPill2To1) dirPill2To1.classList.add('active');
      if (dirPill1To2) dirPill1To2.classList.remove('active');
      if (wfTagDeck1) {
        wfTagDeck1.textContent = 'DECK 1 (INCOMING)';
        wfTagDeck1.className = 'legend-tag tag-deck-1 is-incoming';
      }
      if (wfTagDeck2) {
        wfTagDeck2.textContent = 'DECK 2 (OUTGOING)';
        wfTagDeck2.className = 'legend-tag tag-deck-2 is-outgoing';
      }
      if (aiFlowBadge) aiFlowBadge.textContent = 'DECK 2 ➔ DECK 1';
    }
    // Crossfader remains permanently centered at 50%
    if (crossfader) crossfader.value = 50;
    engine.setCrossfader(50, 'club');

    transitionStatusBanner.textContent = `MIX FLOW: ${dir === '1_to_2' ? 'DECK 1 ➔ DECK 2' : 'DECK 2 ➔ DECK 1'}`;
    updateHarmonicCompatibility();
    updateAIRecCard();
    strategyInputsChanged();
    updateTransitionOverlay();
    prefetchIncoming();
  }

  function toggleTransitionDirection() {
    setTransitionDirection(transitionDirection === '1_to_2' ? '2_to_1' : '1_to_2');
  }

  if (dirPill1To2) dirPill1To2.addEventListener('click', () => setTransitionDirection('1_to_2'));
  if (dirPill2To1) dirPill2To1.addEventListener('click', () => setTransitionDirection('2_to_1'));
  if (btnSwapDir) btnSwapDir.addEventListener('click', () => toggleTransitionDirection());

  function formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) seconds = 0;
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
  }

  // --- Technique Selector ---
  document.querySelectorAll('#technique-selector .pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#technique-selector .pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedTechnique = btn.dataset.tech;
      updateTechniqueUI();
    });
  });

  function updateTechniqueUI() {
    if (selectedTechnique === 'auto') {
      transitionStateSub.textContent = 'AI PICKS · EVERY OPTION SOUND-CHECKED';
    } else {
      const names = {
        'bass_swap': '💥 BASS SWAP (16/32 BARS)',
        'echo_freeze': '❄️ ECHO FREEZE CUT',
        'loop_roll': '🌀 STUTTER LOOP ROLL RISER',
        'vinyl_brake': '⚡ TURNTABLE BRAKE & DROP',
        'spinback': '💫 VINYL SPINBACK & DROP',
        'noise_riser': '📈 WHITE NOISE RISER & DROP',
        'festival_drop': '🎆 FESTIVAL BUILD & DROP',
        'hard_cut': '✂️ HARD CUT (BEAT 1 SNAP)',
        'power_cut': '⚡ POWER CUT → SLAM',
        'fake_drop': '💣 FAKE DROP → BOOM',
        'silence_drop': '🔇 SILENCE DROP',
        'rewind': '🔄 REWIND PULL-UP',
        'double_drop': '💥💥 DOUBLE DROP',
        'beatmash_drop': '🎛️ BEATMASH → DROP',
        'backspin_slam': '🌀 BACKSPIN SLAM',
        'tension_riser': '📈 TENSION BUILD → DROP',
        'stutter_edit': '✂️ STUTTER EDIT',
        'filter_sweep': '🔊 FILTER SWEEP',
        'echo_dissolve': '🌊 ECHO DISSOLVE',
        'acapella_mashup': '🎤 ACAPELLA MASHUP',
        'vocal_chop': '🎵 VOCAL CHOP BRIDGE',
        'drum_swap': '🥁 DRUM SWAP'
      };
      transitionStateSub.textContent = names[selectedTechnique] || selectedTechnique.toUpperCase();
    }
  }

  // --- Explicit File Upload Trigger ---
  d1BtnUpload.addEventListener('click', () => { unlockAudio(); d1FileInput.click(); });
  d2BtnUpload.addEventListener('click', () => { unlockAudio(); d2FileInput.click(); });

  d1FileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) handleFileUpload(e.target.files[0], 'deck_1');
  });
  d2FileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) handleFileUpload(e.target.files[0], 'deck_2');
  });

  // --- Drag and Drop on Deck Panels ---
  function setupDragAndDrop(panel, deck) {
    panel.addEventListener('dragover', (e) => { e.preventDefault(); panel.classList.add('drag-over'); });
    panel.addEventListener('dragleave', () => { panel.classList.remove('drag-over'); });
    panel.addEventListener('drop', (e) => {
      e.preventDefault();
      panel.classList.remove('drag-over');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        unlockAudio();
        handleFileUpload(e.dataTransfer.files[0], deck);
      }
    });
  }
  setupDragAndDrop(deck1Panel, 'deck_1');
  setupDragAndDrop(deck2Panel, 'deck_2');

  // --- Upload Handler (Instant Client-Side Audio Loading + Background DSP Analysis) ---
  async function handleFileUpload(file, deck) {
    if (!file) return;
    const isDeck1 = (deck === 'deck_1');
    const deckNum = isDeck1 ? 1 : 2;
    const deckName = isDeck1 ? 'DECK 1' : 'DECK 2';
    const displayName = file.name.length > 25 ? file.name.substring(0, 22) + '...' : file.name;

    transitionStatusBanner.textContent = `LOADING ${displayName.toUpperCase()} INTO ${deckName}...`;

    // 1. Instant client-side blob URL for 0ms latency playback
    const blobUrl = URL.createObjectURL(file);
    const cleanTitle = file.name.replace(/\.[^/.]+$/, '').replace(/_/g, ' ');

    const initialWave = (deckNum === 1 ? wave1 : wave2).synthesizeWaveform(180.0, 128.0);
    const spbInit = 60.0 / 128.0;
    const initialBeats = [];
    const initialDownbeats = [];
    const initialPhrases = [];
    for (let b = 0; b < Math.floor(180.0 / spbInit); b++) {
      const bt = Math.round(b * spbInit * 1000) / 1000;
      initialBeats.push(bt);
      if (b % 4 === 0) initialDownbeats.push(bt);
      if (b % 64 === 0) initialPhrases.push(bt);
    }

    const initialTrack = {
      title: cleanTitle,
      filename: file.name,
      file_id: `${deck}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`,
      audio_url: blobUrl,
      analyzing: true,  // placeholder grid/cues until the server analysis arrives
      bpm: 128.0,
      camelot: '8A',
      key: 'A Minor',
      duration: 180.0,
      beat_times: initialBeats,
      downbeat_times: initialDownbeats,
      phrase_16_times: initialPhrases,
      phrase_8_times: initialPhrases,
      suggested_cue_intro: 0.0,
      suggested_cue_outro: 150.0,
      waveform: initialWave,
      acoustic_profile: {
        intro_vocal_score: 0.05,
        outro_vocal_score: 0.05,
        intro_percussion: 'driving_4_4',
        outro_percussion: 'driving_4_4'
      }
    };

    // 2. Load immediately into Deck & Waveform!
    loadTrackIntoDeck(deckNum, initialTrack);
    transitionStatusBanner.textContent = `${deckName}: ${cleanTitle.toUpperCase()} LOADED & READY TO PLAY`;

    // 2b. Instant duration from audio element metadata (fires in ~10ms)
    const targetAudio = (deckNum === 1) ? engine.deck1.audio : engine.deck2.audio;
    const onMeta = () => {
      if (targetAudio.duration && !isNaN(targetAudio.duration) && isFinite(targetAudio.duration)) {
        const trueDur = targetAudio.duration;
        const cur = (deckNum === 1) ? track1Data : track2Data;
        if (cur && cur.audio_url === blobUrl) {
          cur.duration = trueDur;
          cur.suggested_cue_outro = Math.max(0, trueDur - 30);
          const curSpb = 60.0 / (cur.bpm || 128.0);
          cur.beat_times = [];
          cur.downbeat_times = [];
          cur.phrase_16_times = [];
          for (let b = 0; b < Math.floor(trueDur / curSpb); b++) {
            const bt = Math.round(b * curSpb * 1000) / 1000;
            cur.beat_times.push(bt);
            if (b % 4 === 0) cur.downbeat_times.push(bt);
            if (b % 64 === 0) cur.phrase_16_times.push(bt);
          }
          if (deckNum === 1) {
            wave1.loadTrack(cur);
            d1Time.textContent = `00:00.00 / ${formatTime(trueDur)}`;
          } else {
            wave2.loadTrack(cur);
            d2Time.textContent = `00:00.00 / ${formatTime(trueDur)}`;
          }
          updateTransitionOverlay();
        }
      }
    };
    targetAudio.addEventListener('loadedmetadata', onMeta, { once: true });

    // 3. Duration from the decoded audio (loadTrackIntoDeck draws its waveform from it too)
    const targetDeck = (deckNum === 1) ? engine.deck1 : engine.deck2;
    targetDeck.audio.loaded.then((audioBuffer) => {
      const cur = (deckNum === 1) ? track1Data : track2Data;
      if (!audioBuffer || cur !== initialTrack || !cur.analyzing) return;
      cur.duration = audioBuffer.duration;
      cur.suggested_cue_outro = Math.max(0, audioBuffer.duration - 30);
    }).catch(() => {});

    // 4. Background server analysis for BPM, Camelot key, and AI acoustic profile
    const formData = new FormData();
    formData.append('file', file);
    formData.append('deck', deck);

    try {
      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`);
      }
      const data = await res.json();
      if (data.status === 'success' && data.track) {
        const sTrack = data.track;
        const currentTrack = (deckNum === 1) ? track1Data : track2Data;
        if (currentTrack === initialTrack) {  // not replaced by another track meanwhile
          currentTrack.bpm = sTrack.bpm || currentTrack.bpm;
          currentTrack.camelot = sTrack.camelot || currentTrack.camelot;
          currentTrack.key = sTrack.key || currentTrack.key;
          currentTrack.duration = sTrack.duration || currentTrack.duration;
          currentTrack.beat_times = sTrack.beat_times || currentTrack.beat_times;
          currentTrack.downbeat_times = sTrack.downbeat_times || currentTrack.downbeat_times;
          currentTrack.phrase_16_times = sTrack.phrase_16_times || currentTrack.phrase_16_times;
          currentTrack.phrase_8_times = sTrack.phrase_8_times || currentTrack.phrase_8_times;
          currentTrack.suggested_cue_intro = sTrack.suggested_cue_intro || currentTrack.suggested_cue_intro;
          currentTrack.suggested_cue_outro = sTrack.suggested_cue_outro || currentTrack.suggested_cue_outro;
          currentTrack.acoustic_profile = sTrack.acoustic_profile || currentTrack.acoustic_profile;
          currentTrack.file_id = sTrack.file_id || currentTrack.file_id;
          ['grid', 'phrase_32_times', 'drop_times', 'section_boundaries', 'section_map',
           'bar_low_db', 'loudness_db', 'vocal_source'].forEach(k => {
            if (sTrack[k]) currentTrack[k] = sTrack[k];
          });
          currentTrack.hot_cues = computeTrackHotCues(currentTrack);
          if (sTrack.waveform && !(currentTrack.waveform && currentTrack.waveform.client)) {
            currentTrack.waveform = sTrack.waveform;
          }

          if (deckNum === 1) {
            d1Bpm.textContent = currentTrack.bpm.toFixed(2);
            d1Key.textContent = `${currentTrack.camelot} (${currentTrack.key})`;
            masterBpmEl.textContent = currentTrack.bpm.toFixed(2);
            wave1.loadTrack(currentTrack);
          } else {
            d2Bpm.textContent = currentTrack.bpm.toFixed(2);
            d2Key.textContent = `${currentTrack.camelot} (${currentTrack.key})`;
            wave2.loadTrack(currentTrack);
          }

          updateHarmonicCompatibility();
          updateAIRecCard();
          if (track1Data && track2Data) {
            btnExportMix.disabled = false;
            strategyInputsChanged();
          }
          transitionStatusBanner.textContent = `${deckName}: ANALYSIS COMPLETE (${currentTrack.bpm.toFixed(1)} BPM, ${currentTrack.camelot})`;
          prefetchIncoming();
          listenForVocals(currentTrack);
        }
      }
    } catch (err) {
      console.warn('Server background analysis failed, local playback remains active:', err);
      transitionStatusBanner.textContent = `${deckName}: READY FOR LIVE MIXING (LOCAL MODE)`;
    } finally {
      initialTrack.analyzing = false;
      startQueuedMix();
    }
  }

  // ═══════════════════════════════════════════════════
  // PRO DJ HOT CUES: Automatic 4-Point Detection
  // ═══════════════════════════════════════════════════
  /** Main drop and the build-up into it, from the per-bar bass level (bar_low_db, one value per
   *  bar from the first downbeat). The drop is the first strong place where the bass comes back
   *  after 4+ bars away and stays; the build-up is where it went away (at most 16 bars earlier,
   *  never before the intro). Null when the track has no clear drop. */
  function measuredDropCues(track, dur, intro) {
    const low = track.bar_low_db, bars = track.downbeat_times, grid = track.grid;
    if (!low || !bars || !grid || low.length < 24) return null;
    const median = [...low].sort((a, b) => a - b)[Math.floor(low.length / 2)];
    const mean = (a, b) => low.slice(a, b).reduce((s, v) => s + v, 0) / (b - a);
    const onPhrase = b => ((b - (grid.phrase_offset_bars || 0)) % 4 + 4) % 4 === 0;
    const entries = [];
    for (let b = 4; b < low.length - 3 && bars[b] < 0.75 * dur; b++) {
      const after = Math.min(...low.slice(b, b + 4));
      const jump = after - low[b - 1];
      if (after > median && mean(b - 4, b) < median - 10 && jump >= 12) entries.push({ b, jump });
    }
    if (!entries.length) return null;
    const strongest = Math.max(...entries.map(e => e.jump));
    const drop = entries.find(e => e.jump >= 0.6 * strongest).b;
    let build = drop - 4;
    for (let b = drop - 4; b >= Math.max(1, drop - 16); b--) {
      if (!onPhrase(b) || bars[b] < intro) continue;
      if (mean(b, drop) >= median - 6) break;
      build = b;
    }
    if (bars[build] <= intro) build = drop;  // drop right after the intro: no separate build
    return { drop: bars[drop], build: bars[build] };
  }

  function computeTrackHotCues(track) {
    if (!track) return { cue_1: 0, cue_2: 30, cue_3: 60, cue_4: 120 };
    const dur = track.duration || 180;
    const bpm = track.bpm || 128;
    const spb = 60.0 / Math.max(60, bpm);

    // Cue 1 (INTRO): First downbeat (or suggested_cue_intro or 0)
    let cue1 = (track.suggested_cue_intro !== undefined && track.suggested_cue_intro >= 0)
      ? track.suggested_cue_intro
      : (track.downbeat_times && track.downbeat_times.length > 0 ? track.downbeat_times[0] : 0.0);

    // Cue 2 (VERSE / BREAKDOWN): Melodic breakdown entrance (phrase 2)
    let cue2 = Math.min(dur * 0.45, Math.max(cue1 + 16 * 4 * spb, cue1 + 25));
    if (track.phrase_16_times && track.phrase_16_times.length > 1) {
      cue2 = track.phrase_16_times[1];
    }

    // Cue 3 (MAIN DROP): Peak energy drop after breakdown (phrase 3 or mid)
    let cue3 = Math.min(dur * 0.70, Math.max(cue2 + 16 * 4 * spb, dur * 0.48));
    if (track.phrase_16_times && track.phrase_16_times.length > 2) {
      cue3 = track.phrase_16_times[2];
    }

    // Measured instead, when the analysis has the bass level per bar: the main drop is where the
    // bass comes back after 4+ bars away, the build-up is where it went away.
    const measured = measuredDropCues(track, dur, cue1);
    if (measured) {
      cue2 = measured.build;
      cue3 = measured.drop;
    }

    // Cue 4 (OUTRO): Start of outro beats (~16 bars before track end)
    let cue4 = Math.max(cue3 + 15, dur - (16 * 4 * spb));
    if (track.suggested_cue_outro && track.suggested_cue_outro > cue3) {
      cue4 = track.suggested_cue_outro;
    } else if (track.phrase_16_times && track.phrase_16_times.length > 3) {
      const lastPhrase = track.phrase_16_times[track.phrase_16_times.length - 1];
      if (lastPhrase > dur * 0.65) cue4 = lastPhrase;
    }

    return {
      cue_1: Math.round(cue1 * 100) / 100,
      cue_2: Math.round(cue2 * 100) / 100,
      cue_3: Math.round(cue3 * 100) / 100,
      cue_4: Math.round(cue4 * 100) / 100,
    };
  }

  // --- Load Track Into Deck ---
  /** RGB waveform peaks straight from the decoded audio, 60 per second: much sharper than the
   *  server's 10 per second, which the display could only interpolate between. */
  function decodedWaveform(audioBuffer) {
    const numBins = Math.min(12000, Math.max(3600, Math.floor(audioBuffer.duration * 60)));
    const chData = audioBuffer.getChannelData(0);
    const binSize = Math.max(1, Math.floor(chData.length / numBins));
    const overall = [];
    const low = [];
    const mid = [];
    const high = [];

    // Fast single-pass 3-band acoustic filtering (< 30ms)
    const sr = audioBuffer.sampleRate;
    const step = 4; // Sub-sample 4:1 for blazing fast DSP
    const alphaLow = Math.min(1.0, (2 * Math.PI * 250 / sr) * step);
    let yL = 0;
    let prevSample = 0;

    for (let b = 0; b < numBins; b++) {
      const start = b * binSize;
      const end = Math.min(chData.length, start + binSize);
      let maxTot = 0, maxLow = 0, maxHigh = 0;

      for (let i = start; i < end; i += step) {
        const x = chData[i];
        const ax = Math.abs(x);
        if (ax > maxTot) maxTot = ax;

        // Low-pass filter for sub-bass & kicks (< 250 Hz)
        yL += alphaLow * (x - yL);
        const aL = Math.abs(yL);
        if (aL > maxLow) maxLow = aL;

        // High-frequency transient delta for hi-hats & cymbals (> 2500 Hz)
        const diff = Math.abs(x - prevSample);
        if (diff > maxHigh) maxHigh = diff;
        prevSample = x;
      }

      const totVal = Math.min(1.0, Math.round(maxTot * 1.25 * 1000) / 1000);
      const lowVal = Math.min(1.0, Math.round(maxLow * 1.65 * 1000) / 1000);
      const highVal = Math.min(1.0, Math.round(maxHigh * 0.75 * 1000) / 1000);
      const midVal = Math.max(0.0, Math.min(1.0, Math.round((totVal - lowVal * 0.45 - highVal * 0.3) * 1.2 * 1000) / 1000));

      overall.push(totVal);
      low.push(lowVal);
      mid.push(midVal);
      high.push(highVal);
    }

    return { overall, low, mid, high, low_red: low, mid_green: mid, high_blue: high, client: true };
  }

  /** Once the deck has decoded the track, draw the full-resolution waveform. */
  function drawDecodedWaveform(deckNum, track) {
    const deck = deckNum === 1 ? engine.deck1 : engine.deck2;
    Promise.resolve(deck.audio.loaded).then((audioBuffer) => {
      if (!audioBuffer || track !== (deckNum === 1 ? track1Data : track2Data)) return;
      track.waveform = decodedWaveform(audioBuffer);
      (deckNum === 1 ? wave1 : wave2).loadTrack(track);
    }).catch((err) => console.warn('Waveform from decoded audio unavailable:', err));
  }

  function loadTrackIntoDeck(deckNum, track) {
    resetDeckEQs(deckNum);
    track.hot_cues = computeTrackHotCues(track);

    // Update Hot Cue buttons title/tooltip with exact timestamps
    const cueLabels = ['INTRO', 'BUILD', 'MAIN DROP', 'OUTRO'];
    [1, 2, 3, 4].forEach(cNum => {
      const btn = document.getElementById(`d${deckNum}-cue-${cNum}`);
      if (btn) {
        const sec = track.hot_cues[`cue_${cNum}`];
        btn.title = `Snap to Cue ${cNum}: ${cueLabels[cNum - 1]} (${formatTime(sec)})`;
      }
    });

    const ac = track.acoustic_profile || {};
    const outroVocal = ac.outro_vocal_score !== undefined ? ac.outro_vocal_score : (ac.intro_vocal_score || 0.0);
    const vocalPct = Math.round(outroVocal * 100);
    const perc = ac.outro_percussion || ac.intro_percussion || 'driving_4_4';
    const phrases = (track.phrase_16_times && track.phrase_16_times.length) || (track.phrase_8_times && track.phrase_8_times.length) || 4;

    const bpmStr = (track.bpm && !isNaN(track.bpm)) ? track.bpm.toFixed(2) : '--.--';
    const keyStr = track.camelot || '--';

    if (deckNum === 1) {
      track1Data = track;
      d1Title.textContent = track.title || track.filename;
      d1Bpm.textContent = bpmStr;
      d1Key.textContent = keyStr;
      d1Key.title = track.key || '';
      if (d1VocalVal) {
        d1VocalVal.textContent = `${vocalPct}%`;
        d1VocalVal.title = vocalPct > 35 ? 'Vocals' : (vocalPct > 15 ? 'Mild vocals' : 'Clean');
        d1VocalVal.className = `lcd-val lcd-vocal-val ${vocalPct > 35 ? 'heavy' : (vocalPct > 15 ? 'moderate' : 'clean')}`;
      }
      if (d1DynamicVal) {
        d1DynamicVal.textContent = perc.replace(/_/g, ' ').toUpperCase();
      }
      if (d1PhraseVal) {
        d1PhraseVal.textContent = `${phrases} PHRASES`;
      }
      engine.deck1.loadTrack(track.audio_url);
      wave1.loadTrack(track);
      drawDecodedWaveform(1, track);
      if (track.bpm && !isNaN(track.bpm)) {
        masterBpmEl.textContent = track.bpm.toFixed(2);
      }
    } else {
      track2Data = track;
      d2Title.textContent = track.title || track.filename;
      d2Bpm.textContent = bpmStr;
      d2Key.textContent = keyStr;
      d2Key.title = track.key || '';
      if (d2VocalVal) {
        d2VocalVal.textContent = `${vocalPct}%`;
        d2VocalVal.title = vocalPct > 35 ? 'Vocals' : (vocalPct > 15 ? 'Mild vocals' : 'Clean');
        d2VocalVal.className = `lcd-val lcd-vocal-val ${vocalPct > 35 ? 'heavy' : (vocalPct > 15 ? 'moderate' : 'clean')}`;
      }
      if (d2DynamicVal) {
        d2DynamicVal.textContent = perc.replace(/_/g, ' ').toUpperCase();
      }
      if (d2PhraseVal) {
        d2PhraseVal.textContent = `${phrases} PHRASES`;
      }
      engine.deck2.loadTrack(track.audio_url);
      wave2.loadTrack(track);
      drawDecodedWaveform(2, track);
    }
    if (track1Data && track2Data) {
      btnExportMix.disabled = false;
      strategyInputsChanged();
    }
    updateHarmonicCompatibility();
    updateAIRecCard();
    updateTransitionOverlay();
    prefetchIncoming();
    listenForVocals(track);
  }

  /** Once per track, Gemini listens and marks which sections really have a lead vocal (the
   *  spectral detector flags nearly everything). Stored server-side with the analysis. */
  async function listenForVocals(track) {
    if (track.vocal_source || !track.file_id || !track.section_map) return;
    if ((aiModelSelect ? aiModelSelect.value : 'local') === 'local') return;
    try {
      const res = await fetch('/api/listen-vocals', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: track.file_id }),
      });
      const data = await res.json();
      if (data.status === 'success') {
        track.section_map = data.section_map;
        track.vocal_source = data.vocal_source;
        console.info(`Vocals relabelled by ${data.vocal_source}: ${track.section_map.filter(s => s.has_vocals).length}` +
                     `/${track.section_map.length} sections`);
      }
    } catch (err) {
      console.warn('Vocal listening pass unavailable:', err);
    }
  }

  // --- Quick Select Dropdowns ---
  d1QuickSelect.addEventListener('change', async (e) => {
    if (!e.target.value) return;
    unlockAudio();
    await loadPresetTrack(e.target.value, 'deck_1');
  });
  d2QuickSelect.addEventListener('change', async (e) => {
    if (!e.target.value) return;
    unlockAudio();
    await loadPresetTrack(e.target.value, 'deck_2');
  });

  async function loadPresetTrack(fileId, deck) {
    if (!fileId) return;
    const isDeck1 = (deck === 'deck_1');
    const deckName = isDeck1 ? 'DECK 1' : 'DECK 2';
    transitionStatusBanner.textContent = `LOADING ${fileId} INTO ${deckName}...`;

    const form = new FormData();
    form.append('file_id', fileId);
    form.append('deck', deck);

    try {
      const res = await fetch('/api/load-preset', { method: 'POST', body: form });
      if (!res.ok) {
        throw new Error(`Server returned ${res.status}: ${res.statusText}`);
      }
      const data = await res.json();
      if (data.status === 'success' && data.track) {
        loadTrackIntoDeck(isDeck1 ? 1 : 2, data.track);
        transitionStatusBanner.textContent = `${deckName}: ${data.track.title || fileId} LOADED & READY`;
      } else {
        transitionStatusBanner.textContent = `FAILED TO LOAD: ${data.detail || 'Unknown error'}`;
      }
    } catch (e) {
      console.error('Failed to load preset:', e);
      transitionStatusBanner.textContent = `ERROR LOADING PRESET: ${e.message}`;
    }
  }

  async function loadAvailableTracksDropdown() {
    try {
      const res = await fetch('/api/presets');
      const data = await res.json();
      if (data.status === 'success' && data.tracks) {
        const opts = ['<option value="">-- Choose Preset Track --</option>'];
        data.tracks.forEach(t => {
          const titleClean = t.title.length > 35 ? t.title.substring(0, 32) + '...' : t.title;
          const bpmClean = t.bpm ? t.bpm.toFixed(1) : '128.0';
          opts.push(`<option value="${t.file_id}">${titleClean} (${bpmClean} BPM, ${t.camelot || '--'})</option>`);
        });
        const html = opts.join('');
        if (d1QuickSelect) d1QuickSelect.innerHTML = html;
        if (d2QuickSelect) d2QuickSelect.innerHTML = html;
      }
    } catch (e) {
      console.warn('Could not load preset dropdowns:', e);
    }
  }
  loadAvailableTracksDropdown();

  async function loadInitialDefaultTracks() {
    try {
      const res = await fetch('/api/generate-demo-tracks', { method: 'POST' });
      const data = await res.json();
      if (data.status === 'success' && data.track_1 && data.track_2) {
        if (!track1Data) loadTrackIntoDeck(1, data.track_1);
        if (!track2Data) loadTrackIntoDeck(2, data.track_2);
        transitionStatusBanner.textContent = 'CLUB SET 1 LOADED: LASERPACK (DECK 1) & OVERWORLD (DECK 2). READY TO PLAY!';
      } else {
        transitionStatusBanner.textContent = 'LOCAL-FIRST DJ: LOAD AUDIO BY CLICKING BROWSE OR DRAGGING TRACKS ONTO DECK 1 & 2';
      }
    } catch (e) {
      console.warn('Could not auto-load default tracks:', e);
      transitionStatusBanner.textContent = 'LOCAL-FIRST DJ: LOAD AUDIO BY CLICKING BROWSE OR DRAGGING TRACKS ONTO DECK 1 & 2';
    }
  }
  loadInitialDefaultTracks();

  async function checkServerAIStatus() {
    try {
      const res = await fetch('/api/ai-status');
      const data = await res.json();
      if (data.status === 'success') {
        if (data.jev_configured) {
          serverHasJev = true;
          if (jevKeyInput && !jevKeyInput.value) {
            jevKeyInput.placeholder = '✓ Active via server environment (Ready)';
          }
        }
        if (data.gemini_configured || data.has_gemini) {
          serverHasGemini = true;
          if (geminiKeyInput && !geminiKeyInput.value) {
            geminiKeyInput.placeholder = '✓ Active via server environment (Ready)';
          }
        }
        if (aiSourceBadge) {
          if (data.jev_configured && data.gemini_configured) {
            aiSourceBadge.textContent = '✨ Gemini + ⚡ Jev fallback Active (Server)';
          } else if (data.jev_configured) {
            aiSourceBadge.textContent = '⚡ TypeSafe Jev System One Active (Server)';
          } else if (data.gemini_configured) {
            aiSourceBadge.textContent = '✨ Google Gemini AI Active (Server)';
          }
        }
        if (aiModelSelect && !localStorage.getItem('ai_dj_model')) {
          aiModelSelect.value = data.gemini_configured ? 'gemini-3.8-flash' : (data.jev_configured ? 'jev-latest' : 'local');
          updateEngineChip();
        }
      }
    } catch (e) {
      console.warn('Could not check server AI status:', e);
    }
  }
  checkServerAIStatus();



  // --- Harmonic Compatibility & AI Live Recommendation ---
  async function updateHarmonicCompatibility() {
    if (!track1Data || !track2Data) return;
    try {
      const res = await fetch(`/api/compatibility?camelot_1=${track1Data.camelot}&camelot_2=${track2Data.camelot}&direction=${transitionDirection}`);
      const compat = await res.json();
      const outCam = (transitionDirection === '1_to_2') ? track1Data.camelot : track2Data.camelot;
      const inCam = (transitionDirection === '1_to_2') ? track2Data.camelot : track1Data.camelot;
      camelotStatusEl.textContent = `${outCam} → ${inCam}: ${compat.relationship}`;
      if (compat.is_harmonically_compatible) {
        camelotStatusEl.classList.add('match-perfect');
      } else {
        camelotStatusEl.classList.remove('match-perfect');
      }
    } catch (e) {
      console.error(e);
    }
  }

  async function updateAIRecCard() {
    if (!track1Data || !track2Data || track1Data.analyzing || track2Data.analyzing) return;
    try {
      const q1 = encodeURIComponent(track1Data.file_id);
      const q2 = encodeURIComponent(track2Data.file_id);
      const res = await fetch(`/api/ai-recommendation?file_id_1=${q1}&file_id_2=${q2}&direction=${transitionDirection}`);
      const data = await res.json();
      if (data.status === 'success') {
        currentAIRec = data.recommendation;
        aiRecTechnique.textContent = currentAIRec.technique_name;
        aiRecReason.textContent = currentAIRec.reasoning;
        aiRecConfidence.textContent = `${Math.round(currentAIRec.confidence * 100)}% MATCH`;
        updateTechniqueUI();
      }
    } catch (e) {
      console.error(e);
    }
  }

  function hideTransitionButtons() {
    ['btn-abort-transition', 'btn-manual-override'].forEach(id => {
      const b = document.getElementById(id);
      if (b) b.style.display = 'none';
    });
  }

  // ═══════════════════════════════════════════════════
  // Abort: cancel everything scheduled, keep whichever deck is carrying the room
  // ═══════════════════════════════════════════════════
  function abortTransition() {
    const t = activeTransition;
    if (!t) return;
    clearTransitionTimers(t);
    activeTransition = null;
    const now = engine.ctx.currentTime;
    const keepOut = t.outDeck.isPlaying && t.outDeck.faderGain.gain.value > 0.05;
    const [keep, drop, keepNum, dropBtn] = keepOut
      ? [t.outDeck, t.inDeck, t.outDeckNum, t.inBtnPlay]
      : [t.inDeck, t.outDeck, t.inDeckNum, t.outBtnPlay];
    drop.pause();
    setPlayUI(dropBtn, false);
    [engine.deck1, engine.deck2].forEach(d => {
      d.resetAllFX();
      MixPlanner.neutral(d, now, d === keep ? 1 : 0);
    });
    resetDeckEQs(1);
    resetDeckEQs(2);
    [1, 2].forEach(n => {
      const fader = document.getElementById(`d${n}-vol-fader`);
      if (fader) fader.value = n === keepNum ? 100 : 0;
      const f = document.getElementById(`d${n}-filter`);
      if (f) f.value = 0;
    });
    isTransitioning = false;
    btnTriggerTransition.classList.remove('in-transition');
    phraseHud.classList.add('hidden');
    hideTransitionButtons();
    transitionStatusBanner.textContent = `🛑 TRANSITION ABORTED: DECK ${keepNum} STAYS LIVE`;
  }

  // ═══════════════════════════════════════════════════
  // Manual override: stop the automation, leave every knob where it is, DJ takes over
  // ═══════════════════════════════════════════════════
  function manualOverrideTransition() {
    const t = activeTransition;
    if (!t) return;
    clearTransitionTimers(t);
    activeTransition = null;
    const now = engine.ctx.currentTime;
    MixPlanner.holdAutomation(t.outDeck, now);
    MixPlanner.holdAutomation(t.inDeck, now);
    [t.outDeck, t.inDeck].forEach(d => d._cancelRepeats());   // a loop roll in progress stops
    // The isolator bass kill has no knob: hand it over to the visible LOW EQ (killed) so the DJ
    // can bring the bass back
    [[t.outDeckNum, t.outDeck], [t.inDeckNum, t.inDeck]].forEach(([n, deck]) => {
      if (deck.lowCut1.frequency.value > 100) {
        applyDeckEQ(n, 'low', -24, true, true);
        deck.eqLow.gain.cancelScheduledValues(now);
        deck.eqLow.gain.setValueAtTime(-24, now);
        [deck.lowCut1, deck.lowCut2].forEach(f => f.frequency.setValueAtTime(10, now + 0.02));
      }
    });
    isTransitioning = false;
    btnTriggerTransition.classList.remove('in-transition');
    phraseHud.classList.add('hidden');
    hideTransitionButtons();
    transitionStatusBanner.textContent = '🎛️ MANUAL MODE: automation stopped, both decks playing. Faders and EQs are yours.';
  }

  async function fetchAIStrategy() {
    if (!track1Data || !track2Data) {
      const missing = (!track1Data && !track2Data) 
        ? 'Both Deck 1 & Deck 2' 
        : (!track1Data ? 'Deck 1' : 'Deck 2');

      if (btnRefreshAI) {
        btnRefreshAI.innerHTML = `<span>⚠️ Load ${missing} First</span>`;
        btnRefreshAI.style.borderColor = '#f59e0b';
        setTimeout(() => {
          btnRefreshAI.innerHTML = '🔄 Re-Analyze with AI';
          btnRefreshAI.style.borderColor = '';
        }, 2200);
      }

      if (aiHeadlineBox) {
        aiHeadlineBox.textContent = `⚡ READY // AWAITING AUDIO (${missing.toUpperCase()})`;
      }
      if (aiRationaleText) {
        aiRationaleText.innerHTML = `
          <div style="background: rgba(2, 132, 199, 0.12); border: 1px solid rgba(56, 189, 248, 0.35); border-radius: 8px; padding: 12px 16px; margin: 8px 0; color: #e0f2fe; line-height: 1.5;">
            <strong>Load Tracks to Compute AI Transition:</strong> Please load an audio file into <strong>${missing}</strong>.
            The AI engine will automatically scan vocal formant envelopes, percussion density, and Camelot wheel keys to compute the optimal transition drop!
          </div>
        `;
      }
      if (aiSourceBadge) {
        aiSourceBadge.textContent = 'Awaiting Tracks';
      }
      if (aiTacticalSteps) {
        aiTacticalSteps.innerHTML = `
          <li>1. Drag & drop an audio file onto <strong>${missing}</strong> or choose from the quick-select menu.</li>
          <li>2. AI will detect downbeat drops, vocal collision risk, and optimal harmonic mixing curves.</li>
          <li>3. Click <strong>"Apply AI Strategy to Console"</strong> to lock in the configuration with 1 click.</li>
        `;
      }
      return;
    }

    const jevKey = jevKeyInput ? jevKeyInput.value.trim() : (localStorage.getItem('jev_api_key') || '');
    const geminiKey = geminiKeyInput ? geminiKeyInput.value.trim() : (localStorage.getItem('gemini_api_key') || '');
    const model = aiModelSelect ? aiModelSelect.value : (localStorage.getItem('ai_dj_model') || 'gemini-3.8-flash');
    const modelLabel = (model === 'local') ? 'Local Acoustic DSP' : 
                       (model.startsWith('jev') ? 'TypeSafe Jev System One (<200ms)' : 
                       'Gemini 3.8 Flash');

    if (btnRefreshAI) {
      btnRefreshAI.disabled = true;
      btnRefreshAI.innerHTML = `<span>🌀 Analyzing with ${modelLabel}...</span>`;
    }
    if (aiHeadlineBox) {
      aiHeadlineBox.textContent = `🔍 Analyzing Audio Acoustic Formants & Keys (${modelLabel})...`;
    }
    if (aiRationaleText) {
      aiRationaleText.textContent = `Querying AI engine with vocal formants, percussion density, and Camelot harmonic keys...`;
    }

    try {
      const form = new FormData();
      form.append('file_id_1', track1Data.file_id || track1Data.filename || 'deck_1_track');
      form.append('file_id_2', track2Data.file_id || track2Data.filename || 'deck_2_track');
      form.append('direction', transitionDirection);
      if (jevKey) form.append('jev_api_key', jevKey);
      if (geminiKey) form.append('gemini_api_key', geminiKey);
      form.append('model', model);

      // Pass full metadata payload so local tracks analyze with 100% precision
      form.append('track_1_meta', JSON.stringify({
        title: track1Data.title || track1Data.filename,
        bpm: track1Data.bpm || 128.0,
        camelot: track1Data.camelot || '8A',
        key: track1Data.key || 'A Minor',
        duration: track1Data.duration || 180.0,
        suggested_cue_intro: track1Data.suggested_cue_intro || 0.0,
        suggested_cue_outro: track1Data.suggested_cue_outro || 120.0,
        phrase_16_times: track1Data.phrase_16_times || [],
        acoustic_profile: track1Data.acoustic_profile || {}
      }));
      form.append('track_2_meta', JSON.stringify({
        title: track2Data.title || track2Data.filename,
        bpm: track2Data.bpm || 128.0,
        camelot: track2Data.camelot || '8A',
        key: track2Data.key || 'A Minor',
        duration: track2Data.duration || 180.0,
        suggested_cue_intro: track2Data.suggested_cue_intro || 0.0,
        suggested_cue_outro: track2Data.suggested_cue_outro || 120.0,
        phrase_16_times: track2Data.phrase_16_times || [],
        acoustic_profile: track2Data.acoustic_profile || {}
      }));

      const res = await fetch('/api/ai-strategy', { method: 'POST', body: form });
      const data = await res.json();
      if (data.status === 'success' && data.strategy) {
        currentAIStrategy = data.strategy;
        renderAIStrategy(data.strategy);
        if (btnRefreshAI) {
          btnRefreshAI.innerHTML = '✅ Strategy Updated!';
        }
      } else {
        throw new Error(data.detail || 'Failed to generate AI strategy');
      }
    } catch (e) {
      console.warn('AI strategy fetch error:', e);
      if (btnRefreshAI) {
        btnRefreshAI.innerHTML = '⚠️ Retry AI Strategy';
      }
    } finally {
      setTimeout(() => {
        if (btnRefreshAI) {
          btnRefreshAI.disabled = false;
          btnRefreshAI.innerHTML = '🔄 Re-Analyze with AI';
        }
      }, 1500);
    }
  }

  function renderAIStrategy(st) {
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    if (aiRecTechnique) aiRecTechnique.textContent = st.ai_headline;
    if (aiRecConfidence) {
      if (st.blend_score !== undefined && st.blend_score !== null) {
        aiRecConfidence.textContent = `${st.blend_score.toFixed(0)}% BLEND`;
      } else {
        aiRecConfidence.textContent = `${Math.round((st.confidence || 0.95) * 100)}% MATCH`;
      }
    }
    if (aiRecReason) aiRecReason.textContent = st.strategic_rationale;

    if (aiHeadlineBox) aiHeadlineBox.textContent = st.ai_headline;
    
    if (aiRationaleText) {
      if (st.gemini_error) {
        aiRationaleText.innerHTML = `
          <div style="background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.4); border-radius: 6px; padding: 8px 12px; margin-bottom: 10px; color: #fbbf24; font-size: 11px;">
            ⚠️ <strong>Gemini Notice:</strong> ${st.gemini_error}. Strategy calculated by ${st.engine_source || 'the Local Physical Acoustic Engine'}.
          </div>
          <div>${st.strategic_rationale}</div>
        `;
      } else {
        aiRationaleText.textContent = st.strategic_rationale;
      }
    }

    if (aiSourceBadge) {
      aiSourceBadge.textContent = `${st.engine_source || 'AI Engine'} • ${timeStr}`;
    }
    if (st.engine_source && st.engine_source.includes('Jev')) {
      serverHasJev = true;
    }

    if (aiMetricTech) aiMetricTech.textContent = st.recommended_technique.replace('_', ' ').toUpperCase();
    if (aiMetricBars) aiMetricBars.textContent = `${st.recommended_bars} BARS`;
    if (aiMetricPitch) {
      const ps = st.pitch_shift_semitones || 0;
      aiMetricPitch.textContent = `${ps > 0 ? '+' : ''}${ps} Semitones`;
    }
    if (aiMetricVocalRisk) {
      aiMetricVocalRisk.textContent = st.vocal_clash_risk || 'SAFE';
      aiMetricVocalRisk.style.color = (st.vocal_clash_risk === 'HIGH') ? '#ef4444' : ((st.vocal_clash_risk === 'MODERATE') ? '#f59e0b' : '#10b981');
    }
    if (aiTacticalSteps && st.tactical_steps) {
      aiTacticalSteps.innerHTML = st.tactical_steps.map(s => `<li>${s}</li>`).join('');
    }
    if (aiProTipText && st.pro_tip) {
      aiProTipText.textContent = st.pro_tip;
    }
  }

  if (btnApplyAIStrategy) {
    btnApplyAIStrategy.addEventListener('click', () => {
      // Determine technique and bars to apply (from current strategy or default)
      const tech = (currentAIStrategy && currentAIStrategy.recommended_technique) || 'bass_swap';
      const bars = (currentAIStrategy && currentAIStrategy.recommended_bars) || 16;
      
      const techPill = document.querySelector(`#technique-selector .pill[data-tech="${tech}"]`);
      if (techPill) techPill.click();

      const barPill = document.querySelector(`#bars-selector .pill[data-bars="${bars}"]`);
      if (barPill) barPill.click();

      if (toggleVocalDuck && currentAIStrategy) {
        toggleVocalDuck.checked = !!currentAIStrategy.vocal_ducking;
      }
      
      closeAllModals();
      
      const missing = (!track1Data && !track2Data) ? 'Deck 1 & Deck 2' : (!track1Data ? 'Deck 1' : (!track2Data ? 'Deck 2' : ''));
      if (missing) {
        transitionStatusBanner.textContent = `⚡ AI SETTINGS APPLIED (${tech.toUpperCase()}, ${bars} BARS). LOAD ${missing.toUpperCase()} TO MIX!`;
      } else {
        transitionStatusBanner.textContent = `⚡ AI STRATEGY APPLIED: ${(currentAIStrategy ? currentAIStrategy.ai_headline : 'BASS SWAP 16 BARS')}`;
      }
    });
  }

  // --- Transition Overlay Marker on Waveform ---
  function updateTransitionOverlay() {
    if (!track1Data || !track2Data) {
      if (transitionOverlay) transitionOverlay.classList.add('hidden');
      wave1.setTransitionZone(0, 0);
      wave2.setTransitionZone(0, 0);
      return;
    }
    const isDir1to2 = (transitionDirection === '1_to_2');
    const outTrack = isDir1to2 ? track1Data : track2Data;
    const dur = outTrack.duration || 180;
    const outroStart = outTrack.suggested_cue_outro || Math.max(0, dur - 30);
    const beatsTotal = selectedBars * 4;
    const transSec = beatsTotal * (60.0 / (outTrack.bpm || 128));

    // Update canvas transition zone on both waveforms
    wave1.setTransitionZone(outroStart, transSec, isDir1to2);
    wave2.setTransitionZone(outroStart, transSec, !isDir1to2);

    if (transitionOverlay) {
      if (wave1.mode === 'overview') {
        transitionOverlay.classList.remove('hidden');
        const leftPct = (outroStart / dur) * 100;
        const widthPct = Math.min(100 - leftPct, (transSec / dur) * 100);
        transitionOverlay.style.left = `${leftPct}%`;
        transitionOverlay.style.width = `${widthPct}%`;
      } else {
        // In scrolling mode, HTML overlay follows outgoing deck position
        const outDeck = isDir1to2 ? engine.deck1 : engine.deck2;
        const visibleDur = wave1.getVisibleDuration();
        const curTime = outDeck.audio.currentTime || 0;
        // 50% is the center playhead
        const leftPct = 50 + ((outroStart - curTime) / visibleDur) * 100;
        const widthPct = (transSec / visibleDur) * 100;

        if (leftPct + widthPct < -10 || leftPct > 110) {
          transitionOverlay.classList.add('hidden');
        } else {
          transitionOverlay.classList.remove('hidden');
          transitionOverlay.style.left = `${leftPct}%`;
          transitionOverlay.style.width = `${widthPct}%`;
        }
      }
    }
  }

  // --- Transport Controls ---
  engine.deck1.audio.addEventListener('play', () => {
    d1BtnPlay.classList.add('playing');
    d1BtnPlay.textContent = 'PAUSE';
  });
  engine.deck1.audio.addEventListener('pause', () => {
    d1BtnPlay.classList.remove('playing');
    d1BtnPlay.textContent = 'PLAY';
  });
  engine.deck2.audio.addEventListener('play', () => {
    d2BtnPlay.classList.add('playing');
    d2BtnPlay.textContent = 'PAUSE';
  });
  engine.deck2.audio.addEventListener('pause', () => {
    d2BtnPlay.classList.remove('playing');
    d2BtnPlay.textContent = 'PLAY';
  });

  d1BtnPlay.addEventListener('click', async () => {
    unlockAudio();
    if (engine.deck1.isPlaying) {
      engine.deck1.pause();
      d1BtnPlay.classList.remove('playing');
      d1BtnPlay.textContent = 'PLAY';
    } else {
      if (!engine.deck1.audio.src || engine.deck1.audio.src === window.location.href) {
        transitionStatusBanner.textContent = 'DECK 1: PLEASE LOAD A TRACK FIRST (CLICK UPLOAD OR CHOOSE PRESET)';
        return;
      }
      if (!engine.deck1.audio.buffer) {
        // Still downloading/decoding: start as soon as it's ready instead of dropping the press
        d1BtnPlay.textContent = '… LOADING';
        transitionStatusBanner.textContent = 'DECK 1: LOADING AUDIO, WILL START WHEN READY...';
        await engine.deck1.audio.loaded;
      }
      let when = null, startPos = null;
      if (isDeck1SyncLocked && engine.deck2.isPlaying && track1Data && track2Data) {
        when = engine.ctx.currentTime + 0.05;
        startPos = alignedPosition(engine.deck2, track2Data, engine.deck1, track1Data, when);
      }
      try {
        await engine.deck1.play(when, startPos);
        d1BtnPlay.classList.add('playing');
        d1BtnPlay.textContent = 'PAUSE';
      } catch (err) {
        d1BtnPlay.classList.remove('playing');
        d1BtnPlay.textContent = 'PLAY';
        transitionStatusBanner.textContent = 'DECK 1 PLAYBACK ERROR: ' + (err.message || 'Check audio source');
      }
    }
  });

  d2BtnPlay.addEventListener('click', async () => {
    unlockAudio();
    if (engine.deck2.isPlaying) {
      engine.deck2.pause();
      d2BtnPlay.classList.remove('playing');
      d2BtnPlay.textContent = 'PLAY';
    } else {
      if (!engine.deck2.audio.src || engine.deck2.audio.src === window.location.href) {
        transitionStatusBanner.textContent = 'DECK 2: PLEASE LOAD A TRACK FIRST (CLICK UPLOAD OR CHOOSE PRESET)';
        return;
      }
      if (!engine.deck2.audio.buffer) {
        // Still downloading/decoding: start as soon as it's ready instead of dropping the press
        d2BtnPlay.textContent = '… LOADING';
        transitionStatusBanner.textContent = 'DECK 2: LOADING AUDIO, WILL START WHEN READY...';
        await engine.deck2.audio.loaded;
      }
      let when = null, startPos = null;
      if (isDeck2SyncLocked && engine.deck1.isPlaying && track1Data && track2Data) {
        when = engine.ctx.currentTime + 0.05;
        startPos = alignedPosition(engine.deck1, track1Data, engine.deck2, track2Data, when);
      }
      try {
        await engine.deck2.play(when, startPos);
        d2BtnPlay.classList.add('playing');
        d2BtnPlay.textContent = 'PAUSE';
      } catch (err) {
        d2BtnPlay.classList.remove('playing');
        d2BtnPlay.textContent = 'PLAY';
        transitionStatusBanner.textContent = 'DECK 2 PLAYBACK ERROR: ' + (err.message || 'Check audio source');
      }
    }
  });

  d1BtnCue.addEventListener('click', () => {
    unlockAudio();
    engine.deck1.setCue();
    d1BtnPlay.classList.remove('playing');
    d1BtnPlay.textContent = 'PLAY';
  });

  d2BtnCue.addEventListener('click', () => {
    unlockAudio();
    engine.deck2.setCue();
    d2BtnPlay.classList.remove('playing');
    d2BtnPlay.textContent = 'PLAY';
  });

  // --- BEAT SYNC: fitted grids + one audio clock. Decks started from the same clock at the
  //     same tempo stay locked, so there is no PLL nudging the pitch around. ---

  /** Native position for `slaveDeck` whose beat phase matches `masterDeck` at ctx time `when`. */
  function alignedPosition(masterDeck, masterTrack, slaveDeck, slaveTrack, when) {
    const m = MixPlanner.beatPhase(masterTrack, masterDeck.audio.timeAt(when));
    const s = MixPlanner.beatPhase(slaveTrack, slaveDeck.audio.timeAt(when));
    return s.beatTime + m.phase * s.period;
  }

  function computePhaseError(masterDeck, masterTrack, slaveDeck, slaveTrack) {
    const now = engine.ctx.currentTime;
    const m = MixPlanner.beatPhase(masterTrack, masterDeck.audio.timeAt(now));
    const s = MixPlanner.beatPhase(slaveTrack, slaveDeck.audio.timeAt(now));
    let phaseDiff = s.phase - m.phase;
    if (phaseDiff > 0.5) phaseDiff -= 1.0;
    if (phaseDiff < -0.5) phaseDiff += 1.0;
    const beatSec = 60.0 / MixPlanner.deckBpm(masterTrack, masterDeck);
    return { phaseDiff, errorMs: phaseDiff * beatSec * 1000 };
  }

  function setPitchReadout(deckNum) {
    const deck = (deckNum === 1) ? engine.deck1 : engine.deck2;
    const el = (deckNum === 1) ? d1PitchVal : d2PitchVal;
    const pct = (MixPlanner.deckSpeed(deck) - 1) * 100;
    if (el) el.textContent = `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
  }

  /** SYNC: match the other deck's effective tempo exactly, then snap phase on the audio clock.
   *  snap=false only re-matches the rate (both rates change at the same instant, so the phase
   *  lock is kept without restarting playback). */
  function engageSync(slaveNum, snap = true) {
    const slaveDeck = (slaveNum === 1) ? engine.deck1 : engine.deck2;
    const masterDeck = (slaveNum === 1) ? engine.deck2 : engine.deck1;
    const slaveTrack = (slaveNum === 1) ? track1Data : track2Data;
    const masterTrack = (slaveNum === 1) ? track2Data : track1Data;
    const rate = MixPlanner.deckBpm(masterTrack, masterDeck) / (slaveTrack.bpm * slaveDeck.audio.tempoRatio);
    slaveDeck.setPlaybackRate(rate);
    setPitchReadout(slaveNum);
    if (snap && masterDeck.isPlaying && slaveDeck.isPlaying) {
      const when = engine.ctx.currentTime + 0.05;
      slaveDeck.play(when, alignedPosition(masterDeck, masterTrack, slaveDeck, slaveTrack, when));
    }
  }

  function updatePhaseMeterHUD(errorMs) {
    if (!phaseCursor || !phaseStatus) return;
    const clampedErr = Math.max(-100, Math.min(100, errorMs));
    const leftPct = 50 + (clampedErr / 100) * 40;
    phaseCursor.style.left = `${leftPct.toFixed(1)}%`;

    const absErr = Math.abs(errorMs);
    if (absErr <= 2.5) {
      phaseCursor.className = 'phase-cursor locked';
      phaseStatus.className = 'phase-status';
      phaseStatus.textContent = `±${absErr.toFixed(1)} ms (LOCKED)`;
    } else if (absErr <= 15.0) {
      phaseCursor.className = 'phase-cursor drifting';
      phaseStatus.className = 'phase-status drifting';
      phaseStatus.textContent = `${errorMs > 0 ? '+' : ''}${errorMs.toFixed(1)} ms (NUDGING)`;
    } else {
      phaseCursor.className = 'phase-cursor error';
      phaseStatus.className = 'phase-status error';
      phaseStatus.textContent = `${errorMs > 0 ? '+' : ''}${errorMs.toFixed(1)} ms (DRIFT)`;
    }
  }

  [[1, d1BtnSync], [2, d2BtnSync]].forEach(([deckNum, btn]) => {
    btn.addEventListener('click', () => {
      if (!track1Data || !track2Data) return;
      const isNowActive = !btn.classList.contains('active');
      btn.classList.toggle('active', isNowActive);
      if (deckNum === 1) isDeck1SyncLocked = isNowActive;
      else isDeck2SyncLocked = isNowActive;
      if (isNowActive) {
        engageSync(deckNum);
        transitionStatusBanner.textContent = `🎯 DECK ${deckNum} BEAT SYNC LOCKED (TEMPO MATCHED, PHASE SNAPPED ON THE AUDIO CLOCK)`;
      } else {
        transitionStatusBanner.textContent = `DECK ${deckNum} BEAT SYNC DISENGAGED`;
      }
    });
  });

  // Tempo sliders
  d1TempoFader.addEventListener('input', (e) => {
    if (isDeck1SyncLocked) {
      isDeck1SyncLocked = false;
      d1BtnSync.classList.remove('active');
    }
    const pct = parseFloat(e.target.value);
    engine.deck1.setPlaybackRate(1 + (pct / 100));
    setPitchReadout(1);
    if (isDeck2SyncLocked) engageSync(2, false);  // synced deck follows the master's tempo
  });
  d2TempoFader.addEventListener('input', (e) => {
    if (isDeck2SyncLocked) {
      isDeck2SyncLocked = false;
      d2BtnSync.classList.remove('active');
    }
    const pct = parseFloat(e.target.value);
    engine.deck2.setPlaybackRate(1 + (pct / 100));
    setPitchReadout(2);
    if (isDeck1SyncLocked) engageSync(1, false);  // synced deck follows the master's tempo
  });

  // --- Master 3-Band EQ & Kill Engine ---
  function applyDeckEQ(deckNum, band, valDb, updateKillLed = false, killLedState = false) {
    const deck = (deckNum === 1) ? engine.deck1 : engine.deck2;
    const inputId = `d${deckNum}-eq-${band}`;
    const inputElem = document.getElementById(inputId);
    const killBtn = document.querySelector(`.btn-kill[data-target="${inputId}"]`);

    const clamped = Math.max(-24, Math.min(6, Math.round(valDb * 10) / 10));
    if (inputElem) {
      inputElem.value = clamped;
    }

    if (band === 'hi') deck.setEQHigh(clamped);
    else if (band === 'mid') deck.setEQMid(clamped);
    else if (band === 'low') deck.setEQLow(clamped);

    // Only update kill button LED if explicitly commanded by manual button click or reset
    if (killBtn && updateKillLed) {
      if (killLedState) {
        killBtn.classList.add('killed');
      } else {
        killBtn.classList.remove('killed');
      }
    }
  }

  function resetDeckEQs(deckNum) {
    applyDeckEQ(deckNum, 'hi', 0, true, false);
    applyDeckEQ(deckNum, 'mid', 0, true, false);
    applyDeckEQ(deckNum, 'low', 0, true, false);
    const filterElem = document.getElementById(`d${deckNum}-filter`);
    if (filterElem) {
      filterElem.value = 0;
      const deck = (deckNum === 1) ? engine.deck1 : engine.deck2;
      deck.setColorFilter(0);
    }
  }

  function killAllDeckEQs(deckNum) {
    applyDeckEQ(deckNum, 'hi', -24, true, true);
    applyDeckEQ(deckNum, 'mid', -24, true, true);
    applyDeckEQ(deckNum, 'low', -24, true, true);
  }

  // Mixer EQ Range Sliders (Bidirectional sync with Web Audio & Kill Buttons)
  [
    { elem: d1EqHi, deck: 1, band: 'hi' },
    { elem: d1EqMid, deck: 1, band: 'mid' },
    { elem: d1EqLow, deck: 1, band: 'low' },
    { elem: d2EqHi, deck: 2, band: 'hi' },
    { elem: d2EqMid, deck: 2, band: 'mid' },
    { elem: d2EqLow, deck: 2, band: 'low' },
  ].forEach(({ elem, deck, band }) => {
    elem.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      applyDeckEQ(deck, band, val);
    });
  });

  // Color FX Filters
  d1Filter.addEventListener('input', (e) => engine.deck1.setColorFilter(parseFloat(e.target.value)));
  d2Filter.addEventListener('input', (e) => engine.deck2.setColorFilter(parseFloat(e.target.value)));

  // Kill Buttons (HI, MID, LOW for both decks)
  document.querySelectorAll('.btn-kill').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.target;
      if (!targetId) return;
      const isD1 = targetId.startsWith('d1');
      const deckNum = isD1 ? 1 : 2;
      const band = targetId.split('-eq-')[1]; // 'hi', 'mid', 'low'

      if (btn.classList.contains('killed')) {
        applyDeckEQ(deckNum, band, 0, true, false);
      } else {
        applyDeckEQ(deckNum, band, -24, true, true);
      }
    });
  });

  // Faders & Headphone Cue (PFL) Buttons
  d1VolFader.addEventListener('input', (e) => engine.deck1.setVolume(parseFloat(e.target.value)));
  d2VolFader.addEventListener('input', (e) => engine.deck2.setVolume(parseFloat(e.target.value)));
  crossfader.addEventListener('input', (e) => engine.setCrossfader(parseFloat(e.target.value)));

  const d1BtnPfl = document.getElementById('d1-btn-pfl');
  const d2BtnPfl = document.getElementById('d2-btn-pfl');

  if (d1BtnPfl) {
    d1BtnPfl.addEventListener('click', () => {
      const active = engine.deck1.setHeadphoneCue(!engine.deck1.isCueActive);
      d1BtnPfl.classList.toggle('active', active);
      transitionStatusBanner.textContent = active 
        ? '🎧 HEADPHONE CUE (PFL): DECK 1 ROUTED TO HEADPHONES (PRE-FADER)' 
        : '🎧 HEADPHONE CUE: DECK 1 DISENGAGED';
    });
  }
  if (d2BtnPfl) {
    d2BtnPfl.addEventListener('click', () => {
      const active = engine.deck2.setHeadphoneCue(!engine.deck2.isCueActive);
      d2BtnPfl.classList.toggle('active', active);
      transitionStatusBanner.textContent = active 
        ? '🎧 HEADPHONE CUE (PFL): DECK 2 ROUTED TO HEADPHONES (PRE-FADER)' 
        : '🎧 HEADPHONE CUE: DECK 2 DISENGAGED';
    });
  }

  // Bars Selector
  document.querySelectorAll('#bars-selector .pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#bars-selector .pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedBars = parseInt(btn.dataset.bars, 10);
      updateTransitionOverlay();
    });
  });

  // ─── Pro DJ Hot Cue Performance Pads (Deck 1 & Deck 2) ───
  [1, 2].forEach(deckNum => {
    [1, 2, 3, 4].forEach(cueNum => {
      const btn = document.getElementById(`d${deckNum}-cue-${cueNum}`);
      if (btn) {
        btn.addEventListener('click', () => {
          const trackData = (deckNum === 1) ? track1Data : track2Data;
          const deck = (deckNum === 1) ? engine.deck1 : engine.deck2;
          const wave = (deckNum === 1) ? wave1 : wave2;
          if (!trackData) {
            transitionStatusBanner.textContent = `DECK ${deckNum}: PLEASE LOAD A TRACK FIRST`;
            return;
          }

          if (!trackData.hot_cues) {
            trackData.hot_cues = computeTrackHotCues(trackData);
          }

          const cueKey = `cue_${cueNum}`;
          const targetTime = trackData.hot_cues[cueKey];
          if (targetTime !== undefined && targetTime !== null) {
            deck.audio.currentTime = targetTime;
            if (wave) wave.setTime(targetTime);

            btn.classList.add('active');
            setTimeout(() => btn.classList.remove('active'), 250);

            const cueLabels = ['INTRO', 'BUILD', 'MAIN DROP', 'OUTRO'];
            transitionStatusBanner.textContent = `DECK ${deckNum}: SNAPPED TO CUE ${cueNum} [${cueLabels[cueNum - 1]}] (${formatTime(targetTime)})`;
          }
        });
      }
    });
  });

  // ─── Manual beat-grid correction (persisted in the server's analysis cache) ───
  document.querySelectorAll('.grid-nudge-strip').forEach(strip => {
    const deckNum = parseInt(strip.dataset.deck, 10);
    strip.querySelectorAll('.btn-grid').forEach(btn => {
      btn.addEventListener('click', async (ev) => {
        const dir = ev.shiftKey ? -1 : 1;  // Shift-click moves the downbeat / phrase backwards
        const track = (deckNum === 1) ? track1Data : track2Data;
        if (!track || !track.grid) {
          transitionStatusBanner.textContent = `DECK ${deckNum}: NO ANALYZED GRID YET`;
          return;
        }
        try {
          const res = await fetch('/api/grid-adjust', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              file_id: track.file_id,
              shift_ms: parseFloat(btn.dataset.shiftMs || 0),
              shift_beats: dir * parseInt(btn.dataset.shiftBeats || 0, 10),
              shift_bars: dir * parseInt(btn.dataset.shiftBars || 0, 10),
            }),
          });
          if (!res.ok) throw new Error(`Server returned ${res.status}`);
          const data = await res.json();
          Object.assign(track, data.track);
          track.hot_cues = computeTrackHotCues(track);
          (deckNum === 1 ? wave1 : wave2).loadTrack(track);
          const g = track.grid;
          transitionStatusBanner.textContent = `DECK ${deckNum} GRID: first beat ${(g.first_beat * 1000).toFixed(1)} ms, ` +
            `downbeat on beat ${g.downbeat_offset + 1}, phrases from bar ${g.phrase_offset_bars + 1}`;
        } catch (e) {
          transitionStatusBanner.textContent = `DECK ${deckNum} GRID ADJUST FAILED: ${e.message}`;
        }
      });
    });
  });

  // ─── Jev Blueprint: Abort & Manual Override Buttons ───
  const btnAbortTransition = document.getElementById('btn-abort-transition');
  const btnManualOverride = document.getElementById('btn-manual-override');
  if (btnAbortTransition) {
    btnAbortTransition.addEventListener('click', () => {
      abortTransition();
    });
  }
  if (btnManualOverride) {
    btnManualOverride.addEventListener('click', () => {
      manualOverrideTransition();
    });
  }

  // --- THE PRO TRANSITION PERFORMANCE ---
  // Planned on the fitted beat grid (mix_planner.js), executed on the audio clock: the incoming
  // deck starts with AudioBufferSourceNode.start(T) and every fader/EQ move is AudioParam
  // automation relative to T. Timers only drive the UI and one-shot FX.
  const CUT_TECHNIQUES = new Set(['echo_freeze', 'vinyl_brake', 'spinback', 'noise_riser',
                                  'loop_roll', 'festival_drop', 'hard_cut']);
  let activeTransition = null;

  // Auto: mixes are searched, measured and played only when confident (searchAndMix)
  const CONFIDENCE_BARS = { proven: 95, strict: 90, balanced: 80, relaxed: 70 };
  const SEARCH_LEAD_SEC = 12;  // candidates start at least this far ahead: time to search and rate them
  const QUICK_LOOK = 12;       // mixes measured before the first decision (defaults and favourites first)
  const TIE_BUDGET_SEC = 8;    // how long the AI may take to rate or break a tie
  const confidenceSelect = document.getElementById('confidence-select');
  if (confidenceSelect) {
    try { confidenceSelect.value = localStorage.getItem('mix_confidence') || 'strict'; } catch (e) { /* blocked */ }
    confidenceSelect.addEventListener('change', () => {
      try { localStorage.setItem('mix_confidence', confidenceSelect.value); } catch (e) { /* storage blocked */ }
    });
  }
  const confidenceBar = () => CONFIDENCE_BARS[confidenceSelect && confidenceSelect.value] || CONFIDENCE_BARS.strict;

  // The DJ's ratings of past mixes, { key: [likes, ratings] } (keys: MixBlocks.prefKeys)
  let tastePrefs = {};
  fetch('/api/feedback/summary').then(r => (r.ok ? r.json() : null))
    .then(d => { if (d && d.keys) tastePrefs = d.keys; }).catch(() => {});

  function camelotCompatible(a, b) {
    if (!a || !b) return true;
    const na = parseInt(a, 10), nb = parseInt(b, 10);
    const d = (nb - na + 12) % 12;
    return na === nb || (a.slice(-1) === b.slice(-1) && (d === 1 || d === 11));
  }

  // Keylocked (server time-stretched) copies of tracks, keyed by file and tempo ratio
  const stretchCache = new Map();
  function stretchedBuffer(track, ratio) {
    ratio = Math.round(ratio * 1e6) / 1e6;
    const key = `${track.file_id}@${ratio}`;
    if (!stretchCache.has(key)) {
      if (stretchCache.size >= 3) stretchCache.delete(stretchCache.keys().next().value);
      stretchCache.set(key, fetch(`/api/stretched/${encodeURIComponent(track.file_id)}?ratio=${ratio}`)
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
        .then(ab => engine.ctx.decodeAudioData(ab))
        .catch(err => {
          console.warn('Keylock stretch unavailable (vinyl tempo fallback):', err);
          stretchCache.delete(key);
          return null;
        }));
    }
    return stretchCache.get(key);
  }

  /** Start rendering the next incoming track at the current master tempo before it's needed. */
  function prefetchIncoming() {
    if (!track1Data || !track2Data || isTransitioning) return;
    const isDir1to2 = (transitionDirection === '1_to_2');
    const outTrack = isDir1to2 ? track1Data : track2Data;
    const inTrack = isDir1to2 ? track2Data : track1Data;
    if (!inTrack.grid || !outTrack.grid) return;
    const ratio = MixPlanner.deckBpm(outTrack, isDir1to2 ? engine.deck1 : engine.deck2) / inTrack.bpm;
    if (Math.abs(ratio - 1) >= 0.0005 && Math.abs(ratio - 1) <= MixPlanner.MAX_STRETCH) {
      stretchedBuffer(inTrack, ratio);
    }
  }

  function setPlayUI(btn, playing) {
    btn.classList.toggle('playing', playing);
    btn.textContent = playing ? 'PAUSE' : 'PLAY';
  }

  function atCtx(t, ctxTime, fn) {
    t.timers.push(setTimeout(fn, Math.max(0, (ctxTime - engine.ctx.currentTime) * 1000)));
  }

  function clearTransitionTimers(t) {
    t.timers.forEach(clearTimeout);
    t.intervals.forEach(clearInterval);
  }

  let mixQueued = false;
  function startQueuedMix() {
    if (!mixQueued || (track1Data && track1Data.analyzing) || (track2Data && track2Data.analyzing)) return;
    mixQueued = false;
    btnTriggerTransition.classList.remove('queued');
    btnTriggerTransition.click();
  }

  btnTriggerTransition.addEventListener('click', () => {
    unlockAudio();
    if (!track1Data || !track2Data) {
      alert('Please load both Deck 1 and Deck 2 first!');
      return;
    }
    if (isTransitioning) return;
    // Never plan on the placeholder grid of a track still being analysed: the beats and cues
    // would be guesses. MIX waits and starts by itself once the analysis is in.
    if (track1Data.analyzing || track2Data.analyzing) {
      mixQueued = true;
      btnTriggerTransition.classList.add('queued');
      transitionStatusBanner.textContent = 'ANALYSING BEAT GRID: MIX STARTS AS SOON AS IT IS READY';
      return;
    }

    const isDir1to2 = (transitionDirection === '1_to_2');
    const t = {
      outTrack: isDir1to2 ? track1Data : track2Data,
      inTrack: isDir1to2 ? track2Data : track1Data,
      outDeck: isDir1to2 ? engine.deck1 : engine.deck2,
      inDeck: isDir1to2 ? engine.deck2 : engine.deck1,
      outDeckNum: isDir1to2 ? 1 : 2,
      inDeckNum: isDir1to2 ? 2 : 1,
      outBtnPlay: isDir1to2 ? d1BtnPlay : d2BtnPlay,
      inBtnPlay: isDir1to2 ? d2BtnPlay : d1BtnPlay,
      inName: isDir1to2 ? 'DECK 2' : 'DECK 1',
      timers: [],
      intervals: [],
    };
    if (!t.outDeck.audio.buffer || !t.inDeck.audio.nativeBuffer) {
      transitionStatusBanner.textContent = 'STILL DECODING AUDIO: TRY AGAIN IN A MOMENT';
      return;
    }

    isTransitioning = true;
    activeTransition = t;
    btnTriggerTransition.classList.add('in-transition');
    if (crossfader) crossfader.value = 50;
    engine.setCrossfader(50, 'club');
    ['btn-abort-transition', 'btn-manual-override'].forEach(id => {
      const b = document.getElementById(id);
      if (b) b.style.display = 'inline-block';
    });

    // Blend by default. Effects/cuts only when chosen, or when the tempos are too far apart
    // to run at one master tempo (then the tracks must not overlap at all).
    let tech = selectedTechnique === 'auto'
      ? (currentAIRec ? currentAIRec.recommended_technique : 'bass_swap')
      : selectedTechnique;
    const tempoGap = Math.abs(MixPlanner.deckBpm(t.outTrack, t.outDeck) / t.inTrack.bpm - 1);
    if (!CUT_TECHNIQUES.has(tech) && tempoGap > MixPlanner.MAX_STRETCH) tech = 'echo_freeze';
    t.tech = tech;
    t.blend = !CUT_TECHNIQUES.has(tech);

    // The plan is expressed in the outgoing deck's clock, so it must be running
    if (!t.outDeck.isPlaying) {
      t.outDeck.play();
      setPlayUI(t.outBtnPlay, true);
    }

    const bars = selectedBars;
    const beatSecNow = 60 / MixPlanner.deckBpm(t.outTrack, t.outDeck);
    const aiModel = aiModelSelect ? aiModelSelect.value : 'local';
    const planOpts = {
      now: engine.ctx.currentTime,
      blend: t.blend,
      keyClash: !camelotCompatible(t.outTrack.camelot, t.inTrack.camelot),
      phraseLock: togglePhraseLock ? togglePhraseLock.checked : true,
    };
    if (!t.inTrack.grid || !t.outTrack.grid) console.warn('Beat grid not analyzed yet: using an estimated grid');

    // Auto: every style worth trying at the planner's best moments is measured, and one plays only
    // when confident
    if (selectedTechnique === 'auto') {
      searchAndMix(t, planOpts, bars, aiModel);
      return;
    }

    const leadIn = cutLeadInBeats(tech, bars);
    commitTransitionPlan(t, MixPlanner.plan(t.outTrack, t.outDeck, t.inTrack, bars, Object.assign({}, planOpts, {
      leadSec: t.blend ? 3.0 : leadIn * beatSecNow + 1.0,
    })), null);
  });

  /** Beats of outgoing FX before an overlap-free technique's drop. */
  function cutLeadInBeats(tech, bars) {
    return {
      echo_freeze: 1, vinyl_brake: 2, spinback: 3, noise_riser: 16, loop_roll: 4 * Math.min(bars, 4),
      festival_drop: 4 * Math.min(bars, 8),
    }[tech] || 0;
  }

  /** Jev's ratings (engines ['jev']) or Gemini's pick (['gemini']) of a few candidates, or {}. */
  async function askAI(t, cands, engines, model) {
    const now = engine.ctx.currentTime;
    const outBpm = MixPlanner.deckBpm(t.outTrack, t.outDeck);
    const position = t.outDeck.audio.timeAt(now);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), (TIE_BUDGET_SEC + 1.0) * 1000);
    try {
      const res = await fetch('/api/ai-choose-transition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          model, engines, budget_sec: TIE_BUDGET_SEC,
          out: MixPlanner.trackSummary(t.outTrack, outBpm, Math.round(position * 10) / 10, position),
          in: MixPlanner.trackSummary(t.inTrack, t.inTrack.bpm || outBpm),
          candidates: cands.map(c => Object.assign(MixPlanner.candidateFeatures(c, t.outTrack, t.inTrack, now),
                                                   { recipe: MixBlocks.describe(c) })),
        }),
      });
      return await res.json();
    } catch (err) {
      console.warn(`AI (${engines.join(', ')}) unavailable:`, err);
      return {};
    } finally {
      clearTimeout(timer);
    }
  }

  const sameStyle = (a, b) => Object.keys(Object.assign({}, a, b)).every(k => (a[k] || 0) === (b[k] || 0));

  /**
   * Auto mix. The planner's best moments (skeletons), dressed in every style worth trying
   * (MixBlocks.variants) and ordered most promising first, are rendered offline and measured a few
   * at a time while the music plays. Each gets a confidence (TransitionLab.confidence: the sound, the
   * DJ's ratings, Jev's). A mix plays once one clears the DJ's bar; until then the search goes on
   * through more styles and later moments, and when it has run out the best one left plays, marked as
   * below the bar. Jev rates the leaders once (no Gemini); Gemini only breaks a near tie.
   */
  async function searchAndMix(t, planOpts, bars, aiModel, attempt = 0) {
    const gap = Math.abs(MixPlanner.deckBpm(t.outTrack, t.outDeck) / t.inTrack.bpm - 1) > MixPlanner.MAX_STRETCH;
    const skeletons = MixPlanner.candidates(t.outTrack, t.outDeck, t.inTrack, Object.assign({}, planOpts, {
      now: engine.ctx.currentTime, blend: !gap, leadSec: 1.0 + SEARCH_LEAD_SEC,
      barsOptions: bars >= 16 ? [bars, 8] : [bars, 16], perBars: 3, cutTechnique: 'echo_freeze', max: 8,
    }));
    const cands = [];
    skeletons.forEach((sk, rank) => MixBlocks.variants(sk, t.inTrack).forEach(c => cands.push(Object.assign(c, { rank }))));
    if (!cands.length) {
      commitTransitionPlan(t, Object.assign(MixPlanner.plan(t.outTrack, t.outDeck, t.inTrack, bars,
        Object.assign({}, planOpts, { now: engine.ctx.currentTime, blend: !gap, leadSec: 3.0 })),
        { technique: gap ? 'echo_freeze' : 'blend' }), 'NO ROOM TO SEARCH: THE PLANNER\'S OWN MIX');
      return;
    }
    cands.forEach(c => {
      c.promise = 100 * TransitionLab.taste(c, tastePrefs) - 6 * c.rank
        + (sameStyle(c.style, MixBlocks.defaultStyle(c)) ? 15 : 0);
    });
    cands.sort((a, b) => b.promise - a.promise);
    cands.forEach((c, i) => { c.id = `M${i + 1}`; });
    t.search = cands;

    const bar = confidenceBar();
    const useAI = aiModel !== 'local';
    const deadline = c => c.startCtx - MixBlocks.preSec(c) - 1.5;   // last moment to commit to c
    const rescore = () => cands.forEach(c => { if (c.measured) c.conf = TransitionLab.confidence(c, tastePrefs); });
    let next = 0;
    let jev = null;         // the Jev round in flight
    let jevRounds = 0;
    let shown = 0;
    while (activeTransition === t) {
      const batch = [];
      while (next < cands.length && batch.length < 3) {
        const c = cands[next++];
        if (deadline(c) > engine.ctx.currentTime + 1) batch.push(c);
      }
      if (batch.length) await measureCandidates(t, batch);
      if (activeTransition !== t) return;
      rescore();
      const now = engine.ctx.currentTime;
      const live = cands.filter(c => c.measured && deadline(c) > now);
      const checked = cands.filter(c => c.measured).length;
      // Done when every candidate has been tried, or when none left could beat the best found even
      // with a flawless sound check and Jev's top rating (a high bar shouldn't mean a long wait)
      const bestConf = live.length ? Math.max(...live.map(c => c.conf)) : -1;
      const done = next >= cands.length ||
        !cands.slice(next).some(c => deadline(c) > now + 1 && ceiling(c, useAI, aiModel) > bestConf);
      const quickDone = checked >= QUICK_LOOK || done;
      // Jev rates the leaders once the quick look is in (free), and leaders found later in another
      // round, so the ones in contention are compared on the same terms
      const leaders = live.slice().sort((a, b) => utility(b) - utility(a)).slice(0, 12);
      const unrated = leaders.filter(c => c.jev === undefined);
      if (useAI && quickDone && (!jev || jev.settled) && jevRounds < 3 && unrated.length && leaders.length > 1) {
        jevRounds++;
        const ask = unrated.length > 1 ? unrated : leaders.slice(0, 2);
        jev = { settled: false };
        askAI(t, ask, ['jev'], 'jev-latest').then(d => {
          ask.forEach(c => { c.jev = d.scores && d.scores[c.id] ? d.scores[c.id].mean : null; });
          jev.settled = true;
        });
      }
      const ranked = live.slice().sort((a, b) => utility(b) - utility(a));
      const confident = ranked.filter(c => c.conf >= bar);
      if (performance.now() - shown > 300 || done) {
        shown = performance.now();
        renderSoundCheck(cands);
        const best = ranked.length ? Math.max(...ranked.map(c => c.conf)) : null;
        transitionStatusBanner.textContent = `SEARCHING: ${checked}/${cands.length} MIXES CHECKED` +
          (best !== null ? ` · BEST ${best}%` : '') + ` · PLAYS AT ${bar}%`;
      }
      const aiReady = !useAI || (jev && jev.settled && (jevRounds >= 3 || leaders.every(c => c.jev !== undefined)))
        || leaders.length < 2;
      if (quickDone && aiReady && confident.length) return settleOn(t, confident, aiModel, bar, false);
      if (done && aiReady) {
        if (ranked.length) return settleOn(t, ranked, aiModel, bar, true);
        // Every moment passed while searching: look again from here
        if (attempt < 1) return searchAndMix(t, planOpts, bars, aiModel, attempt + 1);
        commitTransitionPlan(t, Object.assign(MixPlanner.plan(t.outTrack, t.outDeck, t.inTrack, bars,
          Object.assign({}, planOpts, { now: engine.ctx.currentTime, blend: !gap, leadSec: 3.0 })),
          { technique: gap ? 'echo_freeze' : 'blend' }), 'SEARCH RAN OUT OF TIME: THE PLANNER\'S OWN MIX');
        return;
      }
      await new Promise(r => setTimeout(r, done ? 100 : 0));   // waiting for Jev, or letting the page breathe
    }
  }

  /** The most confidence a candidate could get before it is measured: a flawless sound check, Jev's
   *  top rating (when Jev rates) and Gemini's tie-break. */
  function ceiling(c, useAI, aiModel) {
    return TransitionLab.confidence(Object.assign({}, c, {
      measured: { penalty: 0 }, jev: useAI ? 4 : undefined, geminiPick: aiModel.startsWith('gemini'),
    }), tastePrefs);
  }

  /** Sooner is better once it's past 20 s: a much better mix may be worth a wait, not a long one. */
  function utility(c) {
    return c.conf - 0.1 * Math.max(0, (c.startCtx - engine.ctx.currentTime) - 20);
  }

  /** Commit to the best of `ranked` (confident ones, or the best left when `below` the bar). A near
   *  tie between confident mixes is Gemini's to break, if there is time: its only call of the mix. */
  async function settleOn(t, ranked, aiModel, bar, below) {
    let pick = ranked[0];
    const close = ranked.filter(c => c.conf >= pick.conf - 4).slice(0, 3);
    const time = pick.startCtx - MixBlocks.preSec(pick) - 1.5 - engine.ctx.currentTime;
    if (!below && aiModel.startsWith('gemini') && close.length > 1 && time > TIE_BUDGET_SEC + 1) {
      transitionStatusBanner.textContent = `GEMINI IS BREAKING A TIE BETWEEN ${close.length} CONFIDENT MIXES...`;
      const d = await askAI(t, close, ['gemini'], aiModel);
      if (activeTransition !== t) return;
      const g = close.find(c => c.id === d.gemini_choice);
      if (g) {
        g.geminiPick = true;
        g.geminiReason = d.gemini_reason || '';
        g.conf = TransitionLab.confidence(g, tastePrefs);
        pick = close.slice().sort((a, b) => utility(b) - utility(a))[0];
      }
    }
    const checked = t.search.filter(c => c.measured).length;
    console.info(`Auto mix: ${pick.id} (${MixBlocks.label(pick)}) at ${pick.conf}% of ${checked} checked`, pick.measured);
    pick.pair = { out: t.outTrack.file_id, in: t.inTrack.file_id,
                  tempo_gap: +Math.abs(MixPlanner.deckBpm(t.outTrack, t.outDeck) / t.inTrack.bpm - 1).toFixed(3) };
    renderSoundCheck(t.search, pick.id);
    // The decision card shows the mix that will play, not the recommendation made before the search
    if (aiRecTechnique) aiRecTechnique.textContent = MixBlocks.label(pick);
    if (aiRecReason) aiRecReason.textContent = `${MixBlocks.describe(pick)}.`;
    if (aiRecConfidence) aiRecConfidence.textContent = `${pick.conf}% CONFIDENT`;
    const note = `${MixBlocks.label(pick)} · CONFIDENCE ${pick.conf}%` +
      (below ? ` (UNDER YOUR ${bar}%: BEST OF ${checked} CHECKED)` : '') +
      (pick.geminiPick ? ' · GEMINI BROKE A TIE' : '');
    commitTransitionPlan(t, pick, note);
  }

  /** The sound-check panel: the most confident mixes found so far and which one plays. */
  const soundCheckList = document.getElementById('sound-check-list');
  function renderSoundCheck(cands, playedId = null) {
    if (!soundCheckList) return;
    const bar = confidenceBar();
    const measured = cands.filter(c => c.measured && typeof c.conf === 'number').sort((a, b) => b.conf - a.conf);
    const rows = measured.slice(0, 6);
    const played = playedId && cands.find(c => c.id === playedId);
    if (played && !rows.includes(played)) rows.push(played);
    const head = document.createElement('div');
    head.className = 'check-summary';
    head.textContent = `${measured.length} of ${cands.length} mixes checked · plays at ${bar}%+`;
    soundCheckList.replaceChildren(head, ...rows.map(c => {
      const plays = c.id === playedId;
      const color = plays ? 'var(--ok)' : c.conf >= bar ? 'var(--accent)' : 'var(--muted)';
      const row = document.createElement('div');
      row.className = 'check-row';
      row.style.setProperty('--sc', color);
      row.title = `${MixBlocks.describe(c)}. Leaves at ${formatTime(c.exitNative)}; measured penalty ` +
        `${c.measured.penalty} (lower is cleaner)${c.geminiPick ? '; Gemini broke a tie in its favour' : ''}`;
      const id = document.createElement('span'); id.className = 'check-id'; id.textContent = c.id;
      const meter = document.createElement('span'); meter.className = 'check-bar';
      const fill = document.createElement('span'); fill.style.width = `${Math.max(4, c.conf)}%`;
      meter.append(fill);
      const val = document.createElement('span'); val.className = 'check-score'; val.textContent = `${c.conf}%`;
      val.title = 'Confidence: measured sound, your ratings and Jev';
      const jev = document.createElement('span'); jev.className = 'check-jev';
      jev.textContent = typeof c.jev === 'number' ? c.jev.toFixed(1) : '';
      if (typeof c.jev === 'number') jev.title = `Jev rating: ${c.jev.toFixed(1)} of 4`;
      const what = document.createElement('span'); what.className = 'check-label';
      what.textContent = (plays ? 'PLAYS: ' : '') + MixBlocks.label(c);
      row.append(id, meter, val, jev, what);
      return row;
    }));
  }

  /** Render candidates offline from the decks' own buffers and measure them (c.measured). */
  async function measureCandidates(t, cands) {
    const blends = cands.filter(c => c.technique === 'blend');
    const ratio = blends.length ? blends[0].tempoRatio : 1;  // the master tempo: the same for every blend
    const stretch = Math.abs(ratio - 1) >= 0.0005;
    const stretched = stretch
      ? await Promise.race([stretchedBuffer(t.inTrack, ratio), new Promise(r => setTimeout(() => r(null), 2000))])
      : null;
    // Without the keylocked copy yet, measure the vinyl-rate fallback the deck would play
    const inc = stretched ? { buffer: stretched, tempoRatio: ratio, rate: 1 }
                          : { buffer: t.inDeck.audio.nativeBuffer, tempoRatio: 1, rate: stretch ? ratio : 1 };
    const out = { buffer: t.outDeck.audio.buffer, tempoRatio: t.outDeck.audio.tempoRatio,
                  rate: t.outDeck.audio.playbackRate, trimDb: t.outDeck.trimDb || 0 };
    const native = { buffer: t.inDeck.audio.nativeBuffer, tempoRatio: 1, rate: 1 };
    await TransitionLab.measureAll(cands, out, inc, native);
  }

  /** Lock in a plan and schedule everything from it. */
  function commitTransitionPlan(t, plan, aiNote) {
    if (plan.technique) {
      // A candidate: 'blend', or an overlap-free technique the AI preferred
      if (plan.technique !== 'blend') t.tech = plan.technique;
      t.blend = plan.technique === 'blend';
    }
    t.plan = plan;
    t.aiNote = aiNote;
    const tech = t.tech;
    // How long before its start the mix already moves something (gap styles lead in)
    t.leadInSec = plan.style ? MixBlocks.preSec(plan) : cutLeadInBeats(tech, plan.bars) * plan.beatSec;

    // Incoming at the master tempo, keylocked (usually prefetched already)
    t.bufferPromise = (t.blend && Math.abs(t.plan.tempoRatio - 1) >= 0.0005)
      ? stretchedBuffer(t.inTrack, t.plan.tempoRatio)
      : Promise.resolve(null);

    // No AI blueprint here: rendered A/B tests showed its generic fader/HPF curves left 5-13 dB
    // holes in the blend. The AI chooses between planner candidates; the planner performs them.

    // No automatic server export during a live set (it competes with analysis/stretching for a
    // small instance's memory). The Export button renders this transition on demand.
    t.renderPromise = Promise.resolve(null);
    lastRenderedMix = null;
    const isDir1to2 = t.outDeckNum === 1;
    lastTransitionCues = {
      direction: isDir1to2 ? '1_to_2' : '2_to_1',
      technique: tech,
      bars: t.plan.bars,
      cue_1: isDir1to2 ? t.plan.exitNative : t.plan.inStartNative,
      cue_2: isDir1to2 ? t.plan.inStartNative : t.plan.exitNative,
    };

    startTransitionHud(t);
    // Arm shortly before the first outgoing FX (or the start): from then on it's all scheduled
    atCtx(t, t.plan.startCtx - t.leadInSec - 0.4, () => armTransition(t));
  }

  function startTransitionHud(t) {
    const p = t.plan;
    const total0 = Math.max(0.001, p.startCtx - engine.ctx.currentTime);
    const label = p.style ? MixBlocks.label(p).toUpperCase()
      : t.blend ? `${p.bars}-BAR BLEND` : t.tech.toUpperCase().replace(/_/g, ' ');
    phraseHud.classList.remove('hidden');
    t.intervals.push(setInterval(() => {
      const remain = p.startCtx - engine.ctx.currentTime;
      if (remain > 0) {
        const beats = remain / p.beatSec;
        phraseHudCounter.textContent = `IN ON THE 1: ${Math.floor(beats / 4)} BARS (${Math.floor(beats % 4) + 1}/4)`;
        phraseHudProgress.style.width = `${(100 * (1 - remain / total0)).toFixed(1)}%`;
        transitionStatusBanner.textContent = `🎯 ${label} → ${t.inName} IN ${remain.toFixed(1)}s ` +
          `@ ${p.masterBpm.toFixed(2)} BPM${t.blend && p.vocalClash ? ' (VOCAL CLASH: MIDS SWAP WITH BASS)' : ''}` +
          (t.aiNote ? ` · ${t.aiNote.toUpperCase()}` : '');
      } else {
        phraseHud.classList.add('hidden');
        if (t.blend && t.marks) {
          const now = engine.ctx.currentTime;
          const total = p.bars + (p.tailBars || 0);
          const bar = Math.min(total, Math.floor(-remain / (4 * p.beatSec)) + 1);
          const stage = now < t.marks.swap
            ? (p.dropAligned ? 'HATS & MIDS IN, BASS SWAPS ON THE DROP' : 'HATS & MIDS IN')
            : 'BASS SWAPPED ON THE 1, OUTGOING OUT';
          transitionStatusBanner.textContent =
            `🎚️ BLEND BAR ${bar}/${total}: ${stage}`;
        }
      }
    }, 50));
  }

  async function armTransition(t) {
    if (activeTransition !== t) return;
    const p = t.plan;
    if (t.blend) {
      const waitMs = Math.max(0, (p.startCtx - 0.08 - engine.ctx.currentTime) * 1000);
      t.stretched = await Promise.race([t.bufferPromise, new Promise(r => setTimeout(() => r(null), waitMs))]);
      if (activeTransition !== t) return;
    }
    // Missed the slot (busy tab)? Slide by whole bars so the start stays on a downbeat
    const barSec = 4 * p.beatSec;
    while (p.startCtx - t.leadInSec < engine.ctx.currentTime + 0.03) {
      p.startCtx += barSec;
      p.exitNative += barSec * MixPlanner.deckSpeed(t.outDeck);
    }

    const inDeck = t.inDeck;
    inDeck.pause();
    inDeck.setPlaybackRate(1.0);
    if (t.blend && Math.abs(p.tempoRatio - 1) >= 0.0005) {
      if (t.stretched) {
        inDeck.audio.useBuffer(t.stretched, p.tempoRatio);
      } else {
        // Tempo still exact, but pitch follows (vinyl) until a keylocked copy is available
        inDeck.audio.useBuffer(inDeck.audio.nativeBuffer, 1.0);
        inDeck.audio.playbackRate = p.tempoRatio;
        console.warn('Keylocked incoming not ready: vinyl tempo match for this transition');
      }
    } else {
      inDeck.audio.useBuffer(inDeck.audio.nativeBuffer, 1.0);
    }
    setPitchReadout(t.inDeckNum);
    // Everything needed to re-render exactly this blend for export (in the browser)
    const side = deck => ({ buffer: deck.audio.buffer, tempoRatio: deck.audio.tempoRatio,
                            rate: deck.audio.playbackRate, trimDb: deck.trimDb || 0 });
    const recipe = t.blend || t.tech === 'echo_freeze';   // MixBlocks performs these, in any style
    lastPerformed = recipe ? { out: side(t.outDeck), inc: side(inDeck), plan: Object.assign({}, p),
                               technique: t.tech } : null;
    if (recipe) runRecipe(t); else runCut(t);
  }

  /** A blend or a tempo-gap mix, in its style: the same automation the sound check measured. */
  function runRecipe(t) {
    const p = t.plan;
    const T = p.startCtx;
    const lead = p.inLeadSec || 0;                        // a filter wash starts the incoming early
    t.inDeck.play(T - lead, p.inStartNative - lead);
    t.marks = MixBlocks.perform(p, t.outDeck, t.inDeck);
    atCtx(t, T - lead, () => setPlayUI(t.inBtnPlay, true));
    if (!t.blend) {
      const land = p.style && p.style.inPreBars ? 'LANDS ON ITS BUILD' : 'DROPS ON THE 1';
      atCtx(t, T, () => {
        transitionStatusBanner.textContent = `${(p.style ? MixBlocks.label(p) : 'echo out').toUpperCase()}: ${t.inName} ${land}`;
      });
    }
    atCtx(t, t.marks.end + 0.05, () => completeTransition(t));
  }

  /** Overlap-free techniques: outgoing FX lead in, incoming drops on the 1 at its native tempo. */
  function runCut(t) {
    const p = t.plan;
    const T = p.startCtx;
    const beat = p.beatSec;
    const bar = 4 * beat;
    const bpm = p.masterBpm;
    const { outDeck, inDeck, outDeckNum } = t;

    MixPlanner.neutral(inDeck, T - 0.05, 1);
    MixPlanner.setTrim(inDeck, p.inTrimDb || 0, T - 0.05);
    inDeck.play(T, p.inStartNative);
    let cutTime = T;
    const tail = 0.1;

    if (t.tech === 'vinyl_brake') {
      atCtx(t, T - 2 * beat, () => {
        applyDeckEQ(outDeckNum, 'low', -24);
        const t0 = engine.ctx.currentTime;
        const iv = setInterval(() => {
          const k = (engine.ctx.currentTime - t0) / (2 * beat);
          if (k >= 1) { clearInterval(iv); return; }
          outDeck.audio.playbackRate = Math.max(0.02, 1 - k);
        }, 30);
        t.intervals.push(iv);
      });
    } else if (t.tech === 'spinback') {
      atCtx(t, T - 3 * beat, () => {
        applyDeckEQ(outDeckNum, 'low', -24);
        outDeck.triggerSpinback(3 * beat);
      });
    } else if (t.tech === 'noise_riser') {
      atCtx(t, T - 4 * bar, () => {
        applyDeckEQ(outDeckNum, 'low', -24);
        engine.triggerNoiseRiser(bpm, 4);
      });
      const f = outDeck.filterHPF.frequency;
      f.setValueAtTime(20, T - 4 * bar);
      f.exponentialRampToValueAtTime(1500, T - beat);
    } else if (t.tech === 'loop_roll') {
      const rollBars = Math.min(p.bars, 4);
      atCtx(t, T - rollBars * bar, () => applyDeckEQ(outDeckNum, 'low', -18));
      outDeck.triggerLoopRoll(bpm, rollBars, null, T - rollBars * bar);
      atCtx(t, T, () => engine.triggerDropImpact(bpm));
    } else if (t.tech === 'festival_drop') {
      const buildBars = Math.min(p.bars, 8);
      atCtx(t, T - buildBars * bar, () => {
        applyDeckEQ(outDeckNum, 'low', -18);
        engine.triggerNoiseRiser(bpm, buildBars);
      });
      // Roll (with its HPF sweep) over the last 4 bars, then one beat of silence before the drop
      outDeck.triggerLoopRoll(bpm, 4 - 0.25, null, T - 4 * bar);
      cutTime = T - beat;
      atCtx(t, T, () => engine.triggerDropImpact(bpm));
    } else if (t.tech === 'hard_cut') {
      atCtx(t, T, () => engine.triggerDropImpact(bpm));
    }
    if (cutTime !== null) MixPlanner.cutAt(outDeck, cutTime);

    atCtx(t, T, () => {
      setPlayUI(t.inBtnPlay, true);
      transitionStatusBanner.textContent = `💥 ${t.tech.toUpperCase().replace(/_/g, ' ')}: ${t.inName} DROPS ON THE 1`;
    });
    atCtx(t, T + tail, () => completeTransition(t));
  }

  function completeTransition(t) {
    if (activeTransition !== t) return;
    clearTransitionTimers(t);
    activeTransition = null;
    const now = engine.ctx.currentTime;
    MixPlanner.holdAutomation(t.inDeck, now);
    MixPlanner.holdAutomation(t.outDeck, now);
    t.outDeck.faderGain.gain.linearRampToValueAtTime(0, now + 0.03);
    setTimeout(() => {
      t.outDeck.pause();
      setPlayUI(t.outBtnPlay, false);
      MixPlanner.neutral(t.inDeck, engine.ctx.currentTime, 1);
      ['btn-abort-transition', 'btn-manual-override'].forEach(id => {
        const b = document.getElementById(id);
        if (b) b.style.display = 'none';
      });
      finishTransition(t.renderPromise);
      if (t.plan.style) askForRating(t.plan);
    }, 40);
  }

  // ── The DJ rates each Auto mix: the ratings steer the confidence of mixes like it ──
  const ratingBox = document.getElementById('mix-rating');
  let ratedMix = null;
  function askForRating(plan) {
    if (!ratingBox) return;
    ratedMix = plan;
    ratingBox.querySelector('.mix-rating-note').textContent = `${MixBlocks.label(plan)} (${plan.conf}%)`;
    ratingBox.hidden = false;
  }
  if (ratingBox) {
    ratingBox.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-rate]');
      if (!btn || !ratedMix) return;
      const like = btn.dataset.rate === '1';
      const keys = MixBlocks.prefKeys(ratedMix);
      keys.forEach(k => {
        const [likes, n] = tastePrefs[k] || [0, 0];
        tastePrefs[k] = [likes + (like ? 1 : 0), n + 1];
      });
      fetch('/api/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rating: like ? 1 : 0, keys, style: ratedMix.style, label: MixBlocks.label(ratedMix),
          confidence: ratedMix.conf, measured: ratedMix.measured, jev: ratedMix.jev ?? null,
          gemini_pick: !!ratedMix.geminiPick, pair: ratedMix.pair || null,
        }),
      }).catch(err => console.warn('Rating not saved:', err));
      ratingBox.querySelector('.mix-rating-note').textContent = like ? 'Noted: more mixes like this one.'
                                                                     : 'Noted: fewer mixes like this one.';
      ratedMix = null;
      setTimeout(() => { if (!ratedMix) ratingBox.hidden = true; }, 2500);
    });
  }

  function finishTransition(renderPromise) {
    isTransitioning = false;
    if (phaseCursor && phaseStatus) {
      phaseCursor.style.left = '50%';
      phaseCursor.className = 'phase-cursor locked';
      phaseStatus.className = 'phase-status';
      phaseStatus.textContent = '±0.0 ms (STANDBY)';
    }
    btnTriggerTransition.classList.remove('in-transition');
    phraseHud.classList.add('hidden');
    const liveDeck = (transitionDirection === '1_to_2') ? 'DECK 2' : 'DECK 1';
    const liveDeckNum = (transitionDirection === '1_to_2') ? 2 : 1;
    transitionStatusBanner.textContent = `TRANSITION COMPLETE! ${liveDeck} LIVE ON AIR.`;

    // Ensure live deck has pristine neutral EQs and full volume
    resetDeckEQs(liveDeckNum);
    const liveDeckRef = (liveDeckNum === 1) ? engine.deck1 : engine.deck2;
    const liveVolFader = (liveDeckNum === 1) ? document.getElementById('d1-vol-fader') : document.getElementById('d2-vol-fader');
    liveDeckRef.setVolume(100);
    if (liveVolFader) liveVolFader.value = 100;

    // Reset outgoing deck's FX and filters, and keep its volume at 0 (silent since crossfader is centered at 50%)
    const outDeckNum = (liveDeckNum === 1) ? 2 : 1;
    const outDeckRef = (outDeckNum === 1) ? engine.deck1 : engine.deck2;
    const outDeckFilterEl = (outDeckNum === 1) ? document.getElementById('d1-filter') : document.getElementById('d2-filter');
    const outVolFader = (outDeckNum === 1) ? document.getElementById('d1-vol-fader') : document.getElementById('d2-vol-fader');
    outDeckRef.resetAllFX();
    outDeckRef.pause();
    outDeckRef.setVolume(0);
    if (outDeckFilterEl) { outDeckFilterEl.value = 0; }
    if (outVolFader) { outVolFader.value = 0; }
    resetDeckEQs(outDeckNum);

    // Crossfader remains permanently centered at 50%
    if (crossfader) crossfader.value = 50;
    engine.setCrossfader(50, 'club');

    // Automatically flip the mix direction so DJ is ready for next sequence
    const nextDir = (transitionDirection === '1_to_2') ? '2_to_1' : '1_to_2';
    setTransitionDirection(nextDir);

    renderPromise.then(res => {
      if (res && res.status === 'success') {
        lastRenderedMix = res.mix;
        btnExportMix.disabled = false;
        showMixModal(res.mix);
      }
    });
  }

  // --- Show Mix Modal ---
  let modalDismissTimer = null;
  function showMixModal(mix) {
    modalStatsGrid.innerHTML = `
      <div class="stat-item"><span class="lbl">TECHNIQUE</span><span class="val">${mix.technique.toUpperCase()}</span></div>
      <div class="stat-item"><span class="lbl">CLIP LENGTH</span><span class="val">${formatTime(mix.total_duration)}</span></div>
      <div class="stat-item"><span class="lbl">TRANSITION WINDOW</span><span class="val">${mix.bars} BARS (${mix.mix_start_sec}s → ${mix.mix_end_sec}s)</span></div>
      <div class="stat-item"><span class="lbl">BASS DROP MOMENT</span><span class="val">${mix.mix_swap_sec}s</span></div>
      <div class="stat-item"><span class="lbl">HARMONIC PITCH SHIFT</span><span class="val">${(mix.pitch_shift_semitones > 0 ? '+' : '') + mix.pitch_shift_semitones} Semitones (${mix.camelot_compatibility ? mix.camelot_compatibility.relationship : 'Harmonic'})</span></div>
    `;
    modalAudioPlayer.src = mix.mix_url;
    modalDownloadLink.href = mix.mix_url;
    mixModal.classList.remove('hidden');

    // Auto-dismiss after 5 seconds (enough to glance stats + click download)
    if (modalDismissTimer) clearTimeout(modalDismissTimer);
    modalDismissTimer = setTimeout(() => {
      mixModal.classList.add('hidden');
      modalAudioPlayer.pause();
      modalDismissTimer = null;
    }, 5000);
  }

  btnExportMix.addEventListener('click', async () => {
    if (lastRenderedMix) {
      showMixModal(lastRenderedMix);
      return;
    }
    if (!track1Data || !track2Data) {
      alert('Please load both Deck 1 and Deck 2 first!');
      return;
    }

    // A blend that was just performed is re-rendered in the browser with the same buffers,
    // plan and automation: the export is exactly what was heard, and costs the server nothing.
    if (lastPerformed) {
      transitionStatusBanner.textContent = 'RENDERING THE PERFORMED TRANSITION (.WAV)...';
      btnExportMix.disabled = true;
      try {
        const res = await TransitionLab.exportPerformed(lastPerformed);
        const p = lastPerformed.plan;
        lastRenderedMix = {
          technique: lastPerformed.technique,
          total_duration: Math.round(res.duration * 100) / 100,
          bars: p.bars + (p.tailBars || 0),
          mix_start_sec: Math.round(res.marks.start * 100) / 100,
          mix_end_sec: Math.round(res.marks.end * 100) / 100,
          mix_swap_sec: Math.round(res.marks.swap * 100) / 100,
          pitch_shift_semitones: 0,
          camelot_compatibility: null,
          mix_url: URL.createObjectURL(res.blob),
        };
        showMixModal(lastRenderedMix);
        transitionStatusBanner.textContent = 'TRANSITION EXPORTED: EXACTLY WHAT WAS PLAYED';
      } catch (e) {
        console.error(e);
        alert('Export failed: ' + e.message);
      } finally {
        btnExportMix.disabled = false;
      }
      return;
    }

    transitionStatusBanner.textContent = 'RENDERING LOSSLESS MASTER MIX (.WAV)...';
    btnExportMix.disabled = true;
    btnExportMix.innerHTML = 'Rendering Studio Mix...';

    const effectiveTech = selectedTechnique === 'auto' 
      ? (currentAIRec ? currentAIRec.recommended_technique : 'bass_swap')
      : selectedTechnique;
    const tempoRamp = document.getElementById('toggle-tempo-ramp').checked;
    const harmonicLock = document.getElementById('toggle-harmonic').checked;
    const neuralStems = document.getElementById('toggle-neural-stems').checked;
    const bars = selectedBars;

    try {
      const isDir1to2 = (transitionDirection === '1_to_2');
      const form = new FormData();
      form.append('file_id_1', track1Data.file_id);
      form.append('file_id_2', track2Data.file_id);
      // Export the transition that was just performed, if any
      const c = lastTransitionCues;
      form.append('direction', c ? c.direction : transitionDirection);
      form.append('technique', c ? c.technique : effectiveTech);
      form.append('bars', c ? c.bars : bars);
      form.append('tempo_ramp', tempoRamp);
      form.append('harmonic_lock', harmonicLock);
      form.append('use_stems', neuralStems);
      form.append('cue_1', c ? c.cue_1 : (isDir1to2 ? (engine.deck1.audio.currentTime || track1Data.suggested_cue_outro) : track1Data.suggested_cue_intro));
      form.append('cue_2', c ? c.cue_2 : (isDir1to2 ? track2Data.suggested_cue_intro : (engine.deck2.audio.currentTime || track2Data.suggested_cue_outro)));

      const res = await fetch('/api/render-mix', { method: 'POST', body: form });
      const data = await res.json();
      if (data.status === 'success') {
        lastRenderedMix = data.mix;
        showMixModal(data.mix);
        transitionStatusBanner.textContent = 'STUDIO MASTER MIX READY & LOADED';
      } else {
        alert('Render error: ' + (data.detail || 'Failed to render mix'));
      }
    } catch (e) {
      console.error(e);
      alert('Render request failed: ' + e.message);
    } finally {
      btnExportMix.disabled = false;
      btnExportMix.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        Export Master Mix (.WAV)
      `;
    }
  });

  btnCloseModal.addEventListener('click', () => {
    mixModal.classList.add('hidden');
    modalAudioPlayer.pause();
    if (modalDismissTimer) { clearTimeout(modalDismissTimer); modalDismissTimer = null; }
  });

  // --- Main Animation Loop ---
  let lastTime = performance.now();
  const deckStateEls = [document.getElementById('d1-state'), document.getElementById('d2-state')];
  function updateDeckStates() {
    [[track1Data, engine.deck1], [track2Data, engine.deck2]].forEach(([track, deck], i) => {
      const el = deckStateEls[i];
      if (!el) return;
      const [text, cls] = !track ? ['EMPTY', 'deck-state'] : deck.isPlaying ? ['ON AIR', 'deck-state on-air']
        : ['CUED', 'deck-state cued'];
      if (el.textContent !== text) { el.textContent = text; el.className = cls; }
    });
  }

  function loop(currentTime) {
    const dt = (currentTime - lastTime) / 1000;
    lastTime = currentTime;
    updateDeckStates();

    if (track1Data) {
      jog1.updatePlayback(dt, track1Data.bpm, engine.deck1.isPlaying);
      wave1.setTime(engine.deck1.audio.currentTime);
      d1Time.textContent = `${formatTime(engine.deck1.audio.currentTime)} / ${formatTime(track1Data.duration)}`;
    }
    if (track2Data) {
      jog2.updatePlayback(dt, track2Data.bpm, engine.deck2.isPlaying);
      wave2.setTime(engine.deck2.audio.currentTime);
      d2Time.textContent = `${formatTime(engine.deck2.audio.currentTime)} / ${formatTime(track2Data.duration)}`;
    }
    if (track1Data && track2Data) {
      updateTransitionOverlay();
    }

    // VU Meters
    const vu1 = engine.deck1.getVULevel();
    const vu2 = engine.deck2.getVULevel();
    updateVUBars('vu-meter-left', vu1);
    updateVUBars('vu-meter-right', vu2);

    // Faders/EQ follow the scheduled transition automation so the DJ sees the moves
    if (isTransitioning) {
      [[1, engine.deck1], [2, engine.deck2]].forEach(([n, deck]) => {
        const fader = document.getElementById(`d${n}-vol-fader`);
        if (fader) fader.value = Math.round(deck.faderGain.gain.value * 100);
        [['hi', deck.eqHigh], ['mid', deck.eqMid], ['low', deck.eqLow]].forEach(([band, node]) => {
          const el = document.getElementById(`d${n}-eq-${band}`);
          if (el) el.value = node.gain.value;
        });
      });
    }

    // Phase meter: telemetry only (grids + audio clock), no correction loop
    if (track1Data && track2Data) {
      if (engine.deck1.audio.running && engine.deck2.audio.running) {
        const err = isDeck1SyncLocked
          ? computePhaseError(engine.deck2, track2Data, engine.deck1, track1Data)
          : computePhaseError(engine.deck1, track1Data, engine.deck2, track2Data);
        updatePhaseMeterHUD(err.errorMs);
      } else if (phaseStatus && !isTransitioning) {
        phaseStatus.textContent = '±0.0 ms (STANDBY)';
        if (phaseCursor) {
          phaseCursor.style.left = '50%';
          phaseCursor.className = 'phase-cursor locked';
        }
      }
    }

    requestAnimationFrame(loop);
  }

  function updateVUBars(meterId, level) {
    const bars = document.querySelectorAll(`#${meterId} .vu-bar`);
    const count = bars.length;
    const litCount = Math.round(level * count * 2.2);
    bars.forEach((bar, idx) => {
      const invIdx = count - 1 - idx;
      if (invIdx < litCount) {
        bar.classList.add('lit');
      } else {
        bar.classList.remove('lit');
      }
    });
  }

  // --- Global Keyboard Shortcuts ---
  function flashButton(selector) {
    const el = document.querySelector(selector);
    if (el) {
      el.classList.add('key-active');
      setTimeout(() => el.classList.remove('key-active'), 150);
    }
  }

  function nudgeTempo(deck, delta) {
    if (deck === 1) {
      const cur = parseFloat(d1TempoFader.value) || 0;
      const next = Math.max(-16, Math.min(16, cur + delta));
      d1TempoFader.value = next;
      d1TempoFader.dispatchEvent(new Event('input'));
      flashButton('#d1-tempo-fader');
    } else {
      const cur = parseFloat(d2TempoFader.value) || 0;
      const next = Math.max(-16, Math.min(16, cur + delta));
      d2TempoFader.value = next;
      d2TempoFader.dispatchEvent(new Event('input'));
      flashButton('#d2-tempo-fader');
    }
  }

  window.addEventListener('keydown', (e) => {
    // Ignore keystrokes when typing into text inputs or dropdowns
    if (e.target && e.target.matches('input[type="text"], textarea, select')) return;

    // Prevent handling if modifier keys (Cmd/Ctrl/Alt) are pressed, unless it's ? (Shift+/)
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    unlockAudio();

    const code = e.code;
    const key = e.key;

    switch (code) {
      // -------------------------------------------------------------
      // DECK 1 (LEFT HAND - BLUE)
      // -------------------------------------------------------------
      case 'KeyQ': // Deck 1 Play/Pause
        e.preventDefault();
        flashButton('#d1-btn-play');
        d1BtnPlay.click();
        break;

      case 'KeyW': // Deck 1 Cue
        e.preventDefault();
        flashButton('#d1-btn-cue');
        d1BtnCue.click();
        break;

      case 'KeyS': // Deck 1 Master Tempo Sync
        e.preventDefault();
        flashButton('#d1-btn-sync');
        d1BtnSync.click();
        break;

      case 'KeyZ': // Deck 1 Hi Kill
        e.preventDefault();
        const kill1Hi = document.querySelector('.btn-kill[data-target="d1-eq-hi"]');
        if (kill1Hi) {
          flashButton('.btn-kill[data-target="d1-eq-hi"]');
          kill1Hi.click();
        }
        break;

      case 'KeyC': // Deck 1 Mid Kill
        e.preventDefault();
        const kill1Mid = document.querySelector('.btn-kill[data-target="d1-eq-mid"]');
        if (kill1Mid) {
          flashButton('.btn-kill[data-target="d1-eq-mid"]');
          kill1Mid.click();
        }
        break;

      case 'KeyA': // Deck 1 Bass Kill
        e.preventDefault();
        const kill1 = document.querySelector('.btn-kill[data-target="d1-eq-low"]');
        if (kill1) {
          flashButton('.btn-kill[data-target="d1-eq-low"]');
          kill1.click();
        }
        break;

      case 'KeyE': // Deck 1 Tempo -
        e.preventDefault();
        nudgeTempo(1, -0.2);
        break;

      case 'KeyR': // Deck 1 Tempo +
        e.preventDefault();
        nudgeTempo(1, +0.2);
        break;

      // -------------------------------------------------------------
      // DECK 2 (RIGHT HAND - ORANGE)
      // -------------------------------------------------------------
      case 'KeyP': // Deck 2 Play/Pause
        e.preventDefault();
        flashButton('#d2-btn-play');
        d2BtnPlay.click();
        break;

      case 'KeyO': // Deck 2 Cue
        e.preventDefault();
        flashButton('#d2-btn-cue');
        d2BtnCue.click();
        break;

      case 'KeyL': // Deck 2 Master Tempo Sync
        e.preventDefault();
        flashButton('#d2-btn-sync');
        d2BtnSync.click();
        break;

      case 'KeyM': // Deck 2 Hi Kill
        e.preventDefault();
        const kill2Hi = document.querySelector('.btn-kill[data-target="d2-eq-hi"]');
        if (kill2Hi) {
          flashButton('.btn-kill[data-target="d2-eq-hi"]');
          kill2Hi.click();
        }
        break;

      case 'Comma': // Deck 2 Mid Kill
        e.preventDefault();
        const kill2Mid = document.querySelector('.btn-kill[data-target="d2-eq-mid"]');
        if (kill2Mid) {
          flashButton('.btn-kill[data-target="d2-eq-mid"]');
          kill2Mid.click();
        }
        break;

      case 'KeyK': // Deck 2 Bass Kill
      case 'Period':
      case 'Semicolon':
        e.preventDefault();
        const kill2 = document.querySelector('.btn-kill[data-target="d2-eq-low"]');
        if (kill2) {
          flashButton('.btn-kill[data-target="d2-eq-low"]');
          kill2.click();
        }
        break;

      case 'KeyU': // Deck 2 Tempo -
        e.preventDefault();
        nudgeTempo(2, -0.2);
        break;

      case 'KeyI': // Deck 2 Tempo +
        e.preventDefault();
        nudgeTempo(2, +0.2);
        break;

      // -------------------------------------------------------------
      // MIXER & MASTER TRANSITION ENGINE (CENTER)
      // -------------------------------------------------------------
      case 'Space': // Trigger Pro Transition!
        e.preventDefault();
        flashButton('#btn-trigger-transition');
        btnTriggerTransition.click();
        break;

      case 'Tab': // Swap Flow Direction (1->2 / 2->1)
        e.preventDefault();
        flashButton('#btn-swap-dir');
        toggleTransitionDirection();
        break;

      case 'ArrowLeft': // Fade channel fader: Deck 1 up (100%), Deck 2 down (0%)
        e.preventDefault();
        if (d1VolFader) { d1VolFader.value = 100; d1VolFader.dispatchEvent(new Event('input')); }
        if (d2VolFader) { d2VolFader.value = 0; d2VolFader.dispatchEvent(new Event('input')); }
        crossfader.value = 50;
        engine.setCrossfader(50, 'club');
        flashButton('#crossfader');
        break;

      case 'ArrowDown': // Balance both channel faders at 100% (Crossfader center 50%)
        e.preventDefault();
        if (d1VolFader) { d1VolFader.value = 100; d1VolFader.dispatchEvent(new Event('input')); }
        if (d2VolFader) { d2VolFader.value = 100; d2VolFader.dispatchEvent(new Event('input')); }
        crossfader.value = 50;
        engine.setCrossfader(50, 'club');
        flashButton('#crossfader');
        break;

      case 'ArrowRight': // Fade channel fader: Deck 2 up (100%), Deck 1 down (0%)
        e.preventDefault();
        if (d1VolFader) { d1VolFader.value = 0; d1VolFader.dispatchEvent(new Event('input')); }
        if (d2VolFader) { d2VolFader.value = 100; d2VolFader.dispatchEvent(new Event('input')); }
        crossfader.value = 50;
        engine.setCrossfader(50, 'club');
        flashButton('#crossfader');
        break;

      case 'KeyX': // Export Mix
        e.preventDefault();
        if (!btnExportMix.disabled) {
          flashButton('#btn-export-mix');
          btnExportMix.click();
        }
        break;

      case 'Slash': // '?' key
      case 'KeyH':
        if (key === '?' || code === 'KeyH') {
          e.preventDefault();
          toggleShortcutsModal();
        }
        break;

      case 'Escape': // Dismiss any modal
        e.preventDefault();
        closeAllModals();
        break;
    }
  });

  requestAnimationFrame(loop);
});
