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
  let zoomLevel = 1.0;
  let currentAIRec = null;
  let serverHasJev = false;
  let serverHasGemini = false;

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
    const savedModel = localStorage.getItem('ai_dj_model') || 'jev-latest';
    // Saved choices of retired Gemini models (1.5 / 2.x) move to the current Flash model
    aiModelSelect.value = savedModel.startsWith('gemini-') ? 'gemini-3.8-flash' : savedModel;
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
    // Crossfader remains permanently centered at 50%
    if (crossfader) crossfader.value = 50;
    engine.setCrossfader(50, 'club');

    transitionStatusBanner.textContent = `MIX FLOW: ${dir === '1_to_2' ? 'DECK 1 ➔ DECK 2' : 'DECK 2 ➔ DECK 1'}`;
    updateHarmonicCompatibility();
    updateAIRecCard();
    fetchAIStrategy();
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

    // 3. The deck already decodes the file once (loadTrackIntoDeck): reuse it for the RGB waveform
    try {
      const targetDeck = (deckNum === 1) ? engine.deck1 : engine.deck2;
      targetDeck.audio.loaded.then((audioBuffer) => {
        try {
          if (!audioBuffer) return;
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
          console.warn('Client-side waveform error (using acoustic synthesizer):', decErr);
        }
      });
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
          currentTrack.file_id = sTrack.file_id || currentTrack.file_id;
          ['grid', 'phrase_32_times', 'drop_times', 'section_boundaries', 'section_map',
           'bar_low_db', 'loudness_db'].forEach(k => {
            if (sTrack[k]) currentTrack[k] = sTrack[k];
          });
          currentTrack.hot_cues = computeTrackHotCues(currentTrack);
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
          prefetchIncoming();
        }
      }
    } catch (err) {
      console.warn('Server background analysis failed, local playback remains active:', err);
      transitionStatusBanner.textContent = `${deckName}: READY FOR LIVE MIXING (LOCAL MODE)`;
    }
  }

  // ═══════════════════════════════════════════════════
  // PRO DJ HOT CUES: Automatic 4-Point Detection
  // ═══════════════════════════════════════════════════
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
  function loadTrackIntoDeck(deckNum, track) {
    resetDeckEQs(deckNum);
    track.hot_cues = computeTrackHotCues(track);

    // Update Hot Cue buttons title/tooltip with exact timestamps
    const cueLabels = ['INTRO', 'VERSE', 'MAIN DROP', 'OUTRO'];
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
    prefetchIncoming();
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
            jevKeyInput.placeholder = '✓ Active via Render Environment Variable (Ready)';
          }
        }
        if (data.gemini_configured || data.has_gemini) {
          serverHasGemini = true;
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
          aiModelSelect.value = data.jev_configured ? 'jev-latest' : (data.gemini_configured ? 'gemini-3.8-flash' : 'local');
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

  // ═══════════════════════════════════════════════════
  // JEV AUTONOMOUS DJ BRAIN: Client-Side Audio Profiling
  // ═══════════════════════════════════════════════════
  function profileTrackForJev(deckNum) {
    const trackData = (deckNum === 1) ? track1Data : track2Data;
    const deck = (deckNum === 1) ? engine.deck1 : engine.deck2;
    if (!trackData) return null;

    // Base profile from server analysis cache
    const profile = {
      title: trackData.title || trackData.filename || `Deck ${deckNum}`,
      bpm: trackData.bpm || 128.0,
      camelot: trackData.camelot || '8A',
      key: trackData.key || 'Unknown',
      duration: trackData.duration || 180.0,
      current_position: deck.audio.currentTime || 0.0,
      hot_cues: trackData.hot_cues || computeTrackHotCues(trackData),
    };

    // Extract spectral energy from pre-computed waveform bins
    const wf = trackData.waveform;
    if (wf && wf.low && wf.mid && wf.high && wf.low.length > 0) {
      const pos = deck.audio.currentTime || 0;
      const dur = trackData.duration || 180;
      const totalBins = wf.low.length;
      // Analyze a window around current position (±15 seconds)
      const windowSec = 15;
      const startSec = Math.max(0, pos - windowSec);
      const endSec = Math.min(dur, pos + windowSec);
      const startBin = Math.floor((startSec / dur) * totalBins);
      const endBin = Math.min(totalBins, Math.ceil((endSec / dur) * totalBins));
      const count = Math.max(1, endBin - startBin);

      let sumLow = 0, sumMid = 0, sumHigh = 0, peaks = 0;
      let prevVal = 0;
      for (let i = startBin; i < endBin; i++) {
        sumLow += wf.low[i];
        sumMid += wf.mid[i];
        sumHigh += wf.high[i];
        // Count transient peaks (sharp rises > 0.3)
        const overall = (wf.overall ? wf.overall[i] : (wf.low[i] + wf.mid[i] + wf.high[i]) / 3);
        if (overall - prevVal > 0.3) peaks++;
        prevVal = overall;
      }

      profile.energy_low = Math.round((sumLow / count) * 1000) / 1000;
      profile.energy_mid = Math.round((sumMid / count) * 1000) / 1000;
      profile.energy_high = Math.round((sumHigh / count) * 1000) / 1000;

      const totalEnergy = profile.energy_low + profile.energy_mid + profile.energy_high;
      profile.spectral_centroid = totalEnergy > 0
        ? Math.round((profile.energy_high / totalEnergy) * 1000) / 1000
        : 0.33;

      // Transient density: peaks per second in the analysis window
      const windowDuration = endSec - startSec;
      profile.transient_density = windowDuration > 0
        ? Math.round((peaks / windowDuration) * 100) / 100
        : 0.5;

      // Energy trajectory: compare first half vs second half of window
      const midBin = Math.floor((startBin + endBin) / 2);
      let firstHalf = 0, secondHalf = 0;
      for (let i = startBin; i < midBin; i++) {
        firstHalf += (wf.overall ? wf.overall[i] : (wf.low[i] + wf.mid[i] + wf.high[i]) / 3);
      }
      for (let i = midBin; i < endBin; i++) {
        secondHalf += (wf.overall ? wf.overall[i] : (wf.low[i] + wf.mid[i] + wf.high[i]) / 3);
      }
      const halfCount = Math.max(1, midBin - startBin);
      const avgFirst = firstHalf / halfCount;
      const avgSecond = secondHalf / Math.max(1, endBin - midBin);
      if (avgSecond > avgFirst * 1.15) profile.energy_trajectory = 'building';
      else if (avgFirst > avgSecond * 1.15) profile.energy_trajectory = 'dropping';
      else profile.energy_trajectory = 'sustain';
    } else {
      profile.energy_low = 0.5;
      profile.energy_mid = 0.5;
      profile.energy_high = 0.5;
      profile.spectral_centroid = 0.33;
      profile.transient_density = 0.5;
      profile.energy_trajectory = 'sustain';
    }

    // Vocal presence from server acoustic profile
    const ap = trackData.acoustic_profile || {};
    profile.vocal_presence = Math.max(
      parseFloat(ap.intro_vocal_score || 0),
      parseFloat(ap.outro_vocal_score || 0)
    );

    // Phrase position
    if (profile.bpm > 0) {
      const beatLen = 60.0 / profile.bpm;
      const currentBeat = profile.current_position / beatLen;
      profile.phrase_position = Math.floor(currentBeat % 16);
    } else {
      profile.phrase_position = 0;
    }

    return profile;
  }

  // ═══════════════════════════════════════════════════
  // JEV BLUEPRINT: Effect Trigger Manager
  // ═══════════════════════════════════════════════════
  function triggerBlueprintEffects(bp, p, fxState, outDeck, inDeck, outTrack) {
    const fx = bp.effects;
    const bpm = outTrack.bpm || bp.meta.bpm || 128;

    // Echo wash
    if (fx.echo_wash && p >= fx.echo_wash.engage_at && !fxState.echoEngaged) {
      fxState.echoEngaged = true;
      const spb = 60.0 / bpm;
      outDeck.engageSubtleEcho(bpm, fx.echo_wash.wet_level);
      // Override delay and feedback with Jev-specified values
      const now = outDeck.ctx.currentTime;
      outDeck.delayNode.delayTime.setValueAtTime(spb * fx.echo_wash.delay_beats, now);
      outDeck.delayFeedback.gain.cancelScheduledValues(now);
      outDeck.delayFeedback.gain.setValueAtTime(fx.echo_wash.feedback, now);
    }

    // Vocal ducking
    if (fx.vocal_ducking) {
      if (p >= fx.vocal_ducking.start_at && p < fx.vocal_ducking.end_at) {
        const duckProgress = Math.min(1, (p - fx.vocal_ducking.start_at) / 0.15);
        const duckDb = fx.vocal_ducking.duck_db * duckProgress;
        outDeck.duckMids(duckDb, 0.1);
        fxState.vocalDucked = true;
      } else if (fxState.vocalDucked && p >= fx.vocal_ducking.end_at) {
        outDeck.unduckMids();
        fxState.vocalDucked = false;
      }
    }

    // Loop roll
    if (fx.loop_roll && p >= fx.loop_roll.start_at && !fxState.loopRollStarted) {
      fxState.loopRollStarted = true;
      outDeck.triggerLoopRoll(bpm, fx.loop_roll.total_bars);
    }

    // Noise riser
    if (fx.noise_riser && p >= fx.noise_riser.start_at && !fxState.noiseRiserStarted) {
      fxState.noiseRiserStarted = true;
      engine.triggerNoiseRiser(bpm, fx.noise_riser.bars);
    }

    // Pre-drop gap
    if (fx.predrop_gap && p >= fx.predrop_gap.trigger_at && !fxState.predropGapTriggered) {
      fxState.predropGapTriggered = true;
      const gapSec = (60.0 / bpm) * fx.predrop_gap.duration_beats;
      outDeck.triggerPreDropGap(gapSec);
      inDeck.triggerPreDropGap(gapSec);
    }

    // Drop impact
    if (fx.drop_impact && p >= fx.drop_impact.trigger_at && !fxState.dropImpactTriggered) {
      fxState.dropImpactTriggered = true;
      if (fx.drop_impact.style !== 'silent_drop') {
        engine.triggerDropImpact(bpm);
      }
    }

    // Vinyl brake
    if (fx.vinyl_brake && p >= fx.vinyl_brake.start_at && !fxState.vinylBrakeStarted) {
      fxState.vinylBrakeStarted = true;
      const dur = fx.vinyl_brake.duration_sec;
      const startRate = outDeck.audio.playbackRate;
      const brakeStart = performance.now();
      function brakeFrame() {
        if (!fxState.vinylBrakeStarted) return;
        const elapsed = (performance.now() - brakeStart) / 1000;
        const brkProgress = Math.min(1, elapsed / dur);
        outDeck.setPlaybackRate(startRate * (1 - brkProgress * 0.95));
        if (brkProgress < 1) requestAnimationFrame(brakeFrame);
      }
      requestAnimationFrame(brakeFrame);
    }

    // 4-Stem Isolation Mashup
    if (fx.stem_mashup && p >= fx.stem_mashup.switch_at && !fxState.stemsSwitched) {
      fxState.stemsSwitched = true;
      if (fx.stem_mashup.outgoing_mute === 'bass_first') {
        outDeck.setStemLevels({ bass: 0.001, vocals: 1.0, drums: 1.0, other: 1.0 }, 0.08);
      } else if (fx.stem_mashup.outgoing_mute === 'vocals_first') {
        outDeck.setStemLevels({ vocals: 0.001, bass: 1.0, drums: 1.0, other: 1.0 }, 0.08);
      }

      if (fx.stem_mashup.incoming_focus === 'drums_first') {
        inDeck.setStemLevels({ drums: 1.0, bass: 0.001, vocals: 0.001, other: 0.001 }, 0.08);
      } else if (fx.stem_mashup.incoming_focus === 'vocals_first') {
        inDeck.setStemLevels({ vocals: 1.0, drums: 0.001, bass: 0.001, other: 0.001 }, 0.08);
      } else if (fx.stem_mashup.incoming_focus === 'bass_and_drums') {
        inDeck.setStemLevels({ drums: 1.0, bass: 1.0, vocals: 0.001, other: 0.001 }, 0.08);
      }
    }

    // Resonant LFO Flanger Sweep
    if (fx.flanger && p >= fx.flanger.start_at && !fxState.flangerEngaged) {
      fxState.flangerEngaged = true;
      outDeck.engageFlanger(fx.flanger.speed, fx.flanger.depth, 0.55, fx.flanger.wet);
    }

    // Beat-Synced Masher Stutter
    if (fx.beat_masher && p >= fx.beat_masher.start_at && !fxState.beatMasherStarted) {
      fxState.beatMasherStarted = true;
      outDeck.triggerBeatMasher(bpm, fx.beat_masher.division, fx.beat_masher.bars);
    }

    // Turntable Pitch Bend
    if (fx.pitch_bend && p >= fx.pitch_bend.start_at && !fxState.pitchBendStarted) {
      fxState.pitchBendStarted = true;
      outDeck.triggerPitchBend(fx.pitch_bend.semitones, 2.0, fx.pitch_bend.style);
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
    const model = aiModelSelect ? aiModelSelect.value : (localStorage.getItem('ai_dj_model') || 'jev-latest');
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
      let when = null, startPos = null;
      if (isDeck1SyncLocked && engine.deck2.isPlaying && track1Data && track2Data) {
        when = engine.ctx.currentTime + 0.05;
        startPos = alignedPosition(engine.deck2, track2Data, engine.deck1, track1Data, when);
      }
      try {
        await engine.deck1.play(when, startPos);
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
      let when = null, startPos = null;
      if (isDeck2SyncLocked && engine.deck1.isPlaying && track1Data && track2Data) {
        when = engine.ctx.currentTime + 0.05;
        startPos = alignedPosition(engine.deck1, track1Data, engine.deck2, track2Data, when);
      }
      try {
        await engine.deck2.play(when, startPos);
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

  /** SYNC: match the other deck's effective tempo exactly, then snap phase on the audio clock. */
  function engageSync(slaveNum) {
    const slaveDeck = (slaveNum === 1) ? engine.deck1 : engine.deck2;
    const masterDeck = (slaveNum === 1) ? engine.deck2 : engine.deck1;
    const slaveTrack = (slaveNum === 1) ? track1Data : track2Data;
    const masterTrack = (slaveNum === 1) ? track2Data : track1Data;
    const rate = MixPlanner.deckBpm(masterTrack, masterDeck) / (slaveTrack.bpm * slaveDeck.audio.tempoRatio);
    slaveDeck.setPlaybackRate(rate);
    setPitchReadout(slaveNum);
    if (masterDeck.isPlaying && slaveDeck.isPlaying) {
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
  });
  d2TempoFader.addEventListener('input', (e) => {
    if (isDeck2SyncLocked) {
      isDeck2SyncLocked = false;
      d2BtnSync.classList.remove('active');
    }
    const pct = parseFloat(e.target.value);
    engine.deck2.setPlaybackRate(1 + (pct / 100));
    setPitchReadout(2);
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

  // Faders & Headphone Cue (PFL) Buttons
  d1VolFader.addEventListener('input', (e) => engine.deck1.setVolume(parseFloat(e.target.value)));
  d2VolFader.addEventListener('input', (e) => engine.deck2.setVolume(parseFloat(e.target.value)));
  crossfader.addEventListener('input', (e) => engine.setCrossfader(parseFloat(e.target.value)));

  const d1BtnPfl = document.getElementById('d1-btn-pfl');
  const d2BtnPfl = document.getElementById('d2-btn-pfl');
  const aiAuditionMonitor = document.getElementById('ai-audition-monitor');
  const auditionBadge = document.getElementById('audition-badge');
  const auditionMeterFill = document.getElementById('audition-meter-fill');
  const auditionFeedbackText = document.getElementById('audition-feedback-text');

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

            const cueLabels = ['INTRO', 'VERSE', 'MAIN DROP', 'OUTRO'];
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
      btn.addEventListener('click', async () => {
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
              shift_beats: parseInt(btn.dataset.shiftBeats || 0, 10),
              shift_bars: parseInt(btn.dataset.shiftBars || 0, 10),
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
    btn.textContent = playing ? '⏸ PAUSE' : '▶ PLAY';
  }

  function atCtx(t, ctxTime, fn) {
    t.timers.push(setTimeout(fn, Math.max(0, (ctxTime - engine.ctx.currentTime) * 1000)));
  }

  function clearTransitionTimers(t) {
    t.timers.forEach(clearTimeout);
    t.intervals.forEach(clearInterval);
  }

  /** Optional AI blueprint. Never blocks: used only if it arrives before the planned start. */
  function requestBlueprint(t, timeoutMs) {
    const profileOut = profileTrackForJev(t.outDeckNum);
    const profileIn = profileTrackForJev(t.inDeckNum);
    if (!profileOut || !profileIn) return Promise.resolve(null);
    const cueTime = t.plan.inStartNative;
    const payload = {
      profile_out: profileOut,
      profile_in: profileIn,
      audio_clip_b64: t.inDeck.sliceAuditionWavBase64(cueTime, 10.0, 16000),
      audio_mime: 'audio/wav',
      file_id_in: t.inTrack.file_id,
      cue_time: cueTime,
    };
    const jevKey = jevKeyInput ? jevKeyInput.value.trim() : '';
    const geminiKey = geminiKeyInput ? geminiKeyInput.value.trim() : '';
    if (jevKey) payload.jev_api_key = jevKey;
    if (geminiKey) payload.gemini_api_key = geminiKey;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), timeoutMs);
    return fetch('/api/jev-blueprint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        const bp = d && d.status === 'success' ? d.blueprint : null;
        if (bp && bp.meta && bp.meta.audition_heard && auditionFeedbackText) {
          auditionFeedbackText.textContent = `🎧 HEARD: ${bp.meta.audition_heard}`;
        }
        return bp && bp.keyframes ? bp : null;
      })
      .catch(() => null);
  }

  btnTriggerTransition.addEventListener('click', () => {
    unlockAudio();
    if (!track1Data || !track2Data) {
      alert('Please load both Deck 1 and Deck 2 first!');
      return;
    }
    if (isTransitioning) return;

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
    const leadIn = {
      vinyl_brake: 2, spinback: 3, noise_riser: 16, loop_roll: 4 * Math.min(bars, 4),
      festival_drop: 4 * Math.min(bars, 8),
    }[tech] || 0;  // beats of outgoing FX before the drop
    const beatSecNow = 60 / MixPlanner.deckBpm(t.outTrack, t.outDeck);
    t.plan = MixPlanner.plan(t.outTrack, t.outDeck, t.inTrack, bars, {
      now: engine.ctx.currentTime,
      leadSec: t.blend ? 3.0 : leadIn * beatSecNow + 1.0,
      blend: t.blend,
      keyClash: !camelotCompatible(t.outTrack.camelot, t.inTrack.camelot),
      phraseLock: togglePhraseLock ? togglePhraseLock.checked : true,
    });
    t.leadInSec = leadIn * t.plan.beatSec;
    if (!t.inTrack.grid || !t.outTrack.grid) console.warn('Beat grid not analyzed yet: using an estimated grid');

    // Incoming at the master tempo, keylocked (usually prefetched already)
    t.bufferPromise = (t.blend && Math.abs(t.plan.tempoRatio - 1) >= 0.0005)
      ? stretchedBuffer(t.inTrack, t.plan.tempoRatio)
      : Promise.resolve(null);

    // AI blueprint runs in parallel with the countdown and is dropped if it's late
    t.blueprint = null;
    const hasAIEngine = Boolean(serverHasJev || serverHasGemini ||
      (jevKeyInput && jevKeyInput.value.trim()) || (geminiKeyInput && geminiKeyInput.value.trim()));
    const budgetMs = (t.plan.startCtx - engine.ctx.currentTime - 1.0) * 1000;
    if (t.blend && hasAIEngine && (selectedTechnique === 'auto' || selectedTechnique === 'bass_swap') && budgetMs > 1500) {
      requestBlueprint(t, budgetMs).then(bp => { if (activeTransition === t) t.blueprint = bp; });
    }

    // No automatic server export during a live set (it competes with analysis/stretching for a
    // small instance's memory). The Export button renders this transition on demand.
    t.renderPromise = Promise.resolve(null);
    lastRenderedMix = null;
    lastTransitionCues = {
      direction: transitionDirection,
      technique: tech,
      bars: t.plan.bars,
      cue_1: isDir1to2 ? t.plan.exitNative : t.plan.inStartNative,
      cue_2: isDir1to2 ? t.plan.inStartNative : t.plan.exitNative,
    };

    startTransitionHud(t);
    // Arm shortly before the first outgoing FX (or the start): from then on it's all scheduled
    atCtx(t, t.plan.startCtx - t.leadInSec - 0.4, () => armTransition(t));
  });

  function startTransitionHud(t) {
    const p = t.plan;
    const total0 = Math.max(0.001, p.startCtx - engine.ctx.currentTime);
    const label = t.blend ? `${p.bars}-BAR BLEND` : t.tech.toUpperCase().replace(/_/g, ' ');
    phraseHud.classList.remove('hidden');
    t.intervals.push(setInterval(() => {
      const remain = p.startCtx - engine.ctx.currentTime;
      if (remain > 0) {
        const beats = remain / p.beatSec;
        phraseHudCounter.textContent = `IN ON THE 1: ${Math.floor(beats / 4)} BARS (${Math.floor(beats % 4) + 1}/4)`;
        phraseHudProgress.style.width = `${(100 * (1 - remain / total0)).toFixed(1)}%`;
        transitionStatusBanner.textContent = `🎯 ${label} → ${t.inName} IN ${remain.toFixed(1)}s ` +
          `@ ${p.masterBpm.toFixed(2)} BPM${p.vocalClash ? ' (VOCAL CLASH: MIDS SWAP WITH BASS)' : ''}`;
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
            `🎚️ ${t.blueprint ? 'AI BLUEPRINT' : 'BLEND'} BAR ${bar}/${total}: ${stage}`;
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
    if (t.blend) runBlend(t); else runCut(t);
  }

  function runBlend(t) {
    const p = t.plan;
    const T = p.startCtx;
    t.inDeck.play(T, p.inStartNative);
    t.marks = t.blueprint
      ? MixPlanner.scheduleBlueprint(t.blueprint, p, t.outDeck, t.inDeck)
      : MixPlanner.scheduleBlend(p, t.outDeck, t.inDeck);
    atCtx(t, T, () => setPlayUI(t.inBtnPlay, true));
    if (t.blueprint) {
      // Effects that bend the outgoing deck's speed would pull it off the grid mid-overlap
      ['vinyl_brake', 'pitch_bend'].forEach(k => { if (t.blueprint.effects) delete t.blueprint.effects[k]; });
      const fxState = {};
      t.intervals.push(setInterval(() => {
        const prog = (engine.ctx.currentTime - T) / p.blendSec;
        if (prog >= 0 && prog <= 1) triggerBlueprintEffects(t.blueprint, prog, fxState, t.outDeck, t.inDeck, t.outTrack);
      }, 25));
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
    inDeck.play(T, getTrackIntroCue(t.inTrack));
    let cutTime = T;
    let tail = 0.1;

    if (t.tech === 'echo_freeze') {
      atCtx(t, T, () => {
        applyDeckEQ(outDeckNum, 'low', -24);
        applyDeckEQ(outDeckNum, 'mid', -6);
        outDeck.triggerEchoFreeze(bpm, 4.5);
      });
      cutTime = null;  // the echo freeze gates the dry signal itself
      tail = 5.0;
    } else if (t.tech === 'vinyl_brake') {
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
    }, 40);
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
