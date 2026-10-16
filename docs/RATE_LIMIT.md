# Cloud STT Rate Limits and Chunk Size Trade-offs

This document details the relationship between audio chunk duration, request frequency (RPM), and perceived end-to-end subtitle latency when streaming against cloud Speech-to-Text and Translation endpoints (such as Groq Whisper, OpenAI, or Sarvam AI).

---

## 1. Chunk Size vs STT RPM vs Translation RPM vs Estimated Median Lag

The following table evaluates audio chunk sizes for a single continuous playback stream (concurrency 1) against the Groq free-tier rate limit (20 RPM).

| Chunk Duration | STT RPM (Calls/Min) | Translation RPM (Calls/Min) | Combined Groq RPM | Estimated Turnaround (s) | Estimated Median Lag (s) | Groq Free Tier (20 RPM) Status |
|:--------------:|:-------------------:|:---------------------------:|:-----------------:|:------------------------:|:------------------------:|:------------------------------:|
| 1.0 s          | 60 RPM              | 60 RPM                      | 120 RPM           | ~0.35 s (ESTIMATE)       | ~1.35 s (ESTIMATE)       | EXCEEDS LIMIT (6.0x combined; 429 within 10-20s) |
| 2.0 s          | 30 RPM              | 30 RPM                      | 60 RPM            | ~0.40 s (ESTIMATE)       | ~2.40 s (ESTIMATE)       | EXCEEDS LIMIT (3.0x combined; 429 within 20-40s) |
| 3.0 s          | 20 RPM              | 20 RPM                      | 40 RPM            | ~0.45 s (ESTIMATE)       | ~3.45 s (ESTIMATE)       | EXCEEDS LIMIT (2.0x combined; STT alone sits at limit) |
| 5.0 s          | 12 RPM              | 12 RPM                      | 24 RPM            | ~0.55 s (ESTIMATE)       | ~5.55 s (ESTIMATE)       | STT ALONE IS SAFE (12 RPM); Combined slightly exceeds |

*All latency values above carry the ESTIMATE label based on cloud network roundtrip plus model inference overhead.*

---

## 2. Backend Call Architecture & Rate Limit Dynamics

1. **Per-Chunk API Call Multiplier**:
   - As inspected in `backend/app/main.py:115-156`:
     - Every received audio chunk triggers one STT transcription call via `stt_provider.transcribe_chunk()`.
     - If `target_lang` is set and differs from `source_lang`, each returned speech segment triggers an additional translation call via `translation_provider.translate()`.
     - Result: When translating from Hindi to English on 1.0s chunks, the backend issues 60 STT requests plus 60 LLM translation requests per minute (120 requests/minute total). If both providers use the same Groq API key, the 20 RPM quota is exhausted in 10 seconds.

2. **Retry and Backoff Status in Backend Providers**:
   - `backend/app/providers/whisper.py:59-63`: Uses `httpx.AsyncClient(timeout=10.0)`. Performs a single POST request with ZERO retries and ZERO exponential backoff. Non-200 responses immediately raise `RuntimeError`.
   - `backend/app/providers/translation_llm.py:70-75`: Uses `httpx.AsyncClient(timeout=8.0)`. Performs a single POST request with ZERO retries and ZERO exponential backoff. Caches results in `_cache` dictionary (1000 items), but unique sentences generate uncached calls.
   - `backend/app/providers/translation_sarvam.py:73-78`: Uses `httpx.AsyncClient(timeout=8.0)`. Performs a single POST request with ZERO retries and ZERO exponential backoff.
   - Architectural implication: Cloud 429 rate limit errors fail immediately with no retry buffer. The client WebSocket receives an error frame instantly and the chunk is dropped.

3. **Concurrency Multiplier**:
   - Running evaluation harnesses or serving multiple users multiplies RPM directly:
     $$\text{Estimated RPM} = \text{Concurrency} \times \left(\frac{60.0}{\text{Chunk Duration in Seconds}}\right)$$
   - Concurrency 2 with 1.0 s chunks generates 120 STT RPM and 120 Translation RPM.
   - Concurrency 1 with 5.0 s chunks generates 12 STT RPM and 12 Translation RPM.

---

## 3. Evaluation Harness Guardrails

To prevent unintended quota exhaustion and rate limit errors during evaluations:
- `eval/run_all.py` calculates estimated RPM prior to executing audio streams.
- If estimated RPM exceeds `--rpm_limit` (default: 20.0), execution alerts the operator and requires explicit confirmation via `--confirm_rpm`.
- Concurrency defaults to 1 for all non-mock engines.
- Any clip encountering an HTTP 429 frame is tracked under `Rate-Limited` and marked `INVALID_RATE_LIMITED` in accuracy scoring so dropped speech does not register as a deceptively low CER score.
- The `Coverage` column (`results_received / chunks_sent`) documents missing speech chunks explicitly.
