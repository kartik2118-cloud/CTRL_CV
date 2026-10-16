"""
eval/score_sync.py: Subtitle sync checker and seek robustness validator.

Objective scoring rules (no invented combined percentage):
1. Start Time Sync Gap:
   - Median |cue.start - reference_start| <= 0.5 s -> PASS / FAIL.
2. Seek Recovery Time:
   - For every seek event: find the first cue shown after the seek that covers the new video position.
   - recovery = first_shown_at - seek_time.
   - PASS if <= 1.0 s, FAIL if more or if no cue appears.
3. Stale Cues After Seek (STALE_CUE_AFTER_SEEK):
   - Nothing from before a seek shows after it.
   - PASS if count == 0, FAIL if count > 0.
"""
import argparse
import json
import sys
from pathlib import Path
import numpy as np
import pandas as pd

# Reconfigure stdout to UTF-8
if sys.stdout.encoding != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

EVAL_DIR = Path(__file__).resolve().parent
RESULTS_DIR = EVAL_DIR / "results"


def check_sync_gap(cues: list[dict], references: list[dict]) -> dict:
    """
    Computes absolute start time gaps between cues and reference subtitles.
    Rule 1: Median gap <= 0.5 s -> PASS / FAIL.
    """
    pairs = []
    gaps = []

    match_by_order = len(cues) == len(references)

    for i, cue in enumerate(cues):
        cue_start = float(cue["start"])
        if match_by_order:
            ref = references[i]
            ref_start = float(ref["start"])
        else:
            ref = min(references, key=lambda r: abs(float(r["start"]) - cue_start))
            ref_start = float(ref["start"])

        gap = round(abs(cue_start - ref_start), 4)
        gaps.append(gap)
        pairs.append({
            "cue_index": i + 1,
            "cue_text": cue.get("text", ""),
            "cue_start": cue_start,
            "ref_start": ref_start,
            "abs_gap_seconds": gap
        })

    if not gaps:
        return {
            "pairs": [],
            "count": 0,
            "median_gap": 0.0,
            "p90_gap": 0.0,
            "rule_name": "START_TIME_SYNC_GAP",
            "passed": False,
            "status": "FAIL",
            "message": "No cues to evaluate"
        }

    gaps_arr = np.array(gaps)
    median_gap = float(np.median(gaps_arr))
    p90_gap = float(np.percentile(gaps_arr, 90))
    passed = median_gap <= 0.5

    return {
        "pairs": pairs,
        "count": len(gaps),
        "median_gap": round(median_gap, 4),
        "p90_gap": round(p90_gap, 4),
        "rule_name": "START_TIME_SYNC_GAP",
        "passed": passed,
        "status": "PASS" if passed else "FAIL",
        "message": f"Median gap = {round(median_gap, 3)}s (Target <= 0.5s)"
    }


