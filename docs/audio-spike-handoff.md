# Audio Capture Spike Handoff Documentation

## 1. Overview
This spike delivers the audio capture, 16,000 Hz mono resampling, audible speaker passthrough, and video timing synchronization pipeline for the Chrome Manifest V3 extension. 
Under hackathon rules and data safety policies:
- **Audio Stays Local:** Audio streams remain inside the local Web Audio graph for playback and resampling. No raw audio is sent over the network or saved to disk.
- **Metadata Only:** The extension emits concise chunk diagnostics for synchronization and evaluation.

---

## 2. Unpacked Extension Loading Steps
1. Launch Google Chrome.
2. In the address bar, open:
   ```text
   chrome://extensions
   ```
3. Enable the **Developer mode** toggle in the top-right corner.
4. Click **Load unpacked** in the top-left corner.
5. In the folder picker, select the workspace extension directory:
   ```text
   c:\Users\Raj Chaudhari\OneDrive\Desktop\dyp\extension
   ```
6. Verify that **"Synced YouTube Subtitles - Audio Capture Spike" (v0.1.0)** appears on the extensions page without errors.

---

## 3. Interactive Demo Protocol (Checkpoint 5: Steps 1–13)

| Step | Action | Expected Observation & Verification |
|---|---|---|
| **1. Load extension unpacked** | Load `extension/` via `chrome://extensions`. | Extension card loads without errors; popup icon appears in toolbar. |
| **2. Open YouTube video** | Open any YouTube video (e.g. `https://www.youtube.com/watch?v=dQw4w9WgXcQ`). | Video plays normally; speakers are unmuted. |
| **3. Click Start** | Open extension popup, confirm target tab ID, click **Start Capture**. | Status transitions from `Starting...` to `Capturing Audio`. |
| **4. Confirm capture status** | Inspect popup badge and Chrome tab bar. | Badge displays `Capturing Audio`; Chrome shows tab-audio capture indicator on tab strip. |
| **5. Confirm audible playback** | Listen to speakers. | Video audio remains clearly audible with **zero echo or doubling** (single speaker connection). |
| **6. Observe chunk metadata** | Check popup metric rows and inspect `offscreen.html` console. | Chunk counter increments every 100 ms with timeline bounds, RMS, peak, and rate. |
| **7. Change playback speed** | In YouTube settings, change speed to `1.5x` then `2.0x`. | Content script detects `ratechange`, advances epoch, and updates chunk video span ($0.1\text{s} \times \text{rate}$). |
| **8. Pause and resume** | Click Pause on the YouTube player, wait 2s, click Play. | While paused: `stt_eligible: false, paused: true, anchors: null`. On resume: new epoch starts, re-anchoring cleanly. |
| **9. Seek forward / backward** | Jump forward 30 seconds, then jump back 10 seconds. | Each seek advances epoch; partial chunks are flushed/discarded; new video anchors align to the seeked timeline. |
| **10. SPA video navigation** | Click a recommended video or search for a new video without reload. | Content script detects `yt-navigate-finish` / URL change; `video_id` updates, epoch increments, and old anchors clear. |
| **11. Stop and restart (3x)** | Click **Stop Capture**, then **Start Capture** repeated 3 times. | Verifies clean teardown of tracks/AudioContext and idempotent re-creation without memory leaks. |
| **12. Export text diagnostics** | Click **Export Diagnostics (JSONL)** in the popup. | Downloads a local file `chunk_diagnostics_<timestamp>.jsonl` containing pure text metadata. |
| **13. Run validator on export** | Run `python eval/check_audio_chunks.py <downloaded_file.jsonl>` in terminal. | Validator parses lines, validates duration math and epoch rules, returning exit status `0`. |

---

## 4. Where Diagnostics Appear
- **In the Popup UI:**
  The popup dynamically displays:
  - Active video timeline bounds: `[start_s -> end_s] (Rate: 1.0x, Ep: N)`
  - Total captured chunks count and elapsed audio time: `N chunks (X.Xs)`
- **In the Offscreen Document Console:**
  1. Open `chrome://extensions`.
  2. Under the extension card, click **Inspect views: offscreen.html**.
  3. Real-time logs appear per 100 ms chunk:
     ```text
     [AudioChunk #14 | Ep 0] Video: [1.300000s -> 1.400000s] (Rate: 1x) | Dur: 0.1s | Eligible: true | RMS: 0.1821 | Peak: 0.5214
     ```
- **In the Service Worker Console:**
  Click `service worker` to inspect tab locking and disconnect events.

---

## 5. One-Command Diagnostic Validator
To validate any diagnostic log (either synthetic or exported from the demo):
```bash
python eval/check_audio_chunks.py path/to/log.jsonl --output-report eval/results/validation_report.json
```
- **Exit Status:** `0` on clean pass; `1` on schema/timing violations.
- **Checks Performed:** Line-by-line syntax, 16000 Hz mono types, 1600-sample full chunks, duration math, epoch duplicate detection, and video span formulas ($\Delta t_{\text{video}} = \Delta t_{\text{audio}} \times \text{playback\_rate}$).

---

## 6. Message Contract for Backend Teammate (Role C)
When Role C connects the streaming speech-to-text WebSocket pipeline:
1. **Wire Encoding Agreement:**
   - Raw Float32 samples currently remain in Web Audio memory.
   - For WebSocket streaming to Role C's backend, decide wire format:
     - Option A: 16-bit signed Linear PCM LE (`Int16Array`, 3200 bytes per 100ms chunk).
     - Option B: Normalized 32-bit Float (`Float32Array`, 6400 bytes per 100ms chunk).
     - Option C: Opus frame encoding.
2. **Chunk Framing Header:**
   Each binary audio payload sent to the backend should be accompanied or prefixed by:
   ```json
   {
     "type": "chunk_diagnostic",
     "session_id": "...",
     "video_id": "...",
     "epoch": 0,
     "chunk_id": 12,
     "sample_rate_hz": 16000,
     "channels": 1,
     "sample_count": 1600,
     "audio_duration_s": 0.100,
     "chunk_video_start": 1.200,
     "chunk_video_end": 1.300,
     "playback_rate": 1.0,
     "paused": false,
     "seeking": false,
     "ad_state": "unknown",
     "timing_verified": true,
     "stt_eligible": true,
     "rms": 0.1821,
     "peak": 0.5214
   }
   ```
3. **Discontinuity Rules:**
   - On epoch change (`epoch` incremented), the backend must reset its streaming STT context / VAD state to prevent speech from across a seek or video change from corrupting the new timeline.
   - Any chunk with `stt_eligible: false` (e.g. during pause or seek) must **not** be submitted for transcription.

---

## 7. Known Limitations & Unresolved Dependencies
1. **Acoustic / Physical Hardware Verification:**
   - Automated test runners cannot listen to physical laptop/monitor speakers to evaluate acoustic loudness or phase echo. Physical verification requires running the extension in Chrome with real audio output.
2. **YouTube Ad Signal Verification:**
   - YouTube ad injection varies by region, account, and video. In headless tests, ad servers are not present. The code includes DOM detection for `#movie_player.ad-showing`, but defaults safely to `ad_state = "unknown"` and ad exclusion is marked **not verified** until tested live against real ad inventory.
3. **Chrome tabCapture User Gesture Restriction:**
   - `chrome.tabCapture` requires an explicit user gesture from the active window. It cannot be initiated silently in the background without user interaction.
