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
    this.store = new Map(); // chunk_id -> cue
    this.events = [];
  }

  /**
   * Handles an incoming STT result frame according to docs/contract.md.
   * Converts chunk-relative offsets to video timeline:
   *   t_video = video_start_time + offset * playback_rate
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

    const chunkId = result.chunk_id;
    let cue = this.store.get(chunkId);
    const at = Number(this.getVideoTime().toFixed(2));

    if (!cue) {
      cue = {
        _chunk_id: chunkId,
        start,
        end,
        lang: result.lang || (Array.isArray(result.langs) && result.langs[0]) || "hi",
        text: result.text || "",
        translation: result.translation || "",
        source: result.source || "stt",
        first_shown_at: null,
        revisions: []
      };
      this.store.set(chunkId, cue);
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
   * Resumes accepting speech results on the main video timeline.
   */
  onAdEnd() {
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
   * @param {number} [t] Video seconds (defaults to current getVideoTime())
   * @returns {Array<Object>} Cues covering t, sorted by start time
   */
  getVisibleCues(t) {
    const queryTime = typeof t === "number" ? t : this.getVideoTime();
    const visible = [];
    for (const cue of this.store.values()) {
      if (cue.start <= queryTime && queryTime <= cue.end) {
        visible.push(cue);
      }
    }
    return visible.sort((a, b) => a.start - b.start);
  }

  /**
   * Marks a cue as first shown on screen, recording first_shown_at once.
   * Never overwrites first_shown_at once set.
   * 
   * @param {Object} cue Cue to mark
   */
  markShown(cue) {
    if (cue && cue.first_shown_at === null) {
      cue.first_shown_at = Number(this.getVideoTime().toFixed(2));
    }
  }

  /**
   * Exports strictly schema-valid cue log JSON matching docs/cue_log.schema.json.
   * Exactly 8 fields per cue: start, end, lang, text, translation, source, first_shown_at, revisions.
   * 
   * @returns {Array<Object>} Root array of cues sorted by start time
   */
  exportLog() {
    return Array.from(this.store.values())
      .sort((a, b) => a.start - b.start)
      .map(c => {
        let firstShown = c.first_shown_at;
        if (firstShown === null || typeof firstShown !== "number") {
          firstShown = c.revisions.length > 0 ? c.revisions[0].at : c.start;
        }

        let revisions = c.revisions;
        if (!revisions || revisions.length === 0) {
          revisions = [{ at: firstShown, text: c.text }];
        }

        // Strictly 8 schema properties only (no _chunk_id or extra fields)
        return {
          start: c.start,
          end: c.end,
          lang: c.lang,
          text: c.text,
          translation: c.translation,
          source: c.source,
          first_shown_at: firstShown,
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
