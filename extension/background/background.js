/**
 * background.js - MV3 Service Worker
 * Manages tab audio capture stream delegation to offscreen document
 * and routes cue events between offscreen, content scripts, and popup.
 */

let activeTabId = null;
let isCapturing = false;
let currentWsState = "disconnected";

// Check if offscreen document exists
async function hasOffscreenDocument() {
  if ('getContexts' in chrome.runtime) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('offscreen/offscreen.html')]
    });
    return Boolean(contexts.length);
  } else {
    const matchedClients = await clients.matchAll();
    return matchedClients.some(c => c.url.includes('offscreen/offscreen.html'));
  }
}

// Create offscreen document safely
async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }
  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Capture and process tab audio for real-time multilingual subtitles'
  });
  // Wait for offscreen document to mount and register message listeners
  await new Promise(r => setTimeout(r, 250));
}

// Callback wrapper for chrome.tabCapture.getMediaStreamId
function getTabStreamId(targetTabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId }, (streamId) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (!streamId) {
        return reject(new Error('Failed to obtain stream ID from tabCapture. Make sure the YouTube video tab is active and focused.'));
      }
      resolve(streamId);
    });
  });
}

// Send message to offscreen with retries in case document is mounting
async function sendToOffscreenWithRetry(message, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (res) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(res);
          }
        });
      });
      return response;
    } catch (e) {
      if (i === maxRetries - 1) throw e;
      await new Promise(r => setTimeout(r, 150));
    }
  }
}

// Start tab capture
async function startCapture(tabId, config = {}, existingStreamId = null) {
  try {
    let effectiveTabId = tabId || activeTabId;
    if (!effectiveTabId) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      effectiveTabId = tabs?.[0]?.id || null;
    }
    activeTabId = effectiveTabId;
    
    // Ensure offscreen document is ready
    await ensureOffscreenDocument();

    // 1. Get MediaStreamId (use pre-obtained streamId from popup user gesture or fetch)
    let streamId = existingStreamId;
    if (!streamId && effectiveTabId) {
      streamId = await getTabStreamId(effectiveTabId);
    }
    console.log('[LiveSub Background] Using stream ID:', streamId);

    // Read stored preferences if not supplied in config
    const stored = await chrome.storage.local.get(['backend_url', 'source_lang', 'target_lang']);
    const effectiveWsUrl = config?.wsUrl || stored.backend_url || 'ws://127.0.0.1:8000/ws';
    const effectiveSource = config?.sourceLanguage || stored.source_lang || 'auto';
    const effectiveTarget = config?.targetLanguage || stored.target_lang || 'none';

    // 2. Send to offscreen document with retry
    const offscreenRes = await sendToOffscreenWithRetry({
      target: 'offscreen',
      type: 'START_OFFSCREEN_CAPTURE',
      streamId: streamId,
      targetTabId: effectiveTabId,
      wsUrl: effectiveWsUrl,
      sourceLanguage: effectiveSource,
      targetLanguage: effectiveTarget,
      epoch: config?.epoch !== undefined ? config.epoch : 0
    });

    if (offscreenRes && offscreenRes.success === false) {
      throw new Error(offscreenRes.error || 'Offscreen document audio capture failed.');
    }

    isCapturing = true;
    currentWsState = "connecting";

    // Notify content script
    if (activeTabId) {
      chrome.tabs.sendMessage(activeTabId, {
        type: 'CAPTURE_STATUS_CHANGED',
        action: 'CAPTURE_STATUS_CHANGED',
        isCapturing: true
      }).catch(() => {});
    }

    return { success: true };
  } catch (err) {
    console.error('[LiveSub Background] Failed to start capture:', err);
    isCapturing = false;
    currentWsState = "error";
    return { success: false, error: err.message };
  }
}

// Stop capture
async function stopCapture() {
  isCapturing = false;
  currentWsState = "disconnected";
  
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP_OFFSCREEN_CAPTURE' }).catch(() => {});
  
  if (activeTabId) {
    chrome.tabs.sendMessage(activeTabId, {
      type: 'CAPTURE_STATUS_CHANGED',
      action: 'CAPTURE_STATUS_CHANGED',
      isCapturing: false
    }).catch(() => {});
  }
  
  if (await hasOffscreenDocument()) {
    try {
      await chrome.offscreen.closeDocument();
    } catch (e) {}
  }
  return { success: true };
}

// Message routing
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;
  const msgType = message.type || message.action;
  const targetTab = message.tabId || message.targetTabId || sender.tab?.id || activeTabId;

  if (msgType === 'START_CAPTURE') {
    startCapture(targetTab, message.config, message.streamId).then(sendResponse);
    return true; // Keep channel open for async response
  }

  if (msgType === 'STOP_CAPTURE') {
    stopCapture().then(sendResponse);
    return true;
  }

  if (msgType === 'GET_STATUS') {
    sendResponse({
      isCapturing,
      activeTabId,
      wsState: currentWsState,
      status: isCapturing ? (currentWsState === 'connected' ? 'Streaming' : 'Connecting') : 'Idle'
    });
    return false;
  }

  // Update WS state from offscreen
  if (msgType === 'WS_STATE_CHANGED' || msgType === 'STATUS') {
    currentWsState = message.state || message.ws_state || currentWsState;
    if (activeTabId) {
      chrome.tabs.sendMessage(activeTabId, {
        type: 'WS_STATE_CHANGED',
        action: 'WS_STATE_CHANGED',
        state: currentWsState
      }).catch(() => {});
    }
  }

  // Forward cue results from offscreen to content script
  if (type === 'CUE_RESULT' || type === 'RESULT') {
    const cue = message.cue || message.result;
    if (activeTabId && cue) {
      chrome.tabs.sendMessage(activeTabId, {
        type: 'RENDER_CUE',
        action: 'RENDER_CUE',
        cue: cue
      }).catch(() => {});
    }
  }

  // Forward chunk sent events to content script for HUD telemetry
  if (type === 'CHUNK_SENT') {
    if (activeTabId) {
      chrome.tabs.sendMessage(activeTabId, {
        type: 'CHUNK_SENT',
        action: 'CHUNK_SENT',
        chunkInfo: message.chunkInfo || message
      }).catch(() => {});
    }
  }

  // Forward video timeline state observation from content script to offscreen
  if (type === 'VIDEO_STATE_OBSERVATION') {
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'VIDEO_STATE_OBSERVATION',
      observation: message.observation
    }).catch(() => {});
  }

  // Forward playback control events (seek, navigation) from content script to offscreen
  if (type === 'TIMELINE_EVENT') {
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'TIMELINE_EVENT',
      event: message.event
    }).catch(() => {});
  }
});
