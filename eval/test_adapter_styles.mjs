#!/usr/bin/env node
/**
 * eval/test_adapter_styles.mjs (Link 4: ADAPTER)
 * Verifies bidirectional frame style adapter compatibility between:
 * - Style C: Backend real frame (type 'subtitle', absolute start/end, absent is_final)
 * - Style D: Contract protocol frame (type 'result', start_offset/end_offset, explicit is_final)
 */
import assert from 'node:assert/strict';
import { WsClient } from '../extension/offscreen/ws_client.js';
import { SyncBridge } from '../sync/syncBridge.js';
import { SyncEngine } from '../sync/syncEngine.js';

let currentTime = 10.0;
const fakeVideo = {
  currentTime: 10.0,
  playbackRate: 1.5,
  addEventListener: () => {}
};

// 1. Style C verification (Backend real frame)
{
  const bridge = new SyncBridge({ video: fakeVideo, render: () => {}, tickMs: 50 });
  const client = new WsClient({
    url: 'ws://localhost:8000/ws',
    initialEpoch: 1,
    initialPlaybackRate: 1.5,
    onResult: (res) => bridge.handleResult(res)
  });

  // Register chunk sent at vStart=10.0s, rate=1.5
  client.sentChunks.set(101, {
    type: 'CHUNK_SENT',
    chunk_id: 101,
    video_start_time: 10.0,
    playback_rate: 1.5
  });
  bridge.registerChunk(101, { video_start_time: 10.0, playback_rate: 1.5 });

  // Incoming Style C frame from backend (absolute video seconds 10.0 to 13.0)
  const styleCFrame = {
    type: 'subtitle',
    chunk_id: 101,
    epoch: 1,
    start: 10.0,
    end: 13.0,
    lang: 'hi',
    text: 'Style C Backend Frame',
    source: 'stt'
  };

  const normalized = client._handleSubtitleResult(styleCFrame);

  // Assert adapter normalized Style C correctly
  assert.equal(normalized.type, 'RESULT');
  assert.equal(normalized.is_final, true, 'Style C must default is_final to true');
  assert.deepEqual(normalized.langs, ['hi'], 'Style C must default langs to [lang]');
  assert.equal(normalized.start_offset, 0.0);
  assert.equal(normalized.end_offset, 2.0); // (13.0 - 10.0) / 1.5 = 2.0

  // Assert engine cue start/end matches backend start/end exactly (no double conversion)
  const cue = bridge.engine.store.get('1:101');
  assert.ok(cue, 'Cue must be stored in engine');
  assert.equal(cue.start, 10.0, 'cue.start must match backend start exactly');
  assert.equal(cue.end, 13.0, 'cue.end must match backend end exactly');
  bridge.destroy();
}

// 2. Style D verification (Contract protocol frame)
{
  const bridge = new SyncBridge({ video: fakeVideo, render: () => {}, tickMs: 50 });
  bridge.registerChunk(202, { video_start_time: 20.0, playback_rate: 1.5 });

  const styleDFrame = {
    type: 'result',
    chunk_id: 202,
    epoch: 1,
    is_final: true,
    start_offset: 1.0,
    end_offset: 3.0,
    lang: 'hi',
    langs: ['hi', 'en'],
    text: 'Style D Contract Frame',
    source: 'stt'
  };

  const outcome = bridge.handleResult(styleDFrame);
  assert.equal(outcome.status, 'accepted');

  const cue = bridge.engine.store.get('1:202');
  assert.ok(cue, 'Cue must be stored in engine');
  // start = 20.0 + 1.0 * 1.5 = 21.5
  // end = 20.0 + 3.0 * 1.5 = 24.5
  assert.equal(cue.start, 21.5);
  assert.equal(cue.end, 24.5);
  assert.deepEqual(cue._langs, ['hi', 'en']);
  bridge.destroy();
}

console.log('Adapter C<->D verification: PASS (Both Style C and Style D frames normalized & rendered without double conversion)');
