"""
eval/mock_backend.py: FastAPI WebSocket server implementing docs/contract.md.

Protocol:
1. Session start:
   - Client sends JSON: {"type": "start", "session_id": "...", ...}
   - Server replies JSON: {"type": "ready"}
2. Audio chunk:
   - Client sends JSON header: {"type": "chunk", "chunk_id": ..., "epoch": ..., "video_start_time": ..., "playback_rate": ..., "sample_rate": ...}
   - Client sends binary frame: raw PCM, 16 kHz, mono, 16-bit signed LE
3. Result:
   - Server processes chunks concurrently (spawns async task) with configurable delay (--delay, default 1.5s).
   - Server replies JSON:
     {"type": "result", "chunk_id": ..., "epoch": ..., "is_final": True,
      "start_offset": 0.0, "end_offset": 0.1, "lang": ..., "langs": [...],
      "text": "mock", "translation": "mock"}
"""
import argparse
import asyncio
import json
import sys
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import uvicorn

# Reconfigure stdout to UTF-8
if sys.stdout.encoding != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

app = FastAPI(title="CtrlCV Mock STT Backend")

CONFIG = {
    "delay": 1.5,
    "slow_first": 0,
    "start_offset": 0.0,
    "end_offset": 0.1,  # Non-zero offset so start < end strictly holds
    "text": "mock",
    "translation": "mock"
}


async def handle_contract_connection(websocket: WebSocket):
    await websocket.accept()
    session_id = None
    lang_hint = "hi"
    print(f"[Backend] Client connected from {websocket.client}")

    # Lock to ensure WebSocket sends are thread/coroutine safe
    send_lock = asyncio.Lock()

    async def process_and_reply(chunk_id, epoch, v_start, rate, lang):
        chunk_delay = CONFIG["delay"]
        if chunk_id <= CONFIG["slow_first"]:
            chunk_delay = CONFIG["delay"] + 5.0
            print(f"[Backend] Chunk {chunk_id} is slow_first (delay={chunk_delay}s)")

        if chunk_delay > 0:
            await asyncio.sleep(chunk_delay)

        if CONFIG.get("drop_chunk_at") and chunk_id == CONFIG["drop_chunk_at"]:
            print(f"[Backend] Dropped chunk {chunk_id} (simulating incomplete speech / lost chunk)")
            return

        if CONFIG.get("inject_429_at") and chunk_id == CONFIG["inject_429_at"]:
            err_frame = {
                "type": "error",
                "code": 429,
                "detail": "Whisper STT API error (HTTP 429): Rate limit reached for model"
            }
            async with send_lock:
                await websocket.send_json(err_frame)
            print(f"[Backend] Injected HTTP 429 error for chunk {chunk_id}")
            return

        end_offset = CONFIG.get("end_offset", 1.0)
        start_offset = CONFIG.get("start_offset", 0.0)
        v_sub_start = round(v_start + (start_offset * rate), 3)
        v_sub_end = round(v_start + (end_offset * rate), 3)

        result_frame = {
            "type": "result",
            "chunk_id": chunk_id,
            "epoch": epoch,
            "is_final": True,
            "start": v_sub_start,
            "end": v_sub_end,
            "start_offset": start_offset,
            "end_offset": end_offset,
            "lang": lang,
            "langs": [lang],
            "text": CONFIG["text"],
            "translation": CONFIG["translation"]
        }
        async with send_lock:
            await websocket.send_json(result_frame)
        print(f"[Backend] Sent result for chunk {chunk_id} (epoch={epoch}, start={v_sub_start}s, end={v_sub_end}s, delay={chunk_delay}s)")

    try:
        while True:
            message = await websocket.receive()
            if "text" in message:
                try:
                    data = json.loads(message["text"])
                except Exception as e:
                    async with send_lock:
                        await websocket.send_json({"type": "error", "code": "INVALID_JSON", "message": str(e)})
                    continue

                msg_type = data.get("type")
                if msg_type in ("hello", "start"):
                    session_id = data.get("client_id") or data.get("session_id", "default_session")
                    lang_hint = data.get("lang") or data.get("lang_hint") or "hi"
                    print(f"[Backend] Client handshake ({msg_type}): session_id={session_id}, lang={lang_hint}")
                    async with send_lock:
                        if msg_type == "hello":
                            await websocket.send_json({"type": "hello_ack", "session_id": session_id})
                        else:
                            await websocket.send_json({"type": "ready"})

                elif msg_type == "seek":
                    epoch = data.get("epoch", 1)
                    v_time = data.get("video_time", 0.0)
                    print(f"[Backend] Seek event: epoch={epoch}, video_time={v_time}")
                    async with send_lock:
                        await websocket.send_json({"type": "seek_ack", "epoch": epoch})

                elif msg_type in ("chunk_meta", "chunk"):
                    chunk_id = data.get("chunk_id", 0)
                    epoch = data.get("epoch", 0)
                    v_start = data.get("video_start_time") if "video_start_time" in data else data.get("video_start", 0.0)
                    rate = data.get("playback_rate", 1.0)

                    # Contract requirement: Next frame MUST be binary PCM
                    binary_msg = await websocket.receive()
                    if "bytes" not in binary_msg:
                        async with send_lock:
                            await websocket.send_json({
                                "type": "error",
                                "code": "PROTOCOL_VIOLATION",
                                "message": "Expected binary PCM frame immediately following chunk header."
                            })
                        continue

                    pcm_bytes = binary_msg["bytes"]
                    chunk_duration = len(pcm_bytes) / (16000 * 2)
                    print(f"[Backend] Received chunk {chunk_id} (epoch={epoch}, v_start={v_start:.2f}s, bytes={len(pcm_bytes)}, dur={chunk_duration:.2f}s)")

                    # Process concurrently without blocking the receive loop
                    asyncio.create_task(process_and_reply(chunk_id, epoch, v_start, rate, lang_hint))

    except WebSocketDisconnect:
        print(f"[Backend] Client disconnected ({session_id})")
    except Exception as e:
        print(f"[Backend] Connection error: {e}")


