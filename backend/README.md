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

### Syncing / Sharing (Important)
- **Always use git** to share code between teammates and machines.
- **Never copy folders manually** (e.g. using `Copy-Item` or zip archives across download folders), as this risks leaking uncommitted `.env` secrets, corrupting virtual environments, and creating desynchronized code states.


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

## 3. REST & WebSocket Protocol Specification

### REST Endpoints
- `GET /health` -> `{"ok": true}`
- `GET /info` -> Server capabilities and privacy disclosure:
  ```json
  {
    "status": "ready",
    "stt_provider": "sarvam",
    "translation_provider": "sarvam",
    "is_mock": false,
    "audio_leaves_device": true,
    "stt_provider_label": "Sarvam AI (cloud)",
    "translation_provider_label": "Sarvam AI (cloud)",
    "supported_languages_by_provider": ["hi", "bn", "kn", "ml", "mr", "od", "pa", "ta", "te", "gu", "en"]
  }
  ```
  *(Role A can inspect `audio_leaves_device` to present privacy notices to users).*

### WebSocket Frames (`/ws`)
All control and metadata exchanges use JSON frames. Raw audio payloads use binary WebSocket frames.

| Message Type | Direction | Payload Structure & Fields |
|---|---|---|
| `hello` | Client → Server | `{"type": "hello", "lang": "hi", "target_lang": "en", "client_id": "...", "token": "..."}` |
| `hello_ack` | Server → Client | `{"type": "hello_ack", "session_id": "...", "epoch": 0}` |
| `chunk_meta` | Client → Server | `{"type": "chunk_meta", "chunk_id": 1, "video_start": 12.0, "playback_rate": 1.0, "epoch": 0, "byte_length": 32044}` |
| `[binary audio]`| Client → Server | Raw in-memory WAV/PCM audio bytes (immediately follows corresponding `chunk_meta`) |
| `subtitle` | Server → Client | `{"type": "subtitle", "chunk_id": 1, "epoch": 0, "start": 12.1, "end": 12.9, "lang": "hi", "text": "...", "translation": "...", "source": "stt", "is_final": true, "revision": 1}` |
| `seek` | Client → Server | `{"type": "seek", "video_time": 45.0, "epoch": 1}` |
| `seek_ack` | Server → Client | `{"type": "seek_ack", "epoch": 1, "video_time": 45.0}` |
| `config` | Client → Server | `{"type": "config", "playback_rate": 1.25, "lang": "hi", "target_lang": "en"}` |
| `config_ack` | Server → Client | `{"type": "config_ack", "playback_rate": 1.25, "lang": "hi", "target_lang": "en"}` |
| `bye` | Client → Server | `{"type": "bye"}` |
| `error` | Server → Client | `{"type": "error", "code": "RATE_LIMIT_EXCEEDED", "detail": "...", "message": "..."}` |

---

## 4. Architecture & Security Rules

- **Zero Disk Audio**: Captured audio chunks are processed strictly in-memory (RAM) and never written to disk or logged.
- **Provider Interfaces**: STT and translation engines implement abstract interfaces (`app/providers/base.py`) for plug-and-play swapping between Mock, Sarvam AI, Whisper-Groq, etc.
- **Epoch Guard**: The server cancels in-flight tasks and rejects any audio chunks or STT results whose epoch does not match the active session epoch, ensuring video seeks never show outdated subtitles.
- **Abuse Protections**: Session limits (`MAX_SESSIONS`), chunk size bounds (`MAX_CHUNK_BYTES`), rate-limiting (`MAX_CHUNKS_PER_SECOND`), and idle session timeouts (`IDLE_TIMEOUT_SECONDS`).

