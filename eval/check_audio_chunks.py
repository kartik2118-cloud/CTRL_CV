#!/usr/bin/env python3
"""
Diagnostic Validator for YouTube Audio Chunks (Role D - Eval Harness).
Validates JSONL diagnostic streams against docs/audio-chunk-contract.md.
"""

import argparse
import json
import math
import os
import sys
from typing import Any, Dict, List, Optional, Set, Tuple


REQUIRED_FIELDS = {
    "session_id": str,
    "video_id": (str, type(None)),
    "epoch": int,
    "chunk_id": int,
    "sample_rate_hz": int,
    "channels": int,
    "sample_count": int,
    "audio_duration_s": (int, float),
    "chunk_video_start": (int, float, type(None)),
    "chunk_video_end": (int, float, type(None)),
    "playback_rate": (int, float),
    "paused": bool,
    "seeking": bool,
    "ad_state": str,
    "stt_eligible": bool,
}

VALID_AD_STATES = {"unknown", "ad_playing", "no_ad"}
TARGET_SAMPLE_RATE = 16000
TARGET_CHANNELS = 1
FULL_CHUNK_SAMPLES = 1600
FULL_CHUNK_DURATION = 0.100
VIDEO_SPAN_TOLERANCE_S = 0.005
SEQ_ALIGN_TOLERANCE_S = 0.015


def is_finite_number(val: Any) -> bool:
    if val is None:
        return True
    if isinstance(val, (int, float)):
        return not (math.isnan(val) or math.isinf(val))
    return False


