"""
eval/score_translation.py: Translation quality scorer using sacrebleu chrF.

Features:
- Computes chrF score against English reference translations.
- Per-language breakdown and overall corpus chrF score.
- Self-tests verifying:
    - Identical hypothesis matches: chrF == 100.0 (or ~100.0)
    - Unrelated hypothesis: chrF is low (< 25.0)
"""
import argparse
import json
import sys
from pathlib import Path
import sacrebleu
import pandas as pd

# Reconfigure stdout to UTF-8
if sys.stdout.encoding != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

EVAL_DIR = Path(__file__).resolve().parent
RESULTS_DIR = EVAL_DIR / "results"
DEFAULT_REF_PATH = EVAL_DIR / "data" / "references.json"


def compute_chrf_score(hypotheses: list[str], references: list[str]) -> float:
    """Computes corpus-level chrF score using sacrebleu."""
    if not hypotheses or not references:
        return 0.0
    res = sacrebleu.corpus_chrf(hypotheses, [references])
    return round(float(res.score), 2)


def evaluate_translations(records: list[dict]) -> dict:
    """
    Evaluates translation records.
    Each record must have: 'id', 'language', 'reference', 'hypothesis'.
    Returns per-language scores and overall corpus score.
    """
    df = pd.DataFrame(records)
    if df.empty:
        return {"overall_chrf": 0.0, "languages": {}, "records": []}

    # Sentence-level chrF for each row
    sent_scores = []
    for _, row in df.iterrows():
        score = sacrebleu.sentence_chrf(row["hypothesis"], [row["reference"]]).score
        sent_scores.append(round(float(score), 2))
    df["chrf"] = sent_scores

    # Per-language corpus chrF
    per_lang = []
    for lang, group in df.groupby("language"):
        hyps = group["hypothesis"].tolist()
        refs = group["reference"].tolist()
        lang_chrf = compute_chrf_score(hyps, refs)
        per_lang.append({
            "Language": lang,
            "Metric": "chrF",
            "Corpus Score": lang_chrf,
            "Sample Count": len(group)
        })

    overall_chrf = compute_chrf_score(df["hypothesis"].tolist(), df["reference"].tolist())
    lang_summary_df = pd.DataFrame(per_lang)

    return {
        "overall_chrf": overall_chrf,
        "lang_summary": lang_summary_df,
        "details_df": df
    }


def run_unit_tests():
    """Runs self-test: identical = 100, unrelated = low, per-language and overall."""
    print("\n==========================================")
    print("Running Self-Tests (eval/score_translation.py)")
    print("==========================================")

    # Reference English translations across different source languages
    sample_dataset = [
        {"id": "hi_1", "language": "hi_in", "reference": "Today we will make paneer tikka."},
        {"id": "hi_2", "language": "hi_in", "reference": "Greenland was settled in very few places according to Norse sagas."},
        {"id": "mr_1", "language": "mr_in", "reference": "The weather today is cloudy with light rain expected in the evening."},
        {"id": "ta_1", "language": "ta_in", "reference": "This is known in chemistry as pH, which indicates acidity."},
        {"id": "te_1", "language": "te_in", "reference": "The project was launched with great enthusiasm across the state."},
        {"id": "en_1", "language": "en_us", "reference": "Some molecules have unstable nuclei which tend to decay."}
    ]

    # Test 1: Identical hypotheses (expected chrF = 100.0)
    identical_records = []
    for item in sample_dataset:
        identical_records.append({
            "id": item["id"],
            "language": item["language"],
            "reference": item["reference"],
            "hypothesis": item["reference"]  # exact same string
        })

    res_ident = evaluate_translations(identical_records)
    print("\n--- Test 1: Identical Translations ---")
    print(res_ident["lang_summary"].to_string(index=False))
    print(f"\nOverall Corpus chrF: {res_ident['overall_chrf']}")

    assert res_ident["overall_chrf"] == 100.0, f"Expected 100.0, got {res_ident['overall_chrf']}"
    for _, r in res_ident["lang_summary"].iterrows():
        assert r["Corpus Score"] == 100.0, f"Expected 100.0 for {r['Language']}, got {r['Corpus Score']}"
    print(">>> Test 1 PASSED: Identical translations give exactly 100.0 chrF across all languages.")

    # Test 2: Unrelated hypotheses (expected chrF = low)
    unrelated_pool = [
        "Completely different statement about cooking recipes.",
        "A random sentence discussing astrophysics in deep outer space.",
        "Stock markets fluctuated wildly during morning trading sessions.",
        "The football team won their final match by three goals.",
        "Ancient Egyptian pyramids were built thousands of years ago.",
        "Fresh coffee beans should be stored in an airtight container."
    ]
    unrelated_records = []
    for idx, item in enumerate(sample_dataset):
        unrelated_records.append({
            "id": item["id"],
            "language": item["language"],
            "reference": item["reference"],
            "hypothesis": unrelated_pool[idx]
        })

    res_unrel = evaluate_translations(unrelated_records)
    print("\n--- Test 2: Unrelated Translations ---")
    print(res_unrel["lang_summary"].to_string(index=False))
    print(f"\nOverall Corpus chrF: {res_unrel['overall_chrf']}")

    assert res_unrel["overall_chrf"] < 25.0, f"Expected low chrF (< 25.0), got {res_unrel['overall_chrf']}"
    print(f">>> Test 2 PASSED: Unrelated translations give low chrF ({res_unrel['overall_chrf']}).")

    # Test 3: Identical-as-hypothesis test on real references.json (Task 2)
    if DEFAULT_REF_PATH.exists():
        with open(DEFAULT_REF_PATH, "r", encoding="utf-8") as f:
            real_refs = json.load(f)

        real_records = []
        for r in real_refs:
            cid = str(r["id"])
            lang = r["language"]
            if lang in ("en_us", "en"):
                ref_text = r.get("transcription") or r.get("text", "")
            else:
                ref_text = r.get("en_reference") or r.get("english_reference") or r.get("translation", "")

            if ref_text:
                real_records.append({
                    "id": cid,
                    "language": lang,
                    "reference": ref_text,
                    "hypothesis": ref_text  # identical
                })

        if real_records:
            res_real = evaluate_translations(real_records)
            print("\n--- Test 3: Identical-as-Hypothesis on FLEURS references.json (50 clips) ---")
            print(res_real["lang_summary"].to_string(index=False))
            print(f"\nOverall Corpus chrF: {res_real['overall_chrf']}")
            assert res_real["overall_chrf"] == 100.0, f"Expected 100.0, got {res_real['overall_chrf']}"
            for _, r in res_real["lang_summary"].iterrows():
                assert r["Corpus Score"] == 100.0, f"Expected 100.0 for {r['Language']}, got {r['Corpus Score']}"
            print(">>> Test 3 PASSED: Identical-as-hypothesis gives 100.0 chrF across all 5 FLEURS languages.")

    # Save test verification results
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    out_csv = RESULTS_DIR / "translation_test_results.csv"
    test_summary = pd.DataFrame([
        {"test_name": "Identical Translations", "overall_chrf": res_ident["overall_chrf"], "status": "PASS"},
        {"test_name": "Unrelated Translations", "overall_chrf": res_unrel["overall_chrf"], "status": "PASS"},
    ])
    test_summary.to_csv(out_csv, index=False, encoding="utf-8")
    print(f"\nSaved self-test verification to: {out_csv}")


