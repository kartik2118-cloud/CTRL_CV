/**
 * extension/content/caption_path.test.mjs
 * Unit and integration tests for the manual YouTube caption path.
 *
 * Verifies:
 * 1. Manual caption track detection (strictly ignoring kind='asr').
 * 2. XML and JSON timedtext parsing into cues { start, end, text }.
 * 3. Ingestion into SyncBridge with source = 'captions'.
 * 4. Video playback and seek-back cache hit (instant recovery without network call).
 * 5. Log export with source = 'captions' and verification against eval/validate_log.py.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import CtrlCVCaptions from './caption_path.js';
const {
  detectManualCaptionTracks,
  chooseManualCaptionTrack,
  parseCaptionXml,
  parseCaptionJson,
  parseCaptionText,
  feedCuesToSyncBridge
} = CtrlCVCaptions;

import { SyncBridge } from '../../sync/syncBridge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');

test('1. Caption Detection: detects manual tracks and strictly ignores kind=asr', () => {
  const fakePlayerResponse = {
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            baseUrl: 'https://www.youtube.com/api/timedtext?v=123&lang=en&kind=asr',
            name: { simpleText: 'English (auto-generated)' },
            vssId: 'a.en',
            languageCode: 'en',
            kind: 'asr'
          },
          {
            baseUrl: 'https://www.youtube.com/api/timedtext?v=123&lang=hi',
            name: { simpleText: 'Hindi (Manual)' },
            vssId: '.hi',
            languageCode: 'hi'
            // kind is omitted for standard manual tracks
          },
          {
            baseUrl: 'https://www.youtube.com/api/timedtext?v=123&lang=en',
            name: { runs: [{ text: 'English (Official)' }] },
            vssId: '.en',
            languageCode: 'en',
            kind: 'standard'
          }
        ]
      }
    }
  };

  const manualTracks = detectManualCaptionTracks(fakePlayerResponse);
  assert.equal(manualTracks.length, 2, 'Should only return the 2 manual tracks, ignoring kind=asr');
  assert.equal(manualTracks[0].languageCode, 'hi');
  assert.equal(manualTracks[0].name, 'Hindi (Manual)');
  assert.equal(manualTracks[1].languageCode, 'en');
  assert.equal(manualTracks[1].name, 'English (Official)');

  // Fallback case: only ASR track available -> should return empty array
  const asrOnlyResponse = {
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            baseUrl: 'https://www.youtube.com/api/timedtext?v=999&lang=en&kind=asr',
            name: { simpleText: 'English (auto-generated)' },
            vssId: 'a.en',
            languageCode: 'en',
            kind: 'asr'
          }
        ]
      }
    }
  };
  const fallbackTracks = detectManualCaptionTracks(asrOnlyResponse);
  assert.equal(fallbackTracks.length, 0, 'Must return empty list when only kind=asr exists');
});

test('2. Caption Parsing: parses XML timedtext and JSON3 into cues', () => {
  const fakeXml = `
    <transcript>
      <text start="1.500" dur="2.800">Hello &amp; welcome to the show!</text>
      <text start="5.100" dur="3.400">Don&#39;t touch that dial.</text>
      <text start="10.000" dur="4.000">&lt;i&gt;Stay tuned for more.&lt;/i&gt;</text>
    </transcript>
  `.trim();

  const cuesXml = parseCaptionXml(fakeXml);
  assert.equal(cuesXml.length, 3);
  assert.equal(cuesXml[0].start, 1.5);
  assert.equal(cuesXml[0].end, 4.3);
  assert.equal(cuesXml[0].text, 'Hello & welcome to the show!');
  assert.equal(cuesXml[1].text, "Don't touch that dial.");
  assert.equal(cuesXml[2].text, 'Stay tuned for more.');

  const fakeJson = {
    events: [
      {
        tStartMs: 1500,
        dDurationMs: 2800,
        segs: [{ utf8: 'Hello & welcome to the show!' }]
      },
      {
        tStartMs: 5100,
        dDurationMs: 3400,
        segs: [{ utf8: "Don't touch that dial." }]
      }
    ]
  };

  const cuesJson = parseCaptionJson(fakeJson);
  assert.equal(cuesJson.length, 2);
  assert.equal(cuesJson[0].start, 1.5);
  assert.equal(cuesJson[0].end, 4.3);
  assert.equal(cuesJson[0].text, 'Hello & welcome to the show!');
});

test('3. SyncBridge Integration: feeds cues with source=captions, seek-back hits cache instantly, exports valid log', async () => {
  // Simulated HTML5 video element
  let currentTime = 0.0;
  let playbackRate = 1.0;
  const listeners = {};

  const fakeVideo = {
    get currentTime() { return currentTime; },
    set currentTime(v) { currentTime = v; },
    get playbackRate() { return playbackRate; },
    set playbackRate(r) { playbackRate = r; },
    paused: false,
    addEventListener(event, fn) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(fn);
    },
    removeEventListener(event, fn) {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter(cb => cb !== fn);
      }
    },
    dispatchEvent(event) {
      if (listeners[event]) {
        for (const fn of listeners[event]) fn();
      }
    }
  };

  let renderedCues = [];
  const bridge = new SyncBridge({
    video: fakeVideo,
    tickMs: 20,
    minHold: 2.0,
    render: (cues) => {
      renderedCues = cues;
    }
  });

  try {
    const fakeCues = [
      { start: 1.0, end: 4.0, text: 'First manual caption line' },
      { start: 5.0, end: 8.0, text: 'Second manual caption line' },
      { start: 12.0, end: 15.0, text: 'Third manual caption line' }
    ];

    const ingestedCount = feedCuesToSyncBridge(fakeCues, bridge, { languageCode: 'en' });
    assert.equal(ingestedCount, 3, 'All 3 manual cues must be accepted into SyncBridge');

    // Step A: Play at t=2.5s (within cue 1)
    fakeVideo.currentTime = 2.5;
    bridge._tick();

    assert.equal(renderedCues.length, 1);
    assert.equal(renderedCues[0].text, 'First manual caption line');
    assert.equal(renderedCues[0].source, 'captions');

    // Step B: Advance past cue 1 to t=9.0s (between cue 2 and 3)
    fakeVideo.currentTime = 9.0;
    bridge._tick();
    assert.equal(renderedCues.length, 0, 'No cue should be active at t=9.0s');

    // Step C: Seek-back to t=2.0s -> cached cue shows up INSTANTLY with 0s recovery
    fakeVideo.currentTime = 2.0;
    fakeVideo.dispatchEvent('seeking');
    bridge._tick();

    assert.equal(renderedCues.length, 1, 'Seek-back must immediately render cached cue');
    assert.equal(renderedCues[0].text, 'First manual caption line');
    assert.equal(renderedCues[0].source, 'captions');

    // Step D: Export cue log and verify strictly against docs/cue_log.schema.json via eval/validate_log.py
    const exportedLog = bridge.exportLog();
    assert.ok(exportedLog.length > 0, 'Exported log must have displayed cues');

    for (const entry of exportedLog) {
      assert.equal(entry.source, 'captions', 'Source field must strictly be "captions"');
      assert.ok(typeof entry.first_shown_at === 'number', 'first_shown_at must be populated');
      assert.ok(Array.isArray(entry.revisions), 'revisions must be an array');
      assert.ok(entry.start < entry.end, 'start must be strictly less than end');
    }

    // Write exported log to file and run python eval/validate_log.py
    const outDir = path.resolve(REPO_ROOT, 'eval/results');
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    const testLogPath = path.resolve(outDir, 'cue_log_caption_path_test.json');
    fs.writeFileSync(testLogPath, JSON.stringify(exportedLog, null, 2), 'utf-8');

    const pyScript = path.resolve(REPO_ROOT, 'eval/validate_log.py');
    const candidates = [
      path.resolve(REPO_ROOT, 'eval/venv/Scripts/python.exe'),
      'D:/CTRLCV@2/eval/venv/Scripts/python.exe',
      'C:/Users/Anuj/AppData/Local/Python/bin/python.exe'
    ];
    let pyExe = 'python';
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        pyExe = `"${c}"`;
        break;
      }
    }

    const pythonCmd = `${pyExe} "${pyScript}" "${testLogPath}"`;
    const validateOutput = execSync(pythonCmd, { cwd: REPO_ROOT, encoding: 'utf-8' });

    assert.match(validateOutput, /PASS:/, 'eval/validate_log.py must PASS for caption path log');
  } finally {
    bridge.destroy();
  }
});
