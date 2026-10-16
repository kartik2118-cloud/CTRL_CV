# D Tasks (do in order)

## Task 0: Setup (automate everything)
Create `eval/` with a virtualenv and `requirements.txt`:
```
jiwer
sacrebleu
datasets<4        # FLEURS uses a loading script; datasets>=4 may fail
soundfile
librosa
numpy
pandas
python-dotenv
websockets
```
Write `eval/setup.sh` (or `setup.ps1` on Windows) that creates the venv, installs requirements, and creates `eval/data/` and `eval/results/`.
Add `eval/data/`, `eval/results/`, `.env` to `.gitignore`.

## Task 1: Download FLEURS test samples (script: `eval/download_fleurs.py`)
- Languages: hi_in, mr_in, ta_in, te_in, en_us (HF dataset `google/fleurs`, split `test`).
- Take 10 clips per language, save wav (16 kHz mono) + `references.json` (id, transcription, language).
- If `datasets<4` loading still fails, tell me and use the dataset's parquet/refs branch instead.
- This data is ONLY for our own testing, never shipped in the extension.

## Task 2: Cue log schema (`docs/cue_log.schema.json` + `eval/validate_log.py`)
- JSON Schema for the cue log in AGENT_CONTEXT.md.
- Validator that checks fields, start < end, revisions sorted by `at`, first_shown_at >= end of speech only if it is meaningful.

## Task 3: Accuracy scorer (`eval/score_accuracy.py`)
- Input: predictions JSON and `references.json`.
- Normalize: lowercase (en), strip punctuation, collapse whitespace, Unicode NFC.
- CER for hi/mr/ta/te, WER for en (jiwer). Print per-language table, save CSV.
- Test with a deliberate error: reference `आज हम पनीर टिक्का बनाएंगे` vs `आज हम पनीर टिका बनाएंगे` must give WER 20%, CER 8%.

## Task 4: Latency scorer (`eval/score_latency.py`)
- From a cue log: lag = first_shown_at - end. Print median and p90.
- Score: full marks at median <= 3 and p90 <= 5; zero at median >= 6 or p90 >= 10; linear in between on the worse of the two.

## Task 5: Translation scorer (`eval/score_translation.py`)
- sacrebleu chrF between cue `translation` and reference English.

## Task 6: Sync checker (`eval/score_sync.py`)
- Median |cue.start - reference_start|. Flag cues that appear after a seek but belong to before the seek.

## Task 7: Test harness against the backend (after C is up)
- `eval/run_clip.py`: stream a wav to the backend WebSocket as 16 kHz mono chunks following `docs/contract.md`, collect results with `start_offset, end_offset` (audio seconds relative to the chunk), convert to video times via `video_start_time + offset * playback_rate`, write a cue log, run all scorers.
- Purpose: tune STT engine/chunk size with numbers, not feelings.

## Task 8: `docs/contract.md`
- Extension -> backend: 16 kHz mono PCM chunks with `epoch`, `video_start_time`, `playback_rate`, `chunk_id`.
- Backend -> extension: `start_offset`, `end_offset` (audio seconds relative to chunk), `lang`, `langs`, `text`, `translation`, `is_final`, `epoch`, `chunk_id`.
- Time conversion formula (section 4):
  - `start = video_start_time + start_offset * playback_rate`
  - `end   = video_start_time + end_offset   * playback_rate`
- Rule: any result whose `epoch` differs from the current epoch is dropped (this handles seeks).

