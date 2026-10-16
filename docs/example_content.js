/**
 * docs/example_content.js: Reference Content Script for Role A (~60 lines).
 * Complete wiring: registerChunk, handleResult, seeking, navigation, ad, export, off switch.
 */
const { SyncBridge } = globalThis.CtrlCVSync;

// 1. Locate video element & subtitle overlay container
const video = document.querySelector("video.html5-main-video") || document.querySelector("video");
const overlay = document.getElementById("ctrlcv-overlay") || document.createElement("div");

// 2. Initialize SyncBridge (automatically binds video seeking, ratechange, play, pause)
const bridge = new SyncBridge({
  video,
  tickMs: 50,
  minHold: 2.0,
  render: (visibleCues) => {
    overlay.textContent = visibleCues.map(c => c.translation || c.text).join("\n");
    overlay.style.display = visibleCues.length > 0 ? "block" : "none";
  }
});

// 3. WebSocket Setup
const ws = new WebSocket(window.__ctrlcvWsUrl || "ws://localhost:8000/ws");

// 4. Send Audio Chunk: registerChunk at capture time before sending
function sendAudioChunk(chunkId, pcmBytes) {
  const vStart = Number(video.currentTime.toFixed(2));
  const rate = video.playbackRate || 1.0;
  bridge.registerChunk(chunkId, { video_start_time: vStart, playback_rate: rate });

  const header = {
    type: "chunk",
    chunk_id: chunkId,
    epoch: bridge.getEpoch(),
    video_start_time: vStart,
    playback_rate: rate,
    sample_rate: 16000
  };
  ws.send(JSON.stringify(header));
  ws.send(pcmBytes);
}

// 5. Inbound Results: handleResult consumes registered context, drops unknown chunks
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === "result") {
    bridge.handleResult(msg);
  }
};

// 6. Navigation: YouTube client-side SPA navigation archives previous cues
window.addEventListener("yt-navigate-finish", () => {
  const videoId = new URLSearchParams(window.location.search).get("v") || "unknown";
  bridge.onNavigation({ video_id: videoId, title: document.title });
});

// 7. Ad Detection: Isolate ads to prevent subtitle desync
let adActive = false;
const adObserver = new MutationObserver(() => {
  const isAd = document.querySelector(".ad-showing, .video-ads") !== null;
  if (isAd && !adActive) {
    adActive = true;
    bridge.onAdStart();
  } else if (!isAd && adActive) {
    adActive = false;
    bridge.onAdEnd();
  }
});
adObserver.observe(document.querySelector("#movie_player") || document.body, { attributes: true, subtree: true });

// 8. Global Export Hooks for Judges
window.__ctrlcvExportCueLog = () => bridge.exportLog();
window.__ctrlcvExportArchive = () => bridge.exportArchive();

// 9. Off Switch: Cleanly unmount overlay and halt background tasks
window.__ctrlcvOff = () => {
  adObserver.disconnect();
  bridge.destroy();
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
};
