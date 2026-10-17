from collections import Counter
import uuid
import time
from typing import Optional, List
from app.models import ChunkMetaMessage


class SessionState:
    """
    Manages session-level state for an active WebSocket client connection.
    Keeps track of the epoch counter, playback rate, active languages,
    pending chunk metadata, authentication, and rate-limiting.
    """

    def __init__(self, client_id: Optional[str] = None, lang: str = "en", target_lang: Optional[str] = None):
        self.session_id: str = client_id or str(uuid.uuid4())
        self.epoch: int = 0
        self.playback_rate: float = 1.0
        self.requested_lang: str = lang
        self.lang: str = lang
        self.target_lang: Optional[str] = target_lang
        self.pending_meta: Optional[ChunkMetaMessage] = None
        self.authenticated: bool = False
        self.last_active_time: float = time.time()
        self.chunk_timestamps: list[float] = []
        self.in_flight_tasks: set = set()
        self.client_protocol: str = "default"
        self.is_auto_lang: bool = (not lang) or (lang.lower() == "auto")
        self.auto_lang_samples: List[str] = []
        self.lang_locked: bool = False

    def touch(self):
        self.last_active_time = time.time()

    def record_detected_lang(self, detected_lang: Optional[str]) -> Optional[str]:
        """
        Collects auto-detected language for the first 3 chunks.
        Locks session language to the majority vote after 3 samples.
        Before lock is achieved, self.lang remains 'auto' so Whisper continues native detection.
        """
        if not self.is_auto_lang or self.lang_locked or not detected_lang:
            return self.lang

        self.auto_lang_samples.append(detected_lang)
        if len(self.auto_lang_samples) >= 3:
            majority_lang = Counter(self.auto_lang_samples).most_common(1)[0][0]
            self.lang = majority_lang
            self.lang_locked = True
        return self.lang

    def check_rate_limit(self, max_per_second: float = 5.0) -> bool:
        """
        Sliding 1-second window rate limiter. Returns True if within limit, False if exceeded.
        """
        now = time.time()
        self.chunk_timestamps = [t for t in self.chunk_timestamps if now - t <= 1.0]
        if len(self.chunk_timestamps) >= max_per_second:
            return False
        self.chunk_timestamps.append(now)
        return True

    def handle_seek(self, new_epoch: Optional[int] = None) -> int:
        """
        Advances the epoch to invalidate in-flight or older chunks.
        If the client specified an epoch, adopts it; otherwise increments current epoch.
        Also cancels any in-flight background processing tasks from the old epoch.
        """
        if new_epoch is not None:
            self.epoch = new_epoch
        else:
            self.epoch += 1
        # Clear any pending chunk meta from the pre-seek period
        self.pending_meta = None

        # Reset language lock and auto-detect history on epoch bump
        if self.is_auto_lang:
            self.lang_locked = False
            self.auto_lang_samples = []
            self.lang = self.requested_lang

        # Cancel in-flight tasks for old epoch
        for task in list(self.in_flight_tasks):
            if not task.done():
                task.cancel()
        self.in_flight_tasks.clear()

        return self.epoch

    def is_valid_epoch(self, epoch: int) -> bool:
        """
        Returns True if the given epoch matches the session's current epoch.
        Results or chunks with mismatched epochs must be dropped.
        """
        return epoch == self.epoch
