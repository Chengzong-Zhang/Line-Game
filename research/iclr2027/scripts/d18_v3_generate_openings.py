#!/usr/bin/env python3
"""Generate the frozen, rule-only D18-v3 paired-opening registry.

This module is intentionally unable to load checkpoints, evaluate policies, or
play a formal arena game.  Candidate openings are accepted using only
``LifelineGame`` legality/state invariants and disjointness from the frozen v1
opening registry.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import sys
import tempfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = SCRIPT_PATH.parents[3]
RESEARCH_ROOT = REPO_ROOT / "research" / "iclr2027"
if str(RESEARCH_ROOT) not in sys.path:
    sys.path.insert(0, str(RESEARCH_ROOT))

from lifeline_rl import LifelineGame, Player  # noqa: E402


SCHEMA_NAME = "lifeline-d18-v3-paired-openings-manifest"
SCHEMA_VERSION = 1
EXPERIMENT_ID = "d18_d16_v3_paired_openings_formal_v1"
EXPERIMENT_ARM = "d16-v3-paired-openings"
PROTOCOL_ID = "d18_v3_paired_openings_zero_execution_20260830_v1"
SEED_NAMESPACE = "lifeline-d18-v3-paired-openings-rule-only-20260830-v1"
SIZES = (5, 7, 9)
PREFIX_DEPTHS = (2, 4, 6, 8)
STRATA_PER_DEPTH = 8
STRATA_PER_SIZE = len(PREFIX_DEPTHS) * STRATA_PER_DEPTH
VARIANTS_PER_STRATUM = 2
OPENINGS_PER_SIZE = STRATA_PER_SIZE * VARIANTS_PER_STRATUM
EXPECTED_OPENINGS = len(SIZES) * OPENINGS_PER_SIZE
MAX_REJECTION_ATTEMPTS = 100_000
RETRY_STRIDE = 1_000_003
MASK_63 = (1 << 63) - 1
DEFAULT_V1_OPENINGS = (
    REPO_ROOT / "research" / "iclr2027" / "configs" / "d17_d19_openings_manifest.json"
)
DEFAULT_OUTPUT = (
    REPO_ROOT
    / "research"
    / "iclr2027"
    / "configs"
    / "d18_v3_paired_openings_manifest.json"
)


class PreparationError(RuntimeError):
    """The prospective v3 preparation contract cannot be satisfied."""


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise PreparationError(f"duplicate JSON key: {key!r}")
        result[key] = value
    return result


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(
            path.read_text(encoding="utf-8"), object_pairs_hook=_unique_object
        )
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PreparationError(f"cannot read strict JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise PreparationError(f"JSON root must be an object: {path}")
    return value


def canonical_json(value: Any) -> str:
    return json.dumps(
        value, ensure_ascii=True, sort_keys=True, separators=(",", ":")
    )


def pretty_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, sort_keys=True, indent=2) + "\n"


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise PreparationError(f"cannot hash {path}: {exc}") from exc
    return digest.hexdigest()


def prefix_hash(actions: Sequence[int]) -> str:
    return sha256_bytes(canonical_json([int(action) for action in actions]).encode("utf-8"))


def repo_relative(path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(REPO_ROOT).as_posix()
    except ValueError as exc:
        raise PreparationError(f"path escapes repository root: {resolved}") from exc


def resolve_repo_path(raw: str | Path) -> Path:
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = REPO_ROOT / candidate
    resolved = candidate.resolve()
    try:
        resolved.relative_to(REPO_ROOT)
    except ValueError as exc:
        raise PreparationError(f"path escapes repository root: {resolved}") from exc
    return resolved


def derived_seed(*, size: int, depth: int, stratum: int, variant: int) -> int:
    payload = (
        f"{SEED_NAMESPACE}|n={size}|depth={depth}|"
        f"stratum={stratum}|variant={variant}"
    ).encode("utf-8")
    return int.from_bytes(hashlib.sha256(payload).digest()[:8], "big") & MASK_63


def _v1_hashes(v1_manifest: Mapping[str, Any]) -> tuple[set[str], set[str]]:
    openings = v1_manifest.get("openings")
    if not isinstance(openings, list) or len(openings) != 96:
        raise PreparationError("v1 opening manifest must contain exactly 96 openings")
    prefix_hashes: set[str] = set()
    state_hashes: set[str] = set()
    for index, opening in enumerate(openings):
        if not isinstance(opening, dict):
            raise PreparationError(f"v1 openings[{index}] must be an object")
        prefix = opening.get("opening_prefix_hash")
        state = opening.get("opening_state_hash")
        if not isinstance(prefix, str) or len(prefix) != 64:
            raise PreparationError(f"v1 openings[{index}] has invalid prefix hash")
        if not isinstance(state, str) or len(state) != 64:
            raise PreparationError(f"v1 openings[{index}] has invalid state hash")
        if prefix in prefix_hashes or state in state_hashes:
            raise PreparationError("v1 opening hashes are not unique")
        prefix_hashes.add(prefix)
        state_hashes.add(state)
    return prefix_hashes, state_hashes


def _sample_candidate(*, size: int, depth: int, effective_seed: int) -> dict[str, Any] | None:
    rng = random.Random(effective_seed)
    game = LifelineGame(size, start_player=Player.BLACK, superko_mode="enforce")
    actions: list[int] = []
    coordinates: list[list[int]] = []
    for _ in range(depth):
        if game.game_over or game.consecutive_skips != 0:
            return None
        actor = game.current_player
        legal_points = game.legal_moves()
        if not legal_points:
            return None
        point = legal_points[rng.randrange(len(legal_points))]
        action = int(game.point_to_index[point])
        if action == game.num_points:
            raise AssertionError("legal point sampler selected PASS")
        result = game.play_move(point)
        if not result.success:
            return None
        if game.game_over or game.consecutive_skips != 0:
            return None
        if game.current_player is not LifelineGame.opponent(actor):
            # A non-alternating player means the rules auto-skipped a player.
            return None
        actions.append(action)
        coordinates.append([int(point[0]), int(point[1])])
    if game.turn_count != depth:
        return None
    return {
        "actions": actions,
        "coordinates": coordinates,
        "prefix_hash": prefix_hash(actions),
        "state_hash": game.state_fingerprint(),
        "current_player": game.current_player.value,
        "turn_count": int(game.turn_count),
        "pass_index": int(game.num_points),
    }


def _depth_for_stratum(stratum: int) -> int:
    if not 0 <= stratum < STRATA_PER_SIZE:
        raise PreparationError(f"stratum index out of range: {stratum}")
    return PREFIX_DEPTHS[stratum // STRATA_PER_DEPTH]


def materialize_openings(v1_manifest: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Return the exact prospective registry without policy/model access."""

    v1_prefixes, v1_states = _v1_hashes(v1_manifest)
    used_prefixes = set(v1_prefixes)
    used_states = set(v1_states)
    openings: list[dict[str, Any]] = []
    for size in SIZES:
        for stratum in range(STRATA_PER_SIZE):
            depth = _depth_for_stratum(stratum)
            stratum_id = f"n{size}_s{stratum:02d}_p{depth}"
            for variant in range(VARIANTS_PER_STRATUM):
                base_seed = derived_seed(
                    size=size, depth=depth, stratum=stratum, variant=variant
                )
                accepted: dict[str, Any] | None = None
                accepted_attempt = -1
                accepted_seed = -1
                for attempt in range(MAX_REJECTION_ATTEMPTS):
                    effective_seed = (base_seed + attempt * RETRY_STRIDE) & MASK_63
                    candidate = _sample_candidate(
                        size=size, depth=depth, effective_seed=effective_seed
                    )
                    if candidate is None:
                        continue
                    if candidate["prefix_hash"] in used_prefixes:
                        continue
                    if candidate["state_hash"] in used_states:
                        continue
                    accepted = candidate
                    accepted_attempt = attempt
                    accepted_seed = effective_seed
                    break
                if accepted is None:
                    raise PreparationError(
                        "rule-only rejection sampler exhausted for "
                        f"n={size}, stratum={stratum}, variant={variant}"
                    )
                used_prefixes.add(str(accepted["prefix_hash"]))
                used_states.add(str(accepted["state_hash"]))
                opening_id = f"d18v3_{stratum_id}_v{variant}"
                openings.append(
                    {
                        "cluster_id": stratum_id,
                        "current_player": accepted["current_player"],
                        "effective_opening_seed": accepted_seed,
                        "eval_size": size,
                        "generation_attempt": accepted_attempt,
                        "legal_point_actions_only": True,
                        "no_auto_skip": True,
                        "nonterminal": True,
                        "opening_actions": accepted["actions"],
                        "opening_coordinates": accepted["coordinates"],
                        "opening_id": opening_id,
                        "opening_prefix_hash": accepted["prefix_hash"],
                        "opening_seed": base_seed,
                        "opening_state_hash": accepted["state_hash"],
                        "pass_free": True,
                        "pass_index": accepted["pass_index"],
                        "prefix_plies": depth,
                        "start_player": Player.BLACK.value,
                        "stratum_id": stratum_id,
                        "stratum_index": stratum,
                        "superko_mode": "enforce",
                        "turn_count": accepted["turn_count"],
                        "variant_index": variant,
                    }
                )
    if len(openings) != EXPECTED_OPENINGS:
        raise PreparationError(
            f"opening count mismatch: {len(openings)} != {EXPECTED_OPENINGS}"
        )
    return openings


