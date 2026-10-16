# SyncEngine Module (`sync/syncEngine.js`)

Pure JS ES module managing subtitle timeline synchronization, cache lookups, and schema-valid cue export.

### API Surface
- `new SyncEngine({ getVideoTime })`: Initializes engine with a video timestamp callback.
- `onResult(result, ctx)`: Converts chunk audio offsets to video time (`v_start + offset * rate`), stores cues keyed by `(epoch, chunk_id)`, appends `revisions`, and drops stale/ad frames.
- `onSeek(newTime)`: Bumps `epoch += 1` to invalidate in-flight results while preserving cached cues for 0s seek recovery.
- `onNavigation()`: Bumps `epoch += 1` and clears cue store and visible state on SPA route changes.
- `onAdStart() / onAdEnd()`: Bumps `epoch` and isolates ad speech from ever reaching the main timeline.
- `getVisibleCues(t)`: Returns all active cached cues covering video time `t` sorted by start ascending.
- `markShown(cue)`: Records `first_shown_at` video timestamp once when first rendered (never overwritten).
- `exportLog()`: Returns root array containing strictly the 8 schema fields for displayed cues only.

> **Note on Chrome Manifest V3 Content Scripts:**
> MV3 content scripts cannot use static ES module imports (`import ... from ...`). To load in an extension, either bundle with a bundler (esbuild/webpack/rollup) or load dynamically via `const { SyncEngine } = await import(chrome.runtime.getURL('sync/syncEngine.js'))` with `sync/syncEngine.js` declared in `web_accessible_resources`.
