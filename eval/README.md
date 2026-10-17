# Evaluation & Validation Harness (Role D)

This directory provides validation tools, regression tests, and benchmarking scripts for the audio capture and timing synchronization pipeline.

---

## Script Index & Usage Instructions

### 1. `check_audio_chunks.py`
- **Purpose:** CLI validator that checks JSONL diagnostic streams against [`docs/audio-chunk-contract.md`](../docs/audio-chunk-contract.md).
- **Checks:** Finite numbers, 16000 Hz mono types, 1600-sample full chunks, duration math, epoch duplicate IDs, and video span formulas ($\Delta t_{\text{video}} = \Delta t_{\text{audio}} \times \text{playback\_rate}$).
- **Usage:**
  ```bash
  python eval/check_audio_chunks.py path/to/log.jsonl --output-report eval/results/report.json
  ```
- **Exit Code:** `0` on clean pass; `1` on error.

### 2. `test_audio_chunks.py`
- **Purpose:** Unit and regression test suite for `check_audio_chunks.py` using clearly labeled synthetic test fixtures.
- **Usage:**
  ```bash
  python eval/test_audio_chunks.py
  ```
- **Report Saved:** `eval/results/test_audio_chunks_report.json`

### 3. `resampler.py`
- **Purpose:** Python reference implementation of the stateful anti-aliased resampler (10th-order Butterworth low-pass filter at 6800 Hz + cubic Hermite interpolation) and the 1600-sample chunk accumulator.
- **Used by:** `test_audio_processing.py` and `benchmark_timing_sync.py`.

### 4. `test_audio_processing.py`
- **Purpose:** Signal processing verification suite testing synthetic silence, mono tones, stereo downmixing, multiple sample rates (16k, 44.1k, 48k), variable block lengths, chunk boundary continuity, partial flush, and above-Nyquist alias suppression.
- **Usage:**
  ```bash
  python eval/test_audio_processing.py
  ```
- **Report Saved:** `eval/results/audio_processing_report.json`

### 5. `sync_coordinator.py`
- **Purpose:** Video timing coordinator module associating audio sample positions with content-script page-state video anchors using the formula:
  $$t_{\text{video}} = \text{chunk\_video\_start} + \text{offset\_in\_chunk\_s} \times \text{playback\_rate}$$
- **Used by:** `test_video_timing.py` and `benchmark_timing_sync.py`.

### 6. `test_video_timing.py`
- **Purpose:** Unit test suite verifying rate mapping (1.0x, 1.5x, 2.0x), seek forward/backward, rate changes during partial chunks, pause/resume gating, stale message rejection, SPA navigation, and validator compliance.
- **Usage:**
  ```bash
  python eval/test_video_timing.py
  ```
- **Report Saved:** `eval/results/timing_verification_report.json`

### 7. `benchmark_timing_sync.py`
- **Purpose:** Reproducible timing accuracy benchmark using a local synthetic audio fixture with known pulse markers placed at exact video timestamps to measure real timing error in milliseconds without downloading YouTube media.
- **Usage:**
  ```bash
  python eval/benchmark_timing_sync.py
  ```
- **Report Saved:** `eval/results/timing_accuracy_benchmark.json`

### 8. `test_worklet_node.js`
- **Purpose:** Node.js test harness that loads and executes `extension/audio-processor.js` directly in a mocked AudioWorklet environment to verify JavaScript execution, downmixing, chunk emission, and metadata calculations.
- **Usage:**
  ```bash
  node eval/test_worklet_node.js
  ```

### 9. `generate_mock_session.py`
- **Purpose:** End-to-end multi-state session simulator generating continuous 1.0x playback, speed changes (1.5x), pause/resume gating, backward seeking, and YouTube SPA navigation into `eval/results/demo_session_diagnostics.jsonl` and validating it.
- **Usage:**
  ```bash
  python eval/generate_mock_session.py
  ```


### 10. `test_subtitle_overlay.py`
- **Purpose:** Unit test suite verifying subtitle overlay cue timeline synchronization, active cue detection, time span gaps, seek reset clearance, and dual-language text attributes.
- **Usage:**
  ```bash
  python eval/test_subtitle_overlay.py
  ```

---

## Part II: Upstream Scoring & Evaluation Suite (Role D Tasks T0–T8)

These tools are pulled directly from the official project repository (`https://github.com/kartik2118-cloud/CTRL_CV`) for judging acceptance, cue log validation, and scoring:

### 11. `validate_log.py`
- **Purpose:** Validates exported cue logs against the official strict 8-field JSON schema (`docs/cue_log.schema.json`).
- **Self-Tests:**
  ```bash
  python eval/validate_log.py --test
  ```
- **File Validation:**
  ```bash
  python eval/validate_log.py path/to/cue_log.json
  ```

### 12. `syncEngine.test.mjs` (`sync/`)
- **Purpose:** 24 unit tests verifying cache retention, epoch invalidation, seek-back 0s recovery (D1), code-mixed sidecars (D2), late-cue 2.0s hold, and ad boundary isolation.
- **Usage:**
  ```bash
  node --test sync/syncEngine.test.mjs
  ```

### 13. `judge_sim.mjs`
- **Purpose:** Acceptance test simulating the exact judge playback scenario (play, pause, seek forward, seek backward, speed changes) and evaluating all 11 rubric items.
- **Usage:**
  ```bash
  node eval/judge_sim.mjs
  ```

### 14. `score_latency.py` & `score_sync.py`
- **Purpose:** Calculates lag (`first_shown_at - end`), median sync gap, and seek-back recovery. Requires Python packages in `eval/requirements.txt` (set up with `eval/setup.ps1`).
- **Self-Tests:**
  ```bash
  python eval/score_latency.py --test
  python eval/score_sync.py --test
  ```

### 15. `score_accuracy.py` & `score_translation.py`
- **Purpose:** CER/WER text accuracy scorer and sacrebleu chrF translation scorer for Indic language test clips.

---

## Test Execution Commands

### Audio Capture Spike Suite (37 tests):
```bash
python eval/test_audio_chunks.py ; python eval/test_audio_processing.py ; python eval/test_video_timing.py ; python eval/benchmark_timing_sync.py ; node eval/test_worklet_node.js ; python eval/test_subtitle_overlay.py
```

### Upstream Sync Engine Suite (24 tests):
```bash
node --test sync/syncEngine.test.mjs
```

### Cue Log Validator Self-Test:
```bash
python eval/validate_log.py --test
```

