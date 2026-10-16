import os
import httpx
from app.providers.base import TranslationProvider


class LLMTranslationProvider(TranslationProvider):
    """
    Translation provider using Groq or OpenAI fast chat completion models
    (e.g. Llama-3.3-70b-versatile or GPT-4o-mini).
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
        p_type = (provider_type or os.getenv("TRANSLATION_PROVIDER", "")).strip().lower()

        if p_type == "openai" or (openai_key and not groq_key and p_type not in ("groq", "llm")):
            self.api_key = api_key or openai_key
            self.endpoint = base_url or "https://api.openai.com/v1/chat/completions"
            self.model = model or os.getenv("OPENAI_TRANSLATION_MODEL", "gpt-4o-mini")
        else:
            self.api_key = api_key or groq_key or openai_key
            self.endpoint = base_url or "https://api.groq.com/openai/v1/chat/completions"
            self.model = model or os.getenv("GROQ_TRANSLATION_MODEL", "qwen/qwen3.8-27b")

        self._cache: dict[tuple[str, str, str], str] = {}

    async def translate(self, text: str, source_lang: str, target_lang: str) -> str:
        clean_text = text.strip()
        if not clean_text:
            return ""

        if source_lang.lower() == target_lang.lower():
            return clean_text

        cache_key = (clean_text, source_lang.lower(), target_lang.lower())
        if cache_key in self._cache:
            return self._cache[cache_key]

        if not self.api_key:
            raise ValueError(
                "Neither GROQ_API_KEY nor OPENAI_API_KEY is configured in .env. "
                "Please add a key or set TRANSLATION_PROVIDER=mock for offline development."
            )

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }

        prompt = (
            f"You are a subtitle translator. Translate the following speech text from {source_lang} to {target_lang}.\n"
            f"Output ONLY the translated subtitle text, with no explanations, no formatting, and no quotation marks.\n\n"
            f"Source text: {clean_text}"
        )

        payload = {
            "model": self.model,
            "messages": [
                {"role": "user", "content": prompt}
            ],
            "temperature": 0.1,
            "max_tokens": 128
        }

        async with httpx.AsyncClient(timeout=8.0) as client:
            response = await client.post(self.endpoint, headers=headers, json=payload)
            if response.status_code != 200:
                raise RuntimeError(
                    f"LLM Translation API error (HTTP {response.status_code}): {response.text}"
                )
            res_json = response.json()

        choices = res_json.get("choices", [])
        if choices:
            translated = choices[0].get("message", {}).get("content", "").strip()
            # Strip accidental surrounding quotes if present
            if (translated.startswith('"') and translated.endswith('"')) or (
                translated.startswith("'") and translated.endswith("'")
            ):
                translated = translated[1:-1].strip()
        else:
            translated = clean_text

        if len(self._cache) > 1000:
            self._cache.clear()
        self._cache[cache_key] = translated

        return translated