def build_manifest(*, generator_path: Path, v1_path: Path) -> dict[str, Any]:
    generator_path = resolve_repo_path(generator_path)
    v1_path = resolve_repo_path(v1_path)
    v1_manifest = load_json(v1_path)
    v1_prefixes, v1_states = _v1_hashes(v1_manifest)
    openings = materialize_openings(v1_manifest)
    prefix_counts = Counter(int(row["prefix_plies"]) for row in openings)
    size_counts = Counter(int(row["eval_size"]) for row in openings)
    return {
        "audit": {
            "all_nonterminal": all(bool(row["nonterminal"]) for row in openings),
            "all_no_auto_skip": all(bool(row["no_auto_skip"]) for row in openings),
            "all_pass_free": all(bool(row["pass_free"]) for row in openings),
            "all_point_actions_legal": all(
                bool(row["legal_point_actions_only"]) for row in openings
            ),
            "formal_games_executed": 0,
            "opening_count": len(openings),
            "openings_per_size": {str(size): size_counts[size] for size in SIZES},
            "prefix_counts": {
                str(depth): prefix_counts[depth] for depth in PREFIX_DEPTHS
            },
            "prefix_hashes_disjoint_from_v1": all(
                str(row["opening_prefix_hash"]) not in v1_prefixes for row in openings
            ),
            "prefix_hashes_unique": len(
                {str(row["opening_prefix_hash"]) for row in openings}
            )
            == len(openings),
            "state_hashes_disjoint_from_v1": all(
                str(row["opening_state_hash"]) not in v1_states for row in openings
            ),
            "state_hashes_unique": len(
                {str(row["opening_state_hash"]) for row in openings}
            )
            == len(openings),
        },
        "experiment_arm": EXPERIMENT_ARM,
        "experiment_id": EXPERIMENT_ID,
        "frozen_date": "2026-08-30",
        "generator": {
            "accept_conditions": [
                "exact target prefix depth reached using legal point actions only",
                "nonterminal after every action and at prefix end",
                "current player alternates after every action; no automatic skip",
                "consecutive_skips remains zero",
                "prefix SHA-256 unique across all 192 v3 openings",
                "state SHA-256 unique across all 192 v3 openings",
                "prefix and state SHA-256 disjoint from all 96 frozen v1 openings",
            ],
            "algorithm": (
                "python_random_mt19937_randrange_over_canonical_legal_point_actions"
            ),
            "candidate_order": "LifelineGame.legal_moves canonical point order",
            "generator_path": repo_relative(generator_path),
            "generator_sha256": sha256_file(generator_path),
            "max_rejection_attempts": MAX_REJECTION_ATTEMPTS,
            "model_or_checkpoint_access": False,
            "outcome_or_trajectory_access": False,
            "retry_formula": "(base_seed + generation_attempt*1000003) mod 2^63",
            "seed_namespace": SEED_NAMESPACE,
        },
        "opening_count": EXPECTED_OPENINGS,
        "openings": openings,
        "openings_per_size": OPENINGS_PER_SIZE,
        "prefix_depths": list(PREFIX_DEPTHS),
        "protocol_id": PROTOCOL_ID,
        "schema_name": SCHEMA_NAME,
        "schema_version": SCHEMA_VERSION,
        "sizes": list(SIZES),
        "status": "frozen_zero_formal_games",
        "strata_per_depth": STRATA_PER_DEPTH,
        "strata_per_size": STRATA_PER_SIZE,
        "v1_opening_binding": {
            "opening_count": 96,
            "path": repo_relative(v1_path),
            "sha256": sha256_file(v1_path),
            "usage": "disjointness check only; no v1 outcomes or trajectories read",
        },
        "variants_per_stratum": VARIANTS_PER_STRATUM,
    }


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise PreparationError(message)


