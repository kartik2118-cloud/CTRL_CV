// Node.js test harness for extension/audio-processor.js
// All test signals generated here are explicitly SYNTHETIC.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

// 1. Mock AudioWorkletGlobalScope environment
let registeredProcessors = {};
global.sampleRate = 48000;

global.AudioWorkletProcessor = class {
  constructor() {
    this.port = {
      messages: [],
      onmessage: null,
      postMessage: function(msg) {
        this.messages.push(msg);
      }
    };
  }
};

global.registerProcessor = function(name, procClass) {
  registeredProcessors[name] = procClass;
};

// 2. Load the actual audio-processor.js script
const processorPath = path.join(__dirname, '..', 'extension', 'audio-processor.js');
const processorCode = fs.readFileSync(processorPath, 'utf8');
eval(processorCode);

assert(registeredProcessors['audio-chunk-processor'], 'AudioChunkProcessor must be registered');

// 3. Test instantiation
const ProcessorClass = registeredProcessors['audio-chunk-processor'];
const processor = new ProcessorClass();

assert.strictEqual(processor.inputRate, 48000, 'inputRate should be 48000');
assert.strictEqual(processor.targetRate, 16000, 'targetRate should be 16000');

// 4. Test feeding 1 second (48000 samples) of synthetic 1000 Hz stereo sine wave
const totalSamples = 48000;
const freq = 1000.0;
const left = new Float32Array(totalSamples);
const right = new Float32Array(totalSamples);

for (let i = 0; i < totalSamples; i++) {
  const val = Math.sin(2.0 * Math.PI * freq * (i / 48000));
  left[i] = val * 0.8;
  right[i] = val * 0.8;
}

// Feed in 128-sample blocks
const blockSize = 128;
for (let i = 0; i < totalSamples; i += blockSize) {
  const ch0 = left.subarray(i, i + blockSize);
  const ch1 = right.subarray(i, i + blockSize);
  const inputs = [[ch0, ch1]];
  const outputs = [[]];
  const keepAlive = processor.process(inputs, outputs, {});
  assert.strictEqual(keepAlive, true, 'process() must return true');
}

const emitted = processor.port.messages.filter(m => m.type === 'CHUNK_DIAGNOSTIC');
console.log(`[Node Test] Emitted ${emitted.length} chunks from 1.0s of audio.`);

assert(emitted.length >= 9 && emitted.length <= 10, `Expected 9-10 chunks, got ${emitted.length}`);

// Check metadata properties
for (const chunk of emitted) {
  assert.strictEqual(chunk.sample_rate_hz, 16000);
  assert.strictEqual(chunk.input_sample_rate_hz, 48000);
  assert.strictEqual(chunk.channels, 1);
  assert.strictEqual(chunk.sample_count, 1600);
  assert.strictEqual(chunk.audio_duration_s, 0.1);
  assert.strictEqual(chunk.byte_length, 6400);
  assert.strictEqual(chunk.is_final_partial, false);
  assert(chunk.rms > 0.45 && chunk.rms < 0.65, `Expected RMS around 0.56, got ${chunk.rms}`);
  assert(chunk.peak > 0.70 && chunk.peak <= 0.85, `Expected Peak around 0.80, got ${chunk.peak}`);
  assert(!('pcm' in chunk), 'Raw PCM must never be exported in diagnostic metadata');
}

// 5. Test flush partial
processor.port.onmessage({ data: { type: 'FLUSH_PARTIAL' } });
const flushed = processor.port.messages.filter(m => m.is_final_partial);
console.log(`[Node Test] Flush test completed. Total emitted: ${processor.port.messages.length}`);

// 6. Test discontinuity and epoch preservation (regression test for epoch 0 falsy bug)
processor.port.onmessage({ data: { type: 'DISCONTINUITY', epoch: 0, video_id: 'test_vid' } });
assert.strictEqual(processor.epoch, 0, 'epoch 0 must not be treated as falsy and incremented');

processor.port.onmessage({ data: { type: 'DISCONTINUITY', epoch: 2, video_id: 'test_vid_2' } });
assert.strictEqual(processor.epoch, 2, 'epoch 2 must be assigned accurately');

console.log('[Node Test] All JavaScript AudioWorklet tests passed successfully.');
