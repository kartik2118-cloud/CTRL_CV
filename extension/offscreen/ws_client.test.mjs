import test from 'node:test';
import assert from 'node:assert/strict';
import { WsClient } from './ws_client.js';

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.textFrames = [];
    this.binaryFrames = [];
    this.closed = false;

    // Simulate async connection open
    setTimeout(() => {
      this.readyState = 1; // OPEN
      if (typeof this.onopen === 'function') {
        this.onopen();
      }
    }, 5);
  }

  send(data) {
    if (typeof data === 'string') {
      this.textFrames.push(data);
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'hello') {
          setTimeout(() => {
            if (typeof this.onmessage === 'function') {
              this.onmessage({
                data: JSON.stringify({
                  type: 'hello_ack',
                  session_id: parsed.client_id || 'test_sess',
                  epoch: 0
                })
              });
            }
          }, 5);
        }
      } catch (_) {}
    } else {
      this.binaryFrames.push(data);
    }
  }

  close() {
    this.readyState = 3;
    this.closed = true;
    if (typeof this.onclose === 'function') {
      this.onclose();
    }
  }
}

function create100msPcmBlock(sampleRate = 16000) {
  // 100 ms at 16 kHz = 1600 samples = 3200 bytes
  const count = Math.round(sampleRate * 0.1);
  const pcm = new Int16Array(count);
  for (let i = 0; i < count; i++) {
    pcm[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 16384);
  }
  return pcm;
}

test('WsClient: Handshake protocol (hello -> hello_ack)', async () => {
  const client = new WsClient({
    WebSocketClass: FakeWebSocket,
    url: 'ws://localhost:8000/ws',
    lang: 'hi',
    targetLang: 'en',
    sessionId: 'sess_preflight_1'
  });

  await client.connect();
  // Wait for fake socket hello_ack
  await new Promise(r => setTimeout(r, 20));

  assert.strictEqual(client.ws.readyState, 1);
  assert.strictEqual(client.isHandshakeComplete, true);
  assert.strictEqual(client.ws.textFrames.length, 1);

  const handshakeSent = JSON.parse(client.ws.textFrames[0]);
  assert.strictEqual(handshakeSent.type, 'hello');
  assert.strictEqual(handshakeSent.client_id, 'sess_preflight_1');
  assert.strictEqual(handshakeSent.lang, 'hi');
  assert.strictEqual(handshakeSent.target_lang, 'en');

  client.close();
});

test('WsClient: 100 ms -> 1 s aggregation and exact header fields', async () => {
  const sentEvents = [];
  const client = new WsClient({
    WebSocketClass: FakeWebSocket,
    url: 'ws://localhost:8000/ws',
    onChunkSent: (info) => sentEvents.push(info),
    initialEpoch: 0,
    initialPlaybackRate: 1.0
  });

  await client.connect();
  await new Promise(r => setTimeout(r, 20));

  client.updateVideoObservation({
    epoch: 0,
    video_id: 'vid123',
    video_current_time: 15.0,
    playback_rate: 1.0,
    paused: false,
    seeking: false,
    ad_state: 'main_video',
    wall_time_ms: Date.now()
  });

  // Feed 9 blocks (900 ms) -> should not flush yet
  for (let i = 0; i < 9; i++) {
    client.feedAudioBlock(create100msPcmBlock());
  }

  assert.strictEqual(sentEvents.length, 0, 'Must not send chunk before reaching ~1000 ms target');
  assert.strictEqual(client.bufferedSamples, 9 * 1600);

  // Feed 10th block (reaches 1000 ms) -> triggers chunk flush
  client.feedAudioBlock(create100msPcmBlock());

  assert.strictEqual(sentEvents.length, 1, 'Must send exactly 1 chunk after 1000 ms');
  const event0 = sentEvents[0];
  assert.strictEqual(event0.type, 'CHUNK_SENT');
  assert.strictEqual(event0.chunk_id, 0);
  assert.strictEqual(event0.video_start_time, 15.0);
  assert.strictEqual(event0.playback_rate, 1.0);

  // Check frames sent to fake WebSocket
  // textFrames[0] was hello, textFrames[1] is chunk header
  assert.strictEqual(client.ws.textFrames.length, 2);
  const header = JSON.parse(client.ws.textFrames[1]);

  // Verify exact required fields: {chunk_id, epoch, video_start_time, playback_rate, sample_rate}
  assert.strictEqual(typeof header.chunk_id, 'number');
  assert.strictEqual(typeof header.epoch, 'number');
  assert.strictEqual(typeof header.video_start_time, 'number');
  assert.strictEqual(typeof header.playback_rate, 'number');
  assert.strictEqual(typeof header.sample_rate, 'number');

  assert.strictEqual(header.chunk_id, 0);
  assert.strictEqual(header.epoch, 0);
  assert.strictEqual(header.video_start_time, 15.0);
  assert.strictEqual(header.playback_rate, 1.0);
  assert.strictEqual(header.sample_rate, 16000);

  // Check binary frame
  assert.strictEqual(client.ws.binaryFrames.length, 1);
  assert.strictEqual(client.ws.binaryFrames[0].byteLength, 16000 * 2, 'Must transmit 16000 samples = 32000 bytes');

  client.close();
});

