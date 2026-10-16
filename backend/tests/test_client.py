import asyncio
import json
import sys
import websockets

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass


WS_URI = "ws://127.0.0.1:8000/ws"



async def run_test():
    print("=" * 65)
    print(" LiveSub WebSocket Protocol & Epoch Synchronization Verification")
    print("=" * 65)

    print(f"\n[1] Connecting to WebSocket server at {WS_URI}...")
    try:
        async with websockets.connect(WS_URI) as ws:
            print("  Connected successfully!\n")

            # ── Step A: Hello Handshake ───────────────────────────────────────────
            print("[2] Sending 'hello' message (lang='hi', target_lang='en')...")
            hello_msg = {
                "type": "hello",
                "client_id": "test-client-e2e",
                "lang": "hi",
                "target_lang": "en"
            }
            await ws.send(json.dumps(hello_msg))
            ack_raw = await asyncio.wait_for(ws.recv(), timeout=2.0)
            ack = json.loads(ack_raw)
            print(f"  <- Received: {ack}")
            assert ack.get("type") == "hello_ack", f"Expected hello_ack, got {ack}"
            assert ack.get("epoch") == 0, f"Initial epoch should be 0, got {ack.get('epoch')}"
            print("  PASS: Initial hello handshake established at epoch 0.\n")

            # ── Step B: Send Chunks in Epoch 0 ────────────────────────────────────
            print("[3] Streaming Chunk 1 (epoch=0, video_start=10.0s, rate=1.0x)...")
            chunk1_meta = {
                "type": "chunk_meta",
                "chunk_id": 1,
                "video_start": 10.0,
                "playback_rate": 1.0,
                "epoch": 0,
                "duration": 1.0
            }
            await ws.send(json.dumps(chunk1_meta))
            await ws.send(b"\x00\x01\x02\x03fake-audio-chunk-1")

            sub1_raw = await asyncio.wait_for(ws.recv(), timeout=2.0)
            sub1 = json.loads(sub1_raw)
            print(f"  <- Received Subtitle: {sub1}")
            assert sub1.get("type") == "subtitle"
            assert sub1.get("chunk_id") == 1
            assert sub1.get("epoch") == 0
            # Formula verification: start = 10.0 + 0.1 * 1.0 = 10.1, end = 10.0 + 0.9 * 1.0 = 10.9
            assert abs(sub1["start"] - 10.1) < 0.001, f"Expected start=10.1, got {sub1['start']}"
            assert abs(sub1["end"] - 10.9) < 0.001, f"Expected end=10.9, got {sub1['end']}"
            print(f"  PASS: Chunk 1 rendered synced cue [{sub1['start']}s -> {sub1['end']}s].\n")

            print("[4] Streaming Chunk 2 (epoch=0, video_start=11.0s, rate=1.0x)...")
            chunk2_meta = {
                "type": "chunk_meta",
                "chunk_id": 2,
                "video_start": 11.0,
                "playback_rate": 1.0,
                "epoch": 0,
                "duration": 1.0
            }
            await ws.send(json.dumps(chunk2_meta))
            await ws.send(b"\x00\x01\x02\x03fake-audio-chunk-2")

            sub2_raw = await asyncio.wait_for(ws.recv(), timeout=2.0)
            sub2 = json.loads(sub2_raw)
            print(f"  <- Received Subtitle: {sub2}")
            assert sub2.get("chunk_id") == 2
            assert sub2.get("epoch") == 0
            assert abs(sub2["start"] - 11.1) < 0.001
            assert abs(sub2["end"] - 11.9) < 0.001
            print(f"  PASS: Chunk 2 rendered synced cue [{sub2['start']}s -> {sub2['end']}s].\n")

            # ── Step C: User Seeks Video to 45.0s ─────────────────────────────────
            print("[5] Simulating user seek to 45.0s (sending 'seek' message)...")
            seek_msg = {
                "type": "seek",
                "video_time": 45.0,
                "epoch": 1
            }
            await ws.send(json.dumps(seek_msg))
            seek_ack_raw = await asyncio.wait_for(ws.recv(), timeout=2.0)
            seek_ack = json.loads(seek_ack_raw)
            print(f"  <- Received Seek Ack: {seek_ack}")
            assert seek_ack.get("type") == "seek_ack"
            assert seek_ack.get("epoch") == 1
            print("  PASS: Seek acknowledged; session epoch successfully advanced to 1.\n")

            # ── Step D: Stale Chunk with Old Epoch (Must be DROPPED) ──────────────
            print("[6] Sending stale chunk (chunk_id=3, video_start=12.0s, OLD epoch=0)...")
            stale_chunk = {
                "type": "chunk_meta",
                "chunk_id": 3,
                "video_start": 12.0,
                "playback_rate": 1.0,
                "epoch": 0,
                "duration": 1.0
            }
            await ws.send(json.dumps(stale_chunk))
            await ws.send(b"stale-audio-bytes")

            try:
                unexpected = await asyncio.wait_for(ws.recv(), timeout=0.5)
                print(f"  FAIL: Expected no response for stale chunk, but received: {unexpected}")
                sys.exit(1)
            except asyncio.TimeoutError:
                print("  PASS: Old-epoch chunk was correctly dropped by server (no stale subtitles emitted)!\n")

            # ── Step E: Fresh Chunk with New Epoch ────────────────────────────────
            print("[7] Streaming post-seek Chunk 4 (epoch=1, video_start=45.0s, rate=1.0x)...")
            chunk4_meta = {
                "type": "chunk_meta",
                "chunk_id": 4,
                "video_start": 45.0,
                "playback_rate": 1.0,
                "epoch": 1,
                "duration": 1.0
            }
            await ws.send(json.dumps(chunk4_meta))
            await ws.send(b"\x00\x01\x02\x03post-seek-audio-chunk-4")

            sub4_raw = await asyncio.wait_for(ws.recv(), timeout=2.0)
            sub4 = json.loads(sub4_raw)
            print(f"  <- Received Subtitle: {sub4}")
            assert sub4.get("chunk_id") == 4
            assert sub4.get("epoch") == 1
            assert abs(sub4["start"] - 45.1) < 0.001
            assert abs(sub4["end"] - 45.9) < 0.001
            print(f"  PASS: Fresh chunk correctly delivered at new epoch 1 [{sub4['start']}s -> {sub4['end']}s].\n")

            # ── Step F: Config Change (Playback Rate = 1.5x) ──────────────────────
            print("[8] Testing config update (playback_rate=1.5x)...")
            cfg_msg = {
                "type": "config",
                "playback_rate": 1.5
            }
            await ws.send(json.dumps(cfg_msg))
            cfg_ack_raw = await asyncio.wait_for(ws.recv(), timeout=2.0)
            cfg_ack = json.loads(cfg_ack_raw)
            print(f"  <- Received Config Ack: {cfg_ack}")
            assert cfg_ack.get("type") == "config_ack"
            assert cfg_ack.get("playback_rate") == 1.5

            print("[9] Streaming Chunk 5 with playback_rate=1.5x (video_start=46.5s)...")
            chunk5_meta = {
                "type": "chunk_meta",
                "chunk_id": 5,
                "video_start": 46.5,
                "playback_rate": 1.5,
                "epoch": 1,
                "duration": 1.0
            }
            await ws.send(json.dumps(chunk5_meta))
            await ws.send(b"\x00\x01\x02\x03audio-chunk-5")

            sub5_raw = await asyncio.wait_for(ws.recv(), timeout=2.0)
            sub5 = json.loads(sub5_raw)
            print(f"  <- Received Subtitle: {sub5}")
            # Timing check at 1.5x:
            # start = 46.5 + 0.1 * 1.5 = 46.65
            # end = 46.5 + 0.9 * 1.5 = 47.85
            assert abs(sub5["start"] - 46.65) < 0.001
            assert abs(sub5["end"] - 47.85) < 0.001
            print(f"  PASS: Rate-adjusted cue timing calculated correctly [{sub5['start']}s -> {sub5['end']}s].\n")

            # ── Step G: Bye ───────────────────────────────────────────────────────
            print("[10] Sending 'bye'...")
            await ws.send(json.dumps({"type": "bye"}))
            print("  PASS: Disconnected cleanly.\n")

    except ConnectionRefusedError:
        print(f"\nERROR: Could not connect to {WS_URI}. Ensure uvicorn server is running first:")
        print("  uvicorn app.main:app --reload")
        sys.exit(1)

    print("=" * 65)
    print(" ALL TESTS PASSED: Protocol and Epoch Drop Logic Verified 100%!")
    print("=" * 65)


if __name__ == "__main__":
    asyncio.run(run_test())