def check_seek_events(cues: list[dict], seek_events_input) -> dict:
    """
    Evaluates:
    1. Recovery time after seek: first cue shown after seek that covers new video position.
       recovery = first_shown_at - seek_time. PASS if <= 1.0 s, FAIL if > 1.0 s or no cue.
    2. Stale cue detection: STALE_CUE_AFTER_SEEK count. PASS if count == 0, FAIL if > 0.
    """
    if isinstance(seek_events_input, dict):
        seek_events = seek_events_input.get("events", [])
    else:
        seek_events = seek_events_input

    recovery_results = []
    stale_violations = []

    for s_idx, seek in enumerate(seek_events):
        seek_id = s_idx + 1
        is_sidecar = ("wall_time" in seek or "seek_to" in seek) and ("seek_time" not in seek)
        from_v = float(seek.get("from_video_time", seek.get("seek_at", 0.0)))
        to_v = float(seek.get("to_video_time", seek.get("seek_to", 0.0)))
        is_seek_back = to_v < from_v

        if is_sidecar:
            ref_seek_time = to_v
        else:
            ref_seek_time = float(seek.get("seek_time", seek.get("seek_at_wall_time", seek.get("wall_time", 0.0))))

        # Collect cues that appeared after this seek was initiated
        post_seek_cues = []
        for c in cues:
            shown_at = float(c.get("first_shown_at", c.get("start", 0.0)))
            cue_start = float(c.get("start", 0.0))
            cue_end = float(c.get("end", cue_start + 1.0))

            if is_sidecar:
                max_valid_v_time = shown_at
                cue_is_post_seek = shown_at >= to_v
            else:
                elapsed_since_seek = shown_at - ref_seek_time
                max_valid_v_time = to_v + elapsed_since_seek
                cue_is_post_seek = shown_at >= ref_seek_time

            if cue_is_post_seek:
                # A cue is stale if:
                # 1. It belongs to the pre-seek timeline: cue_start > from_v
                # 2. On seek back: cue_start was before seek (from_v) but is ahead of current video time (max_valid_v_time)
                #    meaning it could not have been produced by post-seek audio.
                if is_seek_back and (cue_start > max_valid_v_time or cue_start > from_v):
                    stale_violations.append({
                        "seek_index": seek_id,
                        "type": "STALE_CUE_AFTER_SEEK",
                        "cue_start": cue_start,
                        "cue_end": cue_end,
                        "seek_to": to_v,
                        "first_shown_at": shown_at,
                        "message": f"Stale cue [{cue_start}s-{cue_end}s] shown at {shown_at}s (video only at {round(max_valid_v_time, 2)}s after seek back to {to_v}s)"
                    })
                elif not is_seek_back and cue_start < to_v:
                    stale_violations.append({
                        "seek_index": seek_id,
                        "type": "STALE_CUE_AFTER_SEEK",
                        "cue_start": cue_start,
                        "cue_end": cue_end,
                        "seek_to": to_v,
                        "first_shown_at": shown_at,
                        "message": f"Pre-seek cue [{cue_start}s-{cue_end}s] shown at {shown_at}s after seek forward to {to_v}s"
                    })
                else:
                    post_seek_cues.append(c)

        # Find the first cue shown after seek that covers the new video position (to_v)
        covering_cues = []
        for c in post_seek_cues:
            c_start = float(c.get("start", 0.0))
            c_end = float(c.get("end", c_start + 1.0))
            # Cue covers new position if to_v is within [start, end] or cue begins immediately at/after to_v (within 1s)
            if (c_start <= to_v <= c_end) or (0.0 <= c_start - to_v <= 1.0):
                covering_cues.append(c)

        if covering_cues:
            first_covering = min(covering_cues, key=lambda x: float(x.get("first_shown_at", float("inf"))))
            first_shown = float(first_covering.get("first_shown_at"))
            recovery = round(first_shown - ref_seek_time, 4)
            passed = recovery <= 1.0
            recovery_results.append({
                "seek_index": seek_id,
                "seek_time": ref_seek_time,
                "to_video_time": to_v,
                "first_shown_at": first_shown,
                "recovery_seconds": recovery,
                "status": "PASS" if passed else "FAIL",
                "message": f"Recovery = {recovery}s (Target <= 1.0s)"
            })
        else:
            recovery_results.append({
                "seek_index": seek_id,
                "seek_time": seek_time,
                "to_video_time": to_v,
                "first_shown_at": None,
                "recovery_seconds": None,
                "status": "FAIL",
                "message": f"No cue appeared covering new video position {to_v}s"
            })

    # Summary per rule
    recovery_all_passed = len(recovery_results) > 0 and all(r["status"] == "PASS" for r in recovery_results)
    stale_passed = len(stale_violations) == 0

    return {
        "recovery_results": recovery_results,
        "recovery_rule": {
            "rule_name": "SEEK_RECOVERY_TIME",
            "passed": recovery_all_passed,
            "status": "PASS" if recovery_all_passed else "FAIL",
            "target": "<= 1.0s"
        },
        "stale_violations": stale_violations,
        "stale_rule": {
            "rule_name": "STALE_CUE_AFTER_SEEK",
            "count": len(stale_violations),
            "passed": stale_passed,
            "status": "PASS" if stale_passed else "FAIL",
            "target": "count == 0"
        }
    }


