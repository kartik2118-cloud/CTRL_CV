/**
 * extension/offscreen/ws_client.js
 * LiveSub Streaming WebSocket Client (Stage 2).
 *
 * Pure logic client with constructor dependency injection for WebSocketClass and storage.
 * Aggregates ~100 ms audio blocks into ~1000 ms chunks (16 kHz mono 16-bit PCM).
 * Handles backend handshake, rate changes, discontinuity discards, and result normalization.
 */

(function(root) {
  'use strict';

  class WsClient {
    /**
     * @param {Object} [options]
     * @param {Function} [options.WebSocketClass] Injected WebSocket constructor (e.g. for Node tests)
     * @param {string} [options.url] Direct WebSocket URL (bypasses storage lookup if set)
     * @param {string} [options.defaultUrl] Default fallback WebSocket URL
     * @param {Object} [options.storage] Storage provider (e.g. chrome.storage.local or mock)
     * @param {number} [options.sampleRate] Audio sample rate (default 16000)
     * @param {number} [options.targetChunkDuration] Target chunk duration in seconds (default 1.0)
     * @param {string} [options.lang] Speech source language code (default "hi")
     * @param {string} [options.targetLang] Translation target language code (default "en")
     * @param {string} [options.sessionId] Unique session identifier
     * @param {Function} [options.onChunkSent] Callback triggered when chunk is transmitted
     * @param {Function} [options.onResult] Callback triggered when backend result is received
     * @param {Function} [options.onError] Error callback
     * @param {Function} [options.onOpen] WebSocket open callback
     * @param {Function} [options.onClose] WebSocket close callback
     * @param {number} [options.initialEpoch] Initial epoch number (default 0)
     * @param {number} [options.initialPlaybackRate] Initial playback rate (default 1.0)
     */
    constructor(options = {}) {
      this.WebSocketClass = options.WebSocketClass || (typeof WebSocket !== 'undefined' ? WebSocket : null);
      this.defaultUrl = options.defaultUrl || 'ws://localhost:8000/ws';
      this.url = options.url || null;
      this.storage = options.storage || (typeof chrome !== 'undefined' && chrome?.storage?.local ? chrome.storage.local : null);

      this.sampleRate = options.sampleRate || 16000;
      this.targetChunkDuration = options.targetChunkDuration || 1.0;
      this.targetChunkSamples = Math.round(this.sampleRate * this.targetChunkDuration);

      this.lang = options.lang || 'hi';
      this.targetLang = options.targetLang || 'en';
      this.sessionId = options.sessionId || ('client_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8));

      this.onChunkSent = options.onChunkSent || null;
      this.onResult = options.onResult || null;
      this.onError = options.onError || null;
      this.onOpen = options.onOpen || null;
      this.onClose = options.onClose || null;

      this.epoch = typeof options.initialEpoch === 'number' ? options.initialEpoch : 0;
      this.playbackRate = typeof options.initialPlaybackRate === 'number' ? options.initialPlaybackRate : 1.0;
      this.latestAnchor = null;
      this.currentChunkVideoStartTime = null;

      this.partialBuffer = [];
      this.bufferedSamples = 0;
      this.chunkId = 0;

      this.sentChunks = new Map();
      this.maxSentHistory = 100;

      this.ws = null;
      this.isHandshakeComplete = false;
      this._closedManually = false;
    }

    /**
     * Resolves backend URL from explicit setting, storage, or default fallback.
     * @returns {Promise<string>}
     */
    async resolveUrl() {
      if (this.url) return this.url;
      if (this.storage && typeof this.storage.get === 'function') {
        try {
          const result = await new Promise((resolve) => {
            this.storage.get(['backend_url', 'backendUrl'], resolve);
          });
          const configured = result?.backend_url || result?.backendUrl;
          if (configured && typeof configured === 'string' && configured.trim()) {
            return configured.trim();
          }
        } catch (_) {}
      }
      return this.defaultUrl;
    }

    /**
     * Establishes WebSocket connection and initiates "hello" handshake.
     * @returns {Promise<Object>} The connected WebSocket instance
     */
    async connect() {
      if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) {
        return this.ws;
      }
      if (!this.WebSocketClass) {
        throw new Error('No WebSocket constructor available or injected.');
      }

      this._closedManually = false;
      const targetUrl = await this.resolveUrl();

      return new Promise((resolve, reject) => {
        try {
          this.ws = new this.WebSocketClass(targetUrl);
        } catch (err) {
          return reject(err);
        }

        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
          const helloMsg = {
            type: 'hello',
            client_id: this.sessionId,
            lang: this.lang,
            target_lang: this.targetLang
          };
          try {
            this.ws.send(JSON.stringify(helloMsg));
          } catch (e) {
            if (this.onError) this.onError(e);
          }
          if (this.onOpen) this.onOpen();
          resolve(this.ws);
        };

        this.ws.onmessage = (event) => {
          this._handleIncomingMessage(event.data);
        };

        this.ws.onerror = (err) => {
          if (this.onError) this.onError(err);
        };

        this.ws.onclose = (event) => {
          this.isHandshakeComplete = false;
          if (this.onClose) this.onClose(event);
        };
      });
    }

    /**
     * Handles incoming JSON messages from backend.
     * @private
     */
    _handleIncomingMessage(rawData) {
      let text = rawData;
      if (typeof rawData !== 'string') {
        return;
      }

      let msg;
      try {
        msg = JSON.parse(text);
      } catch (_) {
        return;
      }

      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'hello_ack') {
        this.isHandshakeComplete = true;
        if (msg.session_id) this.sessionId = msg.session_id;
        return;
      }

      if (msg.type === 'seek_ack' || msg.type === 'config_ack') {
        return;
      }

      if (msg.type === 'subtitle' || msg.type === 'result') {
        this._handleSubtitleResult(msg);
        return;
      }

      if (msg.type === 'error') {
        if (this.onError) this.onError(new Error(msg.detail || msg.message || 'Backend error'));
      }
    }

    /**
     * Normalizes backend subtitle message and triggers onResult callback.
     * @private
     */
    _handleSubtitleResult(msg) {
      const cached = this.sentChunks.get(msg.chunk_id);
      const playbackRate = (cached && cached.playback_rate) || this.playbackRate;
      const vStart = (cached && cached.video_start_time) ?? 0.0;

      let start = msg.start;
      let end = msg.end;
      let startOffset = msg.start_offset;
      let endOffset = msg.end_offset;

      if (start !== undefined && end !== undefined) {
        if (startOffset === undefined) {
          startOffset = Number(((start - vStart) / playbackRate).toFixed(3));
        }
        if (endOffset === undefined) {
          endOffset = Number(((end - vStart) / playbackRate).toFixed(3));
        }
      } else if (startOffset !== undefined && endOffset !== undefined) {
        if (start === undefined) {
          start = Number((vStart + startOffset * playbackRate).toFixed(3));
        }
        if (end === undefined) {
          end = Number((vStart + endOffset * playbackRate).toFixed(3));
        }
      }

      const langs = msg.langs || (msg.lang ? [msg.lang] : ['hi']);
      const result = {
        type: 'RESULT',
        chunk_id: msg.chunk_id,
        epoch: msg.epoch,
        start: start,
        end: end,
        start_offset: startOffset,
        end_offset: endOffset,
        is_final: msg.is_final !== undefined ? msg.is_final : true,
        lang: msg.lang || langs[0] || 'hi',
        langs: langs,
        text: msg.text || '',
        translation: msg.translation || null,
        source: msg.source || 'stt'
      };

      if (typeof this.onResult === 'function') {
        this.onResult(result);
      }
    }

    /**
     * Ingests latest VIDEO_STATE_OBSERVATION from content script.
     * Detects seeking, ads, epoch changes, or playback rate adjustments.
     * @param {Object} obs Observation packet
     */
    updateVideoObservation(obs) {
      if (!obs) return;

      const isEpochBump = typeof obs.epoch === 'number' && obs.epoch > this.epoch;
      const isSeeking = Boolean(obs.seeking);
      const isAd = obs.ad_state === 'ad_playing';

      if (isEpochBump || isSeeking || isAd) {
        const nextEpoch = isEpochBump ? obs.epoch : (this.epoch + 1);
        this.handleDiscontinuity(nextEpoch, isAd ? 'ad' : (isSeeking ? 'seek' : 'epoch_bump'), obs.video_current_time);
        this.latestAnchor = obs;
        return;
      }

      if (typeof obs.playback_rate === 'number' && obs.playback_rate !== this.playbackRate) {
        this.setPlaybackRate(obs.playback_rate);
      }

      this.latestAnchor = obs;
      if (this.currentChunkVideoStartTime === null && typeof obs.video_current_time === 'number') {
        this.currentChunkVideoStartTime = obs.video_current_time;
      }
    }

    /**
     * Adjusts playback rate.
     * Flushes current partial chunk with OLD rate, then adopts NEW rate.
     * @param {number} newRate
     */
    setPlaybackRate(newRate) {
      if (typeof newRate !== 'number' || newRate <= 0 || newRate === this.playbackRate) {
        return;
      }

      if (this.bufferedSamples > 0) {
        this.flushChunk(true);
      }

      this.playbackRate = newRate;
    }

    /**
     * Bumps epoch and drops partial aggregation buffer on seek, navigation, or ad.
     * @param {number|null} [newEpoch]
     * @param {string} [reason]
     * @param {number|null} [videoTime]
     */
    handleDiscontinuity(newEpoch = null, reason = 'discontinuity', videoTime = null) {
      this.epoch = (typeof newEpoch === 'number' && newEpoch > this.epoch) ? newEpoch : (this.epoch + 1);
      this.partialBuffer = [];
      this.bufferedSamples = 0;
      this.currentChunkVideoStartTime = (typeof videoTime === 'number') ? videoTime : null;

      if (this.ws && this.ws.readyState === 1 && this.isHandshakeComplete) {
        const vTime = typeof videoTime === 'number' ? videoTime : (this.latestAnchor?.video_current_time || 0);
        try {
          this.ws.send(JSON.stringify({
            type: 'seek',
            video_time: Number(vTime.toFixed(3)),
            epoch: this.epoch
          }));
        } catch (_) {}
      }
    }

    /**
     * Feeds 100 ms audio block into the 1-second aggregator.
     * @param {Int16Array|Float32Array|ArrayBuffer|Array<number>} block
     * @param {number|null} [durationS]
     */
    feedAudioBlock(block, durationS = null) {
      let pcm;
      if (block instanceof Int16Array) {
        pcm = block;
      } else if (block instanceof Float32Array) {
        pcm = new Int16Array(block.length);
        for (let i = 0; i < block.length; i++) {
          const s = Math.max(-1.0, Math.min(1.0, block[i]));
          pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
      } else if (block instanceof ArrayBuffer) {
        pcm = new Int16Array(block);
      } else if (Array.isArray(block)) {
        pcm = new Int16Array(block);
      } else {
        return;
      }

      if (pcm.length === 0) return;

      if (this.currentChunkVideoStartTime === null) {
        if (this.latestAnchor && typeof this.latestAnchor.video_current_time === 'number') {
          this.currentChunkVideoStartTime = this.latestAnchor.video_current_time;
        } else {
          this.currentChunkVideoStartTime = 0.0;
        }
      }

      this.partialBuffer.push(pcm);
      this.bufferedSamples += pcm.length;

      if (this.bufferedSamples >= this.targetChunkSamples) {
        this.flushChunk(false);
      }
    }

    /**
     * Flushes currently buffered audio samples as a chunk.
     * Transmits header JSON frame followed by binary PCM frame.
     * Dispatches CHUNK_SENT to content script at send time.
     * @param {boolean} [isRateChangeFlush=false]
     * @returns {Object|null}
     */
    flushChunk(isRateChangeFlush = false) {
      if (this.bufferedSamples === 0) return null;

      const totalSamples = this.bufferedSamples;
      const merged = new Int16Array(totalSamples);
      let offset = 0;
      for (const buf of this.partialBuffer) {
        merged.set(buf, offset);
        offset += buf.length;
      }

      const chunkDurationS = totalSamples / this.sampleRate;
      const currentRate = this.playbackRate;
      const vStartTime = this.currentChunkVideoStartTime !== null
        ? this.currentChunkVideoStartTime
        : 0.0;

      // start_next = video_start_time + offset * rate
      const nextStart = Number((vStartTime + (chunkDurationS * currentRate)).toFixed(6));

      const chunkId = this.chunkId++;
      const currentEpoch = this.epoch;

      const header = {
        type: 'chunk_meta',
        chunk_id: chunkId,
        epoch: currentEpoch,
        video_start_time: vStartTime,
        video_start: vStartTime,
        playback_rate: currentRate,
        sample_rate: this.sampleRate,
        duration: Number(chunkDurationS.toFixed(3))
      };

      const chunkSentEvent = {
        type: 'CHUNK_SENT',
        chunk_id: chunkId,
        video_start_time: vStartTime,
        playback_rate: currentRate,
        epoch: currentEpoch
      };

      if (this.sentChunks.size >= this.maxSentHistory) {
        const oldestKey = this.sentChunks.keys().next().value;
        this.sentChunks.delete(oldestKey);
      }
      this.sentChunks.set(chunkId, chunkSentEvent);

      if (this.ws && this.ws.readyState === 1) {
        try {
          this.ws.send(JSON.stringify(header));
          this.ws.send(merged.buffer);
        } catch (err) {
          if (this.onError) this.onError(err);
        }
      }

      if (typeof this.onChunkSent === 'function') {
        this.onChunkSent(chunkSentEvent);
      }

      this.partialBuffer = [];
      this.bufferedSamples = 0;
      this.currentChunkVideoStartTime = nextStart;

      return {
        header,
        pcm: merged,
        chunkSentEvent
      };
    }

    /**
     * Closes the active WebSocket connection cleanly.
     */
    close() {
      this._closedManually = true;
      if (this.ws) {
        if (this.ws.readyState === 1) {
          try {
            this.ws.send(JSON.stringify({ type: 'bye' }));
          } catch (_) {}
        }
        try {
          this.ws.close();
        } catch (_) {}
        this.ws = null;
      }
      this.isHandshakeComplete = false;
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { WsClient };
  }
  root.WsClient = WsClient;
})(typeof globalThis !== 'undefined' ? globalThis : this);
