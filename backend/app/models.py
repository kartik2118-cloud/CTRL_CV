from typing import Optional, Literal
from pydantic import BaseModel, Field


# ─── Client Messages (Incoming) ────────────────────────────────────────────────

class HelloMessage(BaseModel):
    type: Literal["hello"] = "hello"
    client_id: Optional[str] = None
    lang: str = "en"
    target_lang: Optional[str] = None
    token: Optional[str] = None
    video_id: Optional[str] = None
    epoch: Optional[int] = None


class ChunkMetaMessage(BaseModel):
    type: Literal["chunk_meta"] = "chunk_meta"
    chunk_id: int
    video_start: float
    playback_rate: float = 1.0
    epoch: int = 0
    duration: float = 1.0
    byte_length: Optional[int] = None
    video_id: Optional[str] = None


class SeekMessage(BaseModel):
    type: Literal["seek"] = "seek"
    video_time: float
    epoch: Optional[int] = None
    video_id: Optional[str] = None


class ConfigMessage(BaseModel):
    type: Literal["config"] = "config"
    playback_rate: Optional[float] = None
    lang: Optional[str] = None
    target_lang: Optional[str] = None


class ByeMessage(BaseModel):
    type: Literal["bye"] = "bye"


# ─── Server Messages (Outgoing) ────────────────────────────────────────────────

class HelloAckMessage(BaseModel):
    type: Literal["hello_ack"] = "hello_ack"
    session_id: str
    epoch: int


class SubtitleResult(BaseModel):
    type: Literal["subtitle"] = "subtitle"
    chunk_id: int
    epoch: int
    start: float
    end: float
    lang: str
    text: str
    translation: Optional[str] = None
    source: str = "mock"
    is_final: bool = True
    revision: int = 1
    start_offset: Optional[float] = None
    end_offset: Optional[float] = None
    langs: Optional[list[str]] = None


class SeekAckMessage(BaseModel):
    type: Literal["seek_ack"] = "seek_ack"
    epoch: int
    video_time: float


class ConfigAckMessage(BaseModel):
    type: Literal["config_ack"] = "config_ack"
    playback_rate: float
    lang: str
    target_lang: Optional[str] = None


class ErrorMessage(BaseModel):
    type: Literal["error"] = "error"
    code: Optional[str] = None
    detail: str
    message: Optional[str] = None
