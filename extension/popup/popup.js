/**
 * popup.js - Extension popup logic
 * Controls tab capture initiation, settings persistence,
 * dynamic content script injection, and cue log / SRT exports.
 */

let activeTab = null;
let isCapturing = false;

document.addEventListener('DOMContentLoaded', async () => {
  activeTab = await getActiveTab();

  if (activeTab && activeTab.id && activeTab.url && activeTab.url.includes('youtube.com')) {
    await ensureContentScriptInjected(activeTab.id);
  }

  // Restore saved preferences
  chrome.storage.local.get(['sourceLang', 'source_lang', 'targetLang', 'target_lang', 'wsUrl', 'backend_url'], (res) => {
    const src = res.sourceLang || res.source_lang;
    const tgt = res.targetLang || res.target_lang;
    const url = res.wsUrl || res.backend_url;
    if (src) {
      const el = document.getElementById('select-source-lang');
      if (el) el.value = src;
    }
    if (tgt) {
      const el = document.getElementById('select-target-lang');
      if (el) el.value = tgt;
    }
    if (url) {
      const el = document.getElementById('input-ws-url');
      if (el) el.value = url;
    }
  });

  // Query background status
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (status) => {
    if (status && status.isCapturing) {
      isCapturing = true;
      setCaptureButtonState(true);
      updateStatusBadge('Streaming', 'active');
    } else {
      isCapturing = false;
      setCaptureButtonState(false);
      updateStatusBadge('Standby', 'inactive');
    }
  });

  setupEventListeners();
});

async function getActiveTab() {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  }
  return tab;
}

async function ensureContentScriptInjected(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'PING', action: 'PING' });
    if (res && res.status === 'pong') return;
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['vendor/syncEngine.browser.js', 'content/caption_path.js', 'content/pipeline.js', 'content/content.js']
      });
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['content/content.css', 'content/overlay.css']
      });
    } catch (err) {
      console.warn('[LiveSub Popup] Dynamic script injection notice:', err);
    }
  }
}

