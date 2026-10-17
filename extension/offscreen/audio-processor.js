/**
 * audio-processor.js - AudioWorkletProcessor
 * Downsamples browser audio (44.1kHz / 48kHz stereo) to crystal-clear 16kHz Mono 16-bit PCM.
 * Maintains continuous sample phase across 128-frame blocks to eliminate phase clicks.
 * Emits 800ms audio chunks (12,800 Int16 samples = 25,600 bytes) for optimal Whisper ASR.
 */

class PcmResamplerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetSampleRate = 16000;
    // 400ms at 16kHz = 6,400 samples (ultra-low latency detection)
    this.buffer = new Int16Array(6400);
    this.bufferIndex = 0;
    this.phase = 0.0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) {
      return true;
    }

    const channel0 = input[0];
    const channel1 = input.length > 1 ? input[1] : null;
    const len = channel0.length;
    const resampleRatio = sampleRate / this.targetSampleRate;

    while (this.phase < len) {
      const idx = Math.floor(this.phase);
      const frac = this.phase - idx;
      const nextIdx = Math.min(idx + 1, len - 1);

      // Stereo to mono downmix
      let s0 = channel0[idx];
      let s1 = channel0[nextIdx];
      if (channel1) {
        s0 = (s0 + channel1[idx]) * 0.5;
        s1 = (s1 + channel1[nextIdx]) * 0.5;
      }

      // Linear interpolation to prevent aliasing
      let sample = s0 + frac * (s1 - s0);
      sample = Math.max(-1.0, Math.min(1.0, sample));
      
      // Convert Float32 to Signed 16-bit PCM Int16
      const int16Val = sample < 0 ? sample * 32768 : sample * 32767;
      this.buffer[this.bufferIndex++] = Math.round(int16Val);

      if (this.bufferIndex >= this.buffer.length) {
        // Full 400ms chunk ready
        const chunkToSend = new Int16Array(this.buffer);
        this.port.postMessage({
          type: 'CHUNK_AUDIO',
          pcm: chunkToSend.buffer,
          sample_rate_hz: this.targetSampleRate,
          sample_count: chunkToSend.length,
          audio_duration_s: chunkToSend.length / this.targetSampleRate,
          wall_time_ms: Date.now()
        }, [chunkToSend.buffer]);
        this.buffer = new Int16Array(6400);
        this.bufferIndex = 0;
      }

      this.phase += resampleRatio;
    }

    // Carry over remaining phase offset to the next 128-sample block
    this.phase -= len;
    return true;
  }
}

try {
  registerProcessor('audio-chunk-processor', PcmResamplerProcessor);
} catch (e) {}
try {
  registerProcessor('pcm-resampler-processor', PcmResamplerProcessor);
} catch (e) {}
