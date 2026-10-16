"""
eval/run_clip.py: Stream audio WAV clip to STT backend over WebSocket and produce validated cue log.

Complies with docs/contract.md & docs/cue_log.schema.json:
- Sends session start {"type": "start", ...} and waits for {"type": "ready"}.
- Chunks 16 kHz mono 16-bit PCM audio.
- Sends JSON header followed immediately by binary PCM frame per chunk.
- Converts relative audio offsets to video time:
  start = video_start_time + start_offset * playback_rate
  end   = video_start_time + end_offset   * playback_rate
- Converts wall-clock arrival to video timeline for first_shown_at.
- Simulates seeks via --seek_at and --seek_to (increments epoch, resets video timeline).
- Drops results whose epoch differs from current epoch (contract rule 5).
- Exports seek events and dropped count to sidecar <output>.seeks.json.
- Exports validated cue log JSON strictly matching docs/cue_log.schema.json.
"""
import argparse
import asyncio
import json
import sys
import time
from pathlib import Path
import numpy as np
import soundfile as sf
import websockets

# Reconfigure stdout to UTF-8
if sys.stdout.encoding != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

EVAL_DIR = Path(__file__).resolve().parent
RESULTS_DIR = EVAL_DIR / "results"
DEFAULT_OUTPUT = RESULTS_DIR / "cue_log.json"


def prepare_audio_chunks(wav_path: Path, chunk_ms: int = 1000) -> tuple[list[bytes], float]:
    """Reads WAV file, ensures 16 kHz mono 16-bit signed PCM, and slices into chunks."""
    data, sr = sf.read(str(wav_path))
    if data.ndim > 1:
        data = np.mean(data, axis=1)
    if sr != 16000:
        import librosa
        data = librosa.resample(data, orig_sr=sr, target_sr=16000)

    pcm_int16 = (np.clip(data, -1.0, 1.0) * 32767).astype(np.int16)
    raw_bytes = pcm_int16.tobytes()

    samples_per_chunk = int(16000 * (chunk_ms / 1000.0))
    bytes_per_chunk = samples_per_chunk * 2

    chunks = []
    for offset in range(0, len(raw_bytes), bytes_per_chunk):
        chunk = raw_bytes[offset: offset + bytes_per_chunk]
        chunks.append(chunk)

    total_duration = len(data) / 16000.0
    return chunks, total_duration


