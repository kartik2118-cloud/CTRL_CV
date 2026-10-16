import os
import sys
from pathlib import Path
from dotenv import load_dotenv

# Load .env file from backend root directory if present
env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=env_path)

HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))
DEBUG = os.getenv("DEBUG", "false").lower() in ("true", "1", "yes")

# Providers (must be explicitly configured)
STT_PROVIDER_RAW = os.getenv("STT_PROVIDER")
TRANSLATION_PROVIDER_RAW = os.getenv("TRANSLATION_PROVIDER")
if STT_PROVIDER_RAW and STT_PROVIDER_RAW.strip().lower() == "mock" and not TRANSLATION_PROVIDER_RAW:
    TRANSLATION_PROVIDER_RAW = "mock"

# API Keys (Loaded from .env only; never hardcoded)
SARVAM_API_KEY = os.getenv("SARVAM_API_KEY", "").strip()
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()

# Security & limits
AUTH_TOKEN = os.getenv("AUTH_TOKEN", "").strip()
ALLOWED_ORIGINS_RAW = os.getenv("ALLOWED_ORIGINS", "*")
ALLOWED_ORIGINS = [o.strip() for o in ALLOWED_ORIGINS_RAW.split(",") if o.strip()] if ALLOWED_ORIGINS_RAW != "*" else ["*"]
MAX_CHUNK_BYTES = int(os.getenv("MAX_CHUNK_BYTES", "262144"))  # 256 KB default
MAX_SESSIONS = int(os.getenv("MAX_SESSIONS", "20"))
IDLE_TIMEOUT_SECONDS = float(os.getenv("IDLE_TIMEOUT_SECONDS", "120.0"))
MAX_CHUNKS_PER_SECOND = float(os.getenv("MAX_CHUNKS_PER_SECOND", "5.0"))

# Provider error handling & resilience
PROVIDER_TIMEOUT_SECONDS = float(os.getenv("PROVIDER_TIMEOUT_SECONDS", "8.0"))
PROVIDER_MAX_RETRIES = int(os.getenv("PROVIDER_MAX_RETRIES", "2"))
PROVIDER_RETRY_BACKOFF = float(os.getenv("PROVIDER_RETRY_BACKOFF", "0.5"))
FALLBACK_STT_PROVIDER = os.getenv("FALLBACK_STT_PROVIDER", "").strip().lower()
FALLBACK_TRANSLATION_PROVIDER = os.getenv("FALLBACK_TRANSLATION_PROVIDER", "").strip().lower()

# Audio filtering & quality
VAD_ENERGY_THRESHOLD = float(os.getenv("VAD_ENERGY_THRESHOLD", "0.005"))
WHISPER_NO_SPEECH_THRESHOLD = float(os.getenv("WHISPER_NO_SPEECH_THRESHOLD", "0.6"))
WHISPER_MIN_AVG_LOGPROB = float(os.getenv("WHISPER_MIN_AVG_LOGPROB", "-1.2"))
FILTER_HALLUCINATIONS = os.getenv("FILTER_HALLUCINATIONS", "true").lower() in ("true", "1", "yes")


def validate_config():
    """
    Task 2: Fail fast on missing configuration.
    Mock mode is allowed ONLY when explicitly set to 'mock'.
    If no provider is specified or required keys are missing, raise ValueError or exit.
    """
    if not STT_PROVIDER_RAW:
        raise ValueError(
            "STT_PROVIDER environment variable is missing. "
            "Set STT_PROVIDER=mock explicitly for mock mode, or STT_PROVIDER=sarvam/groq/openai."
        )

    stt_name = STT_PROVIDER_RAW.strip().lower()
    if stt_name not in ("mock", "sarvam", "whisper", "groq", "openai"):
        raise ValueError(f"Unsupported STT_PROVIDER: '{STT_PROVIDER_RAW}'")

    if stt_name == "sarvam" and not SARVAM_API_KEY:
        raise ValueError(
            "SARVAM_API_KEY is missing from environment. "
            "Please provide SARVAM_API_KEY in .env or environment variables."
        )
    elif stt_name in ("whisper", "groq") and not (GROQ_API_KEY or OPENAI_API_KEY):
        raise ValueError(
            "GROQ_API_KEY or OPENAI_API_KEY is missing from environment for Whisper/Groq provider. "
            "Please provide GROQ_API_KEY in .env or environment variables."
        )
    elif stt_name == "openai" and not OPENAI_API_KEY:
        raise ValueError(
            "OPENAI_API_KEY is missing from environment for OpenAI provider. "
            "Please provide OPENAI_API_KEY in .env or environment variables."
        )

    # Translation provider check
    if not TRANSLATION_PROVIDER_RAW:
        raise ValueError(
            "TRANSLATION_PROVIDER environment variable is missing. "
            "Set TRANSLATION_PROVIDER=mock explicitly for mock mode, or TRANSLATION_PROVIDER=sarvam/groq/openai."
        )

    trans_name = TRANSLATION_PROVIDER_RAW.strip().lower()
    if trans_name not in ("mock", "sarvam", "groq", "openai", "llm"):
        raise ValueError(f"Unsupported TRANSLATION_PROVIDER: '{TRANSLATION_PROVIDER_RAW}'")

    if trans_name == "sarvam" and not SARVAM_API_KEY:
        raise ValueError(
            "SARVAM_API_KEY is missing from environment for Sarvam translation provider. "
            "Please provide SARVAM_API_KEY in .env or environment variables."
        )
    elif trans_name in ("groq", "llm") and not (GROQ_API_KEY or OPENAI_API_KEY):
        raise ValueError(
            "GROQ_API_KEY or OPENAI_API_KEY is missing from environment for LLM translation provider. "
            "Please provide GROQ_API_KEY in .env or environment variables."
        )
    elif trans_name == "openai" and not OPENAI_API_KEY:
        raise ValueError(
            "OPENAI_API_KEY is missing from environment for OpenAI translation provider. "
            "Please provide OPENAI_API_KEY in .env or environment variables."
        )


# Run validation on import
validate_config()

STT_PROVIDER = STT_PROVIDER_RAW.strip().lower()
TRANSLATION_PROVIDER = TRANSLATION_PROVIDER_RAW.strip().lower()
IS_MOCK = (STT_PROVIDER == "mock" or TRANSLATION_PROVIDER == "mock")
