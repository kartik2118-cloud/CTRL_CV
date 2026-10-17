# LiveSub Backend Review Results (Role C)

Date: 2026-10-17  
Directory: `C:\Users\Tanmay\Desktop\oop project\16\backend`  
Environment: Windows / Python 3.14.3 / pytest 9.1.1  

---

## 1. Task Status Table (Tasks 1–11)

| Task | Description | Status | Files Changed / Created | Verification & Implementation Summary |
|---|---|---|---|---|
| **Task 1** | Secrets hygiene & repo safety | **DONE** | `.gitignore`, `backend/.gitignore`, `backend/README.md` | `.gitignore` updated with `.env`, `.env.*`, `venv/`, `*.log`, `*.pyc`, `__pycache__/`, `.pytest_cache/`. `.env.example` verified to contain placeholders only. Audited git history (`git log --all -p -- "*.env"`) and repo search for tokens (`sk-`, `gsk_`, `Bearer `); zero keys committed. Added "Syncing / Sharing" section in `README.md`. |
| **Task 2** | Fail fast on missing configuration | **DONE** | `backend/app/config.py`, `backend/app/main.py`, `backend/scripts/start.py`, `backend/tests/test_integration.py` | Mock mode is explicit-only (`STT_PROVIDER=mock`, `TRANSLATION_PROVIDER=mock`). Server refuses to start with descriptive error naming missing env vars (`SARVAM_API_KEY`, `GROQ_API_KEY`, etc.) without printing secrets. `start.py` prints loud warning banner in mock mode. `GET /info` reports `status` as `"degraded"` if `is_mock: true`, and `"ready"` when live cloud providers are active. |
| **Task 3** | Cloud-audio disclosure in `/info` | **DONE** | `backend/app/main.py`, `backend/README.md`, `backend/tests/test_integration.py` | Added disclosure fields to `GET /info`: `audio_leaves_device` (bool), `stt_provider_label`, `translation_provider_label`, `supported_languages_by_provider` (verified against real provider code: 11 Indic languages for Sarvam), and `is_mock`. Fully documented in `README.md` for Role A privacy notices. |
| **Task 4** | Epoch / seek race condition | **DONE** | `backend/app/main.py`, `backend/app/session.py`, `backend/tests/test_integration.py` | In-flight STT and translation tasks tracked and cancelled on seek. Triple epoch guard enforced: (1) upon chunk receipt, (2) immediately after STT await returns, (3) immediately after translation await returns. Tested race condition with slow provider; proved that removing guards causes stale-cue leak and restoring guards drops old epoch cues. Added tests for backward seek and rapid consecutive seeks. |
| **Task 5** | Security & abuse limits | **DONE** | `backend/app/config.py`, `backend/app/main.py`, `backend/scripts/start.py`, `backend/tests/test_integration.py` | Enforced optional `AUTH_TOKEN` (via `?token=` query param or `hello` message, closes socket with code 1008 policy violation if invalid; logs startup warning if unset). Enforced `MAX_CHUNK_BYTES` (256 KB), `MAX_SESSIONS` (20), `IDLE_TIMEOUT_SECONDS` (120s), and sliding-window `MAX_CHUNKS_PER_SECOND` (5.0). Added structured `error` frames for malformed JSON, invalid payload types, and oversized frames without crashing. Configured CORS `ALLOWED_ORIGINS`. |
| **Task 6** | Provider resilience & timeout | **DONE** | `backend/app/main.py`, `backend/tests/test_integration.py` | Wrapped STT and translation calls in `call_stt_with_resilience` with configurable timeout (`PROVIDER_TIMEOUT_SECONDS`), exponential backoff retry loop (`PROVIDER_MAX_RETRIES`), and automatic fallback provider failover (`FALLBACK_STT_PROVIDER`). Tested 429 rate limit errors, timeouts, malformed non-list outputs, and fallback failovers; confirmed socket is kept alive and returns structured `error` frames. |
| **Task 7** | Audio quality & VAD | **DONE** | `backend/app/audio_utils.py`, `backend/app/providers/whisper.py`, `backend/app/providers/sarvam.py`, `backend/README.md`, `backend/tests/test_integration.py` | Added RMS audio energy calculation and `is_silence_chunk` gate (never sends silent/music chunks to cloud STT). Filtered Whisper `no_speech_prob` and `avg_logprob` with configurable thresholds. Filtered common silence hallucinations ("Thank you for watching", "Please subscribe"). Added `deduplicate_seam` word overlap de-duplication at chunk boundaries. Documented chunk duration expectations (2.0–3.0s) and latency tradeoffs. Timestamps extracted from word/segment tokens with duration fallback. |
| **Task 8** | Timestamps & revisions | **DONE** | `backend/app/main.py`, `backend/app/models.py`, `backend/README.md`, `backend/tests/test_integration.py` | Confirmed $t_{\text{video}} = \text{video\_start} + \text{offset\_in\_chunk} \times \text{playback\_rate}$ uses the chunk's own `meta.playback_rate` from `chunk_meta`. Validated incoming binary audio size against `meta.byte_length` (rejects mismatch with `BYTE_LENGTH_MISMATCH` error). Added `is_final: bool = True` and `revision: int = 1` to outgoing `subtitle` cue messages for Role D's cue log schema. |
| **Task 9** | Zero disk write audit | **DONE** | `backend/tests/test_integration.py` | Audited entire backend: zero disk writes. Audio is held strictly in RAM (`io.BytesIO`, `bytes`) and never written to disk or logged. Added `test_task9_disk_write_audit` monkeypatching `builtins.open` and `tempfile` (`NamedTemporaryFile`, `TemporaryFile`, `mkstemp`, `mkdtemp`) to fail on any disk write, verifying full WebSocket session runs 100% in memory. |
| **Task 10** | Pytest test suite & live test | **DONE** | `backend/tests/test_integration.py`, `backend/tests/test_live_providers.py`, `backend/pytest.ini`, `backend/requirements-dev.txt` | Converted integration tests to strict `pytest` with real assertions and non-zero exit code on failure. Added test cases for reconnect, mid-stream `config` language switch, graceful `bye`, and isolated simultaneous sessions. Added separate `test_live_providers.py` with `@pytest.mark.live` and `@pytest.mark.skipif` measuring median and p90 latency against targets (median $\le 3\text{s}$, p90 $\le 5\text{s}$). |
| **Task 11** | Deployment readiness | **DONE** | `backend/Dockerfile`, `backend/Procfile`, `backend/scripts/start.py`, `backend/README.md` | Created production `Dockerfile` (Python 3.11-slim) and `Procfile` binding to `0.0.0.0` and respecting `$PORT`. Added comprehensive "Deploy" section in `README.md` stating `wss://` is strictly required on YouTube (mixed content blocks `ws://`), tunnel URLs change on restart, and tunnels are fallbacks only. Updated `scripts/start.py` launcher banner. |

