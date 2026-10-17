import asyncio
import json
import logging
import time
from typing import Dict, List, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError

from app.config import (
    DEBUG,
    STT_PROVIDER,
    TRANSLATION_PROVIDER,
    IS_MOCK,
    AUTH_TOKEN,
    ALLOWED_ORIGINS,
    MAX_CHUNK_BYTES,
    MAX_SESSIONS,
    IDLE_TIMEOUT_SECONDS,
    MAX_CHUNKS_PER_SECOND,
    PROVIDER_TIMEOUT_SECONDS,
    PROVIDER_MAX_RETRIES,
    PROVIDER_RETRY_BACKOFF,
    FALLBACK_STT_PROVIDER,
    FALLBACK_TRANSLATION_PROVIDER,
    VAD_ENERGY_THRESHOLD,
    FILTER_HALLUCINATIONS,
)
from app.models import (
    HelloMessage,
    ChunkMetaMessage,
    SeekMessage,
    ConfigMessage,
    ByeMessage,
    HelloAckMessage,
    SeekAckMessage,
    ConfigAckMessage,
    SubtitleResult,
    ErrorMessage,
)
from app.session import SessionState
from app.audio_utils import is_silence_chunk, deduplicate_seam, is_hallucination_text
from app.providers.factory import get_stt_provider, get_translation_provider
from app.preloaded import get_preloaded_segments

