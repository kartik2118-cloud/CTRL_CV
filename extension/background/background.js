/**
 * background.js — LiveSub service worker
 * Role B: Tab audio capture (tabCapture + offscreen document, audible passthrough)
 * Integrated with message routing scaffold.
 *
 * Do NOT add API keys, remote script loads, or audio downloads here.
 */

'use strict';

// ─── Install / Startup ────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.log('[LiveSub BG] Installed, reason:', reason);
});

// ─── Message router (scaffold — teammates will register their own handlers) ───
const _handlers = {};

function registerHandler(action, fn) {
  if (_handlers[action]) {
    console.warn('[LiveSub BG] Overwriting handler for action:', action);
  }
  _handlers[action] = fn;
}

// ─── Role B: Tab Audio Capture & Offscreen Management ─────────────────────────
let captureSession = null; // { targetTabId: number, state: 'idle' | 'starting' | 'capturing' | 'stopping' }
let creatingOffscreenPromise = null;
let currentAppStatus = { status: 'Idle', message: '' };

function broadcastStatus(status, message = '') {
  currentAppStatus = { status, message };
  chrome.runtime.sendMessage({ type: 'STATUS', status, message }).catch(() => {});
}

const OFFSCREEN_DOCUMENT_PATH = 'offscreen/offscreen.html';

async function ensureOffscreenDocument() {
  const hasDoc = await chrome.offscreen.hasDocument();
  if (hasDoc) {
    return;
  }

  if (creatingOffscreenPromise) {
    await creatingOffscreenPromise;
    return;
  }

  creatingOffscreenPromise = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Capturing tab audio stream for subtitle synchronization and local audible passthrough.'
  });

  try {
    await creatingOffscreenPromise;
  } finally {
    creatingOffscreenPromise = null;
  }
}

async function closeOffscreenDocumentSafely() {
  try {
    const hasDoc = await chrome.offscreen.hasDocument();
    if (hasDoc) {
      await chrome.offscreen.closeDocument();
    }
  } catch (err) {
    console.warn('[LiveSub BG] Error closing offscreen document:', err);
  }
}

async function sendMessageToOffscreenWithRetry(message, maxAttempts = 25, intervalMs = 100) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await chrome.runtime.sendMessage(message);
      if (resp !== undefined) {
        return resp;
      }
    } catch (err) {
      if (attempt === maxAttempts) {
        throw err;
      }
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error('No response received from offscreen document');
}

const CURRENT_CONTENT_BUILD = 10;

async function ensureContentScript(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { action: 'GET_STATUS' });
    if (ping && ping.isAttached !== undefined && ping.build === CURRENT_CONTENT_BUILD) return;
  } catch (_) {}

  try {
    if (chrome.scripting) {
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['content/content.css']
      }).catch(() => {});
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [
          'vendor/syncEngine.browser.js',
          'content/pipeline.js',
          'content/content.js'
        ]
      });
      console.log(`[LiveSub BG] Injected content scripts (build ${CURRENT_CONTENT_BUILD}) into tab ${tabId}`);
    }
  } catch (err) {
    console.warn(`[LiveSub BG] Script injection fallback skipped:`, err?.message || err);
  }
}

async function handleStartCapture(targetTabId) {
  if (captureSession && (captureSession.state === 'capturing' || captureSession.state === 'starting')) {
    console.warn('[LiveSub BG] Capture already active for tab', captureSession.targetTabId);
    return {
      success: true,
      message: 'Capture already active',
      targetTabId: captureSession.targetTabId,
      state: captureSession.state
    };
  }

  captureSession = {
    targetTabId,
    state: 'starting',
    startedAt: Date.now()
  };

  try {
    const tab = await chrome.tabs.get(targetTabId);
    if (!tab) {
      throw new Error(`Tab ${targetTabId} not found`);
    }

    await ensureContentScript(targetTabId);
    await ensureOffscreenDocument();

    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId }, (id) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (!id) {
          return reject(new Error('Failed to obtain stream ID from tabCapture'));
        }
        resolve(id);
      });
    });

    const offscreenResp = await sendMessageToOffscreenWithRetry({
      target: 'offscreen',
      type: 'START_OFFSCREEN_CAPTURE',
      streamId: streamId,
      targetTabId: targetTabId
    });

    if (!offscreenResp || !offscreenResp.success) {
      throw new Error((offscreenResp && offscreenResp.error) || 'Failed to start offscreen stream capture');
    }

    captureSession.state = 'capturing';
    broadcastStatus('Streaming', 'Active');
    console.log(`[LiveSub BG] Successfully started tabCapture for tab ${targetTabId}`);
    return {
      success: true,
      targetTabId: targetTabId,
      actualSampleRate: offscreenResp.actualSampleRate
    };
  } catch (err) {
    console.error('[LiveSub BG] Failed to start capture:', err);
    captureSession = null;
    broadcastStatus('Error', err.message || String(err));
    await closeOffscreenDocumentSafely();
    return {
      success: false,
      error: err.message || String(err)
    };
  }
}

