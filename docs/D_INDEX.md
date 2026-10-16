# Role D: Sync & Evaluation Index (`docs/D_INDEX.md`)

This document serves as the one-page index and execution map for Role D components across `sync/`, `eval/`, and `docs/`.

---

## 1. Component Execution Map

| Folder / File | Description | Execution Command |
|---|---|---|
| `eval/score_latency.py` | Computes median and P90 lag from cue log (`first_shown_at - end`) | `python eval/score_latency.py --cue_log eval/results/cue_log.json` |
| `eval/score_sync.py` | Evaluates acoustic onset sync gap, seek recovery time, and stale cue count | `python eval/score_sync.py --cue_log eval/results/cue_log.json --seeks eval/results/cue_log.seeks.json` |
| `eval/score_accuracy.py` | Computes WER (English) and CER (Indic languages: hi, mr, ta, te) | `python eval/score_accuracy.py --ref eval/data/references.json --hyp eval/results/predictions_mock.json` |
| `eval/score_translation.py` | Computes chrF score against reference English translations | `python eval/score_translation.py --ref eval/data/references.json --hyp eval/results/predictions_mock.json` |
| `eval/validate_log.py` | Validates cue logs against strict 8-field schema | `python eval/validate_log.py eval/results/cue_log.json` |
| `eval/mock_backend.py` | FastAPI WebSocket server implementing contract protocol with delays | `python eval/mock_backend.py --port 8000 --delay 1.5` |
| `eval/run_clip.py` | Streams single audio clip to WebSocket backend with real-time pacing | `python eval/run_clip.py --clip eval/data/hi_in/sample.wav --url ws://127.0.0.1:8000/ws` |
| `eval/run_all.py` | Batch benchmark harness across FLEURS test clips with concurrency | `python eval/run_all.py --ws_url ws://127.0.0.1:8000/ws --realtime --concurrency 2` |
| `eval/judge_sim.mjs` | Executes Judge acceptance playback script and outputs rubric gate table | `node eval/judge_sim.mjs --ws_url ws://127.0.0.1:8000/ws` |
| `eval/check_contract.py` | Verifies WebSocket handshake and frame types against contract | `python eval/check_contract.py --ws_url ws://127.0.0.1:8000/ws` |
| `sync/syncEngine.js` | Core synchronization engine with epochs, deduplication, and late-hold | Module import: `import { SyncEngine } from "./sync/syncEngine.js"` |
| `sync/syncBridge.js` | HTML5 video bridge automating seek, ratechange, ads, and render polling | Module import: `import { SyncBridge } from "./sync/syncBridge.js"` |
| `sync/build_browser.mjs` | Bundles SyncEngine and SyncBridge into standalone classic browser script | `node sync/build_browser.mjs` |
| `sync/dist/syncEngine.browser.js` | Browser bundle exposing `globalThis.CtrlCVSync` (zero ESM dependencies) | Loaded via `<script src="vendor/syncEngine.browser.js">` |
| `sync/syncEngine.test.mjs` | 34-test Node test suite verifying engine, bridge, and browser bundle | `node --test sync/syncEngine.test.mjs` |
| `docs/contract.md` | WebSocket protocol contract (start, chunk, result, error, types) | Reference specification |
| `docs/INTEGRATION_A.md` | Complete integration manual for Role A (extension overlay & lifecycle) | Reference guide |
| `docs/example_content.js` | Reference content script demonstrating full bridge wiring in ~74 lines | Code reference |
| `docs/cue_log.schema.json` | JSON Schema for cue log export (strict 8 fields, no extra properties) | Validator schema |
| `docs/robustness_checklist.md` | Verification checklist covering stalls, seeking, rate changes, ads | Reference verification |
| `docs/ARCHITECTURE_DRAFT.md` | Architectural separation between Roles A, B, C, and D | Architecture reference |
| `docs/STATUS.md` | Project milestone tracker, rubric status, and next actions | Project status |

---

## 2. Status Classification: Verified vs SIMULATED vs Not Yet Measured

### Verified (Locally Tested and Passing)
- **Unit Test Suite**: 34 unit tests in `sync/syncEngine.test.mjs` passing cleanly with zero failures.
- **Schema Strictness**: Generated cue logs pass `eval/validate_log.py` against `docs/cue_log.schema.json`.
- **Sidecar Structure**: Code-mixed sidecar dictionaries match Decision D2 structure.
- **Browser Script Compatibility**: `sync/dist/syncEngine.browser.js` loads and executes in isolated classic VM contexts without ESM errors.
- **WebSocket Contract Compliance**: `eval/check_contract.py` confirms frame structures against `docs/contract.md`.

### SIMULATED (Synthetic or Mock Pipeline Data)
- **Transcription Accuracy (CER/WER)**: Computed against mock backend responses returning static tokens.
- **Translation Quality (chrF)**: Measured against synthetic mock responses.
- **Latency Lag Metrics**: Median 2.00s and P90 2.00s derived from synthetic engine simulation delays.
- **Sync Gap**: Median 0.00s and P90 0.00s derived from synthetic speech schedule alignment.
- **Seek Recovery & Stale Drop**: Recovery times (<1.0s) verified through in-memory playback timeline simulations.
- **Judge Acceptance Table**: Status table in `eval/judge_sim.mjs` labeled SIMULATED due to mock backend.

### Not Yet Measured (Requires Live Integration)
- **Live YouTube Caption Path**: DOM extraction in active YouTube tabs (`Caption path` rubric item).
- **Production Backend Latency**: Network round-trip latency against remote cloud endpoints (Sarvam, Groq, Whisper).
- **Live Hinglish Code-Mixed Audio**: Accuracy on continuous, overlapping bilingual speech from authentic video streams.
- **Real User Audio Isolation**: Audibility retention while `tabCapture` streams audio under Manifest V3.

---

## 3. Locked Decisions (D1 to D5)

- **D1**: Seek-back with cached cues records an additional show timestamp on the video timeline; continuous playback without seek operations never creates duplicate entries.
- **D2**: Multilingual cues store the primary language string in `cue.lang` (schema compliant) and save the full language list in companion `.langs.json` sidecar files.
- **D3**: Results arriving later than their scheduled video end time remain visible on screen for a minimum hold duration of 2.0s (`minHold`).
- **D4**: Audio chunks register timestamp and playback speed at capture time via `registerChunk`; late results compute `t_video` using the capture-time rate.
- **D5**: SPA navigation events (`yt-navigate-finish`) archive prior video cues into `exportArchive()` before resetting active engine state.
