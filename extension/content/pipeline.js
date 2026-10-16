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

  function sendVideoObservation(force = false) {
    const now = Date.now();
    if (!force && (now - lastObservationMs < 250)) {
      return;
    }
    lastObservationMs = now;

    const video = activeVideoEl || document.querySelector('#movie_player video') || document.querySelector('video');
    if (!video) return;

    const adState = isAdShowing() ? 'ad_playing' : 'main_video';
    const obs = {
      epoch: bridge ? bridge.getEpoch() : 0,
      video_id: getVideoId(),
      video_current_time: Number((video.currentTime || 0).toFixed(6)),
      playback_rate: video.playbackRate || 1.0,
      paused: Boolean(video.paused),
      seeking: Boolean(video.seeking),
      ad_state: adState,
      wall_time_ms: now
    };

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
      if (typeof window.__livesubClearSubtitle === 'function') {
        window.__livesubClearSubtitle();
      }
    } else {
      const combinedText = visibleCues.map(c => c.text).filter(Boolean).join('\n');
      const combinedTrans = visibleCues.map(c => c.translation).filter(Boolean).join('\n');
      if (typeof window.__livesubRenderSubtitle === 'function') {
        window.__livesubRenderSubtitle({
          text: combinedText,
          translation: combinedTrans
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

  // 4. Message Listeners for CHUNK_SENT and RESULT
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return false;
    const action = message.type || message.action;

    if (action === 'CHUNK_SENT') {
      if (bridge) {
        bridge.registerChunk(message.chunk_id, {
          video_start_time: message.video_start_time,
          playback_rate: message.playback_rate
        });
        sendResponse({ status: 'registered', chunk_id: message.chunk_id });
      } else {
        sendResponse({ status: 'dropped', reason: 'bridge_not_ready' });
      }
      return false;
    }

    if (action === 'RESULT') {
      const resultFrame = message.result || message;
      if (bridge) {
        const outcome = bridge.handleResult(resultFrame);
        sendResponse(outcome);
      } else {
        sendResponse({ status: 'dropped', reason: 'bridge_not_ready' });
      }
      return false;
    }

    // 7. Judge Export Message Handler
    if (action === 'EXPORT_CUE_LOG') {
      const cueLog = bridge ? bridge.exportLog() : [];
      const archive = bridge ? bridge.exportArchive() : [];
      sendResponse({ success: true, cueLog, archive });
      return false;
    }

    return false;
  });

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
