"""
eval/run_all.py: Batch evaluation harness across FLEURS test clips with concurrency & realtime support.

Features:
- Reads clips from eval/data/references.json.
- Filters by --langs (comma-separated, e.g. 'hi,mr') and --max_clips.
- Streams clips to WebSocket backend with configurable concurrency (--concurrency N, default 2).
- Realtime streaming simulation (--realtime) or fast streaming (--fast).
- Aggregates predictions into eval/results/predictions_{engine_label}.json.
- Evaluates:
    - Accuracy: CER for Indic languages (hi, mr, ta, te) and WER for English (en).
    - Translation: chrF score against English references (en_reference for Indic, transcription for en).
    - Latency: Median lag, P90 lag, and latency scoring.
- Outputs clean formatted table per language and overall summary.
- Exports summary CSV to eval/results/summary_{engine_label}.csv.
"""
import argparse
import asyncio
import json
import os
import sys
import time
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
ROOT_DIR = EVAL_DIR.parent
import soundfile as sf

RESULTS_DIR = EVAL_DIR / "results"
DEFAULT_REFS_PATH = EVAL_DIR / "data" / "references.json"

# Import evaluation components
from run_clip import stream_clip
from score_accuracy import compute_metrics, normalize_text, ENGLISH_LANGS
from score_translation import compute_chrf_score, evaluate_translations
from score_latency import evaluate_latency


def detect_speech_onset(audio_path: Path) -> float:
    """Estimates acoustic speech onset (seconds) via frame energy thresholding."""
    try:
        audio, sr = sf.read(str(audio_path))
        if audio.ndim > 1:
            audio = np.mean(audio, axis=1)
        frame_len = int(sr * 0.02)  # 20ms frames
        if len(audio) < frame_len:
            return 0.0
        frames = [audio[i:i + frame_len] for i in range(0, len(audio) - frame_len, frame_len)]
        rms = [float(np.sqrt(np.mean(f**2))) for f in frames]
        max_rms = max(rms) if rms else 0.0
        if max_rms <= 0.0:
            return 0.0
        thresh = max_rms * 0.05
        for idx, r in enumerate(rms):
            if r > thresh:
                return round(idx * 0.02, 3)
    except Exception:
        pass
    return 0.0


async def evaluate_clip(
    ref_item: dict,
    url: str,
    chunk_ms: int = 1000,
    fast: bool = False
) -> dict:
    """Streams a single clip and collects text, translation, and cue latency data."""
    cid = ref_item["id"]
    lang_full = ref_item["language"]
    lang_short = lang_full.split("_")[0]
    audio_rel = ref_item["audio_path"]
    audio_path = ROOT_DIR / audio_rel

    if not audio_path.exists():
        audio_path = EVAL_DIR / "data" / lang_full / f"{cid}.wav"

    if not audio_path.exists():
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    speech_onset = detect_speech_onset(audio_path)

    # Stream clip over WebSocket
    cues = await stream_clip(
        clip_path=audio_path,
        url=url,
        lang=lang_short,
        chunk_ms=chunk_ms,
        realtime=(not fast),
        output_path=None,
        verbose=False
    )

    hyp_text_parts = [c.get("text", "") for c in cues if c.get("text")]
    hyp_trans_parts = [c.get("translation", "") for c in cues if c.get("translation")]

    hyp_text = " ".join(hyp_text_parts).strip()
    hyp_translation = " ".join(hyp_trans_parts).strip()

    sync_gap = None
    if cues and "start" in cues[0]:
        sync_gap = abs(float(cues[0]["start"]) - speech_onset)

    return {
        "id": cid,
        "language": lang_full,
        "reference": ref_item.get("transcription", ""),
        "en_reference": ref_item.get("en_reference", ""),
        "hypothesis": hyp_text,
        "translation": hyp_translation,
        "cues": cues,
        "speech_onset": speech_onset,
        "sync_gap": sync_gap,
        "clip_duration": ref_item.get("duration", 0.0),
        "failed": False
    }


