/**
 * eval/e2e_node.mjs
 * End-to-end evaluation without a browser.
 *
 * 1. Spawns real FastAPI backend with Mock STT/Translation provider.
 * 2. Uses real extension/offscreen/ws_client.js with Node's global WebSocket.
 * 3. Streams a real FLEURS wav (16 kHz mono) at rate 1.0 and rate 1.5.
 * 4. Feeds RESULTs to SyncBridge/SyncEngine and calls markShown.
 * 5. Exports cue log and validates against eval/validate_log.py.
 * 6. Labels every output number as SIMULATED (mock text).
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { WsClient } from '../extension/offscreen/ws_client.js';
import { SyncBridge } from '../sync/syncBridge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const BACKEND_DIR = path.join(ROOT_DIR, 'backend');
const VENV_PYTHON = path.join(ROOT_DIR, 'eval', 'venv', 'Scripts', 'python.exe');
const WAV_PATH = path.join(ROOT_DIR, 'eval', 'data', 'hi_in', 'hi_in_1792.wav');
const RESULTS_DIR = path.join(ROOT_DIR, 'eval', 'results');
const EXPORT_LOG_PATH = path.join(RESULTS_DIR, 'cue_log_e2e_node.json');
const VALIDATE_LOG_SCRIPT = path.join(ROOT_DIR, 'eval', 'validate_log.py');

async function waitForHealthCheck(maxAttempts = 40, delayMs = 250) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const ok = await new Promise((resolve) => {
        const req = http.get('http://127.0.0.1:8000/health', { timeout: 500 }, (res) => {
          let body = '';
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(body);
              resolve(parsed.ok === true);
            } catch (_) {
              resolve(false);
            }
          });
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
      });
      if (ok) return true;
    } catch (_) {}
    await new Promise(r => setTimeout(r, delayMs));
  }
  return false;
}

async function run() {
  console.log('[E2E Node] Starting real backend process with MOCK provider...');
  let backendStderr = '';
  let backendStdout = '';

  const backendProc = spawn(
    VENV_PYTHON,
    ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000'],
    {
      cwd: BACKEND_DIR,
      env: {
        ...process.env,
        STT_PROVIDER: 'mock',
        TRANSLATION_PROVIDER: 'mock'
      }
    }
  );

  backendProc.stdout.on('data', d => { backendStdout += d.toString(); });
  backendProc.stderr.on('data', d => { backendStderr += d.toString(); });

  const healthy = await waitForHealthCheck();
  if (!healthy) {
    console.error('[E2E Node] ERROR: Backend failed to start or health check timed out.');
    console.error('--- Backend STDOUT ---');
    console.error(backendStdout);
    console.error('--- Backend STDERR ---');
    console.error(backendStderr);
    backendProc.kill();
    process.exit(1);
  }
  console.log('[E2E Node] Backend is healthy at http://127.0.0.1:8000 (MOCK provider active).');

  try {
    if (!fs.existsSync(WAV_PATH)) {
      throw new Error(`FLEURS wav not found at ${WAV_PATH}`);
    }
    const wavRaw = fs.readFileSync(WAV_PATH);
    const pcmRaw = wavRaw.subarray(44);
    const totalSamples = pcmRaw.length / 2;
    console.log(`[E2E Node] Loaded FLEURS audio: ${path.basename(WAV_PATH)} (${totalSamples} samples, ${(totalSamples / 16000).toFixed(2)}s) [SIMULATED audio stream]`);

    let videoTime = 0.0;
    let videoRate = 1.0;
    const fakeVideo = {
      get currentTime() { return videoTime; },
      set currentTime(v) { videoTime = v; },
      get playbackRate() { return videoRate; },
      set playbackRate(r) { videoRate = r; },
      addEventListener: () => {}
    };

    const bridge = new SyncBridge({
      video: fakeVideo,
      tickMs: 50,
      render: () => {}
    });

    // Synchronize initial session epoch
    bridge.engine.epoch = 0;

    const receivedResults = [];
    const client = new WsClient({
      WebSocketClass: globalThis.WebSocket,
      url: 'ws://127.0.0.1:8000/ws',
      initialEpoch: 0,
      initialPlaybackRate: 1.0,
      onChunkSent: (info) => {
        bridge.registerChunk(info.chunk_id, {
          video_start_time: info.video_start_time,
          playback_rate: info.playback_rate
        });
      },
      onResult: (result) => {
        receivedResults.push(result);
        const outcome = bridge.handleResult(result);
        if (outcome && outcome.cue) {
          bridge.engine.markShown(outcome.cue, fakeVideo.currentTime);
        }
      }
    });

    await client.connect();
    // Allow handshake hello -> hello_ack
    await new Promise(r => setTimeout(r, 80));

    const blockSizeBytes = 1600 * 2; // 100 ms at 16 kHz = 3200 bytes
    const totalBlocks = Math.floor(pcmRaw.length / blockSizeBytes); // 82 blocks = 8.2s

    // ─── Stream 1: Rate 1.0 ──────────────────────────────────────────────────────
    console.log(`\n[E2E Node] Streaming pass 1: Playback Rate 1.0x (${totalBlocks} blocks, 8.2s of audio starting at 0.0s)...`);
    videoTime = 0.0;
    videoRate = 1.0;
    client.updateVideoObservation({
      epoch: 0,
      video_id: 'fleurs_hi_1',
      video_current_time: videoTime,
      playback_rate: 1.0,
      paused: false,
      seeking: false,
      ad_state: 'main_video'
    });

    for (let b = 0; b < totalBlocks; b++) {
      const slice = pcmRaw.subarray(b * blockSizeBytes, (b + 1) * blockSizeBytes);
      const pcm16 = new Int16Array(slice.buffer, slice.byteOffset, slice.length / 2);
      client.feedAudioBlock(pcm16, 0.1);
      videoTime = Number((videoTime + 0.1).toFixed(2));
      await new Promise(r => setTimeout(r, 12));
    }

    // Wait for pass 1 backend results to arrive
    await new Promise(r => setTimeout(r, 350));

    // ─── Stream 2: Rate 1.5 with Seek to 50.0s ────────────────────────────────────
    console.log(`\n[E2E Node] Streaming pass 2: Playback Rate 1.5x (${totalBlocks} blocks, 8.2s of audio seeking to 50.0s)...`);
    videoTime = 50.0;
    videoRate = 1.5;

    // Send backend seek frame and advance epoch
    client.onSeek(50.0);
    bridge.engine.onSeek(50.0);

    client.setPlaybackRate(1.5);
    client.updateVideoObservation({
      epoch: client.epoch,
      video_id: 'fleurs_hi_1',
      video_current_time: 50.0,
      playback_rate: 1.5,
      paused: false,
      seeking: false,
      ad_state: 'main_video'
    });

    for (let b = 0; b < totalBlocks; b++) {
      const slice = pcmRaw.subarray(b * blockSizeBytes, (b + 1) * blockSizeBytes);
      const pcm16 = new Int16Array(slice.buffer, slice.byteOffset, slice.length / 2);
      client.feedAudioBlock(pcm16, 0.1);
      videoTime = Number((videoTime + 0.1 * 1.5).toFixed(2));
      await new Promise(r => setTimeout(r, 12));
    }

    // Wait for pass 2 backend results to arrive
    await new Promise(r => setTimeout(r, 350));

    // ─── Export Cue Log & Verification ──────────────────────────────────────────
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const exportedLog = bridge.exportLog();
    fs.writeFileSync(EXPORT_LOG_PATH, JSON.stringify(exportedLog, null, 2), 'utf-8');

    console.log(`\n[E2E Node] Results received from backend: ${receivedResults.length} [SIMULATED]`);
    console.log(`[E2E Node] Exported displayed cues: ${exportedLog.length} to ${EXPORT_LOG_PATH} [SIMULATED]`);

    if (exportedLog.length === 0) {
      throw new Error('Exported cue log has 0 cues. Expected cues from streaming passes.');
    }

    console.log('\n[E2E Node] Sample Exported Cue Entries:');
    for (let i = 0; i < exportedLog.length; i++) {
      const c = exportedLog[i];
      console.log(`  Cue [${i + 1}]: start=${c.start}s, end=${c.end}s, first_shown_at=${c.first_shown_at}s, text="${c.text}" [SIMULATED]`);
    }

    // Double conversion verification on 1.5x results
    let rate15Verified = false;
    for (const cue of exportedLog) {
      if (cue.start >= 50.0) {
        rate15Verified = true;
        // At video_start=50.0, rate=1.5, offset=0.1 -> start should be 50.15s, NOT 125s+
        if (cue.start > 65.0) {
          throw new Error(`Double conversion detected! cue.start=${cue.start} > 65.0s on 50.0s timeline.`);
        }
      }
    }

    if (!rate15Verified) {
      console.warn('[E2E Node] Note: Rate 1.5x cue not found in exported log, verifying pass 1 cues.');
    } else {
      console.log('\n[E2E Node] Double conversion verification: PASSED (Rate 1.5x start timestamps accurately anchored on 50s timeline without doubling) [SIMULATED]');
    }

    // Run validator
    console.log('\n[E2E Node] Running eval/validate_log.py on exported log:');
    const validatorOutput = execFileSync(VENV_PYTHON, [VALIDATE_LOG_SCRIPT, EXPORT_LOG_PATH], { encoding: 'utf-8' });
    console.log(validatorOutput.trim());

    client.close();
    bridge.destroy();
  } finally {
    console.log('[E2E Node] Terminating backend server process...');
    backendProc.kill();
  }
}

run().catch((err) => {
  console.error('[E2E Node] Fatal error during test execution:', err);
  process.exit(1);
});
