#!/usr/bin/env python3
"""
Reproducible Timing Accuracy Benchmark with Local Synthetic Media Fixture (Role D).
Synthesizes audio with known marker pulses placed at exact video timestamps,
runs the audio through the resampler and SyncCoordinator, and measures actual timing error.
Does NOT download or export YouTube media.
"""

import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from resampler import StatefulResampler, AudioChunkAccumulator
from sync_coordinator import SyncCoordinator


def run_benchmark():
    input_rate = 48000
    target_rate = 16000
    playback_rate = 1.0

    # 5-second simulated video playback at 1.0x
    duration_s = 5.0
    total_input_samples = int(input_rate * duration_s)

    # 1. Synthesize audio with sharp 5ms 2 kHz tone pulses at exact video times 1.0s, 2.0s, 3.0s, 4.0s
    audio = [0.0] * total_input_samples
    true_marker_times = [1.000, 2.000, 3.000, 4.000]

    for t_marker in true_marker_times:
        start_idx = int(t_marker * input_rate)
        pulse_len = int(0.005 * input_rate)  # 5ms pulse
        for k in range(pulse_len):
            idx = start_idx + k
            if idx < total_input_samples:
                # 2 kHz burst
                audio[idx] = math.sin(2.0 * math.pi * 2000.0 * (k / input_rate))

    # 2. Setup processing pipeline
    resampler = StatefulResampler(input_rate_hz=input_rate, target_rate_hz=target_rate)
    accumulator = AudioChunkAccumulator(target_chunk_samples=1600, sample_rate_hz=target_rate)
    coordinator = SyncCoordinator(session_id="benchmark_session")

    # Initial video anchor at t=0
    wall_start = 1000.0
    coordinator.register_observation({
        "video_id": "synthetic_bench_vid",
        "epoch": 0,
        "video_current_time": 0.0,
        "playback_rate": playback_rate,
        "paused": False,
        "seeking": False,
        "ad_state": "no_ad",
        "wall_time_ms": wall_start,
    })

    detected_markers = []
    block_size = 128
    simulated_wall_time = wall_start

    # Feed blocks
    for i in range(0, total_input_samples, block_size):
        block = audio[i:i + block_size]
        resampled = resampler.process(block)
        meta_list, data_list = accumulator.feed(resampled)

        # Update simulated wall clock
        simulated_wall_time += (len(block) / input_rate) * 1000.0

        # Periodic observation heartbeat every 100ms
        current_video_progress = (simulated_wall_time - wall_start) / 1000.0 * playback_rate
        coordinator.register_observation({
            "video_id": "synthetic_bench_vid",
            "epoch": 0,
            "video_current_time": current_video_progress,
            "playback_rate": playback_rate,
            "paused": False,
            "seeking": False,
            "ad_state": "no_ad",
            "wall_time_ms": simulated_wall_time,
        })

        for chunk_meta, chunk_data in zip(meta_list, data_list):
            diag = coordinator.associate_chunk(chunk_meta, simulated_wall_time)

            # Check if this chunk contains a pulse (peak > 0.5)
            if diag["stt_eligible"] and diag["peak"] > 0.5:
                # Find exact peak sample offset within chunk
                max_val = 0.0
                peak_offset = 0
                for s_idx, sample in enumerate(chunk_data):
                    if abs(sample) > max_val:
                        max_val = abs(sample)
                        peak_offset = s_idx

                offset_s = peak_offset / target_rate
                # Apply key timing formula: t_video = chunk_video_start + offset_in_chunk * playback_rate
                estimated_t_video = diag["chunk_video_start"] + (offset_s * playback_rate)
                detected_markers.append({
                    "chunk_id": diag["chunk_id"],
                    "peak_offset_sample": peak_offset,
                    "estimated_t_video": round(estimated_t_video, 4),
                })

    # Match detected markers to true marker times
    timing_errors_ms = []
    comparison = []

    for true_t in true_marker_times:
        # Find nearest detected marker
        matches = [m for m in detected_markers if abs(m["estimated_t_video"] - true_t) < 0.150]
        if matches:
            best = min(matches, key=lambda m: abs(m["estimated_t_video"] - true_t))
            error_s = best["estimated_t_video"] - true_t
            error_ms = round(error_s * 1000.0, 2)
            timing_errors_ms.append(error_ms)
            comparison.append({
                "true_video_time_s": true_t,
                "estimated_video_time_s": best["estimated_t_video"],
                "timing_error_ms": error_ms,
            })

    mean_abs_error_ms = round(sum(abs(e) for e in timing_errors_ms) / len(timing_errors_ms), 2) if timing_errors_ms else 0.0
    max_abs_error_ms = max(abs(e) for e in timing_errors_ms) if timing_errors_ms else 0.0

    benchmark_results = {
        "benchmark_type": "LOCAL_SYNTHETIC_MEDIA_FIXTURE_MARKERS",
        "markers_tested": len(true_marker_times),
        "markers_detected": len(timing_errors_ms),
        "mean_absolute_error_ms": mean_abs_error_ms,
        "max_absolute_error_ms": max_abs_error_ms,
        "detailed_markers": comparison,
    }

    out_json = os.path.join("eval", "results", "timing_accuracy_benchmark.json")
    os.makedirs(os.path.dirname(out_json), exist_ok=True)
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(benchmark_results, f, indent=2)

    print("=== Timing Synchronization Benchmark Results ===")
    print(f"Markers Tested:       {benchmark_results['markers_tested']}")
    print(f"Markers Detected:     {benchmark_results['markers_detected']}")
    print(f"Mean Abs Error (ms):  {benchmark_results['mean_absolute_error_ms']} ms")
    print(f"Max Abs Error (ms):   {benchmark_results['max_absolute_error_ms']} ms")
    print(f"Report saved:         {out_json}")
    for item in comparison:
        print(f"  Marker @ {item['true_video_time_s']}s -> Est: {item['estimated_video_time_s']}s (Error: {item['timing_error_ms']} ms)")

    return 0 if len(timing_errors_ms) == len(true_marker_times) else 1


if __name__ == "__main__":
    sys.exit(run_benchmark())
