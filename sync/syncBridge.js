/**
 * sync/syncBridge.js: Subtitle Overlay Bridge connecting HTML5 video element to SyncEngine.
 * 
 * Provides automated lifecycle handling:
 * - Listens to video 'seeking', 'ratechange', 'play', 'pause' events.
 * - Runs a 50ms render tick querying getVisibleCues(video.currentTime) and markShown.
 * - Exposes single getEpoch() for outgoing WebSocket chunk headers.
 * - Handles ad isolation, SPA navigation, and cue log export.
 */
import { SyncEngine } from "./syncEngine.js";

export class SyncBridge {
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