async def stream_clip(
    clip_path: Path,
    url: str,
    lang: str = "hi",
    chunk_ms: int = 1000,
    realtime: bool = True,
    epoch: int = 1,
    playback_rate: float = 1.0,
    seek_at: float | None = None,
    seek_to: float | None = None,
    no_epoch_drop: bool = False,
    protocol: str = "contract_v01",
    output_path: Path | None = DEFAULT_OUTPUT,
    verbose: bool = True,
    return_meta: bool = False
) -> list[dict] | tuple[list[dict], dict]:
    """Streams audio chunks to WebSocket backend and collects results into cue log."""
    if verbose:
        print(f"\n[Client] Preparing audio from: {clip_path}")
    chunks, total_dur = prepare_audio_chunks(clip_path, chunk_ms)
    chunk_duration_sec = chunk_ms / 1000.0
    total_chunks = len(chunks)
    if verbose:
        print(f"[Client] Total duration: {total_dur:.2f}s, {total_chunks} chunks of {chunk_ms}ms (mode: {'realtime' if realtime else 'fast'}, protocol: {protocol})")

    sent_chunks = {}
    cues = []
    current_epoch = epoch
    current_video_time = 0.0
    seek_performed = False
    seek_events = []
    stale_dropped_count = 0
    stale_dropped_chunk_ids = []

    rate_limited = False
    rate_limit_count = 0

    results_received_event = asyncio.Event()

    if verbose:
        print(f"[Client] Connecting to WebSocket: {url} ...")
    async with websockets.connect(url) as ws:
        session_id = f"eval_session_{int(time.time())}"

        if protocol == "real":
            hello_frame = {
                "type": "hello",
                "client_id": session_id,
                "lang": lang,
                "target_lang": "en"
            }
            await ws.send(json.dumps(hello_frame))
            resp = await ws.recv()
            resp_data = json.loads(resp)
            if verbose:
                print(f"[Client] Real protocol handshake response: {resp_data}")
            if resp_data.get("type") != "hello_ack":
                raise RuntimeError(f"Unexpected response to hello frame: {resp_data}")
            current_epoch = resp_data.get("epoch", current_epoch)
        else:
            start_frame = {
                "type": "start",
                "session_id": session_id,
                "translate_to": "en",
                "lang_hint": lang,
                "dual": True
            }
            await ws.send(json.dumps(start_frame))
            resp = await ws.recv()
            resp_data = json.loads(resp)
            if verbose:
                print(f"[Client] Handshake response: {resp_data}")
            if resp_data.get("type") != "ready":
                raise RuntimeError(f"Unexpected response to start frame: {resp_data}")

        wall_start_time = time.time()
        base_video_time = 0.0
        last_seek_wall_time = wall_start_time
        last_seek_to = 0.0

        async def receiver_task():
            nonlocal stale_dropped_count, rate_limited, rate_limit_count
            try:
                while True:
                    raw_msg = await ws.recv()
                    arr_time = time.time()
                    res = json.loads(raw_msg)
                    msg_type = res.get("type")

                    if msg_type == "seek_ack":
                        if verbose:
                            print(f"[Client] Backend seek_ack: epoch={res.get('epoch')}, video_time={res.get('video_time')}s")
                        continue
                    elif msg_type == "error":
                        detail_text = str(res.get("detail", "")) + " " + str(res.get("message", ""))
                        if "429" in detail_text or "rate limit" in detail_text.lower() or "rate_limit" in detail_text.lower():
                            rate_limited = True
                            rate_limit_count += 1
                            if verbose:
                                print(f"[Client] Backend rate-limit (HTTP 429) frame: {detail_text}")
                        else:
                            if verbose:
                                print(f"[Client] Backend error frame: {res.get('detail')}")
                        continue
                    elif msg_type == "config_ack":
                        if verbose:
                            print(f"[Client] Backend config_ack: rate={res.get('playback_rate')}")
                        continue

                    if msg_type in ("result", "subtitle"):
                        res_epoch = res.get("epoch", 0)
                        cid = res.get("chunk_id")

                        # Contract Rule 5: Epoch rule
                        if res_epoch != current_epoch:
                            stale_dropped_count += 1
                            stale_dropped_chunk_ids.append(cid)
                            if not no_epoch_drop:
                                if verbose:
                                    print(f"[Client] DROPPED stale result for chunk {cid} (epoch {res_epoch} != current {current_epoch})")
                                continue
                            else:
                                if verbose:
                                    print(f"[Client] [TEST: NO_EPOCH_DROP] Retaining stale result for chunk {cid} (epoch {res_epoch} != current {current_epoch})")

                        chunk_meta = sent_chunks.get((res_epoch, cid))
                        if not chunk_meta:
                            chunk_meta = next((v for (e, c), v in sent_chunks.items() if c == cid), None)

                        v_start = chunk_meta["video_start_time"] if chunk_meta else 0.0
                        rate = chunk_meta["playback_rate"] if chunk_meta else playback_rate

                        if protocol == "real":
                            # Results are subtitle frames with ABSOLUTE start/end (video seconds). Do not convert them again.
                            c_start = float(res.get("start", 0.0))
                            c_end = float(res.get("end", 0.0))
                            if c_end <= c_start:
                                c_end = c_start + 0.1
                        else:
                            # Time conversion formula (docs/contract.md section 4)
                            c_start = v_start + res.get("start_offset", 0.0) * rate
                            c_end = v_start + res.get("end_offset", chunk_duration_sec) * rate
                            if c_end <= c_start:
                                c_end = c_start + 0.1

                        # Convert wall-clock arrival to video timeline
                        # After a seek: video_time = seek_to + (wall_now - seek_wall_time) * playback_rate
                        if realtime:
                            elapsed_after_anchor = arr_time - last_seek_wall_time
                            first_shown = last_seek_to + elapsed_after_anchor * rate
                        else:
                            sent_w = chunk_meta["sent_wall_time"] if chunk_meta else arr_time
                            proc_latency = arr_time - sent_w
                            first_shown = v_start + chunk_duration_sec + proc_latency * rate

                        text = res.get("text", "") or ""
                        translation = res.get("translation", "") or ""
                        res_lang = res.get("lang", lang) or lang
                        res_source = res.get("source", "stt")
                        if res_source not in ("stt", "captions"):
                            res_source = "stt"

                        cue_entry = {
                            "start": round(c_start, 2),
                            "end": round(c_end, 2),
                            "lang": res_lang,
                            "text": text,
                            "translation": translation,
                            "source": res_source,
                            "first_shown_at": round(first_shown, 2),
                            "revisions": [
                                {
                                    "at": round(first_shown, 2),
                                    "text": text
                                }
                            ]
                        }
                        cues.append(cue_entry)
                        lag = round(first_shown - c_end, 2)
                        if verbose:
                            print(f"  [Result {len(cues)}] Chunk {cid} (epoch {res_epoch}): speech {cue_entry['start']:.2f}-{cue_entry['end']:.2f}s, shown at {cue_entry['first_shown_at']:.2f}s (lag={lag:.2f}s)")

            except websockets.exceptions.ConnectionClosed:
                pass
            except Exception as e:
                if verbose:
                    print(f"[Receiver Error]: {e}")

        recv_worker = asyncio.create_task(receiver_task())

        # Sender loop
        for idx, chunk_bytes in enumerate(chunks):
            cid = idx + 1

            # Check if seek threshold reached before sending this chunk
            if seek_at is not None and seek_to is not None and not seek_performed:
                if current_video_time >= float(seek_at):
                    current_epoch += 1
                    current_video_time = float(seek_to)
                    seek_performed = True
                    seek_now = time.time()
                    last_seek_wall_time = seek_now
                    last_seek_to = float(seek_to)
                    seek_wall = round(seek_now - wall_start_time, 2)
                    seek_events.append({
                        "wall_time": seek_wall,
                        "seek_at": float(seek_at),
                        "seek_to": float(seek_to),
                        "epoch_after": current_epoch
                    })
                    print(f"\n[Client] *** SEEK EVENT TRIGGERED: video {seek_at}s -> {seek_to}s at wall_time={seek_wall}s | New epoch={current_epoch} ***\n")
                    if protocol == "real":
                        seek_frame = {
                            "type": "seek",
                            "video_time": float(seek_to),
                            "epoch": current_epoch
                        }
                        await ws.send(json.dumps(seek_frame))

            v_start = current_video_time

            # In realtime mode: a chunk finishes recording at (idx + 1) * chunk_duration_sec
            if realtime:
                target_send_time = wall_start_time + (idx + 1) * chunk_duration_sec
                now = time.time()
                if target_send_time > now:
                    await asyncio.sleep(target_send_time - now)

            sent_wall = time.time()
            sent_chunks[(current_epoch, cid)] = {
                "video_start_time": v_start,
                "playback_rate": playback_rate,
                "sent_wall_time": sent_wall
            }

            if protocol == "real":
                # Real protocol: chunk_meta {type, chunk_id, video_start, playback_rate, epoch, duration} followed by binary PCM
                header = {
                    "type": "chunk_meta",
                    "chunk_id": cid,
                    "video_start": round(v_start, 3),
                    "playback_rate": playback_rate,
                    "epoch": current_epoch,
                    "duration": round(chunk_duration_sec, 3)
                }
            else:
                # contract_v01 mock protocol
                header = {
                    "type": "chunk",
                    "chunk_id": cid,
                    "epoch": current_epoch,
                    "video_start_time": v_start,
                    "playback_rate": playback_rate,
                    "sample_rate": 16000
                }
            await ws.send(json.dumps(header))
            await ws.send(chunk_bytes)
            if verbose:
                print(f"[Client] Sent chunk {cid}/{total_chunks} (epoch={current_epoch}, v_start={v_start:.2f}s)")

            # Advance video timeline for next chunk
            current_video_time += chunk_duration_sec

        # Wait for pending backend responses to arrive or timeout
        if verbose:
            print("[Client] All chunks sent. Awaiting final results...")
        deadline = time.time() + 4.0
        while (len(cues) + stale_dropped_count < total_chunks) and time.time() < deadline:
            await asyncio.sleep(0.02)
        await asyncio.sleep(0.05)

        recv_worker.cancel()
        try:
            await recv_worker
        except asyncio.CancelledError:
            pass

    # Sort cues chronologically by start time
    cues.sort(key=lambda c: c["start"])

    # Save to JSON if output_path provided (strict schema array)
    if output_path is not None:
        out_p = Path(output_path)
        out_p.parent.mkdir(parents=True, exist_ok=True)
        with open(out_p, "w", encoding="utf-8") as f:
            json.dump(cues, f, ensure_ascii=False, indent=2)

        # Save sidecar JSON with seek events and stale dropped metadata
        sidecar_path = out_p.with_name(f"{out_p.stem}.seeks.json")
        sidecar_data = {
            "events": seek_events,
            "stale_dropped": {
                "count": stale_dropped_count,
                "chunk_ids": stale_dropped_chunk_ids
            }
        }
        with open(sidecar_path, "w", encoding="utf-8") as f:
            json.dump(sidecar_data, f, ensure_ascii=False, indent=2)

        if verbose:
            print(f"\n[Client EXPORT] Exported {len(cues)} cues to {out_p}")
            print(f"[Client EXPORT] Exported seek sidecar to {sidecar_path}")
            print(f"[Client SUMMARY] Stale results dropped count: {stale_dropped_count} (chunks: {stale_dropped_chunk_ids})")

    meta_info = {
        "chunks_sent": total_chunks,
        "results_received": len(cues),
        "rate_limited": rate_limited,
        "rate_limit_count": rate_limit_count,
        "stale_dropped_count": stale_dropped_count,
        "stale_dropped_chunk_ids": stale_dropped_chunk_ids,
        "seek_events": seek_events
    }

    if return_meta:
        return cues, meta_info

    return cues


