import asyncio
from typing import List
from app.providers.base import STTProvider, TranslationProvider, STTResult


class MockSTTProvider(STTProvider):
    """
    Mock STT provider for Step 1 development, local testing, and offline verification.
    Processes audio completely in memory and generates deterministic speech segments.
    """

    def __init__(self, simulated_delay_ms: int = 50):
        self.simulated_delay_ms = simulated_delay_ms
        self._sample_counter = 0

    async def transcribe_chunk(self, audio_bytes: bytes, lang: str = "en") -> List[STTResult]:
        # Respect latency simulation if configured
        if self.simulated_delay_ms > 0:
            await asyncio.sleep(self.simulated_delay_ms / 1000.0)

        self._sample_counter += 1

        # Preset realistic phrases for testing
        phrases = {
            "hi": [
                "नमस्ते दोस्तों, आपका स्वागत है",
                "आज हम एक नया विषय सीखने जा रहे हैं",
                "इस वीडियो को अंत तक जरूर देखें",
                "अगर आपको यह पसंद आए तो लाइक करें"
            ],
            "en": [
                "Hello everyone and welcome back",
                "Today we are exploring live synchronized subtitles",
                "Notice how smoothly the captions follow the video",
                "Let us test seeking and playback rate changes"
            ]
        }

        lang_phrases = phrases.get(lang, phrases["en"])
        selected_text = lang_phrases[(self._sample_counter - 1) % len(lang_phrases)]

        # Relative offsets in seconds inside a 1-second chunk
        return [
            STTResult(
                offset_start=0.1,
                offset_end=0.9,
                text=selected_text,
                confidence=0.98
            )
        ]


class MockTranslationProvider(TranslationProvider):
    """
    Mock translation provider for testing multilingual display.
    """

    async def translate(self, text: str, source_lang: str, target_lang: str) -> str:
        if source_lang.lower() == target_lang.lower():
            return text
        return f"[{target_lang.upper()}] {text}"