def validate_diagnostic_line(
    raw_line: str,
    line_number: int,
    seen_ids: Set[Tuple[str, int, int]],
    prev_chunk: Optional[Dict[str, Any]],
) -> Tuple[Optional[Dict[str, Any]], List[Dict[str, Any]]]:
    errors: List[Dict[str, Any]] = []

    try:
        data = json.loads(raw_line)
    except json.JSONDecodeError as exc:
        errors.append({
            "line": line_number,
            "error": f"Invalid JSON syntax: {exc.msg}",
            "field": None,
            "value": None,
        })
        return None, errors

    if not isinstance(data, dict):
        errors.append({
            "line": line_number,
            "error": "Record must be a JSON object",
            "field": None,
            "value": type(data).__name__,
        })
        return None, errors

    # Check required fields and basic types
    for field, expected_type in REQUIRED_FIELDS.items():
        if field not in data:
            errors.append({
                "line": line_number,
                "error": f"Missing required field: '{field}'",
                "field": field,
                "value": None,
            })
            continue

        val = data[field]
        if not isinstance(val, expected_type):
            errors.append({
                "line": line_number,
                "error": f"Invalid type for '{field}'. Expected {expected_type}, got {type(val).__name__}",
                "field": field,
                "value": val,
            })

    if errors:
        return data, errors

    # Finite numeric checks
    for num_field in ["sample_count", "audio_duration_s", "chunk_video_start", "chunk_video_end", "playback_rate"]:
        if not is_finite_number(data.get(num_field)):
            errors.append({
                "line": line_number,
                "error": f"Field '{num_field}' must be a finite number",
                "field": num_field,
                "value": data.get(num_field),
            })

    # Field specific range and value checks
    session_id = data.get("session_id", "")
    if not isinstance(session_id, str) or not session_id.strip():
        errors.append({
            "line": line_number,
            "error": "'session_id' must be a non-empty string",
            "field": "session_id",
            "value": session_id,
        })

    epoch = data.get("epoch")
    if not isinstance(epoch, int) or epoch < 0:
        errors.append({
            "line": line_number,
            "error": "'epoch' must be a non-negative integer",
            "field": "epoch",
            "value": epoch,
        })

    chunk_id = data.get("chunk_id")
    if not isinstance(chunk_id, int) or chunk_id < 0:
        errors.append({
            "line": line_number,
            "error": "'chunk_id' must be a non-negative integer",
            "field": "chunk_id",
            "value": chunk_id,
        })

    # Epoch-scoped duplicate ID detection
    if isinstance(session_id, str) and isinstance(epoch, int) and isinstance(chunk_id, int):
        id_key = (session_id, epoch, chunk_id)
        if id_key in seen_ids:
            errors.append({
                "line": line_number,
                "error": f"Duplicate (session_id, epoch, chunk_id): {id_key}",
                "field": "chunk_id",
                "value": chunk_id,
            })
        else:
            seen_ids.add(id_key)

    sample_rate_hz = data.get("sample_rate_hz")
    if sample_rate_hz != TARGET_SAMPLE_RATE:
        errors.append({
            "line": line_number,
            "error": f"'sample_rate_hz' must be {TARGET_SAMPLE_RATE}, got {sample_rate_hz}",
            "field": "sample_rate_hz",
            "value": sample_rate_hz,
        })

    channels = data.get("channels")
    if channels != TARGET_CHANNELS:
        errors.append({
            "line": line_number,
            "error": f"'channels' must be {TARGET_CHANNELS}, got {channels}",
            "field": "channels",
            "value": channels,
        })

    sample_count = data.get("sample_count", 0)
    audio_duration_s = data.get("audio_duration_s", 0.0)
    is_final_partial = bool(data.get("is_final_partial", False))

    if not isinstance(sample_count, int) or sample_count <= 0:
        errors.append({
            "line": line_number,
            "error": "'sample_count' must be a positive integer",
            "field": "sample_count",
            "value": sample_count,
        })
    elif not is_final_partial and sample_count != FULL_CHUNK_SAMPLES:
        errors.append({
            "line": line_number,
            "error": f"Full chunk must have {FULL_CHUNK_SAMPLES} samples; got {sample_count} without is_final_partial=True",
            "field": "sample_count",
            "value": sample_count,
        })
    elif is_final_partial and sample_count > FULL_CHUNK_SAMPLES:
        errors.append({
            "line": line_number,
            "error": f"Partial chunk sample_count cannot exceed {FULL_CHUNK_SAMPLES}, got {sample_count}",
            "field": "sample_count",
            "value": sample_count,
        })

    # Duration vs sample count check
    if isinstance(sample_rate_hz, int) and sample_rate_hz > 0 and isinstance(sample_count, int) and sample_count > 0:
        expected_duration = sample_count / sample_rate_hz
        if abs(audio_duration_s - expected_duration) > 1e-5:
            errors.append({
                "line": line_number,
                "error": f"audio_duration_s ({audio_duration_s}) does not match sample_count / sample_rate_hz ({expected_duration:.6f})",
                "field": "audio_duration_s",
                "value": audio_duration_s,
            })

    playback_rate = data.get("playback_rate")
    if not isinstance(playback_rate, (int, float)) or playback_rate <= 0:
        errors.append({
            "line": line_number,
            "error": "'playback_rate' must be a positive number",
            "field": "playback_rate",
            "value": playback_rate,
        })

    ad_state = data.get("ad_state")
    if ad_state not in VALID_AD_STATES:
        errors.append({
            "line": line_number,
            "error": f"'ad_state' must be one of {sorted(VALID_AD_STATES)}, got '{ad_state}'",
            "field": "ad_state",
            "value": ad_state,
        })

    # Anchor checks & STT eligibility validation
    start_v = data.get("chunk_video_start")
    end_v = data.get("chunk_video_end")
    stt_eligible = data.get("stt_eligible")
    paused = data.get("paused")
    seeking = data.get("seeking")

    # Negative timestamps check
    if start_v is not None and start_v < 0:
        errors.append({
            "line": line_number,
            "error": "'chunk_video_start' cannot be negative",
            "field": "chunk_video_start",
            "value": start_v,
        })
    if end_v is not None and end_v < 0:
        errors.append({
            "line": line_number,
            "error": "'chunk_video_end' cannot be negative",
            "field": "chunk_video_end",
            "value": end_v,
        })

    # Invariants for stt_eligible: cannot be eligible if paused, seeking, playing ad, or missing anchors
    if stt_eligible is True:
        if paused or seeking or ad_state == "ad_playing":
            errors.append({
                "line": line_number,
                "error": "stt_eligible cannot be true when paused, seeking, or ad_state is 'ad_playing'",
                "field": "stt_eligible",
                "value": stt_eligible,
            })
        if start_v is None or end_v is None:
            errors.append({
                "line": line_number,
                "error": "stt_eligible cannot be true when video anchors are null",
                "field": "stt_eligible",
                "value": stt_eligible,
            })

    # Video time span validation: only for eligible, stable, continuously playing chunks
    if (
        stt_eligible is True
        and not paused
        and not seeking
        and ad_state != "ad_playing"
        and start_v is not None
        and end_v is not None
        and isinstance(playback_rate, (int, float))
        and playback_rate > 0
    ):
        if end_v < start_v:
            errors.append({
                "line": line_number,
                "error": f"chunk_video_end ({end_v}) is before chunk_video_start ({start_v})",
                "field": "chunk_video_end",
                "value": end_v,
            })
        else:
            actual_span = end_v - start_v
            expected_span = audio_duration_s * playback_rate
            diff = abs(actual_span - expected_span)
            if diff > VIDEO_SPAN_TOLERANCE_S:
                errors.append({
                    "line": line_number,
                    "error": (
                        f"Video time span ({actual_span:.4f}s) deviates from audio_duration_s * playback_rate "
                        f"({expected_span:.4f}s) by {diff:.4f}s (tolerance: {VIDEO_SPAN_TOLERANCE_S}s)"
                    ),
                    "field": "chunk_video_end",
                    "value": end_v,
                })

        # Check sequential alignment within same continuous epoch (never across epoch boundaries)
        if (
            prev_chunk is not None
            and prev_chunk.get("epoch") == epoch
            and prev_chunk.get("session_id") == session_id
            and prev_chunk.get("stt_eligible") is True
            and prev_chunk.get("chunk_video_end") is not None
        ):
            prev_end = prev_chunk["chunk_video_end"]
            gap = abs(start_v - prev_end)
            if gap > SEQ_ALIGN_TOLERANCE_S:
                errors.append({
                    "line": line_number,
                    "error": f"Discontinuous video time within same epoch: chunk_video_start ({start_v:.4f}s) "
                             f"differs from previous chunk_video_end ({prev_end:.4f}s) by {gap:.4f}s",
                    "field": "chunk_video_start",
                    "value": start_v,
                })

    return data, errors


