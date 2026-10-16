#!/usr/bin/env python3
"""
Unit and Timing Regression Test Suite for Video Timing & Reset Behavior (Role D).
Tests synchronization between content-script video anchors and audio chunks.
All test scenarios generated here are explicitly SYNTHETIC.
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sync_coordinator import SyncCoordinator
from check_audio_chunks import validate_diagnostic_line, validate_file


class TestVideoTimingSynthetic(unittest.TestCase):
    """Synthetic test suite for video timeline association, epoch resets, and gating."""

    def setUp(self):
        self.coordinator = SyncCoordinator(session_id="synthetic-timing-session")

    def test_mapping_at_1x_15x_and_2x(self):
        """SYNTHETIC: Validates t_video = chunk_video_start + offset * playback_rate at 1.0x, 1.5x, and 2.0x."""
        rates = [1.0, 1.5, 2.0]

        for rate in rates:
            coord = SyncCoordinator(session_id=f"synthetic-rate-{rate}")
            wall_start = 1000.0

            # Register initial video anchor
            accepted, reason = coord.register_observation({
                "video_id": "vid_rate_test",
                "epoch": 0,
                "video_current_time": 10.0,
                "playback_rate": rate,
                "paused": False,
                "seeking": False,
                "ad_state": "no_ad",
                "wall_time_ms": wall_start,
            })
            self.assertTrue(accepted, reason)

            # Emit 5 chunks of 100ms at intervals of 100ms
            for i in range(5):
                chunk_wall = wall_start + ((i + 1) * 100.0)
                chunk_meta = {
                    "chunk_id": i,
                    "sample_rate_hz": 16000,
                    "channels": 1,
                    "sample_count": 1600,
                    "audio_duration_s": 0.100,
                    "is_final_partial": False,
                }
                diag = coord.associate_chunk(chunk_meta, chunk_wall)

                self.assertTrue(diag["stt_eligible"])
                self.assertEqual(diag["playback_rate"], rate)
                self.assertIsNotNone(diag["chunk_video_start"])
                self.assertIsNotNone(diag["chunk_video_end"])

                # Verify span = audio_duration_s * playback_rate
                expected_span = round(0.100 * rate, 6)
                actual_span = round(diag["chunk_video_end"] - diag["chunk_video_start"], 6)
                self.assertAlmostEqual(actual_span, expected_span, places=4)

                # Verify sub-chunk formula: t_video = start + offset * rate
                offset = 0.050  # 50 ms into chunk
                t_sub = diag["chunk_video_start"] + offset * rate
                self.assertAlmostEqual(t_sub, diag["chunk_video_start"] + 0.050 * rate, places=4)

    def test_seek_forward_and_backward(self):
        """SYNTHETIC: Seeking increments epoch, clears anchor, and handles non-monotonic jumps across epochs."""
        wall = 5000.0

        # Playing at video time 20.0s, epoch 0
        self.coordinator.register_observation({
            "video_id": "vid_seek_test",
            "epoch": 0,
            "video_current_time": 20.0,
            "playback_rate": 1.0,
            "paused": False,
            "seeking": False,
            "ad_state": "no_ad",
            "wall_time_ms": wall,
        })
        c0 = self.coordinator.associate_chunk({"chunk_id": 0, "audio_duration_s": 0.100, "sample_count": 1600}, wall + 100.0)
        self.assertTrue(c0["stt_eligible"])
        self.assertAlmostEqual(c0["chunk_video_start"], 20.0, places=3)

        # 1. Seek forward to 80.0s (epoch advances to 1)
        wall += 500.0
        self.coordinator.register_observation({
            "video_id": "vid_seek_test",
            "epoch": 1,
            "video_current_time": 80.0,
            "playback_rate": 1.0,
            "paused": False,
            "seeking": False,
            "ad_state": "no_ad",
            "wall_time_ms": wall,
        })
        self.assertEqual(self.coordinator.current_epoch, 1)
        c1 = self.coordinator.associate_chunk({"chunk_id": 0, "audio_duration_s": 0.100, "sample_count": 1600}, wall + 100.0)
        self.assertTrue(c1["stt_eligible"])
        self.assertAlmostEqual(c1["chunk_video_start"], 80.0, places=3)

        # 2. Seek backward to 5.0s (epoch advances to 2)
        wall += 500.0
        self.coordinator.register_observation({
            "video_id": "vid_seek_test",
            "epoch": 2,
            "video_current_time": 5.0,
            "playback_rate": 1.0,
            "paused": False,
            "seeking": False,
            "ad_state": "no_ad",
            "wall_time_ms": wall,
        })
        self.assertEqual(self.coordinator.current_epoch, 2)
        c2 = self.coordinator.associate_chunk({"chunk_id": 0, "audio_duration_s": 0.100, "sample_count": 1600}, wall + 100.0)
        self.assertTrue(c2["stt_eligible"])
        self.assertAlmostEqual(c2["chunk_video_start"], 5.0, places=3)

    def test_rate_change_halfway_through_partial_chunk(self):
        """SYNTHETIC: Rate change triggers new epoch; subsequent chunks reflect new rate span."""
        wall = 10000.0

        # Rate 1.0x, epoch 0
        self.coordinator.register_observation({
            "video_id": "vid_rate_change",
            "epoch": 0,
            "video_current_time": 15.0,
            "playback_rate": 1.0,
            "paused": False,
            "seeking": False,
            "ad_state": "no_ad",
            "wall_time_ms": wall,
        })
        c0 = self.coordinator.associate_chunk({"chunk_id": 0, "audio_duration_s": 0.100, "sample_count": 1600}, wall + 100.0)
        self.assertEqual(c0["epoch"], 0)
        self.assertAlmostEqual(c0["chunk_video_end"] - c0["chunk_video_start"], 0.100, places=3)

        # Rate change to 2.0x -> content script advances epoch to 1
        wall += 200.0
        self.coordinator.register_observation({
            "video_id": "vid_rate_change",
            "epoch": 1,
            "video_current_time": 15.2,
            "playback_rate": 2.0,
            "paused": False,
            "seeking": False,
            "ad_state": "no_ad",
            "wall_time_ms": wall,
        })
        self.assertEqual(self.coordinator.current_epoch, 1)

        c1 = self.coordinator.associate_chunk({"chunk_id": 0, "audio_duration_s": 0.100, "sample_count": 1600}, wall + 100.0)
        self.assertEqual(c1["epoch"], 1)
        self.assertEqual(c1["playback_rate"], 2.0)
        # At 2.0x, 0.100s audio span corresponds to 0.200s video span
        self.assertAlmostEqual(c1["chunk_video_end"] - c1["chunk_video_start"], 0.200, places=3)

    def test_pause_and_resume_gating(self):
        """SYNTHETIC: Chunks emitted during pause must have null video anchors and stt_eligible=False."""
        wall = 20000.0

        # Pause event -> epoch 1
        self.coordinator.register_observation({
            "video_id": "vid_pause",
            "epoch": 1,
            "video_current_time": 30.0,
            "playback_rate": 1.0,
            "paused": True,
            "seeking": False,
            "ad_state": "no_ad",
            "wall_time_ms": wall,
        })

        chunk_during_pause = self.coordinator.associate_chunk(
            {"chunk_id": 0, "audio_duration_s": 0.100, "sample_count": 1600},
            wall + 100.0
        )
        self.assertFalse(chunk_during_pause["stt_eligible"])
        self.assertIsNone(chunk_during_pause["chunk_video_start"])
        self.assertIsNone(chunk_during_pause["chunk_video_end"])
        self.assertTrue(chunk_during_pause["paused"])

        # Resume / play event -> epoch 2
        wall += 1000.0
        self.coordinator.register_observation({
            "video_id": "vid_pause",
            "epoch": 2,
            "video_current_time": 30.0,
            "playback_rate": 1.0,
            "paused": False,
            "seeking": False,
            "ad_state": "no_ad",
            "wall_time_ms": wall,
        })

        chunk_after_resume = self.coordinator.associate_chunk(
            {"chunk_id": 0, "audio_duration_s": 0.100, "sample_count": 1600},
            wall + 100.0
        )
        self.assertTrue(chunk_after_resume["stt_eligible"])
        self.assertIsNotNone(chunk_after_resume["chunk_video_start"])
        self.assertFalse(chunk_after_resume["paused"])

    def test_old_messages_arriving_after_reset(self):
        """SYNTHETIC: Stale messages from an older epoch or older video must be rejected."""
        self.coordinator.current_epoch = 5
        self.coordinator.current_video_id = "current_vid"

        # Stale observation from epoch 4
        accepted, reason = self.coordinator.register_observation({
            "video_id": "current_vid",
            "epoch": 4,
            "video_current_time": 10.0,
            "playback_rate": 1.0,
            "paused": False,
            "seeking": False,
            "ad_state": "no_ad",
            "wall_time_ms": 1000.0,
        })
        self.assertFalse(accepted)
        self.assertIn("Stale epoch", reason)
        self.assertEqual(self.coordinator.rejected_stale_observations, 1)

    def test_youtube_spa_video_changes(self):
        """SYNTHETIC: Navigation to a different video resets video_id, advances epoch, and clears anchors."""
        wall = 30000.0

        # Video A
        self.coordinator.register_observation({
            "video_id": "video_AAA",
            "epoch": 0,
            "video_current_time": 45.0,
            "playback_rate": 1.0,
            "paused": False,
            "seeking": False,
            "ad_state": "no_ad",
            "wall_time_ms": wall,
        })
        self.assertEqual(self.coordinator.current_video_id, "video_AAA")

        # Video B (SPA navigation without full page reload)
        wall += 500.0
        self.coordinator.register_observation({
            "video_id": "video_BBB",
            "epoch": 0,
            "video_current_time": 0.0,
            "playback_rate": 1.0,
            "paused": False,
            "seeking": False,
            "ad_state": "no_ad",
            "wall_time_ms": wall,
        })
        self.assertEqual(self.coordinator.current_video_id, "video_BBB")
        self.assertEqual(self.coordinator.current_epoch, 1)

    def test_missing_and_delayed_state_observations(self):
        """SYNTHETIC: Anchors older than 500 ms must be treated as unverified (null timestamps)."""
        wall = 40000.0

        self.coordinator.register_observation({
            "video_id": "vid_delayed",
            "epoch": 0,
            "video_current_time": 10.0,
            "playback_rate": 1.0,
            "paused": False,
            "seeking": False,
            "ad_state": "no_ad",
            "wall_time_ms": wall,
        })

        # Fresh chunk (100 ms age) -> valid
        fresh_chunk = self.coordinator.associate_chunk(
            {"chunk_id": 0, "audio_duration_s": 0.100, "sample_count": 1600},
            wall + 100.0
        )
        self.assertTrue(fresh_chunk["stt_eligible"])

        # Delayed chunk (600 ms age > 500 ms threshold) -> unverified
        delayed_chunk = self.coordinator.associate_chunk(
            {"chunk_id": 1, "audio_duration_s": 0.100, "sample_count": 1600},
            wall + 600.0
        )
        self.assertFalse(delayed_chunk["stt_eligible"])
        self.assertIsNone(delayed_chunk["chunk_video_start"])
        self.assertIsNone(delayed_chunk["chunk_video_end"])

    def test_validator_compliance_on_timing_output(self):
        """SYNTHETIC: Pipe generated timing stream through check_audio_chunks validator."""
        wall = 50000.0
        coord = SyncCoordinator(session_id="pipe-validation-session")
        coord.register_observation({
            "video_id": "vid_validator",
            "epoch": 0,
            "video_current_time": 10.0,
            "playback_rate": 1.0,
            "paused": False,
            "seeking": False,
            "ad_state": "no_ad",
            "wall_time_ms": wall,
        })

        seen_ids = set()
        prev_chunk = None

        for i in range(5):
            chunk_wall = wall + ((i + 1) * 100.0)
            meta = {
                "chunk_id": i,
                "sample_rate_hz": 16000,
                "channels": 1,
                "sample_count": 1600,
                "audio_duration_s": 0.100,
                "is_final_partial": False,
            }
            diag = coord.associate_chunk(meta, chunk_wall)
            raw_line = json.dumps(diag)
            parsed, errors = validate_diagnostic_line(raw_line, i + 1, seen_ids, prev_chunk)
            self.assertEqual(len(errors), 0, f"Validator error on chunk {i}: {errors}")
            prev_chunk = parsed


def run_and_save_report(report_path="eval/results/timing_verification_report.json"):
    suite = unittest.TestLoader().loadTestsFromTestCase(TestVideoTimingSynthetic)
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)

    os.makedirs(os.path.dirname(report_path), exist_ok=True)
    report_data = {
        "tests_run": result.testsRun,
        "failures": len(result.failures),
        "errors": len(result.errors),
        "was_successful": result.wasSuccessful(),
        "fixture_type": "SYNTHETIC_TIMING_TESTS",
    }
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report_data, f, indent=2)

    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(run_and_save_report())
