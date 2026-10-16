# Contract: Extension <-> Backend (v0.1)

Transport: one WebSocket per tab session. Audio leaves the browser, so the extension must show a notice and an off switch.

## 1. Session start (extension -> backend, JSON text frame)
```json
{"type": "start", "session_id": "abc123", "translate_to": "en", "lang_hint": null, "dual": true}
```
`lang_hint` is null for auto-detect. Backend replies `{"type": "ready"}`.

## 2. Audio chunk (extension -> backend)
Two frames per chunk, in order:

1. JSON text frame (header):
```json
{"type": "chunk", "chunk_id": 17, "epoch": 3, "video_start_time": 60.0, "playback_rate": 1.5, "sample_rate": 16000}
```
2. Binary frame: raw PCM, 16 kHz, mono, 16-bit signed little-endian.

- `video_start_time` = `video.currentTime` (video seconds) at the first sample of the chunk.
- `epoch` is a counter. The extension increments it on every seek, navigation, ad start/end and tab reset.
- Cut chunks at pauses (VAD). Do not cut mid-word. Target 1-4 s per chunk.

## 3. Result (backend -> extension, JSON text frame)
```json
{"type": "result", "chunk_id": 17, "epoch": 3, "is_final": true,
 "start_offset": 0.8, "end_offset": 4.0,
 "lang": "hi", "langs": ["hi"], "text": "आज हम पनीर टिक्का बनाएंगे",
 "translation": "Today we will make paneer tikka"}
```
- Offsets are AUDIO seconds from the start of the chunk. The backend never converts to video time.
- `langs` has two entries for code-mixed speech, for example `["hi", "en"]`.
- `is_final: false` = partial text. The same `chunk_id` may be sent again with improved text (each change is logged as a revision).
- Errors: `{"type": "error", "code": "...", "message": "..."}`.

## 4. Time conversion (extension does this, once)
```
start = video_start_time + start_offset * playback_rate
end   = video_start_time + end_offset   * playback_rate
```
Example: chunk at 60.0 s, word at +4.0 s, rate 1.5 -> 60.0 + 4.0 * 1.5 = 66.0 s.
Use the `playback_rate` echoed in the chunk header that was sent, not the current rate.

## 5. Epoch rule
Any result whose `epoch` differs from the current epoch is DROPPED, never rendered, never logged. This is how stale results after a seek or an ad are removed. The backend echoes `epoch` and `chunk_id` unchanged.

## 6. Cue log (exported by the extension)
One entry per subtitle: `start`, `end`, `lang`, `text`, `translation`, `source` ("stt" or "captions"), `first_shown_at` (video time when final text first appeared in full), `revisions: [{at, text}]`. All times are VIDEO seconds.
