/**
 * sync/syncEngine.test.mjs: Test suite for SyncEngine using Node's native test runner.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { SyncEngine } from "./syncEngine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const EVAL_RESULTS_DIR = path.join(ROOT_DIR, "eval", "results");

// Helper to determine the best Python executable
function getPythonCommand() {
  const venvPythonWin = path.join(ROOT_DIR, "eval", "venv", "Scripts", "python.exe");
  const venvPythonUnix = path.join(ROOT_DIR, "eval", "venv", "bin", "python");

  if (fs.existsSync(venvPythonWin)) return venvPythonWin;
  if (fs.existsSync(venvPythonUnix)) return venvPythonUnix;
  return process.platform === "win32" ? "python" : "python3";
}

test("1. Stale epoch result is dropped", () => {
  let currentTime = 10.0;
  const engine = new SyncEngine({ getVideoTime: () => currentTime });
  assert.equal(engine.epoch, 1);

  // Seek triggers epoch increment
  engine.onSeek(25.0);
  assert.equal(engine.epoch, 2);

  // Incoming chunk still tagged with stale epoch 1
  const staleResult = {
    chunk_id: 101,
    epoch: 1,
    is_final: true,
    start_offset: 0.0,
    end_offset: 1.0,
    lang: "hi",
    text: "स्टेल रिजल्ट"
  };
  const ctx = { video_start_time: 10.0, playback_rate: 1.0 };

  const outcome = engine.onResult(staleResult, ctx);
  assert.equal(outcome.status, "dropped");
  assert.equal(outcome.reason, "stale_epoch");
  assert.equal(engine.store.size, 0, "Store must not contain dropped stale cue");
});

test("2. Seek back to a time that has cached cues: getVisibleCues returns them immediately with 0s recovery", () => {
  let currentTime = 10.0;
  const engine = new SyncEngine({ getVideoTime: () => currentTime });

  // Add cue covering 12.0s to 15.0s
  const res = {
    chunk_id: 201,
    epoch: 1,
    is_final: true,
    start_offset: 2.0,
    end_offset: 5.0,
    lang: "hi",
    text: "आज हम पनीर टिक्का बनाएंगे",
    translation: "Today we will make paneer tikka"
  };
  const ctx = { video_start_time: 10.0, playback_rate: 1.0 };
  const { cue } = engine.onResult(res, ctx);
  assert.equal(cue.start, 12.0);
  assert.equal(cue.end, 15.0);

  // User plays through 13.0s and subtitle is shown
  currentTime = 13.0;
  engine.markShown(cue);
  assert.equal(cue.first_shown_at, 13.0);

  // User seeks forward to 60.0s (epoch 2)
  currentTime = 60.0;
  engine.onSeek(60.0);
  assert.equal(engine.epoch, 2);

  // User now seeks back to 13.5s (epoch 3)
  currentTime = 13.5;
  engine.onSeek(13.5);
  assert.equal(engine.epoch, 3);

  // Immediate cache lookup without any backend call
  const visible = engine.getVisibleCues(13.5);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].text, "आज हम पनीर टिक्का बनाएंगे");
  assert.equal(visible[0].start, 12.0);
  assert.equal(visible[0].end, 15.0);
});

test("3. Seek forward to an uncached time: no stale cues are shown", () => {
  let currentTime = 10.0;
  const engine = new SyncEngine({ getVideoTime: () => currentTime });

  // Populate cache with an early cue at 10.0s - 14.0s
  engine.onResult(
    {
      chunk_id: 301,
      epoch: 1,
      is_final: true,
      start_offset: 0.0,
      end_offset: 4.0,
      lang: "hi",
      text: "शुरुआती सबटाइटल"
    },
    { video_start_time: 10.0, playback_rate: 1.0 }
  );

  // Seek forward to 120.0s where no subtitles have been processed
  currentTime = 120.0;
  engine.onSeek(120.0);

  const visibleAt120 = engine.getVisibleCues(120.0);
  assert.equal(visibleAt120.length, 0, "No stale cues should be visible at uncached position");
});

test("4. onNavigation clears everything", () => {
  let currentTime = 5.0;
  const engine = new SyncEngine({ getVideoTime: () => currentTime });

  engine.onResult(
    {
      chunk_id: 401,
      epoch: 1,
      is_final: true,
      start_offset: 0.0,
      end_offset: 2.0,
      lang: "hi",
      text: "पुराने वीडियो का सबटाइटल"
    },
    { video_start_time: 5.0, playback_rate: 1.0 }
  );
  assert.equal(engine.store.size, 1);

  // User navigates to a new video URL
  engine.onNavigation();
  assert.equal(engine.epoch, 2);
  assert.equal(engine.store.size, 0, "Store must be completely cleared on navigation");
  assert.equal(engine.getVisibleCues(5.0).length, 0);

  const events = engine.exportEvents();
  assert.ok(events.some(e => e.type === "navigation"));
});

test("5. Result arriving during an ad is dropped; after onAdEnd new results are accepted", () => {
  let currentTime = 30.0;
  const engine = new SyncEngine({ getVideoTime: () => currentTime });

  // Ad begins
  engine.onAdStart();
  assert.equal(engine.isAdActive, true);
  assert.equal(engine.epoch, 2);

  // Ad audio transcribed by backend arrives
  const adResult = {
    chunk_id: 501,
    epoch: 2,
    is_final: true,
    start_offset: 0.0,
    end_offset: 3.0,
    lang: "en",
    text: "Buy this insurance today with zero deductible"
  };
  const ctx = { video_start_time: 30.0, playback_rate: 1.0 };

  const outcomeDuringAd = engine.onResult(adResult, ctx);
  assert.equal(outcomeDuringAd.status, "dropped");
  assert.equal(outcomeDuringAd.reason, "ad");
  assert.equal(engine.store.size, 0, "Ad speech must never enter the timeline store");

  // Ad finishes
  engine.onAdEnd();
  assert.equal(engine.isAdActive, false);

  // Regular video speech arrives
  const videoResult = {
    chunk_id: 502,
    epoch: 2,
    is_final: true,
    start_offset: 0.0,
    end_offset: 2.5,
    lang: "hi",
    text: "मुख्य वीडियो सामग्री वापस आ गई"
  };
  const outcomeAfterAd = engine.onResult(videoResult, ctx);
  assert.equal(outcomeAfterAd.status, "accepted");
  assert.equal(engine.store.size, 1);
});

test("6. is_final=false then is_final=true on the same chunk produces 1 cue with 2 revisions", () => {
  let currentTime = 15.0;
  const engine = new SyncEngine({ getVideoTime: () => currentTime });
  const ctx = { video_start_time: 14.0, playback_rate: 1.0 };

  // 1. Partial hypothesis arrives
  currentTime = 15.2;
  const resPartial = {
    chunk_id: 601,
    epoch: 1,
    is_final: false,
    start_offset: 0.0,
    end_offset: 1.5,
    lang: "hi",
    text: "आज हम पनीर"
  };
  engine.onResult(resPartial, ctx);

  assert.equal(engine.store.size, 1);
  let cue = engine.store.get(601);
  assert.equal(cue.text, "आज हम पनीर");
  assert.equal(cue.revisions.length, 1);
  assert.deepEqual(cue.revisions[0], { at: 15.2, text: "आज हम पनीर" });

  // 2. Final completed hypothesis arrives for the same chunk_id
  currentTime = 16.1;
  const resFinal = {
    chunk_id: 601,
    epoch: 1,
    is_final: true,
    start_offset: 0.0,
    end_offset: 2.2,
    lang: "hi",
    text: "आज हम पनीर टिक्का बनाएंगे",
    translation: "Today we will make paneer tikka"
  };
  engine.onResult(resFinal, ctx);

  assert.equal(engine.store.size, 1, "Must remain exactly 1 cue for the same chunk_id");
  cue = engine.store.get(601);
  assert.equal(cue.text, "आज हम पनीर टिक्का बनाएंगे");
  assert.equal(cue.translation, "Today we will make paneer tikka");
  assert.equal(cue.revisions.length, 2, "Must contain exactly 2 revisions");
  assert.deepEqual(cue.revisions[1], { at: 16.1, text: "आज हम पनीर टिक्का बनाएंगे" });
});

test("7. exportLog output validates with eval/validate_log.py", () => {
  let currentTime = 10.0;
  const engine = new SyncEngine({ getVideoTime: () => currentTime });

  // Add 3 realistic cues
  const ctx1 = { video_start_time: 10.0, playback_rate: 1.0 };
  const { cue: cue1 } = engine.onResult({
    chunk_id: 701,
    epoch: 1,
    is_final: true,
    start_offset: 0.0,
    end_offset: 2.5,
    lang: "hi",
    text: "नमस्ते और स्वागत है",
    translation: "Hello and welcome",
    source: "stt"
  }, ctx1);
  currentTime = 12.6;
  engine.markShown(cue1);

  const ctx2 = { video_start_time: 13.0, playback_rate: 1.0 };
  const { cue: cue2 } = engine.onResult({
    chunk_id: 702,
    epoch: 1,
    is_final: true,
    start_offset: 0.0,
    end_offset: 3.0,
    lang: "hi",
    text: "आज हम एक नई डिश बनाएंगे",
    translation: "Today we will prepare a new dish",
    source: "stt"
  }, ctx2);
  currentTime = 16.2;
  engine.markShown(cue2);

  const ctx3 = { video_start_time: 17.0, playback_rate: 1.0 };
  const { cue: cue3 } = engine.onResult({
    chunk_id: 703,
    epoch: 1,
    is_final: true,
    start_offset: 0.5,
    end_offset: 3.5,
    lang: "hi",
    text: "यह बहुत स्वादिष्ट बनती है",
    translation: "It turns out very delicious",
    source: "stt"
  }, ctx3);
  currentTime = 20.8;
  engine.markShown(cue3);

  // Export strictly schema-valid log
  const exportedCues = engine.exportLog();
  assert.ok(Array.isArray(exportedCues));
  assert.equal(exportedCues.length, 3);

  // Verify exact 8 schema fields on every cue
  const requiredKeys = ["start", "end", "lang", "text", "translation", "source", "first_shown_at", "revisions"].sort();
  for (const c of exportedCues) {
    const cueKeys = Object.keys(c).sort();
    assert.deepEqual(cueKeys, requiredKeys, `Cue must contain exactly the 8 schema fields, got: ${cueKeys}`);
    assert.ok(c.start < c.end, `start (${c.start}) must be strictly less than end (${c.end})`);
    assert.ok(c.first_shown_at >= 0, `first_shown_at must be non-negative`);
    assert.ok(Array.isArray(c.revisions) && c.revisions.length > 0);
  }

  // Save to eval/results/
  fs.mkdirSync(EVAL_RESULTS_DIR, { recursive: true });
  const exportPath = path.join(EVAL_RESULTS_DIR, "cue_log_sync_test.json");
  fs.writeFileSync(exportPath, JSON.stringify(exportedCues, null, 2), "utf-8");

  // Run eval/validate_log.py via child_process
  const pythonCmd = getPythonCommand();
  const validatorScript = path.join(ROOT_DIR, "eval", "validate_log.py");

  const output = execFileSync(pythonCmd, [validatorScript, exportPath], {
    encoding: "utf-8",
    cwd: ROOT_DIR
  });

  console.log(`[Validation Output]:\n${output.trim()}`);
  assert.ok(output.includes("PASS"), "Validator output must confirm PASS");
});
