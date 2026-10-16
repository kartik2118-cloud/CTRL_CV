import asyncio
import json
import io
import math
import struct
import wave
import time
import pytest
import httpx
from fastapi.testclient import TestClient

from app.main import app, stt_provider, translation_provider
from app.providers.base import STTProvider, STTResult
from app.session import SessionState
from app.audio_utils import is_silence_chunk, compute_audio_energy, deduplicate_seam, is_hallucination_text
from app.config import (
    STT_PROVIDER,
    TRANSLATION_PROVIDER,
    IS_MOCK,
    MAX_CHUNK_BYTES,
    MAX_SESSIONS,
)


def make_in_memory_wav(duration_s: float = 1.0, freq: float = 440.0, sample_rate: int = 16000, silence: bool = False) -> bytes:
    """
    Creates an in-memory mono 16-bit PCM WAV. Never touches disk.
    """
    num_samples = int(duration_s * sample_rate)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        raw = bytearray()
        for i in range(num_samples):
            if silence:
                val = 0
            else:
                val = int(16000.0 * math.sin(2.0 * math.pi * freq * (i / sample_rate)))
            raw.extend(struct.pack("<h", val))
        wf.writeframes(raw)
    return buf.getvalue()


@pytest.fixture(autouse=True)
def setup_mock_providers_for_integration(monkeypatch):
    """
    Ensure integration test suite tests server protocol, epoch logic, limits,
    and streaming deterministically without consuming cloud API credits.
    """
    from app.providers.mock import MockSTTProvider, MockTranslationProvider
    monkeypatch.setattr("app.main.stt_provider", MockSTTProvider())
    monkeypatch.setattr("app.main.translation_provider", MockTranslationProvider())


# ─── Task 1 & 9: Disk-Write Audit Test ────────────────────────────────────────

def test_task9_disk_write_audit(monkeypatch):
    """
    Task 9: Monkeypatch builtins.open and tempfile to fail on write,
    then execute a full WebSocket session and audio synthesis to prove zero disk writes.
    """
    orig_open = open

    def guarded_open(file, mode="r", *args, **kwargs):
        # Allow reading python files or site-packages, but reject writing to any disk file
        if any(m in mode for m in ("w", "a", "x", "+")):
            if isinstance(file, (str, bytes)):
                raise IOError(f"DISK WRITE BLOCKED by LiveSub Zero-Disk Policy: {file} mode={mode}")
        return orig_open(file, mode, *args, **kwargs)

    def guarded_tempfile(*args, **kwargs):
        raise IOError("TEMPFILE CREATION BLOCKED by LiveSub Zero-Disk Policy")

    monkeypatch.setattr("builtins.open", guarded_open)
    import tempfile
    monkeypatch.setattr(tempfile, "NamedTemporaryFile", guarded_tempfile)
    monkeypatch.setattr(tempfile, "TemporaryFile", guarded_tempfile)
    monkeypatch.setattr(tempfile, "mkstemp", guarded_tempfile)
    monkeypatch.setattr(tempfile, "mkdtemp", guarded_tempfile)

    # Audio synthesis in memory
    audio = make_in_memory_wav(duration_s=0.5, freq=440.0)
    assert len(audio) > 0
    assert audio.startswith(b"RIFF")

    # Run full WebSocket session under zero-disk enforcement
    client = TestClient(app)
    with client.websocket_connect("/ws") as ws:
        ws.send_text(json.dumps({"type": "hello", "lang": "hi", "target_lang": "en"}))
        ack = json.loads(ws.receive_text())
        assert ack["type"] == "hello_ack"

        ws.send_text(json.dumps({
            "type": "chunk_meta",
            "chunk_id": 1,
            "video_start": 0.0,
            "epoch": 0,
            "playback_rate": 1.0,
            "byte_length": len(audio)
        }))
        ws.send_bytes(audio)

        sub = json.loads(ws.receive_text())
        assert sub["type"] == "subtitle"
        assert sub["chunk_id"] == 1
        assert sub["text"] is not None

        ws.send_text(json.dumps({"type": "bye"}))


# ─── Task 2 & 3: Fail-Fast & Disclosure Fields ────────────────────────────────

def test_task2_3_rest_endpoints():
    client = TestClient(app)

    # Health
    r_health = client.get("/health")
    assert r_health.status_code == 200
    assert r_health.json() == {"ok": True}

    # Info
    r_info = client.get("/info")
    assert r_info.status_code == 200
    data = r_info.json()

    assert data["status"] == ("degraded" if data.get("is_mock") else "ready")
    assert data["stt_provider"] == STT_PROVIDER
    assert data["translation_provider"] == TRANSLATION_PROVIDER
    assert "is_mock" in data

    # Task 3 fields
    assert "audio_leaves_device" in data
    assert "stt_provider_label" in data
    assert "translation_provider_label" in data
    assert "supported_languages_by_provider" in data
    assert len(data["supported_languages_by_provider"]) >= 4

    if data.get("is_mock"):
        assert data["audio_leaves_device"] is False
        assert "Mock" in data["stt_provider_label"]
    else:
        assert data["audio_leaves_device"] is True


