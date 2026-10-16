import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env file from backend root directory if present
env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(dotenv_path=env_path)

HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))
DEBUG = os.getenv("DEBUG", "false").lower() in ("true", "1", "yes")

STT_PROVIDER = os.getenv("STT_PROVIDER", "mock")
TRANSLATION_PROVIDER = os.getenv("TRANSLATION_PROVIDER", "mock")

# API Keys (Loaded from .env only; never hardcoded)
SARVAM_API_KEY = os.getenv("SARVAM_API_KEY", "")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
