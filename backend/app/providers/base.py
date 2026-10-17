from abc import ABC, abstractmethod
from typing import List, Optional
from pydantic import BaseModel


class STTResult(BaseModel):
    """
    Speech-to-text result relative to the chunk boundaries.
    offset_start and offset_end are seconds from the beginning of the chunk (0.0 to chunk_duration).
    """
    offset_start: float
    offset_end: float
    text: str
    confidence: float = 1.0
    lang: Optional[str] = None


class STTProvider(ABC):
    """
    Abstract interface for Speech-to-Text providers.
    Allows hot-swapping between Mock, Sarvam, OpenAI Whisper, Deepgram, etc.
    """

    @abstractmethod
    async def transcribe_chunk(self, audio_bytes: bytes, lang: str = "en") -> List[STTResult]:
        """
        Takes raw audio bytes in memory (never saved to disk) and returns transcribed segments.
        """
        pass


class TranslationProvider(ABC):
    """
    Abstract interface for Machine Translation providers.
    Allows hot-swapping between Mock, Sarvam, Google, OpenAI, etc.
    """

    @abstractmethod
    async def translate(self, text: str, source_lang: str, target_lang: str) -> str:
        """
        Translates text from source_lang to target_lang.
        """
        pass