---

## 2. Automated Test Execution Output

### Command:
```powershell
pytest -v
```

### Real Execution Output:
```text
============================= test session starts =============================
platform win32 -- Python 3.14.3, pytest-9.1.1, pluggy-1.7.0 -- C:\Python314\python.exe
cachedir: .pytest_cache
rootdir: C:\Users\Tanmay\Desktop\oop project\16\backend
configfile: pytest.ini
plugins: anyio-4.12.1, asyncio-1.4.0
asyncio: mode=Mode.STRICT, debug=False, asyncio_default_fixture_loop_scope=None, asyncio_default_test_loop_scope=function
collecting ... collected 20 items

tests/test_integration.py::test_task9_disk_write_audit PASSED            [  5%]
tests/test_integration.py::test_task2_3_rest_endpoints PASSED            [ 10%]
tests/test_integration.py::test_task8_playback_rate_formula PASSED       [ 15%]
tests/test_integration.py::test_task7_audio_quality_filters PASSED       [ 20%]
tests/test_integration.py::test_websocket_full_lifecycle PASSED          [ 25%]
tests/test_integration.py::test_task4_slow_provider_seek_race PASSED     [ 30%]
tests/test_integration.py::test_task4_backward_seek PASSED               [ 35%]
tests/test_integration.py::test_task4_two_rapid_consecutive_seeks PASSED [ 40%]
tests/test_integration.py::test_task10_simultaneous_sessions PASSED      [ 45%]
tests/test_integration.py::test_task10_reconnect PASSED                  [ 50%]
tests/test_integration.py::test_task10_config_language_switch_mid_stream PASSED [ 55%]
tests/test_integration.py::test_task5_oversized_chunk PASSED             [ 60%]
tests/test_integration.py::test_task5_auth_token_enforcement PASSED      [ 65%]
tests/test_integration.py::test_task5_invalid_json_and_payload PASSED    [ 70%]
tests/test_integration.py::test_task6_provider_429_error PASSED          [ 75%]
tests/test_integration.py::test_task6_provider_timeout PASSED            [ 80%]
tests/test_integration.py::test_task6_provider_malformed_output PASSED   [ 85%]
tests/test_integration.py::test_task6_fallback_provider PASSED           [ 90%]
tests/test_integration.py::test_contract_protocol_compatibility PASSED   [ 95%]
tests/test_live_providers.py::test_live_provider_latency SKIPPED (Li...) [100%]

======================== 19 passed, 1 skipped in 3.33s ========================
```

