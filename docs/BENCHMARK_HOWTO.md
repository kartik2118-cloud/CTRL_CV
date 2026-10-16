# LiveSub Real Benchmark Guide

This document provides exact step-by-step instructions to configure and execute real benchmark evaluations using live speech-to-text providers (Whisper, Sarvam AI) alongside the real WebSocket protocol adapter.

---

## 1. Environment and Gitignore Verification

The backend environment file (`backend/.env`) contains sensitive API keys and secrets. It must never be committed to git.

Verify that `backend/.env` is completely ignored by git:

```bash
git check-ignore -v backend/.env
```

Expected output:
```text
backend/.gitignore:4:.env	backend/.env
```

---

## 2. Setting Up Local `backend/.env`

Create `backend/.env` (copied from `backend/.env.example`):

```bash
cp backend/.env.example backend/.env
```

Populate `backend/.env` with your real provider settings. For example, for Whisper via Groq or OpenAI:

```ini
HOST=0.0.0.0
PORT=8000
DEBUG=false

STT_PROVIDER=whisper
TRANSLATION_PROVIDER=mock

GROQ_API_KEY=your_groq_api_key_here
OPENAI_API_KEY=your_openai_api_key_here
```

Or for Sarvam AI (Indic languages):

```ini
HOST=0.0.0.0
PORT=8000
DEBUG=false

STT_PROVIDER=sarvam
TRANSLATION_PROVIDER=sarvam

SARVAM_API_KEY=your_sarvam_api_key_here
```

---

## 3. Starting the Real Backend

From the repository root or `backend/` directory, launch the FastAPI server:

```bash
cd backend
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Verify the active provider by querying the capability endpoint:

```bash
curl -s http://127.0.0.1:8000/info
```

Expected response format:
```json
{
  "service": "LiveSub Backend",
  "version": "1.0.0",
  "status": "ready",
  "stt_provider": "whisper",
  "translation_provider": "mock",
  "supported_languages": ["hi", "mr", "ta", "te", "en", "kn", "gu", "bn"],
  "ws_endpoint": "/ws",
  "health_endpoint": "/health"
}
```

---

## 4. Running a Single Clip Evaluation

Stream a single audio clip using the real Section 4 protocol adapter:

```bash
python eval/run_clip.py --protocol real --clip eval/data/hi_in/hi_in_1792.wav
```

### Protocol Mechanics
- **Handshake**: Sends `hello {type, client_id, lang, target_lang}` and waits for `hello_ack`.
- **Chunk Streaming**: For each chunk, sends `chunk_meta {type, chunk_id, video_start, playback_rate, epoch, duration}` followed immediately by a binary 16 kHz mono 16-bit PCM frame.
- **Results**: Receives `subtitle` frames with absolute timestamps in video seconds. Epoch mismatches are discarded as stale.
- **Seek Simulation**: Using `--seek_at <sec> --seek_to <sec>` sends the backend's `seek` control frame and increments epoch.

Validate the generated cue log against the strict 8-field schema:

```bash
python eval/validate_log.py eval/results/cue_log.json
```

---

## 5. Running the Batch Benchmark Harness

Execute the benchmark suite across FLEURS test clips:

```bash
# Fast sanity check on 3 clips
python eval/run_all.py --protocol real --max_clips 3

# Specific languages (e.g. Hindi, Marathi, English)
python eval/run_all.py --protocol real --langs hi,mr,en --max_clips 5

# Full test suite
python eval/run_all.py --protocol real
```

### Mock vs Measured Labeling Rule
- If the backend returns `stt_provider == "mock"`, all evaluation rows are labeled `SIMULATED`.
- If the backend returns a real provider (`whisper` or `sarvam`), rows are labeled `MEASURED`.

---

## 6. Running the Acceptance Gate (Judge Simulator)

Run the acceptance script simulator connected to your live backend:

```bash
node eval/judge_sim.mjs --ws_url ws://127.0.0.1:8000/ws
```

The simulator probes `http://127.0.0.1:8000/info`. If a real STT provider is detected, the gate marks relevant rows as `MEASURED` and `PASS`. If a mock provider is detected, rows are labeled `SIMULATED` and `SIMULATED-PASS`.
