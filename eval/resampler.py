"""
Reference implementation of stateful anti-aliased audio resampler & chunker (Role D).
Converts arbitrary sample rate audio (e.g. 44.1k, 48k) to 16000 Hz mono in 1600-sample (100 ms) chunks.
"""

import math
from typing import Any, Dict, List, Optional, Tuple


def design_butterworth_biquad_cascade(cutoff_hz: float, sample_rate_hz: float, order: int = 8) -> List[Dict[str, float]]:
    """
    Designs an Nth-order Butterworth low-pass filter as a cascade of 2nd-order biquad sections.
    """
    sections = []
    num_sections = order // 2
    w0 = 2.0 * math.pi * cutoff_hz / sample_rate_hz
    cos_w0 = math.cos(w0)
    sin_w0 = math.sin(w0)

    for k in range(num_sections):
        # Butterworth pole angles: (2*k + 1) * pi / (2 * order)
        theta = (2 * k + 1) * math.pi / (2 * order)
        q = 1.0 / (2.0 * math.cos(theta))

        alpha = sin_w0 / (2.0 * q)
        b0 = (1.0 - cos_w0) / 2.0
        b1 = 1.0 - cos_w0
        b2 = (1.0 - cos_w0) / 2.0
        a0 = 1.0 + alpha
        a1 = -2.0 * cos_w0
        a2 = 1.0 - alpha

        sections.append({
            "b0": b0 / a0,
            "b1": b1 / a0,
            "b2": b2 / a0,
            "a1": a1 / a0,
            "a2": a2 / a0,
            "s1": 0.0,
            "s2": 0.0,
        })
    return sections


class StatefulResampler:
    """
    Stateful resampler converting audio from input_rate_hz to 16000 Hz mono.
    Uses Direct Form II Transposed biquad anti-aliasing filter and cubic Hermite interpolation.
    """

    def __init__(self, input_rate_hz: int, target_rate_hz: int = 16000, cutoff_hz: float = 6800.0):
        self.input_rate_hz = float(input_rate_hz)
        self.target_rate_hz = float(target_rate_hz)
        self.is_passthrough = abs(self.input_rate_hz - self.target_rate_hz) < 1.0

        if not self.is_passthrough and self.input_rate_hz > self.target_rate_hz:
            # 10th order Butterworth lowpass filter at 6800 Hz for > 35 dB alias suppression
            self.filter_sections = design_butterworth_biquad_cascade(cutoff_hz, input_rate_hz, order=10)
        else:
            self.filter_sections = []

        # Fractional resampling state
        self.ratio = self.input_rate_hz / self.target_rate_hz
        self.phase = 0.0  # fractional index into input history
        self.history = [0.0, 0.0, 0.0, 0.0]  # last 4 filtered input samples

    def _filter_sample(self, sample: float) -> float:
        val = sample
        for sec in self.filter_sections:
            y = sec["b0"] * val + sec["s1"]
            sec["s1"] = sec["b1"] * val - sec["a1"] * y + sec["s2"]
            sec["s2"] = sec["b2"] * val - sec["a2"] * y
            val = y
        return val

    def process(self, mono_input: List[float]) -> List[float]:
        """Processes a block of mono input samples and produces 16000 Hz output samples."""
        if not mono_input:
            return []

        if self.is_passthrough:
            return list(mono_input)

        # 1. Apply anti-aliasing filter
        filtered = [self._filter_sample(s) for s in mono_input]

        # 2. Resample using cubic Hermite interpolation across history buffer
        combined = self.history + filtered
        output = []

        # We need 4 points [p0, p1, p2, p3] for cubic interpolation around index i
        # History has 4 samples at indices 0, 1, 2, 3.
        # Index in `combined` where new samples start is 4.
        # Position starts at 3 + self.phase
        pos = 3.0 + self.phase
        max_pos = float(len(combined) - 2)

        while pos < max_pos:
            idx = int(pos)
            mu = pos - idx

            p0 = combined[idx - 1]
            p1 = combined[idx]
            p2 = combined[idx + 1]
            p3 = combined[idx + 2]

            # Cubic Hermite interpolation
            c0 = p1
            c1 = 0.5 * (p2 - p0)
            c2 = p0 - 2.5 * p1 + 2.0 * p2 - 0.5 * p3
            c3 = 0.5 * (p3 - p0) + 1.5 * (p1 - p2)

            out_val = c0 + mu * (c1 + mu * (c2 + mu * c3))
            output.append(out_val)
            pos += self.ratio

        # Save remaining phase and history for the next callback
        self.phase = pos - (len(combined) - 1)
        self.history = combined[-4:]

        return output


class AudioChunkAccumulator:
    """
    Accumulates 16000 Hz mono audio into exact 1600-sample (100 ms) chunks,
    calculates diagnostic metadata, and flushes final partial chunks on teardown.
    """

    def __init__(self, target_chunk_samples: int = 1600, sample_rate_hz: int = 16000):
        self.target_chunk_samples = target_chunk_samples
        self.sample_rate_hz = sample_rate_hz
        self.buffer: List[float] = []
        self.chunk_id = 0

    def compute_metadata(self, samples: List[float], is_final_partial: bool = False) -> Dict[str, Any]:
        count = len(samples)
        duration_s = count / self.sample_rate_hz
        byte_length = count * 4  # 4 bytes per Float32

        if count > 0:
            sum_sq = sum(s * s for s in samples)
            rms = math.sqrt(sum_sq / count)
            peak = max(abs(s) for s in samples)
        else:
            rms = 0.0
            peak = 0.0

        meta = {
            "chunk_id": self.chunk_id,
            "sample_rate_hz": self.sample_rate_hz,
            "channels": 1,
            "sample_count": count,
            "byte_length": byte_length,
            "audio_duration_s": round(duration_s, 6),
            "rms": round(rms, 6),
            "peak": round(peak, 6),
            "is_final_partial": is_final_partial,
        }
        self.chunk_id += 1
        return meta

    def feed(self, samples: List[float]) -> Tuple[List[Dict[str, Any]], List[List[float]]]:
        """Feeds samples and returns any completed chunks (metadata, samples)."""
        self.buffer.extend(samples)
        chunks_meta = []
        chunks_data = []

        while len(self.buffer) >= self.target_chunk_samples:
            chunk = self.buffer[:self.target_chunk_samples]
            self.buffer = self.buffer[self.target_chunk_samples:]
            meta = self.compute_metadata(chunk, is_final_partial=False)
            chunks_meta.append(meta)
            chunks_data.append(chunk)

        return chunks_meta, chunks_data

    def flush(self) -> Optional[Tuple[Dict[str, Any], List[float]]]:
        """Flushes any remaining samples as a final partial chunk."""
        if not self.buffer:
            return None
        chunk = list(self.buffer)
        self.buffer = []
        meta = self.compute_metadata(chunk, is_final_partial=True)
        return meta, chunk