### Standalone Provider Unit Tests:
```powershell
python tests/test_real_stt.py
```
```text
=================================================================
 LiveSub Real STT Provider Interface & In-Memory Audio Tests
=================================================================
[1] Generated 32044 bytes of synthetic in-memory WAV audio.
  PASS: In-memory generation verified (no disk files created).
[2] Testing STT Provider Factory resolution...
  PASS: Factory correctly resolves 'mock', 'sarvam', and 'whisper'.
[3] Testing MockSTTProvider with in-memory audio...
  <- Mock Result: text='नमस्ते दोस्तों, आपका स्वागत है', offset=[0.1s - 0.9s]
  PASS: Mock STT returns well-formed STTResult.
[4] Testing SarvamSTTProvider guard & configuration...
  Notice: SARVAM_API_KEY is not set in environment (expected for offline test).
  PASS: Raised expected configuration error: SARVAM_API_KEY is not configured in .env. Please add SARVAM_API_KEY or set STT_PROVIDER=mock for offline development.
[5] Testing WhisperSTTProvider guard & configuration...
  Notice: GROQ_API_KEY / OPENAI_API_KEY is not set (expected for offline test).
  PASS: Raised expected configuration error: Neither GROQ_API_KEY nor OPENAI_API_KEY is configured in .env. Please add a key or set STT_PROVIDER=mock for offline development.
=================================================================
 ALL REAL STT PROVIDER TESTS PASSED: Ready for Step 2 Deployment!
=================================================================
```

```powershell
python tests/test_translation.py
```
```text
=================================================================
 LiveSub Translation Provider Interface & Caching Tests
=================================================================
[1] Testing Translation Provider Factory resolution...
  PASS: Factory correctly resolves 'mock', 'sarvam', 'groq', and 'openai'.
[2] Testing MockTranslationProvider behavior...
  <- Same language passthrough: 'Hello world'
  <- Cross language translation: '[EN] नमस्ते दोस्तों'
  PASS: Mock translation behavior verified.
[3] Testing SarvamTranslationProvider guards and caching...
  Notice: SARVAM_API_KEY is not set in environment (expected for offline test).
  PASS: Raised expected configuration error: SARVAM_API_KEY is not configured in .env. Please add SARVAM_API_KEY or set TRANSLATION_PROVIDER=mock for offline development.
[4] Testing LLMTranslationProvider guards and caching...
  Notice: GROQ_API_KEY / OPENAI_API_KEY is not set (expected for offline test).
  PASS: Raised expected configuration error: Neither GROQ_API_KEY nor OPENAI_API_KEY is configured in .env. Please add a key or set TRANSLATION_PROVIDER=mock for offline development.
=================================================================
 ALL TRANSLATION TESTS PASSED: Ready for Step 3 Deployment!
=================================================================
```

