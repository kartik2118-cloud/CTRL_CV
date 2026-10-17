import os
from typing import List
import httpx

from app.providers.base import STTProvider, STTResult
from app.config import (
    WHISPER_NO_SPEECH_THRESHOLD,
    WHISPER_MIN_AVG_LOGPROB,
    FILTER_HALLUCINATIONS,
    PROVIDER_TIMEOUT_SECONDS,
)
from app.audio_utils import is_hallucination_text, ensure_wav_bytes


class WhisperSTTProvider(STTProvider):
    """
    Speech-to-Text provider compatible with OpenAI Whisper and Groq Whisper endpoints.
    Accepts in-memory audio bytes, requests verbose_json segment timestamps,
    filters low confidence/hallucinations, and never writes audio to disk.
    """

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
        provider_type: str | None = None,
    ):
        groq_key = os.getenv("GROQ_API_KEY", "").strip()
        openai_key = os.getenv("OPENAI_API_KEY", "").strip()
        p_type = (provider_type or os.getenv("STT_PROVIDER", "")).strip().lower()

        if p_type == "openai" or (openai_key and not groq_key and p_type != "groq"):
            self.api_key = api_key or openai_key
            self.endpoint = base_url or "https://api.openai.com/v1/audio/transcriptions"
            self.model = model or os.getenv("OPENAI_WHISPER_MODEL", "whisper-1")
        else:
            self.api_key = api_key or groq_key or openai_key
            self.endpoint = base_url or "https://api.groq.com/openai/v1/audio/transcriptions"
            self.model = model or os.getenv("GROQ_WHISPER_MODEL", "whisper-large-v3-turbo")

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
        wav_payload = ensure_wav_bytes(audio_bytes)
        files = {
            "file": ("chunk.wav", wav_payload, "audio/wav")
        }
        data = {
            "model": self.model,
            "response_format": "verbose_json",
            "temperature": "0.0"
        }
        if lang and lang.lower() not in ("auto", "none", ""):
            data["language"] = lang.lower()

        async with httpx.AsyncClient(timeout=PROVIDER_TIMEOUT_SECONDS) as client:
            response = await client.post(self.endpoint, headers=headers, data=data, files=files)
            if response.status_code != 200:
                raise RuntimeError(f"Whisper STT API error (HTTP {response.status_code}): {response.text}")

            res_json = response.json()

        segments = res_json.get("segments", [])
        if segments:
            results = []
            for seg in segments:
                text = seg.get("text", "").strip()
                if not text:
                    continue

                no_speech_prob = float(seg.get("no_speech_prob", 0.0))
                avg_logprob = float(seg.get("avg_logprob", 0.0))

                # Task 7: Filter high no_speech_prob or low confidence
                if no_speech_prob > WHISPER_NO_SPEECH_THRESHOLD:
                    continue
                if avg_logprob < WHISPER_MIN_AVG_LOGPROB:
                    continue

                # Filter hallucination phrases on low confidence
                if FILTER_HALLUCINATIONS and is_hallucination_text(text):
                    continue

                start_sec = float(seg.get("start", 0.0))
                end_sec = float(seg.get("end", start_sec + 0.5))
                if end_sec <= start_sec:
                    end_sec = start_sec + 0.5

                results.append(
                    STTResult(
                        offset_start=start_sec,
                        offset_end=end_sec,
                        text=text,
                        confidence=avg_logprob
                    )
                )
            if results:
                return results

        # Fallback if verbose segments are absent
        text = res_json.get("text", "").strip()
        if not text or (FILTER_HALLUCINATIONS and is_hallucination_text(text)):
            return []

        dur_val = float(res_json.get("duration", 1.0))
        return [
            STTResult(
                offset_start=0.0,
                offset_end=max(dur_val, 0.5),
                text=text,
                confidence=1.0
            )
        ]
