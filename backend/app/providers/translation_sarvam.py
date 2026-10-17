import os
import httpx
from app.providers.base import TranslationProvider


class SarvamTranslationProvider(TranslationProvider):
    """
    Translation provider using Sarvam AI Mayura (mayura:v1).
    Translates accurately between Indic languages (hi, mr, ta, te, etc.) and English.
    """

    API_URL = "https://api.sarvam.ai/translate"

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
        self.model = model or os.getenv("SARVAM_TRANSLATION_MODEL", "mayura:v1")
        self._cache: dict[tuple[str, str, str], str] = {}

    def _normalize_lang(self, code: str) -> str:
        code_clean = code.strip().lower()
        return self.LANGUAGE_MAP.get(code_clean, f"{code_clean}-IN")

    async def translate(self, text: str, source_lang: str, target_lang: str) -> str:
        clean_text = text.strip()
        if not clean_text:
            return ""

        if source_lang.lower() == target_lang.lower():
            return clean_text

        # In-memory cache lookup
        cache_key = (clean_text, source_lang.lower(), target_lang.lower())
        if cache_key in self._cache:
            return self._cache[cache_key]

        if not self.api_key:
            raise ValueError(
                "SARVAM_API_KEY is not configured in .env. "
                "Please add SARVAM_API_KEY or set TRANSLATION_PROVIDER=mock for offline development."
            )

        headers = {
            "api-subscription-key": self.api_key,
            "Content-Type": "application/json"
        }

        src_tag = self._normalize_lang(source_lang)
        tgt_tag = self._normalize_lang(target_lang)

        payload = {
            "input": clean_text,
            "source_language_code": src_tag,
            "target_language_code": tgt_tag,
            "speaker_gender": "Male",
            "mode": "formal",
            "model": self.model
        }

        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.post(self.API_URL, headers=headers, json=payload)
            if response.status_code != 200:
                raise RuntimeError(
                    f"Sarvam Translation API error (HTTP {response.status_code}): {response.text}"
                )
            res_json = response.json()

        translated = res_json.get("translated_text", "").strip() or clean_text

        # Cache result (limit cache size to 1000 items)
        if len(self._cache) > 1000:
            self._cache.clear()
        self._cache[cache_key] = translated

        return translated