---

## 3. Items Unverified (Requiring Live Cloud API Keys)

In strict adherence to Project Rule 1 (*"No API keys in the repo or in any file that gets committed. Keys come from env vars only"*):
1. **Live Sarvam AI API Calls**:
   - `test_live_providers.py::test_live_provider_latency` skipped automatically because `SARVAM_API_KEY` is not set.
   - Verifying live transcription against `https://api.sarvam.ai/speech-to-text` and live translation against `https://api.sarvam.ai/translate` requires the user or deployment environment to configure a valid `SARVAM_API_KEY` in `.env`.
2. **Live Groq / Whisper API Calls**:
   - Live transcription latency against `https://api.groq.com/openai/v1/audio/transcriptions` and translation against `https://api.groq.com/openai/v1/chat/completions` requires configuring `GROQ_API_KEY` in `.env`.
3. **Live End-to-End Latency Target SLA Verification**:
   - The test harness is ready in `tests/test_live_providers.py`. As soon as a real key is placed in `.env`, running `pytest tests/test_live_providers.py -s` will benchmark real median and p90 latencies against the target thresholds (median $\le 3.0\text{s}$, p90 $\le 5.0\text{s}$).

---

## 4. Final WebSocket & REST Message Shapes

### 4.1. REST `GET /info`
```json
{
  "service": "LiveSub Backend",
  "version": "1.0.0",
  "status": "ready",
  "stt_provider": "sarvam",
  "translation_provider": "sarvam",
  "is_mock": false,
  "audio_leaves_device": true,
  "stt_provider_label": "Sarvam AI Saaras (cloud)",
  "translation_provider_label": "Sarvam AI Mayura (cloud)",
  "supported_languages_by_provider": ["hi", "mr", "ta", "te", "kn", "gu", "bn", "pa", "ml", "od", "en"],
  "supported_languages": ["hi", "mr", "ta", "te", "kn", "gu", "bn", "pa", "ml", "od", "en"],
  "ws_endpoint": "/ws",
  "health_endpoint": "/health"
}
```
*(When in mock mode, `status` returns `"degraded"` and `is_mock` returns `true`).*

---

### 4.2. WebSocket: Client → Server Messages

#### 1. `hello` (Initial Handshake & Capabilities)
```json
{
  "type": "hello",
  "lang": "hi",
  "target_lang": "en",
  "client_id": "optional-uuid-string",
  "token": "optional-shared-secret-auth-token"
}
```

#### 2. `chunk_meta` (Precedes Audio Chunk)
```json
{
  "type": "chunk_meta",
  "chunk_id": 1,
  "video_start": 12.0,
  "playback_rate": 1.0,
  "epoch": 0,
  "duration": 2.5,
  "byte_length": 80000
}
```

#### 3. `[binary audio frame]` (Raw Audio Payload)
- Raw 16-bit 16 kHz mono PCM or WAV bytes sent immediately after `chunk_meta`.
- Maximum size bounded by `MAX_CHUNK_BYTES` (default 256 KB).

#### 4. `seek` (Video Seek Notification)
```json
{
  "type": "seek",
  "video_time": 45.0,
  "epoch": 1
}
```

#### 5. `config` (Dynamic Runtime Configuration)
```json
{
  "type": "config",
  "playback_rate": 1.25,
  "lang": "hi",
  "target_lang": "en"
}
```

#### 6. `bye` (Graceful Termination)
```json
{
  "type": "bye"
}
```

---

### 4.3. WebSocket: Server → Client Messages

#### 1. `hello_ack` (Handshake Confirmation)
```json
{
  "type": "hello_ack",
  "session_id": "session-uuid-string",
  "epoch": 0
}
```

