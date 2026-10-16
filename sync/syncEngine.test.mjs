/**
 * sync/syncEngine.test.mjs: Comprehensive test suite for SyncEngine using Node's native test runner.
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

test("2. Seek back -> epoch bump -> cached cue immediately visible (0s recovery without backend call)", () => {
  let currentTime = 10.0;
  const engine = new SyncEngine({ getVideoTime: () => currentTime });

  // Add cue covering 12.0s to 15.0s in epoch 1 (key: '1:201')
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

  // User seeks back to 13.5s (epoch 3)
  currentTime = 13.5;
  engine.onSeek(13.5);
  assert.equal(engine.epoch, 3);

  // Store still has the cached cue keyed by '1:201'
  assert.ok(engine.store.has("1:201"), "Cached cue from epoch 1 must survive seek");

  // Immediate cache lookup without backend call gives 0s recovery
  const visible = engine.getVisibleCues(13.5);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].text, "आज हम पनीर टिक्का बनाएंगे");
  assert.equal(visible[0].start, 12.0);
  assert.equal(visible[0].end, 15.0);

  // A late-arriving chunk from epoch 1 is rejected
  const lateRes = { chunk_id: 202, epoch: 1, is_final: true, start_offset: 0.0, end_offset: 1.0, text: "late" };
  const lateOutcome = engine.onResult(lateRes, ctx);
  assert.equal(lateOutcome.status, "dropped");
  assert.equal(lateOutcome.reason, "stale_epoch");
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

  // Ad finishes -> epoch increments again per contract rule 2
  engine.onAdEnd();
  assert.equal(engine.isAdActive, false);
  assert.equal(engine.epoch, 3);

  // Regular video speech arrives with new epoch 3
  const videoResult = {
    chunk_id: 502,
    epoch: 3,
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

  // 1. Partial hypothesis arrives in epoch 1
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
  let cue = engine.store.get("1:601");
  assert.equal(cue.text, "आज हम पनीर");
  assert.equal(cue.revisions.length, 1);
  assert.deepEqual(cue.revisions[0], { at: 15.2, text: "आज हम पनीर" });

  // 2. Final completed hypothesis arrives for the same chunk_id in epoch 1
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

  assert.equal(engine.store.size, 1, "Must remain exactly 1 cue for the same (epoch, chunk_id)");
  cue = engine.store.get("1:601");
  assert.equal(cue.text, "आज हम पनीर टिक्का बनाएंगे");
  assert.equal(cue.translation, "Today we will make paneer tikka");
  assert.equal(cue.revisions.length, 2, "Must contain exactly 2 revisions");
  assert.deepEqual(cue.revisions[1], { at: 16.1, text: "आज हम पनीर टिक्का बनाएंगे" });
});

test("7. Unshown cue is NOT exported in exportLog() (no fallback)", () => {
  const engine = new SyncEngine({ getVideoTime: () => 10.0 });
  const ctx = { video_start_time: 10.0, playback_rate: 1.0 };

  // Cue 1: shown
  const { cue: cue1 } = engine.onResult({
    chunk_id: 701,
    epoch: 1,
    is_final: true,
    start_offset: 0.0,
    end_offset: 2.0,
    lang: "hi",
    text: "यह सबटाइटल दिखा है"
  }, ctx);
  engine.markShown(cue1);

  // Cue 2: arrived into store but never displayed (markShown never called)
  engine.onResult({
    chunk_id: 702,
    epoch: 1,
    is_final: true,
    start_offset: 3.0,
    end_offset: 5.0,
    lang: "hi",
    text: "यह सबटाइटल कभी नहीं दिखा"
  }, ctx);

  assert.equal(engine.store.size, 2, "Store holds both cues");

  const exported = engine.exportLog();
  assert.equal(exported.length, 1, "exportLog must strictly contain only cues where markShown was called");
  assert.equal(exported[0].text, "यह सबटाइटल दिखा है");
});

test("8. Playback rate conversion: rate=1.5 gives t_video = video_start_time + offset * rate", () => {
  const engine = new SyncEngine({ getVideoTime: () => 20.0 });
  const ctx = { video_start_time: 20.0, playback_rate: 1.5 };

  const { cue } = engine.onResult({
    chunk_id: 801,
    epoch: 1,
    is_final: true,
    start_offset: 2.0,
    end_offset: 4.0,
    lang: "hi",
    text: "तेज गति पर भाषण"
  }, ctx);

  // Expected:
  // start = 20.0 + 2.0 * 1.5 = 23.0
  // end   = 20.0 + 4.0 * 1.5 = 26.0
  assert.equal(cue.start, 23.0);
  assert.equal(cue.end, 26.0);
});

test("9. Overlapping cues: getVisibleCues returns all active concurrent cues sorted by start ascending", () => {
  const engine = new SyncEngine({ getVideoTime: () => 13.0 });
  const ctx = { video_start_time: 10.0, playback_rate: 1.0 };

  // Cue A: 10.0s to 15.0s
  engine.onResult({
    chunk_id: 901,
    epoch: 1,
    is_final: true,
    start_offset: 0.0,
    end_offset: 5.0,
    lang: "hi",
    text: "पंक्ति ए (१० से १५)"
  }, ctx);

  // Cue B: 12.0s to 18.0s (overlaps with A between 12.0s and 15.0s)
  engine.onResult({
    chunk_id: 902,
    epoch: 1,
    is_final: true,
    start_offset: 2.0,
    end_offset: 8.0,
    lang: "hi",
    text: "पंक्ति बी (१२ से १८)"
  }, ctx);

  // At t = 11.0s: Only Cue A is active
  const at11 = engine.getVisibleCues(11.0);
  assert.equal(at11.length, 1);
  assert.equal(at11[0].text, "पंक्ति ए (१० से १५)");

  // At t = 13.0s: Both cues are active and returned sorted by start time
  const at13 = engine.getVisibleCues(13.0);
  assert.equal(at13.length, 2);
  assert.equal(at13[0].text, "पंक्ति ए (१० से १५)");
  assert.equal(at13[1].text, "पंक्ति बी (१२ से १८)");

  // At t = 16.0s: Only Cue B is active
  const at16 = engine.getVisibleCues(16.0);
  assert.equal(at16.length, 1);
  assert.equal(at16[0].text, "पंक्ति बी (१२ से १८)");

  // At t = 20.0s: Neither is active
  assert.equal(engine.getVisibleCues(20.0).length, 0);
});

test("10. Results for chunks sent during an ad arriving late after onAdEnd are dropped", () => {
  const engine = new SyncEngine({ getVideoTime: () => 40.0 });
  const ctx = { video_start_time: 40.0, playback_rate: 1.0 };

  // 1. Ad starts (epoch 1 -> 2)
  engine.onAdStart();
  assert.equal(engine.epoch, 2);

  // 2. Ad ends before chunk returns from backend (epoch 2 -> 3)
  engine.onAdEnd();
  assert.equal(engine.epoch, 3);
  assert.equal(engine.isAdActive, false);

  // 3. Late backend result arrives carrying ad epoch 2
  const lateAdResult = {
    chunk_id: 1001,
    epoch: 2,
    is_final: true,
    start_offset: 0.0,
    end_offset: 2.0,
    lang: "en",
    text: "Late ad text"
  };

  const outcome = engine.onResult(lateAdResult, ctx);
  assert.equal(outcome.status, "dropped");
  assert.equal(outcome.reason, "stale_epoch");
  assert.equal(engine.store.size, 0, "Late ad result must never be cached");
});

test("11. Results arriving after onNavigation with pre-navigation epoch are dropped", () => {
  const engine = new SyncEngine({ getVideoTime: () => 5.0 });
  const ctx = { video_start_time: 5.0, playback_rate: 1.0 };

  assert.equal(engine.epoch, 1);

  // User navigates away to a new video
  engine.onNavigation();
  assert.equal(engine.epoch, 2);
  assert.equal(engine.store.size, 0);

  // A chunk that was in-flight from previous video arrives with epoch 1
  const oldVideoResult = {
    chunk_id: 1101,
    epoch: 1,
    is_final: true,
    start_offset: 0.0,
    end_offset: 2.0,
    lang: "hi",
    text: "पुराने वीडियो का अधूरा रिजल्ट"
  };

  const outcome = engine.onResult(oldVideoResult, ctx);
  assert.equal(outcome.status, "dropped");
  assert.equal(outcome.reason, "stale_epoch");
  assert.equal(engine.store.size, 0, "Store must remain empty after navigation");
});

test("12. Real FLEURS clip cue log validation using eval/validate_log.py (real, not synthetic)", () => {
  const pythonCmd = getPythonCommand();
  const validatorScript = path.join(ROOT_DIR, "eval", "validate_log.py");

  // Validate real FLEURS clip log generated by eval/run_clip.py on hi_in_1778.wav
  const realCueLogPath = path.join(EVAL_RESULTS_DIR, "cue_log.json");
  assert.ok(fs.existsSync(realCueLogPath), `Real cue log file must exist at ${realCueLogPath}`);

  const outputReal = execFileSync(pythonCmd, [validatorScript, realCueLogPath], {
    encoding: "utf-8",
    cwd: ROOT_DIR
  });

  console.log(`[Real FLEURS Log Validation]:\n${outputReal.trim()}`);
  assert.ok(outputReal.includes("PASS"), "Real cue_log.json must PASS schema validation");

  // Ingest real cues through SyncEngine, mark shown, export and validate
  const engine = new SyncEngine({ getVideoTime: () => 2.48 });
  const rawCues = JSON.parse(fs.readFileSync(realCueLogPath, "utf-8"));

  for (let i = 0; i < rawCues.length; i++) {
    const rc = rawCues[i];
    const { cue } = engine.onResult({
      chunk_id: i + 1,
      epoch: engine.epoch,
      is_final: true,
      start_offset: rc.start,
      end_offset: rc.end,
      lang: rc.lang,
      text: rc.text,
      translation: rc.translation,
      source: rc.source
    }, { video_start_time: 0.0, playback_rate: 1.0 });

    engine.getVideoTime = () => rc.first_shown_at;
    engine.markShown(cue);
  }

  const exported = engine.exportLog();
  assert.equal(exported.length, rawCues.length);

  const exportedPath = path.join(EVAL_RESULTS_DIR, "cue_log_sync_real_fleurs.json");
  fs.writeFileSync(exportedPath, JSON.stringify(exported, null, 2), "utf-8");

  const outputExported = execFileSync(pythonCmd, [validatorScript, exportedPath], {
    encoding: "utf-8",
    cwd: ROOT_DIR
  });

  console.log(`[SyncEngine Export of Real Cues Validation]:\n${outputExported.trim()}`);
  assert.ok(outputExported.includes("PASS"), "SyncEngine export of real cues must PASS schema validation");
});