async def evaluate_all_clips(
    refs: list[dict],
    url: str,
    chunk_ms: int = 1000,
    fast: bool = False,
    concurrency: int = 2
) -> tuple[list[dict], list[dict]]:
    """Runs clip evaluations concurrently bounded by concurrency semaphore."""
    semaphore = asyncio.Semaphore(concurrency)
    total_clips = len(refs)

    async def worker(ref, idx):
        async with semaphore:
            cid = ref["id"]
            lang = ref["language"]
            print(f"[{idx:02d}/{total_clips:02d}] Streaming {cid} ({lang})...", flush=True)
            t0 = time.time()
            try:
                res = await evaluate_clip(ref, url=url, chunk_ms=chunk_ms, fast=fast)
                elapsed = time.time() - t0
                print(f"[{idx:02d}/{total_clips:02d}] DONE {cid} ({len(res['cues'])} cues, {elapsed:.2f}s)", flush=True)
                return res
            except Exception as e:
                print(f"[{idx:02d}/{total_clips:02d}] FAILED {cid}: {e}", flush=True)
                return {
                    "id": cid,
                    "language": lang,
                    "reference": ref.get("transcription", ""),
                    "en_reference": ref.get("en_reference", ""),
                    "hypothesis": "",
                    "translation": "",
                    "cues": [],
                    "speech_onset": 0.0,
                    "sync_gap": None,
                    "clip_duration": ref.get("duration", 0.0),
                    "failed": True
                }

    tasks = [worker(ref, i + 1) for i, ref in enumerate(refs)]
    results = await asyncio.gather(*tasks)

    all_cues = []
    for r in results:
        all_cues.extend(r["cues"])

    return results, all_cues


