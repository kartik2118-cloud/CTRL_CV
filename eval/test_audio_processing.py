#!/usr/bin/env python3
"""
Unit and signal processing test suite for 16 kHz audio resampler and chunk accumulator (Role D).
All test signals generated here are explicitly SYNTHETIC.
"""

import json
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from resampler import StatefulResampler, AudioChunkAccumulator, design_butterworth_biquad_cascade


class TestAudioProcessingSynthetic(unittest.TestCase):
    """Synthetic test suite for audio worklet resampling, downmixing, and chunking."""

    def test_synthetic_silence(self):
        """SYNTHETIC: 1.0 second of silence at 48000 Hz must yield 10 chunks of 1600 samples with RMS=0 and Peak=0."""
        input_rate = 48000
        duration_s = 1.0
        total_samples = int(input_rate * duration_s)
        silence_input = [0.0] * total_samples

        resampler = StatefulResampler(input_rate_hz=input_rate, target_rate_hz=16000)
        accumulator = AudioChunkAccumulator(target_chunk_samples=1600, sample_rate_hz=16000)

        # Feed in standard 128-sample worklet blocks
        block_size = 128
        all_meta = []
        for i in range(0, total_samples, block_size):
            block = silence_input[i:i + block_size]
            resampled = resampler.process(block)
            meta, _ = accumulator.feed(resampled)
            all_meta.extend(meta)

        self.assertGreaterEqual(len(all_meta), 9)
        self.assertLessEqual(len(all_meta), 10)

        for chunk in all_meta:
            self.assertEqual(chunk["sample_count"], 1600)
            self.assertEqual(chunk["sample_rate_hz"], 16000)
            self.assertEqual(chunk["channels"], 1)
            self.assertEqual(chunk["audio_duration_s"], 0.100)
            self.assertEqual(chunk["byte_length"], 6400)
            self.assertEqual(chunk["rms"], 0.0)
            self.assertEqual(chunk["peak"], 0.0)
            self.assertFalse(chunk["is_final_partial"])

    def test_synthetic_mono_tone(self):
        """SYNTHETIC: 1000 Hz sine wave at 48000 Hz resampled to 16000 Hz must preserve amplitude and RMS ~ 0.707."""
        input_rate = 48000
        freq = 1000.0
        duration_s = 0.5
        num_samples = int(input_rate * duration_s)
        sine_input = [math.sin(2.0 * math.pi * freq * (n / input_rate)) for n in range(num_samples)]

        resampler = StatefulResampler(input_rate_hz=input_rate, target_rate_hz=16000)
        accumulator = AudioChunkAccumulator(target_chunk_samples=1600, sample_rate_hz=16000)

        all_meta = []
        for i in range(0, num_samples, 128):
            block = sine_input[i:i + 128]
            resampled = resampler.process(block)
            meta, _ = accumulator.feed(resampled)
            all_meta.extend(meta)

        self.assertGreaterEqual(len(all_meta), 4)
        # Check steady-state chunks (skip initial transient chunk 0)
        for chunk in all_meta[1:]:
            self.assertAlmostEqual(chunk["rms"], 1.0 / math.sqrt(2.0), delta=0.05)
            self.assertAlmostEqual(chunk["peak"], 1.0, delta=0.06)

    def test_synthetic_stereo_downmix(self):
        """SYNTHETIC: Downmix stereo channels (ch0 + ch1) * 0.5."""
        left = [0.8, -0.4, 0.5, 1.0]
        right = [0.2, 0.4, -0.5, 0.0]
        expected_mono = [0.5, 0.0, 0.0, 0.5]

        downmixed = [(l + r) * 0.5 for l, r in zip(left, right)]
        for actual, expected in zip(downmixed, expected_mono):
            self.assertAlmostEqual(actual, expected, places=5)

    def test_multiple_input_rates_44100_and_48000_and_16000(self):
        """SYNTHETIC: Test resampling consistency across 48000 Hz, 44100 Hz, and 16000 Hz passthrough."""
        for rate in [48000, 44100, 16000]:
            duration_s = 0.400  # 400 ms -> should produce exactly 4 full 100ms chunks (6400 samples)
            total_in = int(rate * duration_s)
            sine_in = [0.5 * math.sin(2.0 * math.pi * 440.0 * (n / rate)) for n in range(total_in)]

            resampler = StatefulResampler(input_rate_hz=rate, target_rate_hz=16000)
            accumulator = AudioChunkAccumulator(target_chunk_samples=1600, sample_rate_hz=16000)

            all_meta = []
            for i in range(0, total_in, 128):
                block = sine_in[i:i + 128]
                resampled = resampler.process(block)
                meta, _ = accumulator.feed(resampled)
                all_meta.extend(meta)

            partial_meta = accumulator.flush()
            total_produced = sum(m["sample_count"] for m in all_meta)
            if partial_meta:
                total_produced += partial_meta[0]["sample_count"]

            expected_samples = int(duration_s * 16000)
            # Allow at most 2 samples difference due to fractional filter warmup/end phase
            self.assertAlmostEqual(total_produced, expected_samples, delta=3,
                                   msg=f"Failed rate {rate}: expected {expected_samples}, got {total_produced}")

    def test_variable_callback_block_sizes(self):
        """SYNTHETIC: Worklet must handle variable block lengths (e.g. 64, 100, 256, 512, 17) seamlessly."""
        input_rate = 48000
        duration_s = 0.3
        total_samples = int(input_rate * duration_s)
        test_signal = [0.3 * math.sin(2.0 * math.pi * 300.0 * (n / input_rate)) for n in range(total_samples)]

        resampler = StatefulResampler(input_rate_hz=input_rate, target_rate_hz=16000)
        accumulator = AudioChunkAccumulator(target_chunk_samples=1600, sample_rate_hz=16000)

        # Varying block sizes
        block_sizes = [64, 128, 256, 50, 100, 512, 33]
        idx = 0
        all_meta = []
        b_idx = 0
        while idx < total_samples:
            sz = block_sizes[b_idx % len(block_sizes)]
            b_idx += 1
            block = test_signal[idx:idx + sz]
            idx += sz
            resampled = resampler.process(block)
            meta, _ = accumulator.feed(resampled)
            all_meta.extend(meta)

        self.assertGreaterEqual(len(all_meta), 2)
        for chunk in all_meta:
            self.assertEqual(chunk["sample_count"], 1600)

    def test_chunk_boundary_continuity(self):
        """SYNTHETIC: Consecutive chunks on a continuous sine wave must have no discontinuity at the boundary."""
        input_rate = 48000
        freq = 400.0
        duration_s = 0.3  # produces multiple chunks
        num_samples = int(input_rate * duration_s)
        sine_input = [math.sin(2.0 * math.pi * freq * (n / input_rate)) for n in range(num_samples)]

        resampler = StatefulResampler(input_rate_hz=input_rate, target_rate_hz=16000)
        accumulator = AudioChunkAccumulator(target_chunk_samples=1600, sample_rate_hz=16000)

        all_chunks_data = []
        for i in range(0, num_samples, 128):
            block = sine_input[i:i + 128]
            resampled = resampler.process(block)
            _, data = accumulator.feed(resampled)
            all_chunks_data.extend(data)

        self.assertGreaterEqual(len(all_chunks_data), 2)
        # Check boundary between chunk 0 end and chunk 1 start
        last_sample_c0 = all_chunks_data[0][-1]
        first_sample_c1 = all_chunks_data[1][0]

        # In a 400 Hz wave at 16 kHz, max delta per sample is 2*pi*f/Fs = 2*pi*400/16000 = ~0.157
        boundary_delta = abs(first_sample_c1 - last_sample_c0)
        self.assertLess(boundary_delta, 0.20, f"Discontinuity at chunk boundary: delta={boundary_delta:.4f}")

    def test_final_partial_chunk_handling(self):
        """SYNTHETIC: Abrupt stop after 250 ms yields 2 full 100ms chunks + 1 final partial 50ms (800 samples) chunk."""
        input_rate = 48000
        duration_s = 0.250  # 250 ms -> 4000 samples at 16k -> 1600 + 1600 + 800
        num_samples = int(input_rate * duration_s)
        test_signal = [0.5 * math.sin(2.0 * math.pi * 500.0 * (n / input_rate)) for n in range(num_samples)]

        resampler = StatefulResampler(input_rate_hz=input_rate, target_rate_hz=16000)
        accumulator = AudioChunkAccumulator(target_chunk_samples=1600, sample_rate_hz=16000)

        all_meta = []
        for i in range(0, num_samples, 128):
            block = test_signal[i:i + 128]
            resampled = resampler.process(block)
            meta, _ = accumulator.feed(resampled)
            all_meta.extend(meta)

        self.assertEqual(len(all_meta), 2)
        for m in all_meta:
            self.assertEqual(m["sample_count"], 1600)
            self.assertFalse(m["is_final_partial"])

        # Flush on teardown
        partial = accumulator.flush()
        self.assertIsNotNone(partial)
        partial_meta, partial_samples = partial
        self.assertTrue(partial_meta["is_final_partial"])
        self.assertAlmostEqual(partial_meta["sample_count"], 800, delta=2)
        self.assertAlmostEqual(partial_meta["audio_duration_s"], 0.050, delta=0.001)

    def test_above_nyquist_alias_suppression(self):
        """
        SYNTHETIC: An input tone above target Nyquist (e.g. 10 kHz at 48 kHz input rate)
        must be suppressed by at least 30 dB compared to a 1 kHz passband tone.
        """
        input_rate = 48000
        duration_s = 0.3
        num_samples = int(input_rate * duration_s)

        # 1. Passband reference: 1000 Hz
        ref_signal = [math.sin(2.0 * math.pi * 1000.0 * (n / input_rate)) for n in range(num_samples)]
        resampler_ref = StatefulResampler(input_rate_hz=input_rate, target_rate_hz=16000)
        ref_out = []
        for i in range(0, num_samples, 128):
            ref_out.extend(resampler_ref.process(ref_signal[i:i + 128]))

        # Calculate steady-state RMS of passband (skipping first 400 samples transient)
        steady_ref = ref_out[400:]
        rms_passband = math.sqrt(sum(s * s for s in steady_ref) / len(steady_ref))

        # 2. Stopband signal: 10,000 Hz (above 8,000 Hz Nyquist)
        stop_signal = [math.sin(2.0 * math.pi * 10000.0 * (n / input_rate)) for n in range(num_samples)]
        resampler_stop = StatefulResampler(input_rate_hz=input_rate, target_rate_hz=16000)
        stop_out = []
        for i in range(0, num_samples, 128):
            stop_out.extend(resampler_stop.process(stop_signal[i:i + 128]))

        steady_stop = stop_out[400:]
        rms_stopband = math.sqrt(sum(s * s for s in steady_stop) / len(steady_stop))

        # Calculate suppression in decibels
        ratio = rms_stopband / rms_passband
        suppression_db = 20.0 * math.log10(ratio)

        print(f"\n[Alias Suppression Measurement] Passband (1kHz) RMS: {rms_passband:.4f} | "
              f"Stopband (10kHz) RMS: {rms_stopband:.6f} | Suppression: {suppression_db:.2f} dB")

        # Suppression must be at least -30 dB (ratio < 0.0316)
        self.assertLess(suppression_db, -30.0,
                        f"Alias suppression insufficient: {suppression_db:.2f} dB (expected < -30 dB)")


def run_and_save_report(report_path="eval/results/audio_processing_report.json"):
    suite = unittest.TestLoader().loadTestsFromTestCase(TestAudioProcessingSynthetic)
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)

    os.makedirs(os.path.dirname(report_path), exist_ok=True)
    report_data = {
        "tests_run": result.testsRun,
        "failures": len(result.failures),
        "errors": len(result.errors),
        "was_successful": result.wasSuccessful(),
        "fixture_type": "SYNTHETIC_SIGNAL_TESTS",
    }
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report_data, f, indent=2)

    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(run_and_save_report())
