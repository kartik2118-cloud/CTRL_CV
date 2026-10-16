"""
eval/validate_log.py: Validates subtitle cue log JSON files against AGENT_CONTEXT.md schema.

Checks:
1. Root is a list of cue entries.
2. All required fields are present with correct types:
   - start (float/int >= 0)
   - end (float/int >= 0)
   - lang (str)
   - text (str)
   - translation (str)
   - source ('stt' or 'captions')
   - first_shown_at (float/int >= 0)
   - revisions (list of objects with 'at' and 'text')
3. Constraints:
   - start < end
   - no negative timestamps (start, end, first_shown_at, revision 'at')
   - revisions sorted by 'at' timestamp in ascending order
4. Exit code 1 on validation errors, 0 on success.
"""
import argparse
import json
import sys
from pathlib import Path

# Reconfigure stdout to UTF-8
if sys.stdout.encoding != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

VALID_SOURCES = {"stt", "captions"}
REQUIRED_FIELDS = ["start", "end", "lang", "text", "translation", "source", "first_shown_at", "revisions"]


def validate_cue_log(data: list) -> list[str]:
    """
    Validates cue log structure and semantic constraints.
    Returns list of error messages (empty list if valid).
    """
    errors = []

    if not isinstance(data, list):
        return ["Root element must be a JSON array of cue objects."]

    if len(data) == 0:
        return ["Cue log is empty. At least one cue entry is expected."]

    for idx, cue in enumerate(data):
        prefix = f"Cue [{idx + 1}]"

        if not isinstance(cue, dict):
            errors.append(f"{prefix}: Item is not a JSON object.")
            continue

        # 1. Required fields check
        missing = [f for f in REQUIRED_FIELDS if f not in cue]
        if missing:
            errors.append(f"{prefix}: Missing required field(s): {', '.join(missing)}")
            continue

        # 2. Type checks
        start = cue["start"]
        end = cue["end"]
        shown = cue["first_shown_at"]
        lang = cue["lang"]
        text = cue["text"]
        translation = cue["translation"]
        source = cue["source"]
        revisions = cue["revisions"]

        if not isinstance(start, (int, float)):
            errors.append(f"{prefix}: 'start' must be a number, got {type(start).__name__}.")
        if not isinstance(end, (int, float)):
            errors.append(f"{prefix}: 'end' must be a number, got {type(end).__name__}.")
        if not isinstance(shown, (int, float)):
            errors.append(f"{prefix}: 'first_shown_at' must be a number, got {type(shown).__name__}.")
        if not isinstance(lang, str):
            errors.append(f"{prefix}: 'lang' must be a string, got {type(lang).__name__}.")
        if not isinstance(text, str):
            errors.append(f"{prefix}: 'text' must be a string, got {type(text).__name__}.")
        if not isinstance(translation, str):
            errors.append(f"{prefix}: 'translation' must be a string, got {type(translation).__name__}.")
        if not isinstance(source, str):
            errors.append(f"{prefix}: 'source' must be a string, got {type(source).__name__}.")
        elif source not in VALID_SOURCES:
            errors.append(f"{prefix}: 'source' must be one of {sorted(list(VALID_SOURCES))}, got '{source}'.")
        if not isinstance(revisions, list):
            errors.append(f"{prefix}: 'revisions' must be a list of objects, got {type(revisions).__name__}.")

        # If numerical fields are valid numbers, check semantic constraints
        if isinstance(start, (int, float)) and isinstance(end, (int, float)):
            # start < end
            if start >= end:
                errors.append(f"{prefix}: 'start' ({start}s) must be strictly less than 'end' ({end}s).")
            # No negative times
            if start < 0:
                errors.append(f"{prefix}: 'start' ({start}s) cannot be negative.")
            if end < 0:
                errors.append(f"{prefix}: 'end' ({end}s) cannot be negative.")

        if isinstance(shown, (int, float)) and shown < 0:
            errors.append(f"{prefix}: 'first_shown_at' ({shown}s) cannot be negative.")

        # Check revisions
        if isinstance(revisions, list):
            prev_at = -1.0
            for r_idx, rev in enumerate(revisions):
                r_prefix = f"{prefix} Revision [{r_idx + 1}]"
                if not isinstance(rev, dict):
                    errors.append(f"{r_prefix}: Revision item must be a JSON object.")
                    continue
                if "at" not in rev or "text" not in rev:
                    errors.append(f"{r_prefix}: Missing 'at' or 'text' in revision.")
                    continue
                r_at = rev["at"]
                if not isinstance(r_at, (int, float)):
                    errors.append(f"{r_prefix}: 'at' must be a number, got {type(r_at).__name__}.")
                elif r_at < 0:
                    errors.append(f"{r_prefix}: 'at' timestamp ({r_at}s) cannot be negative.")
                elif r_at < prev_at:
                    errors.append(f"{r_prefix}: Revisions not sorted by 'at'. Found {r_at}s after {prev_at}s.")
                else:
                    prev_at = r_at

    return errors


def validate_file(file_path: Path) -> bool:
    """Validates a cue log file from disk and prints errors."""
    print(f"\nValidating: {file_path}")
    if not file_path.exists():
        print(f"ERROR: File not found: {file_path}")
        return False

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        print(f"ERROR: Invalid JSON in {file_path}: {e}")
        return False

    errors = validate_cue_log(data)
    if not errors:
        print(f">>> PASS: {file_path.name} is valid according to schema & rules ({len(data)} cues).")
        return True
    else:
        print(f">>> FAIL: {file_path.name} has {len(errors)} validation error(s):")
        for err in errors:
            print(f"    - {err}")
        return False


def run_unit_tests():
    """Validates sample_log.json (should pass) and broken_log.json (should fail)."""
    print("\n==========================================")
    print("Running Self-Tests (eval/validate_log.py)")
    print("==========================================")

    eval_dir = Path(__file__).resolve().parent
    sample_file = eval_dir / "sample_log.json"
    broken_file = eval_dir / "broken_log.json"

    # Test 1: sample_log.json must PASS
    pass_ok = validate_file(sample_file)
    assert pass_ok, f"Expected {sample_file} to PASS, but it failed!"

    # Test 2: broken_log.json must FAIL
    fail_ok = not validate_file(broken_file)
    assert fail_ok, f"Expected {broken_file} to FAIL, but it passed!"

    print("\n==========================================")
    print(">>> All validator self-tests PASSED successfully.")
    print("==========================================")


def main():
    parser = argparse.ArgumentParser(description="Cue Log Validator (Task 2)")
    parser.add_argument("file", nargs="?", type=str, help="Path to cue log JSON to validate")
    parser.add_argument("--test", action="store_true", help="Run self-tests on sample and broken logs")
    args = parser.parse_args()

    if args.test or args.file is None:
        run_unit_tests()
        sys.exit(0)

    target_file = Path(args.file)
    is_valid = validate_file(target_file)
    sys.exit(0 if is_valid else 1)


if __name__ == "__main__":
    main()