def run_evaluation(
    url: str,
    engine_label: str = "mock",
    references_path: Path = DEFAULT_REFS_PATH,
    chunk_ms: int = 1000,
    fast: bool = False,
    concurrency: int = 2,
    max_clips: int | None = None,
    langs: str | None = None,
    run_label: str = "SIMULATED"
):
    """Main evaluation routine."""
    with open(references_path, "r", encoding="utf-8") as f:
        refs_data = json.load(f)

    # Filter by language if requested
    if langs:
        lang_set = {l.strip().lower() for l in langs.split(",")}
        refs_data = [
            r for r in refs_data
            if r["language"].lower() in lang_set or r["language"].split("_")[0].lower() in lang_set
        ]

    # Filter by max_clips if requested
    if max_clips is not None:
        refs_data = refs_data[:max_clips]

    print("=" * 70)
    print(f"CtrlCV Benchmark Harness: Engine = '{engine_label}' (Mode: {run_label})")
    print(f"Target WebSocket URL : {url}")
    print(f"References Path      : {references_path}")
    print(f"Streaming Mode       : {'Realtime' if not fast else 'Fast (unthrottled)'}")
    print(f"Concurrency Limit    : {concurrency}")
    print(f"Clips to Evaluate    : {len(refs_data)}")
    print("=" * 70)

    if not refs_data:
        print("No clips matched the specified filter criteria.")
        return

    start_eval_time = time.time()
    clip_results, all_cues = asyncio.run(
        evaluate_all_clips(
            refs=refs_data,
            url=url,
            chunk_ms=chunk_ms,
            fast=fast,
            concurrency=concurrency
        )
    )
    total_time = round(time.time() - start_eval_time, 2)
    print(f"\nEvaluated {len(clip_results)} clips in {total_time}s.")

    # Save predictions file
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    preds_path = RESULTS_DIR / f"predictions_{engine_label}.json"
    clean_preds = [
        {
            "id": r["id"],
            "language": r["language"],
            "text": r["hypothesis"],
            "translation": r["translation"],
            "cue_count": len(r["cues"]),
            "failed": r.get("failed", False),
            "speech_onset": r.get("speech_onset", 0.0),
            "sync_gap": r.get("sync_gap")
        }
        for r in clip_results
    ]
    with open(preds_path, "w", encoding="utf-8") as f:
        json.dump(clean_preds, f, ensure_ascii=False, indent=2)
    print(f"Saved predictions to: {preds_path}")

    # Save combined cue log
    cue_log_path = RESULTS_DIR / f"cue_log_{engine_label}.json"
    with open(cue_log_path, "w", encoding="utf-8") as f:
        json.dump(all_cues, f, ensure_ascii=False, indent=2)
    print(f"Saved combined cue log ({len(all_cues)} cues) to: {cue_log_path}")

    # 1. Compute Accuracy Metrics (CER / WER)
    accuracy_records = []
    for r in clip_results:
        metrics = compute_metrics(r["reference"], r["hypothesis"], r["language"])
        accuracy_records.append({
            "id": r["id"],
            "language": r["language"],
            "wer": metrics["wer"] * 100.0,
            "cer": metrics["cer"] * 100.0,
            "primary_metric": metrics["primary_metric"].upper(),
            "primary_score": metrics["primary_score"] * 100.0,
            "failed": r.get("failed", False),
            "sync_gap": r.get("sync_gap")
        })
    df_acc = pd.DataFrame(accuracy_records)

    # 2. Compute Translation Metrics (chrF against English references)
    trans_records = []
    for r in clip_results:
        lang = r["language"]
        if lang in ("en_us", "en"):
            ref_en = r.get("reference")
        else:
            ref_en = r.get("en_reference")

        if ref_en:
            trans_records.append({
                "id": r["id"],
                "language": lang,
                "reference": ref_en,
                "hypothesis": r["translation"]
            })

    trans_eval = evaluate_translations(trans_records)
    chrf_by_lang = {}
    if "lang_summary" in trans_eval and not trans_eval["lang_summary"].empty:
        for _, row in trans_eval["lang_summary"].iterrows():
            chrf_by_lang[row["Language"]] = row["Corpus Score"]

    # 3. Compute Metrics per language and overall
    summary_rows = []
    unique_langs = sorted(list(set(r["language"] for r in clip_results)))

    all_sync_gaps = []

    for lang in unique_langs:
        lang_acc = df_acc[df_acc["language"] == lang]
        is_en = lang in ("en_us", "en")
        metric_name = "WER" if is_en else "CER"
        avg_acc_score = lang_acc["wer"].mean() if is_en else lang_acc["cer"].mean()

        lang_cues = [c for r in clip_results if r["language"] == lang for c in r["cues"]]
        lat_res = evaluate_latency(lang_cues) if lang_cues else {"median": 0.0, "p90": 0.0, "final_score_pct": 0.0}
        chrf_val = chrf_by_lang.get(lang, None)

        lang_sync_gaps = [r["sync_gap"] for r in clip_results if r["language"] == lang and r.get("sync_gap") is not None]
        all_sync_gaps.extend(lang_sync_gaps)
        med_gap = float(np.median(lang_sync_gaps)) if lang_sync_gaps else 0.0
        p90_gap = float(np.percentile(lang_sync_gaps, 90)) if lang_sync_gaps else 0.0

        failed_count = sum(1 for r in clip_results if r["language"] == lang and r.get("failed", False))

        summary_rows.append({
            "Language": lang,
            "Clips": len(lang_acc),
            "Metric": metric_name,
            "Score (%)": round(avg_acc_score, 2),
            "chrF": f"{chrf_val:.2f}" if chrf_val is not None else "N/A",
            "Latency Med/P90 (s)": f"{lat_res['median']:.2f} / {lat_res['p90']:.2f}",
            "Sync Gap Med/P90 (s)": f"{med_gap:.3f} / {p90_gap:.3f}",
            "Failed/Timeouts": failed_count,
            "Label": run_label
        })

    # Overall Row
    overall_cues = all_cues
    overall_lat = evaluate_latency(overall_cues) if overall_cues else {"median": 0.0, "p90": 0.0, "final_score_pct": 0.0}
    overall_chrf = trans_eval.get("overall_chrf", 0.0) if trans_records else 0.0
    overall_acc_err = df_acc["primary_score"].mean() if not df_acc.empty else 0.0
    overall_med_gap = float(np.median(all_sync_gaps)) if all_sync_gaps else 0.0
    overall_p90_gap = float(np.percentile(all_sync_gaps, 90)) if all_sync_gaps else 0.0
    overall_failed = sum(1 for r in clip_results if r.get("failed", False))

    summary_rows.append({
        "Language": "OVERALL",
        "Clips": len(clip_results),
        "Metric": "MIXED",
        "Score (%)": round(overall_acc_err, 2),
        "chrF": f"{overall_chrf:.2f}",
        "Latency Med/P90 (s)": f"{overall_lat['median']:.2f} / {overall_lat['p90']:.2f}",
        "Sync Gap Med/P90 (s)": f"{overall_med_gap:.3f} / {overall_p90_gap:.3f}",
        "Failed/Timeouts": overall_failed,
        "Label": run_label
    })

    summary_df = pd.DataFrame(summary_rows)
    summary_csv = RESULTS_DIR / f"summary_{engine_label}.csv"
    summary_df.to_csv(summary_csv, index=False, encoding="utf-8")

    # Display clean formatted table
    print("\n" + "=" * 105)
    print(f"FLEURS Benchmark Results Table: Engine = '{engine_label}' (Mode: {run_label})")
    print("=" * 105)
    print(summary_df.to_string(index=False))
    print("=" * 105)
    print("NOTE: FLEURS saaf speech hai, noisy/Hinglish pe numbers alag honge.")
    print("Backend Sync Gap Analysis:")
    print(f"  Acoustic speech onset vs cue.start median gap: {overall_med_gap:.3f}s, P90: {overall_p90_gap:.3f}s.")
    print("  Agar backend ka cue.start chunk boundary pe snap hai (speech onset se door):")
    print("  RECOMMENDATION: Backend mein VAD (Voice Activity Detection) ya word timestamps enable karein")
    print("  taaki cue.start audio chunk boundary (0.0s) ke bajaye acoustic speech onset se align ho.\n")
    print(f"Full report exported to: {summary_csv}\n")