async function handleStopCapture() {
  broadcastStatus('Idle', '');
  if (!captureSession && !(await chrome.offscreen.hasDocument())) {
    return { success: true, message: 'Capture not running' };
  }

  try {
    const hasDoc = await chrome.offscreen.hasDocument();
    if (hasDoc) {
      try {
        await sendMessageToOffscreenWithRetry({
          target: 'offscreen',
          type: 'STOP_OFFSCREEN_CAPTURE'
        }, 3, 50);
      } catch (offErr) {
        console.warn('[LiveSub BG] Could not communicate stop to offscreen doc:', offErr);
      }
      await closeOffscreenDocumentSafely();
    }
  } catch (err) {
    console.warn('[LiveSub BG] Error during offscreen shutdown:', err);
  } finally {
    captureSession = null;
  }

  console.log('[LiveSub BG] Capture stopped cleanly.');
  return { success: true };
}

// Register Role B Handlers
registerHandler('START_CAPTURE', (msg, sender, sendResponse) => {
  const tabId = msg.targetTabId || (sender.tab && sender.tab.id);
  if (!tabId) {
    sendResponse({ success: false, error: 'targetTabId is required' });
    return true;
  }
  broadcastStatus('Connecting', 'Initializing capture...');
  handleStartCapture(tabId).then(sendResponse);
  return true;
});

registerHandler('STOP_CAPTURE', (msg, sender, sendResponse) => {
  handleStopCapture().then(sendResponse);
  return true;
});

registerHandler('STATUS', (msg) => {
  currentAppStatus = { status: msg.status || 'Idle', message: msg.message || '' };
  chrome.runtime.sendMessage({ type: 'STATUS', ...currentAppStatus }).catch(() => {});
});

registerHandler('GET_STATUS', (msg, sender, sendResponse) => {
  sendResponse({
    status: currentAppStatus.status,
    message: currentAppStatus.message,
    isCapturing: !!captureSession,
    captureSession
  });
  return true;
});

registerHandler('EXPORT_DIAGNOSTICS', (msg, sender, sendResponse) => {
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'EXPORT_DIAGNOSTICS' })
    .then(sendResponse)
    .catch(err => sendResponse({ success: false, error: err.message }));
  return true;
});

// Stage 2 Routing: offscreen -> background -> content
registerHandler('CHUNK_SENT', (msg) => {
  const tabId = msg.targetTabId || (captureSession && captureSession.targetTabId);
  if (tabId) {
    chrome.tabs.sendMessage(tabId, msg).catch(() => {});
  }
});

registerHandler('RESULT', (msg) => {
  const tabId = msg.targetTabId || (captureSession && captureSession.targetTabId);
  if (tabId) {
    chrome.tabs.sendMessage(tabId, msg).catch(() => {});
  }
});

registerHandler('OFFSCREEN_STREAM_ENDED', async () => {
  console.log('[LiveSub BG] Received OFFSCREEN_STREAM_ENDED. Cleaning up capture session.');
  await handleStopCapture();
});

// Primary Message Dispatcher
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const action = msg?.action || msg?.type;
  if (!action) return;

  if (_handlers[action]) {
    return _handlers[action](msg, sender, sendResponse);
  }

  // Allow offscreen-directed messages to pass through without warning
  if (msg?.target === 'offscreen') {
    return;
  }

  console.log('[LiveSub BG] Unhandled message action:', action, msg);
});

export { registerHandler, handleStartCapture, handleStopCapture };
