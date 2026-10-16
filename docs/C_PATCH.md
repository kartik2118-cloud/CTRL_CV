# Backend Implementation Patches (Role C Guide)

This document provides unified diffs for the `backend/` codebase to align with the streaming WebSocket contract (`docs/contract.md`), implement language auto-detection with ISO normalization, session language locking, script-share code-mixed language detection, and contract-compliant result frames.

---

## 1. Unified Diff: `backend/app/providers/whisper.py`

### Changes:
- **Language Normalization Map**: Maps Whisper verbose output strings (e.g. `"hindi"`, `"marathi"`) to standard ISO 639-1 codes (`"hi"`, `"mr"`, `"ta"`, `"te"`, `"en"`). Maps unrecognized languages to `None`.
- **Auto-Detection Request**: Omits the `"language"` parameter when `lang` is `"auto"`, `""`, or `None` so Whisper executes native language identification.
- **Word Timestamps**: Requests `"timestamp_granularities[]": "word"` and aligns cue boundaries to first and last word timestamps when present.

```diff
--- a/backend/app/providers/whisper.py
+++ b/backend/app/providers/whisper.py
@@ -1,9 +1,43 @@
 import os
-from typing import List
+from typing import List, Optional
 import httpx
 
 from app.providers.base import STTProvider, STTResult
 
+WHISPER_LANG_TO_ISO = {
+    "hindi": "hi",
+    "marathi": "mr",
+    "tamil": "ta",
+    "telugu": "te",
+    "english": "en",
+    "bengali": "bn",
+    "gujarati": "gu",
+    "kannada": "kn",
+    "malayalam": "ml",
+    "punjabi": "pa",
+    "urdu": "ur",
+    "hi": "hi",
+    "mr": "mr",
+    "ta": "ta",
+    "te": "te",
+    "en": "en",
+    "bn": "bn",
+    "gu": "gu",
+    "kn": "kn",
+    "ml": "ml",
+    "pa": "pa",
+    "ur": "ur",
+}
+
+
+def normalize_whisper_lang(raw_lang: Optional[str]) -> Optional[str]:
+    """Maps Whisper language name to standard ISO 639-1 code; returns None if unknown."""
+    if not raw_lang:
+        return None
+    cleaned = raw_lang.strip().lower()
+    return WHISPER_LANG_TO_ISO.get(cleaned, None)
+
 
 class WhisperSTTProvider(STTProvider):
     """
@@ -53,10 +87,14 @@ class WhisperSTTProvider(STTProvider):
         data = {
             "model": self.model,
-            "language": lang.lower() if lang else "en",
             "response_format": "verbose_json",
-            "temperature": "0.0"
+            "temperature": "0.0",
+            "timestamp_granularities[]": "word",
         }
+        # Omit language param if auto or empty to let Whisper auto-detect
+        if lang and lang.lower() not in ("auto", ""):
+            data["language"] = lang.lower()
 
         async with httpx.AsyncClient(timeout=10.0) as client:
             response = await client.post(self.endpoint, headers=headers, data=data, files=files)
@@ -65,6 +103,24 @@ class WhisperSTTProvider(STTProvider):
 
             res_json = response.json()
 
+        detected_raw = res_json.get("language")
+        detected_iso = normalize_whisper_lang(detected_raw)
+
+        # Word-level timestamps fallback to segment level
+        words = res_json.get("words", [])
+        if words:
+            first_w = words[0]
+            last_w = words[-1]
+            full_text = res_json.get("text", "").strip()
+            if full_text:
+                return [
+                    STTResult(
+                        offset_start=float(first_w.get("start", 0.0)),
+                        offset_end=float(last_w.get("end", 1.0)),
+                        text=full_text,
+                        confidence=1.0,
+                        lang=detected_iso
+                    )
+                ]
+
         segments = res_json.get("segments", [])
         if segments:
             results = []
@@ -76,7 +132,8 @@ class WhisperSTTProvider(STTProvider):
                             offset_start=float(seg.get("start", 0.0)),
                             offset_end=float(seg.get("end", 1.0)),
                             text=text,
-                            confidence=float(seg.get("avg_logprob", 1.0))
+                            confidence=float(seg.get("avg_logprob", 1.0)),
+                            lang=detected_iso
                         )
                     )
             if results:
@@ -92,6 +149,7 @@ class WhisperSTTProvider(STTProvider):
                 offset_start=0.0,
                 offset_end=float(res_json.get("duration", 1.0)),
                 text=text,
-                confidence=1.0
+                confidence=1.0,
+                lang=detected_iso
             )
         ]
```

