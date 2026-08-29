"""Color-balanced, replayable arena for non-learning and learned agents."""

from __future__ import annotations

import csv
import json
import math
import random
import statistics
import time
from dataclasses import asdict, dataclass, is_dataclass
from pathlib import Path
from typing import Any

from .agents import Action, Agent
from .core import LifelineGame, Player


class IllegalAgentActionError(RuntimeError):
    pass


@dataclass(frozen=True)
class PlyRecord:
    ply: int
    actor: Player
    action: int
    point: tuple[int, int] | None
    decision_seconds: float
    diagnostics: dict[str, object]

    def to_dict(self) -> dict[str, object]:
        return {
            "ply": self.ply,
            "actor": self.actor.value,
            "action": self.action,
            "point": None if self.point is None else list(self.point),
            "decision_seconds": self.decision_seconds,
            "diagnostics": self.diagnostics,
        }


@dataclass(frozen=True)
class GameRecord:
    game_index: int
    pair_index: int
    grid_size: int
    superko_mode: str
    seed: int
    black_slot: str
    white_slot: str
    black_agent: str
    white_agent: str
    black_policy_seed: int
    white_policy_seed: int
    winner: Player | str | None
    truncated: bool
    plies: int
    duration_seconds: float
    territories: dict[str, int] | None
    actions: tuple[PlyRecord, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "game_index": self.game_index,
            "pair_index": self.pair_index,
            "grid_size": self.grid_size,
            "superko_mode": self.superko_mode,
            "seed": self.seed,
            "black_slot": self.black_slot,
            "white_slot": self.white_slot,
            "black_agent": self.black_agent,
            "white_agent": self.white_agent,
            "black_policy_seed": self.black_policy_seed,
            "white_policy_seed": self.white_policy_seed,
            "winner": self.winner.value if isinstance(self.winner, Player) else self.winner,
            "truncated": self.truncated,
            "plies": self.plies,
            "duration_seconds": self.duration_seconds,
            "territories": self.territories,
            "actions": [action.to_dict() for action in self.actions],
        }


@dataclass(frozen=True)
class MatchupResult:
    summary: dict[str, Any]
    games: tuple[GameRecord, ...]


def _agent_metadata(agent: Agent) -> dict[str, object]:
    metadata: dict[str, object] = {
        "name": agent.name,
        "class": f"{agent.__class__.__module__}.{agent.__class__.__qualname__}",
    }
    config = getattr(agent, "config", None)
    if config is not None and is_dataclass(config):
        metadata["config"] = asdict(config)
    return metadata


def _apply_action(game: LifelineGame, action: Action) -> None:
    result = game.skip_turn() if action is None else game.play_move(action)
    if not result.success:
        raise IllegalAgentActionError(f"agent selected {action!r}: {result.reason}")


def replay_game_record(record: GameRecord | dict[str, Any]) -> LifelineGame:
    """Replay and validate a persisted arena record."""

    data = record.to_dict() if isinstance(record, GameRecord) else record
    superko_mode = data.get("superko_mode", "enforce")
    if superko_mode not in {"enforce", "observe"}:
        raise ValueError("record has an invalid Superko mode")
    game = LifelineGame(int(data["grid_size"]), superko_mode=superko_mode)
    actions = data["actions"]
    for expected_ply, entry in enumerate(actions):
        if game.game_over:
            raise ValueError(f"record contains actions after terminal ply {expected_ply}")
        if int(entry["ply"]) != expected_ply:
            raise ValueError(f"non-contiguous ply index at {expected_ply}")
        if entry["actor"] != game.current_player.value:
            raise ValueError(f"actor mismatch at ply {expected_ply}")
        point = None if entry["point"] is None else tuple(entry["point"])
        action_index = game.num_points if point is None else game.point_to_index.get(point)
        if action_index is None or action_index != int(entry["action"]):
            raise ValueError(f"action mapping mismatch at ply {expected_ply}")
        _apply_action(game, point)

    truncated = bool(data["truncated"])
    if truncated and game.game_over:
        raise ValueError("record labels a terminal game as truncated")
    if not truncated and not game.game_over:
        raise ValueError("record ends before the game is terminal")
    if not truncated:
        winner = game.winner()
        winner_value = winner.value if isinstance(winner, Player) else winner
        if winner_value != data["winner"]:
            raise ValueError("winner mismatch after replay")
        territories = {
            player.value: game.cached_territories[player].area
            for player in (Player.BLACK, Player.WHITE)
        }
        if territories != data["territories"]:
            raise ValueError("territory mismatch after replay")
    return game


