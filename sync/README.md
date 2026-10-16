# SyncEngine Module (`sync/syncEngine.js`)

Pure JS ES module managing subtitle timeline synchronization, cache lookups, and schema-valid cue export.

### API Surface
- `new SyncEngine({ getVideoTime, minHold = 2.0 })`: Initializes engine with a video timestamp callback and late-cue minimum hold duration (default 2.0s).
- `onResult(result, ctx)`: Converts chunk audio offsets to video time (`v_start + offset * rate`), stores cues keyed by `(epoch, chunk_id)`, appends `revisions`, drops stale/ad frames, and replaces overlapping older-epoch cues of the same source. If a live result arrives after its speech end, applies late-cue hold (`minHold`).
- `onSeek(newTime)`: Bumps `epoch += 1` to invalidate in-flight results, clears active late-cue holds immediately, while preserving cached cues for instant 0s seek-back recovery.
- `onNavigation()`: Bumps `epoch += 1` and clears cue store and visible state on SPA route changes.
- `onAdStart() / onAdEnd()`: Bumps `epoch` and isolates ad speech from ever reaching the main timeline.
- `getVisibleCues(t)`: Returns all active cached cues covering video time `t` (`start <= t < end`, end-exclusive; or within active `minHold` window for late-arriving cues), sorted by start ascending, then end ascending.
- `markShown(cue, videoTime)`: Records `first_shown_at` (video seconds) once when first rendered. Subsequent calls are ignored.
- `exportLog()`: Returns root array containing strictly the 8 schema fields for displayed cues only.

### CRITICAL: Overlay Render Loop & Seek Integration
1. **Render Tick Interval (50ms)**:
   The subtitle overlay renderer **MUST** query `getVisibleCues(video.currentTime)` on **EVERY** render tick (every 50ms interval or via `requestAnimationFrame`), and immediately invoke `markShown(cue, video.currentTime)` for each rendered cue.
   > **Warning**: `exportLog()` strictly exports only cues that were displayed (`first_shown_at !== null`). If the overlay fails to call `markShown()`, the exported cue log will be completely empty!

2. **Seek Event Listener (`'seeking'`)**:
   Always attach `engine.onSeek(video.currentTime)` to the HTML5 video `'seeking'` event:
   ```javascript
   video.addEventListener('seeking', () => {
     engine.onSeek(video.currentTime);
   });
   ```
   **DO NOT** rely on `'timeupdate'` for seek detection. The browser throttles `'timeupdate'` to fire only 3-4 times a second (every 250ms-300ms) and fires after playback has already resumed, missing the critical instant-recovery window. The `'seeking'` event fires synchronously as soon as the user seeks.

### Note on Chrome Manifest V3 Content Scripts
MV3 content scripts cannot use static ES module imports (`import ... from ...`). To load in an extension, either bundle with a bundler (esbuild/webpack/rollup) or load dynamically via:
```javascript
const { SyncEngine } = await import(chrome.runtime.getURL('sync/syncEngine.js'));
```
with `sync/syncEngine.js` declared in the manifest's `web_accessible_resources`.
