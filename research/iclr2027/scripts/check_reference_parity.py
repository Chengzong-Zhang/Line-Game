"""Differentially compare Python transitions with the Web GameEngine."""

from __future__ import annotations

import argparse
import json
import random
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = ROOT.parents[1]
sys.path.insert(0, str(ROOT))

from lifeline_rl import LifelineGame, Player  # noqa: E402


ALIAS_FIXTURE = json.loads(
    (ROOT / "tests" / "fixtures" / "aliasing_pair.json").read_text(encoding="utf-8")
)
HISTORY_A = [tuple(point) for point in ALIAS_FIXTURE["histories"]["A"]]
HISTORY_B = [tuple(point) for point in ALIAS_FIXTURE["histories"]["B"]]


def edge_key(game: LifelineGame, edge: tuple[int, int]) -> str:
    points = game.edge_points(edge)
    keys = [f"{point[0]},{point[1]}" for point in points]
    keys.sort()
    return "|".join(keys)


def python_state(game: LifelineGame, result: Any = None) -> dict[str, Any]:
    if result is None:
        result = type("InitialResult", (), {"success": True, "reason": None})()
    # Match GameEngine.getSnapshot(): the reference reports geometric legal
    # moves even after gameOver, while the RL wrapper masks every terminal action.
    legal_moves = [list(point) for point in game.legal_moves()]
    winner = game.winner()
    return {
        "result": {"success": result.success, "reason": result.reason},
        "board": game.grid.copy(),
        "current_player": game.current_player.value,
        "game_over": game.game_over,
        "consecutive_skips": game.consecutive_skips,
        "turn_count": game.turn_count,
        "edges": {
            player.value: sorted(edge_key(game, edge) for edge in game.edges[player])
            for player in (Player.BLACK, Player.WHITE)
        },
        "legal_moves": legal_moves,
        "territories": {
            player.value: {
                "area": game.cached_territories[player].area,
                "display_area": game.cached_territories[player].display_area,
            }
            for player in (Player.BLACK, Player.WHITE)
        },
        "winner": winner.value if isinstance(winner, Player) else winner,
    }


def python_trace(grid_size: int, actions: list[tuple[int, int] | None]) -> list[dict[str, Any]]:
    game = LifelineGame(grid_size)
    trace = [python_state(game)]
    for action in actions:
        result = game.skip_turn() if action is None else game.play_move(action)
        trace.append(python_state(game, result))
    return trace


def web_trace(grid_size: int, actions: list[tuple[int, int] | None]) -> list[dict[str, Any]]:
    payload = json.dumps({"grid_size": grid_size, "actions": actions})
    completed = subprocess.run(
        ["node", str(ROOT / "scripts" / "reference_trace.mjs")],
        input=payload,
        text=True,
        capture_output=True,
        check=False,
        cwd=REPOSITORY,
    )
    if completed.returncode != 0:
        raise RuntimeError(f"Node reference failed:\n{completed.stderr}")
    return json.loads(completed.stdout)


def compare_trace(name: str, grid_size: int, actions: list[tuple[int, int] | None]) -> None:
    python = python_trace(grid_size, actions)
    web = web_trace(grid_size, actions)
    if len(python) != len(web):
        raise AssertionError(f"{name}: trace length differs")
    for ply, (python_step, web_step) in enumerate(zip(python, web)):
        # The training core intentionally computes exact territory only at terminal.
        if not python_step["game_over"]:
            python_step = dict(python_step)
            web_step = dict(web_step)
            python_step.pop("territories")
            web_step.pop("territories")
        if python_step != web_step:
            raise AssertionError(
                f"{name}: mismatch after ply {ply}\n"
                f"python={json.dumps(python_step, ensure_ascii=False, sort_keys=True)}\n"
                f"web={json.dumps(web_step, ensure_ascii=False, sort_keys=True)}"
            )


def generate_random_trace(grid_size: int, seed: int, max_plies: int) -> list[tuple[int, int] | None]:
    rng = random.Random(seed)
    game = LifelineGame(grid_size)
    actions: list[tuple[int, int] | None] = []
    for ply in range(max_plies):
        if game.game_over:
            break
        legal = game.legal_moves()
        action = None if ply > 0 and ply % 13 == 0 else rng.choice(legal)
        actions.append(action)
        result = game.skip_turn() if action is None else game.play_move(action)
        if not result.success:
            raise AssertionError(f"trace generator produced illegal action: {action}")
    if not game.game_over:
        actions.extend([None, None])
    return actions


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--random-games", type=int, default=4)
    parser.add_argument("--max-plies", type=int, default=40)
    parser.add_argument("--seed", type=int, default=20260825)
    args = parser.parse_args()

    fixtures = [
        ("opening", 5, [(0, 3), (0, 4), (2, 1), None, None]),
        ("cascade-delete-and-edge-restore", 5, HISTORY_A[:6] + [(2, 2)]),
        ("line-cut-without-node-deletion", 5, HISTORY_A[:9] + [(1, 1)]),
        ("state-alias-A", 5, HISTORY_A + [(0, 4), None]),
        ("state-alias-B", 5, HISTORY_B + [(0, 4), None]),
    ]
    for name, size, actions in fixtures:
        compare_trace(name, size, actions)

    for index in range(args.random_games):
        size = (5, 7, 9, 10, 12, 15)[index % 6]
        actions = generate_random_trace(size, args.seed + index, args.max_plies)
        compare_trace(f"random-{index}-n{size}", size, actions)

    print(f"PASS: {len(fixtures) + args.random_games} Python/Web traces matched")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
