import asyncio
import json
import sys
from pathlib import Path
import httpx
import websockets

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass


BASE_URL = "http://127.0.0.1:8000"
WS_URL = "ws://127.0.0.1:8000/ws"


async def run_full_integration():
    print("=" * 70)
    print("        LiveSub Full Backend End-to-End Integration Suite")
    print("=" * 70)

    # ── Test 1: REST Health & Metadata ───────────────────────────────────────
    print("\n[Step 1/3] Testing REST Health and Capability Endpoints...")
    async with httpx.AsyncClient(base_url=BASE_URL, timeout=5.0) as client:
        # Health check
        res_health = await client.get("/health")
        print(f"  * GET /health -> HTTP {res_health.status_code}: {res_health.json()}")
        assert res_health.status_code == 200
        assert res_health.json().get("ok") is True

        # Info check
        res_info = await client.get("/info")
        info_json = res_info.json()
        print(f"  * GET /info   -> HTTP {res_info.status_code}")
        print(f"    - Service: {info_json.get('service')}")
        print(f"    - Status : {info_json.get('status')}")
        print(f"    - STT    : {info_json.get('stt_provider')}")
        print(f"    - Langs  : {', '.join(info_json.get('supported_languages', []))}")
        assert res_info.status_code == 200
        assert info_json.get("status") == "ready"
    print("  PASS: REST API endpoints verified.\n")

    # ── Test 2: Full WebSocket Protocol Lifecycle ────────────────────────────
    print("[Step 2/3] Testing WebSocket Handshake & Audio Streaming Pipeline...")
    async with websockets.connect(WS_URL) as ws:
        # 1. Hello
        await ws.send(json.dumps({
            "type": "hello",
            "client_id": "integration-test-suite",
            "lang": "hi",
            "target_lang": "en"
        }))
        ack = json.loads(await asyncio.wait_for(ws.recv(), timeout=2.0))
        assert ack.get("type") == "hello_ack"
        assert ack.get("epoch") == 0
        print(f"  * Handshake established: Session ID={ack.get('session_id')}, Epoch={ack.get('epoch')}")

        # 2. Audio streaming
        await ws.send(json.dumps({
            "type": "chunk_meta",
            "chunk_id": 1,
            "video_start": 20.0,
            "playback_rate": 1.0,
            "epoch": 0,
            "duration": 1.0
        }))
        await ws.send(b"\x00" * 3200)  # 100ms of simulated audio
        sub = json.loads(await asyncio.wait_for(ws.recv(), timeout=2.0))
        assert sub.get("type") == "subtitle"
        assert sub.get("chunk_id") == 1
        assert sub.get("epoch") == 0
        assert abs(sub["start"] - 20.1) < 0.001
        print(f"  * Streamed Chunk 1 -> Cue [{sub['start']}s - {sub['end']}s]: '{sub['text']}'")

        # 3. Video Seek
        print("\n[Step 3/3] Testing Seek Synchronization & Stale Epoch Guard...")
        await ws.send(json.dumps({"type": "seek", "video_time": 80.0, "epoch": 1}))
        seek_ack = json.loads(await asyncio.wait_for(ws.recv(), timeout=2.0))
        assert seek_ack.get("type") == "seek_ack"
        assert seek_ack.get("epoch") == 1
        print(f"  * Seek acknowledged to 80.0s, session advanced to epoch {seek_ack.get('epoch')}")

        # 4. Old-epoch packet must be dropped
        await ws.send(json.dumps({
            "type": "chunk_meta",
            "chunk_id": 2,
            "video_start": 21.0,
            "epoch": 0  # OLD EPOCH
        }))
        await ws.send(b"\x00" * 3200)

        try:
            leak = await asyncio.wait_for(ws.recv(), timeout=0.4)
            print(f"  FAIL: Leaked stale subtitle: {leak}")
            sys.exit(1)
        except asyncio.TimeoutError:
            print("  * Verified: Stale audio packet from Epoch 0 was dropped by server.")

        # 5. New-epoch packet processed correctly
        await ws.send(json.dumps({
            "type": "chunk_meta",
            "chunk_id": 3,
            "video_start": 80.0,
            "playback_rate": 1.0,
            "epoch": 1  # NEW EPOCH
        }))
        await ws.send(b"\x00" * 3200)
        sub_new = json.loads(await asyncio.wait_for(ws.recv(), timeout=2.0))
        assert sub_new.get("epoch") == 1
        assert abs(sub_new["start"] - 80.1) < 0.001
        print(f"  * Verified: Post-seek cue emitted correctly at [{sub_new['start']}s - {sub_new['end']}s]")

        # 6. Bye
        await ws.send(json.dumps({"type": "bye"}))
        print("  * Disconnected cleanly.")

    print("\n" + "=" * 70)
    print(" ALL INTEGRATION TESTS PASSED: 100% SPEC & PROTOCOL COMPLIANT")
    print("=" * 70)


if __name__ == "__main__":
    asyncio.run(run_full_integration())