# ─── Task 8: Playback Rate Formula & Revision Correctness ─────────────────────

def test_task8_playback_rate_formula():
    """
    Verify t_video = video_start + offset_in_chunk * playback_rate
    at 1.0x, 1.5x, and 2.0x using chunk's own playback_rate.
    """
    video_start = 15.0
    seg_start = 0.2
    seg_end = 0.8

    for rate in (1.0, 1.5, 2.0):
        t_start = round(video_start + seg_start * rate, 3)
        t_end = round(video_start + seg_end * rate, 3)

        if rate == 1.0:
            assert t_start == 15.2
            assert t_end == 15.8
        elif rate == 1.5:
            assert t_start == 15.3
            assert t_end == 16.2
        elif rate == 2.0:
            assert t_start == 15.4
            assert t_end == 16.6


# ─── Task 7: Audio Quality, VAD & Hallucination Filtering ────────────────────

def test_task7_audio_quality_filters():
    # 1. Silence chunk detection
    silent_audio = make_in_memory_wav(duration_s=0.5, silence=True)
    assert is_silence_chunk(silent_audio, threshold=0.005) is True

    # 2. Tone audio is not silent
    tone_audio = make_in_memory_wav(duration_s=0.5, freq=440.0, silence=False)
    assert is_silence_chunk(tone_audio, threshold=0.005) is False

    # 3. Hallucination detection
    assert is_hallucination_text("Thank you for watching.") is True
    assert is_hallucination_text("Please like and subscribe!") is True
    assert is_hallucination_text("नमस्ते दोस्तों आज हम सीखेंगे") is False

    # 4. Seam de-duplication
    prev = "आज हम एक नया"
    curr = "एक नया विषय सीखेंगे"
    deduped = deduplicate_seam(prev, curr)
    assert deduped == "विषय सीखेंगे"


# ─── Task 4, 5, 6, 8, 10: WebSocket End-to-End Test Suite ───────────────────

def test_websocket_full_lifecycle():
    client = TestClient(app)
    audio = make_in_memory_wav(duration_s=0.5, freq=440.0)

    with client.websocket_connect("/ws") as ws:
        # Hello
        ws.send_text(json.dumps({
            "type": "hello",
            "client_id": "pytest-suite",
            "lang": "hi",
            "target_lang": "en"
        }))
        ack = json.loads(ws.receive_text())
        assert ack["type"] == "hello_ack"
        assert ack["epoch"] == 0

        # Chunk 1
        ws.send_text(json.dumps({
            "type": "chunk_meta",
            "chunk_id": 1,
            "video_start": 10.0,
            "playback_rate": 1.5,
            "epoch": 0,
            "duration": 1.0,
            "byte_length": len(audio)
        }))
        ws.send_bytes(audio)

        sub = json.loads(ws.receive_text())
        assert sub["type"] == "subtitle"
        assert sub["chunk_id"] == 1
        assert sub["epoch"] == 0
        assert sub["is_final"] is True
        assert sub["revision"] == 1
        # Formula check with rate 1.5: start = 10.0 + 0.1 * 1.5 = 10.15
        assert abs(sub["start"] - 10.15) < 0.001

        # Mid-stream config change (Task 10)
        ws.send_text(json.dumps({
            "type": "config",
            "lang": "en",
            "target_lang": "hi",
            "playback_rate": 1.0
        }))
        cfg_ack = json.loads(ws.receive_text())
        assert cfg_ack["type"] == "config_ack"
        assert cfg_ack["lang"] == "en"

        # Byte length mismatch error (Task 8 & 5)
        ws.send_text(json.dumps({
            "type": "chunk_meta",
            "chunk_id": 2,
            "video_start": 12.0,
            "playback_rate": 1.0,
            "epoch": 0,
            "byte_length": 999999  # wrong
        }))
        ws.send_bytes(audio)
        err = json.loads(ws.receive_text())
        assert err["type"] == "error"
        assert err["code"] == "BYTE_LENGTH_MISMATCH"

        # Invalid JSON error (Task 5)
        ws.send_text("THIS IS NOT JSON")
        err_json = json.loads(ws.receive_text())
        assert err_json["type"] == "error"
        assert err_json["code"] == "INVALID_JSON"

        # Unknown message error (Task 5)
        ws.send_text(json.dumps({"type": "nonexistent_action"}))
        err_type = json.loads(ws.receive_text())
        assert err_type["type"] == "error"
        assert err_type["code"] == "UNKNOWN_MESSAGE_TYPE"

        # Seek (Task 4)
        ws.send_text(json.dumps({"type": "seek", "video_time": 45.0, "epoch": 1}))
        seek_ack = json.loads(ws.receive_text())
        assert seek_ack["type"] == "seek_ack"
        assert seek_ack["epoch"] == 1

        # Post-seek old epoch chunk MUST be dropped (Task 4)
        ws.send_text(json.dumps({
            "type": "chunk_meta",
            "chunk_id": 3,
            "video_start": 13.0,
            "epoch": 0  # OLD
        }))
        ws.send_bytes(audio)

        # Send valid new epoch chunk
        ws.send_text(json.dumps({
            "type": "chunk_meta",
            "chunk_id": 4,
            "video_start": 45.0,
            "playback_rate": 1.0,
            "epoch": 1  # NEW
        }))
        ws.send_bytes(audio)

        sub_new = json.loads(ws.receive_text())
        # The received subtitle MUST be from chunk 4 and epoch 1 (chunk 3 was dropped!)
        assert sub_new["chunk_id"] == 4
        assert sub_new["epoch"] == 1

        # Bye (Task 10)
        ws.send_text(json.dumps({"type": "bye"}))