def _replay_opening(row: Mapping[str, Any]) -> None:
    size = int(row["eval_size"])
    actions = [int(value) for value in row["opening_actions"]]
    coordinates = [[int(value) for value in point] for point in row["opening_coordinates"]]
    _require(len(actions) == int(row["prefix_plies"]), "opening depth mismatch")
    _require(len(coordinates) == len(actions), "opening coordinate count mismatch")
    game = LifelineGame(size, start_player=Player.BLACK, superko_mode="enforce")
    for index, (action, coordinate) in enumerate(zip(actions, coordinates)):
        _require(not game.game_over, f"opening terminal before action {index}")
        _require(action != game.num_points, "opening contains PASS")
        _require(0 <= action < game.num_points, "opening action out of range")
        point = game.valid_positions[action]
        _require(list(point) == coordinate, "opening action/coordinate mismatch")
        _require(point in game.legal_moves(), "opening contains illegal point action")
        actor = game.current_player
        result = game.play_move(point)
        _require(result.success, "opening replay action failed")
        _require(not game.game_over, "opening becomes terminal")
        _require(game.consecutive_skips == 0, "opening caused automatic skip")
        _require(
            game.current_player is LifelineGame.opponent(actor),
            "opening did not alternate current player",
        )
    _require(game.turn_count == len(actions), "opening turn count mismatch")
    _require(prefix_hash(actions) == row["opening_prefix_hash"], "prefix hash mismatch")
    _require(game.state_fingerprint() == row["opening_state_hash"], "state hash mismatch")
    _require(game.current_player.value == row["current_player"], "current player mismatch")
    _require(int(row["pass_index"]) == game.num_points, "PASS index mismatch")


