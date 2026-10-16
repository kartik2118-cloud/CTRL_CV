"""
Video Timing and State Synchronization Coordinator (Role D).
Associates audio chunk positions with page-state video anchors using the contract:
t_video = chunk_video_start + offset_in_chunk_seconds * playback_rate
"""

import math
from typing import Any, Dict, Optional, Tuple


class SyncCoordinator:
    """
    Coordinates page-state observations (currentTime, playbackRate, paused, seeking, video_id, epoch)
    with audio chunks to produce accurate, epoch-scoped video timeline anchors.
    """

    MAX_ANCHOR_AGE_MS = 500.0  # Anchors older than 500ms are treated as unverified

    def __init__(self, session_id: str = "default_session"):
        self.session_id = session_id
        self.current_video_id: Optional[str] = None
        self.current_epoch = 0
        self.latest_anchor: Optional[Dict[str, Any]] = None
        self.discarded_partial_chunks = 0
        self.rejected_stale_observations = 0

    def register_observation(self, obs: Dict[str, Any]) -> Tuple[bool, str]:
        """
        Registers a timestamped page-state observation from the content script.
        Returns (accepted, reason).
        """
        obs_epoch = obs.get("epoch", 0)
        obs_video_id = obs.get("video_id")

        # 1. Initial connection
        if self.current_video_id is None:
            self.current_video_id = obs_video_id
            self.current_epoch = obs_epoch
            self.latest_anchor = dict(obs)
            return True, "Initial anchor accepted"

        # 2. SPA video navigation (video_id change takes precedence over epoch check)
        if obs_video_id != self.current_video_id:
            self.current_video_id = obs_video_id
            self.current_epoch = max(self.current_epoch + 1, obs_epoch)
            self.latest_anchor = dict(obs)
            return True, "Video navigation reset"

        # 3. Reject stale messages from an older epoch for the same video
        if obs_epoch < self.current_epoch:
            self.rejected_stale_observations += 1
            return False, f"Stale epoch {obs_epoch} < current {self.current_epoch}"

        # 4. Check for discontinuity / epoch advancement
        if obs_epoch > self.current_epoch:
            self.current_epoch = obs_epoch

        self.latest_anchor = dict(obs)
        return True, "Anchor accepted"

    def associate_chunk(self, chunk_meta: Dict[str, Any], chunk_wall_time_ms: float) -> Dict[str, Any]:
        """
        Associates an audio chunk with the latest video anchor.
        Computes chunk_video_start, chunk_video_end, and stt_eligible.
        """
        anchor = self.latest_anchor
        playback_rate = anchor.get("playback_rate", 1.0) if anchor else 1.0
        paused = anchor.get("paused", True) if anchor else True
        seeking = anchor.get("seeking", False) if anchor else False
        ad_state = anchor.get("ad_state", "unknown") if anchor else "unknown"
        video_id = self.current_video_id

        chunk_start_v = None
        chunk_end_v = None
        stt_eligible = False

        # Conditions for valid video timeline anchor:
        # - Anchor exists and matches current video_id and epoch
        # - Not paused and not seeking
        # - Not playing an ad
        # - Anchor age is within MAX_ANCHOR_AGE_MS
        if (
            anchor is not None
            and anchor.get("epoch") == self.current_epoch
            and anchor.get("video_id") == self.current_video_id
            and not paused
            and not seeking
            and ad_state != "ad_playing"
        ):
            anchor_wall_ms = anchor.get("wall_time_ms", 0.0)
            age_ms = chunk_wall_time_ms - anchor_wall_ms

            if 0.0 <= age_ms <= self.MAX_ANCHOR_AGE_MS:
                anchor_v_time = anchor.get("video_current_time", 0.0)
                # Video progress between anchor capture and chunk emission
                elapsed_video_s = (age_ms / 1000.0) * playback_rate
                chunk_end_v = round(anchor_v_time + elapsed_video_s, 6)
                # Chunk covers audio_duration_s before chunk emission
                duration_video_s = chunk_meta["audio_duration_s"] * playback_rate
                calculated_start = round(chunk_end_v - duration_video_s, 6)
                if calculated_start < 0:
                    chunk_start_v = None
                    chunk_end_v = None
                    stt_eligible = False
                else:
                    chunk_start_v = calculated_start
                    stt_eligible = True

        return {
            "type": "chunk_diagnostic",
            "session_id": self.session_id,
            "video_id": video_id,
            "epoch": self.current_epoch,
            "chunk_id": chunk_meta.get("chunk_id", 0),
            "sample_rate_hz": chunk_meta.get("sample_rate_hz", 16000),
            "channels": chunk_meta.get("channels", 1),
            "sample_count": chunk_meta.get("sample_count", 1600),
            "audio_duration_s": chunk_meta.get("audio_duration_s", 0.100),
            "chunk_video_start": chunk_start_v,
            "chunk_video_end": chunk_end_v,
            "playback_rate": playback_rate,
            "paused": paused,
            "seeking": seeking,
            "ad_state": ad_state,
            "is_final_partial": chunk_meta.get("is_final_partial", False),
            "stt_eligible": stt_eligible,
            "timing_verified": stt_eligible,
            "rms": chunk_meta.get("rms", 0.0),
            "peak": chunk_meta.get("peak", 0.0),
        }
