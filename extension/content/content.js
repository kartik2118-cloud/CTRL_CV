/**
 * LiveSub — Content Script Overlay Spike
 * Role A: Minimal working subtitle overlay & controls attached inside YouTube's #movie_player.
 *
 * Phases implemented:
 * - Phase 1: Subtitle overlay, Shadow DOM, dual-row, textContent, Indian font support
 * - Phase 2: Collapsible controls (font size slider, color picker, position top/bottom, demo/clear)
 * - Phase 3: SPA navigation detection, instant subtitle reset on video change/exit, deduplication
 * - Phase 4: Integration messaging contract for Role D (showSubtitle, clearSubtitle, updateStyle)
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const OVERLAY_HOST_ID = 'livesub-overlay-host';
const CONTROLS_PANEL_ID = 'livesub-controls-panel';
const PLAYER_SELECTOR = '#movie_player, .html5-video-player, ytd-player, #shorts-player, ytd-shorts';

function getPlayerElement(allowBodyFallback = false) {
  const player = document.querySelector(PLAYER_SELECTOR);
  if (player) return player;
  const videoParent = document.querySelector('video')?.parentElement;
  if (videoParent) return videoParent;
  return allowBodyFallback ? document.body : null;
}

const POLL_INTERVAL_MS = 400;
const MAX_POLL_ATTEMPTS = 30; // 12 seconds total

// Language support & sequential demo steps
const DEMO_SEQUENCES = {
  hindi: [
    { text: 'नमस्ते! LiveSub में आपका स्वागत है।', translation: 'Welcome to LiveSub real-time transcription.', lang: 'HI / EN', duration: 2800 },
    { text: 'यह तकनीक स्वचालित रूप से भाषा पहचानती है।', translation: 'This technology automatically detects and translates speech.', lang: 'HI / EN', duration: 2800 },
    { text: 'आज हम स्वादिष्ट पनीर टिक्का रेसिपी देखेंगे।', translation: 'Today we will explore a delicious paneer tikka recipe.', lang: 'HI / EN', duration: 2800 },
    { text: 'सेटिंग्स से आप फॉन्ट का आकार और स्थिति बदल सकते हैं।', translation: 'You can adjust font size and position from settings.', lang: 'HI / EN', duration: 2800 }
  ],
  marathi: [
    { text: 'नमस्कार! LiveSub मध्ये आपले स्वागत आहे.', translation: 'Welcome to LiveSub real-time transcription.', lang: 'MR / EN', duration: 2800 },
    { text: 'ही प्रणाली व्हिडिओचे थेट भाषांतर करते.', translation: 'This system provides live video translation.', lang: 'MR / EN', duration: 2800 },
    { text: 'आज आपण पनीर टिक्का बनवणार आहोत.', translation: 'Today we will make paneer tikka.', lang: 'MR / EN', duration: 2800 },
    { text: 'आपण सहजपणे उपशीर्षकाचा आकार बदलू शकता.', translation: 'You can easily adjust subtitle styling.', lang: 'MR / EN', duration: 2800 }
  ],
  english: [
    { text: 'Welcome to LiveSub Real-Time Subtitles!', translation: 'AI-powered speech recognition and synchronization.', lang: 'EN', duration: 2800 },
    { text: 'Zero-latency subtitle rendering with exact video sync.', translation: 'Adaptive seeking and epoch tracking active.', lang: 'EN', duration: 2800 },
    { text: 'Multilingual dual-row subtitles for any YouTube video.', translation: 'Hindi, Marathi, Tamil, Telugu, and English supported.', lang: 'EN', duration: 2800 },
    { text: 'Demo running smoothly! Turn ON to stream live speech.', translation: 'Toggle switch in popup to transcribe video in real time.', lang: 'EN', duration: 2800 }
  ]
};

const LANG_ALIASES = {
  hi: 'hindi',
  hin: 'hindi',
  hindi: 'hindi',
  mr: 'marathi',
  mar: 'marathi',
  marathi: 'marathi',
  en: 'english',
  eng: 'english',
  english: 'english',
  auto: 'hindi'
};

function resolveLanguageKey(lang) {
  const norm = (lang || '').toLowerCase().trim();
  return LANG_ALIASES[norm] || 'hindi';
}

const LANGUAGES = {
  hindi: DEMO_SEQUENCES.hindi[2],
  marathi: DEMO_SEQUENCES.marathi[2],
  english: DEMO_SEQUENCES.english[0]
};

let selectedLanguage = 'hindi'; // default language
let demoTimer = null;
let isDemoRunning = false;
window.__livesubIsDemoRunning = false;

function getDemoCue(lang) {
  const key = resolveLanguageKey(lang);
  return LANGUAGES[key] || LANGUAGES['hindi'];
}

const DEMO_CUE = LANGUAGES['hindi'];

// ─── Module State ─────────────────────────────────────────────────────────────
let overlayHostEl = null;
let shadowRootEl = null;
let subtitleBoxEl = null;
let rowLangEl = null;
let rowSourceEl = null;
let rowTransEl = null;
let controlsEl = null;
let playerElement = null;
let bodyObserver = null;

// Track active video identity to avoid clearing on regular DOM/theatre changes
let currentVideoId = null;
let lastKnownUrl = window.location.href;
let urlCheckInterval = null;

// Style State
const currentStyle = {
  fontSize: 22,
  color: '#ffffff',
  position: 'bottom' // 'top' | 'bottom'
};

// ─── Helpers: Video & Player Identity ─────────────────────────────────────────
function getVideoIdFromUrl(urlStr = window.location.href) {
  try {
    const url = new URL(urlStr);
    if (url.pathname === '/watch') {
      return url.searchParams.get('v') || null;
    }
    if (url.pathname.startsWith('/shorts/')) {
      const parts = url.pathname.split('/');
      return parts[2] || null;
    }
  } catch (_) {
    // Malformed URL safety
  }
  return null;
}

function isWatchPage() {
  return window.location.pathname === '/watch' || window.location.pathname.startsWith('/shorts/');
}

function getCurrentVideoElement() {
  return document.querySelector(`${PLAYER_SELECTOR} video`) || document.querySelector('video');
}

// ─── Shadow DOM CSS ───────────────────────────────────────────────────────────
function getShadowStyles() {
  return `
    :host {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 2147483640;
      overflow: hidden;
      display: block;
    }

    #livesub-box {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      width: clamp(260px, 75%, 960px);
      text-align: center;
      pointer-events: none;
      user-select: none;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      transition: bottom 0.15s ease, top 0.15s ease;
    }

    #livesub-box.pos-top {
      top: 10%;
      bottom: auto;
    }

    #livesub-box.pos-bottom {
      top: auto;
      bottom: 15%;
    }

    .sub-row {
      display: inline-block;
      max-width: 100%;
      font-family: 'Noto Sans Devanagari', 'Noto Sans', 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      font-size: var(--livesub-font-size, 22px);
      font-weight: 600;
      line-height: 1.45;
      color: var(--livesub-color, #ffffff);
      background: rgba(0, 0, 0, 0.78);
      border-radius: 4px;
      padding: 4px 10px;
      box-sizing: border-box;
      word-break: break-word;
      white-space: pre-wrap;
      text-shadow:
        -1px -1px 0 #000,
         1px -1px 0 #000,
        -1px  1px 0 #000,
         1px  1px 0 #000,
         0 2px 4px rgba(0, 0, 0, 0.9);
    }

    .sub-row.translation {
      font-size: calc(var(--livesub-font-size, 22px) * 0.82);
      color: #ffe082;
    }

    .sub-lang-badge {
      display: inline-block;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      padding: 2px 7px;
      border-radius: 4px;
      background: rgba(239, 68, 68, 0.88);
      color: #ffffff;
      margin-bottom: 4px;
      width: fit-content;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
    }

    .sub-lang-badge[data-empty="true"],
    .sub-row[data-empty="true"] {
      display: none !important;
    }
  `;
}

// ─── Renderer API (Phase 4 Contract) ──────────────────────────────────────────
function showSubtitle({ text = '', translation = '', lang = '' } = {}) {
  if (!rowSourceEl || !rowTransEl || !overlayHostEl || !overlayHostEl.isConnected) {
    initAll(true);
  }
  if (!rowSourceEl || !rowTransEl) return false;

  if (overlayHostEl && overlayHostEl.style.display === 'none') {
    overlayHostEl.style.display = 'block';
  }

  const cleanText = (text || '').trim();
  const cleanTrans = (translation || '').trim();
  const cleanLang = (lang || '').trim();

  if (rowLangEl) {
    rowLangEl.textContent = cleanLang;
    rowLangEl.setAttribute('data-empty', cleanLang === '' ? 'true' : 'false');
  }

  rowSourceEl.textContent = cleanText;
  rowSourceEl.setAttribute('data-empty', cleanText === '' ? 'true' : 'false');

  rowTransEl.textContent = cleanTrans;
  rowTransEl.setAttribute('data-empty', cleanTrans === '' ? 'true' : 'false');

  return true;
}

function stopDemoSequence() {
  if (demoTimer) {
    clearTimeout(demoTimer);
    demoTimer = null;
  }
  isDemoRunning = false;
  window.__livesubIsDemoRunning = false;
}

function runDemoSequence(lang = selectedLanguage) {
  stopDemoSequence();
  initAll(true);

  const key = resolveLanguageKey(lang);
  selectedLanguage = key;
  const sequence = DEMO_SEQUENCES[key] || DEMO_SEQUENCES['hindi'];

  isDemoRunning = true;
  window.__livesubIsDemoRunning = true;

  let stepIdx = 0;

  function showNextStep() {
    if (!isDemoRunning) return;
    if (stepIdx >= sequence.length) {
      demoTimer = setTimeout(() => {
        clearSubtitle();
        stopDemoSequence();
      }, 3500);
      return;
    }

    const currentStep = sequence[stepIdx];
    showSubtitle({
      text: currentStep.text,
      translation: currentStep.translation,
      lang: currentStep.lang || key.toUpperCase()
    });

    stepIdx++;
    demoTimer = setTimeout(showNextStep, currentStep.duration || 2800);
  }

  showNextStep();
}

function clearSubtitle() {
  stopDemoSequence();
  showSubtitle({ text: '', translation: '', lang: '' });
}

// Expose render callbacks and demo runners on window for pipeline.js and popup
window.__livesubRenderSubtitle = showSubtitle;
window.__livesubClearSubtitle = clearSubtitle;
window.__livesubRunDemo = runDemoSequence;
window.__livesubStopDemo = stopDemoSequence;

function updateStyle({ fontSize, color, position } = {}) {
  if (fontSize !== undefined) {
    currentStyle.fontSize = Number(fontSize);
  }
  if (color !== undefined) {
    currentStyle.color = color;
  }
  if (position !== undefined) {
    currentStyle.position = position === 'top' ? 'top' : 'bottom';
  }

  if (subtitleBoxEl) {
    subtitleBoxEl.style.setProperty('--livesub-font-size', `${currentStyle.fontSize}px`);
    subtitleBoxEl.style.setProperty('--livesub-color', currentStyle.color);

    if (currentStyle.position === 'top') {
      subtitleBoxEl.classList.remove('pos-bottom');
      subtitleBoxEl.classList.add('pos-top');
    } else {
      subtitleBoxEl.classList.remove('pos-top');
      subtitleBoxEl.classList.add('pos-bottom');
    }
  }
}

// ─── Overlay Mount (Idempotent) ───────────────────────────────────────────────
function attachOverlay(player) {
  if (!player) return false;

  // Clean up any orphan overlay host that is not inside player
  const orphan = document.getElementById(OVERLAY_HOST_ID);
  if (orphan && !player.contains(orphan)) {
    orphan.remove();
  }

  const isBody = player === document.body;
  const existing = player.querySelector(`#${OVERLAY_HOST_ID}`);
  if (existing) {
    overlayHostEl = existing;
    existing.style.display = 'block';
    if (existing.shadowRoot) {
      shadowRootEl = existing.shadowRoot;
      subtitleBoxEl = shadowRootEl.querySelector('#livesub-box');
      rowLangEl = shadowRootEl.querySelector('.sub-lang-badge');
      rowSourceEl = shadowRootEl.querySelector('.sub-row.source');
      rowTransEl = shadowRootEl.querySelector('.sub-row.translation');
    }
    if (!subtitleBoxEl || !rowSourceEl || !rowTransEl) {
      existing.remove();
    } else {
      playerElement = player;
      return true;
    }
  }

  if (!isBody) {
    const computedPos = window.getComputedStyle(player).position;
    if (computedPos === 'static') {
      player.style.position = 'relative';
    }
  }

  const host = document.createElement('div');
  host.id = OVERLAY_HOST_ID;
  host.style.cssText = isBody
    ? 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;display:block;'
    : 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2147483640;display:block;';

  const shadow = host.attachShadow({ mode: 'open' });
  const styleEl = document.createElement('style');
  styleEl.textContent = getShadowStyles();
  shadow.appendChild(styleEl);

  const box = document.createElement('div');
  box.id = 'livesub-box';
  box.className = currentStyle.position === 'top' ? 'pos-top' : 'pos-bottom';
  box.style.setProperty('--livesub-font-size', `${currentStyle.fontSize}px`);
  box.style.setProperty('--livesub-color', currentStyle.color);

  const langBadge = document.createElement('span');
  langBadge.className = 'sub-lang-badge';
  langBadge.setAttribute('data-empty', 'true');
  box.appendChild(langBadge);

  const source = document.createElement('span');
  source.className = 'sub-row source';
  source.setAttribute('data-empty', 'true');
  box.appendChild(source);

  const trans = document.createElement('span');
  trans.className = 'sub-row translation';
  trans.setAttribute('data-empty', 'true');
  box.appendChild(trans);

  shadow.appendChild(box);
  player.appendChild(host);

  overlayHostEl = host;
  shadowRootEl = shadow;
  subtitleBoxEl = box;
  rowLangEl = langBadge;
  rowSourceEl = source;
  rowTransEl = trans;
  playerElement = player;

  console.log('[LiveSub] Subtitle overlay attached.');
  return true;
}

// ─── Controls Mount (Idempotent) ──────────────────────────────────────────────
function attachControls(player) {
  if (player.querySelector(`#${CONTROLS_PANEL_ID}`)) return;

  const panel = document.createElement('div');
  panel.id = CONTROLS_PANEL_ID;
  panel.style.cssText = [
    'position:absolute',
    'top:54px',
    'right:14px',
    'z-index:2147483645',
    'pointer-events:auto',
    'font-family:Arial, sans-serif',
    'font-size:12px',
    'color:#ffffff',
    'user-select:none'
  ].join(';');

  const toggleBtn = document.createElement('button');
  toggleBtn.textContent = '⚙ LiveSub';
  toggleBtn.style.cssText = [
    'background:rgba(20,20,20,0.85)',
    'color:#fff',
    'border:1px solid #444',
    'border-radius:6px',
    'padding:5px 10px',
    'font-weight:600',
    'cursor:pointer',
    'backdrop-filter:blur(4px)',
    'display:block',
    'margin-left:auto'
  ].join(';');

  const body = document.createElement('div');
  body.style.cssText = [
    'display:none',
    'margin-top:6px',
    'background:rgba(20,20,20,0.92)',
    'border:1px solid rgba(255,255,255,0.15)',
    'border-radius:8px',
    'padding:10px 12px',
    'width:210px',
    'box-shadow:0 4px 16px rgba(0,0,0,0.6)',
    'backdrop-filter:blur(6px)',
    'box-sizing:border-box'
  ].join(';');

  let isOpen = false;
  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    isOpen = !isOpen;
    body.style.display = isOpen ? 'block' : 'none';
    toggleBtn.style.borderColor = isOpen ? '#ff4444' : '#444';
  });

  // 1. Font Size
  const sizeRow = document.createElement('div');
  sizeRow.style.cssText = 'margin-bottom:8px;';
  const sizeLabel = document.createElement('div');
  sizeLabel.style.cssText = 'display:flex;justify-content:space-between;margin-bottom:3px;color:#bbb;font-size:11px;';
  const sizeTitle = document.createElement('span');
  sizeTitle.textContent = 'Font Size';
  const sizeVal = document.createElement('span');
  sizeVal.id = 'livesub-size-val';
  sizeVal.textContent = `${currentStyle.fontSize}px`;
  sizeLabel.appendChild(sizeTitle);
  sizeLabel.appendChild(sizeVal);
  const sizeSlider = document.createElement('input');
  sizeSlider.type = 'range';
  sizeSlider.min = '14';
  sizeSlider.max = '38';
  sizeSlider.value = String(currentStyle.fontSize);
  sizeSlider.style.cssText = 'width:100%;cursor:pointer;margin:0;accent-color:#ff4444;';
  sizeSlider.addEventListener('input', (e) => {
    e.stopPropagation();
    const val = e.target.value;
    const valSpan = sizeLabel.querySelector('#livesub-size-val');
    if (valSpan) valSpan.textContent = `${val}px`;
    updateStyle({ fontSize: val });
  });
  sizeRow.appendChild(sizeLabel);
  sizeRow.appendChild(sizeSlider);

  // 2. Color
  const colorRow = document.createElement('div');
  colorRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;';
  const colorLabel = document.createElement('span');
  colorLabel.textContent = 'Text Color';
  colorLabel.style.cssText = 'color:#bbb;font-size:11px;';
  const colorPicker = document.createElement('input');
  colorPicker.type = 'color';
  colorPicker.value = currentStyle.color;
  colorPicker.style.cssText = 'width:28px;height:24px;border:none;border-radius:3px;cursor:pointer;background:none;padding:0;';
  colorPicker.addEventListener('input', (e) => {
    e.stopPropagation();
    updateStyle({ color: e.target.value });
  });
  colorRow.appendChild(colorLabel);
  colorRow.appendChild(colorPicker);

  // 3. Position (Top / Bottom)
  const posRow = document.createElement('div');
  posRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;';
  const posLabel = document.createElement('span');
  posLabel.textContent = 'Position';
  posLabel.style.cssText = 'color:#bbb;font-size:11px;';
  const posBtnGroup = document.createElement('div');
  posBtnGroup.style.cssText = 'display:flex;gap:4px;';

  const btnBottom = document.createElement('button');
  btnBottom.textContent = 'Bottom';
  const btnTop = document.createElement('button');
  btnTop.textContent = 'Top';

  const styleGroupBtn = (btn, active) => {
    btn.style.cssText = `
      padding:3px 8px;font-size:11px;cursor:pointer;border-radius:4px;
      border:1px solid ${active ? '#ff4444' : '#555'};
      background:${active ? '#ff4444' : '#2a2a2a'};
      color:#fff;
    `;
  };

  styleGroupBtn(btnBottom, currentStyle.position === 'bottom');
  styleGroupBtn(btnTop, currentStyle.position === 'top');

  btnBottom.addEventListener('click', (e) => {
    e.stopPropagation();
    updateStyle({ position: 'bottom' });
    styleGroupBtn(btnBottom, true);
    styleGroupBtn(btnTop, false);
  });
  btnTop.addEventListener('click', (e) => {
    e.stopPropagation();
    updateStyle({ position: 'top' });
    styleGroupBtn(btnBottom, false);
    styleGroupBtn(btnTop, true);
  });
  posBtnGroup.appendChild(btnBottom);
  posBtnGroup.appendChild(btnTop);
  posRow.appendChild(posLabel);
  posRow.appendChild(posBtnGroup);
  // 4. Language selector
  const langRow = document.createElement('div');
  langRow.style.cssText = 'margin-bottom:8px;';
  const langLabel = document.createElement('span');
  langLabel.textContent = 'Language';
  langLabel.style.cssText = 'color:#bbb;font-size:11px;display:block;margin-bottom:3px;';
  const langSelect = document.createElement('select');
  langSelect.style.cssText = 'width:100%;padding:2px;font-size:11px;cursor:pointer;';
  ['Hindi', 'Marathi', 'English'].forEach(l => {
    const opt = document.createElement('option');
    opt.value = l.toLowerCase();
    opt.textContent = l;
    if (opt.value === selectedLanguage) opt.selected = true;
    langSelect.appendChild(opt);
  });
  langSelect.addEventListener('change', (e) => {
    e.stopPropagation();
    selectedLanguage = e.target.value;
  });
  langRow.appendChild(langLabel);
  langRow.appendChild(langSelect);

  // 4. Action Buttons
  const actRow = document.createElement('div');
  actRow.style.cssText = 'display:flex;gap:6px;border-top:1px solid rgba(255,255,255,0.1);padding-top:8px;';

  const demoBtn = document.createElement('button');
  demoBtn.textContent = '▶ Demo';
  demoBtn.style.cssText = 'flex:1;padding:5px;border:none;border-radius:4px;background:#ff4444;color:#fff;cursor:pointer;font-weight:600;font-size:11px;';
  demoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    runDemoSequence(selectedLanguage);
  });

  const clearBtn = document.createElement('button');
  clearBtn.textContent = '✕ Clear';
  clearBtn.style.cssText = 'flex:1;padding:5px;border:1px solid #555;border-radius:4px;background:#333;color:#eee;cursor:pointer;font-size:11px;';
  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    stopDemoSequence();
    clearSubtitle();
  });

  actRow.appendChild(demoBtn);
  actRow.appendChild(clearBtn);

  body.appendChild(sizeRow);
  body.appendChild(colorRow);
  body.appendChild(posRow);
  body.appendChild(langRow);
  const selectedLangDisplay = document.createElement('div');
  selectedLangDisplay.id = 'selected-lang-display';
  selectedLangDisplay.textContent = `Selected: ${selectedLanguage.charAt(0).toUpperCase() + selectedLanguage.slice(1)}`;
  selectedLangDisplay.style.cssText = 'color:#bbb;font-size:11px;margin-top:4px;';
  body.appendChild(selectedLangDisplay);
  body.appendChild(actRow);

  panel.appendChild(toggleBtn);
  panel.appendChild(body);

  player.appendChild(panel);
  controlsEl = panel;
}

// ─── Phase 3: SPA Navigation Handling ─────────────────────────────────────────
function handleNavigationChange(reason = 'nav') {
  const newUrl = window.location.href;
  const newVid = getVideoIdFromUrl(newUrl);
  const onWatch = isWatchPage();

  const videoChanged = newVid !== currentVideoId;
  const leftWatch = !onWatch && currentVideoId !== null;

  if (videoChanged || leftWatch) {
    console.log(`[LiveSub] SPA transition (${reason}): video changed from ${currentVideoId} to ${newVid}. Resetting subtitle.`);
    currentVideoId = newVid;
    lastKnownUrl = newUrl;

    clearSubtitle();

    if (onWatch) {
      initAll();
    }
  }
}

function initSpaNavigationListeners() {
  window.addEventListener('yt-navigate-finish', () => handleNavigationChange('yt-navigate-finish'));
  window.addEventListener('yt-page-data-updated', () => handleNavigationChange('yt-page-data-updated'));
  window.addEventListener('popstate', () => handleNavigationChange('popstate'));

  if (!urlCheckInterval) {
    urlCheckInterval = setInterval(() => {
      if (window.location.href !== lastKnownUrl) {
        lastKnownUrl = window.location.href;
        handleNavigationChange('url-poll-fallback');
      }
    }, 500);
  }
}

// ─── Phase 4: Extension Messaging Integration Contract ────────────────────────
/**
 * Receives messages from Role D (sync scheduler, background worker, or eval script).
 * Supported actions:
 * - 'SHOW_SUBTITLE' / 'RENDER_SUBTITLE':
 *     payload: { text, translation, cueId, revision, sessionId, generation }
 *     returns: { status: 'rendered', cueId, revision, currentTime, renderTimestamp }
 * - 'CLEAR_SUBTITLE':
 *     returns: { status: 'cleared', currentTime }
 * - 'UPDATE_STYLE':
 *     payload: { fontSize, color, position }
 *     returns: { status: 'style_updated', currentStyle }
 * - 'GET_STATUS':
 *     returns: { currentVideoId, isAttached: !!overlayHostEl, currentStyle }
 */
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.action) return false;

    const video = getCurrentVideoElement();
    const currentTime = video ? video.currentTime : null;

    switch (message.action) {
      case 'RUN_DEMO': {
        const lang = message.lang || selectedLanguage;
        runDemoSequence(lang);
        sendResponse({
          status: 'demo_started',
          lang
        });
        return true;
      }

      case 'STOP_DEMO': {
        stopDemoSequence();
        clearSubtitle();
        sendResponse({
          status: 'demo_stopped'
        });
        return true;
      }

      case 'SHOW_SUBTITLE':
      case 'RENDER_SUBTITLE': {
        window.__livesubIsDemoRunning = true;
        if (demoTimer) clearTimeout(demoTimer);
        demoTimer = setTimeout(() => {
          window.__livesubIsDemoRunning = false;
        }, 3500);

        const ok = showSubtitle({
          text: message.text || '',
          translation: message.translation || '',
          lang: message.lang || ''
        });
        sendResponse({
          status: ok ? 'rendered' : 'player_not_attached',
          cueId: message.cueId || null,
          revision: message.revision || 1,
          currentTime,
          renderTimestamp: performance.now()
        });
        return true;
      }

      case 'CLEAR_SUBTITLE': {
        stopDemoSequence();
        clearSubtitle();
        sendResponse({
          status: 'cleared',
          currentTime
        });
        return true;
      }

      case 'SET_ENABLED': {
        stopDemoSequence();
        clearSubtitle();
        if (message.enabled === false) {
          if (overlayHostEl) overlayHostEl.style.display = 'none';
        } else {
          if (!overlayHostEl || !rowSourceEl) {
            initAll();
          }
          if (overlayHostEl) overlayHostEl.style.display = 'block';
        }
        sendResponse({
          status: 'ok',
          enabled: message.enabled
        });
        return true;
      }

      case 'EXPORT_CUE_LOG': {
        const cueLog = (typeof window.__ctrlcvExportCueLog === 'function')
          ? window.__ctrlcvExportCueLog(false)
          : [];
        sendResponse({ success: true, cueLog });
        return true;
      }

      case 'UPDATE_STYLE': {
        updateStyle({
          fontSize: message.fontSize,
          color: message.color,
          position: message.position
        });
        sendResponse({
          status: 'style_updated',
          currentStyle: { ...currentStyle }
        });
        return false;
      }

      case 'GET_STATUS': {
        sendResponse({
          version: '0.1.1',
          build: 11,
          currentVideoId,
          isAttached: !!overlayHostEl && overlayHostEl.isConnected,
          currentStyle: { ...currentStyle }
        });
        return false;
      }

      default:
        return false;
    }
  });
}

