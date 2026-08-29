"""Run a paired multi-policy Superko engineering matrix.

Each independent block contains four games: enforce/observe with the focal
policy as BLACK, followed by enforce/observe with the focal policy as WHITE.
The two rule modes receive the same decision-local seed whenever their states
remain paired.  The script is an engineering ablation, not an equivalence test
and not evidence that a smoke-trained checkpoint is a paper-quality RL agent.
"""

from __future__ import annotations

import argparse
import hashlib
import inspect
import json
import math
import platform
import random
import statistics
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from lifeline_rl import LifelineGame, Player  # noqa: E402
from lifeline_rl.agents import (  # noqa: E402
    Action,
    CycleSeekingAgent,
    CycleSeekingConfig,
    GreedyAgent,
    MCTSAgent,
    MCTSConfig,
    MinimaxAgent,
    MinimaxConfig,
    check_fixture_guided_cycle,
    legal_actions,
)


EXPERIMENT_VERSION = "superko-policy-matrix-v1"
NEW_SEEDS = (
    2_111_448_885,
    1_179_994_698,
    1_147_703_047,
    2_073_532_949,
    281_460_105,
)
DRY_RUN_SEED = 1_266_014_321
SUPERKO_MODES = ("enforce", "observe")
POLICIES = ("random", "greedy", "minimax-2", "mcts", "frozen-rl", "cycle-seeking")
OUTCOMES = (Player.BLACK.value, Player.WHITE.value, "DRAW", "TRUNCATED")
WITNESS_PATH = ROOT / "state_aliasing" / "superko_n6_witness_v1.json"
DEFAULT_CHECKPOINT = (
    ROOT
    / "results"
    / "smoke"
    / "alphazero"
    / "d9_d10_topology_smoke_verified_seed20260825"
)
FORMAL_MANIFEST_PATH = ROOT / "configs" / "superko_policy_matrix_v1_manifest.json"
EXPECTED_CHECKPOINT_SHA256 = (
    "24fc1e93b74b64e2fdcd79f126f14377916557ac4e1b770b57662a1fe77dc423"
)
EXPECTED_CHECKPOINT_CONFIG_HASH = (
    "4941d9d2c45615592672dacfa7624f2095d045dc74f48a7df6b8eb464bf253fd"
)
EXPECTED_CHECKPOINT_SOURCE_HASH = (
    "90fffac7a50fdcf25b5d2fcd2bcb8e109d176fa261ef6766715f87e2b95124df"
)
FORMAL_CONFIG = {
    "sizes": [6, 7],
    "policies": list(POLICIES),
    "seeds": list(NEW_SEEDS),
    "blocks_per_seed": 1,
    "max_plies": 120,
    "minimax_move_cap": 20,
    "mcts_simulations": 16,
    "mcts_rollout_depth": 24,
    "mcts_exploration": 2**0.5,
    "cycle_max_depth": 4,
    "cycle_branch_limit": 5,
    "cycle_node_budget": 1_000,
    "rl_simulations": 4,
    "rl_c_puct": 1.5,
    "rl_device": "cpu",
    "bootstrap_resamples": 10_000,
}
CLAIM_BOUNDARY = (
    "ENGINEERING_MULTI_POLICY_EXTENSION_ONLY: absence or small frequency of "
    "Superko effects under these finite seeded policies is not rule equivalence. "
    "The frozen RL condition uses an n=5 engineering-smoke checkpoint trained "
    "from one self-play game with one gradient update and evaluates the same "
    "weights out of distribution on n=6/n=7 and, for observe, under a different "
    "rule mode. It is not a paper-quality learned baseline. The cycle fixture is "
    "a guided positive control and is not evidence for generic search success."
)


def derive_seed(*parts: object) -> int:
    payload = "|".join(str(part) for part in parts).encode("utf-8")
    return int.from_bytes(hashlib.sha256(payload).digest()[:8], "big")


def frozen_seed(index: int) -> int:
    payload = f"{EXPERIMENT_VERSION}|{index}".encode("ascii")
    return int.from_bytes(hashlib.sha256(payload).digest()[:4], "big") & 0x7FFFFFFF


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _action_index(game: LifelineGame, action: Action) -> int:
    return game.num_points if action is None else game.point_to_index[action]


def _action_json(action: Action) -> list[int] | None:
    return None if action is None else [action[0], action[1]]


def _position_projection(game: LifelineGame) -> tuple[object, ...]:
    snapshot = game.clone()
    return (
        snapshot.grid,
        snapshot.black_edges,
        snapshot.white_edges,
        snapshot.current_player,
        snapshot.game_over,
        snapshot.consecutive_skips,
    )


def _position_sha256(game: LifelineGame) -> str:
    return hashlib.sha256(repr(_position_projection(game)).encode("utf-8")).hexdigest()


def _full_state_sha256(game: LifelineGame) -> str:
    return hashlib.sha256(game.canonical_state_json().encode("utf-8")).hexdigest()