---

## 2. Unified Diff: `backend/app/session.py`

### Changes:
- **Session Language Lock**: Tracks the first 3 chunks when `lang` is `"auto"`. Locks the session language to the majority vote of those 3 chunks.
- **Epoch Reset**: Clears `auto_lang_samples` and resets `lang_locked = False` upon any seek, navigation, or epoch increment.

```diff
--- a/backend/app/session.py
+++ b/backend/app/session.py
@@ -1,5 +1,6 @@
+from collections import Counter
 import uuid
-from typing import Optional
+from typing import Optional, List
 from app.models import ChunkMetaMessage
 
 
@@ -13,10 +14,35 @@ class SessionState:
     def __init__(self, client_id: Optional[str] = None, lang: str = "en", target_lang: Optional[str] = None):
         self.session_id: str = client_id or str(uuid.uuid4())
         self.epoch: int = 0
         self.playback_rate: float = 1.0
+        self.requested_lang: str = lang
         self.lang: str = lang
         self.target_lang: Optional[str] = target_lang
         self.pending_meta: Optional[ChunkMetaMessage] = None
+        self.is_auto_lang: bool = (not lang) or (lang.lower() == "auto")
+        self.auto_lang_samples: List[str] = []
+        self.lang_locked: bool = False
+
+    def record_detected_lang(self, detected_lang: Optional[str]) -> Optional[str]:
+        """
+        Collects auto-detected language for the first 3 chunks.
+        Locks session language to the majority vote after 3 samples.
+        Before lock is achieved, self.lang remains 'auto' so Whisper continues native detection.
+        """
+        if not self.is_auto_lang or self.lang_locked or not detected_lang:
+            return self.lang
+
+        self.auto_lang_samples.append(detected_lang)
+        if len(self.auto_lang_samples) >= 3:
+            majority_lang = Counter(self.auto_lang_samples).most_common(1)[0][0]
+            self.lang = majority_lang
+            self.lang_locked = True
+        # Notice: until locked, self.lang is NOT changed so Whisper receives no forced language param
+        return self.lang
 
     def handle_seek(self, new_epoch: Optional[int] = None) -> int:
         """
         Advances the epoch to invalidate in-flight or older chunks.
@@ -31,6 +57,12 @@ class SessionState:
         # Clear any pending chunk meta from the pre-seek period
         self.pending_meta = None
+
+        # Reset language lock and auto-detect history on epoch bump
+        if self.is_auto_lang:
+            self.lang_locked = False
+            self.auto_lang_samples = []
+            self.lang = self.requested_lang
+
         return self.epoch
 
     def is_valid_epoch(self, epoch: int) -> bool:
```

---

## 3. Script-Share Code-Mixed Detection & `models.py` Diff

### Script Share Rules (lang vs langs):
- **Dominant Language (`lang`)**:
  - Always preserved directly from Whisper's ISO detection (`seg.lang`).
  - Marathi (`mr`) and Hindi (`hi`) share the same Devanagari script; script analysis cannot differentiate Marathi from Hindi. Therefore, `lang` must never be overridden by script counting.