logging.basicConfig(
    level=logging.DEBUG if DEBUG else logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("livesub.backend")

from contextlib import asynccontextmanager


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not AUTH_TOKEN:
        logger.warning("WARNING: AUTH_TOKEN is not set. WebSocket server is open to unauthorized access.")
    else:
        logger.info("AUTH_TOKEN security enforcement is enabled.")
    yield


app = FastAPI(title="LiveSub Backend", version="1.0.0", lifespan=lifespan)

# Task 5: Restrict CORS to configured ALLOWED_ORIGINS
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Active providers
stt_provider = get_stt_provider(STT_PROVIDER)
translation_provider = get_translation_provider(TRANSLATION_PROVIDER)

# Optional fallback providers (Task 6)
fallback_stt_provider = get_stt_provider(FALLBACK_STT_PROVIDER) if FALLBACK_STT_PROVIDER else None
fallback_translation_provider = get_translation_provider(FALLBACK_TRANSLATION_PROVIDER) if FALLBACK_TRANSLATION_PROVIDER else None

# Active session tracking for capacity management (Task 5)
active_sessions: Dict[str, SessionState] = {}


# Provider labels and capabilities metadata (Task 3)
def get_provider_labels_and_langs():
    stt_name = STT_PROVIDER.lower()
    trans_name = TRANSLATION_PROVIDER.lower()

    if stt_name == "sarvam":
        stt_label = "Sarvam AI Saaras (cloud)"
        stt_audio_leaves = True
        stt_langs = ["hi", "mr", "ta", "te", "kn", "gu", "bn", "pa", "ml", "od", "en"]
    elif stt_name in ("whisper", "groq"):
        stt_label = "Groq Whisper (cloud)"
        stt_audio_leaves = True
        stt_langs = ["en", "hi", "mr", "ta", "te", "kn", "gu", "bn", "pa", "ml", "od", "ur"]
    elif stt_name == "openai":
        stt_label = "OpenAI Whisper (cloud)"
        stt_audio_leaves = True
        stt_langs = ["en", "hi", "mr", "ta", "te", "kn", "gu", "bn", "pa", "ml", "od"]
    else:
        stt_label = "LiveSub Mock STT (local/offline)"
        stt_audio_leaves = False
        stt_langs = ["en", "hi", "mr", "ta", "te"]

    if trans_name == "sarvam":
        trans_label = "Sarvam AI Mayura (cloud)"
    elif trans_name in ("groq", "llm"):
        trans_label = "Groq Llama-3.3-70B (cloud)"
    elif trans_name == "openai":
        trans_label = "OpenAI GPT-4o-mini (cloud)"
    else:
        trans_label = "LiveSub Mock Translation (local/offline)"

    return {
        "audio_leaves_device": stt_audio_leaves,
        "stt_provider_label": stt_label,
        "translation_provider_label": trans_label,
        "supported_languages_by_provider": stt_langs,
    }


@app.get("/health")
async def health_check():
    return {"ok": True}


@app.get("/info")
async def info_endpoint():
    """
    Returns server status, disclosure fields, and capability metadata (Tasks 2 & 3).
    """
    labels = get_provider_labels_and_langs()
    return {
        "service": "LiveSub Backend",
        "version": "1.0.0",
        "status": "degraded" if IS_MOCK else "ready",
        "stt_provider": STT_PROVIDER,
        "translation_provider": TRANSLATION_PROVIDER,
        "is_mock": IS_MOCK,
        "audio_leaves_device": labels["audio_leaves_device"],
        "stt_provider_label": labels["stt_provider_label"],
        "translation_provider_label": labels["translation_provider_label"],
        "supported_languages_by_provider": labels["supported_languages_by_provider"],
        "supported_languages": labels["supported_languages_by_provider"],
        "ws_endpoint": "/ws",
        "health_endpoint": "/health"
    }


# Task 6: Resilient provider execution with timeouts and retries
async def call_stt_with_resilience(audio_bytes: bytes, lang: str):
    last_err = None
    for attempt in range(PROVIDER_MAX_RETRIES + 1):
        try:
            return await asyncio.wait_for(
                stt_provider.transcribe_chunk(audio_bytes, lang=lang),
                timeout=PROVIDER_TIMEOUT_SECONDS
            )
        except Exception as e:
            last_err = e
            logger.warning("STT attempt %d failed: %s", attempt + 1, e)
            if attempt < PROVIDER_MAX_RETRIES:
                await asyncio.sleep(PROVIDER_RETRY_BACKOFF * (2 ** attempt))

    # Try fallback STT provider if configured
    if fallback_stt_provider:
        try:
            logger.info("Attempting fallback STT provider...")
            return await asyncio.wait_for(
                fallback_stt_provider.transcribe_chunk(audio_bytes, lang=lang),
                timeout=PROVIDER_TIMEOUT_SECONDS
            )
        except Exception as fb_err:
            logger.error("Fallback STT provider error: %s", fb_err)

    raise last_err


async def call_translation_with_resilience(text: str, source_lang: str, target_lang: str) -> Optional[str]:
    last_err = None
    for attempt in range(PROVIDER_MAX_RETRIES + 1):
        try:
            return await asyncio.wait_for(
                translation_provider.translate(text, source_lang, target_lang),
                timeout=PROVIDER_TIMEOUT_SECONDS
            )
        except Exception as e:
            last_err = e
            logger.warning("Translation attempt %d failed: %s", attempt + 1, e)
            if attempt < PROVIDER_MAX_RETRIES:
                await asyncio.sleep(PROVIDER_RETRY_BACKOFF * (2 ** attempt))

    if fallback_translation_provider:
        try:
            logger.info("Attempting fallback Translation provider...")
            return await asyncio.wait_for(
                fallback_translation_provider.translate(text, source_lang, target_lang),
                timeout=PROVIDER_TIMEOUT_SECONDS
            )
        except Exception as fb_err:
            logger.error("Fallback translation provider error: %s", fb_err)

    raise last_err


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: Optional[str] = Query(None)):
    """
    LiveSub streaming subtitle WebSocket endpoint.
    Includes Task 4 epoch protections, Task 5 security limits, Task 6 error handling,
    Task 7 audio quality & silence detection, Task 8 timestamps & revisions.
    """
    # Task 5: Session capacity limit
    if len(active_sessions) >= MAX_SESSIONS:
        logger.warning("Max sessions limit reached (%d). Rejecting connection.", MAX_SESSIONS)
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Max sessions limit reached")
        return

    # Task 5: Optional Auth Token verification via query param
    if AUTH_TOKEN:
        if token != AUTH_TOKEN:
            # Check if hello message carries it; accept socket for handshake but require it
            pass
    else:
        logger.debug("Running without AUTH_TOKEN security token.")

    await websocket.accept()
    session = SessionState()
    if token and AUTH_TOKEN and token == AUTH_TOKEN:
        session.authenticated = True

    active_sessions[session.session_id] = session
    logger.info("WebSocket connected. Active sessions: %d, Session ID: %s", len(active_sessions), session.session_id)

    last_transcribed_text = ""

    ws_lock = asyncio.Lock()

    async def safe_send(text: str):
        try:
            async with ws_lock:
                await websocket.send_text(text)
        except Exception as e:
            logger.debug("Failed sending websocket frame: %s", e)

    # Task 5: Idle timeout monitor task
    async def idle_checker():
        try:
            while True:
                await asyncio.sleep(10.0)
                if time.time() - session.last_active_time > IDLE_TIMEOUT_SECONDS:
                    logger.info("Session %s idle timeout exceeded. Closing.", session.session_id)
                    await websocket.close(code=status.WS_1000_NORMAL_CLOSURE, reason="Idle timeout")
                    break
        except asyncio.CancelledError:
            pass

    idle_task = asyncio.create_task(idle_checker())

    async def process_chunk_task(meta: ChunkMetaMessage, chunk_data: bytes):
        nonlocal last_transcribed_text
        try:
            # Task 4 Check 1: Drop if chunk's epoch does not match current session epoch
            if not session.is_valid_epoch(meta.epoch):
                logger.info(
                    "Dropping chunk %d: chunk epoch %d != current session epoch %d",
                    meta.chunk_id, meta.epoch, session.epoch
                )
                return

            # Aligned Preloaded Video Lyrics / Transcripts (e.g. dQw4w9WgXcQ, jNQXAC9IVRw)
            effective_video_id = meta.video_id or session.video_id
            preloaded_segments = get_preloaded_segments(
                effective_video_id,
                meta.video_start,
                duration=meta.duration,
                target_lang=session.target_lang
            )
            if preloaded_segments:
                for seg in preloaded_segments:
                    if not session.is_valid_epoch(meta.epoch):
                        return
                    trans_text = seg.get("translation")
                    if not trans_text and session.target_lang and session.target_lang.lower() != session.lang.lower():
                        try:
                            trans_text = await call_translation_with_resilience(
                                seg["text"], session.lang, session.target_lang
                            )
                        except Exception as e:
                            logger.error("Preloaded translation error: %s", e)
                            trans_text = None

                    sub_res = SubtitleResult(
                        chunk_id=meta.chunk_id,
                        epoch=meta.epoch,
                        start=seg["start"],
                        end=seg["end"],
                        lang=session.lang,
                        text=seg["text"],
                        translation=trans_text,
                        source="preloaded",
                        is_final=True,
                        revision=1,
                        start_offset=0.0,
                        end_offset=round(meta.duration, 3),
                        langs=[session.lang]
                    )
                    if session.client_protocol == "contract":
                        res_dict = sub_res.model_dump()
                        res_dict["type"] = "result"
                        await safe_send(json.dumps(res_dict))
                    else:
                        await safe_send(sub_res.model_dump_json())
                return

            # Task 7: VAD / Silence Energy Gate (Never send silent chunks to cloud STT)
            if not IS_MOCK and is_silence_chunk(chunk_data, threshold=VAD_ENERGY_THRESHOLD):
                logger.debug("Chunk %d filtered out as silence/energy below threshold.", meta.chunk_id)
                return

            # Task 6: Resilient STT processing with timeout/retry
            try:
                results = await call_stt_with_resilience(chunk_data, lang=session.lang)
            except Exception as e:
                logger.error("STT provider error on chunk %d: %s", meta.chunk_id, e)
                err = ErrorMessage(
                    code="STT_PROVIDER_ERROR",
                    detail="Speech transcription service temporarily unavailable",
                    message="STT error: failed to process speech chunk"
                )
                await safe_send(err.model_dump_json())
                return

            if not isinstance(results, list):
                logger.error("STT provider returned malformed non-list output for chunk %d", meta.chunk_id)
                err = ErrorMessage(
                    code="STT_MALFORMED_OUTPUT",
                    detail="STT provider returned malformed response",
                    message="STT error: unexpected response format"
                )
                await safe_send(err.model_dump_json())
                return

            # Task 4 Check 2: Immediately after STT await returns
            if not session.is_valid_epoch(meta.epoch):
                logger.info(
                    "Dropping completed chunk %d: session epoch advanced to %d during STT",
                    meta.chunk_id, session.epoch
                )
                return

            for seg in results:
                if not hasattr(seg, "text") or seg.text is None:
                    continue
                seg_text = str(seg.text).strip()
                if not seg_text:
                    continue

                # Task 7: Filter hallucination text
                if FILTER_HALLUCINATIONS and is_hallucination_text(seg_text):
                    logger.debug("Dropping hallucination segment: '%s'", seg_text)
                    continue

                # Task 7: Seam de-duplication across chunk boundaries
                if last_transcribed_text:
                    clean_text = deduplicate_seam(last_transcribed_text, seg_text)
                    if not clean_text:
                        continue
                else:
                    clean_text = seg_text

                last_transcribed_text = seg_text

                # Task 8: Formula uses chunk's OWN playback_rate from chunk_meta!
                t_start = round(meta.video_start + seg.offset_start * meta.playback_rate, 3)
                t_end = round(meta.video_start + seg.offset_end * meta.playback_rate, 3)

                translation = None
                if session.target_lang and session.target_lang.lower() != session.lang.lower():
                    try:
                        translation = await call_translation_with_resilience(
                            clean_text, session.lang, session.target_lang
                        )
                    except Exception as e:
                        logger.error("Translation provider error: %s", e)
                        translation = None

                # Task 4 Check 3: Immediately after translation await returns, right before sending cue
                if not session.is_valid_epoch(meta.epoch):
                    logger.info(
                        "Dropping translated chunk %d: session epoch advanced to %d during translation",
                        meta.chunk_id, session.epoch
                    )
                    return

                # Task 8: Deliver subtitle with is_final and revision
                sub_res = SubtitleResult(
                    chunk_id=meta.chunk_id,
                    epoch=meta.epoch,
                    start=t_start,
                    end=t_end,
                    lang=session.lang,
                    text=clean_text,
                    translation=translation,
                    source="stt",
                    is_final=True,
                    revision=1,
                    start_offset=seg.offset_start,
                    end_offset=seg.offset_end,
                    langs=[session.lang]
                )

                # Emit result frame for docs/contract.md or subtitle frame for LiveSub extension
                if session.client_protocol == "contract":
                    res_dict = sub_res.model_dump()
                    res_dict["type"] = "result"
                    await safe_send(json.dumps(res_dict))
                else:
                    await safe_send(sub_res.model_dump_json())
        except asyncio.CancelledError:
            logger.debug("Chunk %d task cancelled due to seek/reset", meta.chunk_id)
        except Exception as e:
            logger.exception("Unexpected error processing chunk %d: %s", meta.chunk_id, e)

    try:
        while True:
            message = await websocket.receive()
            session.touch()

            # ─── 1. Binary Frame: Audio Payload ────────────────────────────────
            if "bytes" in message and message["bytes"] is not None:
                audio_bytes = message["bytes"]

                # Task 5: Auth Token enforcement on binary frame
                if AUTH_TOKEN and not session.authenticated:
                    logger.warning("Unauthenticated binary frame received. Closing socket.")
                    await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Unauthorized")
                    return

                # Task 5: Enforce MAX_CHUNK_BYTES
                if len(audio_bytes) > MAX_CHUNK_BYTES:
                    logger.warning("Oversized audio chunk received (%d bytes > %d limit)", len(audio_bytes), MAX_CHUNK_BYTES)
                    err = ErrorMessage(
                        code="OVERSIZED_CHUNK",
                        detail=f"Chunk payload of {len(audio_bytes)} bytes exceeds limit of {MAX_CHUNK_BYTES}",
                        message="Oversized audio chunk rejected"
                    )
                    await safe_send(err.model_dump_json())
                    continue

                # Task 5: Rate limit chunk frequency
                if not session.check_rate_limit(max_per_second=MAX_CHUNKS_PER_SECOND):
                    logger.warning("Rate limit exceeded for session %s", session.session_id)
                    err = ErrorMessage(
                        code="RATE_LIMIT_EXCEEDED",
                        detail="Exceeded maximum allowed audio chunks per second",
                        message="Rate limit exceeded. Slow down chunk streaming."
                    )
                    await safe_send(err.model_dump_json())
                    continue

                if not session.pending_meta:
                    logger.warning("Received binary audio without preceding chunk_meta. Ignoring.")
                    continue

                meta = session.pending_meta
                session.pending_meta = None

                # Task 8: Validate byte_length if provided in chunk_meta
                if meta.byte_length is not None and meta.byte_length != len(audio_bytes):
                    logger.warning(
                        "Chunk %d byte length mismatch: meta claimed %d, got %d",
                        meta.chunk_id, meta.byte_length, len(audio_bytes)
                    )
                    err = ErrorMessage(
                        code="BYTE_LENGTH_MISMATCH",
                        detail=f"Byte length mismatch: expected {meta.byte_length}, got {len(audio_bytes)}",
                        message="Chunk payload size did not match metadata"
                    )
                    await safe_send(err.model_dump_json())
                    continue

                # Task 4 & Task 10: Process audio chunk concurrently in background task
                # so control frames (seek, config, bye) can be received immediately.
                chunk_task = asyncio.create_task(process_chunk_task(meta, audio_bytes))
                session.in_flight_tasks.add(chunk_task)
                chunk_task.add_done_callback(session.in_flight_tasks.discard)

            # ─── 2. Text Frame: Control / Metadata JSON ───────────────────────
            elif "text" in message and message["text"] is not None:
                raw_text = message["text"].strip()
                if not raw_text:
                    continue

                try:
                    data = json.loads(raw_text)
                except Exception:
                    err = ErrorMessage(
                        code="INVALID_JSON",
                        detail="Invalid JSON payload received",
                        message="Malformed JSON"
                    )
                    await safe_send(err.model_dump_json())
                    continue

                if not isinstance(data, dict):
                    err = ErrorMessage(
                        code="INVALID_PAYLOAD",
                        detail="WebSocket text frame must be a JSON object",
                        message="Invalid payload structure"
                    )
                    await safe_send(err.model_dump_json())
                    continue

                msg_type = data.get("type")

                # Task 5: Auth Token enforcement
                if AUTH_TOKEN and not session.authenticated:
                    client_token = data.get("token")
                    if client_token == AUTH_TOKEN:
                        session.authenticated = True
                    elif msg_type != "hello" or client_token != AUTH_TOKEN:
                        logger.warning("Unauthenticated connection attempt. Closing socket.")
                        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Unauthorized")
                        return

                # ── Protocol Message: hello ──
                if msg_type == "hello":
                    try:
                        hello = HelloMessage(**data)
                    except ValidationError as ve:
                        err = ErrorMessage(code="VALIDATION_ERROR", detail=str(ve), message="Invalid hello payload")
                        await safe_send(err.model_dump_json())
                        continue

                    if AUTH_TOKEN and hello.token == AUTH_TOKEN:
                        session.authenticated = True
                    elif AUTH_TOKEN and not session.authenticated:
                        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Unauthorized")
                        return

                    session.lang = hello.lang
                    session.target_lang = hello.target_lang
                    if hello.client_id:
                        session.session_id = hello.client_id
                    if hello.video_id:
                        session.video_id = hello.video_id

                    ack = HelloAckMessage(session_id=session.session_id, epoch=session.epoch)
                    await safe_send(ack.model_dump_json())

                # ── Protocol Message: start (contract.md compatibility) ──
                elif msg_type == "start":
                    session.client_protocol = "contract"
                    session.session_id = data.get("session_id", session.session_id)
                    session.lang = data.get("lang_hint") or data.get("lang") or session.lang
                    session.target_lang = data.get("translate_to") or data.get("target_lang") or session.target_lang
                    if data.get("video_id"):
                        session.video_id = data.get("video_id")
                    await safe_send(json.dumps({"type": "ready"}))

                # ── Protocol Message: chunk_meta ──
                elif msg_type == "chunk_meta":
                    try:
                        meta = ChunkMetaMessage(**data)
                    except ValidationError as ve:
                        err = ErrorMessage(code="VALIDATION_ERROR", detail=str(ve), message="Invalid chunk_meta payload")
                        await safe_send(err.model_dump_json())
                        continue

                    if meta.video_id:
                        session.video_id = meta.video_id

                    if not session.is_valid_epoch(meta.epoch):
                        logger.info(
                            "Ignoring chunk_meta %d: epoch %d != current session epoch %d",
                            meta.chunk_id, meta.epoch, session.epoch
                        )
                        session.pending_meta = None
                    else:
                        session.pending_meta = meta
                        session.playback_rate = meta.playback_rate

                # ── Protocol Message: chunk (contract.md compatibility) ──
                elif msg_type == "chunk":
                    try:
                        v_start = float(data.get("video_start_time", data.get("video_start", 0.0)))
                        rate = float(data.get("playback_rate", 1.0))
                        cid = int(data.get("chunk_id", 0))
                        ep = int(data.get("epoch", session.epoch))
                        vid = data.get("video_id")
                        meta = ChunkMetaMessage(
                            chunk_id=cid,
                            video_start=v_start,
                            playback_rate=rate,
                            epoch=ep,
                            video_id=vid
                        )
                    except Exception as ve:
                        err = ErrorMessage(code="VALIDATION_ERROR", detail=str(ve), message="Invalid chunk payload")
                        await safe_send(err.model_dump_json())
                        continue

                    if vid:
                        session.video_id = vid

                    # If client protocol is contract, adopt higher epoch automatically (e.g. initial epoch 1 or seek increment)
                    if session.client_protocol == "contract" and (ep > session.epoch or session.epoch == 0):
                        session.handle_seek(new_epoch=ep)
                        last_transcribed_text = ""

                    if not session.is_valid_epoch(meta.epoch):
                        logger.info(
                            "Ignoring chunk %d: epoch %d != current session epoch %d",
                            meta.chunk_id, meta.epoch, session.epoch
                        )
                        session.pending_meta = None
                    else:
                        session.pending_meta = meta
                        session.playback_rate = meta.playback_rate

                # ── Protocol Message: seek ──
                elif msg_type == "seek":
                    try:
                        seek_msg = SeekMessage(**data)
                    except ValidationError as ve:
                        err = ErrorMessage(code="VALIDATION_ERROR", detail=str(ve), message="Invalid seek payload")
                        await safe_send(err.model_dump_json())
                        continue

                    if seek_msg.video_id:
                        session.video_id = seek_msg.video_id

                    # Advances epoch and cancels pending in-flight tasks
                    new_epoch = session.handle_seek(new_epoch=seek_msg.epoch)
                    last_transcribed_text = ""
                    logger.info("Seek to %.2fs received. Advanced to epoch %d", seek_msg.video_time, new_epoch)

                    ack = SeekAckMessage(epoch=new_epoch, video_time=seek_msg.video_time)
                    await safe_send(ack.model_dump_json())

                # ── Protocol Message: config ──
                elif msg_type == "config":
                    try:
                        cfg = ConfigMessage(**data)
                    except ValidationError as ve:
                        err = ErrorMessage(code="VALIDATION_ERROR", detail=str(ve), message="Invalid config payload")
                        await safe_send(err.model_dump_json())
                        continue

                    if cfg.playback_rate is not None:
                        session.playback_rate = cfg.playback_rate
                    if cfg.lang is not None:
                        session.lang = cfg.lang
                    if cfg.target_lang is not None:
                        session.target_lang = cfg.target_lang

                    ack = ConfigAckMessage(
                        playback_rate=session.playback_rate,
                        lang=session.lang,
                        target_lang=session.target_lang
                    )
                    await safe_send(ack.model_dump_json())

                # ── Protocol Message: bye ──
                elif msg_type == "bye":
                    logger.info("Client sent bye. Closing connection gracefully.")
                    await websocket.close(code=1000)
                    break

                # ── Unknown Message Type ──
                else:
                    logger.warning("Unrecognized message type: %s", msg_type)
                    err = ErrorMessage(
                        code="UNKNOWN_MESSAGE_TYPE",
                        detail=f"Unrecognized message type: '{msg_type}'",
                        message=f"Unknown message type '{msg_type}'"
                    )
                    await safe_send(err.model_dump_json())

    except (WebSocketDisconnect, RuntimeError) as e:
        logger.info("Client disconnected (%s): %s", type(e).__name__, session.session_id)
    except Exception as e:
        logger.exception("Unexpected error in WebSocket loop: %s", e)
        try:
            await websocket.close(code=1011)
        except Exception:
            pass
    finally:
        idle_task.cancel()
        for t in list(session.in_flight_tasks):
            if not t.done():
                t.cancel()
        session.in_flight_tasks.clear()
        if session.session_id in active_sessions:
            del active_sessions[session.session_id]
        logger.info("Session %s ended. Remaining active sessions: %d", session.session_id, len(active_sessions))
