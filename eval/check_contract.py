"""
eval/check_contract.py: Backend WebSocket Protocol & Contract Verifier (Task F2).

Connects to backend (--ws_url or CTRLCV_WS_URL), sends 1 chunk, and verifies
fields and types against docs/contract.md.
"""
import argparse
import asyncio
import json
import os
import sys
import websockets

# Reconfigure stdout to UTF-8
if sys.stdout.encoding != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

CONTRACT_FIELDS = {
    "chunk_id": (int,),
    "epoch": (int,),
    "is_final": (bool,),
    "start_offset": (float, int),
    "end_offset": (float, int),
    "lang": (str,),
    "langs": (list,),
    "text": (str,),
    "translation": (str,)
}


async def run_contract_check(ws_url: str):
    print("==========================================================================================")
    print("CONTRACT PROTOCOL VERIFICATION (docs/contract.md)")
    print("==========================================================================================")
    print(f"Target WebSocket URL: {ws_url}\n")

    try:
        async with websockets.connect(ws_url, ping_interval=None) as ws:
            # 1. Session start
            start_frame = {
                "type": "start",
                "session_id": "contract_check_session",
                "translate_to": "en",
                "lang_hint": None,
                "dual": True
            }
            await ws.send(json.dumps(start_frame))
            ready_msg = await asyncio.wait_for(ws.recv(), timeout=5.0)
            ready_data = json.loads(ready_msg)
            print(f"[Handshake]: Sent start -> Received {ready_data}")

            # 2. Send 1 chunk with epoch 7
            test_epoch = 7
            chunk_header = {
                "type": "chunk",
                "chunk_id": 1,
                "epoch": test_epoch,
                "video_start_time": 10.0,
                "playback_rate": 1.0,
                "sample_rate": 16000
            }
            # 1 second of 16kHz 16-bit mono PCM (32000 bytes)
            pcm_data = bytes(32000)

            await ws.send(json.dumps(chunk_header))
            await ws.send(pcm_data)

            result_msg = await asyncio.wait_for(ws.recv(), timeout=10.0)
            result = json.loads(result_msg)

            print(f"\n[Result Received]:\n{json.dumps(result, indent=2, ensure_ascii=False)}\n")

            # 3. Verify fields against docs/contract.md
            table_rows = []
            all_valid = True

            for field, expected_types in CONTRACT_FIELDS.items():
                if field not in result:
                    table_rows.append({
                        "field": field,
                        "expected": "/".join(t.__name__ for t in expected_types),
                        "received": "MISSING",
                        "status": "FAIL (Missing)"
                    })
                    all_valid = False
                else:
                    val = result[field]
                    val_type = type(val)
                    if isinstance(val, expected_types):
                        # Special check for langs list elements
                        if field == "langs" and isinstance(val, list):
                            elem_ok = all(isinstance(x, str) for x in val)
                            status = "MATCH" if elem_ok else "FAIL (Elements not strings)"
                            if not elem_ok:
                                all_valid = False
                        else:
                            status = "MATCH"
                    else:
                        status = f"FAIL (Type mismatch: {val_type.__name__})"
                        all_valid = False

                    val_str = str(val) if len(str(val)) < 30 else str(val)[:27] + "..."
                    table_rows.append({
                        "field": field,
                        "expected": "/".join(t.__name__ for t in expected_types),
                        "received": f"{val_str} ({val_type.__name__})",
                        "status": status
                    })

            # Check extra fields
            extra_fields = [k for k in result if k not in CONTRACT_FIELDS and k not in ("type",)]
            extra_status = "None" if not extra_fields else f"EXTRA: {', '.join(extra_fields)}"

            print("==========================================================================================")
            print("CONTRACT SPECIFICATION COMPLIANCE TABLE")
            print("==========================================================================================")
            print("| Contract Field | Expected Type | Received Value (Type) | Status |")
            print("|----------------|---------------|-----------------------|--------|")
            for r in table_rows:
                print(f"| {r['field']:<14} | {r['expected']:<13} | {r['received']:<21} | {r['status']:<6} |")
            print("==========================================================================================\n")

            # Epoch Echo Verification
            epoch_echoed = result.get("epoch") == test_epoch
            print(f"- Epoch Echo Check      : {'PASS' if epoch_echoed else 'FAIL'} (Sent {test_epoch}, Received {result.get('epoch')})")

            # Stale Epoch Test
            stale_header = {
                "type": "chunk",
                "chunk_id": 2,
                "epoch": 1,  # Older stale epoch
                "video_start_time": 10.0,
                "playback_rate": 1.0,
                "sample_rate": 16000
            }
            await ws.send(json.dumps(stale_header))
            await ws.send(pcm_data)
            stale_reply = await asyncio.wait_for(ws.recv(), timeout=5.0)
            stale_result = json.loads(stale_reply)
            stale_echoed = stale_result.get("epoch") == 1
            print(f"- Stale Epoch Behavior  : Echoes epoch ({stale_result.get('epoch')}) -> Client engine drops per Contract Rule 5")

            # Code-mixed langs check
            langs_val = result.get("langs", [])
            print(f"- Code-Mixed langs Check: {'PASS' if isinstance(langs_val, list) and len(langs_val) > 0 else 'FAIL'} (langs = {langs_val})")
            print(f"- Extra Uncontracted Fields: {extra_status}")

            return all_valid

    except Exception as e:
        print(f"ERROR connecting to WebSocket at {ws_url}: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(description="Contract Verifier (Task F2)")
    parser.add_argument("--ws_url", type=str, default=os.getenv("CTRLCV_WS_URL", "ws://localhost:8000/ws"))
    args = parser.parse_args()

    success = asyncio.run(run_contract_check(args.ws_url))
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
