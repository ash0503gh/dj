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
  let zoomLevel = 1.0;
  let currentAIRec = null;

  // Auto-unlock AudioContext on first user interaction
  const unlockAudio = () => {
    if (engine.ctx.state === 'suspended') {
      engine.ctx.resume().then(() => console.log('AudioContext unlocked.'));
    }
  };
  window.addEventListener('click', unlockAudio, { once: true });
  window.addEventListener('keydown', unlockAudio, { once: true });

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

  // Closed-Loop Phase-Lock Loop (PLL) State
  let isDeck1SyncLocked = false;
  let isDeck2SyncLocked = false;
  let isTransitionPhaseLocked = false;

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

  // Waveform Zoom
  const btnZoomIn = document.getElementById('btn-zoom-in');
  const btnZoomOut = document.getElementById('btn-zoom-out');
  const wfZoomLevel = document.getElementById('wf-zoom-level');

  // Phrase Countdown HUD
  const phraseHud = document.getElementById('phrase-countdown-hud');
  const phraseHudCounter = document.getElementById('phrase-hud-counter');
  const phraseHudProgress = document.getElementById('phrase-hud-progress');
  const togglePhraseLock = document.getElementById('toggle-phrase-lock');
  const toggleVocalDuck = document.getElementById('toggle-vocal-duck');
  const toggleNeuralStems = document.getElementById('toggle-neural-stems');

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

  // Load stored Jev key, Gemini key, and model
  if (jevKeyInput) {
    jevKeyInput.value = localStorage.getItem('jev_api_key') || '';
  }
  if (geminiKeyInput) {
    geminiKeyInput.value = localStorage.getItem('gemini_api_key') || '';
  }
  if (aiModelSelect) {
    aiModelSelect.value = localStorage.getItem('ai_dj_model') || 'jev-latest';
    aiModelSelect.addEventListener('change', () => {
      localStorage.setItem('ai_dj_model', aiModelSelect.value);
      fetchAIStrategy();
    });
  }
  if (btnSaveJevKey && jevKeyInput) {
    btnSaveJevKey.addEventListener('click', () => {
      const keyVal = jevKeyInput.value.trim();
      localStorage.setItem('jev_api_key', keyVal);
      btnSaveJevKey.textContent = 'SAVED!';
      setTimeout(() => { btnSaveJevKey.textContent = 'SAVE'; }, 1500);
      fetchAIStrategy();
    });
  }
  if (btnSaveGeminiKey && geminiKeyInput) {
    btnSaveGeminiKey.addEventListener('click', () => {
      const keyVal = geminiKeyInput.value.trim();
      localStorage.setItem('gemini_api_key', keyVal);
      btnSaveGeminiKey.textContent = 'SAVED!';
      setTimeout(() => { btnSaveGeminiKey.textContent = 'SAVE'; }, 1500);
      fetchAIStrategy();
    });
  }

  function toggleAIModal(forceState = null) {
    if (!aiModal) return;
    const shouldOpen = (forceState !== null) ? forceState : aiModal.classList.contains('hidden');
    if (shouldOpen) {
      aiModal.classList.remove('hidden');
      fetchAIStrategy();
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
  if (aiRecCard) aiRecCard.addEventListener('click', () => toggleAIModal(true));
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
    transitionStatusBanner.textContent = `MIX FLOW: ${dir === '1_to_2' ? 'DECK 1 ➔ DECK 2' : 'DECK 2 ➔ DECK 1'}`;
    updateHarmonicCompatibility();
    updateAIRecCard();
    fetchAIStrategy();
    updateTransitionOverlay();
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
      transitionStateSub.textContent = currentAIRec ? `AI PICK: ${currentAIRec.technique_name}` : 'AI SMART DECISION';
    } else {
      const names = {
        'bass_swap': '💥 BASS SWAP (16/32 BARS)',
        'echo_freeze': '❄️ ECHO FREEZE CUT',
        'loop_roll': '🌀 STUTTER LOOP ROLL RISER',
        'vinyl_brake': '⚡ TURNTABLE BRAKE & DROP',
        'spinback': '💫 VINYL SPINBACK & DROP',
        'noise_riser': '📈 WHITE NOISE RISER & DROP',
        'festival_drop': '🎆 FESTIVAL BUILD & DROP',
        'hard_cut': '✂️ HARD CUT (BEAT 1 SNAP)'
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

    // 3. Fast client-side decoding for true duration and high-res RGB waveform
    try {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const arrayBuffer = e.target.result;
          if (engine.ctx.state === 'suspended') {
            await engine.ctx.resume();
          }
          const audioBuffer = await engine.ctx.decodeAudioData(arrayBuffer.slice(0));
          const trueDur = audioBuffer.duration;
          
          const numBins = Math.min(12000, Math.max(3600, Math.floor(trueDur * 60)));
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

          const currentTrack = (deckNum === 1) ? track1Data : track2Data;
          if (currentTrack && currentTrack.audio_url === blobUrl) {
            currentTrack.duration = trueDur;
            currentTrack.waveform = { 
              overall, 
              low, 
              mid, 
              high, 
              low_red: low, 
              mid_green: mid, 
              high_blue: high 
            };
            currentTrack.suggested_cue_outro = Math.max(0, trueDur - 30);
            if (deckNum === 1) {
              wave1.loadTrack(currentTrack);
            } else {
              wave2.loadTrack(currentTrack);
            }
          }
        } catch (decErr) {
          console.warn('Client-side audio decode error (using acoustic synthesizer):', decErr);
        }
      };
      reader.readAsArrayBuffer(file);
    } catch (readErr) {
      console.warn('File read error:', readErr);
    }

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
        if (currentTrack) {
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
          if (sTrack.waveform) {
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
            fetchAIStrategy();
          }
          transitionStatusBanner.textContent = `${deckName}: ANALYSIS COMPLETE (${currentTrack.bpm.toFixed(1)} BPM, ${currentTrack.camelot})`;
        }
      }
    } catch (err) {
      console.warn('Server background analysis failed, local playback remains active:', err);
      transitionStatusBanner.textContent = `${deckName}: READY FOR LIVE MIXING (LOCAL MODE)`;
    }
  }

  // --- Load Track Into Deck ---
  function loadTrackIntoDeck(deckNum, track) {
    resetDeckEQs(deckNum);
    const ac = track.acoustic_profile || {};
    const outroVocal = ac.outro_vocal_score !== undefined ? ac.outro_vocal_score : (ac.intro_vocal_score || 0.0);
    const vocalPct = Math.round(outroVocal * 100);
    const perc = ac.outro_percussion || ac.intro_percussion || 'driving_4_4';
    const phrases = (track.phrase_16_times && track.phrase_16_times.length) || (track.phrase_8_times && track.phrase_8_times.length) || 4;

    const bpmStr = (track.bpm && !isNaN(track.bpm)) ? track.bpm.toFixed(2) : '--.--';
    const keyStr = track.camelot ? `${track.camelot} (${track.key || ''})` : '--';

    if (deckNum === 1) {
      track1Data = track;
      d1Title.textContent = track.title || track.filename;
      d1Bpm.textContent = bpmStr;
      d1Key.textContent = keyStr;
      if (d1VocalVal) {
        d1VocalVal.textContent = `${vocalPct}% (${vocalPct > 35 ? 'VOCALS' : (vocalPct > 15 ? 'MILD' : 'CLEAN')})`;
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
      if (track.bpm && !isNaN(track.bpm)) {
        masterBpmEl.textContent = track.bpm.toFixed(2);
      }
    } else {
      track2Data = track;
      d2Title.textContent = track.title || track.filename;
      d2Bpm.textContent = bpmStr;
      d2Key.textContent = keyStr;
      if (d2VocalVal) {
        d2VocalVal.textContent = `${vocalPct}% (${vocalPct > 35 ? 'VOCALS' : (vocalPct > 15 ? 'MILD' : 'CLEAN')})`;
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
    }
    if (track1Data && track2Data) {
      btnExportMix.disabled = false;
      fetchAIStrategy();
    }
    updateHarmonicCompatibility();
    updateAIRecCard();
    updateTransitionOverlay();
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
          if (jevKeyInput && !jevKeyInput.value) {
            jevKeyInput.placeholder = '✓ Active via Render Environment Variable (Ready)';
          }
        }
        if (data.gemini_configured) {
          if (geminiKeyInput && !geminiKeyInput.value) {
            geminiKeyInput.placeholder = '✓ Active via Render Environment Variable (Ready)';
          }
        }
        if (aiSourceBadge) {
          if (data.jev_configured && data.gemini_configured) {
            aiSourceBadge.textContent = '⚡ Jev (<200ms) & Gemini Active (Render Env)';
          } else if (data.jev_configured) {
            aiSourceBadge.textContent = '⚡ TypeSafe Jev System One Active (Render Env)';
          } else if (data.gemini_configured) {
            aiSourceBadge.textContent = '✨ Google Gemini AI Active (Render Env)';
          }
        }
        if (aiModelSelect && !localStorage.getItem('ai_dj_model')) {
          aiModelSelect.value = data.jev_configured ? 'jev-latest' : (data.gemini_configured ? 'gemini-1.5-flash' : 'local');
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
    if (!track1Data || !track2Data) return;
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
    const model = aiModelSelect ? aiModelSelect.value : (localStorage.getItem('ai_dj_model') || 'jev-latest');
    const modelLabel = (model === 'local') ? 'Local Acoustic DSP' : 
                       (model.startsWith('jev') ? 'TypeSafe Jev System One (<200ms)' : 
                       (model === 'gemini-1.5-pro' ? 'Gemini 1.5 Pro' : 'Gemini 1.5 Flash'));

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
            ⚠️ <strong>Gemini Notice:</strong> ${st.gemini_error}. Strategy calculated using Local Physical Acoustic Engine.
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

  // --- Zoom Controls ---
  btnZoomIn.addEventListener('click', () => {
    if (wave1.mode === 'overview') {
      wave1.mode = 'scroll';
      wave2.mode = 'scroll';
    }
    zoomLevel = Math.min(4.0, +(zoomLevel + 0.5).toFixed(1));
    wfZoomLevel.textContent = `${zoomLevel.toFixed(1)}x`;
    wave1.zoom = zoomLevel;
    wave2.zoom = zoomLevel;
    wave1.draw();
    wave2.draw();
    updateTransitionOverlay();
  });

  btnZoomOut.addEventListener('click', () => {
    if (zoomLevel <= 0.5) {
      wave1.mode = 'overview';
      wave2.mode = 'overview';
      wfZoomLevel.textContent = 'FULL';
    } else {
      zoomLevel = Math.max(0.5, +(zoomLevel - 0.5).toFixed(1));
      wfZoomLevel.textContent = `${zoomLevel.toFixed(1)}x`;
      wave1.zoom = zoomLevel;
      wave2.zoom = zoomLevel;
    }
    wave1.draw();
    wave2.draw();
    updateTransitionOverlay();
  });

  if (wfZoomLevel) {
    wfZoomLevel.style.cursor = 'pointer';
    wfZoomLevel.title = 'Click to toggle SCROLL / FULL OVERVIEW';
    wfZoomLevel.addEventListener('click', () => {
      if (wave1.mode === 'scroll') {
        wave1.mode = 'overview';
        wave2.mode = 'overview';
        wfZoomLevel.textContent = 'FULL';
      } else {
        wave1.mode = 'scroll';
        wave2.mode = 'scroll';
        wfZoomLevel.textContent = `${zoomLevel.toFixed(1)}x`;
      }
      wave1.draw();
      wave2.draw();
      updateTransitionOverlay();
    });
  }

  // --- Transport Controls ---
  engine.deck1.audio.addEventListener('play', () => {
    d1BtnPlay.classList.add('playing');
    d1BtnPlay.textContent = '⏸ PAUSE';
  });
  engine.deck1.audio.addEventListener('pause', () => {
    d1BtnPlay.classList.remove('playing');
    d1BtnPlay.textContent = '▶ PLAY';
  });
  engine.deck2.audio.addEventListener('play', () => {
    d2BtnPlay.classList.add('playing');
    d2BtnPlay.textContent = '⏸ PAUSE';
  });
  engine.deck2.audio.addEventListener('pause', () => {
    d2BtnPlay.classList.remove('playing');
    d2BtnPlay.textContent = '▶ PLAY';
  });

  d1BtnPlay.addEventListener('click', async () => {
    unlockAudio();
    if (engine.deck1.isPlaying) {
      engine.deck1.pause();
      d1BtnPlay.classList.remove('playing');
      d1BtnPlay.textContent = '▶ PLAY';
    } else {
      if (!engine.deck1.audio.src || engine.deck1.audio.src === window.location.href) {
        transitionStatusBanner.textContent = 'DECK 1: PLEASE LOAD A TRACK FIRST (CLICK UPLOAD OR CHOOSE PRESET)';
        return;
      }
      if (isDeck1SyncLocked && engine.deck2.isPlaying && track1Data && track2Data) {
        const m = getDeckPhase(track2Data, engine.deck2.audio.currentTime);
        const s = getDeckPhase(track1Data, engine.deck1.audio.currentTime);
        engine.deck1.audio.currentTime = s.currentBeat + (m.phase * s.beatDuration);
      }
      try {
        await engine.deck1.play();
        d1BtnPlay.classList.add('playing');
        d1BtnPlay.textContent = '⏸ PAUSE';
      } catch (err) {
        d1BtnPlay.classList.remove('playing');
        d1BtnPlay.textContent = '▶ PLAY';
        transitionStatusBanner.textContent = 'DECK 1 PLAYBACK ERROR: ' + (err.message || 'Check audio source');
      }
    }
  });

  d2BtnPlay.addEventListener('click', async () => {
    unlockAudio();
    if (engine.deck2.isPlaying) {
      engine.deck2.pause();
      d2BtnPlay.classList.remove('playing');
      d2BtnPlay.textContent = '▶ PLAY';
    } else {
      if (!engine.deck2.audio.src || engine.deck2.audio.src === window.location.href) {
        transitionStatusBanner.textContent = 'DECK 2: PLEASE LOAD A TRACK FIRST (CLICK UPLOAD OR CHOOSE PRESET)';
        return;
      }
      if (isDeck2SyncLocked && engine.deck1.isPlaying && track1Data && track2Data) {
        const m = getDeckPhase(track1Data, engine.deck1.audio.currentTime);
        const s = getDeckPhase(track2Data, engine.deck2.audio.currentTime);
        engine.deck2.audio.currentTime = s.currentBeat + (m.phase * s.beatDuration);
      }
      try {
        await engine.deck2.play();
        d2BtnPlay.classList.add('playing');
        d2BtnPlay.textContent = '⏸ PAUSE';
      } catch (err) {
        d2BtnPlay.classList.remove('playing');
        d2BtnPlay.textContent = '▶ PLAY';
        transitionStatusBanner.textContent = 'DECK 2 PLAYBACK ERROR: ' + (err.message || 'Check audio source');
      }
    }
  });

  d1BtnCue.addEventListener('click', () => {
    unlockAudio();
    engine.deck1.setCue();
    d1BtnPlay.classList.remove('playing');
    d1BtnPlay.textContent = '▶ PLAY';
  });

  d2BtnCue.addEventListener('click', () => {
    unlockAudio();
    engine.deck2.setCue();
    d2BtnPlay.classList.remove('playing');
    d2BtnPlay.textContent = '▶ PLAY';
  });

  // --- REAL-TIME CLOSED-LOOP PHASE-LOCK LOOP (PLL) ENGINE ---
  function getDeckPhase(trackData, currentTime) {
    if (!trackData || !trackData.beat_times || trackData.beat_times.length === 0) {
      const spb = 60.0 / (trackData ? trackData.bpm : 128.0);
      const beatNum = Math.floor(currentTime / spb);
      return {
        phase: (currentTime % spb) / spb,
        currentBeat: beatNum * spb,
        nextBeat: (beatNum + 1) * spb,
        beatDuration: spb
      };
    }
    const beats = trackData.beat_times;
    let low = 0, high = beats.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (beats[mid] <= currentTime) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const idx = Math.max(0, high);
    const bCur = beats[idx];
    const bNext = (idx + 1 < beats.length) ? beats[idx + 1] : (bCur + (60.0 / trackData.bpm));
    const beatDur = Math.max(0.001, bNext - bCur);
    const phase = (currentTime - bCur) / beatDur;
    return {
      phase: Math.max(0.0, Math.min(1.0, phase)),
      currentBeat: bCur,
      nextBeat: bNext,
      beatDuration: beatDur
    };
  }

  function computePhaseError(masterTrack, masterTime, slaveTrack, slaveTime) {
    const m = getDeckPhase(masterTrack, masterTime);
    const s = getDeckPhase(slaveTrack, slaveTime);

    let phaseDiff = s.phase - m.phase;
    if (phaseDiff > 0.5) phaseDiff -= 1.0;
    if (phaseDiff < -0.5) phaseDiff += 1.0;

    const errorMs = phaseDiff * m.beatDuration * 1000;
    return {
      phaseDiff,
      errorMs,
      masterBeat: m.currentBeat,
      slaveBeat: s.currentBeat,
      masterBeatDuration: m.beatDuration,
      slaveBeatDuration: s.beatDuration,
      beatDuration: m.beatDuration
    };
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

  function applyPhaseLockLoop(masterDeck, masterTrack, slaveDeck, slaveTrack, baseSyncRate) {
    if (!masterTrack || !slaveTrack) return;
    const tMaster = masterDeck.audio.currentTime;
    const tSlave = slaveDeck.audio.currentTime;

    const { phaseDiff, errorMs } = computePhaseError(masterTrack, tMaster, slaveTrack, tSlave);

    // 1. Gross error (e.g. initial audio seek latency > 80ms): instantly micro-seek to snap onto beat
    if (Math.abs(errorMs) > 80 && !slaveDeck.audio.seeking) {
      const m = getDeckPhase(masterTrack, tMaster);
      const s = getDeckPhase(slaveTrack, tSlave);
      const targetTime = s.currentBeat + (m.phase * s.beatDuration);
      if (Math.abs(targetTime - tSlave) > 0.04) {
        slaveDeck.audio.currentTime = targetTime;
        updatePhaseMeterHUD(0);
        return;
      }
    }

    // 2. Proportional Pitch Nudge (proportional closed-loop rate steering)
    let activeRate = baseSyncRate;
    if (Math.abs(errorMs) > 2.0) {
      const kP = 0.45; // Proportional feedback gain
      const correction = 1.0 - (phaseDiff * kP);
      const clamped = Math.max(0.92, Math.min(1.08, correction));
      activeRate = baseSyncRate * clamped;
    }
    slaveDeck.setPlaybackRate(activeRate);

    // Real-time pitch readout feedback
    if (slaveDeck === engine.deck1 && d1PitchVal) {
      d1PitchVal.textContent = `${((activeRate - 1) * 100).toFixed(1)}%`;
    } else if (slaveDeck === engine.deck2 && d2PitchVal) {
      d2PitchVal.textContent = `${((activeRate - 1) * 100).toFixed(1)}%`;
    }

    // 3. Update Visual Phase Meter HUD
    updatePhaseMeterHUD(errorMs);
  }

  d1BtnSync.addEventListener('click', () => {
    if (!track1Data || !track2Data) return;
    const isNowActive = !d1BtnSync.classList.contains('active');
    d1BtnSync.classList.toggle('active', isNowActive);
    isDeck1SyncLocked = isNowActive;

    if (isNowActive) {
      const baseRate = track2Data.bpm / track1Data.bpm;
      engine.deck1.setPlaybackRate(baseRate);
      d1PitchVal.textContent = `${((baseRate - 1) * 100).toFixed(1)}%`;

      // Instant Phase Snap to Deck 2's Beat
      if (engine.deck2.isPlaying) {
        const m = getDeckPhase(track2Data, engine.deck2.audio.currentTime);
        const s = getDeckPhase(track1Data, engine.deck1.audio.currentTime);
        engine.deck1.audio.currentTime = s.currentBeat + (m.phase * s.beatDuration);
      }
      transitionStatusBanner.textContent = '🎯 DECK 1 BEAT SYNC LOCKED (CLOSED-LOOP PLL ACTIVE)';
    } else {
      transitionStatusBanner.textContent = 'DECK 1 BEAT SYNC DISENGAGED';
    }
  });

  d2BtnSync.addEventListener('click', () => {
    if (!track1Data || !track2Data) return;
    const isNowActive = !d2BtnSync.classList.contains('active');
    d2BtnSync.classList.toggle('active', isNowActive);
    isDeck2SyncLocked = isNowActive;

    if (isNowActive) {
      const baseRate = track1Data.bpm / track2Data.bpm;
      engine.deck2.setPlaybackRate(baseRate);
      d2PitchVal.textContent = `${((baseRate - 1) * 100).toFixed(1)}%`;

      // Instant Phase Snap to Deck 1's Beat
      if (engine.deck1.isPlaying) {
        const m = getDeckPhase(track1Data, engine.deck1.audio.currentTime);
        const s = getDeckPhase(track2Data, engine.deck2.audio.currentTime);
        engine.deck2.audio.currentTime = s.currentBeat + (m.phase * s.beatDuration);
      }
      transitionStatusBanner.textContent = '🎯 DECK 2 BEAT SYNC LOCKED (CLOSED-LOOP PLL ACTIVE)';
    } else {
      transitionStatusBanner.textContent = 'DECK 2 BEAT SYNC DISENGAGED';
    }
  });

  // Tempo sliders
  d1TempoFader.addEventListener('input', (e) => {
    if (isDeck1SyncLocked) {
      isDeck1SyncLocked = false;
      d1BtnSync.classList.remove('active');
    }
    const pct = parseFloat(e.target.value);
    engine.deck1.setPlaybackRate(1 + (pct / 100));
    d1PitchVal.textContent = `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
  });
  d2TempoFader.addEventListener('input', (e) => {
    if (isDeck2SyncLocked) {
      isDeck2SyncLocked = false;
      d2BtnSync.classList.remove('active');
    }
    const pct = parseFloat(e.target.value);
    engine.deck2.setPlaybackRate(1 + (pct / 100));
    d2PitchVal.textContent = `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
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

  function getTrackIntroCue(track) {
    if (!track) return 0.0;
    if (track.suggested_cue_intro !== undefined && track.suggested_cue_intro >= 0) {
      return track.suggested_cue_intro;
    }
    if (track.downbeat_times && track.downbeat_times.length > 0) {
      return track.downbeat_times[0];
    }
    if (track.beat_times && track.beat_times.length > 0) {
      return track.beat_times[0];
    }
    return 0.0;
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

  // Faders
  d1VolFader.addEventListener('input', (e) => engine.deck1.setVolume(parseFloat(e.target.value)));
  d2VolFader.addEventListener('input', (e) => engine.deck2.setVolume(parseFloat(e.target.value)));
  crossfader.addEventListener('input', (e) => engine.setCrossfader(parseFloat(e.target.value)));

  // Bars Selector
  document.querySelectorAll('#bars-selector .pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#bars-selector .pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedBars = parseInt(btn.dataset.bars, 10);
      updateTransitionOverlay();
    });
  });

  // --- THE PRO TRANSITION PERFORMANCE ---
  btnTriggerTransition.addEventListener('click', async () => {
    unlockAudio();
    if (!track1Data || !track2Data) {
      alert('Please load both Deck 1 and Deck 2 first!');
      return;
    }
    if (isTransitioning) return;

    isTransitioning = true;
    btnTriggerTransition.classList.add('in-transition');

    const isDir1to2 = (transitionDirection === '1_to_2');
    const outTrack = isDir1to2 ? track1Data : track2Data;
    const inTrack = isDir1to2 ? track2Data : track1Data;
    const outDeck = isDir1to2 ? engine.deck1 : engine.deck2;
    const inDeck = isDir1to2 ? engine.deck2 : engine.deck1;
    const outDeckNum = isDir1to2 ? 1 : 2;
    const inDeckNum = isDir1to2 ? 2 : 1;
    const outBtnPlay = isDir1to2 ? d1BtnPlay : d2BtnPlay;
    const inBtnPlay = isDir1to2 ? d2BtnPlay : d1BtnPlay;
    const outFilter = isDir1to2 ? d1Filter : d2Filter;
    const inPitchVal = isDir1to2 ? d2PitchVal : d1PitchVal;
    const outDeckName = isDir1to2 ? 'DECK 1' : 'DECK 2';
    const inDeckName = isDir1to2 ? 'DECK 2' : 'DECK 1';
    const targetCf = isDir1to2 ? 100 : 0;

    const effectiveTech = selectedTechnique === 'auto' 
      ? (currentAIRec ? currentAIRec.recommended_technique : 'bass_swap')
      : selectedTechnique;

    transitionStatusBanner.textContent = `EXECUTING ${effectiveTech.toUpperCase()} (${outDeckName} ➔ ${inDeckName})...`;

    const tempoRamp = document.getElementById('toggle-tempo-ramp').checked;
    const harmonicLock = document.getElementById('toggle-harmonic').checked;
    const neuralStems = document.getElementById('toggle-neural-stems').checked;
    const bars = selectedBars;

    // Start background lossless WAV render
    const renderPromise = (async () => {
      const form = new FormData();
      form.append('file_id_1', track1Data.file_id);
      form.append('file_id_2', track2Data.file_id);
      form.append('direction', transitionDirection);
      form.append('technique', effectiveTech);
      form.append('bars', bars);
      form.append('tempo_ramp', tempoRamp);
      form.append('harmonic_lock', harmonicLock);
      form.append('use_stems', neuralStems);
      form.append('cue_1', isDir1to2 ? (engine.deck1.audio.currentTime || track1Data.suggested_cue_outro) : track1Data.suggested_cue_intro);
      form.append('cue_2', isDir1to2 ? track2Data.suggested_cue_intro : (engine.deck2.audio.currentTime || track2Data.suggested_cue_outro));

      const res = await fetch('/api/render-mix', { method: 'POST', body: form });
      return await res.json();
    })();

    // Ensure Outgoing Deck is playing
    if (!outDeck.isPlaying) {
      outDeck.play();
      outBtnPlay.classList.add('playing');
      outBtnPlay.textContent = '⏸ PAUSE';
    }

    // -------------------------------------------------------------
    // 16/32-BAR PHRASE LOCKING & HUD COUNTDOWN
    // -------------------------------------------------------------
    const curTime = outDeck.audio.currentTime;
    const spb = 60.0 / outTrack.bpm;
    const isPhraseLock = togglePhraseLock ? togglePhraseLock.checked : true;
    let targetDropTime = null;

    if (isPhraseLock) {
      const phrases = (bars >= 16 && outTrack.phrase_16_times && outTrack.phrase_16_times.length > 0)
        ? outTrack.phrase_16_times
        : (outTrack.phrase_8_times || outTrack.downbeat_times || []);
        
      for (let pt of phrases) {
        if (pt > curTime + 0.5) {
          targetDropTime = pt;
          break;
        }
      }
    }

    if (!targetDropTime && outTrack.downbeat_times && outTrack.downbeat_times.length > 0) {
      for (let db of outTrack.downbeat_times) {
        if (db > curTime + 0.3) {
          targetDropTime = db;
          break;
        }
      }
    }

    if (!targetDropTime) {
      const beatNum = Math.ceil(curTime / spb);
      const nextBarBeat = Math.ceil((beatNum + 1) / 4) * 4;
      targetDropTime = nextBarBeat * spb;
    }

    const waitMs = Math.max(100, Math.min(20000, (targetDropTime - curTime) * 1000));
    
    // Activate CDJ-Style Phrase Countdown HUD
    phraseHud.classList.remove('hidden');
    const hudStartTime = performance.now();
    const hudInterval = setInterval(() => {
      const elapsedMs = performance.now() - hudStartTime;
      const remainMs = Math.max(0, waitMs - elapsedMs);
      const progress = Math.min(1.0, elapsedMs / waitMs);
      
      const remainBeats = remainMs / (spb * 1000);
      const currentBar = Math.floor(remainBeats / 4);
      const currentBeat = Math.floor(remainBeats % 4) + 1;
      
      if (remainMs <= 250) {
        phraseHudCounter.textContent = '💥 DROP ON 1!';
        phraseHudProgress.style.width = '100%';
      } else {
        phraseHudCounter.textContent = `DROP IN ${currentBar} BARS (${currentBeat}/4)`;
        phraseHudProgress.style.width = `${(progress * 100).toFixed(1)}%`;
      }
    }, 40);

    transitionStatusBanner.textContent = `🎯 PHRASE LOCKED: DROPPING ON BEAT 1 IN ${(waitMs/1000).toFixed(1)}s...`;

    // -------------------------------------------------------------
    // LIVE MIXER EXECUTION BY TECHNIQUE
    // -------------------------------------------------------------

    // TECHNIQUE 1: ECHO FREEZE
    if (effectiveTech === 'echo_freeze') {
      setTimeout(() => {
        clearInterval(hudInterval);
        phraseHud.classList.add('hidden');
        transitionStatusBanner.textContent = `❄️ ECHO FREEZE ACTIVE: LOW ROLLED OFF & 3/4-BEAT TAPE DELAY ON ${outDeckName}...`;

        // Smoothly roll off low end on outgoing deck without harsh kill LED
        applyDeckEQ(outDeckNum, 'low', -24);
        applyDeckEQ(outDeckNum, 'mid', -6);

        outDeck.triggerEchoFreeze(outTrack.bpm, 4.5);
        outBtnPlay.classList.remove('playing');
        outBtnPlay.textContent = '▶ PLAY';

        crossfader.value = targetCf;
        engine.setCrossfader(targetCf, 'club');

        // Ensure incoming deck drops with pristine 0 dB EQs and beat-aligned cue
        resetDeckEQs(inDeckNum);
        const introCue = getTrackIntroCue(inTrack);
        inDeck.audio.currentTime = introCue;
        
        inDeck.play();
        inBtnPlay.classList.add('playing');
        inBtnPlay.textContent = '⏸ PAUSE';

        // Gradually fade remaining bands on outgoing as wash decays
        setTimeout(() => {
          applyDeckEQ(outDeckNum, 'mid', -24);
          applyDeckEQ(outDeckNum, 'hi', -24);
          resetDeckEQs(outDeckNum);
        }, 2200);

        finishTransition(renderPromise);
      }, waitMs);
      return;
    }

    // TECHNIQUE 2: VINYL BRAKE
    if (effectiveTech === 'vinyl_brake') {
      setTimeout(() => {
        clearInterval(hudInterval);
        phraseHud.classList.add('hidden');
        transitionStatusBanner.textContent = `⚡ VINYL BRAKE: ${outDeckName} LOW ROLLED OFF & MOTOR SHUTDOWN...`;

        applyDeckEQ(outDeckNum, 'low', -24);

        let rate = 1.0;
        const brakeTimer = setInterval(() => {
          rate -= 0.12;
          if (rate <= 0.05) {
            clearInterval(brakeTimer);
            outDeck.pause();
            outBtnPlay.classList.remove('playing');
            outBtnPlay.textContent = '▶ PLAY';

            resetDeckEQs(outDeckNum);

            crossfader.value = targetCf;
            engine.setCrossfader(targetCf, 'club');
            resetDeckEQs(inDeckNum);

            const introCue = getTrackIntroCue(inTrack);
            inDeck.audio.currentTime = introCue;

            inDeck.play();
            inBtnPlay.classList.add('playing');
            inBtnPlay.textContent = '⏸ PAUSE';

            finishTransition(renderPromise);
          } else {
            outDeck.setPlaybackRate(rate);
          }
        }, 90);
      }, waitMs);
      return;
    }

    // TECHNIQUE 3: VINYL SPINBACK
    if (effectiveTech === 'spinback') {
      const spinDurationSec = 1.2;
      const spinLeadMs = Math.max(0, waitMs - (spinDurationSec * 1000));
      
      setTimeout(() => {
        transitionStatusBanner.textContent = `💫 VINYL SPINBACK: ${outDeckName} LOW ROLLED OFF & REVERSE SCRUB...`;
        applyDeckEQ(outDeckNum, 'low', -24);
        outDeck.triggerSpinback(spinDurationSec, () => {
          outBtnPlay.classList.remove('playing');
          outBtnPlay.textContent = '▶ PLAY';
          resetDeckEQs(outDeckNum);
        });
      }, spinLeadMs);

      setTimeout(() => {
        clearInterval(hudInterval);
        phraseHud.classList.add('hidden');
        transitionStatusBanner.textContent = `💥 DROP: ${inDeckName} DROPS WITH FULL 3-BAND POWER!`;
        crossfader.value = targetCf;
        engine.setCrossfader(targetCf, 'club');
        resetDeckEQs(inDeckNum);

        const introCue = getTrackIntroCue(inTrack);
        inDeck.audio.currentTime = introCue;

        inDeck.play();
        inBtnPlay.classList.add('playing');
        inBtnPlay.textContent = '⏸ PAUSE';

        finishTransition(renderPromise);
      }, waitMs);
      return;
    }

    // TECHNIQUE 4: WHITE NOISE HPF RISER
    if (effectiveTech === 'noise_riser') {
      const riserBars = 4;
      const riserDurationMs = riserBars * 4 * spb * 1000;
      const riserLeadMs = Math.max(0, waitMs - riserDurationMs);

      setTimeout(() => {
        transitionStatusBanner.textContent = `📈 WHITE NOISE RISER: ${outDeckName} LOW ROLLED OFF & HPF SWELL...`;
        applyDeckEQ(outDeckNum, 'low', -24);
        engine.triggerNoiseRiser(outTrack.bpm, riserBars);

        const sweepStart = performance.now();
        const sweepTimer = setInterval(() => {
          const el = (performance.now() - sweepStart) / riserDurationMs;
          if (el >= 1.0) {
            clearInterval(sweepTimer);
            outFilter.value = 0;
            outDeck.setColorFilter(0);
          } else {
            const filterVal = Math.floor(el * 45);
            outFilter.value = filterVal;
            outDeck.setColorFilter(filterVal);
            if (el >= 0.92) {
              applyDeckEQ(outDeckNum, 'mid', -24);
              applyDeckEQ(outDeckNum, 'hi', -24);
              transitionStatusBanner.textContent = '🤫 ANTICIPATION GAP (CHANNELS ROLLED OFF)...';
            }
          }
        }, 50);
      }, riserLeadMs);

      setTimeout(() => {
        clearInterval(hudInterval);
        phraseHud.classList.add('hidden');
        transitionStatusBanner.textContent = `💥 DROP: ${inDeckName} DROPS ON BEAT 1!`;
        outDeck.pause();
        outBtnPlay.classList.remove('playing');
        outBtnPlay.textContent = '▶ PLAY';

        crossfader.value = targetCf;
        engine.setCrossfader(targetCf, 'club');
        resetDeckEQs(inDeckNum);
        resetDeckEQs(outDeckNum);

        const introCue = getTrackIntroCue(inTrack);
        inDeck.audio.currentTime = introCue;

        inDeck.play();
        inBtnPlay.classList.add('playing');
        inBtnPlay.textContent = '⏸ PAUSE';

        finishTransition(renderPromise);
      }, waitMs);
      return;
    }

    // TECHNIQUE 5: LOOP ROLL STUTTER & DROP
    if (effectiveTech === 'loop_roll') {
      const rollBars = Math.min(bars, 4);
      const rollDurationMs = rollBars * 4 * spb * 1000;
      const rollLeadMs = Math.max(0, waitMs - rollDurationMs);

      setTimeout(() => {
        transitionStatusBanner.textContent = `🌀 LOOP ROLL: ${outDeckName} STUTTER ACCELERATING...`;
        applyDeckEQ(outDeckNum, 'low', -18);

        outDeck.triggerLoopRoll(outTrack.bpm, rollBars, () => {
          outDeck.cancelLoopRoll();
        });
      }, rollLeadMs);

      setTimeout(() => {
        clearInterval(hudInterval);
        phraseHud.classList.add('hidden');
        transitionStatusBanner.textContent = `💥 DROP: ${inDeckName} DROPS ON BEAT 1!`;

        outDeck.cancelLoopRoll();
        outDeck.pause();
        outBtnPlay.classList.remove('playing');
        outBtnPlay.textContent = '▶ PLAY';
        resetDeckEQs(outDeckNum);
        outDeck.resetAllFX();

        crossfader.value = targetCf;
        engine.setCrossfader(targetCf, 'club');
        resetDeckEQs(inDeckNum);

        const introCue = getTrackIntroCue(inTrack);
        const mPhase = getDeckPhase(outTrack, outDeck.audio.currentTime);
        const sPhase = getDeckPhase(inTrack, introCue);
        inDeck.audio.currentTime = sPhase.currentBeat + (mPhase.phase * sPhase.beatDuration);

        engine.triggerDropImpact(inTrack.bpm);
        inDeck.play();
        inBtnPlay.classList.add('playing');
        inBtnPlay.textContent = '⏸ PAUSE';

        finishTransition(renderPromise);
      }, waitMs);
      return;
    }

    // TECHNIQUE 6: FESTIVAL BUILD & DROP (Multi-Technique Composite)
    // Layers: HPF Sweep + Loop Roll + White Noise Riser → Pre-Drop Silence → Sub Impact Drop
    if (effectiveTech === 'festival_drop') {
      const buildBars = Math.min(bars, 8);
      const buildDurMs = buildBars * 4 * spb * 1000;
      const buildLeadMs = Math.max(0, waitMs - buildDurMs);

      setTimeout(() => {
        transitionStatusBanner.textContent = `🎆 FESTIVAL BUILD: HPF SWEEP + STUTTER ROLL + NOISE RISER ON ${outDeckName}...`;

        // Layer 1: HPF Sweep on outgoing
        applyDeckEQ(outDeckNum, 'low', -18);
        const sweepStart = performance.now();
        const sweepTimer = setInterval(() => {
          const el = (performance.now() - sweepStart) / buildDurMs;
          if (el >= 0.95) {
            clearInterval(sweepTimer);
            outFilter.value = 0;
            outDeck.setColorFilter(0);
          } else {
            const filterVal = Math.floor(el * 42);
            outFilter.value = filterVal;
            outDeck.setColorFilter(filterVal);
            if (el >= 0.70) {
              applyDeckEQ(outDeckNum, 'mid', -12 * ((el - 0.70) / 0.25));
              applyDeckEQ(outDeckNum, 'hi', -8 * ((el - 0.70) / 0.25));
            }
          }
        }, 40);

        // Layer 2: Loop Roll stutter (last 4 bars of build)
        const rollDelayMs = Math.max(0, buildDurMs - (4 * 4 * spb * 1000));
        setTimeout(() => {
          outDeck.triggerLoopRoll(outTrack.bpm, 4);
        }, rollDelayMs);

        // Layer 3: White Noise Riser (whole build duration)
        engine.triggerNoiseRiser(outTrack.bpm, buildBars);
      }, buildLeadMs);

      // Pre-Drop Silence Gap (1 beat before drop)
      const gapLeadMs = Math.max(0, waitMs - (spb * 1000));
      setTimeout(() => {
        transitionStatusBanner.textContent = `🤫 ANTICIPATION GAP...`;
        outDeck.cancelLoopRoll();
        outDeck.triggerPreDropGap(spb * 0.9);
      }, gapLeadMs);

      // THE DROP
      setTimeout(() => {
        clearInterval(hudInterval);
        phraseHud.classList.add('hidden');
        transitionStatusBanner.textContent = `💥 FESTIVAL DROP: ${inDeckName} FULL POWER!`;

        outDeck.cancelLoopRoll();
        outDeck.pause();
        outBtnPlay.classList.remove('playing');
        outBtnPlay.textContent = '▶ PLAY';
        resetDeckEQs(outDeckNum);
        outDeck.resetAllFX();
        outFilter.value = 0;
        outDeck.setColorFilter(0);

        crossfader.value = targetCf;
        engine.setCrossfader(targetCf, 'club');
        resetDeckEQs(inDeckNum);

        const introCue = getTrackIntroCue(inTrack);
        inDeck.audio.currentTime = introCue;

        engine.triggerDropImpact(inTrack.bpm);
        inDeck.play();
        inBtnPlay.classList.add('playing');
        inBtnPlay.textContent = '⏸ PAUSE';

        finishTransition(renderPromise);
      }, waitMs);
      return;
    }

    // TECHNIQUE 7: HARD CUT (INSTANT DOWNBEAT SNAP)
    if (effectiveTech === 'hard_cut') {
      setTimeout(() => {
        clearInterval(hudInterval);
        phraseHud.classList.add('hidden');
        transitionStatusBanner.textContent = `✂️ HARD CUT: INSTANT 0ms SNAP TO ${inDeckName}!`;

        // Instantly mute / pause and reset outgoing deck
        outDeck.pause();
        outBtnPlay.classList.remove('playing');
        outBtnPlay.textContent = '▶ PLAY';
        resetDeckEQs(outDeckNum);
        outDeck.resetAllFX();
        outFilter.value = 0;
        outDeck.setColorFilter(0);

        // Snap crossfader to target
        crossfader.value = targetCf;
        engine.setCrossfader(targetCf, 'club');

        // Incoming deck starts on the 1 with full punch
        resetDeckEQs(inDeckNum);
        const introCue = getTrackIntroCue(inTrack);
        inDeck.audio.currentTime = introCue;

        // Sub drop impact boom on beat 1 for punch
        engine.triggerDropImpact(inTrack.bpm);
        inDeck.play();
        inBtnPlay.classList.add('playing');
        inBtnPlay.textContent = '⏸ PAUSE';

        finishTransition(renderPromise);
      }, waitMs);
      return;
    }

    // ===================================================================
    // TECHNIQUE 8 (DEFAULT): PRO SEAMLESS BLEND
    // Research-backed imperceptible transition using multi-layer automation:
    //  - Quintic Smootherstep curves (6t^5 - 15t^4 + 10t^3) for zero-jerk EQ motion
    //  - Hi-first-in / Hi-last-out EQ management (hi-hats maintain rhythmic continuity)
    //  - 40% window Linkwitz-Riley equal-power bass crossover (no double-kick mud)
    //  - Gradual HPF washout on outgoing (35%-95% of transition)
    //  - Stem-aware vocal formant ducking to prevent vocal clashing
    //  - Subtle 3/4-beat echo tail on outgoing (from 75%) for spacious wash
    //  - Closed-loop PLL phase lock throughout
    // ===================================================================
    setTimeout(() => {
      clearInterval(hudInterval);
      phraseHud.classList.add('hidden');

      // ─── INITIAL EQ STATE ───
      // Incoming starts nearly inaudible (pro technique: hi-hats arrive first)
      applyDeckEQ(inDeckNum, 'low', -24);  // Bass KILLED (no double-kick mud)
      applyDeckEQ(inDeckNum, 'mid', -18);  // Melody/vocals invisible
      applyDeckEQ(inDeckNum, 'hi', -8);    // Subtle hat presence (first in!)
      // Outgoing stays at full 0 dB (natural, unprocessed)
      applyDeckEQ(outDeckNum, 'low', 0);
      applyDeckEQ(outDeckNum, 'mid', 0);
      applyDeckEQ(outDeckNum, 'hi', 0);

      // ─── VOCAL DUCKING ───
      const isVocalDuck = toggleVocalDuck ? toggleVocalDuck.checked : true;
      const useStems = toggleNeuralStems ? toggleNeuralStems.checked : false;

      // ─── TEMPO SYNC & PHASE-ALIGNED CUE ───
      const syncRate = outTrack.bpm / inTrack.bpm;
      inDeck.setPlaybackRate(syncRate);
      inPitchVal.textContent = `${((syncRate - 1) * 100).toFixed(1)}%`;

      const introCue = getTrackIntroCue(inTrack);
      const mPhase = getDeckPhase(outTrack, outDeck.audio.currentTime);
      const sPhase = getDeckPhase(inTrack, introCue);
      inDeck.audio.currentTime = sPhase.currentBeat + (mPhase.phase * sPhase.beatDuration);
      isTransitionPhaseLocked = true;

      inDeck.play();
      inBtnPlay.classList.add('playing');
      inBtnPlay.textContent = '⏸ PAUSE';

      const beatsTotal = bars * 4;
      const beatDurationMs = (60.0 / outTrack.bpm) * 1000;
      const totalTransMs = beatsTotal * beatDurationMs;

      const startTime = performance.now();
      let animFrameId = null;
      let echoEngaged = false;

      // ─── Quintic Smootherstep: 6t^5 - 15t^4 + 10t^3 ───
      // Smoother than cubic smoothstep: zero 1st AND 2nd derivatives at endpoints
      // This means EQ knobs DECELERATE smoothly at both ends of their travel
      const smootherstep = (t) => {
        const ct = Math.max(0.0, Math.min(1.0, t));
        return ct * ct * ct * (ct * (ct * 6 - 15) + 10);
      };

      function updateTransitionFrame() {
        if (!isTransitioning) return;
        const now = performance.now();
        const elapsed = now - startTime;
        const p = Math.min(1.0, elapsed / totalTransMs);

        // ═══════════════════════════════════════════════════
        // 1. CROSSFADER: Quintic S-Curve with Club Gain Curve
        // ═══════════════════════════════════════════════════
        const pSmooth = smootherstep(p);
        const cfVal = isDir1to2 ? (pSmooth * 100) : ((1.0 - pSmooth) * 100);
        crossfader.value = Math.round(cfVal);
        engine.setCrossfader(cfVal, 'club');

        // ═══════════════════════════════════════════════════
        // 2. CLOSED-LOOP PLL: Phase Lock with Tempo Ramp
        // ═══════════════════════════════════════════════════
        const baseRate = (tempoRamp && Math.abs(outTrack.bpm - inTrack.bpm) > 0.5)
          ? (syncRate + (1.0 - syncRate) * smootherstep(p))
          : syncRate;
        applyPhaseLockLoop(outDeck, outTrack, inDeck, inTrack, baseRate);

        // ═══════════════════════════════════════════════════
        // 3. INCOMING DECK: 3-Band EQ Sculpting
        // ═══════════════════════════════════════════════════

        // ─── INCOMING HIGHS (First in! Hi-hats arrive earliest) ───
        // -8dB → 0dB over p: 0.00 → 0.25 (bars 1-8 of a 32-bar blend)
        let inHi;
        if (p < 0.05) {
          inHi = -8.0 + (3.0 * smootherstep(p / 0.05));  // -8 → -5
        } else if (p < 0.25) {
          inHi = -5.0 + (5.0 * smootherstep((p - 0.05) / 0.20));  // -5 → 0
        } else {
          inHi = 0.0;
        }
        applyDeckEQ(inDeckNum, 'hi', inHi);

        // ─── INCOMING MIDS (Melody/vocals arrive gradually, avoiding clash) ───
        // -18dB → -10dB (p: 0-0.20), -10 → -4dB (p: 0.20-0.40), -4 → 0dB (p: 0.40-0.60)
        let inMid;
        if (p < 0.20) {
          inMid = -18.0 + (8.0 * smootherstep(p / 0.20));   // -18 → -10
        } else if (p < 0.40) {
          inMid = -10.0 + (6.0 * smootherstep((p - 0.20) / 0.20));  // -10 → -4
        } else if (p < 0.60) {
          inMid = -4.0 + (4.0 * smootherstep((p - 0.40) / 0.20));   // -4 → 0
        } else {
          inMid = 0.0;
        }
        applyDeckEQ(inDeckNum, 'mid', inMid);

        // ─── INCOMING LOWS (Bass KILLED until Linkwitz-Riley crossover zone) ───
        // -24dB → -18dB warmup (p: 0-0.28), then equal-power sin() swap (0.28-0.72), then 0dB
        let inLow;
        if (p < 0.28) {
          inLow = -24.0 + (6.0 * smootherstep(p / 0.28));  // sub warmth only
        } else if (p < 0.72) {
          const k = (p - 0.28) / 0.44;  // 0→1 across 44% of transition (wider = smoother)
          const inGain = Math.sin(k * Math.PI * 0.5);  // equal-power rise
          inLow = -18.0 + (18.0 * inGain);
        } else {
          inLow = 0.0;
        }
        applyDeckEQ(inDeckNum, 'low', inLow);

        // ═══════════════════════════════════════════════════
        // 4. OUTGOING DECK: 3-Band EQ Sculpting
        // ═══════════════════════════════════════════════════

        // ─── OUTGOING LOWS (Bass exits via Linkwitz-Riley equal-power cos() decay) ───
        let outLow;
        if (p < 0.28) {
          outLow = 0.0;
        } else if (p < 0.72) {
          const k = (p - 0.28) / 0.44;
          const outGain = Math.cos(k * Math.PI * 0.5);
          outLow = -24.0 * (1.0 - outGain);
        } else {
          outLow = -24.0;
        }
        applyDeckEQ(outDeckNum, 'low', outLow);

        // ─── OUTGOING MIDS (Duck gradually to avoid vocal clash, then dissolve) ───
        // Hold 0dB until p=0.25, duck to -6dB by p=0.50, dissolve to -24dB by p=0.85
        let outMid;
        if (p < 0.25) {
          outMid = 0.0;
        } else if (p < 0.50) {
          outMid = 0.0 - (6.0 * smootherstep((p - 0.25) / 0.25));
        } else if (p < 0.85) {
          outMid = -6.0 - (18.0 * smootherstep((p - 0.50) / 0.35));
        } else {
          outMid = -24.0;
        }
        applyDeckEQ(outDeckNum, 'mid', outMid);

        // ─── OUTGOING HIGHS (Last out! Hats maintain rhythmic continuity longest) ───
        // Hold 0dB until p=0.35, slowly dissolve to -24dB by p=0.92
        let outHi;
        if (p < 0.35) {
          outHi = 0.0;
        } else if (p < 0.92) {
          outHi = 0.0 - (24.0 * smootherstep((p - 0.35) / 0.57));
        } else {
          outHi = -24.0;
        }
        applyDeckEQ(outDeckNum, 'hi', outHi);

        // ═══════════════════════════════════════════════════
        // 5. HPF WASHOUT ON OUTGOING DECK
        // Pro DJs sweep HPF from 20Hz → 1.5kHz to naturally thin out outgoing track
        // Active from p=0.35 → p=0.95 (long, gradual, imperceptible)
        // ═══════════════════════════════════════════════════
        if (p >= 0.35 && p < 0.95) {
          const hpfProgress = smootherstep((p - 0.35) / 0.60);
          const filterVal = Math.floor(hpfProgress * 35);
          outFilter.value = filterVal;
          outDeck.setColorFilter(filterVal);
        } else if (p >= 0.95 && outFilter.value != 0) {
          outFilter.value = 0;
          outDeck.setColorFilter(0);
        }

        // ═══════════════════════════════════════════════════
        // 6. STEM-AWARE VOCAL DUCKING
        // If Neural Stems is on, progressively duck outgoing deck's vocal band
        // to prevent the cardinal sin of vocal clashing
        // ═══════════════════════════════════════════════════
        if (useStems && p > 0.25 && p < 0.75) {
          const duckAmount = -8.0 * smootherstep((p - 0.25) / 0.25);
          outDeck.duckMids(duckAmount, 0.15);
        } else if (isVocalDuck && p > 0.20 && p < 0.80) {
          const duckAmount = -5.0 * smootherstep((p - 0.20) / 0.20);
          outDeck.duckMids(duckAmount, 0.15);
        }

        // ═══════════════════════════════════════════════════
        // 7. SUBTLE ECHO TAIL ON OUTGOING DECK
        // At 75% progress, engage a 3/4-beat delay wash to create spacious dissolve
        // This fills the perceptual gap as the outgoing track thins
        // ═══════════════════════════════════════════════════
        if (p >= 0.75 && !echoEngaged) {
          echoEngaged = true;
          outDeck.engageSubtleEcho(outTrack.bpm, 0.30);
        }

        // ═══════════════════════════════════════════════════
        // 8. REAL-TIME STATUS HUD
        // ═══════════════════════════════════════════════════
        const currentBar = Math.floor(p * bars) + 1;
        if (p < 0.15) {
          transitionStatusBanner.textContent = `🎧 SEAMLESS BLEND: INTRODUCING ${inDeckName} AMBIENCE (BAR ${currentBar}/${bars})...`;
        } else if (p < 0.28) {
          transitionStatusBanner.textContent = `🎵 SEAMLESS BLEND: ${inDeckName} HATS & GROOVE WARMING (BAR ${currentBar}/${bars})...`;
        } else if (p < 0.72) {
          transitionStatusBanner.textContent = `💥 SEAMLESS BLEND: EQUAL-POWER BASS HANDOFF (BAR ${currentBar}/${bars})!`;
        } else if (p < 0.92) {
          transitionStatusBanner.textContent = `🎚️ SEAMLESS BLEND: ${outDeckName} DISSOLVING + ECHO WASH (BAR ${currentBar}/${bars})...`;
        } else {
          transitionStatusBanner.textContent = `✨ SEAMLESS BLEND: ${inDeckName} TAKING FULL CONTROL...`;
        }

        // ═══════════════════════════════════════════════════
        // 9. FRAME LOOP OR COMPLETION
        // ═══════════════════════════════════════════════════
        if (p < 1.0) {
          animFrameId = requestAnimationFrame(updateTransitionFrame);
        } else {
          // ─── CLEAN TEARDOWN ───
          if (isVocalDuck || useStems) {
            outDeck.unduckMids();
          }
          if (echoEngaged) {
            outDeck.disengageSubtleEcho(2.0);
          }

          resetDeckEQs(outDeckNum);
          outFilter.value = 0;
          outDeck.setColorFilter(0);

          outDeck.pause();
          outBtnPlay.classList.remove('playing');
          outBtnPlay.textContent = '▶ PLAY';

          inDeck.setPlaybackRate(1.0);
          inPitchVal.textContent = '0.0%';

          resetDeckEQs(inDeckNum);

          isTransitionPhaseLocked = false;
          if (phaseCursor && phaseStatus) {
            phaseCursor.style.left = '50%';
            phaseCursor.className = 'phase-cursor locked';
            phaseStatus.className = 'phase-status';
            phaseStatus.textContent = '±0.0 ms (STANDBY)';
          }

          finishTransition(renderPromise);
        }
      }

      animFrameId = requestAnimationFrame(updateTransitionFrame);
    }, waitMs);
  });

  function finishTransition(renderPromise) {
    isTransitioning = false;
    isTransitionPhaseLocked = false;
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

    // Ensure live deck has pristine neutral EQs
    resetDeckEQs(liveDeckNum);

    // Reset both decks' FX, filters, and volume to pristine neutral state
    const outDeckRef = (transitionDirection === '1_to_2') ? engine.deck1 : engine.deck2;
    const outDeckFilterEl = (transitionDirection === '1_to_2') ? document.getElementById('d1-filter') : document.getElementById('d2-filter');
    const outVolFader = (transitionDirection === '1_to_2') ? document.getElementById('d1-vol-fader') : document.getElementById('d2-vol-fader');
    outDeckRef.resetAllFX();
    outDeckRef.setVolume(100);
    if (outDeckFilterEl) { outDeckFilterEl.value = 0; }
    if (outVolFader) { outVolFader.value = 100; }
    resetDeckEQs(liveDeckNum === 1 ? 2 : 1);

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
      <div class="stat-item"><span class="lbl">TOTAL RUNTIME</span><span class="val">${formatTime(mix.total_duration)}</span></div>
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
      form.append('direction', transitionDirection);
      form.append('technique', effectiveTech);
      form.append('bars', bars);
      form.append('tempo_ramp', tempoRamp);
      form.append('harmonic_lock', harmonicLock);
      form.append('use_stems', neuralStems);
      form.append('cue_1', isDir1to2 ? (engine.deck1.audio.currentTime || track1Data.suggested_cue_outro) : track1Data.suggested_cue_intro);
      form.append('cue_2', isDir1to2 ? track2Data.suggested_cue_intro : (engine.deck2.audio.currentTime || track2Data.suggested_cue_outro));

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
  function loop(currentTime) {
    const dt = (currentTime - lastTime) / 1000;
    lastTime = currentTime;

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

    // Live Phase Monitoring & Closed-Loop Real-Time SYNC PLL
    if (!isTransitioning && track1Data && track2Data) {
      if (engine.deck1.isPlaying && engine.deck2.isPlaying) {
        if (isDeck2SyncLocked) {
          const baseRate = track1Data.bpm / track2Data.bpm;
          applyPhaseLockLoop(engine.deck1, track1Data, engine.deck2, track2Data, baseRate);
        } else if (isDeck1SyncLocked) {
          const baseRate = track2Data.bpm / track1Data.bpm;
          applyPhaseLockLoop(engine.deck2, track2Data, engine.deck1, track1Data, baseRate);
        } else {
          // Passive Telemetry (Manual DJing)
          const err = computePhaseError(track1Data, engine.deck1.audio.currentTime, track2Data, engine.deck2.audio.currentTime);
          updatePhaseMeterHUD(err.errorMs);
        }
      } else if (phaseStatus && !isDeck1SyncLocked && !isDeck2SyncLocked) {
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

      case 'ArrowLeft': // Crossfader hard left
        e.preventDefault();
        crossfader.value = 0;
        crossfader.dispatchEvent(new Event('input'));
        flashButton('#crossfader');
        break;

      case 'ArrowDown': // Crossfader center (50%)
        e.preventDefault();
        crossfader.value = 50;
        crossfader.dispatchEvent(new Event('input'));
        flashButton('#crossfader');
        break;

      case 'ArrowRight': // Crossfader hard right
        e.preventDefault();
        crossfader.value = 100;
        crossfader.dispatchEvent(new Event('input'));
        flashButton('#crossfader');
        break;

      case 'Equal': // Waveform Zoom In (+)
      case 'NumpadAdd':
        e.preventDefault();
        flashButton('#btn-zoom-in');
        btnZoomIn.click();
        break;

      case 'Minus': // Waveform Zoom Out (-)
      case 'NumpadSubtract':
        e.preventDefault();
        flashButton('#btn-zoom-out');
        btnZoomOut.click();
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
