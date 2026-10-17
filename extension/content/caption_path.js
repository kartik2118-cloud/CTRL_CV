/**
 * extension/content/caption_path.js
 * LiveSub Manual YouTube Caption Track Extraction and Synchronization.
 *
 * Responsibilities:
 * 1. Detect manual caption tracks from YouTube player data (captionTracks in player response).
 *    Strictly ignores auto-generated tracks (kind === 'asr' or vssId starting with 'a.').
 * 2. Parses manual caption tracks (XML timedtext or JSON3) into timed cues { start, end, text }.
 * 3. Feeds cues to SyncBridge with source: "captions", preserving video time coverage,
 *    playback rate, seek cache hits, ad isolation, and navigation archiving.
 * 4. Stops tab audio capture and WebSocket when manual tracks are active, broadcasting status "Captions".
 */

'use strict';

(function(root) {

  /**
   * Decodes XML / HTML entities into plaintext.
   * @param {string} str
   * @returns {string}
   */
  function decodeHtmlEntities(str) {
    if (!str || typeof str !== 'string') return '';
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#039;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
  }

  /**
   * Normalizes raw caption track objects into standard shape.
   * @param {Array<Object>} rawTracks
   * @param {boolean} [includeAsr=true]
   * @returns {Array<Object>}
   */
  function normalizeCaptionTracks(rawTracks, includeAsr = true) {
    if (!Array.isArray(rawTracks)) return [];
    const tracks = [];
    for (const t of rawTracks) {
      if (!t || typeof t !== 'object') continue;
      const rawKind = (t.kind || '').toLowerCase();
      const vssId = (t.vssId || '').toLowerCase();
      const isAsr = rawKind === 'asr' || vssId.startsWith('a.');

      if (isAsr && !includeAsr) {
        continue;
      }

      const languageCode = (t.languageCode || t.vssId?.replace(/^\.?a?\./, '') || 'en').toLowerCase();
      const name = t.name?.simpleText || t.name?.runs?.[0]?.text || languageCode;
      const kind = isAsr ? 'asr' : (t.kind || 'manual');
      const baseUrl = t.baseUrl || '';

      tracks.push({
        languageCode,
        name,
        kind,
        isAsr,
        baseUrl
      });
    }
    return tracks;
  }

  /**
   * Detects all caption tracks (both manual and auto-generated ASR) from YouTube player data.
   * Inspects:
   * 1. Direct playerResponse argument if passed
   * 2. Main world DOM script tags using regex (works in isolated content script world!)
   * 3. DOM movie_player getPlayerResponse() if accessible
   * 4. window.ytInitialPlayerResponse if accessible
   * 
   * @param {Object} [playerResponse] YouTube player response object
   * @param {Object} [options]
   * @param {boolean} [options.includeAsr=true] Whether to include auto-generated (ASR) tracks
   * @returns {Array<{ languageCode: string, name: string, kind: string, isAsr: boolean, baseUrl?: string }>} List of tracks
   */
  function detectCaptionTracks(playerResponse = null, { includeAsr = true } = {}) {
    let pr = playerResponse;

    if (!pr && typeof document !== 'undefined') {
      try {
        const player = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
        if (player && typeof player.getPlayerResponse === 'function') {
          pr = player.getPlayerResponse();
        }
      } catch (_) {}

      if (!pr && typeof window !== 'undefined' && window.ytInitialPlayerResponse) {
        pr = window.ytInitialPlayerResponse;
      }

      if (!pr && typeof document.querySelector === 'function') {
        const watchFlexy = document.querySelector('ytd-watch-flexy');
        if (watchFlexy && watchFlexy.playerData) {
          pr = watchFlexy.playerData;
        }
      }

      // Check DOM script tags (works reliably in Isolated World without CSP or TrustedTypes issues)
      if (!pr || !pr.captions) {
        try {
          const scripts = document.querySelectorAll('script');
          const regex = /"captionTracks":\s*(\[\s*\{.+?\}\s*\])/;
          for (let i = 0; i < scripts.length; i++) {
            const text = scripts[i].textContent || '';
            const match = text.match(regex);
            if (match && match[1]) {
              try {
                const parsed = JSON.parse(match[1]);
                if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].baseUrl) {
                  return normalizeCaptionTracks(parsed, includeAsr);
                }
              } catch (_) {}
            }
          }
        } catch (_) {}
      }
    }

    if (!pr || typeof pr !== 'object') {
      return [];
    }

    const captionTracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    return normalizeCaptionTracks(captionTracks, includeAsr);
  }

  /**
   * Detects manual caption tracks from YouTube player data.
   * Strictly filters out any auto-generated tracks (kind === 'asr' or vssId starting with 'a.').
   * 
   * @param {Object} [playerResponse] YouTube player response object (optional; queries DOM if omitted)
   * @returns {Array<{ languageCode: string, name: string, kind: string, baseUrl?: string }>} List of manual tracks
   */
  function detectManualCaptionTracks(playerResponse = null) {
    return detectCaptionTracks(playerResponse, { includeAsr: false });
  }

  /**
   * Selects the best matching manual caption track based on language preference.
   * 
   * @param {Array<Object>} manualTracks
   * @param {string} [preferredLang='auto']
   * @returns {Object|null}
   */
  function chooseManualCaptionTrack(manualTracks, preferredLang = 'auto') {
    if (!Array.isArray(manualTracks) || manualTracks.length === 0) {
      return null;
    }

    const normPref = (preferredLang || 'auto').toLowerCase().trim();

    if (normPref && normPref !== 'auto' && normPref !== 'none') {
      const match = manualTracks.find(t => t.languageCode === normPref || t.languageCode.startsWith(normPref));
      if (match) return match;
    }

    // Default preference order if 'auto': English, Hindi, Marathi, then first available
    const priority = ['en', 'hi', 'mr'];
    for (const p of priority) {
      const match = manualTracks.find(t => t.languageCode === p || t.languageCode.startsWith(p));
      if (match) return match;
    }

    return manualTracks[0];
  }

  /**
   * Selects the best caption track (prioritizing manual tracks, then auto-generated ASR tracks).
   * 
   * @param {Array<Object>} tracks
   * @param {string} [preferredLang='auto']
   * @returns {Object|null}
   */
  function chooseCaptionTrack(tracks, preferredLang = 'auto') {
    if (!Array.isArray(tracks) || tracks.length === 0) {
      return null;
    }

    const manualTracks = tracks.filter(t => !t.isAsr);
    const asrTracks = tracks.filter(t => t.isAsr);

    const normPref = (preferredLang || 'auto').toLowerCase().trim();

    if (normPref && normPref !== 'auto' && normPref !== 'none') {
      // 1. Manual match
      const manualMatch = manualTracks.find(t => t.languageCode === normPref || t.languageCode.startsWith(normPref));
      if (manualMatch) return manualMatch;
      // 2. ASR match
      const asrMatch = asrTracks.find(t => t.languageCode === normPref || t.languageCode.startsWith(normPref));
      if (asrMatch) return asrMatch;
    }

    // Default priority: manual priority -> asr priority -> first manual -> first asr
    const priority = ['hi', 'en', 'mr', 'ta', 'te'];
    for (const p of priority) {
      const m = manualTracks.find(t => t.languageCode === p || t.languageCode.startsWith(p));
      if (m) return m;
    }
    for (const p of priority) {
      const a = asrTracks.find(t => t.languageCode === p || t.languageCode.startsWith(p));
      if (a) return a;
    }

    return manualTracks[0] || asrTracks[0] || tracks[0];
  }

  /**
   * Parses XML timedtext into an array of cues.
   * Handles both <text start="X" dur="Y"> and <p t="ms" d="ms"> formats.
   * 
   * @param {string} xmlText
   * @returns {Array<{ start: number, end: number, text: string }>}
   */
  function parseCaptionXml(xmlText) {
    if (!xmlText || typeof xmlText !== 'string') return [];
    const cues = [];

    // Format 1: <text start="1.54" dur="2.45">Hello world</text>
    const textTagRegex = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    let match;
    while ((match = textTagRegex.exec(xmlText)) !== null) {
      const attrs = match[1];
      const rawContent = match[2];
      const startMatch = attrs.match(/start="([\d\.]+)"/i);
      const durMatch = attrs.match(/dur="([\d\.]+)"/i);
      if (startMatch) {
        const start = Number(parseFloat(startMatch[1]).toFixed(3));
        const dur = durMatch ? parseFloat(durMatch[1]) : 2.0;
        const end = Number((start + Math.max(0.1, dur)).toFixed(3));
        const cleanText = decodeHtmlEntities(rawContent).replace(/<[^>]+>/g, '').trim();
        if (cleanText) {
          cues.push({ start, end, text: cleanText });
        }
      }
    }

    // Format 2: <p t="1540" d="2450">Hello world</p>
    if (cues.length === 0) {
      const pTagRegex = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
      while ((match = pTagRegex.exec(xmlText)) !== null) {
        const attrs = match[1];
        const rawContent = match[2];
        const tMatch = attrs.match(/\bt="(\d+)"/i);
        const dMatch = attrs.match(/\bd="(\d+)"/i);
        if (tMatch) {
          const start = Number((parseInt(tMatch[1], 10) / 1000).toFixed(3));
          const dur = dMatch ? (parseInt(dMatch[1], 10) / 1000) : 2.0;
          const end = Number((start + Math.max(0.1, dur)).toFixed(3));
          const cleanText = decodeHtmlEntities(rawContent).replace(/<[^>]+>/g, '').trim();
          if (cleanText) {
            cues.push({ start, end, text: cleanText });
          }
        }
      }
    }

    return cues;
  }

  /**
   * Parses YouTube JSON3 timedtext format into cues.
   * @param {Object|string} jsonObjOrText
   * @returns {Array<{ start: number, end: number, text: string }>}
   */
  function parseCaptionJson(jsonObjOrText) {
    let data = jsonObjOrText;
    if (typeof jsonObjOrText === 'string') {
      try {
        data = JSON.parse(jsonObjOrText);
      } catch (_) {
        return [];
      }
    }

    if (!data || !Array.isArray(data.events)) {
      return [];
    }

    const cues = [];
    for (const ev of data.events) {
      if (typeof ev.tStartMs !== 'number') continue;
      const start = Number((ev.tStartMs / 1000).toFixed(3));
      const dur = typeof ev.dDurationMs === 'number' ? (ev.dDurationMs / 1000) : 2.0;
      const end = Number((start + Math.max(0.1, dur)).toFixed(3));

      let text = '';
      if (Array.isArray(ev.segs)) {
        text = ev.segs.map(s => s.utf8 || '').join('');
      }
      text = text.replace(/[\r\n]+/g, ' ').trim();
      if (text) {
        cues.push({ start, end, text });
      }
    }

    return cues;
  }

  /**
   * Universal caption text parser: auto-detects XML vs JSON format.
   * @param {string} rawText
   * @returns {Array<{ start: number, end: number, text: string }>}
   */
  function parseCaptionText(rawText) {
    if (!rawText || typeof rawText !== 'string') return [];
    const trimmed = rawText.trim();
    if (trimmed.startsWith('{')) {
      return parseCaptionJson(trimmed);
    }
    return parseCaptionXml(trimmed);
  }

  /**
   * Feeds parsed caption cues into SyncBridge with source: "captions".
   * 
   * @param {Array<{ start: number, end: number, text: string, translation?: string }>} cues
   * @param {Object} bridge SyncBridge instance
   * @param {Object} [trackInfo={}]
   * @returns {number} Count of accepted cues
   */
  function feedCuesToSyncBridge(cues, bridge, trackInfo = {}) {
    if (!bridge || typeof bridge.handleResult !== 'function') {
      throw new Error('Valid SyncBridge instance required.');
    }
    if (!Array.isArray(cues) || cues.length === 0) {
      return 0;
    }

    const lang = trackInfo.languageCode || 'en';
    const epoch = typeof bridge.getEpoch === 'function' ? bridge.getEpoch() : (bridge.engine?.epoch || 1);
    let accepted = 0;

    cues.forEach((c, idx) => {
      const cueId = `caption_${idx + 1}`;
      const outcome = bridge.handleResult({
        type: 'result',
        chunk_id: cueId,
        epoch: epoch,
        start: c.start,
        end: c.end,
        start_offset: c.start,
        end_offset: c.end,
        video_start_time: 0.0,
        playback_rate: 1.0,
        is_final: true,
        lang: lang,
        langs: [lang],
        text: c.text,
        translation: c.translation || '',
        source: 'captions'
      }, {
        video_start_time: 0.0,
        playback_rate: 1.0
      });

      if (outcome && outcome.status === 'accepted') {
        accepted++;
      }
    });

    return accepted;
  }

  /**
   * Full caption path lifecycle coordinator.
   * 1. Inspects player for YouTube caption tracks (manual prioritized, then ASR).
   * 2. If present: stops audio capture & WebSocket, updates popup status to "Captions".
   * 3. Fetches track text (with &tlang for target language translation if requested).
   * 4. Parses into cues and registers them in SyncBridge.
   * 
   * @param {Object} options
  /**
   * Helper to resolve current YouTube videoId from page or video element.
   * @param {HTMLMediaElement} [video]
   * @returns {string}
   */
  function getVideoId(video = null) {
    if (typeof window !== 'undefined') {
      try {
        const urlParams = new URLSearchParams(window.location.search);
        const v = urlParams.get('v');
        if (v) return v;
        const shortMatch = window.location.pathname.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
        if (shortMatch && shortMatch[1]) return shortMatch[1];
      } catch (_) {}
      try {
        const player = document.querySelector('#movie_player');
        if (player && typeof player.getVideoData === 'function') {
          const vd = player.getVideoData();
          if (vd && vd.video_id) return vd.video_id;
        }
      } catch (_) {}
    }
    return 'default_video';
  }

  /**
   * Generates a unique key for the video script cache in extension storage.
   * @param {string} videoId
   * @param {string} [targetLang='']
   * @returns {string}
   */
  function getScriptCacheKey(videoId, targetLang = '') {
    const langKey = (targetLang && targetLang !== 'none' && targetLang !== 'auto') ? targetLang.toLowerCase() : 'orig';
    return `livesub_script_cache_${videoId}_${langKey}`;
  }

  /**
   * Retrieves video script cues from local extension cache memory.
   * @param {string} videoId
   * @param {string} [targetLang='']
   * @returns {Promise<Object|null>}
   */
  async function getScriptFromCache(videoId, targetLang = '') {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return null;
    const key = getScriptCacheKey(videoId, targetLang);
    return new Promise(resolve => {
      chrome.storage.local.get([key], result => {
        if (chrome.runtime?.lastError || !result || !result[key]) {
          resolve(null);
        } else {
          resolve(result[key]);
        }
      });
    });
  }

  /**
   * Stores downloaded & parsed script cues into local extension cache memory.
   * @param {string} videoId
   * @param {string} targetLang
   * @param {Object} data
   * @returns {Promise<boolean>}
   */
  async function saveScriptToCache(videoId, targetLang = '', data) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return false;
    const key = getScriptCacheKey(videoId, targetLang);
    return new Promise(resolve => {
      chrome.storage.local.set({ [key]: data }, () => {
        if (chrome.runtime?.lastError) {
          resolve(false);
        } else {
          chrome.storage.local.get(['livesub_script_index'], (idxRes) => {
            const index = idxRes?.livesub_script_index || {};
            index[key] = {
              videoId,
              targetLang: targetLang || 'orig',
              cueCount: data.cues?.length || 0,
              cachedAt: data.cachedAt || Date.now()
            };
            chrome.storage.local.set({ livesub_script_index: index }, () => resolve(true));
          });
        }
      });
    });
  }

  /**
   * Clears the script cache for a specific video or all videos.
   * @param {string} [videoId] If omitted, clears all cached video scripts
   * @returns {Promise<void>}
   */
  async function clearScriptCache(videoId = null) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    return new Promise(resolve => {
      chrome.storage.local.get(null, all => {
        if (!all) return resolve();
        const keysToRemove = [];
        for (const k of Object.keys(all)) {
          if (k.startsWith('livesub_script_cache_')) {
            if (!videoId || k.includes(`_${videoId}_`)) {
              keysToRemove.push(k);
            }
          }
        }
        if (keysToRemove.length > 0) {
          chrome.storage.local.remove(keysToRemove, resolve);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Full caption path lifecycle coordinator with Extension Cache Memory.
   * 1. Inspects Extension Cache Memory for pre-downloaded & translated script.
   * 2. If present, immediately feeds cues to SyncBridge without any network calls.
   * 3. If absent, detects YouTube caption tracks (manual prioritized, then ASR).
   * 4. Downloads track text (with &tlang for target language translation if requested).
   * 5. Saves parsed script to Extension Cache Memory and feeds cues to SyncBridge.
   * 
   * @param {Object} options
   * @param {Object} options.bridge Active SyncBridge instance
   * @param {HTMLMediaElement} [options.video] HTML5 video element
   * @param {Function} [options.onStatus] Status callback
   * @param {string} [options.preferredLang='auto']
   * @param {string} [options.targetLang='none']
   * @param {boolean} [options.forceRefresh=false]
   * @returns {Promise<{ active: boolean, track?: Object, count?: number, reason?: string, translated?: boolean, fromCache?: boolean }>}
   */
  async function initCaptionPath({ bridge, video = null, onStatus = null, preferredLang = 'auto', targetLang = 'none', forceRefresh = false } = {}) {
    if (!bridge) {
      return { active: false, reason: 'no_bridge' };
    }

    // Read stored language preference if not supplied
    if ((preferredLang === 'auto' || targetLang === 'none') && typeof chrome !== 'undefined' && chrome.storage?.local) {
      try {
        const stored = await new Promise(r => chrome.storage.local.get(['source_lang', 'target_lang'], r));
        if (preferredLang === 'auto' && stored?.source_lang) preferredLang = stored.source_lang;
        if (targetLang === 'none' && stored?.target_lang) targetLang = stored.target_lang;
      } catch (_) {}
    }

    const currentVid = getVideoId(video);

    // 1. Check Extension Cache Memory first (zero network latency, continuous playback)
    if (!forceRefresh && currentVid && currentVid !== 'default_video') {
      try {
        const cached = await getScriptFromCache(currentVid, targetLang);
        if (cached && Array.isArray(cached.cues) && cached.cues.length > 0) {
          console.log(`[CtrlCV Captions] Loaded script from Extension Cache Memory for video ${currentVid} (${cached.cues.length} cues, lang: ${cached.languageCode}).`);

          // STOP audio capture & WS when using cached script
          try {
            if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
              chrome.runtime.sendMessage({ action: 'STOP_CAPTURE' }).catch(() => {});
              chrome.runtime.sendMessage({
                type: 'STATUS',
                status: 'Captions',
                message: `Cached script active (${cached.languageCode}, ${cached.cues.length} cues)`,
                capture_state: 'idle',
                ws_state: 'captions',
                source: 'captions'
              }).catch(() => {});
            }
          } catch (_) {}

          if (typeof onStatus === 'function') {
            onStatus('Captions', `Cached script active (${cached.languageCode})`);
          }

          const count = feedCuesToSyncBridge(cached.cues, bridge, {
            languageCode: cached.languageCode || targetLang || 'en',
            name: cached.name || 'Extension Cache',
            kind: 'cached'
          });

          return {
            active: true,
            fromCache: true,
            track: {
              languageCode: cached.languageCode || targetLang || 'en',
              name: 'Extension Cache',
              kind: 'cached'
            },
            count,
            translated: Boolean(cached.translated)
          };
        }
      } catch (cacheErr) {
        console.warn('[CtrlCV Captions] Cache memory read error:', cacheErr);
      }
    }

    // 2. Cache miss -> Detect all available tracks (manual + ASR)
    const allTracks = detectCaptionTracks(null, { includeAsr: true });
    if (!allTracks || allTracks.length === 0) {
      return { active: false, reason: 'no_tracks' };
    }

    const chosenTrack = chooseCaptionTrack(allTracks, preferredLang);
    if (!chosenTrack || !chosenTrack.baseUrl) {
      return { active: false, reason: 'no_track_url' };
    }

    console.log(`[CtrlCV Captions] Found YouTube caption track: ${chosenTrack.name} (${chosenTrack.languageCode}, kind=${chosenTrack.kind}). Downloading script...`);

    // STOP audio capture & WS when using YouTube captions
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ action: 'STOP_CAPTURE' }).catch(() => {});
        chrome.runtime.sendMessage({
          type: 'STATUS',
          status: 'Captions',
          message: `YouTube captions active (${chosenTrack.languageCode}${targetLang && targetLang !== 'none' ? ' -> ' + targetLang : ''})`,
          capture_state: 'idle',
          ws_state: 'captions',
          source: 'captions'
        }).catch(() => {});
      }
    } catch (_) {}

    if (typeof onStatus === 'function') {
      onStatus('Captions', `YouTube captions active (${chosenTrack.languageCode})`);
    }

    // 3. Fetch with multilingual translation if targetLang differs
    let rawText = '';
    let isTranslated = false;
    const shouldTranslate = targetLang && targetLang !== 'none' && targetLang !== 'auto' && targetLang.toLowerCase() !== chosenTrack.languageCode.toLowerCase();

    if (shouldTranslate) {
      const transUrl = `${chosenTrack.baseUrl}&tlang=${encodeURIComponent(targetLang)}`;
      try {
        const resp = await fetch(transUrl);
        if (resp.ok) {
          const tText = await resp.text();
          if (tText && (tText.includes('<text') || tText.includes('"events"'))) {
            rawText = tText;
            isTranslated = true;
          }
        }
      } catch (_) {}
    }

    // Fall back to original baseUrl if translation not requested or failed
    if (!rawText) {
      try {
        const resp = await fetch(chosenTrack.baseUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        rawText = await resp.text();
      } catch (fetchErr) {
        console.warn('[CtrlCV Captions] Failed to fetch caption track:', fetchErr);
        return { active: false, reason: 'fetch_failed', error: fetchErr.message };
      }
    }

    const cues = parseCaptionText(rawText);
    if (cues.length === 0) {
      return { active: false, reason: 'empty_cues' };
    }

    // 4. Save downloaded & translated script to Extension Cache Memory
    const finalLang = isTranslated ? targetLang : chosenTrack.languageCode;
    if (currentVid && currentVid !== 'default_video') {
      saveScriptToCache(currentVid, targetLang, {
        videoId: currentVid,
        languageCode: finalLang,
        name: chosenTrack.name,
        kind: chosenTrack.kind,
        translated: isTranslated,
        cachedAt: Date.now(),
        cues: cues
      }).catch(err => console.warn('[CtrlCV Captions] Failed to save script to cache:', err));
    }

    // 5. Ingest cues into SyncBridge
    const trackForBridge = {
      ...chosenTrack,
      languageCode: finalLang
    };
    const count = feedCuesToSyncBridge(cues, bridge, trackForBridge);
    console.log(`[CtrlCV Captions] Ingested ${count} cues into SyncBridge (lang: ${trackForBridge.languageCode}). Saved to Extension Cache Memory.`);

    return {
      active: true,
      fromCache: false,
      track: trackForBridge,
      count,
      translated: isTranslated
    };
  }

  const exportObj = {
    decodeHtmlEntities,
    detectCaptionTracks,
    detectManualCaptionTracks,
    chooseCaptionTrack,
    chooseManualCaptionTrack,
    parseCaptionXml,
    parseCaptionJson,
    parseCaptionText,
    feedCuesToSyncBridge,
    initCaptionPath,
    getVideoId,
    getScriptCacheKey,
    getScriptFromCache,
    saveScriptToCache,
    clearScriptCache
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exportObj;
    module.exports.detectCaptionTracks = detectCaptionTracks;
    module.exports.detectManualCaptionTracks = detectManualCaptionTracks;
    module.exports.chooseCaptionTrack = chooseCaptionTrack;
    module.exports.chooseManualCaptionTrack = chooseManualCaptionTrack;
    module.exports.parseCaptionXml = parseCaptionXml;
    module.exports.parseCaptionJson = parseCaptionJson;
    module.exports.parseCaptionText = parseCaptionText;
    module.exports.feedCuesToSyncBridge = feedCuesToSyncBridge;
    module.exports.initCaptionPath = initCaptionPath;
    module.exports.getVideoId = getVideoId;
    module.exports.getScriptCacheKey = getScriptCacheKey;
    module.exports.getScriptFromCache = getScriptFromCache;
    module.exports.saveScriptToCache = saveScriptToCache;
    module.exports.clearScriptCache = clearScriptCache;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.CtrlCVCaptions = exportObj;
  }

})(typeof globalThis !== 'undefined' ? globalThis : this);

