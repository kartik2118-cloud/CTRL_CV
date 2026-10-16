# CTRL_CV

Extension-based project for YouTube subtitles.

# LiveSub — Overlay Spike

Chrome MV3 extension that renders live subtitles as an overlay on YouTube videos.  
**Hackathon scope for Role A:** content-script overlay only (Phases 1–4 complete).  
Audio capture · STT · translation · cue-log · eval: owned by other roles.

---

## Loading the Extension (Unpacked)

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle top-right)
3. Click **Load unpacked**
4. Select the `extension/` folder inside this repo
5. The **LiveSub** extension appears with a 🔴 icon in the toolbar

> **No build step needed.** The extension is plain HTML/JS/CSS — load as-is.

---

## Quick Test Checklist

### 1 — Overlay & Demo Subtitle

| Step | Expected |
|------|----------|
| Navigate to any `youtube.com/watch?v=…` | Extension loads silently |
| Click **⚙ LiveSub** button (top-right of the player) | Control panel slides open |
| Click **▶ Demo** | Two rows appear: Hindi original + English translation |
| Click **✕ Clear** | Both rows disappear |

### 2 — Style Controls

| Control | Expected |
|---------|----------|
| Font Size slider | Subtitle size updates in real time |
| Text Color picker | Subtitle color updates in real time |
| **Top** / **Bottom** position buttons | Subtitle row moves to chosen edge |

### 3 — Player Modes

Test while Demo subtitle is visible:

| Mode | How to enter | Expected |
|------|-------------|----------|
| Normal | Default | Subtitle renders at bottom-center |
| Theatre | Click theatre icon | Subtitle stays inside player, scaled |
| Fullscreen | `f` key or fullscreen button | Subtitle stays inside player |
| Return to normal | `Escape` / click again | Subtitle persists correctly |

### 4 — SPA Navigation (No Reload)

| Action | Expected within ~1 s |
|--------|----------------------|
| Click a suggested video (next video) | Old subtitle clears automatically |
| Browser Back / Forward | Old subtitle clears |
| Navigate away from `/watch` | Subtitle clears |
| Return to any `/watch` | Overlay reattaches, ready for new subtitles |

### 5 — No Duplicate UI

After any navigation, exactly **one** `⚙ LiveSub` button and **one** subtitle box exist in the player DOM. Verify with:

```
document.querySelectorAll('#livesub-overlay-host').length  // expect 1
document.querySelectorAll('#livesub-controls-panel').length // expect 1
```

### 6 — Player Controls Remain Usable

With Demo subtitle visible, the play/pause bar, volume, fullscreen, and seek bar must all be clickable. The subtitle layer has `pointer-events: none` and must never intercept clicks.

---

## Integration — Role D Renderer API

Use `chrome.tabs.sendMessage(tabId, msg)` from background or popup:

```js
// Show a subtitle cue
chrome.tabs.sendMessage(tabId, {
  action: 'SHOW_SUBTITLE',     // or 'RENDER_SUBTITLE'
  text: 'source language text',
  translation: 'translated text',
  cueId: 'cue-42',             // optional, echoed back
  revision: 1                  // optional
});
// Response: { status: 'rendered'|'player_not_attached', cueId, revision, currentTime, renderTimestamp }

// Clear
chrome.tabs.sendMessage(tabId, { action: 'CLEAR_SUBTITLE' });
// Response: { status: 'cleared', currentTime }

// Update style
chrome.tabs.sendMessage(tabId, { action: 'UPDATE_STYLE', fontSize: 26, color: '#ffeb3b', position: 'top' });
// Response: { status: 'style_updated', currentStyle: { fontSize, color, position } }

// Health check
chrome.tabs.sendMessage(tabId, { action: 'GET_STATUS' });
// Response: { currentVideoId, isAttached: bool, currentStyle }
```

> Functions **are not** exposed on the page `window` — messages go through the extension runtime only.

---

## File Map

```
extension/
├── manifest.json           MV3, matches https://www.youtube.com/*
├── content/
│   ├── content.js          ← Role A (all 4 phases)
│   └── content.css         host-page CSS stub (Shadow DOM used for isolation)
├── background/
│   └── background.js       Message router scaffold (Roles B/C/D extend this)
├── popup/
│   ├── popup.html          Toolbar popup — Demo / Clear buttons
│   └── popup.js            Sends SHOW_SUBTITLE / CLEAR_SUBTITLE to active tab
├── offscreen/
│   ├── offscreen.html      Stub — Role B owns (tabCapture + audio)
│   └── offscreen.js        Stub — Role B owns
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Automated Check Results

> No build toolchain was set up for this spike (plain JS, no Node/npm).

| Check | Result |
|-------|--------|
| Manifest v3 schema | ✅ Valid (all required fields present) |
| Content script JS syntax | ✅ No syntax errors (parsed by V8 on load) |
| Popup script syntax | ✅ |
| No API keys in repo | ✅ |
| No `window.*` exposure of renderer | ✅ (content-script module scope only) |
| Duplicate-overlay guard | ✅ (`#livesub-overlay-host` existence check before attach) |

**Pending manual browser checks** (require loading the extension in Chrome):
- Fullscreen subtitle positioning *(visual)*
- SPA navigation reset timing *(interactive)*
- Player click-through verification *(interactive)*
- Theatre mode layout *(visual)*
