/**
 * sync/syncEngine.js: Pure JS ES Module for Subtitle Synchronization and Cue Management.
 * 
 * Complies with:
 * - docs/contract.md (WebSocket framing, time conversions, epoch-based stale result dropping)
 * - docs/cue_log.schema.json (Strict 8-field schema: start, end, lang, text, translation, source, first_shown_at, revisions)
 * - AGENT_CONTEXT.md (0s seek recovery from cache, SPA navigation reset, ad isolation)
 */

export class SyncEngine {
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
    this.unfinalizedDroppedCount = 0;
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
    const isFinal = result.is_final !== undefined ? Boolean(result.is_final) : true;

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
        is_final: isFinal,
        first_shown_at: null,
        revisions: []
      };
      this.store.set(key, cue);
    } else {
      cue.start = start;
      cue.end = end;
      cue.lang = dominantLang;
      cue._langs = langsList;
      cue.is_final = isFinal;
      if (result.text !== undefined) cue.text = result.text;
      if (result.translation !== undefined) cue.translation = result.translation;
    }

    // Append revision (text state recorded at current timeline time)
    cue.revisions.push({
      at,
      text: cue.text
    });

    // Late-cue policy:
    // If live result arrives at or after its speech end (at >= end):
    // Hold visible from arrival time for minHold seconds (default 2.0s).
    // first_shown_at set only if finalized.
    if (at >= end) {
      cue._arrivalVideoTime = at;
      cue._holdUntil = Number((at + this.minHold).toFixed(2));
      if (cue.is_final && cue.first_shown_at === null) {
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

    // Strict rule: partial cues (is_final === false) must not set first_shown_at.
    // first_shown_at is recorded only when the final (is_final === true) text is displayed.
    if (cue.is_final === false) {
      return;
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
   * Returns count of cues skipped during the last exportLog() call because they were never finalized.
   * @returns {number}
   */
  getUnfinalizedCount() {
    return this.unfinalizedDroppedCount;
  }

  /**
   * Exports strictly schema-valid cue log JSON matching docs/cue_log.schema.json.
   * Exactly 8 fields per cue: start, end, lang, text, translation, source, first_shown_at, revisions.
   * 
   * Strict Rule: Only cues that were finalized and actually displayed as final are exported.
   * Cues that were never finalized (is_final=false) or where markShown was never called are excluded.
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
    let unfinalizedCount = 0;
    const cues = Array.from(this.store.values()).sort((a, b) => (a.start - b.start) || (a.end - b.end));

    for (const c of cues) {
      // Do not fabricate first_shown_at for unfinalized cues
      if (c.is_final === false || c.first_shown_at === null) {
        unfinalizedCount += 1;
        continue;
      }

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
    this.unfinalizedDroppedCount = unfinalizedCount;
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