// ─── Setup & Player Replacement ───────────────────────────────────────────────
function initAll(allowBodyFallback = false) {
  const player = getPlayerElement(allowBodyFallback);
  if (player) {
    attachOverlay(player);
    if (player !== document.body) {
      attachControls(player);
    }
    currentVideoId = getVideoIdFromUrl();
    return true;
  }
  return false;
}

function pollForPlayer() {
  let attempts = 0;
  const timer = setInterval(() => {
    attempts++;
    if (initAll() || attempts >= MAX_POLL_ATTEMPTS) {
      clearInterval(timer);
    }
  }, POLL_INTERVAL_MS);
}

function observePlayerReplacement() {
  if (bodyObserver) return;
  bodyObserver = new MutationObserver(() => {
    const current = document.querySelector(PLAYER_SELECTOR);
    if (current && current !== playerElement) {
      console.log('[LiveSub] Player DOM element replaced. Reattaching overlay & controls.');
      overlayHostEl = null;
      shadowRootEl = null;
      subtitleBoxEl = null;
      rowSourceEl = null;
      rowTransEl = null;
      controlsEl = null;
      playerElement = null;
      initAll();
    }
  });

  bodyObserver.observe(document.body, { childList: true, subtree: true });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
if (!initAll()) {
  pollForPlayer();
}
observePlayerReplacement();
initSpaNavigationListeners();
