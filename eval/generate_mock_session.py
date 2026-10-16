#!/usr/bin/env python3
"""
Simulates an end-to-end session covering all edge cases (rates, pause, seek, navigation)
and validates the resulting JSONL log against docs/audio-chunk-contract.md.
All data generated here is explicitly SYNTHETIC.
"""

import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from resampler import StatefulResampler, AudioChunkAccumulator
from sync_coordinator import SyncCoordinator
from check_audio_chunks import validate_file


def generate_and_validate_session():
    coordinator = SyncCoordinator(session_id="synthetic-demo-session")
    resampler = StatefulResampler(input_rate_hz=48000, target_rate_hz=16000)
    accumulator = AudioChunkAccumulator(target_chunk_samples=1600, sample_rate_hz=16000)

    out_file = os.path.join("eval", "results", "demo_session_diagnostics.jsonl")
    os.makedirs(os.path.dirname(out_file), exist_ok=True)

    diagnostics = []
    wall_ms = 1000.0

    # Phase 1: Normal playback at 1.0x for 5 chunks (0.5s)
    coordinator.register_observation({
        "video_id": "video_alpha",
        "epoch": 0,
        "video_current_time": 10.0,
        "playback_rate": 1.0,
        "paused": False,
        "seeking": False,
        "ad_state": "no_ad",
        "wall_time_ms": wall_ms,
    })

    for i in range(5):
        wall_ms += 100.0
        # 4800 samples at 48k = 1600 samples at 16k
        raw_block = [0.2 * math.sin(2.0 * math.pi * 440.0 * (k / 48000.0)) for k in range(4800)]
        resampled = resampler.process(raw_block)
        meta_list, _ = accumulator.feed(resampled)
        for meta in meta_list:
            diag = coordinator.associate_chunk(meta, wall_ms)
            diagnostics.append(diag)

    # Phase 2: Speed change to 1.5x (epoch 1) for 4 chunks
    wall_ms += 50.0
    coordinator.register_observation({
        "video_id": "video_alpha",
        "epoch": 1,
        "video_current_time": 10.5,
        "playback_rate": 1.5,
        "paused": False,
        "seeking": False,
        "ad_state": "no_ad",
        "wall_time_ms": wall_ms,
    })

    for i in range(4):
        wall_ms += 100.0
        raw_block = [0.2 * math.sin(2.0 * math.pi * 440.0 * (k / 48000.0)) for k in range(4800)]
        resampled = resampler.process(raw_block)
        meta_list, _ = accumulator.feed(resampled)
        for meta in meta_list:
            diag = coordinator.associate_chunk(meta, wall_ms)
            diagnostics.append(diag)

    # Phase 3: Pause (epoch 2) for 2 chunks -> must be gated
    wall_ms += 50.0
    coordinator.register_observation({
        "video_id": "video_alpha",
        "epoch": 2,
        "video_current_time": 11.1,
        "playback_rate": 1.5,
        "paused": True,
        "seeking": False,
        "ad_state": "no_ad",
        "wall_time_ms": wall_ms,
    })

    for i in range(2):
        wall_ms += 100.0
        raw_block = [0.0] * 4800
        resampled = resampler.process(raw_block)
        meta_list, _ = accumulator.feed(resampled)
        for meta in meta_list:
            diag = coordinator.associate_chunk(meta, wall_ms)
            diagnostics.append(diag)

    # Phase 4: Seek backward to 2.0s & resume (epoch 3) for 4 chunks
    wall_ms += 500.0
    coordinator.register_observation({
        "video_id": "video_alpha",
        "epoch": 3,
        "video_current_time": 2.0,
        "playback_rate": 1.0,
        "paused": False,
        "seeking": False,
        "ad_state": "no_ad",
        "wall_time_ms": wall_ms,
    })

    for i in range(4):
        wall_ms += 100.0
        raw_block = [0.3 * math.sin(2.0 * math.pi * 880.0 * (k / 48000.0)) for k in range(4800)]
        resampled = resampler.process(raw_block)
        meta_list, _ = accumulator.feed(resampled)
        for meta in meta_list:
            diag = coordinator.associate_chunk(meta, wall_ms)
            diagnostics.append(diag)

    # Phase 5: SPA navigation to video_beta (epoch 4) for 5 chunks
    wall_ms += 1000.0
    coordinator.register_observation({
        "video_id": "video_beta",
        "epoch": 4,
        "video_current_time": 0.0,
        "playback_rate": 1.0,
        "paused": False,
        "seeking": False,
        "ad_state": "no_ad",
        "wall_time_ms": wall_ms,
    })

    for i in range(5):
        wall_ms += 100.0
        raw_block = [0.25 * math.sin(2.0 * math.pi * 520.0 * (k / 48000.0)) for k in range(4800)]
        resampled = resampler.process(raw_block)
        meta_list, _ = accumulator.feed(resampled)
        for meta in meta_list:
            diag = coordinator.associate_chunk(meta, wall_ms)
            diagnostics.append(diag)

    # Write JSONL
    with open(out_file, "w", encoding="utf-8") as f:
        for d in diagnostics:
            f.write(json.dumps(d) + "\n")

    # Run validator
    report = validate_file(out_file)
    print(f"Generated {len(diagnostics)} diagnostic chunks to: {out_file}")
    print(f"Validation Result: {'PASS' if report['valid'] else 'FAIL'}")
    print(f"  Valid Chunks: {report['valid_chunks']}/{report['total_lines']}")
    print(f"  STT Eligible: {report['eligible_chunks']}")
    print(f"  Errors:       {report['error_count']}")
    if not report["valid"]:
        for e in report["errors"][:5]:
            print(f"    Line {e['line']}: {e['error']}")

    return 0 if report["valid"] else 1


if __name__ == "__main__":
    sys.exit(generate_and_validate_session())