# ─── Task 4: Slow Provider In-Flight Seek Race Condition ─────────────────────

def test_task4_slow_provider_seek_race(monkeypatch):
    """
    Task 4: Slow fake provider. Send chunk, send seek while processing.
    Even if provider shields/swallows cancellation, post-await epoch check
    guarantees that NO cue from old epoch is ever sent after the seek ack.
    """
    client = TestClient(app)
    audio = make_in_memory_wav(duration_s=0.5, freq=440.0)

    class SlowMockProvider(STTProvider):
        async def transcribe_chunk(self, audio_bytes: bytes, lang: str = "en"):
            try:
                await asyncio.sleep(0.3)
            except asyncio.CancelledError:
                # Simulate in-flight computation completing or ignoring cancellation
                pass
            return [STTResult(offset_start=0.1, offset_end=0.9, text="Slow speech text", confidence=1.0)]

    monkeypatch.setattr("app.main.stt_provider", SlowMockProvider())

    with client.websocket_connect("/ws") as ws:
        # Hello
        ws.send_text(json.dumps({"type": "hello", "lang": "en"}))
        json.loads(ws.receive_text())

        # Start chunk in epoch 0
        ws.send_text(json.dumps({
            "type": "chunk_meta",
            "chunk_id": 101,
            "video_start": 5.0,
            "epoch": 0
        }))
        ws.send_bytes(audio)

        # Immediately send seek to advance epoch
        ws.send_text(json.dumps({"type": "seek", "video_time": 60.0, "epoch": 1}))

        # First response must be seek_ack
        msg1 = json.loads(ws.receive_text())
        assert msg1["type"] == "seek_ack"
        assert msg1["epoch"] == 1

        # Now send chunk in new epoch
        ws.send_text(json.dumps({
            "type": "chunk_meta",
            "chunk_id": 102,
            "video_start": 60.0,
            "epoch": 1
        }))
        ws.send_bytes(audio)

        # Wait for next message: it MUST be chunk 102 from epoch 1. Chunk 101 MUST have been dropped.
        msg2 = json.loads(ws.receive_text())
        assert msg2["type"] == "subtitle"
        assert msg2["chunk_id"] == 102
        assert msg2["epoch"] == 1

        # Bye
        ws.send_text(json.dumps({"type": "bye"}))


# ─── Task 4: Backward Seek Test ──────────────────────────────────────────────

def test_task4_backward_seek():
    """
    Task 4: Seek backward from 80.0s to 15.0s, advance epoch, verify old chunks dropped
    and post-seek backward cues arrive with correct epoch and video timestamps.
    """
    client = TestClient(app)
    audio = make_in_memory_wav(duration_s=0.5, freq=440.0)

    with client.websocket_connect("/ws") as ws:
        ws.send_text(json.dumps({"type": "hello", "lang": "en"}))
        json.loads(ws.receive_text())

        # Play at 80.0s epoch 0
        ws.send_text(json.dumps({
            "type": "chunk_meta",
            "chunk_id": 1,
            "video_start": 80.0,
            "epoch": 0
        }))
        ws.send_bytes(audio)
        sub1 = json.loads(ws.receive_text())
        assert sub1["chunk_id"] == 1
        assert sub1["epoch"] == 0

        # Seek backward to 15.0s, epoch 1
        ws.send_text(json.dumps({"type": "seek", "video_time": 15.0, "epoch": 1}))
        ack = json.loads(ws.receive_text())
        assert ack["type"] == "seek_ack"
        assert ack["epoch"] == 1
        assert ack["video_time"] == 15.0

        # Send backward chunk at 15.0s, epoch 1
        ws.send_text(json.dumps({
            "type": "chunk_meta",
            "chunk_id": 2,
            "video_start": 15.0,
            "epoch": 1
        }))
        ws.send_bytes(audio)
        sub2 = json.loads(ws.receive_text())
        assert sub2["chunk_id"] == 2
        assert sub2["epoch"] == 1
        assert abs(sub2["start"] - 15.1) < 0.001

        ws.send_text(json.dumps({"type": "bye"}))


