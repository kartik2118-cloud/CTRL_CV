# Project Context (read this first)

## What we are building
A Chrome extension (Manifest V3) that overlays accurate, synced subtitles on YouTube videos.
- If the video has an uploaded (manual) caption track: use it as source text and translate it.
- If not: capture tab audio, run streaming speech-to-text, translate optionally, render overlay.
- Hackathon: 24 hours. Judges load the extension unpacked and score from our exported **cue log JSON**.

## Team roles
- A: extension shell (overlay, style controls, SPA navigation reset)
- B: tab audio capture (tabCapture + offscreen document, audio stays audible)
- C: backend (WebSocket, STT + translation, keys only in env vars, public URL)
- D (me): sync logic, cue log, eval harness. This repo folder: `eval/` and `docs/`

## Scoring (all objective, computed from cue logs)
| Test | Metric |
|---|---|
| Accuracy | CER for Indian languages (hi, mr, ta, te), WER for English; punctuation removed |
| Translation | chrF vs reference + meaning rating |
| Latency | median <= 3 s, p90 <= 5 s (first_shown_at minus speech end) |
| Sync | median gap between cue start and reference start <= 0.5 s; after seek back, cues appear within 1 s; nothing from before a seek shows after it |
| Robustness | new video without reload clears old subtitles in 2 s; tab stays audible; ad speech never on timeline |

## Cue log schema (one entry per subtitle)
```json
{
  "start": 12.40, "end": 14.10, "lang": "hi",
  "text": "...", "translation": "...", "source": "stt",
  "first_shown_at": 16.30,
  "revisions": [{"at": 16.30, "text": "..."}]
}
```
`source` is `captions` or `stt`. Times are VIDEO seconds.

## Key formula
`t_video = chunk_video_start + offset_in_chunk * playback_rate`

## Hard rules from the organizers
- No API keys in repo or extension package.
- Do not download or redistribute YouTube video/audio. Export text only.
- Do not hard-code anything about test videos; no runtime lookup of datasets.
- If audio goes to a cloud API, the extension must say so and allow switching it off.