- **Multilingual Sidecar (`langs`)**:
  - Computed via character script shares:
    - Devanagari (`\u0900` - `\u097F`): Indic
    - Tamil (`\u0B80` - `\u0BFF`): Indic
    - Telugu (`\u0C00` - `\u0C7F`): Indic
    - Latin (`a-z`, `A-Z`): Latin
  - If both Indic share >= 0.20 and Latin share >= 0.20:
    `langs = [dominant_iso, "en"]`.
  - Otherwise:
    `langs = [dominant_iso]`.

### Unified Diff: `backend/app/models.py`

```diff
--- a/backend/app/models.py
+++ b/backend/app/models.py
@@ -1,5 +1,5 @@
-from typing import Optional, Literal
+from typing import Optional, Literal, List
 from pydantic import BaseModel, Field
 
 
@@ -48,8 +48,12 @@ class SubtitleResult(BaseModel):
     type: Literal["subtitle"] = "subtitle"
     chunk_id: int
     epoch: int
+    is_final: bool = True
     start: float
     end: float
+    start_offset: Optional[float] = None
+    end_offset: Optional[float] = None
     lang: str
+    langs: List[str] = Field(default_factory=list)
     text: str
     translation: Optional[str] = None
     source: str = "mock"
```

---

## 4. Unified Diff: `backend/app/main.py`

### Changes:
- Integrates `detect_script_code_mixed` character analysis.
- Calls `session.record_detected_lang` on each chunk.
- Preserves Whisper ISO detection (including `mr`) as `lang`.
- Emits `is_final: True`, `langs: List[str]`, `lang: str`, `start_offset: float`, and `end_offset: float` matching `docs/contract.md`.

```diff
--- a/backend/app/main.py
+++ b/backend/app/main.py
@@ -21,6 +21,48 @@ from app.session import SessionState
 from app.providers.mock import MockSTTProvider, MockTranslationProvider
 
 
+def detect_script_code_mixed(text: str, dominant_lang: str = "en") -> list[str]:
+    """
+    Calculates character script shares for Indic vs Latin.
+    If both Indic and Latin shares are >= 0.20, returns [dominant_lang, 'en'].
+    Preserves dominant_lang from Whisper ISO (including Marathi 'mr').
+    """
+    if not text:
+        return [dominant_lang]
+
+    indic_letters = 0
+    latin_letters = 0
+    total_letters = 0
+
+    for ch in text:
+        cp = ord(ch)
+        # Devanagari, Tamil, Telugu Unicode ranges
+        if (0x0900 <= cp <= 0x097F) or (0x0B80 <= cp <= 0x0BFF) or (0x0C00 <= cp <= 0x0C7F):
+            indic_letters += 1
+            total_letters += 1
+        elif (0x0041 <= cp <= 0x005A) or (0x0061 <= cp <= 0x007A):
+            latin_letters += 1
+            total_letters += 1
+
+    if total_letters == 0:
+        return [dominant_lang]
+
+    indic_share = indic_letters / total_letters
+    latin_share = latin_letters / total_letters
+
+    if indic_share >= 0.20 and latin_share >= 0.20:
+        if dominant_lang == "en":
+            return ["en", "hi"]
+        return [dominant_lang, "en"]
+
+    return [dominant_lang]
+
+
 logging.basicConfig(
@@ -131,6 +173,10 @@ async def websocket_endpoint(websocket: WebSocket):
                 for seg in results:
+                    detected_iso = getattr(seg, "lang", None) or session.lang
+                    if detected_iso and detected_iso != "auto":
+                        session.record_detected_lang(detected_iso)
+
+                    langs_list = detect_script_code_mixed(seg.text, dominant_lang=detected_iso)
+
                     # Key synchronization formula:
                     # t_video = video_start + offset_in_chunk * playback_rate
                     t_start = round(meta.video_start + seg.offset_start * meta.playback_rate, 3)
@@ -148,8 +194,12 @@ async def websocket_endpoint(websocket: WebSocket):
                     sub_res = SubtitleResult(
                         chunk_id=meta.chunk_id,
                         epoch=meta.epoch,
+                        is_final=True,
                         start=t_start,
                         end=t_end,
-                        lang=session.lang,
+                        start_offset=round(seg.offset_start, 3),
+                        end_offset=round(seg.offset_end, 3),
+                        lang=detected_iso,
+                        langs=langs_list,
                         text=seg.text,
                         translation=translation,
                         source="stt"
```

