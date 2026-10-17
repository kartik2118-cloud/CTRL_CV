/**
 * popup.js — LiveSub popup controller (Stage 3).
 *
 * Responsibilities:
 * - Displays cloud speech transcription notice.
 * - Manages ON/OFF toggle switch (OFF stops capture, closes socket, hides overlay).
 * - Reads/saves backend WebSocket URL in chrome.storage.local.
 * - Handles Demo, Clear, and Cue Log export actions.
 */

'use strict';

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs && tabs[0]) return tabs[0];
  const lastTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return lastTabs?.[0] || null;
}

async function sendToActiveTab(message) {
  const tab = await getActiveTab();
  if (!tab?.id) return null;

  let resp = null;
  try {
    resp = await chrome.tabs.sendMessage(tab.id, message);
  } catch (_) {}

  // If content script was not reached or old content script ignored RUN_DEMO, re-inject!
  if (!resp || (message.action === 'RUN_DEMO' && resp?.status !== 'demo_started')) {
    if (chrome.scripting && tab.id) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['vendor/syncEngine.browser.js', 'content/pipeline.js', 'content/content.js']
        });
        await new Promise(r => setTimeout(r, 120));
        resp = await chrome.tabs.sendMessage(tab.id, message);
      } catch (injErr) {
        console.warn('[LiveSub Popup] Script injection fallback skipped:', injErr.message);
      }
    }
  }

  return resp;
}

