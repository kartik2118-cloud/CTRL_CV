/**
 * extension/content/pipeline.js: Subtitle Pipeline Coordinator (Stage 1).
 *
 * Responsibilities:
 * - Instantiates SyncBridge for the YouTube <video> element.
 * - Routes visible cues to the existing content.js subtitle renderer.
 * - Dispatches VIDEO_STATE_OBSERVATION messages to offscreen capture.
 * - Handles incoming CHUNK_SENT (registerChunk) and RESULT (handleResult) messages.
 * - Listens for YouTube SPA navigation (yt-navigate-finish) and advertisement state changes.
 * - Exposes window.__ctrlcvExportCueLog() and window.__ctrlcvExportArchive() for judges.
 */

'use strict';

(function() {
  const { SyncBridge } = globalThis.CtrlCVSync || {};
  if (!SyncBridge) {
    console.error('[CtrlCV Pipeline] SyncBridge not found on globalThis.CtrlCVSync. Ensure vendor/syncEngine.browser.js is loaded.');
    return;
  }

  let bridge = null;
  let activeVideoEl = null;
  let lastObservationMs = 0;
  let adActive = false;

  function getVideoId() {
    try {
      const url = new URL(window.location.href);
      if (url.pathname === '/watch') {
        return url.searchParams.get('v') || 'unknown';
      }
      if (url.pathname.startsWith('/shorts/')) {
        const parts = url.pathname.split('/');
        return parts[2] || 'unknown';
      }
    } catch (_) {}
    return 'unknown';
  }

  function isAdShowing() {
    const player = document.querySelector('#movie_player') || document.body;
    return player.classList.contains('ad-showing') || document.querySelector('.ad-showing, .ad-interrupting, .video-ads') !== null;
  }

  function getVideoObservationPayload() {
    const video = activeVideoEl || document.querySelector('#movie_player video') || document.querySelector('video');
    if (!video) return null;

    const adState = isAdShowing() ? 'ad_playing' : 'main_video';
    const now = Date.now();
    return {
      epoch: bridge ? bridge.getEpoch() : 1,
      video_id: getVideoId(),
      video_current_time: Number((video.currentTime || 0).toFixed(6)),
      playback_rate: video.playbackRate || 1.0,
      paused: Boolean(video.paused),
      seeking: Boolean(video.seeking),
      ad_state: adState,
      wall_time_ms: now
    };
  }

  function sendVideoObservation(force = false) {
    const now = Date.now();
    if (!force && (now - lastObservationMs < 250)) {
      return;
    }
    lastObservationMs = now;

    const obs = getVideoObservationPayload();
    if (!obs) return;

    try {
      chrome.runtime.sendMessage({
        target: 'offscreen',
        type: 'VIDEO_STATE_OBSERVATION',
        observation: obs
      }).catch(() => {});
    } catch (_) {}
  }

  function onBridgeRender(visibleCues) {
    if (!visibleCues || visibleCues.length === 0) {
      if (window.__livesubIsDemoRunning) {
        return;
      }
      if (typeof window.__livesubClearSubtitle === 'function') {
        window.__livesubClearSubtitle();
      }
    } else {
      if (typeof window.__livesubStopDemo === 'function') {
        window.__livesubStopDemo();
      }
      const combinedText = visibleCues.map(c => c.text).filter(Boolean).join('\n');
      const combinedTrans = visibleCues.map(c => c.translation).filter(Boolean).join('\n');
      const allLangs = [...new Set(visibleCues.flatMap(c => c._langs || (Array.isArray(c.langs) ? c.langs : [c.lang])).filter(Boolean))];
      const langBadge = allLangs.length > 1 ? allLangs.join(' / ').toUpperCase() : (allLangs[0] ? allLangs[0].toUpperCase() : '');
      if (typeof window.__livesubRenderSubtitle === 'function') {
        window.__livesubRenderSubtitle({
          text: combinedText,
          translation: combinedTrans,
          lang: langBadge
        });
      }
    }
  }

  function setupVideoListeners(video) {
    if (!video || video === activeVideoEl) return;
    activeVideoEl = video;

    if (bridge) {
      bridge.destroy();
      bridge = null;
    }

    bridge = new SyncBridge({
      video: video,
      tickMs: 50,
      minHold: 2.0,
      render: onBridgeRender,
      onStatus: (status, data) => {
        if (status === 'seeking' || status === 'ratechange' || status === 'play' || status === 'pause') {
          sendVideoObservation(true);
        }
      }
    });

    video.addEventListener('seeking', () => sendVideoObservation(true));
    video.addEventListener('seeked', () => sendVideoObservation(true));
    video.addEventListener('ratechange', () => sendVideoObservation(true));
    video.addEventListener('play', () => sendVideoObservation(true));
    video.addEventListener('pause', () => sendVideoObservation(true));
    video.addEventListener('timeupdate', () => sendVideoObservation(false));

    sendVideoObservation(true);
    console.log('[CtrlCV Pipeline] SyncBridge mounted to video element.');
    setTimeout(checkForManualCaptions, 400);
  }

  async function checkForManualCaptions() {
    if (typeof globalThis.CtrlCVCaptions?.initCaptionPath === 'function' && bridge) {
      try {
        const res = await globalThis.CtrlCVCaptions.initCaptionPath({
          bridge,
          video: activeVideoEl
        });
        if (res && res.active) {
          console.log(`[CtrlCV Pipeline] Manual caption track loaded (${res.count} cues). Tab audio capture stopped.`);
          return true;
        }
      } catch (err) {
        console.warn('[CtrlCV Pipeline] Caption check error:', err);
      }
    }
    return false;
  }

  let pollInterval = null;
  function pollForVideo() {
    const video = document.querySelector('#movie_player video') || document.querySelector('video');
    if (video) {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      setupVideoListeners(video);
      return;
    }
    if (pollInterval) return;
    let attempts = 0;
    pollInterval = setInterval(() => {
      attempts++;
      const v = document.querySelector('#movie_player video') || document.querySelector('video');
      if (v) {
        clearInterval(pollInterval);
        pollInterval = null;
        setupVideoListeners(v);
      } else if (attempts >= 60) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    }, 400);
  }

  // 5. YouTube SPA Navigation Handling
  window.addEventListener('yt-navigate-finish', () => {
    const vid = getVideoId();
    console.log(`[CtrlCV Pipeline] Navigation event detected -> video_id: ${vid}`);
    if (bridge) {
      bridge.onNavigation({ video_id: vid, title: document.title });
    }
    sendVideoObservation(true);
    pollForVideo();
    setTimeout(checkForManualCaptions, 400);
  });

  // 6. Ad Detection Observer
  function checkAdMutation() {
    const isAd = isAdShowing();
    if (isAd && !adActive) {
      adActive = true;
      if (bridge) bridge.onAdStart();
      sendVideoObservation(true);
      console.log('[CtrlCV Pipeline] Ad started -> bridge.onAdStart()');
    } else if (!isAd && adActive) {
      adActive = false;
      if (bridge) bridge.onAdEnd();
      sendVideoObservation(true);
      console.log('[CtrlCV Pipeline] Ad ended -> bridge.onAdEnd()');
    }
  }

  const observer = new MutationObserver(() => {
    checkAdMutation();
    const v = document.querySelector('#movie_player video') || document.querySelector('video');
    if (v && v !== activeVideoEl) {
      setupVideoListeners(v);
    }
  });

  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
    childList: true,
    subtree: true
  });

  // 4. Message Listeners for CHUNK_SENT, RESULT, and STATUS
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return false;
    const action = message.type || message.action;

    if (action === 'CHUNK_SENT') {
      if (typeof window.__livesubOnChunkSent === 'function') {
        window.__livesubOnChunkSent(message);
      }
      if (bridge) {
        bridge.registerChunk(message.chunk_id, {
          video_start_time: message.video_start_time,
          playback_rate: message.playback_rate
        });
        sendResponse({ status: 'registered', chunk_id: message.chunk_id });
      } else {
        sendResponse({ status: 'dropped', reason: 'bridge_not_ready' });
      }
      return true;
    }

    if (action === 'RESULT') {
      if (typeof window.__livesubOnResult === 'function') {
        window.__livesubOnResult(message);
      }
      const resultFrame = message.result || message;
      if (bridge) {
        let overrideCtx = null;
        if (!bridge._chunkMetaMap?.has(resultFrame.chunk_id)) {
          const rate = resultFrame.playback_rate || 1.0;
          const vStart = (typeof resultFrame.video_start_time === 'number')
            ? resultFrame.video_start_time
            : (typeof resultFrame.start === 'number' && typeof resultFrame.start_offset === 'number')
              ? Number((resultFrame.start - resultFrame.start_offset * rate).toFixed(6))
              : (activeVideoEl?.currentTime || 0.0);
          overrideCtx = {
            video_start_time: vStart,
            playback_rate: rate
          };
        }
        const outcome = bridge.handleResult(resultFrame, overrideCtx);
        sendResponse(outcome);
      } else {
        sendResponse({ status: 'dropped', reason: 'bridge_not_ready' });
      }
      return true;
    }

    if (action === 'STATUS') {
      if (typeof window.__livesubUpdateHud === 'function') {
        const update = {};
        if (message.status === 'Streaming') {
          update.capture_state = 'capturing';
          update.ws_state = 'connected';
        } else if (message.status === 'Connecting') {
          update.capture_state = 'starting';
          update.ws_state = 'connecting';
        } else if (message.status === 'Idle') {
          update.capture_state = 'idle';
          update.ws_state = 'disconnected';
        } else if (message.status === 'Error') {
          update.capture_state = 'error';
          update.ws_state = 'error';
        }
        if (message.capture_state) update.capture_state = message.capture_state;
        if (message.ws_state) update.ws_state = message.ws_state;
        if (message.last_error || message.message) update.last_error = message.last_error || message.message;
        window.__livesubUpdateHud(update);
      }
      return false;
    }

    // 7. Judge Export Message Handler
    if (action === 'EXPORT_CUE_LOG') {
      const cueLog = bridge ? bridge.exportLog() : [];
      const archive = bridge ? bridge.exportArchive() : [];
      sendResponse({ success: true, cueLog, archive });
      return true;
    }

    if (action === 'SET_ENABLED') {
      if (message.enabled !== false) {
        sendVideoObservation(true);
      }
      return false;
    }

    if (action === 'GET_VIDEO_OBSERVATION' || action === 'REQUEST_VIDEO_OBSERVATION') {
      const obs = getVideoObservationPayload();
      sendResponse({ success: true, observation: obs });
      sendVideoObservation(true);
      return true;
    }

    return false;
  });

  // Periodic observation heartbeat while playing (every 250ms)
  setInterval(() => {
    const video = activeVideoEl || document.querySelector('#movie_player video') || document.querySelector('video');
    if (video && !video.paused) {
      sendVideoObservation(false);
    }
  }, 250);

  // 7. Expose Judge Export Hooks on Window
  window.__ctrlcvExportCueLog = function(asString = false) {
    const cues = bridge ? bridge.exportLog() : [];
    return asString ? JSON.stringify(cues, null, 2) : cues;
  };

  window.__ctrlcvExportArchive = function(asString = false) {
    const archive = bridge ? bridge.exportArchive() : [];
    return asString ? JSON.stringify(archive, null, 2) : archive;
  };

  window.__ctrlcvGetBridge = function() {
    return bridge;
  };

  pollForVideo();
})();