def play_game(
    black_agent: Agent,
    white_agent: Agent,
    *,
    grid_size: int,
    seed: int,
    max_plies: int,
    game_index: int = 0,
    pair_index: int = 0,
    black_slot: str = "A",
    white_slot: str = "B",
    black_policy_seed: int | None = None,
    white_policy_seed: int | None = None,
    superko_mode: str = "enforce",
) -> GameRecord:
    if max_plies < 1:
        raise ValueError("max_plies must be at least 1")
    black_seed = seed * 2 + 1 if black_policy_seed is None else black_policy_seed
    white_seed = seed * 2 + 2 if white_policy_seed is None else white_policy_seed
    policy_rng = {
        Player.BLACK: random.Random(black_seed),
        Player.WHITE: random.Random(white_seed),
    }
    agents = {Player.BLACK: black_agent, Player.WHITE: white_agent}
    game = LifelineGame(grid_size, superko_mode=superko_mode)
    actions: list[PlyRecord] = []
    started = time.perf_counter()

    while not game.game_over and len(actions) < max_plies:
        actor = game.current_player
        agent = agents[actor]
        snapshot = game.clone()
        decision_started = time.perf_counter()
        action = agent.select_action(game, policy_rng[actor])
        decision_seconds = time.perf_counter() - decision_started
        if game.clone() != snapshot:
            raise RuntimeError(f"agent {agent.name!r} mutated the arena game during selection")
        if action is not None and action not in game.point_to_index:
            raise IllegalAgentActionError(f"agent {agent.name!r} returned invalid point {action!r}")
        action_index = game.num_points if action is None else game.point_to_index[action]
        _apply_action(game, action)
        actions.append(
            PlyRecord(
                ply=len(actions),
                actor=actor,
                action=action_index,
                point=action,
                decision_seconds=decision_seconds,
                diagnostics=dict(agent.diagnostics()),
            )
        )

    duration = time.perf_counter() - started
    truncated = not game.game_over
    winner = None if truncated else game.winner()
    territories = None
    if game.game_over:
        territories = {
            player.value: game.cached_territories[player].area
            for player in (Player.BLACK, Player.WHITE)
        }
    return GameRecord(
        game_index=game_index,
        pair_index=pair_index,
        grid_size=grid_size,
        superko_mode=superko_mode,
        seed=seed,
        black_slot=black_slot,
        white_slot=white_slot,
        black_agent=black_agent.name,
        white_agent=white_agent.name,
        black_policy_seed=black_seed,
        white_policy_seed=white_seed,
        winner=winner,
        truncated=truncated,
        plies=len(actions),
        duration_seconds=duration,
        territories=territories,
        actions=tuple(actions),
    )


def _score_ci95_wilson(scores: list[float]) -> list[float] | None:
    """Wilson interval using draws as half-successes (descriptive, not final inference)."""

    if not scores:
        return None
    count = len(scores)
    proportion = statistics.fmean(scores)
    z = 1.96
    denominator = 1.0 + z * z / count
    center = (proportion + z * z / (2.0 * count)) / denominator
    margin = (
        z
        * math.sqrt(
            proportion * (1.0 - proportion) / count
            + z * z / (4.0 * count * count)
        )
        / denominator
    )
    return [max(0.0, center - margin), min(1.0, center + margin)]