test('WsClient: Rate-change flush (start = video_start_time + offset * rate at 0.5, 1.5, 2.0)', async () => {
  const sentChunks = [];
  const client = new WsClient({
    WebSocketClass: FakeWebSocket,
    url: 'ws://localhost:8000/ws',
    onChunkSent: (info) => sentChunks.push(info),
    initialEpoch: 0,
    initialPlaybackRate: 0.5
  });

  await client.connect();
  await new Promise(r => setTimeout(r, 20));

  // Anchor video at 10.0s
  client.updateVideoObservation({
    epoch: 0,
    video_id: 'vid_rate',
    video_current_time: 10.0,
    playback_rate: 0.5,
    paused: false,
    seeking: false,
    ad_state: 'main_video',
    wall_time_ms: Date.now()
  });

  // Stage A: Rate 0.5
  // Feed 3 blocks of 100 ms (0.3 s audio)
  for (let i = 0; i < 3; i++) {
    client.feedAudioBlock(create100msPcmBlock());
  }

  // Rate changes to 1.5: must flush chunk with OLD rate (0.5)
  client.setPlaybackRate(1.5);

  assert.strictEqual(sentChunks.length, 1);
  const chunk0 = sentChunks[0];
  assert.strictEqual(chunk0.chunk_id, 0);
  assert.strictEqual(chunk0.video_start_time, 10.0);
  assert.strictEqual(chunk0.playback_rate, 0.5);

  // Expected start of next chunk:
  // start = 10.0 + (0.3 s * 0.5) = 10.15
  assert.strictEqual(client.currentChunkVideoStartTime, 10.15);

  // Stage B: Rate 1.5
  // Feed 4 blocks of 100 ms (0.4 s audio)
  for (let i = 0; i < 4; i++) {
    client.feedAudioBlock(create100msPcmBlock());
  }

  // Rate changes to 2.0: must flush chunk with OLD rate (1.5)
  client.setPlaybackRate(2.0);

  assert.strictEqual(sentChunks.length, 2);
  const chunk1 = sentChunks[1];
  assert.strictEqual(chunk1.chunk_id, 1);
  assert.strictEqual(chunk1.video_start_time, 10.15);
  assert.strictEqual(chunk1.playback_rate, 1.5);

  // Expected start of next chunk:
  // start = 10.15 + (0.4 s * 1.5) = 10.15 + 0.6 = 10.75
  assert.strictEqual(client.currentChunkVideoStartTime, 10.75);

  // Stage C: Rate 2.0
  // Feed 10 blocks of 100 ms (1.0 s audio) -> aggregates to full 1.0 s chunk
  for (let i = 0; i < 10; i++) {
    client.feedAudioBlock(create100msPcmBlock());
  }

  assert.strictEqual(sentChunks.length, 3);
  const chunk2 = sentChunks[2];
  assert.strictEqual(chunk2.chunk_id, 2);
  assert.strictEqual(chunk2.video_start_time, 10.75);
  assert.strictEqual(chunk2.playback_rate, 2.0);

  // Expected start of next chunk after 1.0s at rate 2.0:
  // start = 10.75 + (1.0 s * 2.0) = 10.75 + 2.0 = 12.75
  assert.strictEqual(client.currentChunkVideoStartTime, 12.75);

  client.close();
});

