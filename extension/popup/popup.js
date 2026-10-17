/**
 * popup.js - Extension popup logic
 * Controls tab capture initiation, settings persistence,
 * dynamic content script injection, and cue log / SRT exports.
 */

let activeTab = null;
let isCapturing = false;

document.addEventListener('DOMContentLoaded', async () => {
  // Guard: Detect if opened as file:/// instead of extension popup
  if (typeof chrome === 'undefined' || !chrome.runtime?.id || !chrome.tabs) {
    const banner = document.createElement('div');
    banner.style.cssText = 'background:#ef4444;color:#ffffff;padding:12px;font-weight:600;font-size:12px;border-radius:8px;margin-bottom:14px;text-align:center;line-height:1.4;box-shadow:0 4px 12px rgba(239,68,68,0.4);';
    banner.innerHTML = '⚠️ <strong>Local File Notice:</strong><br>You opened popup.html as a local file (file:///). Extension APIs are disabled here.<br><br>👉 <strong>To use LiveSub:</strong><br>1. Open a YouTube video tab.<br>2. Click the puzzle icon (🧩) in the top-right toolbar.<br>3. Click <strong>LiveSub</strong> (or pin it 📌).';
    document.body.prepend(banner);
    setupEventListeners();
    return;
  }

  activeTab = await getActiveTab();

  if (activeTab && activeTab.id && activeTab.url && activeTab.url.includes('youtube.com')) {
    await ensureContentScriptInjected(activeTab.id);
  }

  // Restore saved preferences
  chrome.storage.local.get(['sourceLang', 'source_lang', 'targetLang', 'target_lang', 'wsUrl', 'backend_url'], (res) => {
    const src = res.sourceLang || res.source_lang;
    const tgt = res.targetLang || res.target_lang;
    const url = res.wsUrl || res.backend_url;
    if (src) {
      const el = document.getElementById('select-source-lang');
      if (el) el.value = src;
    }
    if (tgt) {
      const el = document.getElementById('select-target-lang');
      if (el) el.value = tgt;
    }
    if (url) {
      const el = document.getElementById('input-ws-url');
      if (el) el.value = url;
    }
  });

  // Query background status
  chrome.runtime.sendMessage({ type: 'GET_STATUS', action: 'GET_STATUS' }, (status) => {
    if (status && status.isCapturing) {
      isCapturing = true;
      setCaptureButtonState(true);
      updateStatusBadge('Streaming', 'active');
    } else {
      isCapturing = false;
      setCaptureButtonState(false);
      updateStatusBadge('Standby', 'inactive');
    }
  });

  updateCaptionBanner();
  setupEventListeners();
});

async function getActiveTab() {
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  }
  return tab;
}

async function ensureContentScriptInjected(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'PING', action: 'PING' });
    if (res && res.status === 'pong') return;
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['vendor/syncEngine.browser.js', 'content/caption_path.js', 'content/pipeline.js', 'content/content.js']
      });
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ['content/content.css', 'content/overlay.css']
      });
    } catch (err) {
      console.warn('[LiveSub Popup] Dynamic script injection notice:', err);
    }
  }
}

