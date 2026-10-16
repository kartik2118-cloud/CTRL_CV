import os
from typing import List
import httpx

from app.providers.base import STTProvider, STTResult


class WhisperSTTProvider(STTProvider):
    """
    Speech-to-Text provider compatible with OpenAI Whisper and Groq Whisper endpoints.
    Accepts in-memory audio bytes, requests verbose_json segment timestamps,
    and never writes audio to disk.
    """

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None
    ):
        # Allow Groq as fast alternative or standard OpenAI
        groq_key = os.getenv("GROQ_API_KEY", "")
        openai_key = os.getenv("OPENAI_API_KEY", "")

        if groq_key:
            self.api_key = api_key or groq_key
            self.endpoint = base_url or "https://api.groq.com/openai/v1/audio/transcriptions"
            self.model = model or "whisper-large-v3-turbo"
        else:
            self.api_key = api_key or openai_key
            self.endpoint = base_url or "https://api.openai.com/v1/audio/transcriptions"
            self.model = model or "whisper-1"

    async def transcribe_chunk(self, audio_bytes: bytes, lang: str = "en") -> List[STTResult]:
        if not self.api_key:
            raise ValueError(
                "Neither GROQ_API_KEY nor OPENAI_API_KEY is configured in .env. "
                "Please add a key or set STT_PROVIDER=mock for offline development."
            )

        if not audio_bytes or len(audio_bytes) < 100:
            return []

        headers = {
            "Authorization": f"Bearer {self.api_key}",
        }

        # Send in-memory bytes directly without writing to disk
        files = {
            "file": ("chunk.wav", audio_bytes, "audio/wav")
        }
        data = {
            "model": self.model,
            "language": lang.lower() if lang else "en",
            "response_format": "verbose_json",
            "temperature": "0.0"
        }

        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(self.endpoint, headers=headers, data=data, files=files)
            if response.status_code != 200:
                raise RuntimeError(f"Whisper STT API error (HTTP {response.status_code}): {response.text}")

            res_json = response.json()

        segments = res_json.get("segments", [])
        if segments:
            results = []
            for seg in segments:
                text = seg.get("text", "").strip()
                if text:
                    results.append(
                        STTResult(
                            offset_start=float(seg.get("start", 0.0)),
                            offset_end=float(seg.get("end", 1.0)),
                            text=text,
                            confidence=float(seg.get("avg_logprob", 1.0))
                        )
                    )
            if results:
                return results

        # Fallback if verbose segments are absent
        text = res_json.get("text", "").strip()
        if not text:
            return []

        return [
            STTResult(
                offset_start=0.0,
                offset_end=float(res_json.get("duration", 1.0)),
                text=text,
                confidence=1.0
            )
        ]
