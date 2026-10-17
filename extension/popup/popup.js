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
  chrome.storage.local.get(['backend_url', 'livesub_active', 'source_lang', 'target_lang'], (items) => {
    if (items.backend_url) {
      urlInput.value = items.backend_url;
    }
    const isActive = items.livesub_active === true; // Default: false (OFF)
    toggleInput.checked = isActive;
    updateToggleLabel(isActive);

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
      }
    });
  } catch (_) {
    setStatus('Idle');
  }

  // Real-time status update listener
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && (msg.type === 'STATUS' || msg.action === 'STATUS')) {
      setStatus(msg.status, msg.message);
    }
  });

  // Language selectors change listeners
  sourceLangSelect?.addEventListener('change', async () => {
    await chrome.storage.local.set({ source_lang: sourceLangSelect.value });
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'UPDATE_LANGUAGES',
      source_lang: sourceLangSelect.value,
      target_lang: targetLangSelect?.value
    }).catch(() => {});
  });

  targetLangSelect?.addEventListener('change', async () => {
    await chrome.storage.local.set({ target_lang: targetLangSelect.value });
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'UPDATE_LANGUAGES',
      source_lang: sourceLangSelect?.value,
      target_lang: targetLangSelect.value
    }).catch(() => {});
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
    updateToggleLabel(isActive);

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
        }).catch(() => {});
        chrome.tabs.sendMessage(tab.id, {
          action: 'SET_ENABLED',
          enabled: true
        }).catch(() => {});
      }
    } else {
      // OFF: Close socket, stop capture, hide overlay
      setStatus('Idle', '');
      chrome.runtime.sendMessage({ action: 'STOP_CAPTURE' }).catch(() => {});
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, { action: 'CLEAR_SUBTITLE' }).catch(() => {});
        chrome.tabs.sendMessage(tab.id, {
          action: 'SET_ENABLED',
          enabled: false
        }).catch(() => {});
      }
    }
  });

  // ─── 3. Backend URL Save Handler ──────────────────────────────────────────────
  const saveUrl = async () => {
    const rawVal = urlInput.value.trim();
    const finalUrl = rawVal || 'ws://localhost:8000/ws';
    await chrome.storage.local.set({ backend_url: finalUrl });

    urlFeedback.textContent = 'Saved to storage';
    urlFeedback.style.color = '#22c55e';
    setTimeout(() => {
      urlFeedback.textContent = '';
    }, 2500);
  };

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

    const key = (lang || 'hindi').toLowerCase();
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
    const srcLang = sourceLangSelect?.value || 'hindi';
    const langKey = srcLang === 'auto' ? 'hindi' : srcLang;

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
