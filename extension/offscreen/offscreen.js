// Offscreen document script for audio capture and speaker passthrough (Role B / Spike)
// Invariants: Audio-only capture, single audible connection to destination, zero network transmission.

let currentStream = null;
let audioContext = null;
let sourceNode = null;
let workletNode = null;
let silentGain = null;
let isCapturing = false;

// Timing and video anchor state
let sessionId = 'sess_' + Date.now();
let currentVideoId = null;
let currentEpoch = 1;
let latestAnchor = null;
let wsClient = null;
let currentTargetTabId = null;

// Bounded ring buffer for diagnostic metadata
const MAX_DIAGNOSTIC_HISTORY = 50;
const diagnosticHistory = [];

function recordDiagnostic(rawMeta) {
  const nowMs = rawMeta.wall_time_ms || Date.now();
  let chunkStartV = null;
  let chunkEndV = null;
  let sttEligible = false;
  let playbackRate = latestAnchor ? latestAnchor.playback_rate : 1.0;
  let paused = latestAnchor ? latestAnchor.paused : true;
  let seeking = latestAnchor ? latestAnchor.seeking : false;
  let adState = latestAnchor ? latestAnchor.ad_state : 'unknown';

  // Invariant check: only associate timing if anchor is fresh and video is playing
  if (
    latestAnchor &&
    latestAnchor.epoch === rawMeta.epoch &&
    latestAnchor.video_id === currentVideoId &&
    !paused &&
    !seeking &&
    adState !== 'ad_playing'
  ) {
    const ageMs = nowMs - latestAnchor.wall_time_ms;
    // Max anchor age: 500 ms
    if (ageMs >= 0 && ageMs <= 500) {
      const elapsedVideoS = (ageMs / 1000.0) * playbackRate;
      chunkEndV = parseFloat((latestAnchor.video_current_time + elapsedVideoS).toFixed(6));
      const chunkSpanS = rawMeta.audio_duration_s * playbackRate;
      const computedStart = parseFloat((chunkEndV - chunkSpanS).toFixed(6));
      if (computedStart < 0) {
        chunkStartV = null;
        chunkEndV = null;
        sttEligible = false;
      } else {
        chunkStartV = computedStart;
        sttEligible = true;
      }
    }
  }

  const fullDiagnostic = {
    type: 'chunk_diagnostic',
    session_id: sessionId,
    video_id: currentVideoId,
    epoch: rawMeta.epoch,
    chunk_id: rawMeta.chunk_id,
    sample_rate_hz: rawMeta.sample_rate_hz,
    channels: rawMeta.channels,
    sample_count: rawMeta.sample_count,
    audio_duration_s: rawMeta.audio_duration_s,
    chunk_video_start: chunkStartV,
    chunk_video_end: chunkEndV,
    playback_rate: playbackRate,
    paused: paused,
    seeking: seeking,
    ad_state: adState,
    is_final_partial: rawMeta.is_final_partial,
    stt_eligible: sttEligible,
    timing_verified: sttEligible,
    rms: rawMeta.rms,
    peak: rawMeta.peak
  };

  if (diagnosticHistory.length >= MAX_DIAGNOSTIC_HISTORY) {
    diagnosticHistory.shift();
  }
  diagnosticHistory.push(fullDiagnostic);

  console.log(
    `[AudioChunk #${fullDiagnostic.chunk_id} | Ep ${fullDiagnostic.epoch}] ` +
    `Video: [${chunkStartV !== null ? chunkStartV + 's' : 'null'} -> ` +
    `${chunkEndV !== null ? chunkEndV + 's' : 'null'}] (Rate: ${playbackRate}x) | ` +
    `Dur: ${fullDiagnostic.audio_duration_s}s | Eligible: ${sttEligible} | ` +
    `RMS: ${fullDiagnostic.rms} | Peak: ${fullDiagnostic.peak}` +
    (fullDiagnostic.is_final_partial ? ' [FINAL PARTIAL]' : '')
  );
}

function applyVideoObservation(obs) {
  if (!obs) return;

  // Stale observation check
  if (typeof obs.epoch === 'number' && obs.epoch < currentEpoch) {
    console.warn(`[Offscreen] Stale observation ignored: epoch ${obs.epoch} < current ${currentEpoch}`);
    return;
  }

  // Discontinuity or epoch bump
  if (obs.video_id !== currentVideoId || (typeof obs.epoch === 'number' && obs.epoch > currentEpoch)) {
    currentVideoId = obs.video_id;
    if (typeof obs.epoch === 'number') {
      currentEpoch = obs.epoch;
    }
    console.log(`[Offscreen] Discontinuity detected: video_id=${currentVideoId}, epoch=${currentEpoch}`);
    if (workletNode && workletNode.port) {
      workletNode.port.postMessage({
        type: 'DISCONTINUITY',
        epoch: currentEpoch,
        video_id: currentVideoId
      });
    }
  }

  latestAnchor = obs;
  if (wsClient) {
    wsClient.updateVideoObservation(obs);
  }
}

