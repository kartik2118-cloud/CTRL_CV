"""
eval/start_jitter_eval.py: Start-Time Jitter & Bias Sensitivity Simulator (Task T6 & F3 - Decision D5).

Simulates:
1. Symmetric Jitter: Chunk-boundary vs VAD jitter (+-0.0s, +-0.2s, +-0.5s, +-1.0s, +-2.0s) on cue.start.
2. Constant Bias: Systematic late offset (+0.3s, +0.6s, +1.0s) due to buffering/framing.
3. Chunk-Boundary Snap: cue.start snapped to 1s chunk start while speech onset is random (0-1s).

Evaluates START_TIME_SYNC_GAP (median and p90 gap) against ground-truth references.
"""
import argparse
import json
import sys
from pathlib import Path
import numpy as np

# Reconfigure stdout to UTF-8
if sys.stdout.encoding != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

EVAL_DIR = Path(__file__).resolve().parent
RESULTS_DIR = EVAL_DIR / "results"
DEFAULT_REF_PATH = EVAL_DIR / "data" / "references.json"
SAMPLE_LOG_PATH = EVAL_DIR / "sample_cue_log_fleurs.json"


def load_ground_truth_references() -> list[dict]:
    """Loads ground-truth speech references with start/end timestamps."""
    if DEFAULT_REF_PATH.exists():
        with open(DEFAULT_REF_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            if isinstance(data, list) and len(data) > 0:
                refs = []
                for idx, r in enumerate(data):
                    start = float(r.get("start", idx * 3.5 + 0.5))
                    end = float(r.get("end", start + 3.0))
                    refs.append({
                        "id": r.get("id", idx + 1),
                        "start": start,
                        "end": end,
                        "text": r.get("text", f"Sentence {idx + 1}")
                    })
                return refs

    if SAMPLE_LOG_PATH.exists():
        with open(SAMPLE_LOG_PATH, "r", encoding="utf-8") as f:
            sample = json.load(f)
            return [{"start": float(c["start"]), "end": float(c["end"]), "text": c.get("text", "")} for c in sample]

    refs = []
    t = 0.5
    for i in range(30):
        dur = 2.5 + (i % 5) * 0.3
        refs.append({"start": round(t, 2), "end": round(t + dur, 2), "text": f"Reference cue {i + 1}"})
        t += dur + 0.8
    return refs


def evaluate_jitter(references: list[dict], jitter_sec: float, rng_seed: int = 42) -> dict:
    """Applies simulated +-jitter to cue.start and evaluates START_TIME_SYNC_GAP."""
    rng = np.random.default_rng(rng_seed)
    gaps = []
    for ref in references:
        ref_start = float(ref["start"])
        offset = 0.0 if jitter_sec == 0.0 else float(rng.uniform(-jitter_sec, jitter_sec))
        cue_start = max(0.0, round(ref_start + offset, 3))
        gaps.append(round(abs(cue_start - ref_start), 4))

    gaps_arr = np.array(gaps)
    median_gap = float(np.median(gaps_arr))
    p90_gap = float(np.percentile(gaps_arr, 90))
    passed = median_gap <= 0.5

    return {
        "scenario": f"Jitter +- {jitter_sec:.1f}s",
        "median_gap": round(median_gap, 3),
        "p90_gap": round(p90_gap, 3),
        "status": "PASS" if passed else "FAIL",
        "mode": "SIMULATED"
    }


def evaluate_bias(references: list[dict], bias_sec: float) -> dict:
    """Applies constant positive bias to cue.start."""
    gaps = []
    for ref in references:
        ref_start = float(ref["start"])
        cue_start = max(0.0, round(ref_start + bias_sec, 3))
        gaps.append(round(abs(cue_start - ref_start), 4))

    gaps_arr = np.array(gaps)
    median_gap = float(np.median(gaps_arr))
    p90_gap = float(np.percentile(gaps_arr, 90))
    passed = median_gap <= 0.5

    return {
        "scenario": f"Constant bias +{bias_sec:.1f}s",
        "median_gap": round(median_gap, 3),
        "p90_gap": round(p90_gap, 3),
        "status": "PASS" if passed else "FAIL",
        "mode": "SIMULATED"
    }


def evaluate_chunk_boundary(references: list[dict], chunk_duration: float = 1.0, rng_seed: int = 42) -> dict:
    """
    Simulates snapping cue.start to chunk boundary while speech onset is random (0-1s after boundary).
    """
    rng = np.random.default_rng(rng_seed)
    gaps = []
    for _ in references:
        offset = float(rng.uniform(0.0, chunk_duration))
        gaps.append(round(offset, 4))

    gaps_arr = np.array(gaps)
    median_gap = float(np.median(gaps_arr))
    p90_gap = float(np.percentile(gaps_arr, 90))
    passed = median_gap <= 0.5

    return {
        "scenario": f"Chunk-boundary snap (onset 0-{chunk_duration:.0f}s)",
        "median_gap": round(median_gap, 3),
        "p90_gap": round(p90_gap, 3),
        "status": "PASS" if passed else "FAIL",
        "mode": "SIMULATED"
    }


def main():
    print("==========================================================================================")
    print("START-TIME SYNC GAP SENSITIVITY: JITTER, BIAS & CHUNK SNAP (Task T6 & F3)")
    print("==========================================================================================")
    print("Rule: START_TIME_SYNC_GAP = |cue.start - reference_start|")
    print("Official Threshold: Median gap <= 0.5s\n")

    references = load_ground_truth_references()
    print(f"Loaded {len(references)} ground-truth speech reference intervals.\n")

    results = []

    # 1. Symmetric Jitter scenarios
    for j in [0.0, 0.2, 0.5, 1.0, 2.0]:
        results.append(evaluate_jitter(references, j))

    # 2. Constant Bias scenarios (F3)
    for b in [0.3, 0.6, 1.0]:
        results.append(evaluate_bias(references, b))

    # 3. Chunk-boundary snap scenario (F3)
    results.append(evaluate_chunk_boundary(references, chunk_duration=1.0))

    print("==========================================================================================")
    print("SYNC GAP SENSITIVITY TABLE (SIMULATED)")
    print("==========================================================================================")
    print("| Scenario / Condition | Median Gap (s) | P90 Gap (s) | Status | Official Target | Mode |")
    print("|----------------------|----------------|-------------|--------|-----------------|------|")
    for r in results:
        print(f"| {r['scenario']:<40} | {r['median_gap']:.3f}s | {r['p90_gap']:.3f}s | {r['status']:<4} | <= 0.5s | {r['mode']} |")
    print("==========================================================================================\n")

    print("------------------------------------------------------------------------------------------")
    print("ENGINEERING GUIDANCE FOR TEAM C (STT / VAD BACKEND):")
    print("1. Jitter <= +-0.2s: Median gap ~0.106s -> PASS with comfortable headroom.")
    print("2. Constant bias +0.3s: Median gap = 0.300s -> PASS (buffer delay margin).")
    print("3. Constant bias +0.6s or +1.0s: Median gap = 0.600s / 1.000s -> FAIL (> 0.5s threshold).")
    print("4. Chunk-boundary snap (no VAD onset): Median gap ~0.495s, P90 ~0.892s -> BORDERLINE / RISKY.")
    print("-> Recommendation for Team C: Backend must return speech-relative start offsets (VAD / word")
    print("   timestamps) rather than snapping cue.start to the raw 1s audio chunk boundary.")
    print("------------------------------------------------------------------------------------------")

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    out_file = RESULTS_DIR / "start_jitter_sensitivity.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)


if __name__ == "__main__":
    main()
