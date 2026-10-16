"""
eval/score_accuracy.py: Accuracy scorer for Indic languages (CER) and English (WER).

Features:
- Indic-safe normalization: Preserves combining marks (matras, viramas, anusvaras) by filtering
  strictly on unicode punctuation categories ('P*') and Devanagari dandas (। and ॥).
- Evaluates CER for Indian languages (hi_in, mr_in, ta_in, te_in) and WER for English (en_us).
- Retains spaces as characters during CER computation (2 edits / 25 chars = 8.0%).
- Outputs per-language formatted summary table and saves CSV report to eval/results/.
"""
import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path
import jiwer
import pandas as pd

# Reconfigure stdout to UTF-8 for safe console output on Windows
if sys.stdout.encoding != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

INDIC_LANGS = {"hi_in", "mr_in", "ta_in", "te_in", "hi", "mr", "ta", "te"}
ENGLISH_LANGS = {"en_us", "en"}

EVAL_DIR = Path(__file__).resolve().parent
RESULTS_DIR = EVAL_DIR / "results"
DEFAULT_REF_PATH = EVAL_DIR / "data" / "references.json"


def normalize_text(text: str, is_english: bool = False) -> str:
    """
    Indic-safe normalization:
    1. Unicode NFC form.
    2. Lowercase if English.
    3. Remove punctuation characters (category starting with 'P' or dandas । and ॥).
       DO NOT use re.sub(r'[^\\w\\s]', '', text) to avoid deleting combining matras.
    4. Collapse consecutive whitespace into a single space and strip edges.
    """
    if not text:
        return ""

    # Step 1: NFC
    text = unicodedata.normalize("NFC", text)

    # Step 2: Lowercase for English
    if is_english:
        text = text.lower()

    # Step 3: Strip punctuation (Preserves 'Mn', 'Mc' combining marks)
    chars = []
    for ch in text:
        cat = unicodedata.category(ch)
        if cat.startswith("P") or ch in ("\u0964", "\u0965"):  # । and ॥
            continue
        chars.append(ch)
    cleaned = "".join(chars)

    # Step 4: Collapse whitespace
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def compute_metrics(reference: str, hypothesis: str, lang: str) -> dict:
    """
    Computes normalized CER and WER for a single pair.
    Spaces are kept as characters during CER computation.
    """
    is_en = lang.lower() in ENGLISH_LANGS
    norm_ref = normalize_text(reference, is_english=is_en)
    norm_hyp = normalize_text(hypothesis, is_english=is_en)

    ref_char_count = len(norm_ref)
    ref_word_count = len(norm_ref.split()) if norm_ref else 0

    if not norm_ref and not norm_hyp:
        wer, cer = 0.0, 0.0
    elif not norm_ref:
        wer, cer = 1.0, 1.0
    else:
        wer = jiwer.wer(norm_ref, norm_hyp)
        cer = jiwer.cer(norm_ref, norm_hyp)

    return {
        "norm_ref": norm_ref,
        "norm_hyp": norm_hyp,
        "ref_chars": ref_char_count,
        "ref_words": ref_word_count,
        "wer": wer,
        "cer": cer,
        "primary_metric": "wer" if is_en else "cer",
        "primary_score": wer if is_en else cer,
    }


def run_unit_tests():
    """
    Runs the mandated test cases:
    1. Deliberate error in Hindi: must give WER 20%, CER 8% (2 edits / 25 characters).
    2. Identical prediction: must give WER 0% and CER 0%.
    """
    print("\n==========================================")
    print("Running Self-Tests (Task 3 Validation)")
    print("==========================================")

    ref_hindi = "आज हम पनीर टिक्का बनाएंगे"
    hyp_deliberate = "आज हम पनीर टिका बनाएंगे"
    hyp_identical = "आज हम पनीर टिक्का बनाएंगे"

    # Test 1: Deliberate error
    res1 = compute_metrics(ref_hindi, hyp_deliberate, lang="hi_in")
    ref1_len = res1["ref_chars"]
    wer1_pct = round(res1["wer"] * 100, 2)
    cer1_pct = round(res1["cer"] * 100, 2)

    print("\n--- Test 1: Deliberate Error ---")
    print(f"Reference     : '{ref_hindi}'")
    print(f"Prediction    : '{hyp_deliberate}'")
    print(f"Ref Char Count: {ref1_len} (including spaces)")
    print(f"Ref Word Count: {res1['ref_words']}")
    print(f"WER           : {wer1_pct}% (Expected: 20.0%)")
    print(f"CER           : {cer1_pct}% (Expected: 8.0%)")

    assert wer1_pct == 20.0, f"Expected WER 20.0%, got {wer1_pct}%"
    assert cer1_pct == 8.0, f"Expected CER 8.0%, got {cer1_pct}%"
    print(">>> Test 1 PASSED: WER is exactly 20.0% and CER is exactly 8.0%.")

    # Test 2: Identical match
    res2 = compute_metrics(ref_hindi, hyp_identical, lang="hi_in")
    ref2_len = res2["ref_chars"]
    wer2_pct = round(res2["wer"] * 100, 2)
    cer2_pct = round(res2["cer"] * 100, 2)

    print("\n--- Test 2: Identical Prediction ---")
    print(f"Reference     : '{ref_hindi}'")
    print(f"Prediction    : '{hyp_identical}'")
    print(f"Ref Char Count: {ref2_len} (including spaces)")
    print(f"WER           : {wer2_pct}% (Expected: 0.0%)")
    print(f"CER           : {cer2_pct}% (Expected: 0.0%)")

    assert wer2_pct == 0.0, f"Expected WER 0.0%, got {wer2_pct}%"
    assert cer2_pct == 0.0, f"Expected CER 0.0%, got {cer2_pct}%"
    print(">>> Test 2 PASSED: Both WER and CER are 0.0%.")

    # Test 3: Devanagari dandas and punctuation removal
    ref_punct = "आज हम, पनीर टिक्का! बनाएंगे। क्या आप भी? ॥"
    norm_punct = normalize_text(ref_punct, is_english=False)
    print(f"\n--- Test 3: Punctuation & Danda Removal ---")
    print(f"Original  : '{ref_punct}'")
    print(f"Normalized: '{norm_punct}'")
    assert "।" not in norm_punct and "॥" not in norm_punct
    assert "," not in norm_punct and "!" not in norm_punct and "?" not in norm_punct
    print(">>> Test 3 PASSED: All punctuation and dandas successfully removed without harming matras.")

    # Save test verification results to CSV
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    test_results_csv = RESULTS_DIR / "accuracy_test_results.csv"
    df_tests = pd.DataFrame(
        [
            {
                "test_name": "Deliberate Error (Hindi)",
                "ref_chars": ref1_len,
                "wer_percent": wer1_pct,
                "cer_percent": cer1_pct,
                "status": "PASSED",
            },
            {
                "test_name": "Identical Match (Hindi)",
                "ref_chars": ref2_len,
                "wer_percent": wer2_pct,
                "cer_percent": cer2_pct,
                "status": "PASSED",
            },
        ]
    )
    df_tests.to_csv(test_results_csv, index=False, encoding="utf-8")
    print(f"\nSaved self-test verification to: {test_results_csv}")


