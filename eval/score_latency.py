"""
eval/score_latency.py: Latency scorer based on exported cue logs.

Definition:
- Lag = first_shown_at - end (all in video seconds).
- Computes median lag and 90th percentile (p90) lag.
- Scoring:
    - Full marks (1.0 or 100%) if median <= 3.0 s and p90 <= 5.0 s.
    - Zero marks (0.0 or 0%) if median >= 6.0 s or p90 >= 10.0 s.
    - Linear interpolation between boundaries on the worse of the two.
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


def compute_linear_score(val: float, full_threshold: float, zero_threshold: float) -> float:
    """Computes linear score between full marks and zero marks (worse is higher val)."""
    if val <= full_threshold:
        return 1.0
    if val >= zero_threshold:
        return 0.0
    return (zero_threshold - val) / (zero_threshold - full_threshold)


def evaluate_latency(cues: list[dict]) -> dict:
    """
    Evaluates latency from cue log entries.
    Returns dictionary with lags, median, p90, and final scores.
    """
    records = []
    lags = []

    for idx, cue in enumerate(cues):
        start = cue.get("start")
        end = cue.get("end")
        shown = cue.get("first_shown_at")
        text = cue.get("text", "")

        if end is not None and shown is not None:
            lag = round(float(shown) - float(end), 4)
            lags.append(lag)
            records.append({
                "cue_index": idx + 1,
                "text": text,
                "start": start,
                "end": end,
                "first_shown_at": shown,
                "lag_seconds": lag
            })

    if not lags:
        return {
            "records": [],
            "count": 0,
            "median": 0.0,
            "p90": 0.0,
            "score_median": 0.0,
            "score_p90": 0.0,
            "final_score": 0.0,
            "final_score_pct": 0.0
        }

    lags_arr = np.array(lags)
    median_lag = float(np.median(lags_arr))
    p90_lag = float(np.percentile(lags_arr, 90))

    score_med = compute_linear_score(median_lag, full_threshold=3.0, zero_threshold=6.0)
    score_p90 = compute_linear_score(p90_lag, full_threshold=5.0, zero_threshold=10.0)
    final_score = min(score_med, score_p90)

    return {
        "records": records,
        "count": len(lags),
        "median": round(median_lag, 3),
        "p90": round(p90_lag, 3),
        "score_median": round(score_med, 4),
        "score_p90": round(score_p90, 4),
        "final_score": round(final_score, 4),
        "final_score_pct": round(final_score * 100, 2)
    }


def run_unit_tests():
    """Runs test using the problem example and edge cases."""
    print("\n==========================================")
    print("Running Self-Tests (Task 4 Latency)")
    print("==========================================")

    # Example from problem statement:
    # Speech 1: 12.40-14.10 shown at 16.30 -> lag = 2.20 s
    # Speech 2: 15.00-17.80 shown at 22.95 -> lag = 5.15 s
    test_cues = [
        {
            "start": 12.40,
            "end": 14.10,
            "text": "आज हम पनीर टिक्का बनाएंगे",
            "first_shown_at": 16.30
        },
        {
            "start": 15.00,
            "end": 17.80,
            "text": "यह बहुत स्वादिष्ट बनता है",
            "first_shown_at": 22.95
        }
    ]

    res = evaluate_latency(test_cues)
    print("\nTest Case (Problem Examples):")
    for r in res["records"]:
        print(f"  Cue {r['cue_index']}: speech {r['start']:.2f}-{r['end']:.2f} s, shown at {r['first_shown_at']:.2f} s -> lag = {r['lag_seconds']:.2f} s")

    # Verify individual lag calculations
    assert abs(res["records"][0]["lag_seconds"] - 2.20) < 1e-4, f"Expected 2.20, got {res['records'][0]['lag_seconds']}"
    assert abs(res["records"][1]["lag_seconds"] - 5.15) < 1e-4, f"Expected 5.15, got {res['records'][1]['lag_seconds']}"
    print(">>> Individual lag verification: PASSED (2.20 s and 5.15 s match exactly)")

    print(f"\nAggregates for test cues:")
    print(f"  Count        : {res['count']}")
    print(f"  Median Lag   : {res['median']} s")
    print(f"  P90 Lag      : {res['p90']} s")
    print(f"  Score Median : {res['score_median'] * 100:.1f}%")
    print(f"  Score P90    : {res['score_p90'] * 100:.1f}%")
    print(f"  Final Score  : {res['final_score_pct']}% (worse of the two)")

    # Boundary tests
    # Full marks test: median <= 3.0 and p90 <= 5.0
    perfect_cues = [
        {"start": 10.0, "end": 12.0, "first_shown_at": 14.0}, # lag 2.0
        {"start": 13.0, "end": 15.0, "first_shown_at": 17.5}, # lag 2.5
    ]
    res_perf = evaluate_latency(perfect_cues)
    assert res_perf["final_score_pct"] == 100.0, f"Expected 100.0%, got {res_perf['final_score_pct']}%"
    print("\n>>> Perfect Latency Test (lags 2.0s, 2.5s): PASSED -> 100.0% score")

    # Zero marks test: median >= 6.0 or p90 >= 10.0
    zero_cues = [
        {"start": 10.0, "end": 12.0, "first_shown_at": 19.0}, # lag 7.0
        {"start": 13.0, "end": 15.0, "first_shown_at": 26.0}, # lag 11.0
    ]
    res_zero = evaluate_latency(zero_cues)
    assert res_zero["final_score_pct"] == 0.0, f"Expected 0.0%, got {res_zero['final_score_pct']}%"
    print(">>> Zero Latency Test (lags 7.0s, 11.0s): PASSED -> 0.0% score")

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    csv_path = RESULTS_DIR / "latency_test_results.csv"
    df = pd.DataFrame(res["records"])
    df.to_csv(csv_path, index=False, encoding="utf-8")
    print(f"\nSaved test results to: {csv_path}")


def main():
    parser = argparse.ArgumentParser(description="Latency Scorer (Task 4)")
    parser.add_argument("--cue_log", type=str, help="Path to cue log JSON file", default=None)
    parser.add_argument("--test", action="store_true", help="Run self-tests with example cases")
    parser.add_argument(
        "--output",
        type=str,
        help="Path for output CSV report",
        default=str(RESULTS_DIR / "latency_scores.csv")
    )
    args = parser.parse_args()

    # Run self tests by default or on --test
    run_unit_tests()

    if args.cue_log:
        cue_log_path = Path(args.cue_log)
        if cue_log_path.exists():
            with open(cue_log_path, "r", encoding="utf-8") as f:
                cues = json.load(f)
            results = evaluate_latency(cues)
            print("\n==========================================")
            print("Cue Log Latency Evaluation")
            print("==========================================")
            print(f"Total Cues   : {results['count']}")
            print(f"Median Lag   : {results['median']} s (Target: <= 3.0 s)")
            print(f"P90 Lag      : {results['p90']} s (Target: <= 5.0 s)")
            print(f"Median Score : {results['score_median'] * 100:.1f}%")
            print(f"P90 Score    : {results['score_p90'] * 100:.1f}%")
            print(f"Final Score  : {results['final_score_pct']}%")

            out_p = Path(args.output)
            RESULTS_DIR.mkdir(parents=True, exist_ok=True)
            df = pd.DataFrame(results["records"])
            df.to_csv(out_p, index=False, encoding="utf-8")
            print(f"Saved evaluation results to: {out_p}")
        else:
            print(f"\nError: Cue log not found at {cue_log_path}")


if __name__ == "__main__":
    main()
