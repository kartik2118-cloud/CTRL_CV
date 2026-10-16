#!/usr/bin/env python3
"""
Synthetic Unit & Regression Test Suite for Audio Chunk Diagnostics (Role D).
Tests eval/check_audio_chunks.py against valid and deliberately invalid fixtures.
All test data generated in this suite is explicitly SYNTHETIC.
"""

import json
import os
import sys
import tempfile
import unittest

# Ensure eval directory is in path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from check_audio_chunks import validate_file, validate_diagnostic_line


class TestAudioChunkValidationSynthetic(unittest.TestCase):
    """Synthetic test suite for audio chunk schema, timing, and state rules."""

    def create_temp_jsonl(self, lines: list) -> str:
        fd, path = tempfile.mkstemp(suffix=".jsonl", prefix="synthetic_chunk_test_")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            for item in lines:
                if isinstance(item, str):
                    f.write(item + "\n")
                else:
                    f.write(json.dumps(item) + "\n")
        self.addCleanup(lambda: os.path.exists(path) and os.remove(path))
        return path

    def test_valid_continuous_stream_synthetic(self):
        """Synthetic fixture: 5 continuous 100ms chunks at 1.0x playback rate."""
        records = []
        for i in range(5):
            records.append({
                "session_id": "synthetic-session-001",
                "video_id": "dQw4w9WgXcQ",
                "epoch": 0,
                "chunk_id": i,
                "sample_rate_hz": 16000,
                "channels": 1,
                "sample_count": 1600,
                "audio_duration_s": 0.100,
                "chunk_video_start": round(10.0 + (i * 0.100), 4),
                "chunk_video_end": round(10.0 + ((i + 1) * 0.100), 4),
                "playback_rate": 1.0,
                "paused": False,
                "seeking": False,
                "ad_state": "no_ad",
                "stt_eligible": True,
                "is_final_partial": False,
            })
        temp_file = self.create_temp_jsonl(records)
        report = validate_file(temp_file)
        self.assertTrue(report["valid"], f"Validation failed: {report['errors']}")
        self.assertEqual(report["total_lines"], 5)
        self.assertEqual(report["valid_chunks"], 5)
        self.assertEqual(report["eligible_chunks"], 5)
        self.assertEqual(report["unverified_anchor_chunks"], 0)

    def test_valid_playback_rates_synthetic(self):
        """Synthetic fixture: Chunks at 1.5x playback rate with matching video spans."""
        records = []
        for i in range(3):
            # At 1.5x, 0.100s audio covers 0.150s video
            records.append({
                "session_id": "synthetic-session-rate15",
                "video_id": "test_video_15x",
                "epoch": 0,
                "chunk_id": i,
                "sample_rate_hz": 16000,
                "channels": 1,
                "sample_count": 1600,
                "audio_duration_s": 0.100,
                "chunk_video_start": round(20.0 + (i * 0.150), 4),
                "chunk_video_end": round(20.0 + ((i + 1) * 0.150), 4),
                "playback_rate": 1.5,
                "paused": False,
                "seeking": False,
                "ad_state": "no_ad",
                "stt_eligible": True,
            })
        temp_file = self.create_temp_jsonl(records)
        report = validate_file(temp_file)
        self.assertTrue(report["valid"], f"Validation failed for 1.5x: {report['errors']}")
        self.assertEqual(report["valid_chunks"], 3)

    def test_valid_with_final_partial_chunk_synthetic(self):
        """Synthetic fixture: Regular chunks followed by an 800-sample final partial chunk."""
        records = [
            {
                "session_id": "synthetic-partial-001",
                "video_id": "vid123",
                "epoch": 0,
                "chunk_id": 0,
                "sample_rate_hz": 16000,
                "channels": 1,
                "sample_count": 1600,
                "audio_duration_s": 0.100,
                "chunk_video_start": 5.0,
                "chunk_video_end": 5.100,
                "playback_rate": 1.0,
                "paused": False,
                "seeking": False,
                "ad_state": "unknown",
                "stt_eligible": True,
                "is_final_partial": False,
            },
            {
                "session_id": "synthetic-partial-001",
                "video_id": "vid123",
                "epoch": 0,
                "chunk_id": 1,
                "sample_rate_hz": 16000,
                "channels": 1,
                "sample_count": 800,
                "audio_duration_s": 0.050,
                "chunk_video_start": 5.100,
                "chunk_video_end": 5.150,
                "playback_rate": 1.0,
                "paused": False,
                "seeking": False,
                "ad_state": "unknown",
                "stt_eligible": True,
                "is_final_partial": True,
            },
        ]
        temp_file = self.create_temp_jsonl(records)
        report = validate_file(temp_file)
        self.assertTrue(report["valid"], f"Partial chunk validation failed: {report['errors']}")
        self.assertEqual(report["final_partial_chunks"], 1)

    def test_valid_unverified_null_anchors_synthetic(self):
        """Synthetic fixture: Chunks emitted before video starts playing (null anchors, not stt_eligible)."""
        records = [
            {
                "session_id": "synthetic-unanchored",
                "video_id": None,
                "epoch": 0,
                "chunk_id": 0,
                "sample_rate_hz": 16000,
                "channels": 1,
                "sample_count": 1600,
                "audio_duration_s": 0.100,
                "chunk_video_start": None,
                "chunk_video_end": None,
                "playback_rate": 1.0,
                "paused": True,
                "seeking": False,
                "ad_state": "unknown",
                "stt_eligible": False,
            }
        ]
        temp_file = self.create_temp_jsonl(records)
        report = validate_file(temp_file)
        self.assertTrue(report["valid"])
        self.assertEqual(report["unverified_anchor_chunks"], 1)
        self.assertEqual(report["eligible_chunks"], 0)

    def test_valid_epoch_transition_across_seek_synthetic(self):
        """Synthetic fixture: User seeks backwards from 50.0s to 12.0s; epoch increments from 0 to 1."""
        records = [
            {
                "session_id": "synthetic-seek-01",
                "video_id": "vid_seek",
                "epoch": 0,
                "chunk_id": 10,
                "sample_rate_hz": 16000,
                "channels": 1,
                "sample_count": 1600,
                "audio_duration_s": 0.100,
                "chunk_video_start": 50.0,
                "chunk_video_end": 50.1,
                "playback_rate": 1.0,
                "paused": False,
                "seeking": False,
                "ad_state": "no_ad",
                "stt_eligible": True,
            },
            # Non-monotonic video jump across new epoch is completely valid
            {
                "session_id": "synthetic-seek-01",
                "video_id": "vid_seek",
                "epoch": 1,
                "chunk_id": 0,
                "sample_rate_hz": 16000,
                "channels": 1,
                "sample_count": 1600,
                "audio_duration_s": 0.100,
                "chunk_video_start": 12.0,
                "chunk_video_end": 12.1,
                "playback_rate": 1.0,
                "paused": False,
                "seeking": False,
                "ad_state": "no_ad",
                "stt_eligible": True,
            },
        ]
        temp_file = self.create_temp_jsonl(records)
        report = validate_file(temp_file)
        self.assertTrue(report["valid"], f"Epoch transition validation failed: {report['errors']}")

    def test_invalid_json_syntax_synthetic(self):
        """Synthetic fixture: Malformed JSON syntax must report exact line number error."""
        lines = [
            '{"session_id": "s1", "valid": false}',
            '{"unclosed_json": 123, ',
        ]
        temp_file = self.create_temp_jsonl(lines)
        report = validate_file(temp_file)
        self.assertFalse(report["valid"])
        self.assertTrue(any(e["line"] == 2 and "Invalid JSON syntax" in e["error"] for e in report["errors"]))

    def test_invalid_sample_rate_and_channels_synthetic(self):
        """Synthetic fixture: Non-16kHz sample rate and stereo channels must be rejected."""
        records = [
            {
                "session_id": "s-err",
                "video_id": "v1",
                "epoch": 0,
                "chunk_id": 0,
                "sample_rate_hz": 48000,  # Invalid
                "channels": 2,            # Invalid
                "sample_count": 1600,
                "audio_duration_s": 0.100,
                "chunk_video_start": 1.0,
                "chunk_video_end": 1.1,
                "playback_rate": 1.0,
                "paused": False,
                "seeking": False,
                "ad_state": "no_ad",
                "stt_eligible": False,
            }
        ]
        temp_file = self.create_temp_jsonl(records)
        report = validate_file(temp_file)
        self.assertFalse(report["valid"])
        error_fields = {e["field"] for e in report["errors"]}
        self.assertIn("sample_rate_hz", error_fields)
        self.assertIn("channels", error_fields)

    def test_invalid_sample_count_duration_mismatch_synthetic(self):
        """Synthetic fixture: sample_count != audio_duration_s * sample_rate_hz must be rejected."""
        records = [
            {
                "session_id": "s-err2",
                "video_id": "v1",
                "epoch": 0,
                "chunk_id": 0,
                "sample_rate_hz": 16000,
                "channels": 1,
                "sample_count": 1600,
                "audio_duration_s": 0.500,  # Mismatch: 1600 / 16000 = 0.100 != 0.500
                "chunk_video_start": 1.0,
                "chunk_video_end": 1.1,
                "playback_rate": 1.0,
                "paused": False,
                "seeking": False,
                "ad_state": "no_ad",
                "stt_eligible": False,
            }
        ]
        temp_file = self.create_temp_jsonl(records)
        report = validate_file(temp_file)
        self.assertFalse(report["valid"])
        self.assertTrue(any(e["field"] == "audio_duration_s" for e in report["errors"]))

    def test_invalid_partial_without_flag_synthetic(self):
        """Synthetic fixture: Less than 1600 samples without is_final_partial=True must fail."""
        records = [
            {
                "session_id": "s-err3",
                "video_id": "v1",
                "epoch": 0,
                "chunk_id": 0,
                "sample_rate_hz": 16000,
                "channels": 1,
                "sample_count": 1200,      # Incomplete
                "audio_duration_s": 0.075,
                "chunk_video_start": 1.0,
                "chunk_video_end": 1.075,
                "playback_rate": 1.0,
                "paused": False,
                "seeking": False,
                "ad_state": "no_ad",
                "stt_eligible": False,
                "is_final_partial": False, # Missing true flag
            }
        ]
        temp_file = self.create_temp_jsonl(records)
        report = validate_file(temp_file)
        self.assertFalse(report["valid"])
        self.assertTrue(any(e["field"] == "sample_count" for e in report["errors"]))

    def test_invalid_duplicate_chunk_id_synthetic(self):
        """Synthetic fixture: Duplicate (session_id, epoch, chunk_id) must be detected."""
        records = [
            {
                "session_id": "s-dup",
                "video_id": "v1",
                "epoch": 0,
                "chunk_id": 5,
                "sample_rate_hz": 16000,
                "channels": 1,
                "sample_count": 1600,
                "audio_duration_s": 0.100,
                "chunk_video_start": 1.0,
                "chunk_video_end": 1.1,
                "playback_rate": 1.0,
                "paused": False,
                "seeking": False,
                "ad_state": "no_ad",
                "stt_eligible": True,
            },
            {
                "session_id": "s-dup",
                "video_id": "v1",
                "epoch": 0,
                "chunk_id": 5,             # Duplicate ID in same epoch
                "sample_rate_hz": 16000,
                "channels": 1,
                "sample_count": 1600,
                "audio_duration_s": 0.100,
                "chunk_video_start": 1.1,
                "chunk_video_end": 1.2,
                "playback_rate": 1.0,
                "paused": False,
                "seeking": False,
                "ad_state": "no_ad",
                "stt_eligible": True,
            },
        ]
        temp_file = self.create_temp_jsonl(records)
        report = validate_file(temp_file)
        self.assertFalse(report["valid"])
        self.assertTrue(any("Duplicate" in e["error"] for e in report["errors"]))

    def test_invalid_video_time_span_deviation_synthetic(self):
        """Synthetic fixture: Video span (end - start) deviating from duration * rate must be rejected."""
        records = [
            {
                "session_id": "s-span",
                "video_id": "v1",
                "epoch": 0,
                "chunk_id": 0,
                "sample_rate_hz": 16000,
                "channels": 1,
                "sample_count": 1600,
                "audio_duration_s": 0.100,
                "chunk_video_start": 10.0,
                "chunk_video_end": 10.500,  # Expected 10.100 at 1.0x, 0.500 is 400ms off
                "playback_rate": 1.0,
                "paused": False,
                "seeking": False,
                "ad_state": "no_ad",
                "stt_eligible": True,
            }
        ]
        temp_file = self.create_temp_jsonl(records)
        report = validate_file(temp_file)
        self.assertFalse(report["valid"])
        self.assertTrue(any("deviates from audio_duration_s * playback_rate" in e["error"] for e in report["errors"]))

    def test_invalid_eligible_with_null_anchors_or_paused_synthetic(self):
        """Synthetic fixture: stt_eligible cannot be True if anchors are null or paused."""
        records = [
            {
                "session_id": "s-elig1",
                "video_id": "v1",
                "epoch": 0,
                "chunk_id": 0,
                "sample_rate_hz": 16000,
                "channels": 1,
                "sample_count": 1600,
                "audio_duration_s": 0.100,
                "chunk_video_start": None,
                "chunk_video_end": None,
                "playback_rate": 1.0,
                "paused": False,
                "seeking": False,
                "ad_state": "no_ad",
                "stt_eligible": True,       # Invalid: eligible with null anchors
            },
            {
                "session_id": "s-elig2",
                "video_id": "v1",
                "epoch": 0,
                "chunk_id": 1,
                "sample_rate_hz": 16000,
                "channels": 1,
                "sample_count": 1600,
                "audio_duration_s": 0.100,
                "chunk_video_start": 2.0,
                "chunk_video_end": 2.1,
                "playback_rate": 1.0,
                "paused": True,             # Invalid: eligible while paused
                "seeking": False,
                "ad_state": "no_ad",
                "stt_eligible": True,
            },
        ]
        temp_file = self.create_temp_jsonl(records)
        report = validate_file(temp_file)
        self.assertFalse(report["valid"])
        self.assertEqual(len(report["errors"]), 2)


def run_tests_and_save_report(report_path: str = "eval/results/test_audio_chunks_report.json") -> int:
    suite = unittest.TestLoader().loadTestsFromTestCase(TestAudioChunkValidationSynthetic)
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)

    os.makedirs(os.path.dirname(report_path), exist_ok=True)
    report_data = {
        "tests_run": result.testsRun,
        "failures": len(result.failures),
        "errors": len(result.errors),
        "was_successful": result.wasSuccessful(),
        "fixture_type": "SYNTHETIC_ONLY",
    }
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report_data, f, indent=2)

    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(run_tests_and_save_report())