def score_predictions(predictions_path: Path, references_path: Path, output_csv: Path):
    """Evaluates a full predictions JSON against references.json and outputs report."""
    with open(references_path, "r", encoding="utf-8") as f:
        refs_data = json.load(f)

    with open(predictions_path, "r", encoding="utf-8") as f:
        preds_data = json.load(f)

    # Normalize predictions into dict id -> text
    preds_map = {}
    if isinstance(preds_data, list):
        for item in preds_data:
            cid = item.get("id")
            text = item.get("text") or item.get("transcription") or ""
            if cid:
                preds_map[cid] = text
    elif isinstance(preds_data, dict):
        for cid, val in preds_data.items():
            if isinstance(val, dict):
                preds_map[cid] = val.get("text") or val.get("transcription") or ""
            else:
                preds_map[cid] = str(val)

    rows = []
    for ref_item in refs_data:
        cid = ref_item["id"]
        lang = ref_item["language"]
        ref_text = ref_item["transcription"]
        pred_text = preds_map.get(cid, "")

        metrics = compute_metrics(ref_text, pred_text, lang)
        rows.append(
            {
                "id": cid,
                "language": lang,
                "ref_chars": metrics["ref_chars"],
                "ref_words": metrics["ref_words"],
                "wer": round(metrics["wer"] * 100, 2),
                "cer": round(metrics["cer"] * 100, 2),
                "primary_metric": metrics["primary_metric"].upper(),
                "primary_score": round(metrics["primary_score"] * 100, 2),
                "reference": metrics["norm_ref"],
                "hypothesis": metrics["norm_hyp"],
            }
        )

    df = pd.DataFrame(rows)
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    df.to_csv(output_csv, index=False, encoding="utf-8")

    # Aggregate summary by language
    summary = []
    for lang, group in df.groupby("language"):
        is_en = lang in ENGLISH_LANGS
        metric_name = "WER" if is_en else "CER"
        score = group["wer"].mean() if is_en else group["cer"].mean()
        summary.append(
            {
                "Language": lang,
                "Metric": metric_name,
                "Average Score (%)": round(score, 2),
                "Clips": len(group),
            }
        )

    summary_df = pd.DataFrame(summary)
    print("\n==========================================")
    print("Accuracy Scoring Summary Table")
    print("==========================================")
    print(summary_df.to_string(index=False))
    print(f"\nDetailed per-clip results saved to: {output_csv}")


def main():
    parser = argparse.ArgumentParser(description="Accuracy Scorer (Task 3)")
    parser.add_argument("--predictions", type=str, help="Path to predictions JSON file", default=None)
    parser.add_argument("--references", type=str, help="Path to references JSON file", default=str(DEFAULT_REF_PATH))
    parser.add_argument("--test", action="store_true", help="Run self-tests with mandated Indic test cases")
    parser.add_argument(
        "--output",
        type=str,
        help="Path for output CSV report",
        default=str(RESULTS_DIR / "accuracy_scores.csv"),
    )
    args = parser.parse_args()

    # Always run the mandated unit tests to verify normalization accuracy
    run_unit_tests()

    # If predictions file provided or exists, run evaluation
    if args.predictions:
        preds_p = Path(args.predictions)
        refs_p = Path(args.references)
        out_p = Path(args.output)
        if preds_p.exists() and refs_p.exists():
            score_predictions(preds_p, refs_p, out_p)
        else:
            print(f"\nWarning: Files not found. Predictions: {preds_p.exists()}, References: {refs_p.exists()}")


if __name__ == "__main__":
    main()
