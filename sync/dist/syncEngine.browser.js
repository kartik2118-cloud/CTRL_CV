/**
 * CtrlCV Subtitle Sync Bundle (Manifest V3 Classic Script)
 * Auto-generated from sync/syncEngine.js and sync/syncBridge.js.
 * Source of truth: ESM modules in sync/.
 */
(function(root) {
  'use strict';

  /**
 * sync/syncEngine.js: Pure JS ES Module for Subtitle Synchronization and Cue Management.
 * 
 * Complies with:
 * - docs/contract.md (WebSocket framing, time conversions, epoch-based stale result dropping)
 * - docs/cue_log.schema.json (Strict 8-field schema: start, end, lang, text, translation, source, first_shown_at, revisions)
 * - AGENT_CONTEXT.md (0s seek recovery from cache, SPA navigation reset, ad isolation)
 */

class SyncEngine {
  /**
   * @param {Object} options
   * @param {() => number} options.getVideoTime Function returning current video seconds
   * @param {number} [options.minHold=2.0] Minimum display hold duration in seconds for late-arriving cues
   */
  constructor({ getVideoTime = () => 0, minHold = 2.0 } = {}) {
    this.getVideoTime = getVideoTime;
    this.minHold = minHold;
    this.epoch = 1;
    this.isAdActive = false;
    this.store = new Map(); // Keyed by (epoch, chunk_id) => `${epoch}:${chunk_id}`
    this.events = [];
  }

  /**
   * Handles an incoming STT result frame according to docs/contract.md.
   * Converts chunk-relative offsets to video timeline:
   *   t_video = video_start_time + offset * playback_rate
   * 
   * Overlap replacement:
   * If a newly received cue overlaps with existing cues from older epochs with the
   * same source ("stt" or "captions"), the newer epoch replaces the older ones.
   * Within the same epoch, is_final=false then is_final=true updates the same cue.
   * 
   * Late-cue policy:
   * If a live result arrives after its speech end (vTime > end), it is held visible
   * for minHold seconds (default 2.0s), with first_shown_at = arrival video time.
   * 
   * @param {Object} result Result frame from backend WebSocket
   * @param {Object} ctx Context with video_start_time and playback_rate
   * @returns {{ status: string, reason?: string, cue?: Object }}
   */
  onResult(result, ctx = {}) {
    if (this.isAdActive) {
      return { status: "dropped", reason: "ad" };
    }

    if (result.epoch !== this.epoch) {
      return { status: "dropped", reason: "stale_epoch" };
    }

    const vStart = ctx.video_start_time ?? 0.0;
    const rate = ctx.playback_rate ?? 1.0;
    const startOffset = result.start_offset ?? 0.0;
    const endOffset = result.end_offset ?? (startOffset + 0.1);

    let start = Number((vStart + startOffset * rate).toFixed(2));
    let end = Number((vStart + endOffset * rate).toFixed(2));
    if (end <= start) {
      end = Number((start + 0.1).toFixed(2));
    }

    // Cache key is strictly (epoch, chunk_id)
    const key = `${result.epoch}:${result.chunk_id}`;
    let cue = this.store.get(key);
    const at = Number(this.getVideoTime().toFixed(2));

    const langsList = Array.isArray(result.langs) && result.langs.length > 0
      ? result.langs
      : (result.lang ? [result.lang] : ["hi"]);
    const dominantLang = result.lang || langsList[0] || "hi";

    if (!cue) {
      cue = {
        _epoch: result.epoch,
        _chunk_id: result.chunk_id,
        _holdUntil: null,
        _arrivalVideoTime: null,
        _shows: [],
        _langs: langsList,
        start,
        end,
        lang: dominantLang,
        text: result.text || "",
        translation: result.translation || "",
        source: result.source || "stt",
        first_shown_at: null,
        revisions: []
      };
      this.store.set(key, cue);
    } else {
      cue.start = start;
      cue.end = end;
      cue.lang = dominantLang;
      cue._langs = langsList;
      if (result.text !== undefined) cue.text = result.text;
      if (result.translation !== undefined) cue.translation = result.translation;
    }

    // Append revision (partial is_final=false or final is_final=true)
    cue.revisions.push({
      at,
      text: cue.text
    });

    // Late-cue policy:
    // If live result arrives at or after its speech end (at >= end):
    // Hold visible from arrival time for minHold seconds (default 2.0s).
    // first_shown_at = arrival video time.
    if (at >= end) {
      cue._arrivalVideoTime = at;
      cue._holdUntil = Number((at + this.minHold).toFixed(2));
      if (cue.first_shown_at === null) {
        cue.first_shown_at = at;
        cue._shows.push({ epoch: this.epoch, at });
      }
    } else {
      cue._holdUntil = null;
      cue._arrivalVideoTime = null;
    }

    // Overlap replacement rule:
    // If older epoch cues overlap in time and share the same source, the newer epoch replaces them.
    for (const [existingKey, existingCue] of this.store.entries()) {
      if (
        existingKey !== key &&
        existingCue.source === cue.source &&
        existingCue._epoch < cue._epoch &&
        existingCue.start < cue.end &&
        cue.start < existingCue.end
      ) {
        if (existingCue.first_shown_at !== null && cue.first_shown_at === null) {
          cue.first_shown_at = existingCue.first_shown_at;
        }
        this.store.delete(existingKey);
      }
    }

    return { status: "accepted", cue };
  }

  /**
   * Handles user seeking to a new video position.
   * Increments epoch to invalidate in-flight requests, but preserves cached cues.
   * Clears any active late-cue display holds immediately.
   * 
   * @param {number} newTime New video timestamp in seconds
   */
  onSeek(newTime) {
    const fromTime = Number(this.getVideoTime().toFixed(2));
    this.epoch += 1;
    // Seek immediately clears any late-cue display holds
    for (const cue of this.store.values()) {
      cue._holdUntil = null;
      cue._arrivalVideoTime = null;
    }
    this.events.push({
      type: "seek",
      from: fromTime,
      to: Number(newTime.toFixed(2)),
      epoch_after: this.epoch,
      wall_time: Date.now()
    });
  }

  /**
   * Handles SPA navigation to a new video URL.
   * Increments epoch, completely clears cue cache and visible cues.
   */
  onNavigation() {
    this.epoch += 1;
    this.store.clear();
    this.events.push({
      type: "navigation",
      epoch_after: this.epoch,
      wall_time: Date.now()
    });
  }

  /**
   * Handles video ad starting.
   * Increments epoch and suppresses any incoming speech results from being displayed.
   * Clears any active late-cue display holds immediately.
   */
  onAdStart() {
    this.epoch += 1;
    this.isAdActive = true;
    for (const cue of this.store.values()) {
      cue._holdUntil = null;
      cue._arrivalVideoTime = null;
    }
    this.events.push({
      type: "ad_start",
      epoch_after: this.epoch,
      wall_time: Date.now()
    });
  }

  /**
   * Handles video ad finishing.
   * Increments epoch to invalidate any late results generated during the ad,
   * and resumes accepting speech results on the main video timeline.
   */
  onAdEnd() {
    this.epoch += 1;
    this.isAdActive = false;
    this.events.push({
      type: "ad_end",
      epoch_after: this.epoch,
      wall_time: Date.now()
    });
  }

  /**
   * Retrieves all cues covering the specified video timestamp from cache.
   * 
   * Time coverage:
   * - Regular speech range: start <= t < end (end exclusive).
   * - Late-cue hold range: arrival <= t < arrival + minHold (if arrived after end).
   * 
   * Boundary rule: at t == end (or t == holdUntil) the cue is no longer visible;
   * at the boundary between two adjacent cues, exactly one cue is active.
   * 
   * Sorted by start ascending, then end ascending.
   * 
   * @param {number} [t] Video seconds (defaults to current getVideoTime())
   * @returns {Array<Object>} Cues covering t, sorted by start time
   */
  getVisibleCues(t) {
    const queryTime = typeof t === "number" ? t : this.getVideoTime();
    const visible = [];
    for (const cue of this.store.values()) {
      const inSpeechRange = cue.start <= queryTime && queryTime < cue.end;
      const inHoldRange = Boolean(
        cue._holdUntil && queryTime >= cue._arrivalVideoTime && queryTime < cue._holdUntil
      );

      if (inSpeechRange || inHoldRange) {
        visible.push(cue);
      }
    }
    return visible.sort((a, b) => (a.start - b.start) || (a.end - b.end));
  }

  /**
   * Marks a cue as shown on screen in the current epoch.
   * Uses video timeline seconds (videoTime parameter or getVideoTime()).
   * 
   * Epoch awareness (Decision D1):
   * Within the same epoch, subsequent calls are ignored (first_shown_at is never overwritten).
   * Across different epochs (e.g. after a seek-back), re-showing records the new epoch display time.
   * 
   * @param {Object} cue Cue to mark
   * @param {number} [videoTime] Video timeline seconds
   */
  markShown(cue, videoTime) {
    if (!cue) return;
    const vTime = Number((typeof videoTime === "number" ? videoTime : this.getVideoTime()).toFixed(2));
    if (!cue._shows) {
      cue._shows = [];
      if (cue.first_shown_at !== null) {
        cue._shows.push({ epoch: cue._epoch || this.epoch, at: cue.first_shown_at });
      }
    }

    const shownInCurrentEpoch = cue._shows.some(s => s.epoch === this.epoch);
    if (!shownInCurrentEpoch) {
      cue._shows.push({ epoch: this.epoch, at: vTime });
      if (cue.first_shown_at === null) {
        cue.first_shown_at = vTime;
      }
    }
  }

  /**
   * Exports strictly schema-valid cue log JSON matching docs/cue_log.schema.json.
   * Exactly 8 fields per cue: start, end, lang, text, translation, source, first_shown_at, revisions.
   * 
   * Strict Rule: Only cues that were actually displayed (markShown called) are exported.
   * Cues where markShown was never called are excluded from the log.
   * 
   * Decision D1 (Seek-back re-show):
   * When reshow_entries is true (default ON), if a cue was re-displayed in subsequent epochs
   * (e.g. seek-back cache hit), a new cue log entry is emitted for each epoch show with:
   *   first_shown_at = show.at, revisions = [{ at: show.at, text: cue.text }].
   * When reshow_entries is false, legacy single-entry export is performed.
   * 
   * @param {Object} [options]
   * @param {boolean} [options.reshow_entries=true] Whether to emit new log entries for seek re-shows (D1)
   * @returns {Array<Object>} Root array of displayed cues
   */
  exportLog({ reshow_entries = true } = {}) {
    const paired = [];
    const cues = Array.from(this.store.values()).sort((a, b) => (a.start - b.start) || (a.end - b.end));

    for (const c of cues) {
      const shows = c._shows && c._shows.length > 0
        ? c._shows
        : (c.first_shown_at !== null ? [{ epoch: c._epoch || 1, at: c.first_shown_at }] : []);

      if (shows.length === 0) continue;

      const baseRevisions = (c.revisions && c.revisions.length > 0)
        ? c.revisions.map(r => ({ at: r.at, text: r.text }))
        : [{ at: shows[0].at, text: c.text }];

      const showsToExport = reshow_entries ? shows : [shows[0]];

      for (let sIdx = 0; sIdx < showsToExport.length; sIdx++) {
        const show = showsToExport[sIdx];
        const entryRevisions = sIdx === 0
          ? baseRevisions
          : [{ at: show.at, text: c.text }];

        const entry = {
          start: c.start,
          end: c.end,
          lang: c.lang,
          text: c.text,
          translation: c.translation,
          source: c.source,
          first_shown_at: show.at,
          revisions: entryRevisions
        };

        paired.push({
          entry,
          langs: c._langs || (c.lang ? [c.lang] : ["hi"])
        });
      }
    }

    paired.sort((a, b) => (a.entry.start - b.entry.start) || (a.entry.first_shown_at - b.entry.first_shown_at));
    const result = paired.map(p => p.entry);
    this._lastExportedLangs = paired.map(p => p.langs);
    this._lastExportedList = result;
    return result;
  }

  /**
   * Exports full language list sidecar dictionary matching Decision D2.
   * Returns: { [cueIndex]: ["hi", "en"] }
   * 
   * @param {Array<Object>} [exportedCues] Optional list of exported cues
   * @returns {Object} Sidecar dictionary mapping cue index to langs array
   */
  exportLangsSidecar(exportedCues = null) {
    const sidecar = {};
    const count = exportedCues ? exportedCues.length : (this._lastExportedLangs ? this._lastExportedLangs.length : 0);
    for (let i = 0; i < count; i++) {
      sidecar[i] = (this._lastExportedLangs && this._lastExportedLangs[i]) || [(exportedCues && exportedCues[i] && exportedCues[i].lang) || "hi"];
    }
    return sidecar;
  }

  /**
   * Exports recorded lifecycle events (seeks, navigation, ads).
   * 
   * @returns {Array<Object>}
   */
  exportEvents() {
    return [...this.events];
  }
}

  /**
 * sync/syncBridge.js: Subtitle Overlay Bridge connecting HTML5 video element to SyncEngine.
 * 
 * Provides automated lifecycle handling:
 * - Listens to video 'seeking', 'ratechange', 'play', 'pause' events.
 * - Runs a 50ms render tick querying getVisibleCues(video.currentTime) and markShown.
 * - Exposes single getEpoch() for outgoing WebSocket chunk headers.
 * - Handles ad isolation, SPA navigation, and cue log export.
 */

class SyncBridge {
  /**
   * @param {Object} options
   * @param {HTMLMediaElement|EventTarget} options.video HTML5 video element
   * @param {(cues: Array<Object>) => void} options.render Callback receiving active visible cues
   * @param {(status: string, data?: any) => void} [options.onStatus] Optional lifecycle status callback
   * @param {number} [options.minHold=2.0] Minimum hold for late cues in seconds
   * @param {number} [options.tickMs=50] Render tick interval in ms (default 50)
   */
  constructor({ video, render, onStatus = () => {}, minHold = 2.0, tickMs = 50 } = {}) {
    if (!video) throw new Error("SyncBridge requires a video element");
    if (typeof render !== "function") throw new Error("SyncBridge requires a render callback function");

    this.video = video;
    this.render = render;
    this.onStatus = onStatus;
    this.tickMs = tickMs;

    this.engine = new SyncEngine({
      getVideoTime: () => Number((this.video.currentTime || 0).toFixed(2)),
      minHold
    });

    this.playbackRate = this.video.playbackRate || 1.0;
    this.isPaused = Boolean(this.video.paused);
    this._destroyed = false;

    // Event listeners
    this._onSeeking = () => {
      const t = Number((this.video.currentTime || 0).toFixed(2));
      this.engine.onSeek(t);
      this.onStatus("seeking", { time: t, epoch: this.engine.epoch });
      this._tick();
    };

    this._onRateChange = () => {
      this.playbackRate = this.video.playbackRate || 1.0;
      this.onStatus("ratechange", { rate: this.playbackRate });
    };

    this._onPlay = () => {
      this.isPaused = false;
      this.onStatus("play");
    };

    this._onPause = () => {
      this.isPaused = true;
      this.onStatus("pause");
      this._tick();
    };

    if (this.video.addEventListener) {
      this.video.addEventListener("seeking", this._onSeeking);
      this.video.addEventListener("ratechange", this._onRateChange);
      this.video.addEventListener("play", this._onPlay);
      this.video.addEventListener("pause", this._onPause);
    }

    // 50ms render loop
    this._intervalId = setInterval(() => {
      this._tick();
    }, this.tickMs);
  }

  _tick() {
    if (this._destroyed) return;
    const vTime = Number((this.video.currentTime || 0).toFixed(2));
    const visible = this.engine.getVisibleCues(vTime);
    for (const c of visible) {
      this.engine.markShown(c, vTime);
    }
    this.render(visible);
  }

  /**
   * Dispatches incoming WebSocket STT result into the engine.
   * Automatically falls back to video.currentTime and video.playbackRate if not provided in ctx.
   * 
   * @param {Object} result STT result frame matching docs/contract.md
   * @param {Object} [ctx]
   * @param {number} [ctx.video_start_time] Video seconds at start of chunk
   * @param {number} [ctx.playback_rate] Playback rate during chunk
   * @returns {Object} { status: "accepted" | "dropped", reason?: string, cue?: Object }
   */
  handleResult(result, ctx = {}) {
    if (this._destroyed) return { status: "dropped", reason: "destroyed" };
    const mergedCtx = {
      video_start_time: ctx.video_start_time ?? Number((this.video.currentTime || 0).toFixed(2)),
      playback_rate: ctx.playback_rate ?? this.playbackRate
    };
    const outcome = this.engine.onResult(result, mergedCtx);
    if (outcome.status === "accepted") {
      this._tick();
    }
    return outcome;
  }

  /**
   * Call when a video advertisement begins playing.
   */
  onAdStart() {
    this.engine.onAdStart();
    this.onStatus("ad_start", { epoch: this.engine.epoch });
    this._tick();
  }

  /**
   * Call when an advertisement finishes and main video resumes.
   */
  onAdEnd() {
    this.engine.onAdEnd();
    this.onStatus("ad_end", { epoch: this.engine.epoch });
    this._tick();
  }

  /**
   * Call when SPA client-side navigation occurs (e.g. YouTube yt-navigate-finish).
   */
  onNavigation() {
    this.engine.onNavigation();
    this.onStatus("navigation", { epoch: this.engine.epoch });
    this._tick();
  }

  /**
   * Returns current active epoch. Extension must include this value in all outgoing chunk headers.
   * 
   * @returns {number}
   */
  getEpoch() {
    return this.engine.epoch;
  }

  /**
   * Exports strictly schema-valid cue log JSON matching docs/cue_log.schema.json.
   * 
   * @param {Object} [options]
   * @param {boolean} [options.reshow_entries=true]
   * @returns {Array<Object>}
   */
  exportLog(options) {
    return this.engine.exportLog(options);
  }

  /**
   * Exports full language list sidecar dictionary matching Decision D2.
   * 
   * @param {Array<Object>} [exported]
   * @returns {Object}
   */
  exportLangsSidecar(exported) {
    return this.engine.exportLangsSidecar(exported);
  }

  /**
   * Cleans up all event listeners and stops the 50ms render loop.
   */
  destroy() {
    this._destroyed = true;
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    if (this.video && this.video.removeEventListener) {
      this.video.removeEventListener("seeking", this._onSeeking);
      this.video.removeEventListener("ratechange", this._onRateChange);
      this.video.removeEventListener("play", this._onPlay);
      this.video.removeEventListener("pause", this._onPause);
    }
    this.render([]);
  }
}

  root.CtrlCVSync = {
    SyncEngine: SyncEngine,
    SyncBridge: SyncBridge
  };
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