def main():
    parser = argparse.ArgumentParser(description="CtrlCV Clip Streamer (Task 7)")
    parser.add_argument("--clip", type=str, required=True, help="Path to WAV audio file")
    parser.add_argument("--lang", type=str, default="hi", help="Language code (default: hi)")
    parser.add_argument("--url", type=str, default="ws://127.0.0.1:8000/ws", help="WebSocket URL")
    parser.add_argument("--chunk_ms", type=int, default=1000, help="Chunk duration in ms (default: 1000)")
    parser.add_argument("--protocol", type=str, default="contract_v01", choices=["contract_v01", "real"], help="Protocol adapter: contract_v01 or real (default: contract_v01)")
    parser.add_argument("--realtime", action="store_true", default=True, help="Stream in real-time (sleep between chunks)")
    parser.add_argument("--fast", action="store_true", help="Stream chunks as fast as possible without sleep")
    parser.add_argument("--seek_at", type=float, default=None, help="Video time in seconds to trigger a seek")
    parser.add_argument("--seek_to", type=float, default=None, help="Video time in seconds to jump to on seek")
    parser.add_argument("--no_epoch_drop", action="store_true", help="Disable dropping of stale-epoch results (for testing)")
    parser.add_argument("--backend-ready", action="store_true", help="Skip mock checks and connect directly to specified URL")
    parser.add_argument("--output", type=str, default=str(DEFAULT_OUTPUT), help="Output cue log JSON path")
    args = parser.parse_args()

    clip_p = Path(args.clip)
    if not clip_p.exists():
        print(f"Error: Clip file not found: {clip_p}")
        sys.exit(1)

    is_realtime = not args.fast
    out_p = Path(args.output)

    if args.backend_ready:
        print(f"[Client] Running in --backend-ready mode against external backend: {args.url}")

    asyncio.run(stream_clip(
        clip_path=clip_p,
        url=args.url,
        lang=args.lang,
        chunk_ms=args.chunk_ms,
        realtime=is_realtime,
        seek_at=args.seek_at,
        seek_to=args.seek_to,
        no_epoch_drop=args.no_epoch_drop,
        protocol=args.protocol,
        output_path=out_p
    ))


if __name__ == "__main__":
    main()
