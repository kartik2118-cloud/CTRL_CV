import test from 'node:test';
import assert from 'node:assert/strict';
import { WsClient } from './ws_client.js';
import { SyncEngine } from '../../sync/syncEngine.js';
import { SyncBridge } from '../../sync/syncBridge.js';

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

  assert.strictEqual(client.ws.textFrames.length, 2);
  const header = JSON.parse(client.ws.textFrames[1]);

  // Exact required header fields: {chunk_id, epoch, video_start_time, playback_rate, sample_rate}
  assert.strictEqual(header.chunk_id, 0);
  assert.strictEqual(header.epoch, 0);
  assert.strictEqual(header.video_start_time, 15.0);
  assert.strictEqual(header.playback_rate, 1.0);
  assert.strictEqual(header.sample_rate, 16000);

  // Binary audio payload
  assert.strictEqual(client.ws.binaryFrames.length, 1);
  assert.strictEqual(client.ws.binaryFrames[0].byteLength, 16000 * 2);

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

  // Stage A: Rate 0.5, 3 blocks (0.3 s audio)
  for (let i = 0; i < 3; i++) {
    client.feedAudioBlock(create100msPcmBlock());
  }

  // Rate changes to 1.5 -> flush with OLD rate 0.5
  client.setPlaybackRate(1.5);
  assert.strictEqual(sentChunks.length, 1);
  assert.strictEqual(sentChunks[0].video_start_time, 10.0);
  assert.strictEqual(sentChunks[0].playback_rate, 0.5);

  // Next chunk starts at 10.0 + (0.3 * 0.5) = 10.15
  assert.strictEqual(client.currentChunkVideoStartTime, 10.15);

  // Stage B: Rate 1.5, 4 blocks (0.4 s audio)
  for (let i = 0; i < 4; i++) {
    client.feedAudioBlock(create100msPcmBlock());
  }

  // Rate changes to 2.0 -> flush with OLD rate 1.5
  client.setPlaybackRate(2.0);
  assert.strictEqual(sentChunks.length, 2);
  assert.strictEqual(sentChunks[1].video_start_time, 10.15);
  assert.strictEqual(sentChunks[1].playback_rate, 1.5);

  // Next chunk starts at 10.15 + (0.4 * 1.5) = 10.75
  assert.strictEqual(client.currentChunkVideoStartTime, 10.75);

  // Stage C: Rate 2.0, 10 blocks (1.0 s audio) -> aggregates to 1.0s chunk
  for (let i = 0; i < 10; i++) {
    client.feedAudioBlock(create100msPcmBlock());
  }
  assert.strictEqual(sentChunks.length, 3);
  assert.strictEqual(sentChunks[2].video_start_time, 10.75);
  assert.strictEqual(sentChunks[2].playback_rate, 2.0);

  // Next start after 1.0s at rate 2.0: 10.75 + (1.0 * 2.0) = 12.75
  assert.strictEqual(client.currentChunkVideoStartTime, 12.75);

  client.close();
});

test('WsClient: Backend seek message sent on seek, navigation, ad', async () => {
  const client = new WsClient({
    WebSocketClass: FakeWebSocket,
    url: 'ws://localhost:8000/ws',
    initialEpoch: 0
  });

  await client.connect();
  await new Promise(r => setTimeout(r, 20));

  // 1. Explicit seek
  const seek1 = client.onSeek(45.0);
  assert.strictEqual(seek1.type, 'seek');
  assert.strictEqual(seek1.video_time, 45.0);
  assert.strictEqual(seek1.epoch, 1);

  // 2. Navigation event
  const seek2 = client.onNavigation('vid_next', 0.0);
  assert.strictEqual(seek2.type, 'seek');
  assert.strictEqual(seek2.video_time, 0.0);
  assert.strictEqual(seek2.epoch, 2);

  // 3. Ad start event
  const seek3 = client.onAdStart(12.5);
  assert.strictEqual(seek3.type, 'seek');
  assert.strictEqual(seek3.video_time, 12.5);
  assert.strictEqual(seek3.epoch, 3);

  // 4. Ad end event
  const seek4 = client.onAdEnd(12.5);
  assert.strictEqual(seek4.type, 'seek');
  assert.strictEqual(seek4.video_time, 12.5);
  assert.strictEqual(seek4.epoch, 4);

  // Verify all seek frames were transmitted to WebSocket
  const seekFrames = client.ws.textFrames
    .map(f => JSON.parse(f))
    .filter(m => m.type === 'seek');

  assert.strictEqual(seekFrames.length, 4);
  assert.deepStrictEqual(seekFrames.map(s => s.epoch), [1, 2, 3, 4]);

  client.close();
});

