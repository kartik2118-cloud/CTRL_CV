import asyncio
import io
import math
import struct
import sys
import wave
from pathlib import Path

# Add backend root directory to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

from app.providers.base import STTResult
from app.providers.factory import get_stt_provider
from app.providers.mock import MockSTTProvider
from app.providers.sarvam import SarvamSTTProvider
from app.providers.whisper import WhisperSTTProvider


def generate_in_memory_wav(duration_s: float = 1.0, sample_rate: int = 16000) -> bytes:
    """
    Generates a 1-second in-memory mono PCM WAV audio buffer.
    Never touches disk.
    """
    num_samples = int(duration_s * sample_rate)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wf:
        wf.setnchannels(1)        # Mono
        wf.setsampwidth(2)        # 16-bit
        wf.setframerate(sample_rate)
        # Generate 440 Hz tone
        raw_samples = bytearray()
        for i in range(num_samples):
            val = int(16000.0 * math.sin(2.0 * math.pi * 440.0 * (i / sample_rate)))
            raw_samples.extend(struct.pack("<h", val))
        wf.writeframes(raw_samples)
    return buffer.getvalue()


async def run_tests():
    print("=" * 65)
    print(" LiveSub Real STT Provider Interface & In-Memory Audio Tests")
    print("=" * 65)

    audio_bytes = generate_in_memory_wav(duration_s=1.0)
    print(f"\n[1] Generated {len(audio_bytes)} bytes of synthetic in-memory WAV audio.")
    print("  PASS: In-memory generation verified (no disk files created).\n")

    # ── Test 1: Factory Resolution ──────────────────────────────────────────
    print("[2] Testing STT Provider Factory resolution...")
    p_mock = get_stt_provider("mock")
    assert isinstance(p_mock, MockSTTProvider)

    p_sarvam = get_stt_provider("sarvam")
    assert isinstance(p_sarvam, SarvamSTTProvider)

    p_whisper = get_stt_provider("whisper")
    assert isinstance(p_whisper, WhisperSTTProvider)
    print("  PASS: Factory correctly resolves 'mock', 'sarvam', and 'whisper'.\n")

    # ── Test 2: Mock STT Provider ───────────────────────────────────────────
    print("[3] Testing MockSTTProvider with in-memory audio...")
    results = await p_mock.transcribe_chunk(audio_bytes, lang="hi")
    assert len(results) > 0
    seg = results[0]
    assert isinstance(seg, STTResult)
    assert 0.0 <= seg.offset_start < seg.offset_end <= 1.0
    print(f"  <- Mock Result: text='{seg.text}', offset=[{seg.offset_start}s - {seg.offset_end}s]")
    print("  PASS: Mock STT returns well-formed STTResult.\n")

    # ── Test 3: Sarvam STT Provider ─────────────────────────────────────────
    print("[4] Testing SarvamSTTProvider guard & configuration...")
    if not p_sarvam.api_key:
        print("  Notice: SARVAM_API_KEY is not set in environment (expected for offline test).")
        try:
            await p_sarvam.transcribe_chunk(audio_bytes, lang="hi")
            print("  FAIL: Should have raised ValueError for missing key.")
            sys.exit(1)
        except ValueError as e:
            print(f"  PASS: Raised expected configuration error: {e}\n")
    else:
        print("  SARVAM_API_KEY detected. Performing live API transcription...")
        live_res = await p_sarvam.transcribe_chunk(audio_bytes, lang="hi")
        print(f"  <- Live Sarvam Result: {live_res}")
        print("  PASS: Live Sarvam STT call succeeded.\n")

    # ── Test 4: Whisper STT Provider ────────────────────────────────────────
    print("[5] Testing WhisperSTTProvider guard & configuration...")
    if not p_whisper.api_key:
        print("  Notice: GROQ_API_KEY / OPENAI_API_KEY is not set (expected for offline test).")
        try:
            await p_whisper.transcribe_chunk(audio_bytes, lang="en")
            print("  FAIL: Should have raised ValueError for missing key.")
            sys.exit(1)
        except ValueError as e:
            print(f"  PASS: Raised expected configuration error: {e}\n")
    else:
        print("  Whisper API key detected. Performing live API transcription...")
        live_res = await p_whisper.transcribe_chunk(audio_bytes, lang="en")
        print(f"  <- Live Whisper Result: {live_res}")
        print("  PASS: Live Whisper STT call succeeded.\n")

    print("=" * 65)
    print(" ALL REAL STT PROVIDER TESTS PASSED: Ready for Step 2 Deployment!")
    print("=" * 65)


if __name__ == "__main__":
    asyncio.run(run_tests())