def main():
    parser = argparse.ArgumentParser(description="CtrlCV Batch Evaluation Runner (eval/run_all.py)")
    parser.add_argument("--url", "--ws_url", dest="ws_url", type=str, default=None, help="WebSocket server URL")
    parser.add_argument("--engine_label", type=str, default="mock", help="Engine label (e.g., mock, whisper)")
    parser.add_argument("--references", type=str, default=str(DEFAULT_REFS_PATH), help="Path to references.json")
    parser.add_argument("--chunk_ms", type=int, default=1000, help="Chunk duration in ms")
    parser.add_argument("--concurrency", type=int, default=2, help="Max concurrent streams (default: 2)")
    parser.add_argument("--realtime", action="store_true", help="Stream in real-time (default safe mode)")
    parser.add_argument("--fast", action="store_true", help="Stream fast without realtime sleep")
    parser.add_argument("--max_clips", type=int, default=None, help="Limit total number of clips")
    parser.add_argument("--langs", type=str, default=None, help="Filter languages (comma-separated, e.g. 'hi,mr')")
    parser.add_argument("--measured", action="store_true", help="Mark run as MEASURED (for real backend)")
    args = parser.parse_args()

    # Determine fast streaming vs realtime
    if args.fast:
        fast_mode = True
    elif args.realtime:
        fast_mode = False
    else:
        fast_mode = False

    ws_url = args.ws_url or os.environ.get("CTRLCV_WS_URL") or "ws://127.0.0.1:8000/ws"
    run_label = "MEASURED" if (args.measured or "localhost" not in ws_url and "127.0.0.1" not in ws_url) else "SIMULATED"

    run_evaluation(
        url=ws_url,
        engine_label=args.engine_label,
        references_path=Path(args.references),
        chunk_ms=args.chunk_ms,
        fast=fast_mode,
        concurrency=args.concurrency,
        max_clips=args.max_clips,
        langs=args.langs,
        run_label=run_label
    )


if __name__ == "__main__":
    main()
