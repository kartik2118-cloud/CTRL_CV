import os
from typing import List
import httpx

from app.providers.base import STTProvider, STTResult
from app.audio_utils import ensure_wav_bytes


class SarvamSTTProvider(STTProvider):
    """
    Speech-to-Text provider using Sarvam AI (Saaras-v2 / Saaras-v1).
    Specialized for Indian languages (hi, mr, ta, te, kn, gu, etc.) and Indian English.
    Processes audio completely in memory. Never saves audio to disk.
    """

    API_URL = "https://api.sarvam.ai/speech-to-text"

    # Map standard language codes to Sarvam language tags
    LANGUAGE_MAP = {
        "hi": "hi-IN",
        "mr": "mr-IN",
        "ta": "ta-IN",
        "te": "te-IN",
        "kn": "kn-IN",
        "gu": "gu-IN",
        "bn": "bn-IN",
        "pa": "pa-IN",
        "ml": "ml-IN",
        "od": "od-IN",
        "en": "en-IN",
    }

    def __init__(self, api_key: str | None = None, model: str | None = None):
        self.api_key = api_key or os.getenv("SARVAM_API_KEY", "")
        self.model = model or os.getenv("SARVAM_STT_MODEL", "saaras:v3")

    async def transcribe_chunk(self, audio_bytes: bytes, lang: str = "hi") -> List[STTResult]:
        if not self.api_key:
            raise ValueError(
                "SARVAM_API_KEY is not configured in .env. "
                "Please add SARVAM_API_KEY or set STT_PROVIDER=mock for offline development."
            )

        if not audio_bytes or len(audio_bytes) < 100:
            return []

        sarvam_lang = self.LANGUAGE_MAP.get(lang.lower(), f"{lang.lower()}-IN")

        headers = {
            "api-subscription-key": self.api_key,
        }

        # Send in-memory bytes as multipart form data. Never writes to disk.
        wav_payload = ensure_wav_bytes(audio_bytes)
        files = {
            "file": ("chunk.wav", wav_payload, "audio/wav")
        }
        data = {
            "model": self.model,
            "language_code": sarvam_lang,
            "with_diarization": "false"
        }

        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(self.API_URL, headers=headers, data=data, files=files)
            if response.status_code != 200:
                error_detail = response.text
                raise RuntimeError(f"Sarvam STT API error (HTTP {response.status_code}): {error_detail}")

            res_json = response.json()

        transcript = res_json.get("transcript", "").strip()
        if not transcript:
            return []

        # Parse word or segment timestamps if provided by Sarvam
        timestamps = res_json.get("timestamps") or {}
        words = timestamps.get("words", [])

        if words:
            offset_start = float(words[0].get("start", 0.0))
            offset_end = float(words[-1].get("end", offset_start + 0.5))
            if offset_end <= offset_start:
                offset_end = offset_start + 0.5
        else:
            est_duration = max(0.5, round(len(audio_bytes) / 32000.0, 2))
            offset_start = 0.0
            offset_end = est_duration

        return [
            STTResult(
                offset_start=offset_start,
                offset_end=offset_end,
                text=transcript,
                confidence=1.0
            )
        ]
