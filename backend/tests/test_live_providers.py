import asyncio
import io
import math
import os
import struct
import sys
import time
import wave
from pathlib import Path
import pytest
from dotenv import load_dotenv

# Ensure backend root is in sys.path and load .env regardless of working directory
backend_dir = Path(__file__).resolve().parent.parent
if str(backend_dir) not in sys.path:
    sys.path.insert(0, str(backend_dir))
load_dotenv(dotenv_path=backend_dir / ".env")

from app.providers.factory import get_stt_provider
from app.providers.base import STTProvider, STTResult

HAS_LIVE_KEY = bool(
    os.getenv("SARVAM_API_KEY") or os.getenv("GROQ_API_KEY") or os.getenv("OPENAI_API_KEY")
)


def generate_speech_like_in_memory_wav(duration_s: float = 2.0, sample_rate: int = 16000) -> bytes:
    """
    Generates a 2-second in-memory audio buffer synthesized with multiple harmonic
    frequencies (150Hz, 300Hz, 1200Hz, 2400Hz) simulating voice formants.
    Never touches disk.
    """
    num_samples = int(duration_s * sample_rate)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        raw = bytearray()
        for i in range(num_samples):
            t = i / sample_rate
            # Voice-like harmonics
            v = (
                0.5 * math.sin(2.0 * math.pi * 150.0 * t)
                + 0.3 * math.sin(2.0 * math.pi * 300.0 * t)
                + 0.15 * math.sin(2.0 * math.pi * 1200.0 * t)
                + 0.05 * math.sin(2.0 * math.pi * 2400.0 * t)
            )
            val = int(v * 16000.0)
            raw.extend(struct.pack("<h", max(-32768, min(32767, val))))
        wf.writeframes(raw)
    return buffer.getvalue()


@pytest.mark.live
@pytest.mark.skipif(not HAS_LIVE_KEY, reason="Live cloud API keys not configured in environment (Project Rule 1)")
@pytest.mark.asyncio
async def test_live_provider_latency():
    """
    Task 10: Live Provider Performance & Latency SLA Verification.
    Runs multiple chunk transcriptions against the configured cloud provider,
    records per-chunk latency, and verifies performance against targets:
      * Target Median: <= 3.0 s
      * Target p90:    <= 5.0 s
    """
    stt_choice = os.getenv("STT_PROVIDER", "sarvam").lower()
    provider: STTProvider = get_stt_provider(stt_choice)

    audio_bytes = generate_speech_like_in_memory_wav(duration_s=2.0)
    latencies = []

    print(f"\n--- Live STT Benchmark: Provider = {stt_choice.upper()} ---")

    # Send 3 benchmark chunks
    num_runs = 3
    for idx in range(num_runs):
        t0 = time.perf_counter()
        results = await provider.transcribe_chunk(audio_bytes, lang="en" if stt_choice == "groq" else "hi")
        elapsed = time.perf_counter() - t0
        latencies.append(elapsed)
        print(f"  Chunk {idx + 1}/{num_runs}: Latency = {elapsed:.3f} s, Results count = {len(results)}")

    latencies.sort()
    median_lat = latencies[len(latencies) // 2]
    # p90 calculation
    p90_idx = max(0, int(math.ceil(0.9 * len(latencies))) - 1)
    p90_lat = latencies[p90_idx]

    print("\n" + "=" * 65)
    print(" LIVE STT LATENCY REPORT")
    print("=" * 65)
    print(f" Provider         : {stt_choice.upper()}")
    print(f" Samples Tested   : {len(latencies)}")
    print(f" Median Latency   : {median_lat:.3f} s (Target: <= 3.000 s)")
    print(f" p90 Latency      : {p90_lat:.3f} s (Target: <= 5.000 s)")
    print("=" * 65)

    assert median_lat <= 3.0, f"Median latency {median_lat:.3f}s exceeded target of 3.0s"
    assert p90_lat <= 5.0, f"p90 latency {p90_lat:.3f}s exceeded target of 5.0s"
