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
  engine.markShown(cue, currentTime);
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
  engine.markShown(cue1, 10.5);

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
  assert.equal(exported[0].first_shown_at, 10.5);
});

test("8. Playback rate conversion: rate=1.5 gives t_video = video_start_time + offset * rate (e.g. 60.0 + 4.0*1.5 = 66.0)", () => {
  const engine = new SyncEngine({ getVideoTime: () => 60.0 });
  const ctx = { video_start_time: 60.0, playback_rate: 1.5 };

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
  // start = 60.0 + 2.0 * 1.5 = 63.0
  // end   = 60.0 + 4.0 * 1.5 = 66.0
  assert.equal(cue.start, 63.0);
  assert.equal(cue.end, 66.0);
});

test("9. Overlapping cues: different sources coexist sorted by start, while same-source newer epoch replaces older overlapping cue", () => {
  const engine = new SyncEngine({ getVideoTime: () => 13.0 });
  const ctx = { video_start_time: 10.0, playback_rate: 1.0 };

  // Cue A: 10.0s to 15.0s, source = "captions" (epoch 1)
  engine.onResult({
    chunk_id: 901,
    epoch: 1,
    is_final: true,
    start_offset: 0.0,
    end_offset: 5.0,
    lang: "hi",
    text: "कैप्शन पंक्ति ए (१० से १५)",
    source: "captions"
  }, ctx);

  // Cue B: 12.0s to 18.0s, source = "stt" (epoch 1)
  engine.onResult({
    chunk_id: 902,
    epoch: 1,
    is_final: true,
    start_offset: 2.0,
    end_offset: 8.0,
    lang: "hi",
    text: "एसटीटी पंक्ति बी (१२ से १८)",
    source: "stt"
  }, ctx);

  // At t = 13.0s: Different sources ("captions" and "stt") coexist concurrently, sorted by start ascending
  const at13Before = engine.getVisibleCues(13.0);
  assert.equal(at13Before.length, 2);
  assert.equal(at13Before[0].source, "captions");
  assert.equal(at13Before[0].start, 10.0);
  assert.equal(at13Before[1].source, "stt");
  assert.equal(at13Before[1].start, 12.0);

  // Now Cue C arrives in epoch 2, source = "stt", covering [11.0s, 16.0s]
  // Rule 1: Same source ("stt") + time overlap -> newer epoch 2 REPLACES older epoch 1 STT cue (Cue B),
  // but does NOT replace Cue A because source ("captions") is different.
  engine.epoch = 2;
  engine.onResult({
    chunk_id: 903,
    epoch: 2,
    is_final: true,
    start_offset: 1.0,
    end_offset: 6.0,
    lang: "hi",
    text: "नया एसटीटी पंक्ति सी (११ से १६)",
    source: "stt"
  }, ctx);

  // Older STT cue B has been deleted; newer STT cue C is present
  assert.ok(!engine.store.has("1:902"), "Older epoch 1 STT cue must be replaced and deleted");
  assert.ok(engine.store.has("2:903"), "Newer epoch 2 STT cue must be stored");
  assert.ok(engine.store.has("1:901"), "Captions cue must be preserved");

  // At t = 13.0s: Visible cues are Cue A (captions) and Cue C (stt), sorted by start (10.0 then 11.0)
  const at13After = engine.getVisibleCues(13.0);
  assert.equal(at13After.length, 2);
  assert.equal(at13After[0].text, "कैप्शन पंक्ति ए (१० से १५)");
  assert.equal(at13After[1].text, "नया एसटीटी पंक्ति सी (११ से १६)");
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

test("12. Seek-back + re-transcribe replaces older overlapping cue: NO duplicates in getVisibleCues or exportLog", () => {
  let currentTime = 0.0;
  const engine = new SyncEngine({ getVideoTime: () => currentTime });
  const ctx = { video_start_time: 0.0, playback_rate: 1.0 };

  // 1. Initial pass in epoch 1: chunk 1 covering [0.0s, 2.5s]
  const { cue: cue1 } = engine.onResult({
    chunk_id: 1,
    epoch: 1,
    is_final: true,
    start_offset: 0.0,
    end_offset: 2.5,
    lang: "hi",
    text: "मूल पाठ (युग १)"
  }, ctx);
  engine.markShown(cue1, 0.5);

  assert.equal(engine.store.size, 1);
  assert.equal(engine.getVisibleCues(1.0).length, 1);
  assert.equal(engine.getVisibleCues(1.0)[0].text, "मूल पाठ (युग १)");

  // 2. User seeks back to 0.0s (epoch 1 -> 2)
  currentTime = 0.0;
  engine.onSeek(0.0);
  assert.equal(engine.epoch, 2);

  // Cache lookup still returns old cue before re-transcription arrives (0s recovery)
  assert.equal(engine.getVisibleCues(1.0).length, 1);
  assert.equal(engine.getVisibleCues(1.0)[0].text, "मूल पाठ (युग १)");

  // 3. New re-transcription arrives in epoch 2 covering the overlapping range [0.0s, 2.5s]
  const { cue: cue2 } = engine.onResult({
    chunk_id: 1,
    epoch: 2,
    is_final: true,
    start_offset: 0.0,
    end_offset: 2.5,
    lang: "hi",
    text: "सुधारित पुनः अनुलेखित पाठ (युग २)"
  }, ctx);
  engine.markShown(cue2, 0.1);

  // Newer epoch MUST replace the older epoch overlapping cue
  assert.equal(engine.store.size, 1, "Must contain exactly 1 cue after replacement, no duplicate");
  assert.ok(engine.store.has("2:1"));
  assert.ok(!engine.store.has("1:1"), "Old epoch cue '1:1' must have been replaced and deleted");

  // getVisibleCues has no duplicates
  const visible = engine.getVisibleCues(1.0);
  assert.equal(visible.length, 1, "getVisibleCues must not return duplicates");
  assert.equal(visible[0].text, "सुधारित पुनः अनुलेखित पाठ (युग २)");

  // exportLog has no duplicates
  const exported = engine.exportLog();
  assert.equal(exported.length, 1, "exportLog must not have duplicates");
  assert.equal(exported[0].text, "सुधारित पुनः अनुलेखित पाठ (युग २)");
});

test("13. Boundary rule: t == end is NOT visible; at boundary of two adjacent cues exactly one is active", () => {
  const engine = new SyncEngine({ getVideoTime: () => 10.0 });
  const ctx = { video_start_time: 10.0, playback_rate: 1.0 };

  // Cue 1: [10.0s, 12.0s)
  engine.onResult({
    chunk_id: 1,
    epoch: 1,
    is_final: true,
    start_offset: 0.0,
    end_offset: 2.0,
    lang: "hi",
    text: "पहला सबटाइटल"
  }, ctx);

  // Cue 2: [12.0s, 15.0s) adjacent to Cue 1
  engine.onResult({
    chunk_id: 2,
    epoch: 1,
    is_final: true,
    start_offset: 2.0,
    end_offset: 5.0,
    lang: "hi",
    text: "दूसरा सबटाइटल"
  }, ctx);

  // At t = 10.0s: Cue 1 is active (start inclusive)
  const v10 = engine.getVisibleCues(10.0);
  assert.equal(v10.length, 1);
  assert.equal(v10[0].text, "पहला सबटाइटल");

  // At t = 11.99s: Cue 1 is active
  const v119 = engine.getVisibleCues(11.99);
  assert.equal(v119.length, 1);
  assert.equal(v119[0].text, "पहला सबटाइटल");

  // At boundary t = 12.0s:
  // Cue 1 ends at 12.0 (end-exclusive: 12.0 < 12.0 is FALSE -> NOT visible)
  // Cue 2 starts at 12.0 (start-inclusive: 12.0 <= 12.0 < 15.0 is TRUE -> VISIBLE)
  const v12 = engine.getVisibleCues(12.0);
  assert.equal(v12.length, 1, "Exactly one cue must be visible at adjacent boundary");
  assert.equal(v12[0].text, "दूसरा सबटाइटल");

  // At t = 15.0s: Cue 2 ends (end-exclusive -> NOT visible)
  const v15 = engine.getVisibleCues(15.0);
  assert.equal(v15.length, 0, "No cues visible at t == end of Cue 2");
});

test("14. markShown ignores subsequent calls (first_shown_at never overwritten)", () => {
  const engine = new SyncEngine({ getVideoTime: () => 10.0 });
  const ctx = { video_start_time: 10.0, playback_rate: 1.0 };

  const { cue } = engine.onResult({
    chunk_id: 1,
    epoch: 1,
    is_final: true,
    start_offset: 0.0,
    end_offset: 2.0,
    lang: "hi",
    text: "पहला सबटाइटल"
  }, ctx);

  assert.equal(cue.first_shown_at, null);

  // 1st call at video time 10.45s sets first_shown_at
  engine.markShown(cue, 10.45);
  assert.equal(cue.first_shown_at, 10.45);

  // 2nd call at video time 11.80s must be ignored
  engine.markShown(cue, 11.80);
  assert.equal(cue.first_shown_at, 10.45, "first_shown_at must not be overwritten by 2nd call");

  // 3rd call with no explicit videoTime uses getVideoTime callback (ignored)
  engine.getVideoTime = () => 15.0;
  engine.markShown(cue);
  assert.equal(cue.first_shown_at, 10.45, "first_shown_at must remain exactly 10.45");
});

test("15. Real FLEURS clip cue log validation using eval/validate_log.py", (t) => {
  const pythonCmd = getPythonCommand();
  const validatorScript = path.join(ROOT_DIR, "eval", "validate_log.py");

  // Preference order: sample committed file, then results/cue_log.json
  const samplePath = path.join(ROOT_DIR, "eval", "sample_cue_log_fleurs.json");
  const resultsPath = path.join(EVAL_RESULTS_DIR, "cue_log.json");

  let cueLogPath = null;
  if (fs.existsSync(samplePath)) {
    cueLogPath = samplePath;
  } else if (fs.existsSync(resultsPath)) {
    cueLogPath = resultsPath;
  }

  if (!cueLogPath) {
    t.skip("Neither eval/sample_cue_log_fleurs.json nor eval/results/cue_log.json found, skipping test.");
    return;
  }

  const outputReal = execFileSync(pythonCmd, [validatorScript, cueLogPath], {
    encoding: "utf-8",
    cwd: ROOT_DIR
  });

  console.log(`[Real FLEURS Log Validation (${path.basename(cueLogPath)})]:\n${outputReal.trim()}`);
  assert.ok(outputReal.includes("PASS"), "cue_log must PASS schema validation");

  // Ingest cues through SyncEngine, mark shown with videoTime, export and validate
  const rawCues = JSON.parse(fs.readFileSync(cueLogPath, "utf-8"));
  const engine = new SyncEngine({ getVideoTime: () => 0.0 });

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

    engine.markShown(cue, rc.first_shown_at);
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

test("16. Late-cue policy: end+2s late cue visible + exported with first_shown_at = arrival video time", () => {
  let currentTime = 14.5; // Arrives at 14.5s (which is end + 2.0s)
  const engine = new SyncEngine({ getVideoTime: () => currentTime, minHold: 2.0 });
  const ctx = { video_start_time: 10.0, playback_rate: 1.0 };

  // Speech range is [10.0s, 12.5s], but arrives late at video time 14.5s
  const { cue } = engine.onResult({
    chunk_id: 1601,
    epoch: 1,
    is_final: true,
    start_offset: 0.0,
    end_offset: 2.5,
    lang: "hi",
    text: "देर से आने वाला सबटाइटल"
  }, ctx);

  assert.equal(cue.start, 10.0);
  assert.equal(cue.end, 12.5);
  // Arrival video time is 14.5s
  assert.equal(cue.first_shown_at, 14.5);

  // At arrival video time 14.5s: cue MUST be visible under late-cue policy
  const visible = engine.getVisibleCues(14.5);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].text, "देर से आने वाला सबटाइटल");

  // Mark shown idempotently
  engine.markShown(cue, 14.5);
  assert.equal(cue.first_shown_at, 14.5);

  // Must be exported in exportLog
  const exported = engine.exportLog();
  assert.equal(exported.length, 1);
  assert.equal(exported[0].text, "देर से आने वाला सबटाइटल");
  assert.equal(exported[0].start, 10.0);
  assert.equal(exported[0].end, 12.5);
  assert.equal(exported[0].first_shown_at, 14.5);
});

test("17. Late-cue policy: hold ke baad gayab", () => {
  let currentTime = 14.5;
  const engine = new SyncEngine({ getVideoTime: () => currentTime, minHold: 2.0 });
  const ctx = { video_start_time: 10.0, playback_rate: 1.0 };

  // Speech [10.0s, 12.5s], arrives at 14.5s -> minHold 2.0s holds until 16.5s
  engine.onResult({
    chunk_id: 1701,
    epoch: 1,
    is_final: true,
    start_offset: 0.0,
    end_offset: 2.5,
    lang: "hi",
    text: "होल्ड टेस्ट"
  }, ctx);

  // At 15.5s (during hold): still visible
  assert.equal(engine.getVisibleCues(15.5).length, 1);
  assert.equal(engine.getVisibleCues(15.5)[0].text, "होल्ड टेस्ट");

  // At 16.49s (end of hold): still visible
  assert.equal(engine.getVisibleCues(16.49).length, 1);

  // At 16.50s (hold expired, hold ke baad gayab): NOT visible
  assert.equal(engine.getVisibleCues(16.50).length, 0);

  // At 17.0s: NOT visible
  assert.equal(engine.getVisibleCues(17.0).length, 0);
});

test("18. Late-cue policy: seek pe hold clear & seek-back cached cues pe hold nahi", () => {
  let currentTime = 14.5;
  const engine = new SyncEngine({ getVideoTime: () => currentTime, minHold: 2.0 });
  const ctx = { video_start_time: 10.0, playback_rate: 1.0 };

  // Speech [10.0s, 12.5s], arrives late at 14.5s
  const { cue } = engine.onResult({
    chunk_id: 1801,
    epoch: 1,
    is_final: true,
    start_offset: 0.0,
    end_offset: 2.5,
    lang: "hi",
    text: "सीक होल्ड टेस्ट"
  }, ctx);

  assert.equal(engine.getVisibleCues(14.5).length, 1);

  // User seeks forward to 50.0s
  currentTime = 50.0;
  engine.onSeek(50.0);

  // At new position 50.0s: hold was cleared, nothing visible
  assert.equal(engine.getVisibleCues(50.0).length, 0);

  // Seek back to 13.0s (which is > cue.end 12.5s):
  // Since seek-back cached cues DO NOT have hold, it must NOT be visible at 13.0s!
  currentTime = 13.0;
  engine.onSeek(13.0);
  assert.equal(engine.getVisibleCues(13.0).length, 0, "Cached cues on seek-back must not have hold past end");

  // Seek back into speech range [10.0s, 12.5s) at 11.0s:
  // Cached cue IS visible strictly during its speech range!
  currentTime = 11.0;
  engine.onSeek(11.0);
  assert.equal(engine.getVisibleCues(11.0).length, 1);
  assert.equal(engine.getVisibleCues(11.0)[0].text, "सीक होल्ड टेस्ट");
});

test("19. D1 (a): Seek-back with cached cue produces 2 entries in exportLog; second first_shown_at = seek-back time", () => {
  let currentTime = 10.0;
  const engine = new SyncEngine({ getVideoTime: () => currentTime });
  const ctx = { video_start_time: 10.0, playback_rate: 1.0 };

  // Cue arrives in epoch 1
  const { cue } = engine.onResult({
    chunk_id: 1901,
    epoch: 1,
    is_final: true,
    start_offset: 2.0,
    end_offset: 5.0,
    lang: "hi",
    text: "सीक बैक पुनः प्रदर्शन",
    translation: "Seek back re-show"
  }, ctx);

  // 1st show in epoch 1 at video time 12.5s
  currentTime = 12.5;
  engine.markShown(cue, 12.5);
  assert.equal(cue.first_shown_at, 12.5);

  // User seeks forward to 60.0s (epoch 2)
  currentTime = 60.0;
  engine.onSeek(60.0);
  assert.equal(engine.epoch, 2);

  // User seeks back to 13.0s (epoch 3)
  currentTime = 13.0;
  engine.onSeek(13.0);
  assert.equal(engine.epoch, 3);

  // Overlay finds cached cue covering 13.0s and calls markShown with seek-back time
  const visible = engine.getVisibleCues(13.0);
  assert.equal(visible.length, 1);
  engine.markShown(visible[0], 13.0);

  // Default exportLog (reshow_entries = true) produces 2 distinct entries
  const exported = engine.exportLog();
  assert.equal(exported.length, 2, "Must produce exactly 2 entries for re-shown cached cue");

  // Entry 1: initial show in epoch 1
  assert.equal(exported[0].start, 12.0);
  assert.equal(exported[0].end, 15.0);
  assert.equal(exported[0].first_shown_at, 12.5);
  assert.equal(exported[0].text, "सीक बैक पुनः प्रदर्शन");

  // Entry 2: re-show in epoch 3 with first_shown_at = 13.0
  assert.equal(exported[1].start, 12.0);
  assert.equal(exported[1].end, 15.0);
  assert.equal(exported[1].first_shown_at, 13.0);
  assert.equal(exported[1].text, "सीक बैक पुनः प्रदर्शन");
  assert.deepEqual(exported[1].revisions, [{ at: 13.0, text: "सीक बैक पुनः प्रदर्शन" }]);
});

test("20. D1 (b): Overlay does NOT call markShown on seek-back -> second entry is NOT created", () => {
  let currentTime = 10.0;
  const engine = new SyncEngine({ getVideoTime: () => currentTime });
  const ctx = { video_start_time: 10.0, playback_rate: 1.0 };

  const { cue } = engine.onResult({
    chunk_id: 2001,
    epoch: 1,
    is_final: true,
    start_offset: 2.0,
    end_offset: 5.0,
    lang: "hi",
    text: "बिना दिखाए सीक"
  }, ctx);

  // Shown in epoch 1
  currentTime = 12.5;
  engine.markShown(cue, 12.5);

  // Seek back to 13.0 (epoch 2)
  currentTime = 13.0;
  engine.onSeek(13.0);

  // Overlay does NOT call markShown
  const exported = engine.exportLog();
  assert.equal(exported.length, 1, "Only 1 entry must exist if markShown was never called in new epoch");
  assert.equal(exported[0].first_shown_at, 12.5);
});

test("21. D1 (c): --reshow_entries off ({ reshow_entries: false }) preserves legacy single-entry behavior", () => {
  let currentTime = 10.0;
  const engine = new SyncEngine({ getVideoTime: () => currentTime });
  const ctx = { video_start_time: 10.0, playback_rate: 1.0 };

  const { cue } = engine.onResult({
    chunk_id: 2101,
    epoch: 1,
    is_final: true,
    start_offset: 2.0,
    end_offset: 5.0,
    lang: "hi",
    text: "फ्लैग ऑफ टेस्ट"
  }, ctx);

  // Show in epoch 1
  engine.markShown(cue, 12.5);

  // Seek back in epoch 2 and re-show
  engine.onSeek(13.0);
  engine.markShown(cue, 13.0);

  // With reshow_entries: false -> legacy single entry
  const legacyExport = engine.exportLog({ reshow_entries: false });
  assert.equal(legacyExport.length, 1, "Must export strictly 1 entry when reshow_entries is false");
  assert.equal(legacyExport[0].first_shown_at, 12.5);
});

test("22. D1 (d): exportLog output with re-show entries PASSES eval/validate_log.py", () => {
  const pythonCmd = getPythonCommand();
  const validatorScript = path.join(ROOT_DIR, "eval", "validate_log.py");

  const engine = new SyncEngine({ getVideoTime: () => 10.0 });
  const ctx = { video_start_time: 10.0, playback_rate: 1.0 };

  const { cue } = engine.onResult({
    chunk_id: 2201,
    epoch: 1,
    is_final: true,
    start_offset: 2.0,
    end_offset: 5.0,
    lang: "hi",
    text: "स्कीमा वैलिडेशन टेस्ट",
    translation: "Schema validation test"
  }, ctx);

  engine.markShown(cue, 12.5);
  engine.onSeek(13.0);
  engine.markShown(cue, 13.0);

  const exported = engine.exportLog();
  assert.equal(exported.length, 2);

  const testLogPath = path.join(EVAL_RESULTS_DIR, "cue_log_test_reshow.json");
  fs.mkdirSync(EVAL_RESULTS_DIR, { recursive: true });
  fs.writeFileSync(testLogPath, JSON.stringify(exported, null, 2), "utf-8");

  const valOutput = execFileSync(pythonCmd, [validatorScript, testLogPath], {
    encoding: "utf-8",
    cwd: ROOT_DIR
  });
  console.log(`[Re-show Log Validation]:\n${valOutput.trim()}`);
  assert.ok(valOutput.includes("PASS"), "Exported re-show cue log must pass validate_log.py");
});

test("23. D1 (e): Without seek (accuracy path: continuous playback), duplicates are NEVER created", () => {
  let currentTime = 0.0;
  const engine = new SyncEngine({ getVideoTime: () => currentTime });
  const ctx = { video_start_time: 0.0, playback_rate: 1.0 };

  // 3 sequential cues in epoch 1
  for (let i = 1; i <= 3; i++) {
    const { cue } = engine.onResult({
      chunk_id: 2300 + i,
      epoch: 1,
      is_final: true,
      start_offset: (i - 1) * 3.0,
      end_offset: i * 3.0,
      lang: "hi",
      text: `लगातार भाषण ${i}`
    }, ctx);

    // Mark shown repeatedly across ticks
    engine.markShown(cue, (i - 1) * 3.0 + 0.5);
    engine.markShown(cue, (i - 1) * 3.0 + 1.0);
    engine.markShown(cue, (i - 1) * 3.0 + 1.5);
  }

  const exported = engine.exportLog();
  assert.equal(exported.length, 3, "Exactly 3 cues exported for 3 sequential chunks with no seeks");
});

test("24. D2: Code-mixed sidecar: {'lang':'hi','langs':['hi','en']} -> log lang 'hi', sidecar ['hi','en'], validate_log pass", () => {
  const pythonCmd = getPythonCommand();
  const validatorScript = path.join(ROOT_DIR, "eval", "validate_log.py");

  const engine = new SyncEngine({ getVideoTime: () => 10.0 });
  const ctx = { video_start_time: 10.0, playback_rate: 1.0 };

  const { cue } = engine.onResult({
    chunk_id: 2401,
    epoch: 1,
    is_final: true,
    start_offset: 1.0,
    end_offset: 4.0,
    lang: "hi",
    langs: ["hi", "en"],
    text: "आज हम paneer tikka बनाएंगे",
    translation: "Today we will make paneer tikka"
  }, ctx);

  engine.markShown(cue, 11.2);

  const exported = engine.exportLog();
  assert.equal(exported.length, 1);
  assert.equal(exported[0].lang, "hi", "Cue log lang must be single string dominant language");
  assert.equal(exported[0].langs, undefined, "Strict 8 fields: langs must not be in exported cue log");

  // Sidecar dictionary
  const sidecar = engine.exportLangsSidecar(exported);
  assert.deepEqual(sidecar[0], ["hi", "en"], "Sidecar dictionary must store full langs list");

  const testLogPath = path.join(EVAL_RESULTS_DIR, "cue_log_codemixed.json");
  const testSidecarPath = path.join(EVAL_RESULTS_DIR, "cue_log_codemixed.langs.json");
  fs.mkdirSync(EVAL_RESULTS_DIR, { recursive: true });
  fs.writeFileSync(testLogPath, JSON.stringify(exported, null, 2), "utf-8");
  fs.writeFileSync(testSidecarPath, JSON.stringify(sidecar, null, 2), "utf-8");

  const valOutput = execFileSync(pythonCmd, [validatorScript, testLogPath], {
    encoding: "utf-8",
    cwd: ROOT_DIR
  });
  console.log(`[Code-Mixed Log Validation]:\n${valOutput.trim()}`);
  assert.ok(valOutput.includes("PASS"), "Code-mixed cue log must pass validate_log.py");
});

