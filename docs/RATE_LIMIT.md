# Cloud STT Rate Limits and Chunk Size Trade-offs

This document details the relationship between audio chunk duration, request frequency (RPM), and perceived end-to-end subtitle latency when streaming against cloud Speech-to-Text endpoints (such as the Groq Whisper API).

---

## 1. Chunk Size vs RPM vs Estimated Median Lag

The following table evaluates audio chunk sizes for a single continuous playback stream (concurrency 1) against the Groq Whisper free-tier rate limit (20 RPM).

| Chunk Duration | Chunks / Min (RPM) | Estimated STT Turnaround (s) | Estimated Median Lag (s) | Groq Free Tier (20 RPM) Compliance |
|:--------------:|:------------------:|:----------------------------:|:------------------------:|:----------------------------------:|
| 1.0 s          | 60 RPM             | ~0.35 s (ESTIMATE)           | ~1.35 s (ESTIMATE)       | EXCEEDS LIMIT (3.0x limit; 429 within 20s) |
| 2.0 s          | 30 RPM             | ~0.40 s (ESTIMATE)           | ~2.40 s (ESTIMATE)       | EXCEEDS LIMIT (1.5x limit; 429 within 40s) |
| 3.0 s          | 20 RPM             | ~0.45 s (ESTIMATE)           | ~3.45 s (ESTIMATE)       | AT THRESHOLD (20 RPM boundary; jitter risk) |
| 5.0 s          | 12 RPM             | ~0.55 s (ESTIMATE)           | ~5.55 s (ESTIMATE)       | SAFE (Sustainable under 20 RPM quota) |

*All latency values above carry the ESTIMATE label based on cloud network roundtrip plus model inference overhead.*

---

## 2. Rate Limit Dynamics & Analysis

1. **Groq Free-Tier Rate Limits**:
   - Request Limit: 20 Requests Per Minute (RPM).
   - Daily Request Limit: 2,000 Requests Per Day (RPD).
   - Audio Streaming Limit: 7,200 Audio Seconds Per Hour (ASH).

2. **The 1.0-Second Streaming Problem**:
   - A standard 1.0-second chunking strategy transmits 60 audio chunks every minute per client.
   - For a single viewer, this consumes 3.0 times the allowed RPM limit.
   - Result: Cloud provider returns `HTTP 429 Too Many Requests` (Rate limit reached) after chunk 20 (approximately 20 seconds into playback).

3. **Concurrency Multiplier**:
   - Running evaluation harnesses or serving multiple users multiplies RPM directly:
     $$\text{Estimated RPM} = \text{Concurrency} \times \left(\frac{60.0}{\text{Chunk Duration in Seconds}}\right)$$
   - Concurrency 2 with 1.0 s chunks generates 120 RPM (6.0 times the free limit).
   - Concurrency 1 with 5.0 s chunks generates 12 RPM (comfortably below the 20 RPM ceiling).

---

## 3. Evaluation Harness Guardrails

To prevent unintended quota exhaustion and rate limit errors during evaluations:
- `eval/run_all.py` calculates estimated RPM prior to executing audio streams.
- If estimated RPM exceeds `--rpm_limit` (default: 20.0), execution alerts the operator and requires explicit confirmation via `--confirm_rpm`.
- Concurrency defaults to 1 for all non-mock engines.
- Any frame dropped or failed due to HTTP 429 is tracked under `Rate-Limited` and excluded from CER/WER metric scoring so as not to distort model accuracy figures.