def run_unit_tests():
    """Runs all self-tests specified by the user."""
    print("\n==========================================")
    print("Running Self-Tests (eval/score_sync.py)")
    print("==========================================")

    # 1. Baseline Sync Gap Test
    cues_sync = [
        {"start": 12.35, "end": 14.10, "text": "आज हम पनीर टिक्का बनाएंगे"},
        {"start": 15.20, "end": 17.80, "text": "यह बहुत स्वादिष्ट बनता है"},
        {"start": 20.05, "end": 22.50, "text": "इसे मध्यम आंच पर पकाएं"},
        {"start": 25.40, "end": 28.00, "text": "अब यह परोसने के लिए तैयार है"}
    ]
    refs_sync = [
        {"start": 12.40, "end": 14.10, "text": "आज हम पनीर टिक्का बनाएंगे"},
        {"start": 15.00, "end": 17.80, "text": "यह बहुत स्वादिष्ट बनता है"},
        {"start": 20.00, "end": 22.50, "text": "इसे मध्यम आंच पर पकाएं"},
        {"start": 25.10, "end": 28.00, "text": "अब यह परोसने के लिए तैयार है"}
    ]
    gap_res = check_sync_gap(cues_sync, refs_sync)
    print(f"\n[RULE: START_TIME_SYNC_GAP]")
    print(f"  Median Gap: {gap_res['median_gap']} s (Threshold: <= 0.5 s)")
    print(f"  P90 Gap   : {gap_res['p90_gap']} s")
    print(f"  Result    : {gap_res['status']}")
    assert gap_res["status"] == "PASS"

    # 2. Self-test A: cue at 0.6 s after seek -> PASS
    seek_a = [{"seek_time": 50.0, "from_video_time": 65.0, "to_video_time": 20.0}]
    cues_a = [
        {"start": 20.0, "end": 23.0, "first_shown_at": 50.6, "text": "नया सबटाइटल"}
    ]
    res_a = check_seek_events(cues_a, seek_a)
    rec_a = res_a["recovery_results"][0]
    print(f"\n[SELF-TEST A: Cue shown 0.6s after seek]")
    print(f"  Seek time = 50.0s, Cue covering 20.0s shown at = 50.6s")
    print(f"  Recovery  = {rec_a['recovery_seconds']} s")
    print(f"  Result    : {rec_a['status']}")
    assert rec_a["status"] == "PASS", f"Expected PASS for 0.6s recovery, got {rec_a['status']}"

    # 3. Self-test B: cue at 1.8 s after seek -> FAIL
    seek_b = [{"seek_time": 50.0, "from_video_time": 65.0, "to_video_time": 20.0}]
    cues_b = [
        {"start": 20.0, "end": 23.0, "first_shown_at": 51.8, "text": "देर से आया सबटाइटल"}
    ]
    res_b = check_seek_events(cues_b, seek_b)
    rec_b = res_b["recovery_results"][0]
    print(f"\n[SELF-TEST B: Cue shown 1.8s after seek]")
    print(f"  Seek time = 50.0s, Cue covering 20.0s shown at = 51.8s")
    print(f"  Recovery  = {rec_b['recovery_seconds']} s")
    print(f"  Result    : {rec_b['status']}")
    assert rec_b["status"] == "FAIL", f"Expected FAIL for 1.8s recovery, got {rec_b['status']}"

    # 4. Self-test C: Stale cue after seek -> FAIL
    seek_c = [{"seek_time": 50.0, "from_video_time": 65.0, "to_video_time": 20.0}]
    cues_c = [
        # Stale cue from pre-seek position 64.0s arrives after seek at 50.3s
        {"start": 64.0, "end": 65.0, "first_shown_at": 50.3, "text": "पुरानी टाइमलाइन का स्टेल सबटाइटल"},
        # Valid new cue
        {"start": 20.0, "end": 23.0, "first_shown_at": 50.6, "text": "नया सबटाइटल"}
    ]
    res_c = check_seek_events(cues_c, seek_c)
    stale_c = res_c["stale_rule"]
    print(f"\n[SELF-TEST C: Stale cue after seek]")
    print(f"  Stale Violations Count = {stale_c['count']}")
    for v in res_c["stale_violations"]:
        print(f"  - {v['message']}")
    print(f"  Result                 : {stale_c['status']}")
    assert stale_c["status"] == "FAIL", f"Expected FAIL for stale cue detection, got {stale_c['status']}"

    # Save summary report to results/
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    summary_csv = RESULTS_DIR / "sync_rules_test_results.csv"
    df = pd.DataFrame([
        {"rule": "START_TIME_SYNC_GAP", "metric": f"median={gap_res['median_gap']}s", "status": gap_res["status"]},
        {"rule": "SEEK_RECOVERY_TIME (0.6s test)", "metric": f"recovery={rec_a['recovery_seconds']}s", "status": rec_a["status"]},
        {"rule": "SEEK_RECOVERY_TIME (1.8s test)", "metric": f"recovery={rec_b['recovery_seconds']}s", "status": rec_b["status"]},
        {"rule": "STALE_CUE_AFTER_SEEK (stale test)", "metric": f"violations={stale_c['count']}", "status": stale_c["status"]},
    ])
    df.to_csv(summary_csv, index=False, encoding="utf-8")
    print(f"\nSaved self-test rule results to: {summary_csv}")


