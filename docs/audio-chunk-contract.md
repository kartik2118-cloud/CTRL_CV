# Audio Chunk Contract & Diagnostic Specification

## 1. Purpose & Scope
This document specifies the data contract for audio chunks captured from YouTube tabs in the Chrome Manifest V3 extension. 
Under hackathon rules and data safety policies:
- **Metadata Only:** Only metadata diagnostics are exported/logged; raw audio samples and video streams are **never** exported, saved, or downloaded.
- **Audio Capture Scope:** Defines the interface between Role B (Tab Audio Capture) and Role D (Sync Logic, Cue Log, and Evaluation Harness).

---

## 2. Audio Processing Parameters
| Parameter | Value | Description |
|---|---|---|
| **Sample Rate** | `16000` Hz | Fixed 16 kHz sample rate required for standard streaming speech-to-text engines. |
| **Channels** | `1` | Mono audio stream downmixed from stereo tab capture. |
| **Full Chunk Duration** | `0.100` s (100 ms) | Target delivery cadence for low-latency streaming pipeline. |
| **Full Chunk Sample Count** | `1600` samples | Exact number of samples in a standard 100 ms full chunk ($16000 \times 0.100$). |
| **Internal Representation** | `Float32Array` | Normalized $[-1.0, 1.0]$ Float32 in Web Audio API. |
| **Wire Encoding** | TBD | Wire serialization (e.g., 16-bit Linear PCM LE, Float32, or compressed Opus) will be agreed upon with backend (Role C); no wire format is silently assumed. |

---

## 3. Diagnostic Log Schema (JSONL)
Each captured audio chunk emits one diagnostic JSON object per line with the following fields:

| Field | Type | Allowed Values / Constraints | Description |
|---|---|---|---|
| `session_id` | `string` | Non-empty string (e.g. UUID) | Unique session identifier for the capture lifecycle. |
| `video_id` | `string \| null` | 11-char YouTube ID or `null` | YouTube video ID, or `null` if navigating/not loaded. |
| `epoch` | `integer` | $\ge 0$ | Incremented whenever a discontinuity occurs (video load, seek, pause, rate change, reconnect). |
| `chunk_id` | `integer` | $\ge 0$ | Monotonic sequence number within the current `(session_id, epoch)`. |
| `sample_rate_hz` | `integer` | `16000` | Must equal 16000. |
| `channels` | `integer` | `1` | Must equal 1 (mono). |
| `sample_count` | `integer` | $1600$ (or $< 1600$ if `is_final_partial` is `true`) | Number of audio samples in this chunk. |
| `audio_duration_s` | `float` | $\approx \text{sample\_count} / \text{sample\_rate\_hz}$ | Exact duration in audio seconds (0.100 s for full chunk). |
| `chunk_video_start` | `float \| null` | $\ge 0.0$ or `null` | Estimated video timeline start time in seconds. Must be `null` if no valid anchor is available. |
| `chunk_video_end` | `float \| null` | $\ge 0.0$ or `null` | Estimated video timeline end time in seconds. Must be `null` if no valid anchor is available. |
| `playback_rate` | `float` | $> 0.0$ (typically $0.25$ to $2.0$) | Video playback rate at chunk emission. |
| `paused` | `boolean` | `true \| false` | Video playback pause state. |
| `seeking` | `boolean` | `true \| false` | Video seeking state. |
| `ad_state` | `string` | `"unknown" \| "ad_playing" \| "no_ad"` | YouTube ad state. Must default to `"unknown"` unless verified signal exists. |
| `is_final_partial` | `boolean` | Optional, default `false` | Set to `true` only for the terminal chunk when stream is paused, stopped, or flushed. |
| `stt_eligible` | `boolean` | `true \| false` | Distinguishes produced chunks from chunks eligible for future STT submission. |

---

## 4. Key Rules & Invariants

1. **No Hallucinated Video Anchors:**
   - If the video element anchor time cannot be synchronously read or is in flux, `chunk_video_start` and `chunk_video_end` **must** be set to `null`.
   - Missing anchors are treated as **unverified**, never as valid continuous timing.

2. **STT Eligibility Rule:**
   - A chunk is `stt_eligible = true` **only** if:
     - `paused == false`
     - `seeking == false`
     - `ad_state != "ad_playing"`
     - Video anchors are present (`chunk_video_start != null` and `chunk_video_end != null`).
   - If any of these conditions fail, `stt_eligible` must be `false`.

3. **Video Time Span Formula:**
   - For stable, continuous, eligible chunks:
     $$\Delta t_{\text{video}} = \text{chunk\_video\_end} - \text{chunk\_video\_start} = \text{audio\_duration\_s} \times \text{playback\_rate}$$
   - Tolerance for rounding: $\pm 5\text{ ms}$ ($0.005\text{ s}$).

4. **Epoch Boundaries & Discontinuities:**
   - Any video seek, navigation, rate change, or unpause **must increment `epoch`**.
   - Monotonicity checks on `chunk_video_start` are **only valid within the same `(session_id, epoch)`**.
   - Chronological jumps across different epochs are expected and valid.
