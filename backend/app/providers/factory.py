import logging
from app.providers.base import STTProvider, TranslationProvider
from app.providers.mock import MockSTTProvider, MockTranslationProvider
from app.providers.sarvam import SarvamSTTProvider
from app.providers.whisper import WhisperSTTProvider

logger = logging.getLogger("livesub.providers")


def get_stt_provider(provider_name: str) -> STTProvider:
    """
    Factory function returning an instantiated STT provider.
    Enables swapping between mock, sarvam, whisper/groq/openai without modifying core server logic.
    """
    name = (provider_name or "mock").lower()

    if name == "sarvam":
        logger.info("Initializing Sarvam AI STT Provider (Saaras)")
        return SarvamSTTProvider()

    elif name in ("whisper", "groq", "openai"):
        logger.info("Initializing Whisper STT Provider (%s)", name)
        return WhisperSTTProvider(provider_type=name)

    elif name == "mock":
        logger.info("Initializing Mock STT Provider")
        return MockSTTProvider()

    else:
        logger.warning("Unknown STT provider '%s', defaulting to MockSTTProvider", provider_name)
        return MockSTTProvider()


from app.providers.translation_sarvam import SarvamTranslationProvider
from app.providers.translation_llm import LLMTranslationProvider


def get_translation_provider(provider_name: str) -> TranslationProvider:
    """
    Factory function returning an instantiated Translation provider.
    Supports 'mock', 'sarvam', 'groq', 'openai'.
    """
    name = (provider_name or "mock").lower()

    if name == "sarvam":
        logger.info("Initializing Sarvam AI Translation Provider (Mayura)")
        return SarvamTranslationProvider()

    elif name in ("groq", "openai", "llm"):
        logger.info("Initializing LLM Translation Provider (%s)", name)
        return LLMTranslationProvider(provider_type=name)

    elif name == "mock":
        logger.info("Initializing Mock Translation Provider")
        return MockTranslationProvider()

    else:
        logger.warning("Unknown translation provider '%s', defaulting to MockTranslationProvider", provider_name)
        return MockTranslationProvider()

