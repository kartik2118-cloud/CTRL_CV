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

// Language support & sequential demo steps (Rick Astley - Never Gonna Give You Up & Multilingual)
const DEMO_SEQUENCES = {
  hindi: [
    { text: "We're no strangers to love, you know the rules and so do I", translation: "हम प्यार से अनजान नहीं हैं, तुम नियम जानते हो और मैं भी", lang: "HI / EN", duration: 3200 },
    { text: "A full commitment's what I'm thinking of, you wouldn't get this from any other guy", translation: "मैं एक पूर्ण समर्पण के बारे में सोच रहा हूँ, तुम्हें यह किसी और से नहीं मिलेगा", lang: "HI / EN", duration: 3200 },
    { text: "I just wanna tell you how I'm feeling, gotta make you understand", translation: "मैं बस तुम्हें बताना चाहता हूँ कि मैं कैसा महसूस कर रहा हूँ, तुम्हें समझाना ही होगा", lang: "HI / EN", duration: 3200 },
    { text: "Never gonna give you up, never gonna let you down", translation: "तुम्हें कभी नहीं छोड़ूँगा, कभी निराश नहीं करूँगा", lang: "HI / EN", duration: 3000 },
    { text: "Never gonna run around and desert you", translation: "कभी भागूँगा नहीं और तुम्हें अकेला नहीं छोड़ूँगा", lang: "HI / EN", duration: 3000 },
    { text: "Never gonna make you cry, never gonna say goodbye", translation: "कभी तुम्हें रुलाऊँगा नहीं, कभी अलविदा नहीं कहूँगा", lang: "HI / EN", duration: 3000 },
    { text: "Never gonna tell a lie and hurt you", translation: "कभी झूठ नहीं बोलूँगा और तुम्हें चोट नहीं पहुँचाऊँगा", lang: "HI / EN", duration: 3000 },
    { text: "We've known each other for so long, your heart's been aching", translation: "हम एक दूसरे को बहुत समय से जानते हैं, तुम्हारा दिल दुख रहा है", lang: "HI / EN", duration: 3200 },
    { text: "Inside we both know what's been going on, we know the game and we're gonna play it", translation: "अंदर ही अंदर हम दोनों जानते हैं कि क्या चल रहा है, हम खेल जानते हैं और इसे खेलेंगे", lang: "HI / EN", duration: 3200 }
  ],
  marathi: [
    { text: "We're no strangers to love, you know the rules and so do I", translation: "आपण प्रेमासाठी अनोळखी नाही, तुम्हाला नियम माहीत आहेत आणि मलाही", lang: "MR / EN", duration: 3200 },
    { text: "A full commitment's what I'm thinking of, you wouldn't get this from any other guy", translation: "मी पूर्ण समर्पणाचा विचार करत आहे, हे इतर कोणाकडून मिळणार नाही", lang: "MR / EN", duration: 3200 },
    { text: "I just wanna tell you how I'm feeling, gotta make you understand", translation: "मला फक्त सांगायचे आहे की मला कसे वाटते, तुला समजावून सांगावेच लागेल", lang: "MR / EN", duration: 3200 },
    { text: "Never gonna give you up, never gonna let you down", translation: "तुला कधीही सोडणार नाही, कधीही निराश करणार नाही", lang: "MR / EN", duration: 3000 },
    { text: "Never gonna run around and desert you", translation: "कधीही पळून जाणार नाही आणि तुला एकटे सोडणार नाही", lang: "MR / EN", duration: 3000 },
    { text: "Never gonna make you cry, never gonna say goodbye", translation: "तुला कधीही रडवणार नाही, कधीही निरोप घेणार नाही", lang: "MR / EN", duration: 3000 },
    { text: "Never gonna tell a lie and hurt you", translation: "कधीही खोटे बोलणार नाही आणि तुला दुखावणार नाही", lang: "MR / EN", duration: 3000 },
    { text: "We've known each other for so long, your heart's been aching", translation: "आपण एकमेकांना खूप दिवसांपासून ओळखतो, तुझे मन दुखत आहे", lang: "MR / EN", duration: 3200 },
    { text: "Inside we both know what's been going on, we know the game and we're gonna play it", translation: "आतल्या आत आपल्या दोघांना माहीत आहे काय चालले आहे, आपल्याला खेळ माहीत आहे", lang: "MR / EN", duration: 3200 }
  ],
  english: [
    { text: "We're no strangers to love, you know the rules and so do I", translation: "A full commitment's what I'm thinking of", lang: "EN", duration: 3200 },
    { text: "You wouldn't get this from any other guy", translation: "I just wanna tell you how I'm feeling", lang: "EN", duration: 3200 },
    { text: "Gotta make you understand", translation: "Never gonna give you up, never gonna let you down", lang: "EN", duration: 3000 },
    { text: "Never gonna run around and desert you", translation: "Never gonna make you cry, never gonna say goodbye", lang: "EN", duration: 3000 },
    { text: "Never gonna tell a lie and hurt you", translation: "We've known each other for so long", lang: "EN", duration: 3000 },
    { text: "Inside we both know what's been going on", translation: "We know the game and we're gonna play it", lang: "EN", duration: 3200 }
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
  hindi: DEMO_SEQUENCES.hindi[0],
  marathi: DEMO_SEQUENCES.marathi[0],
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
      z-index: 2147483647;
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
    : 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2147483647;display:block;';

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
// ─── Cue Log Storage & Export (K4, Evaluation Contract) ───────────────────────
const recordedCues = [];

function recordCue(cue) {
  if (!cue) return;
  const cleanText = (cue.text || '').trim();
  if (!cleanText) return;

  const existing = recordedCues.find(c => c.cueId && c.cueId === cue.cueId);
  if (existing) {
    existing.text = cleanText;
    existing.translation = (cue.translation || existing.translation || '').trim();
    if (cue.end !== undefined) existing.end = Number(cue.end);
    if (!existing.revisions) existing.revisions = [];
    existing.revisions.push({ at: cue.start !== undefined ? Number(cue.start) : 0.0, text: cleanText });
  } else {
    recordedCues.push({
      cueId: cue.cueId || `cue_${Date.now()}_${recordedCues.length}`,
      start: cue.start !== undefined ? Number(cue.start) : 0.0,
      end: cue.end !== undefined ? Number(cue.end) : 2.5,
      lang: cue.lang || 'hi',
      text: cleanText,
      translation: (cue.translation || cleanText).trim(),
      source: cue.source || 'stt',
      first_shown_at: performance.now() / 1000.0,
      revisions: [{ at: cue.start !== undefined ? Number(cue.start) : 0.0, text: cleanText }]
    });
  }
}

async function getOrFetchCues({ allowDemo = false, targetLang = null } = {}) {
  if (recordedCues.length > 0) {
    return recordedCues;
  }

  // 1. Try SyncBridge archive if available
  if (window.__ctrlcvBridge && typeof window.__ctrlcvBridge.exportArchive === 'function') {
    try {
      const archive = window.__ctrlcvBridge.exportArchive();
      if (archive && Array.isArray(archive.cues) && archive.cues.length > 0) {
        archive.cues.forEach(c => recordCue(c));
        return recordedCues;
      }
    } catch (_) {}
  }

  // 2. Extract and parse native YouTube video caption tracks (Manual or ASR)
  const captionsApi = globalThis.CtrlCVCaptions;
  if (captionsApi && typeof captionsApi.detectCaptionTracks === 'function') {
    try {
      const allTracks = captionsApi.detectCaptionTracks(null, { includeAsr: true });
      if (allTracks && allTracks.length > 0) {
        const langPref = selectedLanguage || 'hi';
        const chosen = captionsApi.chooseCaptionTrack(allTracks, langPref);
        if (chosen && chosen.baseUrl) {
          let fetchUrl = chosen.baseUrl;
          const tgt = (targetLang && targetLang !== 'none' && targetLang !== 'auto') ? targetLang : '';
          if (tgt && tgt.toLowerCase() !== chosen.languageCode.toLowerCase()) {
            fetchUrl += `&tlang=${encodeURIComponent(tgt)}`;
          }
          const resp = await fetch(fetchUrl);
          if (resp.ok) {
            const raw = await resp.text();
            const parsedCues = captionsApi.parseCaptionText(raw);
            if (parsedCues && parsedCues.length > 0) {
              parsedCues.forEach((c, idx) => {
                recordCue({
                  cueId: `yt_cap_${idx + 1}`,
                  start: c.start,
                  end: c.end,
                  text: c.text,
                  translation: c.text,
                  lang: tgt || chosen.languageCode || 'hi',
                  source: chosen.isAsr ? 'youtube_asr' : 'youtube_manual'
                });
              });
              return recordedCues;
            }
          }
        }
      }
    } catch (e) {
      console.warn('[LiveSub] Error extracting YouTube captions:', e);
    }
  }

  // 3. Fallback to sequence of demo steps if demo was explicitly allowed/requested
  if (allowDemo) {
    const demoSeq = DEMO_SEQUENCES[selectedLanguage] || DEMO_SEQUENCES['hindi'];
    if (demoSeq && demoSeq.length > 0) {
      let t = 0.0;
      demoSeq.forEach((step, idx) => {
        const dur = (step.duration || 3000) / 1000.0;
        recordCue({
          cueId: `demo_${idx + 1}`,
          start: Number(t.toFixed(3)),
          end: Number((t + dur).toFixed(3)),
          text: step.text,
          translation: step.translation,
          lang: step.lang || selectedLanguage,
          source: 'demo'
        });
        t += dur;
      });
      return recordedCues;
    }
  }

  return recordedCues;
}

window.__ctrlcvExportCueLog = function() {
  return {
    videoId: currentVideoId || 'youtube',
    createdAt: new Date().toISOString(),
    targetLanguage: selectedLanguage || 'en',
    cues: recordedCues
  };
};

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return false;
    const action = message.action || message.type;
    if (!action) return false;

    const video = getCurrentVideoElement();
    const currentTime = video ? video.currentTime : null;

    if (action === 'PING') {
      sendResponse({ status: 'pong', version: '1.0.1' });
      return true;
    }

    if (action === 'CHECK_CAPTION_STATUS') {
      const captionsApi = globalThis.CtrlCVCaptions;
      let tracks = [];
      const vid = currentVideoId || getVideoIdFromUrl() || 'youtube';
      if (captionsApi && typeof captionsApi.detectCaptionTracks === 'function') {
        tracks = captionsApi.detectCaptionTracks(null, { includeAsr: true });
      }
      if (captionsApi && typeof captionsApi.getScriptFromCache === 'function') {
        captionsApi.getScriptFromCache(vid, selectedLanguage).then(cached => {
          sendResponse({
            videoId: vid,
            recordedCuesCount: recordedCues.length,
            hasCaptions: tracks.length > 0,
            hasCache: Boolean(cached && cached.cues?.length > 0),
            cachedCueCount: cached?.cues?.length || 0,
            tracks: tracks.map(t => ({ languageCode: t.languageCode, name: t.name, isAsr: t.isAsr }))
          });
        }).catch(() => {
          sendResponse({
            videoId: vid,
            recordedCuesCount: recordedCues.length,
            hasCaptions: tracks.length > 0,
            hasCache: false,
            cachedCueCount: 0,
            tracks: tracks.map(t => ({ languageCode: t.languageCode, name: t.name, isAsr: t.isAsr }))
          });
        });
        return true;
      }
      sendResponse({
        videoId: vid,
        recordedCuesCount: recordedCues.length,
        hasCaptions: tracks.length > 0,
        hasCache: false,
        cachedCueCount: 0,
        tracks: tracks.map(t => ({ languageCode: t.languageCode, name: t.name, isAsr: t.isAsr }))
      });
      return true;
    }

    if (action === 'CLEAR_SCRIPT_CACHE') {
      const captionsApi = globalThis.CtrlCVCaptions;
      const vid = currentVideoId || getVideoIdFromUrl() || null;
      if (captionsApi && typeof captionsApi.clearScriptCache === 'function') {
        captionsApi.clearScriptCache(vid).then(() => {
          sendResponse({ success: true });
        }).catch(err => {
          sendResponse({ success: false, error: err?.message || String(err) });
        });
        return true;
      }
      sendResponse({ success: false, error: 'no_api' });
      return true;
    }

    if (action === 'GET_CUE_LOG' || action === 'EXPORT_CUE_LOG') {
      const allowDemo = Boolean(message.allowDemo);
      const targetLang = message.targetLanguage || selectedLanguage;
      getOrFetchCues({ allowDemo, targetLang }).then((cues) => {
        sendResponse({
          videoId: currentVideoId || getVideoIdFromUrl() || 'youtube',
          createdAt: new Date().toISOString(),
          targetLanguage: targetLang || 'en',
          cues: cues || [],
          count: (cues || []).length
        });
      }).catch((err) => {
        sendResponse({
          videoId: currentVideoId || getVideoIdFromUrl() || 'youtube',
          createdAt: new Date().toISOString(),
          targetLanguage: 'en',
          cues: recordedCues || [],
          count: (recordedCues || []).length,
          error: String(err)
        });
      });
      return true;
    }

    if (action === 'GET_VIDEO_OBSERVATION') {
      const v = getCurrentVideoElement();
      if (v) {
        sendResponse({
          observation: {
            wall_time_ms: Date.now(),
            video_current_time: v.currentTime,
            playback_rate: v.playbackRate,
            paused: v.paused,
            seeking: v.seeking,
            video_id: getVideoIdFromUrl(),
            epoch: debugHudState.epoch || 1,
            ad_state: document.querySelector('.ad-showing') ? 'ad_playing' : 'none'
          }
        });
      } else {
        sendResponse({ observation: null });
      }
      return true;
    }

    if (action === 'RENDER_CUE') {
      const cue = message.cue || {};
      recordCue(cue);
      const ok = showSubtitle({
        text: cue.text || '',
        translation: cue.translation || '',
        lang: cue.lang || ''
      });
      if (typeof window.__livesubOnResult === 'function') {
        window.__livesubOnResult({ result: cue, epoch: cue.epoch });
      }

      // Auto-clear subtitle after 4.5 seconds if speech stops so stale text doesn't linger
      if (window.__livesubAutoClearTimer) {
        clearTimeout(window.__livesubAutoClearTimer);
      }
      window.__livesubAutoClearTimer = setTimeout(() => {
        if (!window.__livesubIsDemoRunning) {
          clearSubtitle();
        }
      }, 4500);

      sendResponse({ status: ok ? 'rendered' : 'player_not_attached', cueId: cue.cueId });
      return true;
    }

    if (action === 'CHUNK_SENT') {
      if (typeof window.__livesubOnChunkSent === 'function') {
        window.__livesubOnChunkSent(message.chunkInfo || message);
      }
      sendResponse({ status: 'ok' });
      return true;
    }

    if (action === 'CAPTURE_STATUS_CHANGED') {
      if (typeof window.__livesubUpdateHud === 'function') {
        window.__livesubUpdateHud({
          capture_state: message.isCapturing ? 'capturing' : 'idle',
          last_error: message.error || 'none'
        });
      }
      sendResponse({ status: 'ok' });
      return true;
    }

    if (action === 'WS_STATE_CHANGED') {
      if (typeof window.__livesubUpdateHud === 'function') {
        window.__livesubUpdateHud({
          ws_state: message.state || 'unknown',
          last_error: message.error || 'none'
        });
      }
      sendResponse({ status: 'ok' });
      return true;
    }

    if (action === 'SET_SETTINGS') {
      if (message.targetLanguage) {
        selectedLanguage = message.targetLanguage;
      }
      sendResponse({ status: 'ok' });
      return true;
    }

    switch (action) {
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
          ? window.__ctrlcvExportCueLog()
          : { videoId: currentVideoId || 'youtube', createdAt: new Date().toISOString(), cues: [] };
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

      case 'CHUNK_SENT': {
        if (typeof window.__livesubOnChunkSent === 'function') {
          window.__livesubOnChunkSent(message);
        }
        sendResponse({ status: 'ok' });
        return true;
      }

      case 'RESULT': {
        if (typeof window.__livesubOnResult === 'function') {
          window.__livesubOnResult(message);
        }
        sendResponse({ status: 'ok' });
        return true;
      }

      case 'STATUS': {
        if (typeof window.__livesubUpdateHud === 'function') {
          const update = {};
          if (message.status === 'Streaming') {
            update.capture_state = 'capturing';
            update.ws_state = 'connected';
          } else if (message.status === 'Connecting') {
            update.capture_state = 'starting';
            update.ws_state = 'connecting';
          } else if (message.status === 'Idle') {
            update.capture_state = 'idle';
            update.ws_state = 'disconnected';
          } else if (message.status === 'Error') {
            update.capture_state = 'error';
            update.ws_state = 'error';
          }
          if (message.capture_state) update.capture_state = message.capture_state;
          if (message.ws_state) update.ws_state = message.ws_state;
          if (message.last_error || message.message) update.last_error = message.last_error || message.message;
          window.__livesubUpdateHud(update);
        }
        sendResponse({ status: 'ok' });
        return true;
      }

      case 'UPDATE_HUD_ERROR': {
        if (typeof window.__livesubUpdateHud === 'function') {
          window.__livesubUpdateHud({ last_error: message.error || 'none' });
        }
        sendResponse({ status: 'ok' });
        return true;
      }

      case 'TOGGLE_DEBUG_HUD': {
        if (typeof window.__livesubToggleHud === 'function') {
          window.__livesubToggleHud(message.visible !== false);
        }
        sendResponse({ status: 'ok' });
        return true;
      }

      case 'GET_HUD_TELEMETRY': {
        const isOverlayPresent = !!(overlayHostEl && overlayHostEl.isConnected && overlayHostEl.shadowRoot);
        debugHudState.overlay_present = isOverlayPresent;
        const ageS = debugHudState.last_result_time
          ? ((Date.now() - debugHudState.last_result_time) / 1000).toFixed(1)
          : 'n/a';
        sendResponse({
          success: true,
          telemetry: {
            ...debugHudState,
            last_result_age_s: ageS
          }
        });
        return true;
      }

      case 'GET_STATUS': {
        sendResponse({
          version: '0.1.2',
          build: 12,
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

let lastObservationTime = 0;

function sendVideoObservation(video) {
  if (!video || typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
  const now = Date.now();
  if (now - lastObservationTime < 400) return;
  lastObservationTime = now;

  const obs = {
    wall_time_ms: now,
    video_current_time: video.currentTime,
    playback_rate: video.playbackRate,
    paused: video.paused,
    seeking: video.seeking,
    video_id: getVideoIdFromUrl(),
    epoch: debugHudState.epoch || 1,
    ad_state: document.querySelector('.ad-showing') ? 'ad_playing' : 'none'
  };

  chrome.runtime.sendMessage({
    type: 'VIDEO_STATE_OBSERVATION',
    observation: obs
  }).catch(() => {});
}

function setupVideoTimelineListeners() {
  const video = getCurrentVideoElement();
  if (!video || video.__livesubListenersAttached) return;
  video.__livesubListenersAttached = true;

  video.addEventListener('timeupdate', () => {
    sendVideoObservation(video);
  });

  video.addEventListener('seeking', () => {
    if (window.__livesubAutoClearTimer) clearTimeout(window.__livesubAutoClearTimer);
    clearSubtitle();
    chrome.runtime.sendMessage({
      type: 'TIMELINE_EVENT',
      event: { type: 'seek', videoTime: video.currentTime }
    }).catch(() => {});
    sendVideoObservation(video);
  });

  video.addEventListener('seeked', () => {
    sendVideoObservation(video);
  });

  video.addEventListener('ratechange', () => {
    chrome.runtime.sendMessage({
      type: 'TIMELINE_EVENT',
      event: { type: 'ratechange', playbackRate: video.playbackRate }
    }).catch(() => {});
    sendVideoObservation(video);
  });

  video.addEventListener('play', () => sendVideoObservation(video));
  video.addEventListener('pause', () => sendVideoObservation(video));
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
    setupVideoTimelineListeners();
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

// ─── Debug HUD (Telemetry Badge - K2, K5) ────────────────────────────────────
const DEBUG_HUD_ID = 'livesub-debug-hud';
const debugHudState = {
  ext_loaded: true,
  capture_state: 'idle',
  ws_state: 'disconnected',
  chunks_sent: 0,
  results_received: 0,
  last_result_time: null,
  epoch: 1,
  last_error: 'none',
  overlay_present: false,
  visible: true
};

function renderDebugHud() {
  let hudEl = document.getElementById(DEBUG_HUD_ID);
  if (!hudEl) {
    hudEl = document.createElement('div');
    hudEl.id = DEBUG_HUD_ID;
    hudEl.style.cssText = 'position:fixed;top:12px;left:12px;z-index:2147483647;pointer-events:none;' +
      'background:rgba(15,23,42,0.92);backdrop-filter:blur(4px);color:#f1f5f9;' +
      'font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:11px;' +
      'line-height:1.4;padding:8px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);' +
      'box-shadow:0 4px 14px rgba(0,0,0,0.55);max-width:380px;display:block;';
    const fsEl = document.fullscreenElement;
    if (fsEl) {
      fsEl.appendChild(hudEl);
    } else {
      document.body.appendChild(hudEl);
    }
  }

  const isOverlayPresent = !!(overlayHostEl && overlayHostEl.isConnected && overlayHostEl.shadowRoot);
  debugHudState.overlay_present = isOverlayPresent;

  const ageS = debugHudState.last_result_time
    ? ((Date.now() - debugHudState.last_result_time) / 1000).toFixed(1) + 's'
    : 'n/a';

  hudEl.style.display = debugHudState.visible ? 'block' : 'none';

  hudEl.innerHTML = `
    <div style="font-weight:700;color:#ef4444;margin-bottom:3px;letter-spacing:0.5px;">[LiveSub Debug HUD]</div>
    <div>ext_loaded: <span style="color:#22c55e;">${debugHudState.ext_loaded}</span></div>
    <div>capture_state: <span style="color:#38bdf8;">${debugHudState.capture_state}</span></div>
    <div>ws_state: <span style="color:#a78bfa;">${debugHudState.ws_state}</span></div>
    <div>chunks_sent: <span style="color:#facc15;">${debugHudState.chunks_sent}</span></div>
    <div>results_received: <span style="color:#4ade80;">${debugHudState.results_received}</span></div>
    <div>last_result_age_s: <span>${ageS}</span></div>
    <div>epoch: <span>${debugHudState.epoch}</span></div>
    <div>overlay_present: <span style="color:${isOverlayPresent ? '#22c55e' : '#f87171'};font-weight:600;">${isOverlayPresent}</span></div>
    <div>last_error: <span style="color:${debugHudState.last_error !== 'none' ? '#f87171' : '#94a3b8'};">${debugHudState.last_error}</span></div>
  `.trim();
}

window.__livesubOnChunkSent = function(msg) {
  debugHudState.chunks_sent++;
  if (typeof msg.epoch === 'number') debugHudState.epoch = msg.epoch;
  renderDebugHud();
};

window.__livesubOnResult = function(msg) {
  debugHudState.results_received++;
  debugHudState.last_result_time = Date.now();
  const resEpoch = msg.result?.epoch ?? msg.epoch;
  if (typeof resEpoch === 'number') debugHudState.epoch = resEpoch;
  renderDebugHud();
};

window.__livesubUpdateHud = function(partial) {
  Object.assign(debugHudState, partial);
  renderDebugHud();
};

window.__livesubToggleHud = function(visible) {
  debugHudState.visible = Boolean(visible);
  renderDebugHud();
};

// 500ms ticker for Debug HUD
setInterval(renderDebugHud, 500);

// Load persisted HUD visibility preference (default: true)
if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
  chrome.storage.local.get(['livesub_debug_hud'], (items) => {
    if (items && items.livesub_debug_hud !== undefined) {
      debugHudState.visible = items.livesub_debug_hud !== false;
      renderDebugHud();
    }
  });
}

// Fullscreen listener keeping HUD and overlay mounted inside fullscreen element
document.addEventListener('fullscreenchange', () => {
  const fsEl = document.fullscreenElement;
  const hudEl = document.getElementById(DEBUG_HUD_ID);
  if (fsEl) {
    if (hudEl && !fsEl.contains(hudEl)) {
      fsEl.appendChild(hudEl);
    }
    if (overlayHostEl && !fsEl.contains(overlayHostEl)) {
      fsEl.appendChild(overlayHostEl);
    }
  } else {
    if (hudEl && hudEl.parentElement !== document.body) {
      document.body.appendChild(hudEl);
    }
    const player = getPlayerElement(true);
    if (player && overlayHostEl && !player.contains(overlayHostEl)) {
      player.appendChild(overlayHostEl);
    }
  }
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────
if (!initAll()) {
  pollForPlayer();
}
observePlayerReplacement();
initSpaNavigationListeners();
renderDebugHud();
