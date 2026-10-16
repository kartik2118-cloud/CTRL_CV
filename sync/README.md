# SyncEngine Module (`sync/syncEngine.js`)

Pure JS ES module managing subtitle timeline synchronization, cache lookups, and schema-valid cue export.

### API Surface
- `new SyncEngine({ getVideoTime })`: Initializes engine with a video timestamp callback.
- `onResult(result, ctx)`: Converts chunk audio offsets to video time (`v_start + offset * rate`), stores cues keyed by `(epoch, chunk_id)`, appends `revisions`, drops stale/ad frames, and replaces overlapping older-epoch cues of the same source.
- `onSeek(newTime)`: Bumps `epoch += 1` to invalidate in-flight results while preserving cached cues for instant 0s seek-back recovery.
- `onNavigation()`: Bumps `epoch += 1` and clears cue store and visible state on SPA route changes.
- `onAdStart() / onAdEnd()`: Bumps `epoch` and isolates ad speech from ever reaching the main timeline.
- `getVisibleCues(t)`: Returns all active cached cues covering video time `t` (`start <= t < end`, end-exclusive), sorted by start ascending, then end ascending.
- `markShown(cue, videoTime)`: Records `first_shown_at` (video seconds) once when first rendered. Subsequent calls are ignored.
- `exportLog()`: Returns root array containing strictly the 8 schema fields for displayed cues only.

### CRITICAL: Overlay Render Loop Integration
The subtitle overlay renderer **MUST** query `getVisibleCues(video.currentTime)` on **EVERY** render tick (e.g. `requestAnimationFrame` or `timeupdate`), and immediately invoke `markShown(cue, video.currentTime)` for each rendered cue.
> **Warning**: `exportLog()` strictly exports only cues that were displayed (`first_shown_at !== null`). If the overlay fails to call `markShown()`, the exported cue log will be completely empty!

### Note on Chrome Manifest V3 Content Scripts
MV3 content scripts cannot use static ES module imports (`import ... from ...`). To load in an extension, either bundle with a bundler (esbuild/webpack/rollup) or load dynamically via:
```javascript
const { SyncEngine } = await import(chrome.runtime.getURL('sync/syncEngine.js'));
```
with `sync/syncEngine.js` declared in the manifest's `web_accessible_resources`.
