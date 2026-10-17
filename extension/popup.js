/**
 * popup.js — LiveSub Extension Popup Controller
 * Manages Tab Audio Capture toggle, Subtitle Overlay Demo/Clear, and Cue Log Export.
 */
'use strict';

let isCapturing = false;

const btnCapture = document.getElementById('btn-toggle-capture');
const badge = document.getElementById('capture-badge');
const btnDemo = document.getElementById('btn-demo');
const btnClear = document.getElementById('btn-clear');
const btnExport = document.getElementById('btn-export-log');

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function sendToActiveTab(message) {
  const tab = await getActiveTab();
  if (!tab?.id) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (e) {
    console.warn('[LiveSub Popup] Could not reach content script:', e.message);
    return null;
  }
}

function updateUiState(capturing) {
  isCapturing = capturing;
  if (isCapturing) {
    badge.textContent = 'CAPTURING';
    badge.classList.add('active');
    btnCapture.textContent = '⏹ Stop Subtitles';
    btnCapture.classList.add('stop');
  } else {
    badge.textContent = 'IDLE';
    badge.classList.remove('active');
    btnCapture.textContent = '▶ Start Live Subtitles';
    btnCapture.classList.remove('stop');
  }
}

async function refreshStatus() {
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'GET_STATUS' });
    if (resp) {
      updateUiState(!!resp.isCapturing);
    }
  } catch (_) {
    updateUiState(false);
  }
}

// Toggle Live Audio Capture
btnCapture.addEventListener('click', async () => {
  btnCapture.disabled = true;
  try {
    if (!isCapturing) {
      const tab = await getActiveTab();
      if (!tab?.id) {
        alert('Please open an active YouTube video tab first.');
        return;
      }
      const resp = await chrome.runtime.sendMessage({
        action: 'START_CAPTURE',
        targetTabId: tab.id
      });
      if (resp && resp.success) {
        updateUiState(true);
      } else {
        alert('Failed to start capture: ' + ((resp && resp.error) || 'Unknown error'));
      }
    } else {
      const resp = await chrome.runtime.sendMessage({ action: 'STOP_CAPTURE' });
      if (resp && resp.success) {
        updateUiState(false);
      }
    }
  } catch (err) {
    console.error('[LiveSub Popup] Capture toggle error:', err);
  } finally {
    btnCapture.disabled = false;
  }
});

// Demo & Clear
btnDemo.addEventListener('click', () => {
  sendToActiveTab({
    action: 'SHOW_SUBTITLE',
    text: 'आज हम पनीर टिक्का बनाएंगे।',
    translation: 'Today we will make paneer tikka.'
  });
});

btnClear.addEventListener('click', () => {
  sendToActiveTab({ action: 'CLEAR_SUBTITLE' });
});

// Export Cue Log JSON for Judges
btnExport.addEventListener('click', async () => {
  btnExport.textContent = 'Exporting...';
  try {
    // 1. Try to get cue log from active content script (SyncBridge)
    const resp = await sendToActiveTab({ action: 'EXPORT_CUE_LOG' });
    const cues = (resp && resp.cues) || [];

    // 2. Fallback to background/offscreen diagnostics if bridge was idle
    let jsonStr = '';
    if (cues.length > 0) {
      jsonStr = JSON.stringify(cues, null, 2);
    } else {
      const diagResp = await chrome.runtime.sendMessage({ action: 'EXPORT_DIAGNOSTICS' });
      if (diagResp && diagResp.jsonl) {
        jsonStr = diagResp.jsonl;
      } else {
        jsonStr = JSON.stringify([], null, 2);
      }
    }

    // Trigger browser download
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cue_log_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error('[LiveSub Popup] Export error:', err);
  } finally {
    btnExport.textContent = '💾 Export Cue Log (JSON)';
  }
});

// Check status on popup open
refreshStatus();
