import json
import logging
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError

from app.config import DEBUG, STT_PROVIDER, TRANSLATION_PROVIDER
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
from app.providers.mock import MockSTTProvider, MockTranslationProvider

logging.basicConfig(
    level=logging.DEBUG if DEBUG else logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("livesub.backend")

app = FastAPI(title="LiveSub Backend", version="1.0.0")

# Enable CORS for Chrome extension origin
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from app.providers.factory import get_stt_provider, get_translation_provider

# Instantiate providers dynamically based on environment configuration
stt_provider = get_stt_provider(STT_PROVIDER)
translation_provider = get_translation_provider(TRANSLATION_PROVIDER)



@app.get("/health")
async def health_check():
    """
    Health check endpoint returning ok status.
    """
    return {"ok": True}


@app.get("/info")
async def info_endpoint():
    """
    Returns server status and capability metadata for Chrome Extension handshake.
    """
    return {
        "service": "LiveSub Backend",
        "version": "1.0.0",
        "status": "ready",
        "stt_provider": STT_PROVIDER,
        "translation_provider": TRANSLATION_PROVIDER,
        "supported_languages": ["hi", "mr", "ta", "te", "en", "kn", "gu", "bn"],
        "ws_endpoint": "/ws",
        "health_endpoint": "/health"
    }



@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    LiveSub streaming subtitle WebSocket endpoint.
    Implements Section 4 protocol:
      - hello -> hello_ack
      - chunk_meta + binary audio -> subtitle results
      - seek -> advance epoch, discard old chunks, seek_ack
      - config -> update playback rate or language, config_ack
      - bye -> clean disconnect
    """
    await websocket.accept()
    session = SessionState()
    logger.info("WebSocket client connected. Created session: %s", session.session_id)

    try:
        while True:
            message = await websocket.receive()

            # ─── 1. Binary Frame: Audio Payload ────────────────────────────────
            if "bytes" in message and message["bytes"] is not None:
                audio_bytes = message["bytes"]

                if not session.pending_meta:
                    logger.warning("Received binary audio without preceding chunk_meta. Ignoring.")
                    continue

                meta = session.pending_meta
                session.pending_meta = None  # Consumed

                # Check 1: Drop if chunk's epoch does not match current session epoch
                if not session.is_valid_epoch(meta.epoch):
                    logger.info(
                        "Dropping chunk %d: chunk epoch %d != current session epoch %d",
                        meta.chunk_id, meta.epoch, session.epoch
                    )
                    continue

                # Process in-memory audio through STT Provider
                # Audio is processed in memory only — never written to disk or logged
                try:
                    results = await stt_provider.transcribe_chunk(audio_bytes, lang=session.lang)
                except Exception as e:
                    logger.error("STT provider transcription error: %s", e)
                    err = ErrorMessage(detail=f"STT error: {str(e)}")
                    await websocket.send_text(err.model_dump_json())
                    continue

                # Check 2: Verify epoch again after async transcription (in case seek occurred)
                if not session.is_valid_epoch(meta.epoch):
                    logger.info(
                        "Dropping completed chunk %d: session epoch advanced to %d during STT",
                        meta.chunk_id, session.epoch
                    )
                    continue

                for seg in results:
                    # Key synchronization formula:
                    # t_video = video_start + offset_in_chunk * playback_rate
                    t_start = round(meta.video_start + seg.offset_start * meta.playback_rate, 3)
                    t_end = round(meta.video_start + seg.offset_end * meta.playback_rate, 3)

                    translation = None
                    if session.target_lang and session.target_lang.lower() != session.lang.lower():
                        try:
                            translation = await translation_provider.translate(
                                seg.text, session.lang, session.target_lang
                            )
                        except Exception as e:
                            logger.error("Translation error: %s", e)
                            translation = None

                    sub_res = SubtitleResult(
                        chunk_id=meta.chunk_id,
                        epoch=meta.epoch,
                        start=t_start,
                        end=t_end,
                        lang=session.lang,
                        text=seg.text,
                        translation=translation,
                        source="stt"
                    )
                    await websocket.send_text(sub_res.model_dump_json())

            # ─── 2. Text Frame: Control / Metadata JSON ───────────────────────
            elif "text" in message and message["text"] is not None:
                raw_text = message["text"].strip()
                if not raw_text:
                    continue

                try:
                    data = json.loads(raw_text)
                except json.JSONDecodeError:
                    err = ErrorMessage(detail="Invalid JSON payload")
                    await websocket.send_text(err.model_dump_json())
                    continue

                msg_type = data.get("type")

                # ── Protocol Message: hello ──
                if msg_type == "hello":
                    hello = HelloMessage(**data)
                    session.lang = hello.lang
                    session.target_lang = hello.target_lang
                    if hello.client_id:
                        session.session_id = hello.client_id

                    ack = HelloAckMessage(session_id=session.session_id, epoch=session.epoch)
                    await websocket.send_text(ack.model_dump_json())

                # ── Protocol Message: chunk_meta ──
                elif msg_type == "chunk_meta":
                    meta = ChunkMetaMessage(**data)
                    # Verify epoch before even accepting binary payload
                    if not session.is_valid_epoch(meta.epoch):
                        logger.info(
                            "Ignoring chunk_meta %d: epoch %d != current session epoch %d",
                            meta.chunk_id, meta.epoch, session.epoch
                        )
                        session.pending_meta = None
                    else:
                        session.pending_meta = meta
                        session.playback_rate = meta.playback_rate

                # ── Protocol Message: seek ──
                elif msg_type == "seek":
                    seek_msg = SeekMessage(**data)
                    new_epoch = session.handle_seek(new_epoch=seek_msg.epoch)
                    logger.info("Seek to %.2fs received. Advanced to epoch %d", seek_msg.video_time, new_epoch)

                    ack = SeekAckMessage(epoch=new_epoch, video_time=seek_msg.video_time)
                    await websocket.send_text(ack.model_dump_json())

                # ── Protocol Message: config ──
                elif msg_type == "config":
                    cfg = ConfigMessage(**data)
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
                    await websocket.send_text(ack.model_dump_json())

                # ── Protocol Message: bye ──
                elif msg_type == "bye":
                    logger.info("Client sent bye. Closing connection.")
                    await websocket.close(code=1000)
                    break

                else:
                    logger.warning("Unrecognized message type: %s", msg_type)
                    err = ErrorMessage(detail=f"Unrecognized message type: {msg_type}")
                    await websocket.send_text(err.model_dump_json())

    except (WebSocketDisconnect, RuntimeError) as e:
        logger.info("Client disconnected (%s): %s", type(e).__name__, session.session_id)
    except Exception as e:
        logger.exception("Unexpected error in WebSocket loop: %s", e)
        try:
            await websocket.close(code=1011)
        except Exception:
            pass