@app.websocket("/")
async def websocket_root(websocket: WebSocket):
    await handle_contract_connection(websocket)


@app.websocket("/ws")
async def websocket_ws(websocket: WebSocket):
    await handle_contract_connection(websocket)


def main():
    parser = argparse.ArgumentParser(description="Mock Backend WebSocket Server (docs/contract.md)")
    parser.add_argument("--port", type=int, default=8000, help="Port to listen on (default: 8000)")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host address (default: 127.0.0.1)")
    parser.add_argument("--delay", type=float, default=1.5, help="Simulated processing delay in seconds (default: 1.5)")
    parser.add_argument("--slow_first", type=int, default=0, help="Number of first N chunks to delay heavily (default: 0)")
    parser.add_argument("--end_offset", type=float, default=0.1, help="Speech end offset relative to chunk start (default: 0.1)")
    parser.add_argument("--text", type=str, default="mock", help="Mock recognized text (default: 'mock')")
    parser.add_argument("--translation", type=str, default="mock", help="Mock translation text (default: 'mock')")
    parser.add_argument("--inject_429_at", type=int, default=0, help="Inject HTTP 429 rate limit error frame at specified chunk_id (default: 0)")
    parser.add_argument("--drop_chunk_at", type=int, default=0, help="Silently drop result for specified chunk_id to simulate incomplete coverage (default: 0)")
    args = parser.parse_args()

    CONFIG["delay"] = args.delay
    CONFIG["slow_first"] = args.slow_first
    CONFIG["end_offset"] = args.end_offset
    CONFIG["text"] = args.text
    CONFIG["translation"] = args.translation
    CONFIG["inject_429_at"] = args.inject_429_at
    CONFIG["drop_chunk_at"] = args.drop_chunk_at

    print(f"Starting Mock Backend on {args.host}:{args.port} with delay={args.delay}s, slow_first={args.slow_first}, end_offset={args.end_offset}s...")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()