# ─── Task 4: Two Rapid Consecutive Seeks ─────────────────────────────────────

def test_task4_two_rapid_consecutive_seeks():
    """
    Task 4: Two rapid consecutive seeks (e.g. user clicking twice on timeline).
    Ensures intermediate and older epochs are invalidated and only final epoch is active.
    """
    client = TestClient(app)
    audio = make_in_memory_wav(duration_s=0.5, freq=440.0)

    with client.websocket_connect("/ws") as ws:
        ws.send_text(json.dumps({"type": "hello", "lang": "en"}))
        json.loads(ws.receive_text())

        # Rapid seek 1
        ws.send_text(json.dumps({"type": "seek", "video_time": 50.0, "epoch": 1}))
        # Rapid seek 2 without waiting
        ws.send_text(json.dumps({"type": "seek", "video_time": 120.0, "epoch": 2}))

        ack1 = json.loads(ws.receive_text())
        assert ack1["type"] == "seek_ack"
        assert ack1["epoch"] == 1

        ack2 = json.loads(ws.receive_text())
        assert ack2["type"] == "seek_ack"
        assert ack2["epoch"] == 2

        # Send chunk for epoch 1 (stale now because epoch 2 is current)
        ws.send_text(json.dumps({
            "type": "chunk_meta",
            "chunk_id": 5,
            "video_start": 50.0,
            "epoch": 1
        }))
        ws.send_bytes(audio)

        # Send chunk for epoch 2 (valid)
        ws.send_text(json.dumps({
            "type": "chunk_meta",
            "chunk_id": 6,
            "video_start": 120.0,
            "epoch": 2
        }))
        ws.send_bytes(audio)

        # Result MUST be chunk 6 with epoch 2 (chunk 5 must be dropped)
        sub = json.loads(ws.receive_text())
        assert sub["chunk_id"] == 6
        assert sub["epoch"] == 2
        assert abs(sub["start"] - 120.1) < 0.001

        ws.send_text(json.dumps({"type": "bye"}))


# ─── Task 10: Two Simultaneous Sessions (Isolated Streaming) ─────────────────

def test_task10_simultaneous_sessions():
    """
    Task 10: Two simultaneous client sessions streaming concurrently.
    Verifies state isolation: independent epochs, separate chunk counters,
    and no cross-talk between sessions.
    """
    client = TestClient(app)
    audio = make_in_memory_wav(duration_s=0.3, freq=440.0)

    with client.websocket_connect("/ws") as ws1, client.websocket_connect("/ws") as ws2:
        # Client 1 Hello
        ws1.send_text(json.dumps({"type": "hello", "client_id": "client-1", "lang": "hi"}))
        ack1 = json.loads(ws1.receive_text())
        assert ack1["session_id"] == "client-1"
        assert ack1["epoch"] == 0

        # Client 2 Hello
        ws2.send_text(json.dumps({"type": "hello", "client_id": "client-2", "lang": "en"}))
        ack2 = json.loads(ws2.receive_text())
        assert ack2["session_id"] == "client-2"
        assert ack2["epoch"] == 0

        # Client 1 streams chunk
        ws1.send_text(json.dumps({
            "type": "chunk_meta",
            "chunk_id": 1,
            "video_start": 10.0,
            "epoch": 0
        }))
        ws1.send_bytes(audio)

        # Client 2 streams chunk
        ws2.send_text(json.dumps({
            "type": "chunk_meta",
            "chunk_id": 1,
            "video_start": 50.0,
            "epoch": 0
        }))
        ws2.send_bytes(audio)

        # Receive responses
        sub1 = json.loads(ws1.receive_text())
        sub2 = json.loads(ws2.receive_text())

        assert sub1["chunk_id"] == 1
        assert abs(sub1["start"] - 10.1) < 0.001
        assert sub1["lang"] == "hi"

        assert sub2["chunk_id"] == 1
        assert abs(sub2["start"] - 50.1) < 0.001
        assert sub2["lang"] == "en"

        # Client 1 seeks to epoch 1; Client 2 stays at epoch 0
        ws1.send_text(json.dumps({"type": "seek", "video_time": 99.0, "epoch": 1}))
        s_ack1 = json.loads(ws1.receive_text())
        assert s_ack1["epoch"] == 1

        # Client 2 streams another epoch 0 chunk — should succeed because Client 2 did not seek
        ws2.send_text(json.dumps({
            "type": "chunk_meta",
            "chunk_id": 2,
            "video_start": 51.0,
            "epoch": 0
        }))
        ws2.send_bytes(audio)
        sub2_2 = json.loads(ws2.receive_text())
        assert sub2_2["chunk_id"] == 2
        assert sub2_2["epoch"] == 0

        ws1.send_text(json.dumps({"type": "bye"}))
        ws2.send_text(json.dumps({"type": "bye"}))