async function startCapture(streamId, targetTabId = null) {
  if (isCapturing) {
    console.warn('[Offscreen] Capture already running. Ignoring duplicate start.');
    return { success: true, message: 'Already capturing' };
  }
  currentTargetTabId = targetTabId;

  // Proactively request initial video timeline anchor from target tab
  if (targetTabId) {
    try {
      const resp = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 300);
        chrome.tabs.sendMessage(targetTabId, { action: 'GET_VIDEO_OBSERVATION' }, (r) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) resolve(null);
          else resolve(r);
        });
      });
      if (resp && resp.observation) {
        applyVideoObservation(resp.observation);
      }
    } catch (_) {}
  }

  try {
    // 1. Consume the tab stream ID promptly using audio-only getUserMedia
    currentStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    const audioTracks = currentStream.getAudioTracks();
    if (audioTracks.length === 0) {
      throw new Error('No audio tracks returned from tabCapture stream');
    }

    // 2. Setup listener for unexpected stream termination (e.g. tab closed or navigation)
    audioTracks[0].addEventListener('ended', () => {
      console.log('[Offscreen] Audio track ended unexpectedly.');
      stopCapture();
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_STREAM_ENDED' }).catch(() => {});
    });

    // 3. Setup AudioContext
    audioContext = new AudioContext();
    console.log(`[Offscreen] AudioContext running at actual sample rate: ${audioContext.sampleRate} Hz`);

    if (audioContext.state === 'suspended') {
      try {
        await audioContext.resume();
      } catch (resumeErr) {
        console.warn('[Offscreen] AudioContext resume rejected:', resumeErr);
      }
    }

    // 4. Connect source stream to AudioContext.destination exactly once (Single audible speaker path)
    sourceNode = audioContext.createMediaStreamSource(currentStream);
    sourceNode.connect(audioContext.destination);

    // 5. Load and initialize AudioWorklet processing branch
    const processorUrl = chrome.runtime.getURL('offscreen/audio-processor.js');
    await audioContext.audioWorklet.addModule(processorUrl);
    workletNode = new AudioWorkletNode(audioContext, 'audio-chunk-processor');

    // Handle diagnostic metadata and PCM audio from AudioWorklet
    workletNode.port.onmessage = (event) => {
      if (!event.data) return;
      if (event.data.type === 'CHUNK_AUDIO' || event.data.type === 'CHUNK_DIAGNOSTIC') {
        recordDiagnostic(event.data);
        if (event.data.pcm && wsClient && isCapturing) {
          wsClient.feedAudioBlock(new Int16Array(event.data.pcm), event.data.audio_duration_s);
        }
      }
    };

    // Initialize WsClient for backend streaming
    const WsClientClass = globalThis.WsClient || (typeof window !== 'undefined' && window.WsClient) || (typeof self !== 'undefined' && self.WsClient);
    if (WsClientClass) {
      chrome.runtime.sendMessage({ type: 'STATUS', status: 'Connecting', ws_state: 'connecting' }, () => {
        if (chrome.runtime.lastError) {}
      });
      wsClient = new WsClientClass({
        initialEpoch: currentEpoch,
        initialPlaybackRate: latestAnchor ? latestAnchor.playback_rate : 1.0,
        onChunkSent: (chunkInfo) => {
          chrome.runtime.sendMessage({
            type: 'CHUNK_SENT',
            targetTabId: currentTargetTabId,
            chunk_id: chunkInfo.chunk_id,
            video_start_time: chunkInfo.video_start_time,
            playback_rate: chunkInfo.playback_rate,
            epoch: chunkInfo.epoch
          }, () => {
            if (chrome.runtime.lastError) {}
          });
          chrome.runtime.sendMessage({
            type: 'STATUS',
            status: 'Streaming',
            capture_state: 'capturing',
            ws_state: 'connected'
          }, () => {
            if (chrome.runtime.lastError) {}
          });
        },
        onResult: (result) => {
          chrome.runtime.sendMessage({
            type: 'RESULT',
            targetTabId: currentTargetTabId,
            result: result
          }, () => {
            if (chrome.runtime.lastError) {}
          });
        },
        onOpen: () => {
          chrome.runtime.sendMessage({
            type: 'STATUS',
            status: 'Streaming',
            capture_state: 'capturing',
            ws_state: 'connected'
          }, () => {
            if (chrome.runtime.lastError) {}
          });
        },
        onError: (err) => {
          console.warn('[Offscreen WS] Error:', err);
          const errMsg = err?.message || String(err);
          chrome.runtime.sendMessage({
            type: 'STATUS',
            status: 'Error',
            message: errMsg,
            last_error: errMsg,
            ws_state: 'error'
          }, () => {
            if (chrome.runtime.lastError) {}
          });
        },
        onClose: () => {
          chrome.runtime.sendMessage({
            type: 'STATUS',
            status: 'Idle',
            ws_state: 'disconnected'
          }, () => {
            if (chrome.runtime.lastError) {}
          });
        }
      });

      if (latestAnchor) {
        wsClient.updateVideoObservation(latestAnchor);
        wsClient.sendSeek(latestAnchor.video_current_time || 0.0, currentEpoch, 'init');
      } else {
        wsClient.sendSeek(0.0, currentEpoch, 'init');
      }

      wsClient.connect().catch((err) => {
        console.warn('[Offscreen WS] Connect error (will retry or offline):', err);
        const errMsg = err?.message || String(err);
        chrome.runtime.sendMessage({
          type: 'STATUS',
          status: 'Error',
          message: errMsg,
          last_error: errMsg,
          ws_state: 'error'
        }, () => {
          if (chrome.runtime.lastError) {}
        });
      });
    }

    // Connect source to workletNode
    sourceNode.connect(workletNode);

    // Connect worklet to a silent sink (gain 0.0) -> destination to keep processing graph active
    // without introducing a second audible path or audio doubling.
    silentGain = audioContext.createGain();
    silentGain.gain.value = 0.0;
    workletNode.connect(silentGain);
    silentGain.connect(audioContext.destination);

    isCapturing = true;
    console.log('[Offscreen] Capture, audible playback, and AudioWorklet processing active.');
    return { success: true, actualSampleRate: audioContext.sampleRate };
  } catch (err) {
    console.error('[Offscreen] Failed to start capture:', err);
    await stopCapture();
    return { success: false, error: err.message || String(err) };
  }
}