---

## 5. Verification: `backend/app/providers/base.py`

### Import Check:
At line 2 of `backend/app/providers/base.py`:
```python
from typing import List, Optional
```
`Optional` is already imported at line 2. To pass detected language metadata from provider to session, add `lang: Optional[str] = None` to `STTResult`:

```diff
--- a/backend/app/providers/base.py
+++ b/backend/app/providers/base.py
@@ -14,6 +14,7 @@ class STTResult(BaseModel):
     offset_start: float
     offset_end: float
     text: str
     confidence: float = 1.0
+    lang: Optional[str] = None
```

---

## 6. Role C Language Verification Test Cases

| Test Case | Speech Audio | Whisper Output | Expected `lang` | Expected `langs` | Rationale |
|:---:|:---:|:---:|:---:|:---:|:---|
| 1. Hindi | Hindi speech | `language: "hindi"`, text: `"आज का मौसम अच्छा है"` | `"hi"` | `["hi"]` | Devanagari script, pure Hindi audio |
| 2. Marathi | Marathi speech | `language: "marathi"`, text: `"आजचा दिवस छान आहे"` | `"mr"` | `["mr"]` | Devanagari script, Whisper ISO correctly retains `mr` (not hijacked to `hi`) |
| 3. Tamil | Tamil speech | `language: "tamil"`, text: `"இன்று வானிலை நன்றாக உள்ளது"` | `"ta"` | `["ta"]` | Tamil script, pure Tamil audio |
| 4. Telugu | Telugu speech | `language: "telugu"`, text: `"ఈరోజు వాతావరణం బాగుంది"` | `"te"` | `["te"]` | Telugu script, pure Telugu audio |
| 5. English | English speech | `language: "english"`, text: `"The weather today is great"` | `"en"` | `["en"]` | Latin script, pure English audio |
| 6. Hinglish | Code-mixed Hindi + English | `language: "hindi"`, text: `"आज का weather बहुत nice है"` | `"hi"` | `["hi", "en"]` | Devanagari share = 0.43, Latin share = 0.57 (both >= 0.20) -> code-mixed sidecar |

### Expected `check_contract.py` Compliance Table:

```
==========================================================================================
CONTRACT PROTOCOL VERIFICATION (docs/contract.md)
==========================================================================================
Target WebSocket URL: ws://localhost:8000/ws

[Handshake]: Sent start -> Received {'type': 'ready'}

==========================================================================================
CONTRACT SPECIFICATION COMPLIANCE TABLE
==========================================================================================
| Contract Field | Expected Type | Received Value (Type) | Status |
|----------------|---------------|-----------------------|--------|
| chunk_id       | int           | 1 (int)               | MATCH  |
| epoch          | int           | 7 (int)               | MATCH  |
| is_final       | bool          | True (bool)           | MATCH  |
| start_offset   | float/int     | 0.0 (float)           | MATCH  |
| end_offset     | float/int     | 0.1 (float)           | MATCH  |
| lang           | str           | hi (str)              | MATCH  |
| langs          | list          | ['hi'] (list)         | MATCH  |
| text           | str           | mock (str)            | MATCH  |
| translation    | str           | mock (str)            | MATCH  |
==========================================================================================

- Epoch Echo Check      : PASS (Sent 7, Received 7)
- Stale Epoch Behavior  : Echoes epoch (1) -> Client engine drops per Contract Rule 5
- Code-Mixed langs Check: PASS (langs = ['hi'])
- Extra Uncontracted Fields: None
```