def score_from_files(preds_path: Path, refs_path: Path, output_csv: Path):
    """Evaluates translations from prediction / cue log file against references.json."""
    with open(refs_path, "r", encoding="utf-8") as f:
        refs_raw = json.load(f)

    with open(preds_path, "r", encoding="utf-8") as f:
        preds_raw = json.load(f)

    # Normalize predictions map
    hyp_map = {}
    if isinstance(preds_raw, list):
        for p in preds_raw:
            pid = p.get("id") or p.get("chunk_id")
            text = p.get("translation") or p.get("text") or ""
            if pid is not None:
                hyp_map[str(pid)] = text
    elif isinstance(preds_raw, dict):
        for pid, val in preds_raw.items():
            if isinstance(val, dict):
                hyp_map[str(pid)] = val.get("translation") or val.get("text") or ""
            else:
                hyp_map[str(pid)] = str(val)

    records = []
    for r in refs_raw:
        cid = str(r["id"])
        lang = r["language"]
        # English reference: use en_reference for hi/mr/ta/te and text (transcription) for en
        if lang in ("en_us", "en"):
            ref_text = r.get("transcription") or r.get("text", "")
        else:
            ref_text = r.get("en_reference") or r.get("english_reference") or r.get("translation", "")

        hyp_text = hyp_map.get(cid, "")
        if ref_text:
            records.append({
                "id": cid,
                "language": lang,
                "reference": ref_text,
                "hypothesis": hyp_text
            })

    if not records:
        print("\nNo matching English reference pairs found to score.")
        return

    res = evaluate_translations(records)
    print("\n==========================================")
    print("Translation Evaluation Summary (chrF)")
    print("==========================================")
    print(res["lang_summary"].to_string(index=False))
    print(f"\nOverall Corpus chrF: {res['overall_chrf']}")

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    res["details_df"].to_csv(output_csv, index=False, encoding="utf-8")
    print(f"Saved detailed translation scores to: {output_csv}")


def main():
    parser = argparse.ArgumentParser(description="Translation chrF Scorer (Task 5)")
    parser.add_argument("--predictions", type=str, help="Path to predictions / cue log JSON", default=None)
    parser.add_argument("--references", type=str, help="Path to references JSON", default=str(DEFAULT_REF_PATH))
    parser.add_argument("--test", action="store_true", help="Run self-tests")
    parser.add_argument(
        "--output",
        type=str,
        help="Path for output CSV report",
        default=str(RESULTS_DIR / "translation_scores.csv")
    )
    args = parser.parse_args()

    # Always execute self-tests
    run_unit_tests()

    if args.predictions:
        p_path = Path(args.predictions)
        r_path = Path(args.references)
        if p_path.exists() and r_path.exists():
            score_from_files(p_path, r_path, Path(args.output))
        else:
            print(f"File not found. Predictions: {p_path.exists()}, References: {r_path.exists()}")


if __name__ == "__main__":
    main()