async function stopCapture() {
  if (!isCapturing && !currentStream && !audioContext) {
    return { success: true, message: 'Already stopped' };
  }

  try {
    if (wsClient) {
      try {
        wsClient.close();
      } catch (e) {
        console.warn('[Offscreen] Error closing wsClient:', e);
      }
      wsClient = null;
    }

    // 1. Flush any partial chunk in the worklet before teardown
    if (workletNode && workletNode.port) {
      try {
        workletNode.port.postMessage({ type: 'FLUSH_PARTIAL' });
      } catch (e) {
        console.warn('[Offscreen] Error flushing worklet:', e);
      }
    }

    // 2. Stop every track on the media stream
    if (currentStream) {
      currentStream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (e) {
          console.warn('[Offscreen] Error stopping track:', e);
        }
      });
      currentStream = null;
    }

    // 3. Disconnect Web Audio nodes
    if (silentGain) {
      try {
        silentGain.disconnect();
      } catch (e) {}
      silentGain = null;
    }

    if (workletNode) {
      try {
        workletNode.disconnect();
      } catch (e) {}
      workletNode = null;
    }

    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch (e) {
        console.warn('[Offscreen] Error disconnecting source node:', e);
      }
      sourceNode = null;
    }

    // 4. Close the AudioContext
    if (audioContext) {
      try {
        if (audioContext.state !== 'closed') {
          await audioContext.close();
        }
      } catch (e) {
        console.warn('[Offscreen] Error closing AudioContext:', e);
      }
      audioContext = null;
    }

    latestAnchor = null;
    currentEpoch = 1;
    isCapturing = false;
    console.log('[Offscreen] Capture stopped and all audio processing resources cleaned up.');
    return { success: true };
  } catch (err) {
    console.error('[Offscreen] Error during teardown:', err);
    isCapturing = false;
    return { success: false, error: err.message || String(err) };
  }
}

// Runtime message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') {
    return false;
  }

  if (message.type === 'START_OFFSCREEN_CAPTURE') {
    startCapture(message.streamId, message.targetTabId)
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message || String(err) }));
    return true;
  }

  if (message.type === 'STOP_OFFSCREEN_CAPTURE') {
    stopCapture()
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err.message || String(err) }));
    return true;
  }



  if (message.type === 'VIDEO_STATE_OBSERVATION') {
    applyVideoObservation(message.observation);
    return false;
  }

  if (message.type === 'UPDATE_LANGUAGES') {
    if (wsClient) {
      wsClient.updateLanguages(message.source_lang, message.target_lang);
    }
    return false;
  }

  if (message.type === 'EXPORT_DIAGNOSTICS') {
    const jsonl = diagnosticHistory.map(d => JSON.stringify(d)).join('\n');
    sendResponse({
      success: true,
      count: diagnosticHistory.length,
      jsonl: jsonl
    });
    return false;
  }

  if (message.type === 'GET_OFFSCREEN_STATUS') {
    sendResponse({
      isCapturing,
      audioContextState: audioContext ? audioContext.state : 'null',
      actualSampleRate: audioContext ? audioContext.sampleRate : null,
      hasStream: !!currentStream,
      currentVideoId,
      currentEpoch,
      hasAnchor: !!latestAnchor,
      recentDiagnostics: diagnosticHistory.slice(-5)
    });
    return false;
  }

  return false;
});