def _mode_normalized_state_sha256(game: LifelineGame) -> str:
    """Digest the complete rule state while intentionally excluding mode."""

    snapshot = game.clone()
    normalized = (
        snapshot.grid,
        snapshot.black_edges,
        snapshot.white_edges,
        snapshot.current_player,
        snapshot.game_over,
        snapshot.consecutive_skips,
        snapshot.turn_count,
        tuple(sorted(snapshot.history_hashes, key=repr)),
        snapshot.start_player,
    )
    return hashlib.sha256(repr(normalized).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class KeyedRandomAgent:
    """Uniform random agent with set-independent per-action priorities.

    At matched states, adding one Superko-only action changes the selected
    shared action only when that new action has the highest keyed priority.
    """

    label: str = "canonical-keyed-random"

    @property
    def name(self) -> str:
        return self.label

    def select_action(self, game: LifelineGame, rng: random.Random) -> Action:
        actions = legal_actions(game)
        if not actions:
            raise RuntimeError("cannot act in a terminal state")
        key = rng.getrandbits(128)

        def priority(action: Action) -> tuple[int, int]:
            index = _action_index(game, action)
            payload = f"{EXPERIMENT_VERSION}|keyed-random|{key:032x}|{index}".encode(
                "ascii"
            )
            return int.from_bytes(hashlib.sha256(payload).digest(), "big"), index

        return max(actions, key=priority)

    def diagnostics(self) -> dict[str, object]:
        return {"coupling": "set-independent keyed priority", "uniform": True}


def _diagnostic_summary(raw: dict[str, object]) -> dict[str, object]:
    keys = (
        "algorithm",
        "reason",
        "found_cycle",
        "nodes_expanded",
        "max_depth_reached",
        "path",
        "repeat_action",
        "simulations",
        "selected_visits",
        "selected_mean_value",
        "selected_prior",
        "selected_q",
        "value",
        "nodes",
        "leaf_evaluations",
        "selected_score",
        "root_actions",
        "root_visits",
        "root_priors",
        "root_q_values",
        "root_visit_sum",
    )
    summary = {key: raw[key] for key in keys if key in raw}
    if "found_cycle" in summary:
        summary["counterfactual_cycle_plan_found"] = summary.pop("found_cycle")
        summary["counterfactual_plan_not_actual_episode_cycle"] = True
    return summary


def _make_non_neural_agents(policy: str, args: argparse.Namespace) -> tuple[Any, Any]:
    anchor = KeyedRandomAgent("canonical-keyed-random-anchor")
    if policy == "random":
        return KeyedRandomAgent("canonical-keyed-random-focal"), anchor
    if policy == "greedy":
        return GreedyAgent(label="greedy-focal"), anchor
    if policy == "minimax-2":
        return (
            MinimaxAgent(
                MinimaxConfig(depth=2, move_cap=args.minimax_move_cap),
                label=f"minimax-2-cap{args.minimax_move_cap}-focal",
            ),
            anchor,
        )
    if policy == "mcts":
        return (
            MCTSAgent(
                MCTSConfig(
                    simulations=args.mcts_simulations,
                    exploration=args.mcts_exploration,
                    rollout_depth=args.mcts_rollout_depth,
                ),
                label=(
                    f"uct-mcts-s{args.mcts_simulations}-d{args.mcts_rollout_depth}-focal"
                ),
            ),
            anchor,
        )
    if policy == "cycle-seeking":
        return (
            CycleSeekingAgent(
                CycleSeekingConfig(
                    max_depth=args.cycle_max_depth,
                    branch_limit=args.cycle_branch_limit,
                    node_budget=args.cycle_node_budget,
                    fallback="random",
                ),
                label=(
                    f"cycle-seeking-d{args.cycle_max_depth}-b{args.cycle_branch_limit}"
                    f"-n{args.cycle_node_budget}-focal"
                ),
            ),
            anchor,
        )
    raise ValueError(f"unsupported non-neural policy: {policy}")


def _load_frozen_rl_agent(args: argparse.Namespace) -> tuple[Any, dict[str, Any]]:
    if not args.allow_checkpoint_source_migration:
        raise RuntimeError(
            "the legacy smoke checkpoint source hash differs from the current "
            "tree; pass --allow-checkpoint-source-migration to acknowledge the "
            "fixed-weight engineering migration"
        )
    try:
        from lifeline_rl.alphazero.neural_agent import (
            NeuralPUCTAgent,
            NeuralPUCTSearchConfig,
        )
        from lifeline_rl.alphazero.trainer import AlphaZeroTrainer
    except ImportError as exc:
        raise RuntimeError("frozen RL evaluation requires the PyTorch environment") from exc

    signature = inspect.signature(NeuralPUCTAgent.from_checkpoint)
    if "allow_superko_mode_override" not in signature.parameters:
        raise RuntimeError(
            "NeuralPUCTAgent lacks the explicit allow_superko_mode_override gate"
        )
    checkpoint = args.checkpoint.resolve()
    agent = NeuralPUCTAgent.from_checkpoint(
        checkpoint,
        device=args.rl_device,
        search_config=NeuralPUCTSearchConfig(
            simulations=args.rl_simulations,
            c_puct=args.rl_c_puct,
            temperature=0.0,
        ),
        label="frozen-topology-smoke-puct-focal",
        expected_model_kind="topology_gnn",
        expected_observation_mode="topology",
        expected_config_hash=EXPECTED_CHECKPOINT_CONFIG_HASH,
        expected_source_hash=EXPECTED_CHECKPOINT_SOURCE_HASH,
        strict_source=False,
        allow_superko_mode_override=True,
    )
    current_source_hash = AlphaZeroTrainer.current_source_hash()
    identity = agent.checkpoint_identity
    expected_identity = {
        "sha256": EXPECTED_CHECKPOINT_SHA256,
        "config_hash": EXPECTED_CHECKPOINT_CONFIG_HASH,
        "source_hash": EXPECTED_CHECKPOINT_SOURCE_HASH,
        "games_completed": 1,
        "gradient_steps": 1,
        "iteration": 1,
    }
    observed_identity = {
        key: getattr(identity, key) for key in expected_identity
    }
    if observed_identity != expected_identity:
        raise RuntimeError(
            "frozen RL checkpoint identity mismatch: "
            f"expected {expected_identity}, observed {observed_identity}"
        )
    if agent.config.trained_board_sizes != (5,) or agent.config.train_superko_mode != "enforce":
        raise RuntimeError("frozen RL training scope is not the preregistered n=5/enforce run")
    metadata = agent.metadata_dict()
    metadata.update(
        {
            "classification": "engineering_smoke_checkpoint_not_paper_baseline",
            "source_migration_waiver": True,
            "rule_mode_override": True,
            "train_superko_mode": agent.config.superko_mode,
            "eval_superko_modes": list(SUPERKO_MODES),
            "current_source_hash": current_source_hash,
            "saved_source_hash_matches_current": identity.source_hash == current_source_hash,
        }
    )
    return agent, metadata


def _agents_for_game(
    policy: str,
    args: argparse.Namespace,
    frozen_rl_agent: Any | None,
) -> tuple[Any, Any]:
    if policy != "frozen-rl":
        return _make_non_neural_agents(policy, args)
    if frozen_rl_agent is None:
        raise RuntimeError("frozen RL agent was not loaded")
    return frozen_rl_agent, KeyedRandomAgent("canonical-keyed-random-anchor")


def _winner_value(game: LifelineGame, truncated: bool) -> str | None:
    if truncated:
        return None
    winner = game.winner()
    return winner.value if isinstance(winner, Player) else winner


def _focal_score(winner: str | None, truncated: bool, focal_color: Player) -> float | None:
    if truncated:
        return None
    if winner == "DRAW":
        return 0.5
    if winner == focal_color.value:
        return 1.0
    if winner == LifelineGame.opponent(focal_color).value:
        return 0.0
    raise AssertionError(f"unexpected winner {winner!r}")


def _play_game(
    *,
    policy: str,
    mode: str,
    grid_size: int,
    master_seed: int,
    block_index: int,
    block_seed: int,
    orientation: str,
    focal_color: Player,
    max_plies: int,
    args: argparse.Namespace,
    frozen_rl_agent: Any | None,
) -> dict[str, Any]:
    focal_agent, anchor_agent = _agents_for_game(policy, args, frozen_rl_agent)
    agents = {
        focal_color: ("focal", focal_agent),
        LifelineGame.opponent(focal_color): ("anchor", anchor_agent),
    }
    game = LifelineGame(grid_size, superko_mode=mode)
    actions: list[dict[str, Any]] = []
    started = time.perf_counter()
    decision_seconds = {"focal": 0.0, "anchor": 0.0}
    trigger_states = 0
    repeat_candidates_total = 0
    selected_repetitions = 0

    while not game.game_over and len(actions) < max_plies:
        ply = len(actions)
        actor = game.current_player
        slot, agent = agents[actor]
        position_before_sha256 = _position_sha256(game)
        full_state_before_sha256 = _full_state_sha256(game)
        normalized_state_before_sha256 = _mode_normalized_state_sha256(game)
        legal_indices = [_action_index(game, action) for action in legal_actions(game)]
        repeats = tuple(game.would_violate_superko_moves())
        if repeats:
            trigger_states += 1
            repeat_candidates_total += len(repeats)
        decision_seed = derive_seed(
            EXPERIMENT_VERSION,
            master_seed,
            block_index,
            grid_size,
            policy,
            orientation,
            slot,
            actor.value,
            ply,
        )
        before = game.clone()
        decision_started = time.perf_counter()
        action = agent.select_action(game, random.Random(decision_seed))
        elapsed = time.perf_counter() - decision_started
        decision_seconds[slot] += elapsed
        if game.clone() != before:
            raise RuntimeError(f"agent {agent.name!r} mutated the arena state")
        if action is not None and action not in game.point_to_index:
            raise RuntimeError(f"agent {agent.name!r} returned invalid point {action!r}")
        selected_repeat = action is not None and action in repeats
        result = game.skip_turn() if action is None else game.play_move(action)
        if not result.success:
            raise RuntimeError(
                f"{agent.name} selected illegal {action!r} in {mode}: {result.reason}"
            )
        if bool(result.would_violate_superko) != selected_repeat:
            raise AssertionError("Superko probe and transition flag disagree")
        selected_repetitions += int(selected_repeat)
        actions.append(
            {
                "ply": ply,
                "actor": actor.value,
                "slot": slot,
                "agent": agent.name,
                "decision_seed": decision_seed,
                "position_before_sha256": position_before_sha256,
                "full_state_before_sha256": full_state_before_sha256,
                "mode_normalized_state_before_sha256": normalized_state_before_sha256,
                "legal_actions": legal_indices,
                "action": _action_index(game, action),
                "point": _action_json(action),
                "would_violate_superko_candidates": [
                    game.point_to_index[point] for point in repeats
                ],
                "selected_would_violate_superko": selected_repeat,
                "result_success": result.success,
                "result_reason": result.reason,
                "result_would_violate_superko": result.would_violate_superko,
                "decision_seconds": elapsed,
                "diagnostics": _diagnostic_summary(dict(agent.diagnostics())),
                "position_after_sha256": _position_sha256(game),
                "full_state_after_sha256": _full_state_sha256(game),
                "mode_normalized_state_after_sha256": _mode_normalized_state_sha256(game),
            }
        )

    duration = time.perf_counter() - started
    truncated = not game.game_over
    winner = _winner_value(game, truncated)
    return {
        "mode": mode,
        "grid_size": grid_size,
        "policy": policy,
        "master_seed": master_seed,
        "block_index": block_index,
        "block_seed": block_seed,
        "orientation": orientation,
        "focal_color": focal_color.value,
        "focal_agent": focal_agent.name,
        "anchor_agent": anchor_agent.name,
        "max_plies": max_plies,
        "plies": len(actions),
        "truncated": truncated,
        "winner": winner,
        "focal_score": _focal_score(winner, truncated, focal_color),
        "trigger_states": trigger_states,
        "repeat_candidates_total": repeat_candidates_total,
        "selected_repetitions": selected_repetitions,
        "triggered": trigger_states > 0,
        "selected_repetition": selected_repetitions > 0,
        "decision_seconds": decision_seconds,
        "duration_seconds": duration,
        "action_trace_sha256": hashlib.sha256(
            json.dumps(
                [[entry["actor"], entry["action"]] for entry in actions],
                separators=(",", ":"),
            ).encode("ascii")
        ).hexdigest(),
        "final_position_sha256": _position_sha256(game),
        "final_full_state_sha256": _full_state_sha256(game),
        "final_mode_normalized_state_sha256": _mode_normalized_state_sha256(game),
        "actions": actions,
    }


def _compare_games(enforce: dict[str, Any], observe: dict[str, Any]) -> dict[str, Any]:
    first_action_divergence: int | None = None
    first_position_divergence: int | None = None
    first_complete_state_divergence: int | None = None
    aligned_trigger_plies: list[int] = []
    still_paired = True
    shared = min(len(enforce["actions"]), len(observe["actions"]))
    for ply in range(shared):
        left = enforce["actions"][ply]
        right = observe["actions"][ply]
        if (
            still_paired
            and left["mode_normalized_state_before_sha256"]
            == right["mode_normalized_state_before_sha256"]
            and left["would_violate_superko_candidates"]
            and left["would_violate_superko_candidates"]
            == right["would_violate_superko_candidates"]
        ):
            aligned_trigger_plies.append(ply)
        if first_action_divergence is None and (
            left["actor"] != right["actor"] or left["action"] != right["action"]
        ):
            first_action_divergence = ply
        if (
            first_position_divergence is None
            and left["position_after_sha256"] != right["position_after_sha256"]
        ):
            first_position_divergence = ply
        if (
            first_complete_state_divergence is None
            and left["mode_normalized_state_after_sha256"]
            != right["mode_normalized_state_after_sha256"]
        ):
            first_complete_state_divergence = ply
        if (
            left["actor"] != right["actor"]
            or left["action"] != right["action"]
            or left["mode_normalized_state_after_sha256"]
            != right["mode_normalized_state_after_sha256"]
        ):
            still_paired = False
    if len(enforce["actions"]) != len(observe["actions"]):
        if first_action_divergence is None:
            first_action_divergence = shared
        if first_position_divergence is None:
            first_position_divergence = shared
        if first_complete_state_divergence is None:
            first_complete_state_divergence = shared
    outcome_enforce = "TRUNCATED" if enforce["truncated"] else enforce["winner"]
    outcome_observe = "TRUNCATED" if observe["truncated"] else observe["winner"]
    score_difference = None
    if enforce["focal_score"] is not None and observe["focal_score"] is not None:
        score_difference = observe["focal_score"] - enforce["focal_score"]
    return {
        "trajectory_diverged": (
            first_action_divergence is not None or first_position_divergence is not None
            or first_complete_state_divergence is not None
        ),
        "first_action_divergence_ply": first_action_divergence,
        "first_position_divergence_after_ply": first_position_divergence,
        "first_complete_state_divergence_after_ply": first_complete_state_divergence,
        "aligned_trigger_plies": aligned_trigger_plies,
        "first_aligned_trigger_ply": (
            aligned_trigger_plies[0] if aligned_trigger_plies else None
        ),
        "divergence_begins_at_aligned_trigger": bool(
            aligned_trigger_plies
            and (
                first_action_divergence == aligned_trigger_plies[0]
                or first_position_divergence == aligned_trigger_plies[0]
                or first_complete_state_divergence == aligned_trigger_plies[0]
            )
        ),
        "outcome_enforce": outcome_enforce,
        "outcome_observe": outcome_observe,
        "outcome_agrees": outcome_enforce == outcome_observe,
        "enforce_plies": enforce["plies"],
        "observe_plies": observe["plies"],
        "focal_score_observe_minus_enforce": score_difference,
        "plies_observe_minus_enforce": observe["plies"] - enforce["plies"],
        "truncation_observe_minus_enforce": (
            float(observe["truncated"]) - float(enforce["truncated"])
        ),
    }


def _run_block(
    *,
    policy: str,
    grid_size: int,
    master_seed: int,
    block_index: int,
    args: argparse.Namespace,
    frozen_rl_agent: Any | None,
) -> dict[str, Any]:
    block_seed = derive_seed(
        EXPERIMENT_VERSION, master_seed, grid_size, policy, block_index, "block"
    )
    orientations: list[dict[str, Any]] = []
    for orientation, focal_color in (
        ("focal_black", Player.BLACK),
        ("focal_white", Player.WHITE),
    ):
        games = {
            mode: _play_game(
                policy=policy,
                mode=mode,
                grid_size=grid_size,
                master_seed=master_seed,
                block_index=block_index,
                block_seed=block_seed,
                orientation=orientation,
                focal_color=focal_color,
                max_plies=args.max_plies,
                args=args,
                frozen_rl_agent=frozen_rl_agent,
            )
            for mode in SUPERKO_MODES
        }
        orientations.append(
            {
                "orientation": orientation,
                "focal_color": focal_color.value,
                "comparison": _compare_games(games["enforce"], games["observe"]),
                **games,
            }
        )
    mode_scores: dict[str, float | None] = {}
    mode_plies: dict[str, float] = {}
    mode_truncation: dict[str, float] = {}
    for mode in SUPERKO_MODES:
        scores = [orientation[mode]["focal_score"] for orientation in orientations]
        mode_scores[mode] = (
            statistics.fmean(scores) if all(score is not None for score in scores) else None
        )
        mode_plies[mode] = statistics.fmean(
            orientation[mode]["plies"] for orientation in orientations
        )
        mode_truncation[mode] = statistics.fmean(
            float(orientation[mode]["truncated"]) for orientation in orientations
        )
    return {
        "master_seed": master_seed,
        "block_index": block_index,
        "block_seed": block_seed,
        "orientations": orientations,
        "summary": {
            "focal_score": mode_scores,
            "focal_score_observe_minus_enforce": (
                None
                if mode_scores["enforce"] is None or mode_scores["observe"] is None
                else mode_scores["observe"] - mode_scores["enforce"]
            ),
            "mean_plies": mode_plies,
            "mean_plies_observe_minus_enforce": (
                mode_plies["observe"] - mode_plies["enforce"]
            ),
            "truncation_rate": mode_truncation,
            "truncation_rate_observe_minus_enforce": (
                mode_truncation["observe"] - mode_truncation["enforce"]
            ),
            "any_trigger": any(
                orientation[mode]["triggered"]
                for orientation in orientations
                for mode in SUPERKO_MODES
            ),
            "observe_selected_repetition": any(
                orientation["observe"]["selected_repetition"]
                for orientation in orientations
            ),
            "any_trajectory_divergence": any(
                orientation["comparison"]["trajectory_diverged"]
                for orientation in orientations
            ),
        },
    }


def _wilson(successes: int, trials: int) -> list[float] | None:
    if trials == 0:
        return None
    z = 1.959963984540054
    proportion = successes / trials
    z2 = z * z
    denominator = 1.0 + z2 / trials
    center = (proportion + z2 / (2.0 * trials)) / denominator
    margin = z * math.sqrt(
        proportion * (1.0 - proportion) / trials + z2 / (4.0 * trials * trials)
    ) / denominator
    return [
        0.0 if successes == 0 else max(0.0, center - margin),
        1.0 if successes == trials else min(1.0, center + margin),
    ]


def _rate(successes: int, trials: int) -> dict[str, Any]:
    return {
        "successes": successes,
        "trials": trials,
        "rate": successes / trials if trials else None,
        "ci95_wilson": _wilson(successes, trials),
    }


def _percentile(values: Sequence[float], probability: float) -> float:
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    location = probability * (len(ordered) - 1)
    lower = math.floor(location)
    upper = math.ceil(location)
    fraction = location - lower
    return ordered[lower] * (1.0 - fraction) + ordered[upper] * fraction


def _bootstrap_mean(
    values: Sequence[float], *, seed: int, resamples: int
) -> dict[str, Any]:
    if not values:
        return {"blocks": 0, "mean": None, "resamples": resamples, "ci95": None}
    rng = random.Random(seed)
    count = len(values)
    draws = [
        statistics.fmean(values[rng.randrange(count)] for _ in range(count))
        for _ in range(resamples)
    ]
    return {
        "blocks": count,
        "mean": statistics.fmean(values),
        "resamples": resamples,
        "ci95": [_percentile(draws, 0.025), _percentile(draws, 0.975)],
    }


def _hierarchical_pair_bootstrap(
    blocks: Sequence[dict[str, Any]],
    *,
    field: str,
    seed: int,
    resamples: int,
) -> dict[str, Any]:
    """Resample seed blocks, then orientation pairs inside each block."""

    by_block = [
        [
            orientation["comparison"][field]
            for orientation in block["orientations"]
            if orientation["comparison"][field] is not None
        ]
        for block in blocks
    ]
    observed = [value for values in by_block for value in values]
    if not observed:
        return {
            "seed_blocks": len(blocks),
            "retained_orientation_pairs": 0,
            "mean": None,
            "resamples_requested": resamples,
            "resamples_valid": 0,
            "ci95": None,
        }
    rng = random.Random(seed)
    sampled_means: list[float] = []
    for _ in range(resamples):
        sampled: list[float] = []
        for _ in blocks:
            values = by_block[rng.randrange(len(by_block))]
            if values:
                sampled.extend(values[rng.randrange(len(values))] for _ in values)
        if sampled:
            sampled_means.append(statistics.fmean(sampled))
    return {
        "seed_blocks": len(blocks),
        "retained_orientation_pairs": len(observed),
        "mean": statistics.fmean(observed),
        "resamples_requested": resamples,
        "resamples_valid": len(sampled_means),
        "ci95": (
            [_percentile(sampled_means, 0.025), _percentile(sampled_means, 0.975)]
            if sampled_means
            else None
        ),
    }


def _hierarchical_relative_plies_bootstrap(
    blocks: Sequence[dict[str, Any]],
    *,
    seed: int,
    resamples: int,
) -> dict[str, Any]:
    by_block = [
        [
            (
                float(orientation["comparison"]["enforce_plies"]),
                float(orientation["comparison"]["observe_plies"]),
            )
            for orientation in block["orientations"]
        ]
        for block in blocks
    ]
    observed = [pair for values in by_block for pair in values]

    def effect(pairs: Sequence[tuple[float, float]]) -> float:
        enforce_mean = statistics.fmean(pair[0] for pair in pairs)
        observe_mean = statistics.fmean(pair[1] for pair in pairs)
        return (observe_mean - enforce_mean) / enforce_mean

    rng = random.Random(seed)
    sampled_effects: list[float] = []
    for _ in range(resamples):
        sampled: list[tuple[float, float]] = []
        for _ in blocks:
            values = by_block[rng.randrange(len(by_block))]
            sampled.extend(values[rng.randrange(len(values))] for _ in values)
        sampled_effects.append(effect(sampled))
    return {
        "seed_blocks": len(blocks),
        "orientation_pairs": len(observed),
        "effect": effect(observed),
        "definition": "(mean(observe plies)-mean(enforce plies))/mean(enforce plies)",
        "resamples": resamples,
        "ci95": [
            _percentile(sampled_effects, 0.025),
            _percentile(sampled_effects, 0.975),
        ],
    }


def _score_bounds(blocks: Sequence[dict[str, Any]]) -> dict[str, Any]:
    lower: list[float] = []
    upper: list[float] = []
    for block in blocks:
        enforce_low = enforce_high = observe_low = observe_high = 0.0
        for orientation in block["orientations"]:
            enforce_score = orientation["enforce"]["focal_score"]
            observe_score = orientation["observe"]["focal_score"]
            enforce_low += 0.0 if enforce_score is None else enforce_score
            enforce_high += 1.0 if enforce_score is None else enforce_score
            observe_low += 0.0 if observe_score is None else observe_score
            observe_high += 1.0 if observe_score is None else observe_score
        lower.append(observe_low / 2.0 - enforce_high / 2.0)
        upper.append(observe_high / 2.0 - enforce_low / 2.0)
    return {
        "blocks": len(blocks),
        "identified_sample_mean_interval": [
            statistics.fmean(lower),
            statistics.fmean(upper),
        ],
        "definition": "truncated focal scores range independently over [0,1]",
        "sampling_uncertainty_included": False,
    }


def _summarize_condition(
    blocks: Sequence[dict[str, Any]],
    *,
    policy: str,
    grid_size: int,
    bootstrap_resamples: int,
) -> dict[str, Any]:
    games = {
        mode: [
            orientation[mode]
            for block in blocks
            for orientation in block["orientations"]
        ]
        for mode in SUPERKO_MODES
    }
    comparisons = [
        orientation["comparison"]
        for block in blocks
        for orientation in block["orientations"]
    ]
    contingency = {
        enforce: {observe: 0 for observe in OUTCOMES} for enforce in OUTCOMES
    }
    for comparison in comparisons:
        contingency[comparison["outcome_enforce"]][comparison["outcome_observe"]] += 1

    mode_summary: dict[str, Any] = {}
    for mode in SUPERKO_MODES:
        records = games[mode]
        focal_diagnostics = [
            action["diagnostics"]
            for record in records
            for action in record["actions"]
            if action["slot"] == "focal"
        ]
        completed_scores = [
            record["focal_score"]
            for record in records
            if record["focal_score"] is not None
        ]
        outcomes = {outcome: 0 for outcome in OUTCOMES}
        for record in records:
            outcome = "TRUNCATED" if record["truncated"] else record["winner"]
            outcomes[outcome] += 1
        mode_summary[mode] = {
            "games": len(records),
            "completed_games": len(completed_scores),
            "outcomes": outcomes,
            "focal_outcomes_completed": {
                "wins": sum(score == 1.0 for score in completed_scores),
                "draws": sum(score == 0.5 for score in completed_scores),
                "losses": sum(score == 0.0 for score in completed_scores),
            },
            "truncation_rate": _rate(
                sum(record["truncated"] for record in records), len(records)
            ),
            "trigger_game_rate": _rate(
                sum(record["triggered"] for record in records), len(records)
            ),
            "selected_repetition_game_rate": _rate(
                sum(record["selected_repetition"] for record in records), len(records)
            ),
            "trigger_states": sum(record["trigger_states"] for record in records),
            "selected_repetitions": sum(
                record["selected_repetitions"] for record in records
            ),
            "mean_plies": statistics.fmean(record["plies"] for record in records),
            "median_plies": statistics.median(record["plies"] for record in records),
            "mean_focal_score_completed_only": (
                statistics.fmean(completed_scores) if completed_scores else None
            ),
            "total_duration_seconds": sum(
                record["duration_seconds"] for record in records
            ),
            "mean_focal_decision_seconds_per_game": statistics.fmean(
                record["decision_seconds"]["focal"] for record in records
            ),
            "counterfactual_cycle_plans": sum(
                bool(diagnostic.get("counterfactual_cycle_plan_found"))
                for diagnostic in focal_diagnostics
            ),
            "cycle_search_fallbacks": sum(
                str(diagnostic.get("reason", "")).startswith("fallback_")
                for diagnostic in focal_diagnostics
            ),
        }

    complete_pairs = [
        comparison
        for comparison in comparisons
        if comparison["outcome_enforce"] != "TRUNCATED"
        and comparison["outcome_observe"] != "TRUNCATED"
    ]
    score_bootstrap = _hierarchical_pair_bootstrap(
        blocks,
        field="focal_score_observe_minus_enforce",
        seed=derive_seed(EXPERIMENT_VERSION, policy, grid_size, "score-bootstrap"),
        resamples=bootstrap_resamples,
    )
    plies_bootstrap = _hierarchical_pair_bootstrap(
        blocks,
        field="plies_observe_minus_enforce",
        seed=derive_seed(EXPERIMENT_VERSION, policy, grid_size, "plies-bootstrap"),
        resamples=bootstrap_resamples,
    )
    relative_plies_bootstrap = _hierarchical_relative_plies_bootstrap(
        blocks,
        seed=derive_seed(EXPERIMENT_VERSION, policy, grid_size, "relative-plies-bootstrap"),
        resamples=bootstrap_resamples,
    )
    truncation_bootstrap = _hierarchical_pair_bootstrap(
        blocks,
        field="truncation_observe_minus_enforce",
        seed=derive_seed(EXPERIMENT_VERSION, policy, grid_size, "truncation-bootstrap"),
        resamples=bootstrap_resamples,
    )
    score_ci = score_bootstrap["ci95"]
    relative_plies_ci = relative_plies_bootstrap["ci95"]
    truncation_ci = truncation_bootstrap["ci95"]
    observe_truncation_upper = mode_summary["observe"]["truncation_rate"][
        "ci95_wilson"
    ][1]
    gates = {
        "score_ci_inside_plus_minus_0_05": bool(
            score_ci is not None and score_ci[0] >= -0.05 and score_ci[1] <= 0.05
        ),
        "relative_plies_ci_inside_plus_minus_0_05": bool(
            relative_plies_ci is not None
            and relative_plies_ci[0] >= -0.05
            and relative_plies_ci[1] <= 0.05
        ),
        "truncation_difference_ci_inside_plus_minus_0_01": bool(
            truncation_ci is not None
            and truncation_ci[0] >= -0.01
            and truncation_ci[1] <= 0.01
        ),
        "observe_truncation_wilson_upper_below_0_01": (
            observe_truncation_upper < 0.01
        ),
    }
    gates["all_pass"] = all(gates.values())
    return {
        "policy": policy,
        "grid_size": grid_size,
        "independent_blocks": len(blocks),
        "master_seeds": sorted({block["master_seed"] for block in blocks}),
        "mode": mode_summary,
        "paired": {
            "orientation_pairs": len(comparisons),
            "trajectory_divergence_rate": _rate(
                sum(comparison["trajectory_diverged"] for comparison in comparisons),
                len(comparisons),
            ),
            "aligned_trigger_orientation_rate": _rate(
                sum(bool(comparison["aligned_trigger_plies"]) for comparison in comparisons),
                len(comparisons),
            ),
            "aligned_trigger_plies": sum(
                len(comparison["aligned_trigger_plies"]) for comparison in comparisons
            ),
            "divergence_at_aligned_trigger_rate": _rate(
                sum(
                    comparison["divergence_begins_at_aligned_trigger"]
                    for comparison in comparisons
                ),
                len(comparisons),
            ),
            "winner_agreement_complete_pairs": _rate(
                sum(comparison["outcome_agrees"] for comparison in complete_pairs),
                len(complete_pairs),
            ),
            "retained_complete_pair_rate": _rate(
                len(complete_pairs), len(comparisons)
            ),
            "nonzero_focal_score_difference_rate_complete_pairs": _rate(
                sum(
                    comparison["focal_score_observe_minus_enforce"] != 0.0
                    for comparison in complete_pairs
                ),
                len(complete_pairs),
            ),
            "outcome_contingency": contingency,
            "trigger_block_rate": _rate(
                sum(block["summary"]["any_trigger"] for block in blocks), len(blocks)
            ),
            "observe_selected_repetition_block_rate": _rate(
                sum(
                    block["summary"]["observe_selected_repetition"] for block in blocks
                ),
                len(blocks),
            ),
            "score_observe_minus_enforce_complete_pairs": score_bootstrap,
            "score_observe_minus_enforce_all_block_bounds": _score_bounds(blocks),
            "mean_plies_observe_minus_enforce": plies_bootstrap,
            "relative_mean_plies_observe_minus_enforce": relative_plies_bootstrap,
            "truncation_rate_observe_minus_enforce": truncation_bootstrap,
            "practical_similarity_gates": gates,
        },
        "per_seed": [
            {
                "master_seed": block["master_seed"],
                "block_index": block["block_index"],
                **block["summary"],
            }
            for block in blocks
        ],
    }


def _actions(raw: Iterable[list[int] | None]) -> tuple[Action, ...]:
    return tuple(None if action is None else (int(action[0]), int(action[1])) for action in raw)


def _positive_control() -> dict[str, Any]:
    witness = json.loads(WITNESS_PATH.read_text(encoding="utf-8"))
    prefix = _actions(witness["natural_prefix"]["actions"])
    loop = _actions(witness["witness_loop"]["actions"])
    candidate_raw = witness["candidate"]["action"]
    candidate = (int(candidate_raw[0]), int(candidate_raw[1]))

    enforce = LifelineGame(6, superko_mode="enforce")
    enforce.replay(prefix)
    enforce_before = enforce.clone()
    observe = LifelineGame(6, superko_mode="observe")
    observe.replay(prefix)

    def instrument_attempt(game: LifelineGame) -> tuple[dict[str, Any], Any]:
        repeats = tuple(game.would_violate_superko_moves())
        before_position = _position_sha256(game)
        before_full = _full_state_sha256(game)
        before_normalized = _mode_normalized_state_sha256(game)
        legal = [_action_index(game, action) for action in legal_actions(game)]
        actor = game.current_player
        result = game.play_move(candidate)
        return (
            {
                "ply": 0,
                "actor": actor.value,
                "slot": "fixture",
                "agent": "fixture-guided-forced-action",
                "decision_seed": None,
                "position_before_sha256": before_position,
                "full_state_before_sha256": before_full,
                "mode_normalized_state_before_sha256": before_normalized,
                "legal_actions": legal,
                "action": game.point_to_index[candidate],
                "point": list(candidate),
                "would_violate_superko_candidates": [
                    game.point_to_index[point] for point in repeats
                ],
                "selected_would_violate_superko": candidate in repeats,
                "result_success": result.success,
                "result_reason": result.reason,
                "result_would_violate_superko": result.would_violate_superko,
                "position_after_sha256": _position_sha256(game),
                "full_state_after_sha256": _full_state_sha256(game),
                "mode_normalized_state_after_sha256": _mode_normalized_state_sha256(game),
            },
            result,
        )

    enforce_record, enforce_result = instrument_attempt(enforce)
    observe_record, observe_result = instrument_attempt(observe)
    instrumentation_comparison = _compare_games(
        {
            "actions": [enforce_record],
            "truncated": True,
            "winner": None,
            "focal_score": None,
            "plies": 1,
        },
        {
            "actions": [observe_record],
            "truncated": True,
            "winner": None,
            "focal_score": None,
            "plies": 1,
        },
    )

    stage_count = int(witness["stage_5"]["prefix_action_count"])
    stage = LifelineGame(6, superko_mode="enforce")
    stage.replay(prefix[:stage_count])
    guided = check_fixture_guided_cycle(stage, loop)
    repeated = LifelineGame(6, superko_mode="observe")
    repeated.replay(prefix[:stage_count])
    repeated_stage_digest = _position_sha256(repeated)
    loop_end_digests: list[str] = []
    loop_end_repeat_flags: list[bool] = []
    for _ in range(2):
        final_loop_result = None
        for action in loop:
            final_loop_result = (
                repeated.skip_turn() if action is None else repeated.play_move(action)
            )
            if not final_loop_result.success:
                raise AssertionError("positive-control loop replay failed")
        assert final_loop_result is not None
        loop_end_digests.append(_position_sha256(repeated))
        loop_end_repeat_flags.append(final_loop_result.would_violate_superko)
    passed = (
        not enforce_result.success
        and enforce_result.reason == "SUPERKO_VIOLATION"
        and enforce_result.would_violate_superko
        and enforce.clone() == enforce_before
        and observe_result.success
        and observe_result.would_violate_superko
        and guided.valid
        and guided.closes_root_position
        and all(digest == repeated_stage_digest for digest in loop_end_digests)
        and all(loop_end_repeat_flags)
        and enforce_record["selected_would_violate_superko"]
        and observe_record["selected_would_violate_superko"]
        and instrumentation_comparison["first_aligned_trigger_ply"] == 0
        and instrumentation_comparison["first_position_divergence_after_ply"] == 0
    )
    if not passed:
        raise AssertionError("frozen Superko positive control failed")
    return {
        "classification": "fixture_guided_positive_control_not_generic_policy_result",
        "passed": True,
        "witness_path": str(WITNESS_PATH.resolve()),
        "witness_sha256": sha256_file(WITNESS_PATH),
        "grid_size": 6,
        "natural_prefix_transitions": len(prefix),
        "loop_transitions": len(loop),
        "candidate": list(candidate),
        "enforce": {
            "success": enforce_result.success,
            "reason": enforce_result.reason,
            "would_violate_superko": enforce_result.would_violate_superko,
            "transactional_state_unchanged": enforce.clone() == enforce_before,
        },
        "observe": {
            "success": observe_result.success,
            "reason": observe_result.reason,
            "would_violate_superko": observe_result.would_violate_superko,
        },
        "guided_loop": asdict(guided),
        "observe_two_loop_replay": {
            "stage_rule_position_sha256": repeated_stage_digest,
            "loop_end_rule_position_sha256": loop_end_digests,
            "closing_actions_flagged_repeat": loop_end_repeat_flags,
            "successful_transitions": 2 * len(loop),
        },
        "instrumentation": {
            "enforce_attempt": enforce_record,
            "observe_attempt": observe_record,
            "comparison": instrumentation_comparison,
        },
    }


def _source_hashes() -> dict[str, str]:
    paths = (
        Path(__file__).resolve(),
        ROOT / "SUPERKO_POLICY_MATRIX_PROTOCOL.md",
        WITNESS_PATH,
        *sorted((ROOT / "lifeline_rl").rglob("*.py")),
    )
    return {str(path.relative_to(ROOT)): sha256_file(path) for path in paths if path.is_file()}


def _resolved_formal_config(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "sizes": list(args.sizes),
        "policies": list(args.policies),
        "seeds": list(args.seeds),
        "blocks_per_seed": args.blocks_per_seed,
        "max_plies": args.max_plies,
        "minimax_move_cap": args.minimax_move_cap,
        "mcts_simulations": args.mcts_simulations,
        "mcts_rollout_depth": args.mcts_rollout_depth,
        "mcts_exploration": args.mcts_exploration,
        "cycle_max_depth": args.cycle_max_depth,
        "cycle_branch_limit": args.cycle_branch_limit,
        "cycle_node_budget": args.cycle_node_budget,
        "rl_simulations": args.rl_simulations,
        "rl_c_puct": args.rl_c_puct,
        "rl_device": args.rl_device,
        "bootstrap_resamples": args.bootstrap_resamples,
    }


def _validate_formal_args(args: argparse.Namespace) -> None:
    observed = _resolved_formal_config(args)
    if observed != FORMAL_CONFIG:
        differing = {
            key: {"expected": FORMAL_CONFIG[key], "observed": observed[key]}
            for key in FORMAL_CONFIG
            if observed[key] != FORMAL_CONFIG[key]
        }
        raise ValueError(f"five_seed_extension config is not frozen: {differing}")
    if args.checkpoint.resolve() != DEFAULT_CHECKPOINT.resolve():
        raise ValueError("five_seed_extension requires the frozen Topology checkpoint path")
    if not args.allow_checkpoint_source_migration:
        raise ValueError("five_seed_extension requires the explicit source-migration waiver")
    if args.output is None:
        raise ValueError("five_seed_extension requires --output for the full raw artifact")
    if args.output.exists():
        raise FileExistsError(f"formal output already exists: {args.output.resolve()}")
    journal = args.output.with_suffix(args.output.suffix + ".blocks.jsonl")
    if journal.exists():
        raise FileExistsError(f"formal append-only journal already exists: {journal.resolve()}")


def _validate_formal_manifest(
    manifest_path: Path,
    *,
    source_hashes: dict[str, str],
) -> dict[str, Any]:
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"cannot read formal manifest: {manifest_path}") from exc
    if manifest.get("schema_version") != 1 or manifest.get("experiment") != EXPERIMENT_VERSION:
        raise RuntimeError("formal manifest schema/experiment mismatch")
    if manifest.get("formal_config") != FORMAL_CONFIG:
        raise RuntimeError("formal manifest config does not match frozen runner config")
    if manifest.get("source_sha256") != source_hashes:
        missing = sorted(set(manifest.get("source_sha256", {})) - set(source_hashes))
        extra = sorted(set(source_hashes) - set(manifest.get("source_sha256", {})))
        changed = sorted(
            key
            for key in set(source_hashes) & set(manifest.get("source_sha256", {}))
            if source_hashes[key] != manifest["source_sha256"][key]
        )
        raise RuntimeError(
            f"formal source freeze mismatch: missing={missing}, extra={extra}, changed={changed}"
        )
    expected_checkpoint = {
        "path": str(DEFAULT_CHECKPOINT.resolve()),
        "sha256": EXPECTED_CHECKPOINT_SHA256,
        "config_hash": EXPECTED_CHECKPOINT_CONFIG_HASH,
        "source_hash": EXPECTED_CHECKPOINT_SOURCE_HASH,
    }
    if manifest.get("checkpoint") != expected_checkpoint:
        raise RuntimeError("formal manifest checkpoint identity mismatch")
    return manifest


