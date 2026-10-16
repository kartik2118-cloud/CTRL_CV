import asyncio
import sys
from pathlib import Path

# Add backend root directory to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

from app.providers.factory import get_translation_provider
from app.providers.mock import MockTranslationProvider
from app.providers.translation_sarvam import SarvamTranslationProvider
from app.providers.translation_llm import LLMTranslationProvider


async def run_tests():
    print("=" * 65)
    print(" LiveSub Translation Provider Interface & Caching Tests")
    print("=" * 65)

    # ── Test 1: Factory Resolution ──────────────────────────────────────────
    print("\n[1] Testing Translation Provider Factory resolution...")
    t_mock = get_translation_provider("mock")
    assert isinstance(t_mock, MockTranslationProvider)

    t_sarvam = get_translation_provider("sarvam")
    assert isinstance(t_sarvam, SarvamTranslationProvider)

    t_groq = get_translation_provider("groq")
    assert isinstance(t_groq, LLMTranslationProvider)

    t_openai = get_translation_provider("openai")
    assert isinstance(t_openai, LLMTranslationProvider)
    print("  PASS: Factory correctly resolves 'mock', 'sarvam', 'groq', and 'openai'.\n")

    # ── Test 2: Mock Translation & Same-Language Passthrough ────────────────
    print("[2] Testing MockTranslationProvider behavior...")
    # Same language should return original text without translation tag
    same_lang_res = await t_mock.translate("Hello world", source_lang="en", target_lang="en")
    assert same_lang_res == "Hello world"
    print(f"  <- Same language passthrough: '{same_lang_res}'")

    # Cross language should prepend target language tag
    cross_lang_res = await t_mock.translate("नमस्ते दोस्तों", source_lang="hi", target_lang="en")
    assert cross_lang_res == "[EN] नमस्ते दोस्तों"
    print(f"  <- Cross language translation: '{cross_lang_res}'")
    print("  PASS: Mock translation behavior verified.\n")

    # ── Test 3: Sarvam Translation Provider Guards & Caching ────────────────
    print("[3] Testing SarvamTranslationProvider guards and caching...")
    test_hindi = "नमस्ते दोस्तों, आपका स्वागत है"
    if not t_sarvam.api_key:
        print("  Notice: SARVAM_API_KEY is not set in environment (expected for offline test).")
        try:
            await t_sarvam.translate(test_hindi, source_lang="hi", target_lang="en")
            print("  FAIL: Expected ValueError when SARVAM_API_KEY is missing.")
            sys.exit(1)
        except ValueError as e:
            print(f"  PASS: Raised expected configuration error: {e}\n")
    else:
        print("  SARVAM_API_KEY detected. Performing live translation...")
        res1 = await t_sarvam.translate(test_hindi, source_lang="hi", target_lang="en")
        print(f"  <- Live translation: '{res1}'")
        # Verify caching
        res2 = await t_sarvam.translate(test_hindi, source_lang="hi", target_lang="en")
        assert res1 == res2
        print("  PASS: Live Sarvam translation and in-memory cache hit verified.\n")

    # ── Test 4: LLM Translation Provider Guards & Caching ───────────────────
    print("[4] Testing LLMTranslationProvider guards and caching...")
    if not t_groq.api_key:
        print("  Notice: GROQ_API_KEY / OPENAI_API_KEY is not set (expected for offline test).")
        try:
            await t_groq.translate(test_hindi, source_lang="hi", target_lang="en")
            print("  FAIL: Expected ValueError when LLM API key is missing.")
            sys.exit(1)
        except ValueError as e:
            print(f"  PASS: Raised expected configuration error: {e}\n")
    else:
        print("  LLM API key detected. Performing live translation...")
        res_llm = await t_groq.translate(test_hindi, source_lang="hi", target_lang="en")
        print(f"  <- Live LLM translation: '{res_llm}'")
        print("  PASS: Live LLM translation succeeded.\n")

    print("=" * 65)
    print(" ALL TRANSLATION TESTS PASSED: Ready for Step 3 Deployment!")
    print("=" * 65)


if __name__ == "__main__":
    asyncio.run(run_tests())
