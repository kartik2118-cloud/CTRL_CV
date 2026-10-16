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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function sendToActiveTab(message) {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, message);
  } catch (e) {
    console.warn('[LiveSub Popup] Could not reach content script:', e.message);
  }
}

// ─── 1. Storage & Settings Initialization ─────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const toggleInput = document.getElementById('toggle-active');
  const toggleText = document.getElementById('toggle-state-text');
  const urlInput = document.getElementById('backend-url');
  const urlFeedback = document.getElementById('url-feedback');

  // Load configured backend URL and active state
  chrome.storage.local.get(['backend_url', 'livesub_active'], (items) => {
    if (items.backend_url) {
      urlInput.value = items.backend_url;
    }
    const isActive = items.livesub_active !== false; // Default: true
    toggleInput.checked = isActive;
    updateToggleLabel(isActive);
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
  document.getElementById('btn-demo')?.addEventListener('click', () => {
    sendToActiveTab({
      action: 'SHOW_SUBTITLE',
      text: 'आज हम पनीर टिक्का बनाएंगे।',
      translation: 'Today we will make paneer tikka.'
    });
  });

  document.getElementById('btn-clear')?.addEventListener('click', () => {
    sendToActiveTab({ action: 'CLEAR_SUBTITLE' });
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