### Chunk Duration Expectations & Latency Tradeoffs (Role B & C)
- **Recommended Chunk Duration**: 2.0 to 3.0 seconds (e.g., 2.5 s slices of 16 kHz mono 16-bit PCM).
- **Latency Tradeoff**: Chunks under 1.5 seconds cause fragmented acoustic context, frequent word cuts at seams, and high HTTP/API overhead. Chunks over 4.0 seconds improve context but directly inflate end-to-end latency ($t_{\text{first\_shown}} - t_{\text{speech\_end}}$), risking the hackathon objective targets (median $\le 3\text{s}$, p90 $\le 5\text{s}$). The optimal balance is 2.0–3.0 s.
- **Timestamp Strategy**: Timestamps are extracted directly from STT segment/word alignment tokens ($seg.start$ and $seg.end$). If a provider response does not include word/segment timestamps, the backend applies the fallback: $t_{\text{start}} = \text{video\_start} + 0.0$ and $t_{\text{end}} = \text{video\_start} + \text{chunk\_duration} \times \text{playback\_rate}$.

---

## 5. Deploy

### Why HTTPS + WSS Are Required
Chrome extensions running in modern Manifest V3 contexts (and YouTube page scripts) can **only** establish WebSocket connections to:
1. `ws://localhost` or `ws://127.0.0.1` (for local development on the same machine).
2. Secure WebSockets: `wss://<remote-host>` (for any non-localhost host).

Unencrypted remote endpoints (`ws://remote.host`) are blocked by Chrome security and Content Security Policy (CSP).

### Deployment Option A: Render (Recommended PaaS)
1. Fork or push this repository to GitHub.
2. In the [Render Dashboard](https://dashboard.render.com), click **New +** -> **Web Service**.
3. Select your repository and choose the **backend** directory as Root Directory.
4. Set:
   - **Environment**: `Python 3` or `Docker` (both `Dockerfile` and `Procfile` are included).
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
5. Under **Environment Variables**, configure:
   - `STT_PROVIDER`: `sarvam` (or `groq`)
   - `TRANSLATION_PROVIDER`: `sarvam` (or `groq`)
   - `SARVAM_API_KEY`: `<your_sarvam_key>`
   - `GROQ_API_KEY`: `<your_groq_key>` (if using Groq)
   - `ALLOWED_ORIGINS`: `*` (or your Chrome Extension ID)
   - `AUTH_TOKEN`: `<optional_shared_secret>`
6. Deploy. Render automatically provisions an SSL certificate giving you a public URL like:
   `https://livesub-backend.onrender.com` -> WebSocket endpoint: `wss://livesub-backend.onrender.com/ws`.

### Deployment Option B: Railway / Fly.io
- **Railway**: Connect repo -> Set Root Directory to `backend` -> Railway detects `Procfile` and assigns `$PORT`. Configure env vars in the Variables tab.
- **Fly.io**: Run `fly launch` in `backend/` -> Uses `Dockerfile` -> Set secrets with `fly secrets set SARVAM_API_KEY=... STT_PROVIDER=sarvam`.

### Local Development via Tunnels (ngrok / Cloudflare Tunnel)
When testing on physical devices or across team members' computers without deploying to cloud:

1. **Cloudflare Tunnel (Free, no login needed)**:
   ```bash
   cloudflared tunnel --url http://127.0.0.1:8000
   ```
   Cloudflare outputs a public HTTPS URL (e.g. `https://random-words.trycloudflare.com`).
   Your extension can connect to:
   `wss://random-words.trycloudflare.com/ws`.

2. **ngrok**:
   ```bash
   ngrok http 8000
   ```
   Outputs an HTTPS forwarding URL (e.g. `https://abc123.ngrok-free.app`).
   Connect using `wss://abc123.ngrok-free.app/ws`.

> [!WARNING]
> **Caveat on Free Tunnels**: Free ngrok and Cloudflare tunnels impose strict connection timeouts and may drop idle WebSocket connections or restart URLs periodically. For hackathon judging and live demonstrations, use a deployed PaaS URL (e.g., Render) or `ws://localhost:8000`.
