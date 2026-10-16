"""
Downloads 10 test clips per language (hi_in, mr_in, ta_in, te_in, en_us) from google/fleurs.
Saves 16 kHz mono WAV files in eval/data/<language>/ and references.json in eval/data/.
"""
import io
import json
import os
import sys
from pathlib import Path
import numpy as np
import pandas as pd
import soundfile as sf

# Ensure UTF-8 output on Windows console
if sys.stdout.encoding != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

LANGUAGES = ["hi_in", "mr_in", "ta_in", "te_in", "en_us"]
NUM_CLIPS = 10
TARGET_SR = 16000

EVAL_DIR = Path(__file__).resolve().parent
DATA_DIR = EVAL_DIR / "data"


def try_load_via_datasets(lang: str):
    """Attempt loading via datasets script and return dataset or raise exception."""
    import datasets

    print(f"[{lang}] Attempting datasets.load_dataset('google/fleurs', '{lang}', split='test')...", flush=True)
    # Datasets script loading fails due to pickler incompatibilities with datasets<4 loading script
    return datasets.load_dataset("google/fleurs", lang, split="test")


def download_via_parquet(lang: str) -> pd.DataFrame:
    """Download parquet file directly from refs/convert/parquet branch."""
    from huggingface_hub import hf_hub_download

    print(f"[{lang}] Downloading parquet file from HF Hub (refs/convert/parquet)...", flush=True)
    parquet_path = hf_hub_download(
        repo_id="google/fleurs",
        filename=f"{lang}/test/0000.parquet",
        repo_type="dataset",
        revision="refs/convert/parquet",
    )
    print(f"[{lang}] Parquet downloaded to: {parquet_path}", flush=True)
    df = pd.read_parquet(parquet_path)
    return df


def process_audio(audio_dict) -> tuple[np.ndarray, float]:
    """Extract audio bytes, convert to mono, resample to 16 kHz if needed."""
    audio_bytes = audio_dict["bytes"]
    data, sr = sf.read(io.BytesIO(audio_bytes))
    if data.ndim > 1:
        data = np.mean(data, axis=1)
    if sr != TARGET_SR:
        import librosa

        data = librosa.resample(data, orig_sr=sr, target_sr=TARGET_SR)
    duration = round(len(data) / TARGET_SR, 2)
    return data, duration


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    all_references = []

    # Map English reference sentences by sentence ID (Task 2)
    print("\n[en_us] Loading English reference parquet to map sentence IDs...", flush=True)
    df_en = download_via_parquet("en_us")
    en_ref_map = dict(zip(df_en["id"], df_en["transcription"]))
    print(f"[en_us] Successfully mapped {len(en_ref_map)} English reference sentences.", flush=True)

    for lang in LANGUAGES:
        lang_dir = DATA_DIR / lang
        lang_dir.mkdir(parents=True, exist_ok=True)
        print(f"\n==========================================", flush=True)
        print(f"Processing language: {lang}", flush=True)
        print(f"==========================================", flush=True)

        # Rule 7: Test datasets loading script first, display error if it fails
        use_parquet = False
        try:
            ds = try_load_via_datasets(lang)
            print(f"[{lang}] Successfully loaded via datasets script.", flush=True)
            samples = [ds[i] for i in range(min(NUM_CLIPS, len(ds)))]
        except Exception as e:
            print(f"[{lang}] datasets loading script FAILED!", flush=True)
            print(f"[{lang}] Exact Error: {type(e).__name__}: {e}", flush=True)
            print(f"[{lang}] Falling back to parquet route (refs/convert/parquet)...", flush=True)
            use_parquet = True

        if use_parquet:
            df = download_via_parquet(lang)
            samples = df.head(NUM_CLIPS).to_dict(orient="records")

        for idx, sample in enumerate(samples):
            sentence_id = sample["id"]
            clip_id = f"{lang}_{sentence_id}"
            wav_path = lang_dir / f"{clip_id}.wav"

            if wav_path.exists():
                info = sf.info(str(wav_path))
                duration = round(info.duration, 2)
            else:
                audio_data, duration = process_audio(sample["audio"])
                sf.write(str(wav_path), audio_data, TARGET_SR, subtype="PCM_16")

            if lang == "en_us":
                en_ref = sample["transcription"]
            else:
                en_ref = en_ref_map.get(sentence_id, "")
                if not en_ref:
                    print(f"  [Warning] Sentence ID {sentence_id} has no matching en_us reference!", flush=True)

            all_references.append(
                {
                    "id": clip_id,
                    "transcription": sample["transcription"],
                    "en_reference": en_ref,
                    "language": lang,
                    "audio_path": f"eval/data/{lang}/{clip_id}.wav",
                    "duration": duration,
                }
            )
            print(f"  [{idx+1}/{NUM_CLIPS}] Processed {clip_id} (duration: {duration}s, en_ref: {bool(en_ref)})", flush=True)

    ref_file = DATA_DIR / "references.json"
    with open(ref_file, "w", encoding="utf-8") as f:
        json.dump(all_references, f, ensure_ascii=False, indent=2)

    print(f"\n[DONE] Saved {len(all_references)} reference clips to {ref_file}", flush=True)


if __name__ == "__main__":
    main()
