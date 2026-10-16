#!/usr/bin/env node
/**
 * eval/replay_through_engine.mjs: Replay recorded STT results through SyncEngine
 * and evaluate seek recovery & subtitle sync against score_sync.py.
 * 
 * Flow:
 * 1. Reads raw results / cue log and sidecar seeks JSON.
 * 2. Feeds results to SyncEngine.onResult(result, ctx).
 * 3. Triggers engine.onSeek(seek_to) at seek events.
 * 4. On each video playback tick, queries getVisibleCues(videoTime) and marks
 *    visible cues using engine.markShown(cue, videoTime).
 * 5. Exports schema-valid cue log using engine.exportLog() -> eval/results/cue_log_engine.json.
 * 6. Executes eval/score_sync.py on the exported log.
 * 
 * Flags:
 *   --input <path>     Path to input results (default: eval/results/cue_log.json)
 *   --seeks <path>     Path to seeks sidecar (default: eval/results/cue_log.seeks.json)
 *   --out <path>       Output path for exported log (default: eval/results/cue_log_engine.json)
 *   --ws_url <url>     Optional WebSocket URL for live backend (default: off)
 *   --with_cache       Simulates pre-seek caching (speech cached before seek)
 *   --tick_ms <ms>     Playback simulation tick step in ms (default: 50)
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SyncEngine } from "../sync/syncEngine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const EVAL_RESULTS_DIR = path.join(ROOT_DIR, "eval", "results");

function getPythonCommand() {
  const venvPythonWin = path.join(ROOT_DIR, "eval", "venv", "Scripts", "python.exe");
  const venvPythonUnix = path.join(ROOT_DIR, "eval", "venv", "bin", "python");
  if (fs.existsSync(venvPythonWin)) return venvPythonWin;
  if (fs.existsSync(venvPythonUnix)) return venvPythonUnix;
  return process.platform === "win32" ? "python" : "python3";
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    input: path.join(EVAL_RESULTS_DIR, "cue_log.json"),
    seeks: path.join(EVAL_RESULTS_DIR, "cue_log.seeks.json"),
    out: path.join(EVAL_RESULTS_DIR, "cue_log_engine.json"),
    ws_url: null,
    with_cache: false,
    tick_ms: 50
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--input" && i + 1 < args.length) {
      options.input = path.resolve(args[++i]);
    } else if (arg === "--seeks" && i + 1 < args.length) {
      options.seeks = path.resolve(args[++i]);
    } else if (arg === "--out" && i + 1 < args.length) {
      options.out = path.resolve(args[++i]);
    } else if (arg === "--ws_url" && i + 1 < args.length) {
      options.ws_url = args[++i];
    } else if (arg === "--tick_ms" && i + 1 < args.length) {
      options.tick_ms = parseInt(args[++i], 10) || 50;
    } else if (arg === "--with_cache") {
      options.with_cache = true;
    }
  }

  return options;
}

async function runReplay() {
  const options = parseArgs();
  console.log("==========================================");
  console.log("Replaying STT Results Through SyncEngine");
  console.log("==========================================");
  console.log(`Input Results : ${options.input}`);
  console.log(`Seek Sidecar  : ${options.seeks}`);
  console.log(`Output Log    : ${options.out}`);
  console.log(`Live Backend  : ${options.ws_url ? options.ws_url : "OFF (using recorded/mock results)"}`);
  console.log(`With Cache    : ${options.with_cache ? "YES (pre-seek cache populated)" : "NO (exact recorded input)"}`);
  console.log(`Tick Interval : ${options.tick_ms} ms\n`);

  if (!fs.existsSync(options.input)) {
    console.error(`Error: Input file not found: ${options.input}`);
    process.exit(1);
  }

  const rawInput = JSON.parse(fs.readFileSync(options.input, "utf-8"));
  let inputCues = Array.isArray(rawInput) ? rawInput : (rawInput.cues || []);

  let seekEvents = [];
  if (fs.existsSync(options.seeks)) {
    const rawSeeks = JSON.parse(fs.readFileSync(options.seeks, "utf-8"));
    seekEvents = Array.isArray(rawSeeks) ? rawSeeks : (rawSeeks.events || []);
  }

  console.log(`Loaded ${inputCues.length} recorded cues, ${seekEvents.length} seek events.`);

  let currentVideoTime = 0.0;
  const engine = new SyncEngine({ getVideoTime: () => currentVideoTime });

  // If with_cache simulation is enabled, populate cache with pre-seek cues in epoch 1
  if (options.with_cache) {
    console.log("[Replay] Pre-populating SyncEngine cache with epoch 1 speech before seek...");
    for (let i = 0; i < inputCues.length; i++) {
      const c = inputCues[i];
      const ctx = { video_start_time: 0.0, playback_rate: 1.0 };
      const { cue } = engine.onResult({
        chunk_id: i + 1,
        epoch: 1,
        is_final: true,
        start_offset: c.start,
        end_offset: c.end,
        lang: c.lang || "hi",
        text: c.text || "mock",
        translation: c.translation || "mock",
        source: c.source || "stt"
      }, ctx);
      // Pre-seek playback: cue was shown during initial pass
      engine.markShown(cue, c.start);
    }
    console.log(`[Replay] Cache pre-populated with ${engine.store.size} cues from epoch 1.`);
  }

  // Determine playback simulation bounds
  const tickStep = options.tick_ms / 1000.0;
  let seekEvent = seekEvents.length > 0 ? seekEvents[0] : null;
  const seekAt = seekEvent ? parseFloat(seekEvent.seek_at ?? seekEvent.from_video_time ?? 3.0) : 3.0;
  const seekTo = seekEvent ? parseFloat(seekEvent.seek_to ?? seekEvent.to_video_time ?? 0.0) : 0.0;

  // Maximum timeline duration to simulate
  let maxTime = 5.0;
  for (const c of inputCues) {
    if (c.first_shown_at && c.first_shown_at > maxTime) maxTime = c.first_shown_at + 1.0;
    if (c.end && c.end > maxTime) maxTime = c.end + 1.0;
  }

  let seekTriggered = false;
  let deliveredIndices = new Set();

  console.log("\n[Replay] Starting video playback simulation loop...");

  // Phase 1: Play from 0.0 up to seekAt
  currentVideoTime = 0.0;
  while (currentVideoTime < seekAt) {
    const visible = engine.getVisibleCues(currentVideoTime);
    for (const vc of visible) {
      engine.markShown(vc, currentVideoTime);
    }
    currentVideoTime = Number((currentVideoTime + tickStep).toFixed(4));
  }

  // Phase 2: Trigger Seek
  if (seekEvent) {
    seekTriggered = true;
    engine.onSeek(seekTo);
    currentVideoTime = seekTo;
    console.log(`[Replay] Seek triggered at ${seekAt}s -> video jumped to ${seekTo}s. Engine epoch: ${engine.epoch}`);

    // Check immediate cache hit right at seekTo
    const immediateCues = engine.getVisibleCues(currentVideoTime);
    console.log(`[Replay] Immediate cache lookup at t=${currentVideoTime}s returned ${immediateCues.length} visible cue(s).`);
    for (const vc of immediateCues) {
      engine.markShown(vc, currentVideoTime);
      console.log(`  -> Rendered cached cue [${vc.start}s-${vc.end}s]: "${vc.text}" (first_shown_at set to ${vc.first_shown_at}s)`);
    }
  }

  // Phase 3: Continue playback from seekTo onwards, delivering incoming results
  while (currentVideoTime <= maxTime) {
    // Deliver any incoming results whose arrival time (first_shown_at in recorded log) is reached
    for (let i = 0; i < inputCues.length; i++) {
      if (!deliveredIndices.has(i)) {
        const c = inputCues[i];
        const arrivalTime = typeof c.first_shown_at === "number" ? c.first_shown_at : c.start;

        if (currentVideoTime >= arrivalTime) {
          deliveredIndices.add(i);
          const ctx = { video_start_time: 0.0, playback_rate: 1.0 };
          const outcome = engine.onResult({
            chunk_id: i + 1,
            epoch: engine.epoch,
            is_final: true,
            start_offset: c.start,
            end_offset: c.end,
            lang: c.lang || "hi",
            text: c.text || "",
            translation: c.translation || "",
            source: c.source || "stt"
          }, ctx);
          console.log(`[Replay] Incoming chunk ${i + 1} delivered at video time ${currentVideoTime}s: [${c.start}s-${c.end}s] -> status: ${outcome.status}`);
        }
      }
    }

    // Render tick: query visible cues and mark displayed
    const visible = engine.getVisibleCues(currentVideoTime);
    for (const vc of visible) {
      engine.markShown(vc, currentVideoTime);
    }

    currentVideoTime = Number((currentVideoTime + tickStep).toFixed(4));
  }

  // Phase 4: Export log
  const exported = engine.exportLog();
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, JSON.stringify(exported, null, 2), "utf-8");
  console.log(`\n[Replay] Engine replay complete. Exported ${exported.length} displayed cues to:\n  ${options.out}`);

  // Phase 5: Run score_sync.py on the exported log
  console.log("\n==========================================");
  console.log("Running eval/score_sync.py on Engine Log");
  console.log("==========================================");
  const pyCmd = getPythonCommand();
  const scoreScript = path.join(ROOT_DIR, "eval", "score_sync.py");

  try {
    const scoreOutput = execFileSync(pyCmd, [scoreScript, "--cue_log", options.out, "--seeks", options.seeks], {
      encoding: "utf-8",
      cwd: ROOT_DIR
    });
    console.log(scoreOutput.trim());
  } catch (err) {
    if (err.stdout) console.log(err.stdout.trim());
    if (err.stderr) console.error(err.stderr.trim());
  }
}

runReplay().catch(err => {
  console.error("[Fatal Error]:", err);
  process.exit(1);
});