function getMediaStreamIdFromPopup(targetTabId) {
  return new Promise((resolve) => {
    if (!chrome.tabCapture || !chrome.tabCapture.getMediaStreamId) {
      resolve(null);
      return;
    }
    try {
      chrome.tabCapture.getMediaStreamId({ targetTabId }, (streamId) => {
        if (chrome.runtime.lastError || !streamId) {
          console.warn('[LiveSub Popup] tabCapture warning:', chrome.runtime.lastError);
          resolve(null);
        } else {
          resolve(streamId);
        }
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function setupEventListeners() {
  const toggleBtn = document.getElementById('btn-toggle-capture');
  const demoBtn = document.getElementById('btn-test-overlay');
  const clearBtn = document.getElementById('btn-clear-overlay');
  const exportLogBtn = document.getElementById('btn-export-log');
  const exportSrtBtn = document.getElementById('btn-export-srt');
  const clearCacheBtn = document.getElementById('btn-clear-cache');

  if (toggleBtn) toggleBtn.addEventListener('click', handleToggleCapture);
  if (demoBtn) demoBtn.addEventListener('click', handleTestOverlay);
  if (clearBtn) clearBtn.addEventListener('click', handleClearOverlay);
  if (exportLogBtn) exportLogBtn.addEventListener('click', handleExportCueLog);
  if (exportSrtBtn) exportSrtBtn.addEventListener('click', handleExportSrt);
  if (clearCacheBtn) clearCacheBtn.addEventListener('click', handleClearScriptCache);

  // Auto-save settings on change
  ['select-source-lang', 'select-target-lang', 'input-ws-url'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', saveSettings);
  });
}

async function handleClearScriptCache() {
  const clearCacheBtn = document.getElementById('btn-clear-cache');
  if (clearCacheBtn) {
    clearCacheBtn.disabled = true;
    clearCacheBtn.innerHTML = '<span>⏳</span> Clearing...';
  }
  activeTab = await getActiveTab();
  if (activeTab && activeTab.id) {
    chrome.tabs.sendMessage(activeTab.id, { action: 'CLEAR_SCRIPT_CACHE' }, () => {
      if (chrome.runtime.lastError) {}
      chrome.storage.local.get(null, all => {
        if (all) {
          const keys = Object.keys(all).filter(k => k.startsWith('livesub_script_cache_'));
          if (keys.length > 0) chrome.storage.local.remove(keys);
        }
      });
      setTimeout(() => {
        if (clearCacheBtn) {
          clearCacheBtn.disabled = false;
          clearCacheBtn.innerHTML = '<span>⚡</span> Clear Script Cache Memory';
        }
        updateCaptionBanner();
      }, 400);
    });
  } else {
    chrome.storage.local.get(null, all => {
      if (all) {
        const keys = Object.keys(all).filter(k => k.startsWith('livesub_script_cache_'));
        if (keys.length > 0) chrome.storage.local.remove(keys);
      }
    });
    if (clearCacheBtn) {
      clearCacheBtn.disabled = false;
      clearCacheBtn.innerHTML = '<span>⚡</span> Clear Script Cache Memory';
    }
    updateCaptionBanner();
  }
}

function saveSettings() {
  const sourceLang = document.getElementById('select-source-lang')?.value || 'hi';
  const targetLang = document.getElementById('select-target-lang')?.value || 'en';
  const wsUrl = document.getElementById('input-ws-url')?.value.trim() || 'ws://127.0.0.1:8000/ws';

  chrome.storage.local.set({
    sourceLang,
    source_lang: sourceLang,
    targetLang,
    target_lang: targetLang,
    wsUrl,
    backend_url: wsUrl
  });

  if (activeTab && activeTab.id) {
    chrome.tabs.sendMessage(activeTab.id, {
      type: 'SET_SETTINGS',
      targetLanguage: targetLang
    }).catch(() => {});
  }
  updateCaptionBanner();
}

async function handleToggleCapture() {
  const toggleBtn = document.getElementById('btn-toggle-capture');

  if (typeof chrome === 'undefined' || !chrome.runtime?.id || !chrome.tabs) {
    alert('⚠️ LiveSub must be opened by clicking the LiveSub icon in Chrome\'s top-right toolbar on a YouTube tab, not as a local file:/// page.');
    return;
  }

  // Pre-query or use existing activeTab
  if (!activeTab || !activeTab.id) {
    activeTab = await getActiveTab();
  }

  if (!activeTab || !activeTab.id) {
    alert('Please switch to an active YouTube video tab and click the extension icon again.');
    return;
  }

  saveSettings();

  const sourceLang = document.getElementById('select-source-lang')?.value || 'hi';
  const targetLang = document.getElementById('select-target-lang')?.value || 'en';
  const wsUrl = document.getElementById('input-ws-url')?.value.trim() || 'ws://127.0.0.1:8000/ws';

  if (!isCapturing) {
    toggleBtn.disabled = true;
    toggleBtn.innerHTML = '<span>⏳</span> Connecting...';

    // Initiate stream ID acquisition immediately under user gesture context
    const streamPromise = getMediaStreamIdFromPopup(activeTab.id);

    await ensureContentScriptInjected(activeTab.id);

    const popupStreamId = await streamPromise;

    chrome.runtime.sendMessage({
      type: 'START_CAPTURE',
      action: 'START_CAPTURE',
      tabId: activeTab.id,
      targetTabId: activeTab.id,
      streamId: popupStreamId,
      config: { sourceLanguage: sourceLang, targetLanguage: targetLang, wsUrl }
    }, (res) => {
      toggleBtn.disabled = false;
      if (res && res.success) {
        isCapturing = true;
        setCaptureButtonState(true);
        updateStatusBadge('Streaming', 'active');
      } else {
        const errorMsg = res && res.error ? res.error : 'Failed to start capture. Ensure you are on a YouTube video tab.';
        alert(errorMsg);
        setCaptureButtonState(false);
        updateStatusBadge('Error', 'inactive');
      }
    });
  } else {
    chrome.runtime.sendMessage({ type: 'STOP_CAPTURE', action: 'STOP_CAPTURE' }, () => {
      isCapturing = false;
      setCaptureButtonState(false);
      updateStatusBadge('Standby', 'inactive');
    });
  }
}

function setCaptureButtonState(capturing) {
  const toggleBtn = document.getElementById('btn-toggle-capture');
  if (!toggleBtn) return;
  if (capturing) {
    toggleBtn.className = 'btn btn-danger';
    toggleBtn.innerHTML = '<span>⏹</span> Stop Audio Capture';
  } else {
    toggleBtn.className = 'btn btn-primary';
    toggleBtn.innerHTML = '<span>▶</span> Start Audio Capture';
  }
}

function updateStatusBadge(text, state) {
  const statusText = document.getElementById('status-text');
  const pill = document.getElementById('status-pill');
  if (statusText && pill) {
    statusText.textContent = text;
    if (state === 'active') {
      pill.style.background = 'rgba(34, 197, 94, 0.15)';
      pill.style.color = '#22c55e';
    } else {
      pill.style.background = 'rgba(148, 163, 184, 0.15)';
      pill.style.color = '#94a3b8';
    }
  }
}

async function handleTestOverlay() {
  activeTab = await getActiveTab();
  if (!activeTab || !activeTab.id) return;
  const sourceLang = document.getElementById('select-source-lang')?.value || 'hi';

  await ensureContentScriptInjected(activeTab.id);
  chrome.tabs.sendMessage(activeTab.id, {
    action: 'RUN_DEMO',
    type: 'RUN_DEMO',
    lang: sourceLang
  }).catch(() => {});
}

async function handleClearOverlay() {
  activeTab = await getActiveTab();
  if (!activeTab || !activeTab.id) return;

  chrome.tabs.sendMessage(activeTab.id, {
    action: 'STOP_DEMO',
    type: 'STOP_DEMO'
  }).catch(() => {});
}

async function updateCaptionBanner() {
  const box = document.getElementById('caption-status-box');
  const icon = document.getElementById('caption-status-icon');
  const text = document.getElementById('caption-status-text');
  if (!box || !icon || !text) return;

  activeTab = await getActiveTab();
  if (!activeTab || !activeTab.id || !activeTab.url || !activeTab.url.includes('youtube.com')) {
    icon.textContent = '⏸️';
    text.textContent = 'Open a YouTube video to use LiveSub';
    box.style.background = 'rgba(255, 255, 255, 0.05)';
    box.style.borderColor = 'rgba(255, 255, 255, 0.1)';
    text.style.color = '#94a3b8';
    return;
  }

  // 1. Try querying content script
  let status = null;
  try {
    status = await new Promise((resolve) => {
      chrome.tabs.sendMessage(activeTab.id, { action: 'CHECK_CAPTION_STATUS' }, (res) => {
        if (chrome.runtime.lastError || !res) resolve(null);
        else resolve(res);
      });
    });
  } catch (_) {}

  // 2. Query main world if needed
  let hasCaptions = status?.hasCaptions || false;
  let trackNames = (status?.tracks || []).map(t => t.name || t.languageCode).join(', ');
  let liveCount = status?.recordedCuesCount || 0;

  if (!hasCaptions) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        world: 'MAIN',
        func: () => {
          const p = document.querySelector('#movie_player');
          const pr = (p && typeof p.getPlayerResponse === 'function') ? p.getPlayerResponse() : window.ytInitialPlayerResponse;
          const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
          return tracks.map(t => t.name?.simpleText || t.languageCode);
        }
      });
      const tracks = results?.[0]?.result || [];
      if (tracks.length > 0) {
        hasCaptions = true;
        trackNames = tracks.slice(0, 2).join(', ');
      }
    } catch (_) {}
  }

  if (status?.hasCache) {
    icon.textContent = '⚡';
    text.textContent = `Script Memory: ${status.cachedCueCount} cues stored in local cache`;
    box.style.background = 'rgba(168, 85, 247, 0.14)';
    box.style.borderColor = 'rgba(168, 85, 247, 0.35)';
    text.style.color = '#c084fc';
  } else if (liveCount > 0) {
    icon.textContent = '🎙️';
    text.textContent = `Live Subtitles: ${liveCount} cues captured`;
    box.style.background = 'rgba(56, 189, 248, 0.12)';
    box.style.borderColor = 'rgba(56, 189, 248, 0.3)';
    text.style.color = '#38bdf8';
  } else if (hasCaptions) {
    icon.textContent = '🎬';
    text.textContent = `Video CC: Ready (${trackNames || 'Available'})`;
    box.style.background = 'rgba(34, 197, 94, 0.12)';
    box.style.borderColor = 'rgba(34, 197, 94, 0.3)';
    text.style.color = '#4ade80';
  } else {
    icon.textContent = 'ℹ️';
    text.textContent = 'No CC on video • Use ▶ Start Audio Capture';
    box.style.background = 'rgba(234, 179, 8, 0.1)';
    box.style.borderColor = 'rgba(234, 179, 8, 0.25)';
    text.style.color = '#fde047';
  }
}

function formatSrtTimestamp(seconds) {
  const pad = (num, size = 2) => String(num).padStart(size, '0');
  const secNum = Math.max(0, Number(seconds) || 0);
  const hrs = Math.floor(secNum / 3600);
  const mins = Math.floor((secNum % 3600) / 60);
  const secs = Math.floor(secNum % 60);
  const millis = Math.floor((secNum % 1) * 1000);
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${pad(millis, 3)}`;
}

function parseTimedTextXml(xmlText) {
  if (!xmlText) return [];
  const cues = [];
  const textTagRegex = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let match;
  while ((match = textTagRegex.exec(xmlText)) !== null) {
    const attrs = match[1];
    const rawContent = match[2];
    const startMatch = attrs.match(/start="([\d\.]+)"/i);
    const durMatch = attrs.match(/dur="([\d\.]+)"/i);
    if (startMatch) {
      const start = parseFloat(startMatch[1]);
      const dur = durMatch ? parseFloat(durMatch[1]) : 2.0;
      const end = Number((start + Math.max(0.2, dur)).toFixed(3));
      const cleanText = rawContent
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/<[^>]+>/g, '')
        .trim();
      if (cleanText) {
        cues.push({ start, end, text: cleanText });
      }
    }
  }
  return cues;
}

function downloadSrtFile(cues, vidId = 'youtube') {
  let srtContent = '';
  cues.forEach((cue, index) => {
    const start = formatSrtTimestamp(cue.start || 0);
    const end = formatSrtTimestamp(cue.end || (cue.start + 2.0));
    const text = (cue.text || '').trim();
    const translation = (cue.translation && cue.translation.trim() !== text) ? `\n${cue.translation.trim()}` : '';
    if (text) {
      srtContent += `${index + 1}\n${start} --> ${end}\n${text}${translation}\n\n`;
    }
  });

  const blob = new Blob([srtContent], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const dlAnchor = document.createElement('a');
  dlAnchor.href = url;
  dlAnchor.download = `livesub_subtitles_${vidId}_${Date.now()}.srt`;
  document.body.appendChild(dlAnchor);
  dlAnchor.click();
  dlAnchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadJsonFile(data, vidId = 'youtube') {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const dlAnchor = document.createElement('a');
  dlAnchor.href = url;
  dlAnchor.download = `livesub_cuelog_${vidId}_${Date.now()}.json`;
  document.body.appendChild(dlAnchor);
  dlAnchor.click();
  dlAnchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function getSampleCues() {
  return [
    { start: 0.8, end: 3.5, text: "नमस्ते! यह लाइव उपशीर्षक और अनुवाद का एक डेमो पूर्वावलोकन है।", translation: "Hello! This is a demo preview of live subtitles and translation." },
    { start: 3.8, end: 7.0, text: "जब आप 'Start Audio Capture' पर क्लिक करते हैं, तो बोले गए सभी शब्द वास्तविक समय में अनुवादित होते हैं।", translation: "When you click 'Start Audio Capture', all spoken words are transcribed in real-time." },
    { start: 7.4, end: 11.2, text: "यह SRT फ़ाइल प्रारूप सभी प्रमुख वीडियो प्लेयरों और YouTube के साथ पूरी तरह से संगत है।", translation: "This SRT file format is fully compatible with all major video players and YouTube." }
  ];
}

async function handleExportCueLog() {
  activeTab = await getActiveTab();
  if (!activeTab || !activeTab.id) {
    alert('Please switch to an active YouTube video tab and click the extension icon again.');
    return;
  }

  const exportBtn = document.getElementById('btn-export-log');
  if (exportBtn) {
    exportBtn.disabled = true;
    exportBtn.innerHTML = '<span>⏳</span> Exporting...';
  }

  await ensureContentScriptInjected(activeTab.id);

  const targetLang = document.getElementById('select-target-lang')?.value || 'en';
  let cues = [];
  let vidId = 'youtube';

  // 1. Query content script
  try {
    const res = await new Promise((resolve) => {
      chrome.tabs.sendMessage(activeTab.id, {
        action: 'GET_CUE_LOG',
        type: 'GET_CUE_LOG',
        targetLanguage: targetLang
      }, (r) => {
        if (chrome.runtime.lastError || !r) resolve(null);
        else resolve(r);
      });
    });
    if (res && Array.isArray(res.cues) && res.cues.length > 0) {
      cues = res.cues;
      vidId = res.videoId || 'youtube';
    }
  } catch (_) {}

  // 2. Query main world if needed
  if (cues.length === 0) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        world: 'MAIN',
        func: () => {
          const p = document.querySelector('#movie_player');
          const pr = (p && typeof p.getPlayerResponse === 'function') ? p.getPlayerResponse() : window.ytInitialPlayerResponse;
          const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
          const videoId = pr?.videoDetails?.videoId || new URLSearchParams(window.location.search).get('v') || 'youtube';
          return { tracks, videoId };
        }
      });
      const mainData = results?.[0]?.result;
      if (mainData && Array.isArray(mainData.tracks) && mainData.tracks.length > 0) {
        vidId = mainData.videoId || vidId;
        const chosen = mainData.tracks[0];
        if (chosen && chosen.baseUrl) {
          const resp = await fetch(chosen.baseUrl);
          if (resp.ok) {
            const xml = await resp.text();
            cues = parseTimedTextXml(xml);
          }
        }
      }
    } catch (_) {}
  }

  if (exportBtn) {
    exportBtn.disabled = false;
    exportBtn.innerHTML = '<span>📥</span> Cue Log (JSON)';
  }

  if (cues.length > 0) {
    downloadJsonFile({
      videoId: vidId,
      createdAt: new Date().toISOString(),
      targetLanguage: targetLang,
      cues: cues
    }, vidId);
    if (exportBtn) {
      exportBtn.innerHTML = '<span>✅</span> Downloaded!';
      setTimeout(() => { exportBtn.innerHTML = '<span>📥</span> Cue Log (JSON)'; }, 2000);
    }
    return;
  }

  const shouldStart = confirm(
    "This YouTube video has no built-in closed captions.\n\n" +
    "To transcribe real-time subtitles from the video audio:\n" +
    "• Click [OK] to Start Audio Capture now\n" +
    "• Click [Cancel] to export sample JSON cue log"
  );

  if (shouldStart) {
    handleToggleCapture();
  } else {
    downloadJsonFile({
      videoId: vidId,
      createdAt: new Date().toISOString(),
      targetLanguage: targetLang,
      cues: getSampleCues()
    }, vidId);
  }
}

async function handleExportSrt() {
  activeTab = await getActiveTab();
  if (!activeTab || !activeTab.id) {
    alert('Please switch to an active YouTube video tab and click the extension icon again.');
    return;
  }

  const exportBtn = document.getElementById('btn-export-srt');
  if (exportBtn) {
    exportBtn.disabled = true;
    exportBtn.innerHTML = '<span>⏳</span> Exporting...';
  }

  await ensureContentScriptInjected(activeTab.id);

  const targetLang = document.getElementById('select-target-lang')?.value || 'en';
  const sourceLang = document.getElementById('select-source-lang')?.value || 'hi';

  let cues = [];
  let vidId = 'youtube';

  // 1. Try content script
  try {
    const res = await new Promise((resolve) => {
      chrome.tabs.sendMessage(activeTab.id, {
        action: 'GET_CUE_LOG',
        type: 'GET_CUE_LOG',
        targetLanguage: targetLang
      }, (r) => {
        if (chrome.runtime.lastError || !r) resolve(null);
        else resolve(r);
      });
    });
    if (res && Array.isArray(res.cues) && res.cues.length > 0) {
      cues = res.cues;
      vidId = res.videoId || 'youtube';
    }
  } catch (_) {}

  // 2. If no cues from content script, query main world for YouTube caption tracks
  if (cues.length === 0) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        world: 'MAIN',
        func: () => {
          const p = document.querySelector('#movie_player');
          const pr = (p && typeof p.getPlayerResponse === 'function') ? p.getPlayerResponse() : window.ytInitialPlayerResponse;
          const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
          const videoId = pr?.videoDetails?.videoId || new URLSearchParams(window.location.search).get('v') || 'youtube';
          return { tracks, videoId };
        }
      });

      const mainData = results?.[0]?.result;
      if (mainData && Array.isArray(mainData.tracks) && mainData.tracks.length > 0) {
        vidId = mainData.videoId || vidId;
        const tracks = mainData.tracks;
        let chosen = tracks.find(t => t.languageCode === sourceLang || (t.vssId && t.vssId.includes(sourceLang)));
        if (!chosen) chosen = tracks.find(t => t.languageCode === 'en' || (t.vssId && t.vssId.includes('en')));
        if (!chosen) chosen = tracks[0];

        if (chosen && chosen.baseUrl) {
          let url = chosen.baseUrl;
          if (targetLang && targetLang !== 'none' && targetLang !== 'auto' && targetLang !== chosen.languageCode) {
            url += `&tlang=${encodeURIComponent(targetLang)}`;
          }
          const resp = await fetch(url);
          if (resp.ok) {
            const xml = await resp.text();
            cues = parseTimedTextXml(xml);
          }
        }
      }
    } catch (e) {
      console.warn('[LiveSub Popup] Direct main-world caption check:', e);
    }
  }

  if (exportBtn) {
    exportBtn.disabled = false;
    exportBtn.innerHTML = '<span>📄</span> Subtitles (SRT)';
  }

  // 3. If subtitles or captions were found, export them!
  if (cues.length > 0) {
    downloadSrtFile(cues, vidId);
    if (exportBtn) {
      exportBtn.innerHTML = '<span>✅</span> Downloaded!';
      setTimeout(() => { exportBtn.innerHTML = '<span>📄</span> Subtitles (SRT)'; }, 2000);
    }
    return;
  }

  // 4. Video has no native YouTube captions and audio capture hasn't transcribed yet:
  const shouldStart = confirm(
    "This YouTube video has no built-in closed captions.\n\n" +
    "To transcribe real-time subtitles from the video audio:\n" +
    "• Click [OK] to Start Audio Capture now\n" +
    "• Click [Cancel] to export a sample demonstration SRT file"
  );

  if (shouldStart) {
    handleToggleCapture();
  } else {
    downloadSrtFile(getSampleCues(), vidId);
  }
}
