import uuid
from typing import Optional
from app.models import ChunkMetaMessage


class SessionState:
    """
    Manages session-level state for an active WebSocket client connection.
    Keeps track of the epoch counter, playback rate, active languages,
    and pending chunk metadata.
    """

    def __init__(self, client_id: Optional[str] = None, lang: str = "en", target_lang: Optional[str] = None):
        self.session_id: str = client_id or str(uuid.uuid4())
        self.epoch: int = 0
        self.playback_rate: float = 1.0
        self.lang: str = lang
        self.target_lang: Optional[str] = target_lang
        self.pending_meta: Optional[ChunkMetaMessage] = None

    def handle_seek(self, new_epoch: Optional[int] = None) -> int:
        """
        Advances the epoch to invalidate in-flight or older chunks.
        If the client specified an epoch, adopts it; otherwise increments current epoch.
        """
        if new_epoch is not None:
            self.epoch = new_epoch
        else:
            self.epoch += 1
        # Clear any pending chunk meta from the pre-seek period
        self.pending_meta = None
        return self.epoch

    def is_valid_epoch(self, epoch: int) -> bool:
        """
        Returns True if the given epoch matches the session's current epoch.
        Results or chunks with mismatched epochs must be dropped.
        """
        return epoch == self.epoch
