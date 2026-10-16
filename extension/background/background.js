/**
 * background.js — LiveSub service worker stub
 * Phase 1: minimal boot; installs message routing scaffold.
 *
 * B will add: tabCapture, offscreen document management.
 * C will add: WebSocket connect/disconnect.
 * D will add: session lifecycle, cue log writes, eval triggers.
 *
 * Do NOT add API keys, remote script loads, or audio downloads here.
 */

'use strict';

// ─── Install / Startup ────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.log('[LiveSub BG] Installed, reason:', reason);
});

// ─── Message router (scaffold — teammates will register their own handlers) ───
/**
 * Registered handlers: { [action]: (msg, sender, sendResponse) => bool }
 * Return true from a handler to keep the channel open for async sendResponse.
 */
const _handlers = {};

function registerHandler(action, fn) {
  if (_handlers[action]) {
    console.warn('[LiveSub BG] Overwriting handler for action:', action);
  }
  _handlers[action] = fn;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const { action } = msg || {};
  if (!action) return;

  if (_handlers[action]) {
    return _handlers[action](msg, sender, sendResponse);
  }

  // Unknown actions — log for debugging during integration
  console.log('[LiveSub BG] Unhandled message action:', action, msg);
});

// ─── Expose registration helper for teammate modules (ESM import) ─────────────
export { registerHandler };