def run_matchup(
    agent_a: Agent,
    agent_b: Agent,
    *,
    games: int,
    grid_size: int,
    base_seed: int = 0,
    max_plies: int = 200,
    superko_mode: str = "enforce",
) -> MatchupResult:
    if games < 2 or games % 2:
        raise ValueError("games must be a positive even number of at least 2")

    records: list[GameRecord] = []
    for pair_index in range(games // 2):
        pair_seed = base_seed + pair_index
        seed_a = pair_seed * 2 + 10_001
        seed_b = pair_seed * 2 + 20_001
        records.append(
            play_game(
                agent_a,
                agent_b,
                grid_size=grid_size,
                seed=pair_seed,
                max_plies=max_plies,
                game_index=len(records),
                pair_index=pair_index,
                black_slot="A",
                white_slot="B",
                black_policy_seed=seed_a,
                white_policy_seed=seed_b,
                superko_mode=superko_mode,
            )
        )
        records.append(
            play_game(
                agent_b,
                agent_a,
                grid_size=grid_size,
                seed=pair_seed,
                max_plies=max_plies,
                game_index=len(records),
                pair_index=pair_index,
                black_slot="B",
                white_slot="A",
                black_policy_seed=seed_b,
                white_policy_seed=seed_a,
                superko_mode=superko_mode,
            )
        )

    wins = losses = draws = truncated = 0
    scores: list[float] = []
    a_as_black = {"wins": 0, "losses": 0, "draws": 0, "truncated": 0}
    a_as_white = {"wins": 0, "losses": 0, "draws": 0, "truncated": 0}
    for record in records:
        color_stats = a_as_black if record.black_slot == "A" else a_as_white
        if record.truncated:
            truncated += 1
            color_stats["truncated"] += 1
            continue
        if record.winner == "DRAW":
            draws += 1
            scores.append(0.5)
            color_stats["draws"] += 1
            continue
        a_color = Player.BLACK if record.black_slot == "A" else Player.WHITE
        if record.winner is a_color:
            wins += 1
            scores.append(1.0)
            color_stats["wins"] += 1
        else:
            losses += 1
            scores.append(0.0)
            color_stats["losses"] += 1

    completed = len(scores)
    score_rate = statistics.fmean(scores) if scores else None
    elo_difference = None
    if score_rate is not None and 0.0 < score_rate < 1.0:
        elo_difference = 400.0 * math.log10(score_rate / (1.0 - score_rate))
    a_decisions = [
        action.decision_seconds
        for record in records
        for action in record.actions
        if (record.black_slot == "A" and action.actor is Player.BLACK)
        or (record.white_slot == "A" and action.actor is Player.WHITE)
    ]
    b_decisions = [
        action.decision_seconds
        for record in records
        for action in record.actions
        if (record.black_slot == "B" and action.actor is Player.BLACK)
        or (record.white_slot == "B" and action.actor is Player.WHITE)
    ]
    summary = {
        "schema_version": 1,
        "agent_a": agent_a.name,
        "agent_b": agent_b.name,
        "agent_a_metadata": _agent_metadata(agent_a),
        "agent_b_metadata": _agent_metadata(agent_b),
        "grid_size": grid_size,
        "superko_mode": superko_mode,
        "games_requested": games,
        "games_completed": completed,
        "truncated_games": truncated,
        "a_wins": wins,
        "a_losses": losses,
        "draws": draws,
        "a_score_rate": score_rate,
        "a_score_ci95_wilson": _score_ci95_wilson(scores),
        "a_elo_difference": elo_difference,
        "a_as_black": a_as_black,
        "a_as_white": a_as_white,
        "average_plies": statistics.fmean(record.plies for record in records),
        "a_mean_decision_seconds": statistics.fmean(a_decisions) if a_decisions else None,
        "b_mean_decision_seconds": statistics.fmean(b_decisions) if b_decisions else None,
        "total_duration_seconds": sum(record.duration_seconds for record in records),
        "base_seed": base_seed,
        "max_plies": max_plies,
    }
    return MatchupResult(summary=summary, games=tuple(records))


def write_matchup(
    result: MatchupResult,
    output_directory: str | Path,
    *,
    overwrite: bool = False,
) -> dict[str, Path]:
    output = Path(output_directory)
    output.mkdir(parents=True, exist_ok=True)
    summary_path = output / "summary.json"
    games_path = output / "games.jsonl"
    csv_path = output / "games.csv"
    existing = [path for path in (summary_path, games_path, csv_path) if path.exists()]
    if existing and not overwrite:
        raise FileExistsError(
            "refusing to overwrite arena artifacts: "
            + ", ".join(str(path) for path in existing)
        )
    summary_path.write_text(
        json.dumps(result.summary, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    games_path.write_text(
        "".join(
            json.dumps(record.to_dict(), ensure_ascii=False) + "\n"
            for record in result.games
        ),
        encoding="utf-8",
    )
    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=(
                "game_index",
                "pair_index",
                "seed",
                "grid_size",
                "superko_mode",
                "black_slot",
                "white_slot",
                "black_agent",
                "white_agent",
                "winner",
                "truncated",
                "plies",
                "duration_seconds",
                "black_area",
                "white_area",
            ),
        )
        writer.writeheader()
        for record in result.games:
            writer.writerow(
                {
                    "game_index": record.game_index,
                    "pair_index": record.pair_index,
                    "seed": record.seed,
                    "grid_size": record.grid_size,
                    "superko_mode": record.superko_mode,
                    "black_slot": record.black_slot,
                    "white_slot": record.white_slot,
                    "black_agent": record.black_agent,
                    "white_agent": record.white_agent,
                    "winner": (
                        record.winner.value if isinstance(record.winner, Player) else record.winner
                    ),
                    "truncated": record.truncated,
                    "plies": record.plies,
                    "duration_seconds": record.duration_seconds,
                    "black_area": (
                        record.territories["BLACK"] if record.territories is not None else ""
                    ),
                    "white_area": (
                        record.territories["WHITE"] if record.territories is not None else ""
                    ),
                }
            )
    return {"summary": summary_path, "games": games_path, "csv": csv_path}