test('WsClient + SyncEngine: No double conversion at rate 1.5, 0.5, 2.0', async () => {
  // Verifies: rate 1.5, video_start 60, backend start 66.0 -> cue.start must be 66.0 (not 126.0)
  // and the same at 0.5 and 2.0.

  const testCases = [
    { rate: 1.5, vStart: 60.0, backendStart: 66.0, backendEnd: 67.2 },
    { rate: 0.5, vStart: 60.0, backendStart: 62.0, backendEnd: 62.4 },
    { rate: 2.0, vStart: 60.0, backendStart: 68.0, backendEnd: 69.6 }
  ];

  for (const { rate, vStart, backendStart, backendEnd } of testCases) {
    const fakeVideo = { currentTime: vStart, playbackRate: rate };
    const bridge = new SyncBridge({
      video: fakeVideo,
      render: () => {}
    });

    const testEpoch = bridge.getEpoch();
    let forwardedResult = null;
    const client = new WsClient({
      WebSocketClass: FakeWebSocket,
      url: 'ws://localhost:8000/ws',
      initialEpoch: testEpoch,
      initialPlaybackRate: rate,
      onChunkSent: (chunkInfo) => {
        bridge.registerChunk(chunkInfo.chunk_id, {
          video_start_time: chunkInfo.video_start_time,
          playback_rate: chunkInfo.playback_rate
        });
      },
      onResult: (result) => {
        forwardedResult = result;
        bridge.handleResult(result);
      }
    });

    await client.connect();
    await new Promise(r => setTimeout(r, 15));

    client.updateVideoObservation({
      epoch: testEpoch,
      video_id: 'test_vid',
      video_current_time: vStart,
      playback_rate: rate,
      paused: false,
      seeking: false,
      ad_state: 'main_video',
      wall_time_ms: Date.now()
    });

    // Feed 10 blocks (1.0s audio) to trigger chunk flush
    for (let i = 0; i < 10; i++) {
      client.feedAudioBlock(create100msPcmBlock());
    }

    // Backend returns absolute video seconds (start, end) without is_final or langs
    client.ws.onmessage({
      data: JSON.stringify({
        type: 'subtitle',
        chunk_id: 0,
        epoch: testEpoch,
        start: backendStart,
        end: backendEnd,
        lang: 'hi',
        text: `Test text at rate ${rate}`,
        source: 'stt'
      })
    });

    assert.ok(forwardedResult, 'Result must be forwarded');
    assert.strictEqual(forwardedResult.is_final, true, 'is_final must default to true when absent');
    assert.deepStrictEqual(forwardedResult.langs, ['hi'], 'langs must default to [lang]');

    // Retrieve cue from SyncEngine
    const cue = bridge.engine.store.get(`${testEpoch}:0`);
    assert.ok(cue, 'Cue must be stored in engine');

    // CRITICAL ASSERTION: cue.start must be backendStart (66.0, 62.0, 68.0), NOT double-converted
    assert.strictEqual(
      cue.start,
      backendStart,
      `Double conversion detected! Expected cue.start=${backendStart}, got ${cue.start}`
    );
    assert.strictEqual(
      cue.end,
      backendEnd,
      `Expected cue.end=${backendEnd}, got ${cue.end}`
    );

    bridge.destroy();
    client.close();
  }
});