// ─── 1. Storage & Settings Initialization ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const toggleInput = document.getElementById('toggle-active');
  const toggleText = document.getElementById('toggle-state-text');
  const urlInput = document.getElementById('backend-url');
  const urlFeedback = document.getElementById('url-feedback');
  const statusIndicator = document.getElementById('status-indicator');
  const statusText = document.getElementById('status-text');
  const sourceLangSelect = document.getElementById('source-lang');
  const targetLangSelect = document.getElementById('target-lang');

  function isUrlInvalid(url) {
    if (!url || typeof url !== 'string') return true;
    const trimmed = url.trim();
    if (!trimmed || trimmed.includes('REPLACE_ME')) return true;
    if (!trimmed.startsWith('ws://') && !trimmed.startsWith('wss://')) return true;
    return false;
  }

  function updateUrlBanner(url) {
    const banner = document.getElementById('url-error-banner');
    if (!banner) return;
    if (isUrlInvalid(url)) {
      banner.style.display = 'block';
    } else {
      banner.style.display = 'none';
    }
  }

  const defaultPlaceholder = (typeof DEFAULT_WS_URL !== 'undefined') ? DEFAULT_WS_URL : 'wss://REPLACE_ME/ws';
  if (urlInput) {
    urlInput.placeholder = defaultPlaceholder;
  }

  function setStatus(status, message = '') {
    if (!statusText || !statusIndicator) return;
    const normalized = status || 'Idle';
    statusIndicator.className = 'status-indicator ' + normalized.toLowerCase();
    if (normalized === 'Error' && message) {
      statusText.textContent = `Error: ${message}`;
      statusText.title = message;
    } else if (normalized === 'Connecting') {
      statusText.textContent = message || 'Connecting...';
      statusText.title = '';
    } else if (normalized === 'Streaming') {
      statusText.textContent = 'Streaming';
      statusText.title = '';
    } else {
      statusText.textContent = 'Idle';
      statusText.title = '';
    }
  }

  // Load configured backend URL, language options, and active state (default: OFF)
  chrome.storage.local.get(['backend_url', 'livesub_active', 'source_lang', 'target_lang', 'livesub_debug_hud'], (items) => {
    const currentUrl = items.backend_url || '';
    if (currentUrl) {
      urlInput.value = currentUrl;
    }
    updateUrlBanner(currentUrl || (defaultPlaceholder.includes('REPLACE_ME') ? '' : defaultPlaceholder));

    const isActive = items.livesub_active === true; // Default: false (OFF)
    // If URL is invalid, capture cannot be active
    if (isActive && isUrlInvalid(currentUrl || defaultPlaceholder)) {
      toggleInput.checked = false;
      updateToggleLabel(false);
      chrome.storage.local.set({ livesub_active: false });
    } else {
      toggleInput.checked = isActive;
      updateToggleLabel(isActive);
    }

    const hudCheckbox = document.getElementById('toggle-debug-hud');
    if (hudCheckbox) {
      hudCheckbox.checked = items.livesub_debug_hud !== false;
    }

    if (sourceLangSelect && items.source_lang) {
      sourceLangSelect.value = items.source_lang;
    }
    if (targetLangSelect && items.target_lang !== undefined) {
      targetLangSelect.value = items.target_lang;
    }
  });

  // Query background status
  try {
    chrome.runtime.sendMessage({ action: 'GET_STATUS' }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        setStatus('Idle');
      } else {
        setStatus(resp.status, resp.message);
        if (resp.last_error && resp.last_error !== 'none') {
          const errEl = document.getElementById('hud-error');
          if (errEl) errEl.textContent = resp.last_error;
        }
      }
    });
  } catch (_) {
    setStatus('Idle');
  }

  // Real-time status update listener
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && (msg.type === 'STATUS' || msg.action === 'STATUS')) {
      setStatus(msg.status, msg.message);
      if (msg.last_error || msg.message) {
        const errEl = document.getElementById('hud-error');
        if (errEl && (msg.last_error || msg.message)) errEl.textContent = msg.last_error || msg.message;
      }
      if (msg.ws_state) {
        const wsEl = document.getElementById('hud-ws');
        if (wsEl) wsEl.textContent = msg.ws_state;
      }
    }
  });

  // Debug HUD Toggle Listener
  const debugHudToggle = document.getElementById('toggle-debug-hud');
  debugHudToggle?.addEventListener('change', async () => {
    const visible = debugHudToggle.checked;
    await chrome.storage.local.set({ livesub_debug_hud: visible });
    sendToActiveTab({ action: 'TOGGLE_DEBUG_HUD', visible });
  });

  // Language selectors change listeners
  sourceLangSelect?.addEventListener('change', async () => {
    await chrome.storage.local.set({ source_lang: sourceLangSelect.value });
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'UPDATE_LANGUAGES',
      source_lang: sourceLangSelect.value,
      target_lang: targetLangSelect?.value
    }, () => {
      if (chrome.runtime.lastError) {}
    });
  });

  targetLangSelect?.addEventListener('change', async () => {
    await chrome.storage.local.set({ target_lang: targetLangSelect.value });
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'UPDATE_LANGUAGES',
      source_lang: sourceLangSelect?.value,
      target_lang: targetLangSelect.value
    }, () => {
      if (chrome.runtime.lastError) {}
    });
  });

  function updateToggleLabel(active) {
    toggleText.textContent = active ? 'ON' : 'OFF';
    if (active) {
      toggleText.classList.add('active');
    } else {
      toggleText.classList.remove('active');
    }
  }

  // ─── 2. ON/OFF Toggle Switch Handler ──────────────────────────────────────────
  toggleInput.addEventListener('change', async () => {
    const isActive = toggleInput.checked;
    const effectiveUrl = urlInput.value.trim() || defaultPlaceholder;

    // K3: Block starting capture if URL is REPLACE_ME or invalid
    if (isActive && isUrlInvalid(effectiveUrl)) {
      toggleInput.checked = false;
      updateToggleLabel(false);
      updateUrlBanner(effectiveUrl);
      setStatus('Error', 'Backend URL set nahi hai');
      await chrome.storage.local.set({ livesub_active: false });
      sendToActiveTab({ action: 'UPDATE_HUD_ERROR', error: 'Backend URL set nahi hai' });
      return;
    }

    updateToggleLabel(isActive);
    updateUrlBanner(effectiveUrl);

    // Persist preference
    await chrome.storage.local.set({ livesub_active: isActive });

    const tab = await getActiveTab();

    if (isActive) {
      // ON: Start capture session for active tab & unhide overlay
      setStatus('Connecting', 'Initializing capture...');
      if (tab?.id) {
        chrome.runtime.sendMessage({
          action: 'START_CAPTURE',
          targetTabId: tab.id
        }, (startResp) => {
          if (chrome.runtime.lastError) {
            const err = chrome.runtime.lastError.message;
            setStatus('Error', err);
            sendToActiveTab({ action: 'UPDATE_HUD_ERROR', error: err });
          } else if (startResp && !startResp.success) {
            const err = startResp.error || 'Failed to start capture';
            setStatus('Error', err);
            sendToActiveTab({ action: 'UPDATE_HUD_ERROR', error: err });
          }
        });
        chrome.tabs.sendMessage(tab.id, {
          action: 'SET_ENABLED',
          enabled: true
        }, () => {
          if (chrome.runtime.lastError) {}
        });
      }
    } else {
      // OFF: Close socket, stop capture, hide overlay
      setStatus('Idle', '');
      chrome.runtime.sendMessage({ action: 'STOP_CAPTURE' }, () => {
        if (chrome.runtime.lastError) {}
      });
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, { action: 'CLEAR_SUBTITLE' }, () => {
          if (chrome.runtime.lastError) {}
        });
        chrome.tabs.sendMessage(tab.id, {
          action: 'SET_ENABLED',
          enabled: false
        }, () => {
          if (chrome.runtime.lastError) {}
        });
      }
    }
  });

  // ─── 3. Backend URL Save Handler ──────────────────────────────────────────────
  const saveUrl = async () => {
    const rawVal = urlInput.value.trim();
    if (isUrlInvalid(rawVal)) {
      updateUrlBanner(rawVal);
      urlFeedback.textContent = 'Backend URL set nahi hai';
      urlFeedback.style.color = '#ef4444';
      return;
    }
    updateUrlBanner(rawVal);
    await chrome.storage.local.set({ backend_url: rawVal });

    urlFeedback.textContent = 'Saved to storage';
    urlFeedback.style.color = '#22c55e';
    setTimeout(() => {
      urlFeedback.textContent = '';
    }, 2500);
  };

  // Poll active tab for HUD telemetry every 500ms
  async function updatePopupHudTelemetry() {
    const resp = await sendToActiveTab({ action: 'GET_HUD_TELEMETRY' });
    if (resp && resp.telemetry) {
      const t = resp.telemetry;
      const chunksEl = document.getElementById('hud-chunks');
      const resultsEl = document.getElementById('hud-results');
      const epochEl = document.getElementById('hud-epoch');
      const ageEl = document.getElementById('hud-age');
      const wsEl = document.getElementById('hud-ws');
      const errEl = document.getElementById('hud-error');

      if (chunksEl) chunksEl.textContent = t.chunks_sent ?? 0;
      if (resultsEl) resultsEl.textContent = t.results_received ?? 0;
      if (epochEl) epochEl.textContent = t.epoch ?? 1;
      if (ageEl) ageEl.textContent = t.last_result_age_s ? `${t.last_result_age_s}s` : 'n/a';
      if (wsEl) wsEl.textContent = t.ws_state ?? 'disconnected';
      if (errEl) errEl.textContent = t.last_error ?? 'none';
    }
  }
  setInterval(updatePopupHudTelemetry, 500);

  document.getElementById('btn-save-url')?.addEventListener('click', saveUrl);
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      saveUrl();
    }
  });

  // ─── 4. Demo & Clear Subtitle Buttons ─────────────────────────────────────────
  let popupDemoTimer = null;
  function runPopupDemo(lang = 'hindi') {
    if (popupDemoTimer) {
      clearTimeout(popupDemoTimer);
      popupDemoTimer = null;
    }

    const card = document.getElementById('demo-preview-card');
    const badge = document.getElementById('demo-preview-badge');
    const source = document.getElementById('demo-preview-source');
    const trans = document.getElementById('demo-preview-trans');
    if (!card || !source) return;

    const DEMO_SEQUENCES = {
      hindi: [
        { text: 'नमस्ते! LiveSub में आपका स्वागत है।', translation: 'Welcome to LiveSub real-time transcription.', lang: 'HI / EN' },
        { text: 'यह तकनीक स्वचालित रूप से भाषा पहचानती है।', translation: 'This technology automatically detects and translates speech.', lang: 'HI / EN' },
        { text: 'आज हम स्वादिष्ट पनीर टिक्का रेसिपी देखेंगे।', translation: 'Today we will explore a delicious paneer tikka recipe.', lang: 'HI / EN' },
        { text: 'सेटिंग्स से आप फॉन्ट का आकार और स्थिति बदल सकते हैं।', translation: 'You can adjust font size and position from settings.', lang: 'HI / EN' }
      ],
      marathi: [
        { text: 'नमस्कार! LiveSub मध्ये आपले स्वागत आहे.', translation: 'Welcome to LiveSub real-time transcription.', lang: 'MR / EN' },
        { text: 'ही प्रणाली व्हिडिओचे थेट भाषांतर करते.', translation: 'This system provides live video translation.', lang: 'MR / EN' },
        { text: 'आज आपण पनीर टिक्का बनवणार आहोत.', translation: 'Today we will make paneer tikka.', lang: 'MR / EN' }
      ],
      english: [
        { text: 'Welcome to LiveSub Real-Time Subtitles!', translation: 'AI-powered speech recognition and synchronization.', lang: 'EN' },
        { text: 'Zero-latency subtitle rendering with exact video sync.', translation: 'Adaptive seeking and epoch tracking active.', lang: 'EN' },
        { text: 'Multilingual dual-row subtitles for any YouTube video.', translation: 'Hindi, Marathi, Tamil, Telugu, and English supported.', lang: 'EN' }
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

    const key = LANG_ALIASES[(lang || 'hindi').toLowerCase()] || 'hindi';
    const seq = DEMO_SEQUENCES[key] || DEMO_SEQUENCES['hindi'];

    card.style.display = 'block';
    let idx = 0;

    function renderNext() {
      if (idx >= seq.length) {
        popupDemoTimer = setTimeout(() => {
          card.style.display = 'none';
        }, 3000);
        return;
      }
      const item = seq[idx];
      if (badge) badge.textContent = item.lang || 'LIVE DEMO';
      if (source) source.textContent = item.text;
      if (trans) trans.textContent = item.translation || '';
      idx++;
      popupDemoTimer = setTimeout(renderNext, 2800);
    }

    renderNext();
  }

  function stopPopupDemo() {
    if (popupDemoTimer) {
      clearTimeout(popupDemoTimer);
      popupDemoTimer = null;
    }
    const card = document.getElementById('demo-preview-card');
    if (card) card.style.display = 'none';
  }

  document.getElementById('btn-demo')?.addEventListener('click', async () => {
    const srcLang = sourceLangSelect?.value || 'hi';
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
    const langKey = LANG_ALIASES[srcLang.toLowerCase()] || 'hindi';

    // 1. Immediately run animated preview directly inside popup
    runPopupDemo(langKey);

    // 2. Dispatch to active video tab
    await sendToActiveTab({
      action: 'RUN_DEMO',
      lang: langKey
    });
  });

  document.getElementById('btn-clear')?.addEventListener('click', async () => {
    stopPopupDemo();
    await sendToActiveTab({ action: 'CLEAR_SUBTITLE' });
  });

  // ─── 5. Export Cue Log ────────────────────────────────────────────────────────
  document.getElementById('btn-export-log')?.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab?.id) return;
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { action: 'EXPORT_CUE_LOG' });
      if (resp && resp.cueLog) {
        const blob = new Blob([JSON.stringify(resp.cueLog, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `cue_log_${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      console.warn('[LiveSub Popup] Could not export cue log:', e.message);
    }
  });
});