test('WsClient: Epoch bump drops partial buffer (seek, navigation, ad)', async () => {
  const sentChunks = [];
  const client = new WsClient({
    WebSocketClass: FakeWebSocket,
    url: 'ws://localhost:8000/ws',
    onChunkSent: (info) => sentChunks.push(info),
    initialEpoch: 0,
    initialPlaybackRate: 1.0
  });

  await client.connect();
  await new Promise(r => setTimeout(r, 20));

  client.updateVideoObservation({
    epoch: 0,
    video_id: 'vid1',
    video_current_time: 20.0,
    playback_rate: 1.0,
    paused: false,
    seeking: false,
    ad_state: 'main_video',
    wall_time_ms: Date.now()
  });

  // Feed 5 blocks (500 ms)
  for (let i = 0; i < 5; i++) {
    client.feedAudioBlock(create100msPcmBlock());
  }
  assert.strictEqual(client.bufferedSamples, 5 * 1600);

  // Seek occurs -> epoch bump
  client.updateVideoObservation({
    epoch: 1,
    video_id: 'vid1',
    video_current_time: 80.0,
    playback_rate: 1.0,
    paused: false,
    seeking: true,
    ad_state: 'main_video',
    wall_time_ms: Date.now()
  });

  // Partial buffer must be discarded, zero chunks sent for dropped audio
  assert.strictEqual(client.bufferedSamples, 0);
  assert.strictEqual(client.partialBuffer.length, 0);
  assert.strictEqual(sentChunks.length, 0);
  assert.strictEqual(client.epoch, 1);

  // Now resume playing at new position 80.0s
  client.updateVideoObservation({
    epoch: 1,
    video_id: 'vid1',
    video_current_time: 80.0,
    playback_rate: 1.0,
    paused: false,
    seeking: false,
    ad_state: 'main_video',
    wall_time_ms: Date.now()
  });

  // Feed 10 blocks under new epoch
  for (let i = 0; i < 10; i++) {
    client.feedAudioBlock(create100msPcmBlock());
  }

  assert.strictEqual(sentChunks.length, 1);
  const chunkAfterSeek = sentChunks[0];
  assert.strictEqual(chunkAfterSeek.chunk_id, 0);
  assert.strictEqual(chunkAfterSeek.epoch, 1);
  assert.strictEqual(chunkAfterSeek.video_start_time, 80.0);
  assert.strictEqual(chunkAfterSeek.playback_rate, 1.0);

  client.close();
});

test('WsClient: Result normalization and forwarding', async () => {
  const resultsReceived = [];
  const client = new WsClient({
    WebSocketClass: FakeWebSocket,
    url: 'ws://localhost:8000/ws',
    onResult: (res) => resultsReceived.push(res),
    initialEpoch: 2,
    initialPlaybackRate: 1.5
  });

  await client.connect();
  await new Promise(r => setTimeout(r, 20));

  // Anchor and send chunk 7 at video_start_time 50.0
  client.updateVideoObservation({
    epoch: 2,
    video_id: 'vid_res',
    video_current_time: 50.0,
    playback_rate: 1.5,
    paused: false,
    seeking: false,
    ad_state: 'main_video',
    wall_time_ms: Date.now()
  });

  for (let i = 0; i < 10; i++) {
    client.feedAudioBlock(create100msPcmBlock());
  }

  // Simulate backend returning subtitle result frame
  client.ws.onmessage({
    data: JSON.stringify({
      type: 'subtitle',
      chunk_id: 0,
      epoch: 2,
      start: 50.15,
      end: 51.35,
      lang: 'hi',
      text: 'नमस्ते दोस्तों',
      translation: 'Hello friends',
      source: 'stt'
    })
  });

  assert.strictEqual(resultsReceived.length, 1);
  const res = resultsReceived[0];
  assert.strictEqual(res.type, 'RESULT');
  assert.strictEqual(res.chunk_id, 0);
  assert.strictEqual(res.epoch, 2);
  assert.strictEqual(res.start, 50.15);
  assert.strictEqual(res.end, 51.35);
  assert.strictEqual(res.start_offset, 0.1);
  assert.strictEqual(res.end_offset, 0.9);
  assert.strictEqual(res.is_final, true);
  assert.strictEqual(res.lang, 'hi');
  assert.deepStrictEqual(res.langs, ['hi']);
  assert.strictEqual(res.text, 'नमस्ते दोस्तों');
  assert.strictEqual(res.translation, 'Hello friends');
  assert.strictEqual(res.source, 'stt');

  client.close();
});