def main():
    parser = argparse.ArgumentParser(description="Sync Checker (Task 6)")
    parser.add_argument("--cue_log", type=str, help="Path to cue log JSON file", default=None)
    parser.add_argument("--references", type=str, help="Path to reference timestamps JSON", default=None)
    parser.add_argument("--seeks", type=str, help="Path to seek events JSON", default=None)
    parser.add_argument("--test", action="store_true", help="Run self-tests")
    parser.add_argument(
        "--output",
        type=str,
        help="Path for output CSV report",
        default=str(RESULTS_DIR / "sync_scores.csv")
    )
    args = parser.parse_args()

    # Run self-tests
    run_unit_tests()

    if args.cue_log:
        cue_p = Path(args.cue_log)
        if cue_p.exists():
            with open(cue_p, "r", encoding="utf-8") as f:
                cues = json.load(f)

            print("\n==========================================")
            print("Sync Evaluation Summary")
            print("==========================================")

            if args.references:
                ref_p = Path(args.references)
                if ref_p.exists():
                    with open(ref_p, "r", encoding="utf-8") as f:
                        refs = json.load(f)
                    gap_res = check_sync_gap(cues, refs)
                    print(f"Rule 1 [START_TIME_SYNC_GAP]: {gap_res['status']} ({gap_res['message']})")

            if args.seeks:
                seek_p = Path(args.seeks)
                if seek_p.exists():
                    with open(seek_p, "r", encoding="utf-8") as f:
                        seeks_data = json.load(f)
                    seek_res = check_seek_events(cues, seeks_data)
                    rec = seek_res["recovery_rule"]
                    stale = seek_res["stale_rule"]
                    print(f"Rule 2 [SEEK_RECOVERY_TIME]: {rec['status']} (Target {rec['target']})")
                    for r in seek_res["recovery_results"]:
                        print(f"  - Seek to {r['to_video_time']}s: {r['message']} [{r['status']}]")
                    print(f"Rule 3 [STALE_CUE_AFTER_SEEK]: {stale['status']} (Violations count={stale['count']})")
                    for v in seek_res["stale_violations"]:
                        print(f"  - [VIOLATION]: {v['message']}")


if __name__ == "__main__":
    main()
