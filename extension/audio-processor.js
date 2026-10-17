// AudioWorklet processor for 16 kHz mono chunking and diagnostic metadata emission.
// Runs in real-time AudioWorklet thread. No heavy allocations in process() callback.

function designButterworthBiquads(cutoffHz, sampleRateHz, order = 10) {
  const sections = [];
  const numSections = Math.floor(order / 2);
  const w0 = (2.0 * Math.PI * cutoffHz) / sampleRateHz;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);

  for (let k = 0; k < numSections; k++) {
    const theta = ((2 * k + 1) * Math.PI) / (2 * order);
    const q = 1.0 / (2.0 * Math.cos(theta));

    const alpha = sinW0 / (2.0 * q);
    const b0 = (1.0 - cosW0) / 2.0;
    const b1 = 1.0 - cosW0;
    const b2 = (1.0 - cosW0) / 2.0;
    const a0 = 1.0 + alpha;
    const a1 = -2.0 * cosW0;
    const a2 = 1.0 - alpha;

    sections.push({
      b0: b0 / a0,
      b1: b1 / a0,
      b2: b2 / a0,
      a1: a1 / a0,
      a2: a2 / a0,
      s1: 0.0,
      s2: 0.0
    });
  }
  return sections;
}

class AudioChunkProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.inputRate = sampleRate; // Global sampleRate in AudioWorkletGlobalScope
    this.isPassthrough = Math.abs(this.inputRate - this.targetRate) < 1.0;

    // Design anti-aliasing filter if downsampling is required (10th order Butterworth at 6800 Hz)
    if (!this.isPassthrough && this.inputRate > this.targetRate) {
      this.filterSections = designButterworthBiquads(6800, this.inputRate, 10);
    } else {
      this.filterSections = [];
    }

    this.ratio = this.inputRate / this.targetRate;
    this.phase = 0.0;
    this.history = [0.0, 0.0, 0.0, 0.0];

    // Pre-allocated chunk buffer for 1600 samples (100ms at 16kHz)
    this.targetChunkSamples = 1600;
    this.chunkBuffer = new Float32Array(this.targetChunkSamples);
    this.chunkWriteIdx = 0;
    this.chunkId = 0;

    this.epoch = 0;

    // Listen for messages from offscreen thread (e.g. FLUSH, DISCONTINUITY)
    this.port.onmessage = (event) => {
      if (!event.data) return;
      if (event.data.type === 'FLUSH_PARTIAL') {
        this.flushPartial();
      } else if (event.data.type === 'DISCONTINUITY') {
        this.epoch = (typeof event.data.epoch === 'number') ? event.data.epoch : (this.epoch + 1);
        // Requirement 9: Discard partial chunks that cross seek/rate/pause/navigation boundaries
        this.chunkWriteIdx = 0;
      }
    };

    console.log(`[AudioProcessor] Initialized with inputRate=${this.inputRate}Hz -> targetRate=${this.targetRate}Hz`);
  }

  filterSample(x) {
    let val = x;
    for (let i = 0; i < this.filterSections.length; i++) {
      const sec = this.filterSections[i];
      const y = sec.b0 * val + sec.s1;
      sec.s1 = sec.b1 * val - sec.a1 * y + sec.s2;
      sec.s2 = sec.b2 * val - sec.a2 * y;
      val = y;
    }
    return val;
  }

  emitChunk(isFinalPartial = false) {
    const sampleCount = isFinalPartial ? this.chunkWriteIdx : this.targetChunkSamples;
    if (sampleCount === 0) return;

    let sumSq = 0.0;
    let peak = 0.0;

    const pcm16 = new Int16Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      const s = Math.max(-1.0, Math.min(1.0, this.chunkBuffer[i]));
      sumSq += s * s;
      const absS = Math.abs(s);
      if (absS > peak) peak = absS;
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    const rms = Math.sqrt(sumSq / sampleCount);
    const durationS = sampleCount / this.targetRate;
    const byteLength = sampleCount * 2; // Int16: 2 bytes per sample

    this.port.postMessage({
      type: 'CHUNK_AUDIO',
      pcm: pcm16.buffer,
      epoch: this.epoch,
      chunk_id: this.chunkId++,
      sample_rate_hz: this.targetRate,
      input_sample_rate_hz: this.inputRate,
      channels: 1,
      sample_count: sampleCount,
      byte_length: byteLength,
      audio_duration_s: parseFloat(durationS.toFixed(6)),
      rms: parseFloat(rms.toFixed(6)),
      peak: parseFloat(peak.toFixed(6)),
      is_final_partial: isFinalPartial,
      wall_time_ms: Date.now()
    }, [pcm16.buffer]);

    this.chunkWriteIdx = 0;
  }

  flushPartial() {
    if (this.chunkWriteIdx > 0) {
      this.emitChunk(true);
    }
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) {
      return true;
    }

    const numChannels = input.length;
    const blockSize = input[0].length;
    const ch0 = input[0];
    const ch1 = numChannels > 1 ? input[1] : null;

    if (this.isPassthrough) {
      // 16000 Hz input passthrough
      for (let i = 0; i < blockSize; i++) {
        const mono = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
        this.chunkBuffer[this.chunkWriteIdx++] = mono;
        if (this.chunkWriteIdx === this.targetChunkSamples) {
          this.emitChunk(false);
        }
      }
      return true;
    }

    // Step 1: Downmix and filter incoming block
    // We combine last 4 history samples with the filtered new block
    const filteredBlock = new Float32Array(blockSize);
    for (let i = 0; i < blockSize; i++) {
      const mono = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
      filteredBlock[i] = this.filterSample(mono);
    }

    // Step 2: Stateful fractional interpolation across history + new samples
    const combinedLength = 4 + blockSize;
    const combined = new Float32Array(combinedLength);
    combined[0] = this.history[0];
    combined[1] = this.history[1];
    combined[2] = this.history[2];
    combined[3] = this.history[3];
    combined.set(filteredBlock, 4);

    let pos = 3.0 + this.phase;
    const maxPos = combinedLength - 2;

    while (pos < maxPos) {
      const idx = Math.floor(pos);
      const mu = pos - idx;

      const p0 = combined[idx - 1];
      const p1 = combined[idx];
      const p2 = combined[idx + 1];
      const p3 = combined[idx + 2];

      // Cubic Hermite interpolation
      const c0 = p1;
      const c1 = 0.5 * (p2 - p0);
      const c2 = p0 - 2.5 * p1 + 2.0 * p2 - 0.5 * p3;
      const c3 = 0.5 * (p3 - p0) + 1.5 * (p1 - p2);

      const outSample = c0 + mu * (c1 + mu * (c2 + mu * c3));
      this.chunkBuffer[this.chunkWriteIdx++] = outSample;

      if (this.chunkWriteIdx === this.targetChunkSamples) {
        this.emitChunk(false);
      }

      pos += this.ratio;
    }

    // Step 3: Update phase and history for the next callback
    this.phase = pos - (combinedLength - 1);
    this.history[0] = combined[combinedLength - 4];
    this.history[1] = combined[combinedLength - 3];
    this.history[2] = combined[combinedLength - 2];
    this.history[3] = combined[combinedLength - 1];

    return true;
  }
}

registerProcessor('audio-chunk-processor', AudioChunkProcessor);