# ─── Task 10: Reconnect Lifecycle Test ───────────────────────────────────────

def test_task10_reconnect():
    """
    Task 10: Client disconnects, reconnects immediately with new session,
    handshakes cleanly, and resumes streaming without session state contamination.
    """
    client = TestClient(app)
    audio = make_in_memory_wav(duration_s=0.3, freq=440.0)

    # Session 1
    with client.websocket_connect("/ws") as ws1:
        ws1.send_text(json.dumps({"type": "hello", "client_id": "reconnect-sess-1"}))
        ack1 = json.loads(ws1.receive_text())
        assert ack1["session_id"] == "reconnect-sess-1"

        ws1.send_text(json.dumps({
            "type": "chunk_meta",
            "chunk_id": 1,
            "video_start": 5.0,
            "epoch": 0
        }))
        ws1.send_bytes(audio)
        sub1 = json.loads(ws1.receive_text())
        assert sub1["chunk_id"] == 1

        ws1.send_text(json.dumps({"type": "bye"}))

    # Session 2 (Reconnect)
    with client.websocket_connect("/ws") as ws2:
        ws2.send_text(json.dumps({"type": "hello", "client_id": "reconnect-sess-2"}))
        ack2 = json.loads(ws2.receive_text())
        assert ack2["session_id"] == "reconnect-sess-2"
        assert ack2["epoch"] == 0

        ws2.send_text(json.dumps({
            "type": "chunk_meta",
            "chunk_id": 1,
            "video_start": 20.0,
            "epoch": 0
        }))
        ws2.send_bytes(audio)
        sub2 = json.loads(ws2.receive_text())
        assert sub2["chunk_id"] == 1
        assert abs(sub2["start"] - 20.1) < 0.001

        ws2.send_text(json.dumps({"type": "bye"}))


# ─── Task 10: Config Language Switch Mid-Stream ──────────────────────────────

def test_task10_config_language_switch_mid_stream():
    """
    Task 10: Dynamic language switch via 'config' message mid-stream.
    Switches from English-only to Hindi with English translation without dropping connection.
    """
    client = TestClient(app)
    audio = make_in_memory_wav(duration_s=0.3, freq=440.0)

    with client.websocket_connect("/ws") as ws:
        # Start English only
        ws.send_text(json.dumps({"type": "hello", "lang": "en"}))
        ack = json.loads(ws.receive_text())
        assert ack["type"] == "hello_ack"

        ws.send_text(json.dumps({
            "type": "chunk_meta",
            "chunk_id": 1,
            "video_start": 10.0,
            "epoch": 0
        }))
        ws.send_bytes(audio)
        sub1 = json.loads(ws.receive_text())
        assert sub1["lang"] == "en"
        assert sub1["translation"] is None

        # Switch languages mid-stream
        ws.send_text(json.dumps({
            "type": "config",
            "lang": "hi",
            "target_lang": "en",
            "playback_rate": 1.25
        }))
        cfg_ack = json.loads(ws.receive_text())
        assert cfg_ack["type"] == "config_ack"
        assert cfg_ack["lang"] == "hi"
        assert cfg_ack["target_lang"] == "en"
        assert cfg_ack["playback_rate"] == 1.25

        # Send next chunk with new language configuration
        ws.send_text(json.dumps({
            "type": "chunk_meta",
            "chunk_id": 2,
            "video_start": 11.25,
            "playback_rate": 1.25,
            "epoch": 0
        }))
        ws.send_bytes(audio)
        sub2 = json.loads(ws.receive_text())
        assert sub2["chunk_id"] == 2
        assert sub2["lang"] == "hi"
        assert sub2["translation"] is not None
        assert "[EN]" in sub2["translation"]

        ws.send_text(json.dumps({"type": "bye"}))



# ─── Task 5: Security and Abuse Limits Tests ─────────────────────────────────