#### 2. `subtitle` (Outgoing Subtitle Cue)
```json
{
  "type": "subtitle",
  "chunk_id": 1,
  "epoch": 0,
  "start": 12.15,
  "end": 14.35,
  "lang": "hi",
  "text": "आज हम एक नया विषय सीखने जा रहे हैं",
  "translation": "Today we are going to learn a new topic",
  "source": "stt",
  "is_final": true,
  "revision": 1
}
```
- `start` / `end`: Video seconds calculated via formula $t_{\text{video}} = \text{video\_start} + \text{offset\_in\_chunk} \times \text{playback\_rate}$ using chunk's own playback rate.
- `is_final` (bool) and `revision` (int): Required by Role D for the cue log schema.

#### 3. `seek_ack` (Seek Acknowledged)
```json
{
  "type": "seek_ack",
  "epoch": 1,
  "video_time": 45.0
}
```

#### 4. `config_ack` (Config Updated)
```json
{
  "type": "config_ack",
  "playback_rate": 1.25,
  "lang": "hi",
  "target_lang": "en"
}
```

#### 5. `error` (Structured Error Frame — Socket Stays Alive)
```json
{
  "type": "error",
  "code": "OVERSIZED_CHUNK | RATE_LIMIT_EXCEEDED | BYTE_LENGTH_MISMATCH | STT_PROVIDER_ERROR | STT_MALFORMED_OUTPUT | INVALID_JSON | UNKNOWN_MESSAGE_TYPE | VALIDATION_ERROR",
  "detail": "Detailed diagnostic information (safe, no secrets)",
  "message": "Human-readable summary message"
}
```

---

### 4.4. Contract Protocol Compatibility (`docs/contract.md` & `eval/run_clip.py`)

When clients negotiate using the `docs/contract.md` handshake, the backend seamlessly routes into contract mode:

1. **Client Handshake**:
   ```json
   {"type": "start", "session_id": "abc123", "translate_to": "en", "lang_hint": "hi", "dual": true}
   ```
2. **Server Ack**:
   ```json
   {"type": "ready"}
   ```
3. **Client Chunk**:
   ```json
   {"type": "chunk", "chunk_id": 1, "epoch": 1, "video_start_time": 10.0, "playback_rate": 1.0, "sample_rate": 16000}
   ```
   Followed by raw PCM audio binary frame.
4. **Server Result**:
   ```json
   {
     "type": "result",
     "chunk_id": 1,
     "epoch": 1,
     "is_final": true,
     "start_offset": 0.1,
     "end_offset": 0.9,
     "lang": "hi",
     "langs": ["hi"],
     "text": "नमस्ते दोस्तों, आपका स्वागत है",
     "translation": "Hello friends, welcome"
   }
   ```
- If client increments `epoch` (e.g. on seek), the backend automatically adopts the higher epoch and purges older in-flight tasks.
- If a chunk arrives with an older/stale epoch, the backend drops it without emitting a cue.

---

## 5. Live Cloud API Activation Guide

To transition from mock mode to real cloud APIs:
1. In `backend/.env`:
   - Set `STT_PROVIDER=sarvam` (for Indian languages: hi, mr, ta, te, kn, gu, etc.) OR `STT_PROVIDER=groq` (for fast English/Whisper)
   - Set `TRANSLATION_PROVIDER=sarvam` (Mayura translation) OR `TRANSLATION_PROVIDER=groq` (Llama 3.3 70B translation)
   - Add your API keys:
     - `SARVAM_API_KEY=your_key_here`
     - `GROQ_API_KEY=your_key_here` (and/or `OPENAI_API_KEY=your_key_here`)
2. Run live latency benchmark:
   ```powershell
   pytest tests/test_live_providers.py -s
   ```
3. Launch server with real cloud providers:
   ```powershell
   python scripts/start.py
   ```
   The startup banner will show `status: "ready"` and `is_mock: false`.
