# LiveSub — Role C (Backend)

Streaming speech-to-text and translation backend for the LiveSub YouTube Chrome Extension.

---

## 1. Quick Start

### Prerequisites
- Python 3.11+

### Installation
From within the `backend/` directory:

```bash
pip install -r requirements.txt
```

### Environment Configuration
Copy the template configuration:
```bash
cp .env.example .env
```
*(Leave real API keys in `.env` only; `.env` is gitignored).*

### Run the Server
Option A — Standard Uvicorn:
```bash
uvicorn app.main:app --reload
```

Option B — Interactive Launcher (prints LAN IP and Tunnel instructions):
```bash
python scripts/start.py
```

The server starts at `http://127.0.0.1:8000`.
- Health check: `GET http://127.0.0.1:8000/health`
- Server info: `GET http://127.0.0.1:8000/info`
- WebSocket endpoint: `ws://127.0.0.1:8000/ws`

---

## 2. Running Automated Tests

Start the server, then run tests:

1. **Full Integration Test Suite**:
```bash
python tests/test_integration.py
```

2. **WebSocket Client & Seek Sync Test**:
```bash
python tests/test_client.py
```

3. **STT Providers Unit Test**:
```bash
python tests/test_real_stt.py
```

4. **Translation Providers Unit Test**:
```bash
python tests/test_translation.py
```



The test client verifies:
1. `hello` handshake and session initialization at `epoch = 0`.
2. Audio chunk streaming and timestamp synchronization formula:
   $$t_{\text{video}} = \text{video\_start} + \text{offset\_in\_chunk} \times \text{playback\_rate}$$
3. Video seek handling and epoch advancement.
4. Dropping stale audio chunks from older epochs (no pre-seek subtitles shown after seek).
5. Dynamic playback speed adjustment via `config` messages.
6. Clean termination with `bye`.

---

## 3. WebSocket Protocol Specification

All control and metadata exchanges use JSON frames. Raw audio payloads use binary WebSocket frames.

| Message Type | Direction | Payload Description |
|---|---|---|
| `hello` | Client → Server | `{"type": "hello", "lang": "hi", "target_lang": "en"}` |
| `hello_ack` | Server → Client | `{"type": "hello_ack", "session_id": "...", "epoch": 0}` |
| `chunk_meta` | Client → Server | `{"type": "chunk_meta", "chunk_id": 1, "video_start": 12.0, "playback_rate": 1.0, "epoch": 0}` |
| `[binary audio]` | Client → Server | Raw in-memory audio chunk bytes (immediately follows `chunk_meta`) |
| `subtitle` | Server → Client | `{"type": "subtitle", "chunk_id": 1, "epoch": 0, "start": 12.1, "end": 12.9, "text": "...", "translation": "..."}` |
| `seek` | Client → Server | `{"type": "seek", "video_time": 45.0, "epoch": 1}` |
| `seek_ack` | Server → Client | `{"type": "seek_ack", "epoch": 1, "video_time": 45.0}` |
| `config` | Client → Server | `{"type": "config", "playback_rate": 1.25}` |
| `config_ack` | Server → Client | `{"type": "config_ack", "playback_rate": 1.25, ...}` |
| `bye` | Client → Server | `{"type": "bye"}` |

---

## 4. Architecture & Security Rules

- **Zero Disk Audio**: Captured audio chunks are processed strictly in-memory and never written to disk or logged.
- **Provider Interfaces**: STT and translation engines implement abstract interfaces (`app/providers/base.py`) for plug-and-play swapping between Mock, Sarvam AI, OpenAI, etc.
- **Epoch Guard**: The server rejects in-flight or delayed audio chunks whose epoch does not match the active session epoch, ensuring video seeks never show outdated subtitles.