def test_task5_oversized_chunk(monkeypatch):
    """
    Task 5: Server rejects chunks exceeding MAX_CHUNK_BYTES with OVERSIZED_CHUNK error
    without crashing the server, and remains alive to process valid chunks.
    """
    monkeypatch.setattr("app.main.MAX_CHUNK_BYTES", 500)
    client = TestClient(app)

    with client.websocket_connect("/ws") as ws:
        ws.send_text(json.dumps({"type": "hello", "lang": "en"}))
        json.loads(ws.receive_text())

        # Send chunk meta
        ws.send_text(json.dumps({
            "type": "chunk_meta",
            "chunk_id": 1,
            "video_start": 0.0,
            "epoch": 0,
            "byte_length": 600
        }))
        # Send 600 bytes (> 500 limit)
        ws.send_bytes(b"\x00" * 600)

        err = json.loads(ws.receive_text())
        assert err["type"] == "error"
        assert err["code"] == "OVERSIZED_CHUNK"

        # Server remains alive: send valid chunk
        valid_audio = make_in_memory_wav(duration_s=0.2, freq=440.0)
        monkeypatch.setattr("app.main.MAX_CHUNK_BYTES", 100000)
        ws.send_text(json.dumps({
            "type": "chunk_meta",
            "chunk_id": 2,
            "video_start": 1.0,
            "epoch": 0
        }))
        ws.send_bytes(valid_audio)
        sub = json.loads(ws.receive_text())
        assert sub["type"] == "subtitle"
        assert sub["chunk_id"] == 2

        ws.send_text(json.dumps({"type": "bye"}))


def test_task5_auth_token_enforcement(monkeypatch):
    """
    Task 5: Shared-secret auth token enforcement.
    Unauthenticated connections or wrong tokens are closed with WS_1008_POLICY_VIOLATION.
    """
    monkeypatch.setattr("app.main.AUTH_TOKEN", "secure-secret-token")
    client = TestClient(app)

    # 1. Connection with wrong query param token and wrong hello token -> closed
    with pytest.raises(Exception):
        with client.websocket_connect("/ws?token=wrong-token") as ws:
            ws.send_text(json.dumps({"type": "hello", "token": "wrong-token"}))
            ws.receive_text()

    # 2. Connection with valid query param token -> succeeds
    with client.websocket_connect("/ws?token=secure-secret-token") as ws:
        ws.send_text(json.dumps({"type": "hello"}))
        ack = json.loads(ws.receive_text())
        assert ack["type"] == "hello_ack"
        ws.send_text(json.dumps({"type": "bye"}))

    # 3. Connection with valid hello token -> succeeds
    with client.websocket_connect("/ws") as ws:
        ws.send_text(json.dumps({"type": "hello", "token": "secure-secret-token"}))
        ack = json.loads(ws.receive_text())
        assert ack["type"] == "hello_ack"
        ws.send_text(json.dumps({"type": "bye"}))


def test_task5_invalid_json_and_payload():
    """
    Task 5: Malformed JSON, non-dict payloads, and unknown message types
    return structured error frames without crashing the server.
    """
    client = TestClient(app)
    with client.websocket_connect("/ws") as ws:
        # Invalid JSON syntax
        ws.send_text("{bad json syntax")
        err1 = json.loads(ws.receive_text())
        assert err1["type"] == "error"
        assert err1["code"] == "INVALID_JSON"

        # Valid JSON but not an object (e.g. list)
        ws.send_text(json.dumps([1, 2, 3]))
        err2 = json.loads(ws.receive_text())
        assert err2["type"] == "error"
        assert err2["code"] == "INVALID_PAYLOAD"

        # Unknown message type
        ws.send_text(json.dumps({"type": "unsupported_ping"}))
        err3 = json.loads(ws.receive_text())
        assert err3["type"] == "error"
        assert err3["code"] == "UNKNOWN_MESSAGE_TYPE"

        # Connection is still healthy: handshake works
        ws.send_text(json.dumps({"type": "hello"}))
        ack = json.loads(ws.receive_text())
        assert ack["type"] == "hello_ack"
        ws.send_text(json.dumps({"type": "bye"}))


# ─── Task 6: Robust Provider Error Handling & Resilience Tests ───────────────