def validate_file(file_path: str) -> Dict[str, Any]:
    total_lines = 0
    valid_chunks = 0
    eligible_chunks = 0
    unverified_anchor_chunks = 0
    final_partial_chunks = 0
    all_errors: List[Dict[str, Any]] = []

    seen_ids: Set[Tuple[str, int, int]] = set()
    prev_chunk: Optional[Dict[str, Any]] = None

    if not os.path.exists(file_path):
        return {
            "valid": False,
            "input_file": file_path,
            "total_lines": 0,
            "valid_chunks": 0,
            "eligible_chunks": 0,
            "unverified_anchor_chunks": 0,
            "final_partial_chunks": 0,
            "errors": [{"line": 0, "error": f"File not found: {file_path}", "field": None, "value": None}],
            "summary": "Validation failed: input file does not exist",
        }

    with open(file_path, "r", encoding="utf-8") as f:
        for idx, line in enumerate(f, start=1):
            stripped = line.strip()
            if not stripped:
                continue

            total_lines += 1
            chunk_data, line_errors = validate_diagnostic_line(stripped, idx, seen_ids, prev_chunk)

            if line_errors:
                all_errors.extend(line_errors)
            else:
                valid_chunks += 1
                if chunk_data and chunk_data.get("stt_eligible"):
                    eligible_chunks += 1
                if chunk_data and (chunk_data.get("chunk_video_start") is None or chunk_data.get("chunk_video_end") is None):
                    unverified_anchor_chunks += 1
                if chunk_data and chunk_data.get("is_final_partial"):
                    final_partial_chunks += 1

            if chunk_data:
                prev_chunk = chunk_data

    is_valid = len(all_errors) == 0

    return {
        "valid": is_valid,
        "input_file": file_path,
        "total_lines": total_lines,
        "valid_chunks": valid_chunks,
        "eligible_chunks": eligible_chunks,
        "unverified_anchor_chunks": unverified_anchor_chunks,
        "final_partial_chunks": final_partial_chunks,
        "error_count": len(all_errors),
        "errors": all_errors,
        "summary": (
            f"PASSED: {valid_chunks}/{total_lines} valid chunks ({eligible_chunks} eligible, "
            f"{unverified_anchor_chunks} unverified anchors)"
            if is_valid
            else f"FAILED: {len(all_errors)} error(s) found across {total_lines} lines"
        ),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate audio chunk diagnostic JSONL logs.")
    parser.add_argument("input_path", help="Path to input JSONL diagnostic file")
    parser.add_argument(
        "--output-report",
        "-o",
        default=os.path.join("eval", "results", "chunk_validation_report.json"),
        help="Path where JSON validation report should be saved",
    )
    parser.add_argument("--quiet", "-q", action="store_true", help="Quiet output")
    args = parser.parse_args()

    report = validate_file(args.input_path)

    out_dir = os.path.dirname(args.output_report)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    with open(args.output_report, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    if not args.quiet:
        print(f"=== Audio Chunk Validation Report ===")
        print(f"Input:        {report['input_file']}")
        print(f"Total lines:  {report['total_lines']}")
        print(f"Valid chunks: {report['valid_chunks']}")
        print(f"Eligible:     {report['eligible_chunks']}")
        print(f"Unverified:   {report['unverified_anchor_chunks']}")
        print(f"Errors:       {report['error_count']}")
        print(f"Report saved: {args.output_report}")
        print(f"Status:       {'PASS' if report['valid'] else 'FAIL'}")

        if not report["valid"]:
            print("\nFirst 10 Errors:")
            for err in report["errors"][:10]:
                print(f"  Line {err['line']}: {err['error']} (field={err['field']}, val={err['value']})")

    return 0 if report["valid"] else 1


if __name__ == "__main__":
    sys.exit(main())
