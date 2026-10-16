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
   */
  constructor({ getVideoTime = () => 0 } = {}) {
    this.getVideoTime = getVideoTime;
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

    if (!cue) {
      cue = {
        _epoch: result.epoch,
        _chunk_id: result.chunk_id,
        start,
        end,
        lang: result.lang || (Array.isArray(result.langs) && result.langs[0]) || "hi",
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
      if (result.lang) cue.lang = result.lang;
      if (result.text !== undefined) cue.text = result.text;
      if (result.translation !== undefined) cue.translation = result.translation;
    }

    // Append revision (partial is_final=false or final is_final=true)
    cue.revisions.push({
      at,
      text: cue.text
    });

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
   * 
   * @param {number} newTime New video timestamp in seconds
   */
  onSeek(newTime) {
    const fromTime = Number(this.getVideoTime().toFixed(2));
    this.epoch += 1;
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
   */
  onAdStart() {
    this.epoch += 1;
    this.isAdActive = true;
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
   * Time coverage: start <= t < end (end exclusive).
   * Boundary rule: at t == end the cue is no longer visible; at the boundary
   * between two adjacent cues, exactly one cue is active.
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
      if (cue.start <= queryTime && queryTime < cue.end) {
        visible.push(cue);
      }
    }
    return visible.sort((a, b) => (a.start - b.start) || (a.end - b.end));
  }

  /**
   * Marks a cue as first shown on screen, recording first_shown_at once.
   * Uses video timeline seconds (videoTime parameter or getVideoTime()).
   * Ignores subsequent calls once first_shown_at is set.
   * 
   * @param {Object} cue Cue to mark
   * @param {number} [videoTime] Video timeline seconds
   */
  markShown(cue, videoTime) {
    if (cue && cue.first_shown_at === null) {
      const vTime = typeof videoTime === "number" ? videoTime : this.getVideoTime();
      cue.first_shown_at = Number(vTime.toFixed(2));
    }
  }

  /**
   * Exports strictly schema-valid cue log JSON matching docs/cue_log.schema.json.
   * Exactly 8 fields per cue: start, end, lang, text, translation, source, first_shown_at, revisions.
   * 
   * Strict Rule: Only cues that were actually displayed (markShown called) are exported.
   * Cues where first_shown_at is null (never shown) are excluded from the log.
   * 
   * @returns {Array<Object>} Root array of displayed cues sorted by start time
   */
  exportLog() {
    return Array.from(this.store.values())
      .filter(c => c.first_shown_at !== null && typeof c.first_shown_at === "number")
      .sort((a, b) => a.start - b.start)
      .map(c => {
        let revisions = c.revisions;
        if (!revisions || revisions.length === 0) {
          revisions = [{ at: c.first_shown_at, text: c.text }];
        }

        // Strictly 8 schema properties only (no _epoch, _chunk_id or extra fields)
        return {
          start: c.start,
          end: c.end,
          lang: c.lang,
          text: c.text,
          translation: c.translation,
          source: c.source,
          first_shown_at: c.first_shown_at,
          revisions: revisions.map(r => ({ at: r.at, text: r.text }))
        };
      });
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