def validate_manifest(
    manifest: Mapping[str, Any], *, generator_path: Path, v1_path: Path
) -> dict[str, Any]:
    expected = build_manifest(generator_path=generator_path, v1_path=v1_path)
    _require(dict(manifest) == expected, "opening manifest is not the exact frozen regeneration")
    openings = manifest["openings"]
    _require(isinstance(openings, list), "openings must be a list")
    by_size: dict[int, list[Mapping[str, Any]]] = defaultdict(list)
    by_stratum: dict[tuple[int, int], list[Mapping[str, Any]]] = defaultdict(list)
    for row in openings:
        _require(isinstance(row, dict), "opening row must be an object")
        _replay_opening(row)
        size = int(row["eval_size"])
        stratum = int(row["stratum_index"])
        by_size[size].append(row)
        by_stratum[(size, stratum)].append(row)
    _require(set(by_size) == set(SIZES), "opening sizes mismatch")
    for size in SIZES:
        _require(len(by_size[size]) == OPENINGS_PER_SIZE, f"n={size} opening count mismatch")
        depth_counts = Counter(int(row["prefix_plies"]) for row in by_size[size])
        _require(
            depth_counts == Counter({depth: STRATA_PER_DEPTH * 2 for depth in PREFIX_DEPTHS}),
            f"n={size} depth strata mismatch",
        )
        for stratum in range(STRATA_PER_SIZE):
            rows = by_stratum[(size, stratum)]
            _require(len(rows) == 2, f"n={size} stratum={stratum} needs two variants")
            _require(
                {int(row["variant_index"]) for row in rows} == {0, 1},
                "variant indices mismatch",
            )
            _require(
                len({int(row["prefix_plies"]) for row in rows}) == 1,
                "paired variants must share a prefix-depth stratum",
            )
    return {
        "experiment_id": EXPERIMENT_ID,
        "formal_games_executed": 0,
        "opening_count": len(openings),
        "openings_per_size": OPENINGS_PER_SIZE,
        "prefix_depths": list(PREFIX_DEPTHS),
        "status": "passed",
        "strata_per_size": STRATA_PER_SIZE,
        "variants_per_stratum": VARIANTS_PER_STRATUM,
    }


def atomic_write_new(path: Path, text: str) -> None:
    path = resolve_repo_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise PreparationError(f"refusing to overwrite existing frozen file: {path}")
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        if path.exists():
            raise PreparationError(f"target appeared during freeze: {path}")
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--v1-openings", type=Path, default=DEFAULT_V1_OPENINGS)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--check",
        action="store_true",
        help="validate an existing frozen manifest; never write",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.check:
            manifest = load_json(resolve_repo_path(args.output))
            report = validate_manifest(
                manifest, generator_path=SCRIPT_PATH, v1_path=args.v1_openings
            )
        else:
            manifest = build_manifest(
                generator_path=SCRIPT_PATH, v1_path=args.v1_openings
            )
            atomic_write_new(args.output, pretty_json(manifest))
            report = {
                "formal_games_executed": 0,
                "opening_count": EXPECTED_OPENINGS,
                "output": repo_relative(resolve_repo_path(args.output)),
                "sha256": sha256_file(resolve_repo_path(args.output)),
                "status": "frozen",
            }
    except PreparationError as exc:
        print(canonical_json({"error": str(exc), "formal_games_executed": 0, "status": "failed"}))
        return 2
    print(canonical_json(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
