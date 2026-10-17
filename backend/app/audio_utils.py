import io
import math
import struct
import wave
import re
from typing import Optional

# Common silence/hallucination phrases produced by Whisper on music or low speech
HALLUCINATION_PATTERNS = [
    re.compile(r"thank\s+you\s+(for\s+)?watching", re.I),
    re.compile(r"thanks\s+for\s+watching", re.I),
    re.compile(r"please\s+subscribe", re.I),
    re.compile(r"subtitles\s+by", re.I),
    re.compile(r"like\s+and\s+subscribe", re.I),
    re.compile(r"see\s+you\s+in\s+the\s+next\s+video", re.I),
    re.compile(r"bye\s+bye", re.I),
    re.compile(r"translated\s+by", re.I),
    re.compile(r"you\s*$", re.I),
    re.compile(r"^[\.\,\!\?\s\-\–\—]+$"),
]


def ensure_wav_bytes(audio_bytes: bytes, sample_rate: int = 16000, channels: int = 1, sampwidth: int = 2) -> bytes:
    """
    Ensures in-memory audio bytes have a valid WAV RIFF header.
    If the bytes already start with 'RIFF', returns them as-is.
    If raw PCM, wraps it in a standard 44-byte WAV header completely in memory.
    Never writes to disk.
    """
    if not audio_bytes:
        return b""
    if audio_bytes.startswith(b"RIFF"):
        return audio_bytes
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(sampwidth)
        wf.setframerate(sample_rate)
        wf.writeframes(audio_bytes)
    return buf.getvalue()


def compute_audio_energy(audio_bytes: bytes) -> float:
    """
    Computes RMS (Root Mean Square) energy of 16-bit PCM audio samples.
    If the audio contains a WAV header, skip the 44-byte header.
    Returns normalized RMS value between 0.0 and 1.0.
    """
    if len(audio_bytes) < 4:
        return 0.0

    raw = audio_bytes
    # Check for RIFF header
    if raw.startswith(b"RIFF") and len(raw) > 44:
        raw = raw[44:]

    # Ensure even number of bytes for 16-bit samples
    num_samples = len(raw) // 2
    if num_samples == 0:
        return 0.0

    fmt = f"<{num_samples}h"
    try:
        samples = struct.unpack(fmt, raw[: num_samples * 2])
    except Exception:
        return 1.0  # Fallback to passing if unpack fails

    sum_sq = sum(s * s for s in samples)
    mean_sq = sum_sq / num_samples
    rms = math.sqrt(mean_sq)
    # 16-bit max is 32767
    return rms / 32767.0


def is_silence_chunk(audio_bytes: bytes, threshold: float = 0.005) -> bool:
    """
    Returns True if the audio chunk's RMS energy is below the silence threshold.
    """
    if not audio_bytes or len(audio_bytes) < 100:
        return True
    energy = compute_audio_energy(audio_bytes)
    return energy < threshold


def is_hallucination_text(text: str) -> bool:
    """
    Checks if transcribed text matches known Whisper silence hallucinations.
    """
    clean = text.strip()
    if not clean:
        return True
    for pat in HALLUCINATION_PATTERNS:
        if pat.search(clean):
            return True
    return False


def deduplicate_seam(prev_text: str, curr_text: str) -> str:
    """
    De-duplicates repeated overlapping words at chunk boundaries.
    E.g.: prev="welcome to our", curr="to our channel" -> curr="channel"
    """
    prev_words = prev_text.strip().split()
    curr_words = curr_text.strip().split()

    if not prev_words or not curr_words:
        return curr_text.strip()

    # Check for overlaps of length 1 to min(len(prev), len(curr))
    max_check = min(len(prev_words), len(curr_words), 5)
    best_overlap = 0

    for k in range(1, max_check + 1):
        if [w.lower() for w in prev_words[-k:]] == [w.lower() for w in curr_words[:k]]:
            best_overlap = k

    if best_overlap > 0:
        remaining = curr_words[best_overlap:]
        return " ".join(remaining)

    return curr_text.strip()