def _torch_runtime(device: str) -> dict[str, Any] | None:
    try:
        import torch
    except ImportError:
        return None
    resolved = torch.device(device)
    details: dict[str, Any] = {
        "torch": torch.__version__,
        "requested_device": device,
        "resolved_device": str(resolved),
        "cuda_available": torch.cuda.is_available(),
        "cuda_version": torch.version.cuda,
    }
    if resolved.type == "cuda" and torch.cuda.is_available():
        index = torch.cuda.current_device() if resolved.index is None else resolved.index
        properties = torch.cuda.get_device_properties(index)
        details["cuda_device"] = {
            "index": index,
            "name": properties.name,
            "total_memory_bytes": properties.total_memory,
        }
    return details


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--purpose", choices=("dry_run", "five_seed_extension"), default="dry_run")
    parser.add_argument("--sizes", type=int, nargs="+", default=[6, 7])
    parser.add_argument("--policies", choices=POLICIES, nargs="+", default=list(POLICIES))
    parser.add_argument("--seeds", type=int, nargs="+", default=None)
    parser.add_argument("--blocks-per-seed", type=int, default=1)
    parser.add_argument("--max-plies", type=int, default=120)
    parser.add_argument("--minimax-move-cap", type=int, default=20)
    parser.add_argument("--mcts-simulations", type=int, default=16)
    parser.add_argument("--mcts-rollout-depth", type=int, default=24)
    parser.add_argument("--mcts-exploration", type=float, default=2**0.5)
    parser.add_argument("--cycle-max-depth", type=int, default=4)
    parser.add_argument("--cycle-branch-limit", type=int, default=5)
    parser.add_argument("--cycle-node-budget", type=int, default=1_000)
    parser.add_argument("--checkpoint", type=Path, default=DEFAULT_CHECKPOINT)
    parser.add_argument("--rl-simulations", type=int, default=4)
    parser.add_argument("--rl-c-puct", type=float, default=1.5)
    parser.add_argument("--rl-device", default="cpu")
    parser.add_argument("--allow-checkpoint-source-migration", action="store_true")
    parser.add_argument("--bootstrap-resamples", type=int, default=10_000)
    parser.add_argument("--formal-manifest", type=Path, default=FORMAL_MANIFEST_PATH)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--summary-only", action="store_true")
    parser.add_argument("--progress", action="store_true")
    args = parser.parse_args()

    if args.seeds is None:
        args.seeds = list(NEW_SEEDS if args.purpose == "five_seed_extension" else (DRY_RUN_SEED,))
    if args.purpose == "five_seed_extension" and tuple(args.seeds) != NEW_SEEDS:
        parser.error("five_seed_extension requires the exact frozen NEW_SEEDS sequence")
    if args.purpose != "five_seed_extension" and set(args.seeds) & set(NEW_SEEDS):
        parser.error("dry_run must not consume any frozen five-seed root")
    if len(set(args.seeds)) != len(args.seeds):
        parser.error("--seeds must not contain duplicates")
    if len(set(args.sizes)) != len(args.sizes) or any(size not in range(5, 16) for size in args.sizes):
        parser.error("--sizes must be unique values in [5,15]")
    if len(set(args.policies)) != len(args.policies):
        parser.error("--policies must not contain duplicates")
    for name in (
        "blocks_per_seed",
        "max_plies",
        "minimax_move_cap",
        "mcts_simulations",
        "cycle_max_depth",
        "cycle_branch_limit",
        "cycle_node_budget",
        "rl_simulations",
        "bootstrap_resamples",
    ):
        if getattr(args, name) < 1:
            parser.error(f"--{name.replace('_', '-')} must be positive")
    if args.mcts_rollout_depth < 0:
        parser.error("--mcts-rollout-depth must be non-negative")
    if "frozen-rl" in args.policies and not args.allow_checkpoint_source_migration:
        parser.error(
            "frozen-rl requires the explicit --allow-checkpoint-source-migration waiver"
        )
    if args.purpose == "five_seed_extension":
        try:
            _validate_formal_args(args)
        except (FileExistsError, ValueError) as exc:
            parser.error(str(exc))
    return args


