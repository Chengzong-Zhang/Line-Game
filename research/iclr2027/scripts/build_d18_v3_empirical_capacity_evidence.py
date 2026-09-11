#!/usr/bin/env python3
"""Build or verify the frozen D18-v3 empirical capacity evidence.

The receipt summarizes game lengths from the complete D14--D16 formal run.
It is deliberately independent of the D18 runner: the execution protocol
keeps ``max_plies=256`` while capacity planning uses twice the historical
nearest-rank p99.9 for each board size.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable


ICLR_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ICLR_ROOT / "results" / "formal" / "d14_d16" / "run_v1" / "tasks"
DEFAULT_OUTPUT = (
    ICLR_ROOT
    / "results"
    / "validation"
    / "d18_v3_empirical_capacity_evidence_v1.json"
)

SCHEMA_NAME = "lifeline-d18-v3-empirical-capacity-evidence"
SCHEMA_VERSION = 1
MAX_PLIES = 256
PUCT_SIMULATIONS = 16
PERCENTILE_NUMERATOR = 999
PERCENTILE_DENOMINATOR = 1000
PLANNING_MULTIPLIER = 2

EXPECTED_FILE_COUNT = 330
EXPECTED_TOTAL_GAMES = 32_100
EXPECTED_BY_BOARD_SIZE = {
    5: {"sample_count": 10_734, "max": 19, "p99_9": 16, "planning": 32},
    7: {"sample_count": 10_701, "max": 49, "p99_9": 42, "planning": 84},
    9: {"sample_count": 10_665, "max": 85, "p99_9": 69, "planning": 138},
}

BINDING_PATHS = {
    "formal_manifest": ICLR_ROOT / "configs" / "d14_d16_formal_manifest.json",
    "task_bundle_manifest_snapshot": (
        ICLR_ROOT
        / "results"
        / "formal"
        / "d14_d16"
        / "task_bundle_v1"
        / "manifest_snapshot.json"
    ),
    "task_bundle_summary": (
        ICLR_ROOT
        / "results"
        / "formal"
        / "d14_d16"
        / "task_bundle_v1"
        / "bundle_summary.json"
    ),
    "formal_result_receipts": (
        ICLR_ROOT
        / "results"
        / "formal"
        / "d14_d16"
        / "run_v1"
        / "result_receipts.jsonl"
    ),
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def relative_path(path: Path) -> str:
    return path.resolve().relative_to(ICLR_ROOT).as_posix()


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def frozen_json_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    ).encode("utf-8")


def trajectory_files() -> list[Path]:
    files = sorted(
        (
            path
            for path in SOURCE_ROOT.rglob("*.jsonl")
            if path.name in {"games.jsonl", "self_play_games.jsonl"}
        ),
        key=lambda path: relative_path(path),
    )
    if len(files) != EXPECTED_FILE_COUNT:
        raise ValueError(
            f"expected {EXPECTED_FILE_COUNT} trajectory files, found {len(files)}"
        )
    return files


def nearest_rank(values: Iterable[int], numerator: int, denominator: int) -> int:
    ordered = sorted(values)
    if not ordered:
        raise ValueError("nearest-rank percentile requires at least one value")
    rank = math.ceil(len(ordered) * numerator / denominator)
    return ordered[rank - 1]


def read_games(path: Path) -> list[tuple[int, int, bool]]:
    games: list[tuple[int, int, bool]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                raise ValueError(f"blank JSONL record: {path}:{line_number}")
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid JSON: {path}:{line_number}: {exc}") from exc
            board_size = record.get("grid_size")
            plies = record.get("plies")
            truncated = record.get("truncated")
            if board_size not in EXPECTED_BY_BOARD_SIZE:
                raise ValueError(
                    f"unexpected grid_size at {path}:{line_number}: {board_size!r}"
                )
            if isinstance(plies, bool) or not isinstance(plies, int) or plies < 0:
                raise ValueError(f"invalid plies at {path}:{line_number}: {plies!r}")
            if plies > MAX_PLIES:
                raise ValueError(
                    f"plies exceed protocol max_plies at {path}:{line_number}: {plies}"
                )
            if not isinstance(truncated, bool):
                raise ValueError(
                    f"invalid truncated flag at {path}:{line_number}: {truncated!r}"
                )
            games.append((board_size, plies, truncated))
    if not games:
        raise ValueError(f"empty trajectory file: {path}")
    return games


def file_binding(path: Path) -> dict[str, Any]:
    return {
        "relative_path": relative_path(path),
        "sha256": sha256_file(path),
        "size_bytes": path.stat().st_size,
    }


def build_receipt() -> dict[str, Any]:
    files = trajectory_files()
    plies_by_size: dict[int, list[int]] = defaultdict(list)
    truncated_by_size: Counter[int] = Counter()
    manifest_entries: list[dict[str, Any]] = []

    for path in files:
        games = read_games(path)
        for board_size, plies, truncated in games:
            plies_by_size[board_size].append(plies)
            truncated_by_size[board_size] += int(truncated)
        entry = {
            "bytes": path.stat().st_size,
            "path": relative_path(path),
            "sha256": sha256_file(path),
        }
        manifest_entries.append(entry)

    total_games = sum(len(values) for values in plies_by_size.values())
    total_truncated = sum(truncated_by_size.values())
    if total_games != EXPECTED_TOTAL_GAMES:
        raise ValueError(
            f"expected {EXPECTED_TOTAL_GAMES} games, found {total_games}"
        )
    if total_truncated != 0:
        raise ValueError(f"expected zero truncated games, found {total_truncated}")

    by_board_size: dict[str, Any] = {}
    for board_size, expected in EXPECTED_BY_BOARD_SIZE.items():
        values = plies_by_size[board_size]
        p99_9 = nearest_rank(
            values, PERCENTILE_NUMERATOR, PERCENTILE_DENOMINATOR
        )
        planning = PLANNING_MULTIPLIER * p99_9
        observed = {
            "sample_count": len(values),
            "max": max(values),
            "p99_9": p99_9,
            "planning": planning,
        }
        if observed != expected:
            raise ValueError(
                f"board size {board_size} changed: expected {expected}, found {observed}"
            )
        histogram = Counter(values)
        by_board_size[str(board_size)] = {
            "game_count": len(values),
            "histogram": {
                str(plies): histogram[plies] for plies in sorted(histogram)
            },
            "historical_max_plies": max(values),
            "nearest_rank_p999_plies": p99_9,
            "empirical_planning_plies": planning,
        }

    bindings = {name: file_binding(path) for name, path in BINDING_PATHS.items()}
    if (
        bindings["formal_manifest"]["sha256"]
        != bindings["task_bundle_manifest_snapshot"]["sha256"]
    ):
        raise ValueError("formal manifest and frozen task-bundle snapshot differ")

    manifest_sha256 = hashlib.sha256(
        canonical_json_bytes(manifest_entries)
    ).hexdigest()
    return {
        "interpretation": {
            "execution_max_plies_unchanged": True,
            "fail_closed_if_future_execution_truncates": True,
            "scope": (
                "capacity planning only; this receipt does not alter the formal "
                "execution protocol or certify a future run"
            ),
        },
        "max_plies": MAX_PLIES,
        "planning_multiplier": PLANNING_MULTIPLIER,
        "provenance": {"artifacts": bindings, "puct_simulations": PUCT_SIMULATIONS},
        "quantile": {
            "method": "nearest_rank",
            "probability_denominator": PERCENTILE_DENOMINATOR,
            "probability_numerator": PERCENTILE_NUMERATOR,
        },
        "schema_name": SCHEMA_NAME,
        "schema_version": SCHEMA_VERSION,
        "sizes": by_board_size,
        "source_manifest": manifest_entries,
        "source_manifest_canonicalization": (
            "UTF-8 JSON, sorted keys, compact separators; entries sorted by path"
        ),
        "source_manifest_sha256": manifest_sha256,
        "source_root": relative_path(SOURCE_ROOT),
        "status": "PASS",
        "total_games": total_games,
        "total_source_files": len(manifest_entries),
        "total_truncated_games": total_truncated,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output", type=Path, default=DEFAULT_OUTPUT, help="receipt path"
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="recompute and require byte-for-byte equality with the frozen receipt",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output = args.output.resolve()
    receipt_bytes = frozen_json_bytes(build_receipt())
    if args.check:
        if not output.is_file():
            raise FileNotFoundError(f"frozen receipt does not exist: {output}")
        frozen_bytes = output.read_bytes()
        if frozen_bytes != receipt_bytes:
            raise ValueError(f"frozen receipt mismatch: {output}")
        status = "verified"
    else:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(receipt_bytes)
        status = "written"
    print(
        json.dumps(
            {
                "path": str(output),
                "receipt_sha256": hashlib.sha256(receipt_bytes).hexdigest(),
                "source_manifest_sha256": json.loads(receipt_bytes)[
                    "source_manifest_sha256"
                ],
                "status": status,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