function getMediaStreamIdFromPopup(targetTabId) {
  return new Promise((resolve) => {
    if (!chrome.tabCapture || !chrome.tabCapture.getMediaStreamId) {
      resolve(null);
      return;
    }
    try {
      chrome.tabCapture.getMediaStreamId({ targetTabId }, (streamId) => {
        if (chrome.runtime.lastError || !streamId) {
          console.warn('[LiveSub Popup] tabCapture warning:', chrome.runtime.lastError);
          resolve(null);
        } else {
          resolve(streamId);
        }
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function setupEventListeners() {
  const toggleBtn = document.getElementById('btn-toggle-capture');
  const demoBtn = document.getElementById('btn-test-overlay');
  const clearBtn = document.getElementById('btn-clear-overlay');
  const exportLogBtn = document.getElementById('btn-export-log');
  const exportSrtBtn = document.getElementById('btn-export-srt');

  if (toggleBtn) toggleBtn.addEventListener('click', handleToggleCapture);
  if (demoBtn) demoBtn.addEventListener('click', handleTestOverlay);
  if (clearBtn) clearBtn.addEventListener('click', handleClearOverlay);
  if (exportLogBtn) exportLogBtn.addEventListener('click', handleExportCueLog);
  if (exportSrtBtn) exportSrtBtn.addEventListener('click', handleExportSrt);

  // Auto-save settings on change
  ['select-source-lang', 'select-target-lang', 'input-ws-url'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', saveSettings);
  });
}

function saveSettings() {
  const sourceLang = document.getElementById('select-source-lang')?.value || 'hi';
  const targetLang = document.getElementById('select-target-lang')?.value || 'en';
  const wsUrl = document.getElementById('input-ws-url')?.value.trim() || 'ws://127.0.0.1:8000/ws';

  chrome.storage.local.set({
    sourceLang,
    source_lang: sourceLang,
    targetLang,
    target_lang: targetLang,
    wsUrl,
    backend_url: wsUrl
  });

  if (activeTab && activeTab.id) {
    chrome.tabs.sendMessage(activeTab.id, {
      type: 'SET_SETTINGS',
      targetLanguage: targetLang
    }).catch(() => {});
  }
}

async function handleToggleCapture() {
  activeTab = await getActiveTab();
  if (!activeTab || !activeTab.id) {
    alert('Please switch to an active YouTube video tab and click the extension icon again.');
    return;
  }

  const toggleBtn = document.getElementById('btn-toggle-capture');
  saveSettings();

  const sourceLang = document.getElementById('select-source-lang')?.value || 'hi';
  const targetLang = document.getElementById('select-target-lang')?.value || 'en';
  const wsUrl = document.getElementById('input-ws-url')?.value.trim() || 'ws://127.0.0.1:8000/ws';

  if (!isCapturing) {
    toggleBtn.disabled = true;
    toggleBtn.innerHTML = '<span>⏳</span> Connecting...';

    await ensureContentScriptInjected(activeTab.id);

    // Acquire streamId under user gesture context in popup
    const popupStreamId = await getMediaStreamIdFromPopup(activeTab.id);

    chrome.runtime.sendMessage({
      type: 'START_CAPTURE',
      tabId: activeTab.id,
      streamId: popupStreamId,
      config: { sourceLanguage: sourceLang, targetLanguage: targetLang, wsUrl }
    }, (res) => {
      toggleBtn.disabled = false;
      if (res && res.success) {
        isCapturing = true;
        setCaptureButtonState(true);
        updateStatusBadge('Streaming', 'active');
      } else {
        const errorMsg = res && res.error ? res.error : 'Failed to start capture. Ensure you are on a YouTube video tab.';
        alert(errorMsg);
        setCaptureButtonState(false);
        updateStatusBadge('Error', 'inactive');
      }
    });
  } else {
    chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' }, () => {
      isCapturing = false;
      setCaptureButtonState(false);
      updateStatusBadge('Standby', 'inactive');
    });
  }
}

function setCaptureButtonState(capturing) {
  const toggleBtn = document.getElementById('btn-toggle-capture');
  if (!toggleBtn) return;
  if (capturing) {
    toggleBtn.className = 'btn btn-danger';
    toggleBtn.innerHTML = '<span>⏹</span> Stop Audio Capture';
  } else {
    toggleBtn.className = 'btn btn-primary';
    toggleBtn.innerHTML = '<span>▶</span> Start Audio Capture';
  }
}

function updateStatusBadge(text, state) {
  const statusText = document.getElementById('status-text');
  const pill = document.getElementById('status-pill');
  if (statusText && pill) {
    statusText.textContent = text;
    if (state === 'active') {
      pill.style.background = 'rgba(34, 197, 94, 0.15)';
      pill.style.color = '#22c55e';
    } else {
      pill.style.background = 'rgba(148, 163, 184, 0.15)';
      pill.style.color = '#94a3b8';
    }
  }
}

async function handleTestOverlay() {
  activeTab = await getActiveTab();
  if (!activeTab || !activeTab.id) return;
  const sourceLang = document.getElementById('select-source-lang')?.value || 'hi';

  await ensureContentScriptInjected(activeTab.id);
  chrome.tabs.sendMessage(activeTab.id, {
    action: 'RUN_DEMO',
    type: 'RUN_DEMO',
    lang: sourceLang
  }).catch(() => {});
}

async function handleClearOverlay() {
  activeTab = await getActiveTab();
  if (!activeTab || !activeTab.id) return;

  chrome.tabs.sendMessage(activeTab.id, {
    action: 'STOP_DEMO',
    type: 'STOP_DEMO'
  }).catch(() => {});
}

async function handleExportCueLog() {
  activeTab = await getActiveTab();
  if (!activeTab || !activeTab.id) {
    alert('Please switch to an active YouTube video tab and click the extension icon again.');
    return;
  }

  const exportBtn = document.getElementById('btn-export-log');
  if (exportBtn) {
    exportBtn.disabled = true;
    exportBtn.innerHTML = '<span>⏳</span> Exporting...';
  }

  await ensureContentScriptInjected(activeTab.id);

  chrome.tabs.sendMessage(activeTab.id, { action: 'GET_CUE_LOG', type: 'GET_CUE_LOG' }, (res) => {
    if (exportBtn) {
      exportBtn.disabled = false;
      exportBtn.innerHTML = '<span>📥</span> Cue Log (JSON)';
    }

    if (!res || !res.cues || res.cues.length === 0) {
      alert('No subtitles or captions found for this video yet.\n\nTip: Click "▶ Start Audio Capture" to generate real-time subtitles, or open a video with caption tracks.');
      return;
    }

    const blob = new Blob([JSON.stringify(res, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const dlAnchor = document.createElement('a');
    dlAnchor.href = url;
    const vidId = res.videoId || 'youtube';
    dlAnchor.download = `livesub_cuelog_${vidId}_${Date.now()}.json`;
    document.body.appendChild(dlAnchor);
    dlAnchor.click();
    dlAnchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

function formatSrtTimestamp(seconds) {
  const pad = (num, size = 2) => String(num).padStart(size, '0');
  const secNum = Math.max(0, Number(seconds) || 0);
  const hrs = Math.floor(secNum / 3600);
  const mins = Math.floor((secNum % 3600) / 60);
  const secs = Math.floor(secNum % 60);
  const millis = Math.floor((secNum % 1) * 1000);
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${pad(millis, 3)}`;
}

async function handleExportSrt() {
  activeTab = await getActiveTab();
  if (!activeTab || !activeTab.id) {
    alert('Please switch to an active YouTube video tab and click the extension icon again.');
    return;
  }

  const exportBtn = document.getElementById('btn-export-srt');
  if (exportBtn) {
    exportBtn.disabled = true;
    exportBtn.innerHTML = '<span>⏳</span> Exporting...';
  }

  await ensureContentScriptInjected(activeTab.id);

  chrome.tabs.sendMessage(activeTab.id, { action: 'GET_CUE_LOG', type: 'GET_CUE_LOG' }, (res) => {
    if (exportBtn) {
      exportBtn.disabled = false;
      exportBtn.innerHTML = '<span>📄</span> Subtitles (SRT)';
    }

    if (!res || !res.cues || res.cues.length === 0) {
      alert('No subtitles or captions found for this video yet.\n\nTip: Click "▶ Start Audio Capture" to generate real-time subtitles, or open a video with caption tracks.');
      return;
    }

    let srtContent = '';
    res.cues.forEach((cue, index) => {
      const start = formatSrtTimestamp(cue.start || 0);
      const end = formatSrtTimestamp(cue.end || (cue.start + 2.0));
      const text = (cue.text || '').trim();
      const translation = (cue.translation && cue.translation.trim() !== text) ? `\n${cue.translation.trim()}` : '';
      if (text) {
        srtContent += `${index + 1}\n${start} --> ${end}\n${text}${translation}\n\n`;
      }
    });

    const blob = new Blob([srtContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const dlAnchor = document.createElement('a');
    dlAnchor.href = url;
    const vidId = res.videoId || 'youtube';
    dlAnchor.download = `livesub_subtitles_${vidId}_${Date.now()}.srt`;
    document.body.appendChild(dlAnchor);
    dlAnchor.click();
    dlAnchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}