def test_task6_provider_429_error(monkeypatch):
    """
    Task 6: Provider raises 429 rate-limit error.
    Server retries with exponential backoff, sends structured error frame on final failure,
    and keeps WebSocket alive to process subsequent chunks when provider recovers.
    """
    monkeypatch.setattr("app.main.PROVIDER_MAX_RETRIES", 1)
    monkeypatch.setattr("app.main.PROVIDER_RETRY_BACKOFF", 0.01)

    attempts = 0

    class RateLimitProvider(STTProvider):
        async def transcribe_chunk(self, audio_bytes: bytes, lang: str = "en"):
            nonlocal attempts
            attempts += 1
            raise RuntimeError("HTTP 429: Rate limit exceeded")

    monkeypatch.setattr("app.main.stt_provider", RateLimitProvider())
    client = TestClient(app)
    audio = make_in_memory_wav(duration_s=0.2, freq=440.0)

    with client.websocket_connect("/ws") as ws:
        ws.send_text(json.dumps({"type": "hello", "lang": "en"}))
        json.loads(ws.receive_text())

        # Send chunk that will fail with 429
        ws.send_text(json.dumps({
            "type": "chunk_meta",
            "chunk_id": 10,
            "video_start": 10.0,
            "epoch": 0
        }))
        ws.send_bytes(audio)

        err = json.loads(ws.receive_text())
        assert err["type"] == "error"
        assert err["code"] == "STT_PROVIDER_ERROR"
        assert "temporarily unavailable" in err["detail"]
        assert attempts == 2  # 1 initial + 1 retry

        # Provider recovers: socket is still alive and processes chunk 11
        class RecoveredProvider(STTProvider):
            async def transcribe_chunk(self, audio_bytes: bytes, lang: str = "en"):
                return [STTResult(offset_start=0.1, offset_end=0.9, text="Recovered audio text", confidence=1.0)]

        monkeypatch.setattr("app.main.stt_provider", RecoveredProvider())
        ws.send_text(json.dumps({
            "type": "chunk_meta",
            "chunk_id": 11,
            "video_start": 11.0,
            "epoch": 0
        }))
        ws.send_bytes(audio)

        sub = json.loads(ws.receive_text())
        assert sub["type"] == "subtitle"
        assert sub["chunk_id"] == 11
        assert sub["text"] == "Recovered audio text"

        ws.send_text(json.dumps({"type": "bye"}))


def test_task6_provider_timeout(monkeypatch):
    """
    Task 6: Provider call times out.
    Server catches timeout, sends structured error frame, keeps socket alive.
    """
    monkeypatch.setattr("app.main.PROVIDER_MAX_RETRIES", 0)
    monkeypatch.setattr("app.main.PROVIDER_TIMEOUT_SECONDS", 0.05)

    class TimeoutProvider(STTProvider):
        async def transcribe_chunk(self, audio_bytes: bytes, lang: str = "en"):
            await asyncio.sleep(0.3)
            return []

    monkeypatch.setattr("app.main.stt_provider", TimeoutProvider())
    client = TestClient(app)
    audio = make_in_memory_wav(duration_s=0.2, freq=440.0)

    with client.websocket_connect("/ws") as ws:
        ws.send_text(json.dumps({"type": "hello"}))
        json.loads(ws.receive_text())

        ws.send_text(json.dumps({
            "type": "chunk_meta",
            "chunk_id": 20,
            "video_start": 20.0,
            "epoch": 0
        }))
        ws.send_bytes(audio)

        err = json.loads(ws.receive_text())
        assert err["type"] == "error"
        assert err["code"] == "STT_PROVIDER_ERROR"

        ws.send_text(json.dumps({"type": "bye"}))


def test_task6_provider_malformed_output(monkeypatch):
    """
    Task 6: Provider returns malformed output (not a list of STTResult).
    Server returns STT_MALFORMED_OUTPUT error and does not crash.
    """
    class MalformedProvider(STTProvider):
        async def transcribe_chunk(self, audio_bytes: bytes, lang: str = "en"):
            return "unexpected string instead of list"

    monkeypatch.setattr("app.main.stt_provider", MalformedProvider())
    client = TestClient(app)
    audio = make_in_memory_wav(duration_s=0.2, freq=440.0)

    with client.websocket_connect("/ws") as ws:
        ws.send_text(json.dumps({"type": "hello"}))
        json.loads(ws.receive_text())

        ws.send_text(json.dumps({
            "type": "chunk_meta",
            "chunk_id": 30,
            "video_start": 30.0,
            "epoch": 0
        }))
        ws.send_bytes(audio)

        err = json.loads(ws.receive_text())
        assert err["type"] == "error"
        assert err["code"] == "STT_MALFORMED_OUTPUT"

        ws.send_text(json.dumps({"type": "bye"}))