def _write_journal_event(handle: Any, event: dict[str, Any]) -> None:
    handle.write(
        json.dumps(event, ensure_ascii=False, sort_keys=True, allow_nan=False) + "\n"
    )
    handle.flush()


def main() -> int:
    args = parse_args()
    if tuple(frozen_seed(index) for index in range(5)) != NEW_SEEDS:
        raise AssertionError("frozen seed derivation no longer matches NEW_SEEDS")
    started = time.perf_counter()
    source_hashes_start = _source_hashes()
    formal = args.purpose == "five_seed_extension"
    formal_manifest: dict[str, Any] | None = None
    attempt_id = (
        datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        + "_"
        + hashlib.sha256(
            json.dumps(_resolved_formal_config(args), sort_keys=True).encode("utf-8")
        ).hexdigest()[:12]
    )
    journal_handle = None
    journal_path = None
    if formal:
        formal_manifest = _validate_formal_manifest(
            args.formal_manifest.resolve(), source_hashes=source_hashes_start
        )
        assert args.output is not None
        args.output.parent.mkdir(parents=True, exist_ok=True)
        journal_path = args.output.with_suffix(args.output.suffix + ".blocks.jsonl")
        journal_handle = journal_path.open("x", encoding="utf-8", newline="\n")
        _write_journal_event(
            journal_handle,
            {
                "event": "attempt_started",
                "attempt_id": attempt_id,
                "experiment": EXPERIMENT_VERSION,
                "purpose": args.purpose,
                "formal_config": _resolved_formal_config(args),
                "formal_manifest": str(args.formal_manifest.resolve()),
                "formal_manifest_sha256": sha256_file(args.formal_manifest.resolve()),
                "started_at_utc": datetime.now(timezone.utc).isoformat(),
            },
        )

    try:
        frozen_rl_agent = None
        rl_metadata = None
        if "frozen-rl" in args.policies:
            frozen_rl_agent, rl_metadata = _load_frozen_rl_agent(args)

        conditions: list[dict[str, Any]] = []
        total = len(args.policies) * len(args.sizes) * len(args.seeds) * args.blocks_per_seed
        completed = 0
        for policy in args.policies:
            for grid_size in args.sizes:
                blocks: list[dict[str, Any]] = []
                for master_seed in args.seeds:
                    for block_index in range(args.blocks_per_seed):
                        block = _run_block(
                            policy=policy,
                            grid_size=grid_size,
                            master_seed=master_seed,
                            block_index=block_index,
                            args=args,
                            frozen_rl_agent=frozen_rl_agent,
                        )
                        blocks.append(block)
                        completed += 1
                        if journal_handle is not None:
                            _write_journal_event(
                                journal_handle,
                                {
                                    "event": "block_completed",
                                    "attempt_id": attempt_id,
                                    "ordinal": completed,
                                    "blocks_total": total,
                                    "policy": policy,
                                    "grid_size": grid_size,
                                    "master_seed": master_seed,
                                    "block_index": block_index,
                                    "block": block,
                                },
                            )
                        if args.progress:
                            print(
                                json.dumps(
                                    {
                                        "policy": policy,
                                        "grid_size": grid_size,
                                        "blocks_completed": completed,
                                        "blocks_total": total,
                                    },
                                    sort_keys=True,
                                ),
                                file=sys.stderr,
                                flush=True,
                            )
                conditions.append(
                    {
                        "policy": policy,
                        "grid_size": grid_size,
                        "summary": _summarize_condition(
                            blocks,
                            policy=policy,
                            grid_size=grid_size,
                            bootstrap_resamples=args.bootstrap_resamples,
                        ),
                        "blocks": blocks,
                    }
                )

        source_hashes_end = _source_hashes()
        if source_hashes_end != source_hashes_start:
            changed = sorted(
                key
                for key in set(source_hashes_start) | set(source_hashes_end)
                if source_hashes_start.get(key) != source_hashes_end.get(key)
            )
            raise RuntimeError(f"source files changed during the run: {changed}")

        report = {
            "schema_version": 1,
            "experiment": EXPERIMENT_VERSION,
            "purpose": args.purpose,
            "attempt_id": attempt_id,
            "claim_boundary": CLAIM_BOUNDARY,
            "config": {
                "sizes": args.sizes,
                "policies": args.policies,
                "master_seeds": args.seeds,
                "frozen_seed_derivation": (
                    'sha256("superko-policy-matrix-v1|i")[:4] & 0x7fffffff, i=0..4'
                ),
                "uses_exact_frozen_seed_set": tuple(args.seeds) == NEW_SEEDS,
                "blocks_per_seed": args.blocks_per_seed,
                "games_per_block": 4,
                "pairing": "enforce/observe x focal BLACK/WHITE",
                "opponent": "canonical keyed-priority uniform Random",
                "decision_seed": (
                    "SHA-256(version, master_seed, block, n, policy, orientation, "
                    "slot, actor, paired_ply), recreated at every decision"
                ),
                "max_plies": args.max_plies,
                "minimax": {"depth": 2, "move_cap": args.minimax_move_cap},
                "mcts": {
                    "simulations": args.mcts_simulations,
                    "rollout_depth": args.mcts_rollout_depth,
                    "exploration": args.mcts_exploration,
                },
                "cycle_seeking": {
                    "max_depth": args.cycle_max_depth,
                    "branch_limit": args.cycle_branch_limit,
                    "node_budget": args.cycle_node_budget,
                    "fallback": "random",
                },
                "frozen_rl": {
                    "requested": "frozen-rl" in args.policies,
                    "checkpoint": str(args.checkpoint.resolve()),
                    "simulations": args.rl_simulations,
                    "c_puct": args.rl_c_puct,
                    "temperature": 0.0,
                    "root_noise": False,
                    "device": args.rl_device,
                    "metadata": rl_metadata,
                },
                "bootstrap_resamples": args.bootstrap_resamples,
                "truncation_scoring": (
                    "never imputed; completed-only estimate plus [0,1] bounds"
                ),
                "source_sha256": source_hashes_start,
                "formal_manifest": (
                    None
                    if formal_manifest is None
                    else {
                        "path": str(args.formal_manifest.resolve()),
                        "sha256": sha256_file(args.formal_manifest.resolve()),
                    }
                ),
            },
            "positive_control": _positive_control(),
            "runtime": {
                "python": sys.version,
                "platform": platform.platform(),
                "torch": _torch_runtime(args.rl_device),
                "duration_seconds": time.perf_counter() - started,
            },
            "conditions": conditions,
        }
        rendered = json.dumps(
            report, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False
        )
        if args.output is not None:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            if formal:
                with args.output.open("x", encoding="utf-8", newline="\n") as handle:
                    handle.write(rendered + "\n")
            else:
                args.output.write_text(rendered + "\n", encoding="utf-8")
        if journal_handle is not None:
            _write_journal_event(
                journal_handle,
                {
                    "event": "attempt_completed",
                    "attempt_id": attempt_id,
                    "blocks_completed": completed,
                    "blocks_total": total,
                    "output": str(args.output.resolve()),
                    "output_sha256": hashlib.sha256((rendered + "\n").encode("utf-8")).hexdigest(),
                    "completed_at_utc": datetime.now(timezone.utc).isoformat(),
                },
            )
    except BaseException as exc:
        if journal_handle is not None:
            _write_journal_event(
                journal_handle,
                {
                    "event": "attempt_failed",
                    "attempt_id": attempt_id,
                    "error_type": type(exc).__name__,
                    "error": str(exc),
                    "failed_at_utc": datetime.now(timezone.utc).isoformat(),
                },
            )
        raise
    finally:
        if journal_handle is not None:
            journal_handle.close()

    printed = report
    if args.summary_only:
        printed = {
            **report,
            "conditions": [
                {key: value for key, value in condition.items() if key != "blocks"}
                for condition in conditions
            ],
        }
    print(json.dumps(printed, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
