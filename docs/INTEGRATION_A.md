# Integration Guide for Role A (Extension Shell & Overlay)

This document provides a single-page, copy-paste ready integration guide for Role A to wire the subtitle overlay, video listeners, WebSocket communication, and cue log export with `SyncBridge` and `SyncEngine`.

---

## 1. Files & Manifest V3 Setup

### 1.1 Bundle Placement
Place `sync/dist/syncEngine.browser.js` directly into your extension directory:
```
extension/
├── manifest.json
├── content.js
├── background.js
├── popup.html
└── vendor/
    └── syncEngine.browser.js   <-- copy from sync/dist/syncEngine.browser.js
```

### 1.2 Manifest Configuration (`manifest.json`)
Load the browser bundle as a classic script before your content script:
```json
{
  "content_scripts": [
    {
      "matches": ["*://*.youtube.com/*"],
      "js": [
        "vendor/syncEngine.browser.js",
        "content.js"
      ],
      "run_at": "document_idle"
    }
  ],
  "web_accessible_resources": [
    {
      "resources": ["vendor/syncEngine.browser.js"],
      "matches": ["*://*.youtube.com/*"]
    }
  ]
}
```
*Note*: `vendor/syncEngine.browser.js` executes as a classic script and registers on the global namespace:
```javascript
const { SyncEngine, SyncBridge } = globalThis.CtrlCVSync;
```

---

## 2. Wiring `SyncBridge` in `content.js`

### 2.1 Initialization & Overlay Mounting
Instantiate `SyncBridge` when the YouTube HTML5 `<video>` element is discovered:
```javascript
const { SyncBridge } = globalThis.CtrlCVSync;

const video = document.querySelector('video.html5-main-video') || document.querySelector('video');

const bridge = new SyncBridge({
  video: video,
  tickMs: 50, // 50ms render tick
  minHold: 2.0, // Hold late cues for at least 2.0s
  render: (visibleCues) => {
    // Update subtitle overlay container DOM
    const overlay = document.getElementById('ctrlcv-subtitle-overlay');
    if (!overlay) return;
    if (visibleCues.length === 0) {
      overlay.style.display = 'none';
      overlay.innerText = '';
    } else {
      overlay.style.display = 'block';
      // Render text or translation
      overlay.innerText = visibleCues.map(c => c.translation || c.text).join('\n');
    }
  },
  onStatus: (status) => {
    console.log('[CtrlCV Bridge Status]:', status);
  }
});
```

### 2.2 Outgoing Audio Chunk Headers
When Role B's capture pipeline sends an audio chunk to the WebSocket backend, include `bridge.getEpoch()` in the chunk header:
```javascript
function sendAudioChunk(pcmBytes, videoStartTime, playbackRate) {
  const header = {
    type: "chunk",
    chunk_id: nextChunkId++,
    epoch: bridge.getEpoch(), // Uses Bridge epoch; Role A does NOT manage a separate counter
    video_start_time: videoStartTime,
    playback_rate: playbackRate,
    sample_rate: 16000
  };

  websocket.send(JSON.stringify(header));
  websocket.send(pcmBytes);
}
```

### 2.3 Inbound Backend Result Frames
Pass received result frames directly to `bridge.handleResult()`:
```javascript
websocket.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === "result") {
    bridge.handleResult(msg, {
      video_start_time: msg.video_start_time || currentChunkVideoStartTime,
      playback_rate: video.playbackRate
    });
  }
};
```

### 2.4 YouTube SPA Navigation & Advertisement Handlers
```javascript
// YouTube SPA Navigation (client-side page transition without reload)
window.addEventListener('yt-navigate-finish', () => {
  console.log('[CtrlCV] YouTube navigation detected -> resetting timeline');
  bridge.onNavigation();
});

// YouTube Ad Detection (MutationObserver or player ad classes)
const adObserver = new MutationObserver(() => {
  const isAd = document.querySelector('.ad-showing, .video-ads') !== null;
  if (isAd && !bridge.adActive) {
    bridge.adActive = true;
    bridge.onAdStart();
  } else if (!isAd && bridge.adActive) {
    bridge.adActive = false;
    bridge.onAdEnd();
  }
});
adObserver.observe(document.querySelector('#movie_player') || document.body, {
  attributes: true,
  subtree: true,
  attributeFilter: ['class']
});
```

---

## 3. Cue Log Export Specification

> [!IMPORTANT]
> **Specification Gap Check**: In `AGENT_CONTEXT.md` line 7-8: *"Hackathon: 24 hours. Judges load the extension unpacked and score from our exported cue log JSON."*
> The exact trigger mechanism (whether via automated DevTools hook, popup button, or keyboard shortcut) is **UNDEFINED** in organizer docs. Requires confirmation from mentor.

### Interim Standard Implementation for Role A
To ensure judges can download the cue log after each test video, expose both a global DevTools hook and a popup button:
```javascript
// Expose global download hook on window
window.__ctrlcvExportCueLog = function(download = true) {
  const cues = bridge.exportLog();
  const sidecar = bridge.exportLangsSidecar(cues);
  const jsonStr = JSON.stringify(cues, null, 2);

  if (download) {
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cue_log_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    console.log(`[CtrlCV] Exported ${cues.length} cues.`);
  }
  return { cues, sidecar };
};
```
In extension `popup.html`:
Add a button `<button id="btn-export-log">Export Cue Log (JSON)</button>` that sends a message to `content.js` to trigger `window.__ctrlcvExportCueLog(true)`.

---

## 4. Privacy Notice & Kill Switch (Role A Ownership)

Per competition rules:
1. **Notice**: The extension popup must show a prominent notice:
   *"Audio from this tab is streamed to a speech-to-text cloud endpoint for real-time translation."*
2. **Off Switch**: When user toggles the extension to OFF:
   - Call `bridge.destroy()`.
   - Close the WebSocket connection (`websocket.close()`).
   - Remove the subtitle overlay container from DOM.

---

## 5. 10-Point Integration Verification Checklist

| # | Integration Test Item | Test Action | Expected Observable Output |
|---|---|---|---|
| 1 | **Global Bundle Registration** | In Chrome DevTools console: `globalThis.CtrlCVSync` | Object `{ SyncEngine: f, SyncBridge: f }` present without exceptions. |
| 2 | **Bridge Instantiation** | Call `new SyncBridge({ video, render })` | Console logs status; 50ms interval starts polling video timeline. |
| 3 | **Result Ingestion** | Feed 1 result frame to `bridge.handleResult()` | Subtitle appears in overlay DOM container at specified video time. |
| 4 | **Seek Back Instant Recovery** | Play past 30s, seek back to 10s | Previously displayed cue appears in overlay within < 1.0s (0s recovery). |
| 5 | **Stale Result Dropping** | Send result with older epoch after seek | In-flight stale result dropped; console shows `stale_epoch`; overlay unaffected. |
| 6 | **Playback Rate Scaling** | Set `video.playbackRate = 1.5` | Cue start and end scale correctly according to `v_start + offset * 1.5`. |
| 7 | **SPA Navigation Reset** | Click a different YouTube video | Subtitles clear immediately (< 2.0s); `bridge.getEpoch()` increments; cache purged. |
| 8 | **Ad Isolation** | Trigger YouTube advertisement | Overlay clears during ad; ad speech does not appear on video timeline. |
| 9 | **Cue Log Export Format** | Run `window.__ctrlcvExportCueLog()` | Downloads `cue_log.json`; strictly passes `python eval/validate_log.py`. |
| 10 | **Privacy Kill Switch** | Toggle extension toggle to OFF | WebSocket closes; audio capture stops; overlay hidden. |