def test_task6_fallback_provider(monkeypatch):
    """
    Task 6: Primary provider fails, but configured fallback provider succeeds.
    """
    monkeypatch.setattr("app.main.PROVIDER_MAX_RETRIES", 0)

    class FailingPrimary(STTProvider):
        async def transcribe_chunk(self, audio_bytes: bytes, lang: str = "en"):
            raise RuntimeError("Primary provider down")

    class WorkingFallback(STTProvider):
        async def transcribe_chunk(self, audio_bytes: bytes, lang: str = "en"):
            return [STTResult(offset_start=0.1, offset_end=0.9, text="Fallback transcribed text", confidence=1.0)]

    monkeypatch.setattr("app.main.stt_provider", FailingPrimary())
    monkeypatch.setattr("app.main.fallback_stt_provider", WorkingFallback())

    client = TestClient(app)
    audio = make_in_memory_wav(duration_s=0.2, freq=440.0)

    with client.websocket_connect("/ws") as ws:
        ws.send_text(json.dumps({"type": "hello"}))
        json.loads(ws.receive_text())

        ws.send_text(json.dumps({
            "type": "chunk_meta",
            "chunk_id": 40,
            "video_start": 40.0,
            "epoch": 0
        }))
        ws.send_bytes(audio)

        sub = json.loads(ws.receive_text())
        assert sub["type"] == "subtitle"
        assert sub["chunk_id"] == 40
        assert sub["text"] == "Fallback transcribed text"

        ws.send_text(json.dumps({"type": "bye"}))


# ─── Contract Protocol Compatibility Test (docs/contract.md) ──────────────────

def test_contract_protocol_compatibility():
    """
    Verifies full compatibility with docs/contract.md:
    1. Extension/Eval sends {"type": "start", "session_id": "eval123", "translate_to": "en", ...}
    2. Server replies {"type": "ready"}
    3. Client sends {"type": "chunk", "chunk_id": 1, "epoch": 1, "video_start_time": 10.0, "playback_rate": 1.0, "sample_rate": 16000}
    4. Client sends binary PCM audio
    5. Server replies {"type": "result", "chunk_id": 1, "epoch": 1, "is_final": True, "start_offset": ..., "end_offset": ..., "lang": ..., "langs": [...]}
    6. Client advances epoch to 2 on seek, sends new chunk -> receives result with epoch 2
    7. Client sends stale chunk with old epoch 1 -> server drops it
    """
    client = TestClient(app)
    audio = make_in_memory_wav(duration_s=0.5, freq=440.0)

    with client.websocket_connect("/ws") as ws:
        # Handshake: start -> ready
        start_payload = {
            "type": "start",
            "session_id": "eval_test_session_1",
            "translate_to": "en",
            "lang_hint": "hi",
            "dual": True
        }
        ws.send_text(json.dumps(start_payload))
        ready_frame = json.loads(ws.receive_text())
        assert ready_frame["type"] == "ready"

        # Chunk 1 (epoch 1)
        chunk1 = {
            "type": "chunk",
            "chunk_id": 1,
            "epoch": 1,
            "video_start_time": 10.0,
            "playback_rate": 1.0,
            "sample_rate": 16000
        }
        ws.send_text(json.dumps(chunk1))
        ws.send_bytes(audio)

        res1 = json.loads(ws.receive_text())
        assert res1["type"] == "result"
        assert res1["chunk_id"] == 1
        assert res1["epoch"] == 1
        assert res1["is_final"] is True
        assert "start_offset" in res1 and "end_offset" in res1
        assert res1["end_offset"] > res1["start_offset"]
        assert "langs" in res1 and isinstance(res1["langs"], list)
        assert res1["text"] is not None
        assert res1["translation"] is not None

        # Seek: client advances epoch to 2
        chunk2 = {
            "type": "chunk",
            "chunk_id": 2,
            "epoch": 2,
            "video_start_time": 45.0,
            "playback_rate": 1.0,
            "sample_rate": 16000
        }
        ws.send_text(json.dumps(chunk2))
        ws.send_bytes(audio)

        res2 = json.loads(ws.receive_text())
        assert res2["type"] == "result"
        assert res2["chunk_id"] == 2
        assert res2["epoch"] == 2

        # Stale chunk with epoch 1 (Must be dropped)
        stale_chunk = {
            "type": "chunk",
            "chunk_id": 3,
            "epoch": 1,
            "video_start_time": 12.0,
            "playback_rate": 1.0,
            "sample_rate": 16000
        }
        ws.send_text(json.dumps(stale_chunk))
        ws.send_bytes(audio)

        # Confirm no response emitted for stale chunk by sending fresh chunk 4 (epoch 2)
        fresh_chunk = {
            "type": "chunk",
            "chunk_id": 4,
            "epoch": 2,
            "video_start_time": 46.0,
            "playback_rate": 1.0,
            "sample_rate": 16000
        }
        ws.send_text(json.dumps(fresh_chunk))
        ws.send_bytes(audio)

        res_fresh = json.loads(ws.receive_text())
        # The immediate next message received MUST be for chunk 4, NOT stale chunk 3!
        assert res_fresh["type"] == "result"
        assert res_fresh["chunk_id"] == 4
        assert res_fresh["epoch"] == 2



