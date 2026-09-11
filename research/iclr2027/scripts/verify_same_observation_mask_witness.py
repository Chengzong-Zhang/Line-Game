#!/usr/bin/env python3
"""Independently replay and audit a same-observation/mask search artifact.

The verifier does not import the search module.  For a found witness it
replays both complete histories through the public engine, reconstructs the
implemented topology observation and legal mask, and checks the declared
shared-action difference.  For a negative artifact it verifies the source
bindings, deterministic budget declaration, and absence of a claimed witness;
it deliberately does not upgrade a bounded negative result into nonexistence.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import sys
from pathlib import Path
from typing import Any, Sequence


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from lifeline_rl import LifelineGame, Player  # noqa: E402
from lifeline_rl.encoding import encode_observation  # noqa: E402


Action = tuple[int, int] | None

CORE_PATH = PROJECT_ROOT / "lifeline_rl" / "core.py"
ENCODING_PATH = PROJECT_ROOT / "lifeline_rl" / "encoding.py"
SEARCH_PATH = PROJECT_ROOT / "scripts" / "search_same_observation_mask_witness.py"
PROTOCOL_PATH = PROJECT_ROOT / "D19_V2_MATCHED_HISTORY_ABLATION_PROTOCOL.md"
MANIFEST_PATH = PROJECT_ROOT / "configs" / "d19_v2_matched_history_ablation_manifest.json"
MASK_FREE_ADDENDUM_PATH = PROJECT_ROOT / "D6_HISTORY_TWIN_EVIDENCE_ADDENDUM_V2.md"


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest().upper()


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))


def _sha256_json(value: Any) -> str:
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest().upper()


def _parse_action(raw: object, label: str) -> Action:
    if raw is None:
        return None
    if (
        not isinstance(raw, list)
        or len(raw) != 2
        or any(isinstance(value, bool) or not isinstance(value, int) for value in raw)
    ):
        raise ValueError(f"{label} must be PASS (null) or two strict integers")
    return raw[0], raw[1]


def _parse_history(raw: object, label: str) -> tuple[Action, ...]:
    if not isinstance(raw, list):
        raise ValueError(f"{label} must be a list")
    return tuple(_parse_action(item, f"{label}[{index}]") for index, item in enumerate(raw))


def _replay(grid_size: int, history: Sequence[Action], label: str) -> LifelineGame:
    game = LifelineGame(grid_size)
    for ply, action in enumerate(history):
        result = game.skip_turn() if action is None else game.play_move(action)
        if not result.success:
            raise ValueError(f"{label} is not a natural legal replay at ply {ply}: {result.reason}")
    return game


def _observation_payload(game: LifelineGame) -> dict[str, Any]:
    return {"game_over": bool(game.game_over), **encode_observation(game, "topology")}


def _observation_key(game: LifelineGame) -> str:
    return _canonical(_observation_payload(game))


def _json_action(action: Action) -> list[int] | None:
    return None if action is None else [action[0], action[1]]


def _ordered_legal_actions(game: LifelineGame) -> tuple[Action, ...]:
    mask = encode_observation(game, "topology")["legal_action_mask"]
    points = tuple(
        point for point, enabled in zip(game.valid_positions, mask[:-1]) if enabled
    )
    return points + ((None,) if mask[-1] else ())


def _successor(game: LifelineGame, action: Action) -> LifelineGame:
    child = LifelineGame(game.grid_size)
    child.restore(game.clone())
    result = child.skip_turn() if action is None else child.play_move(action)
    if not result.success:
        raise ValueError(f"declared shared action is not replayable: {action!r}")
    return child


def _verify_witness(
    witness: dict[str, Any],
    grid_size: int,
    declared_observation_sha256: str,
) -> dict[str, Any]:
    history_a = _parse_history(witness.get("history_a"), "history_a")
    history_b = _parse_history(witness.get("history_b"), "history_b")
    if history_a == history_b:
        raise ValueError("witness histories are identical")
    game_a = _replay(grid_size, history_a, "history_a")
    game_b = _replay(grid_size, history_b, "history_b")
    if game_a.history_hashes == game_b.history_hashes:
        raise ValueError("witness histories do not produce different Superko sets")
    key_a = _observation_key(game_a)
    key_b = _observation_key(game_b)
    if key_a != key_b:
        raise ValueError("witness does not have identical implemented observation and mask")
    if _sha256_json(_observation_payload(game_a)) != declared_observation_sha256:
        raise ValueError("witness observation digest does not match search artifact")

    action = _parse_action(witness.get("action"), "witness action")
    legal_a = set(_ordered_legal_actions(game_a))
    legal_b = set(_ordered_legal_actions(game_b))
    if legal_a != legal_b or action not in legal_a:
        raise ValueError("witness action is not shared legal under the implemented mask")

    difference = witness.get("difference")
    checked: dict[str, Any] = {
        "difference": difference,
        "same_implemented_observation_and_mask": True,
        "different_complete_histories": True,
        "different_history_sets": True,
        "shared_legal_action": _json_action(action),
        "shared_legal_action_count": len(legal_a),
    }
    if difference in {
        "different_successor_implemented_observation_and_mask",
        "different_terminal_black_reward",
    }:
        successor_a = _successor(game_a, action)
        successor_b = _successor(game_b, action)
        successor_equal = _observation_key(successor_a) == _observation_key(successor_b)
        checked["successor_observation_equal"] = successor_equal
        if difference == "different_successor_implemented_observation_and_mask" and successor_equal:
            raise ValueError("declared successor-observation difference does not replay")
        if difference == "different_terminal_black_reward":
            if not successor_a.game_over or not successor_b.game_over:
                raise ValueError("declared terminal reward difference lacks two terminal successors")
            reward_a = int(successor_a.rewards()[Player.BLACK])
            reward_b = int(successor_b.rewards()[Player.BLACK])
            checked["successor_black_rewards"] = [reward_a, reward_b]
            if reward_a == reward_b:
                raise ValueError("declared terminal reward difference does not replay")
    elif difference in {
        "different_exact_black_value",
        "different_optimal_action_set",
        "different_shared_action_q_value",
    }:
        decision = witness.get("decision")
        if not isinstance(decision, dict) or decision.get("status") != "EXACT":
            raise ValueError("decision witness lacks an exact decision payload")
        checked["decision_payload_shape_valid"] = True
    else:
        raise ValueError(f"unsupported witness difference: {difference!r}")
    return checked


def verify(path: Path) -> dict[str, Any]:
    raw = path.read_bytes()
    payload = json.loads(raw.decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("search artifact root must be an object")
    if payload.get("schema_name") != "lifeline-d19-v2-same-implemented-observation-mask-search":
        raise ValueError("unexpected search artifact schema")
    binding = payload.get("source_binding")
    if not isinstance(binding, dict):
        raise ValueError("search artifact lacks source bindings")
    observed = {
        "engine_core_sha256": _sha256_file(CORE_PATH),
        "encoding_sha256": _sha256_file(ENCODING_PATH),
        "search_script_sha256": _sha256_file(SEARCH_PATH),
        "d19_protocol_sha256": _sha256_file(PROTOCOL_PATH),
        "d19_manifest_sha256": _sha256_file(MANIFEST_PATH),
        "mask_free_addendum_sha256": _sha256_file(MASK_FREE_ADDENDUM_PATH),
    }
    for key, value in observed.items():
        if binding.get(key) != value:
            raise ValueError(f"source binding mismatch: {key}")

    config = payload.get("search_config")
    if not isinstance(config, dict):
        raise ValueError("search artifact lacks search configuration")
    required_config = {
        "standard_initial_state": True,
        "start_player": "BLACK",
        "superko_mode": "enforce",
        "strategy": "deterministic_breadth_first_full_snapshot_search",
        "frontier_discipline": "FIFO",
        "action_order": "PASS_FIRST_THEN_LEXICOGRAPHIC_POINTS_V1",
        "wall_clock_stop": False,
    }
    for key, expected in required_config.items():
        if config.get(key) != expected:
            raise ValueError(f"search configuration drifted at {key}")
    for key in ("grid_size", "max_states", "max_depth_actions_including_pass", "exact_solver_node_budget", "max_decision_pairs"):
        if not isinstance(config.get(key), int) or config[key] < 0:
            raise ValueError(f"invalid non-negative integer budget: {key}")
    if config["grid_size"] < 2 or config["max_states"] <= 0:
        raise ValueError("invalid grid/state budget")

    scope = payload.get("observation_scope")
    if not isinstance(scope, dict) or not all(scope.get(key) is True for key in (
        "board_fixed", "typed_logical_edges_fixed", "player_fixed", "skip_state_fixed",
        "terminal_flag_fixed", "implemented_legal_action_mask_fixed",
        "complete_history_must_differ", "history_set_must_differ",
    )):
        raise ValueError("observation scope is not the declared strict scope")
    result = payload.get("result")
    if not isinstance(result, dict) or not isinstance(result.get("first_witnesses"), dict):
        raise ValueError("search artifact lacks result/witness map")
    status = payload.get("status")
    if status not in {"FOUND", "NOT_FOUND_WITHIN_DECLARED_BUDGET"}:
        raise ValueError("unsupported search status")

    checked_witnesses: dict[str, Any] = {}
    for difference, witness in result["first_witnesses"].items():
        if not isinstance(witness, dict):
            raise ValueError(f"witness {difference!r} is not an object")
        checked_witnesses[difference] = _verify_witness(
            witness,
            config["grid_size"],
            str(witness.get("observation_sha256")),
        )
    if status == "FOUND" and not checked_witnesses:
        raise ValueError("FOUND artifact has no replayable witness")
    if status == "NOT_FOUND_WITHIN_DECLARED_BUDGET" and checked_witnesses:
        raise ValueError("negative artifact contains a witness")
    if payload.get("claim_boundary", {}).get("global_nonexistence_claimed") is not False:
        raise ValueError("negative/nonexistence claim boundary is unsafe")
    if payload.get("claim_boundary", {}).get("mask_free_side6_witness_promoted") is not False:
        raise ValueError("mask-free side-6 witness was improperly promoted")

    return {
        "schema_name": "lifeline-d19-v2-same-implemented-observation-mask-verification",
        "schema_version": 1,
        "status": "PASS",
        "ok": True,
        "artifact_path": path.resolve().relative_to(PROJECT_ROOT.parent.parent).as_posix(),
        "artifact_sha256": hashlib.sha256(raw).hexdigest().upper(),
        "search_status": status,
        "bounded_negative_is_not_nonexistence": status == "NOT_FOUND_WITHIN_DECLARED_BUDGET",
        "replayed_witnesses": checked_witnesses,
        "source_binding": observed,
        "runtime": {
            "python_version": platform.python_version(),
            "python_implementation": platform.python_implementation(),
            "platform": platform.platform(),
            "cpu_only": True,
            "network_used": False,
            "gpu_used": False,
        },
    }


def _write_create_only(path: Path, payload: dict[str, Any]) -> None:
    resolved = path.resolve()
    if resolved.exists():
        raise FileExistsError(f"refusing to overwrite verification artifact: {resolved}")
    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_text(json.dumps(payload, ensure_ascii=True, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--search-artifact", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    receipt = verify(args.search_artifact.resolve())
    _write_create_only(args.output, receipt)
    print(json.dumps({"status": receipt["status"], "output": str(args.output.resolve()), "search_status": receipt["search_status"]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
