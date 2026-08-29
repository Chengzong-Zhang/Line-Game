#!/usr/bin/env python3
"""Detect and optionally truncate only malformed final JSONL records."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def _inspect(path: Path) -> dict[str, object] | None:
    size = path.stat().st_size
    valid_end = 0
    invalid: list[tuple[int, int, str]] = []
    with path.open("rb") as handle:
        for line_number, raw_line in enumerate(handle, 1):
            end = handle.tell()
            try:
                json.loads(raw_line.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                invalid.append((line_number, end, str(exc)))
            else:
                if invalid:
                    raise RuntimeError(
                        f"{path} has valid data after malformed line {invalid[0][0]}"
                    )
                valid_end = end
    if not invalid:
        return None
    first_line, _, error = invalid[0]
    if len(invalid) != 1:
        raise RuntimeError(f"{path} has {len(invalid)} malformed trailing lines")
    return {
        "path": str(path),
        "line": first_line,
        "original_bytes": size,
        "valid_bytes": valid_end,
        "truncated_bytes": size - valid_end,
        "error": error,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("roots", nargs="+", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    files = sorted(
        path
        for root in args.roots
        for path in root.glob("seed_*/*.jsonl")
        if path.is_file()
    )
    repairs = [repair for path in files if (repair := _inspect(path)) is not None]
    if args.apply:
        for repair in repairs:
            path = Path(str(repair["path"]))
            with path.open("r+b") as handle:
                handle.truncate(int(repair["valid_bytes"]))
    print(
        json.dumps(
            {
                "status": "applied" if args.apply else "dry_run",
                "files_scanned": len(files),
                "repair_count": len(repairs),
                "truncated_bytes": sum(
                    int(repair["truncated_bytes"]) for repair in repairs
                ),
                "repairs": repairs,
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
