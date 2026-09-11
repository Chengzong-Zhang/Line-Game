"""Rebuild the three static paper figures from frozen artifacts.

The script performs assertion checks before drawing so that a plot cannot
silently drift from the accepted side-five witness or the formal aggregate
tables.
"""

from __future__ import annotations

import csv
import json
import math
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap
from matplotlib.lines import Line2D
import numpy as np

from lifeline_rl.core import LifelineGame, Player, PointState


ROOT = Path(__file__).resolve().parents[1]
FIGURE_DIR = ROOT / "paper" / "figures"
AGGREGATE_DIR = ROOT / "results" / "formal" / "d14_d16" / "aggregate_v1"

MODEL_ORDER = ["grid_gnn", "padded_cnn", "topology_gnn"]
MODEL_LABELS = {
    "grid_gnn": "Grid-GNN",
    "padded_cnn": "Padded-CNN",
    "topology_gnn": "Topology-GNN",
}
MODEL_STYLE = {
    "grid_gnn": ("#1F4E79", "o", "-"),
    "padded_cnn": ("#6F9FC8", "s", "--"),
    "topology_gnn": ("#B07A13", "^", ":"),
}


def configure_style() -> None:
    plt.rcParams.update(
        {
            "font.family": "serif",
            "font.serif": ["Times New Roman", "Times", "DejaVu Serif"],
            "font.size": 8.5,
            "axes.titlesize": 9.0,
            "axes.labelsize": 8.5,
            "legend.fontsize": 7.5,
            "xtick.labelsize": 7.5,
            "ytick.labelsize": 7.5,
            "axes.edgecolor": "#4B5563",
            "axes.linewidth": 0.7,
            "axes.grid": True,
            "grid.color": "#D7DCE2",
            "grid.linewidth": 0.5,
            "grid.alpha": 0.8,
            "savefig.bbox": "tight",
            "savefig.facecolor": "white",
        }
    )


def replay(grid_size: int, history: list[list[int] | None]) -> LifelineGame:
    game = LifelineGame(grid_size)
    for action in history:
        result = game.skip_turn() if action is None else game.play_move(action)
        if not result.success:
            raise AssertionError(f"witness replay failed at {action}: {result}")
    return game


def board_xy(point: tuple[int, int]) -> tuple[float, float]:
    x, y = point
    return x + 0.5 * y, (math.sqrt(3.0) / 2.0) * y


def draw_witness_panel(
    ax: plt.Axes,
    game: LifelineGame,
    panel_title: str,
    differing_edge: tuple[int, int],
    edge_present: bool,
) -> None:
    positions = [board_xy(point) for point in game.valid_positions]
    for a, b in game.physical_edges:
        ax.plot(
            [positions[a][0], positions[b][0]],
            [positions[a][1], positions[b][1]],
            color="#D5D9DE",
            linewidth=0.65,
            zorder=0,
        )

    for player, color, linestyle in (
        (Player.BLACK, "#1F4E79", "-"),
        (Player.WHITE, "#D97706", "--"),
    ):
        for a, b in sorted(game.edges[player]):
            is_difference = player is Player.WHITE and (a, b) == differing_edge
            ax.plot(
                [positions[a][0], positions[b][0]],
                [positions[a][1], positions[b][1]],
                color=color,
                linestyle=linestyle,
                linewidth=3.0 if is_difference else 1.8,
                zorder=2,
            )

    if not edge_present:
        a, b = differing_edge
        ax.plot(
            [positions[a][0], positions[b][0]],
            [positions[a][1], positions[b][1]],
            color="#9CA3AF",
            linestyle=(0, (1, 2)),
            linewidth=1.2,
            zorder=1,
        )

    node_styles = {
        PointState.EMPTY: ("white", "#9CA3AF", 20),
        PointState.BLACK_NODE: ("#222222", "#222222", 70),
        PointState.BLACK_LINE: ("#1F4E79", "#1F4E79", 24),
        PointState.WHITE_NODE: ("#F6E7C1", "#9A6700", 70),
        PointState.WHITE_LINE: ("#D97706", "#D97706", 24),
    }
    for index, raw_state in enumerate(game.grid):
        face, edge, size = node_styles[PointState(raw_state)]
        ax.scatter(
            positions[index][0],
            positions[index][1],
            s=size,
            facecolor=face,
            edgecolor=edge,
            linewidth=0.8,
            zorder=3,
        )

    ax.set_title(panel_title, pad=3)
    ax.set_aspect("equal")
    ax.set_xlim(-0.35, game.grid_size - 0.65)
    ax.set_ylim(-0.35, (math.sqrt(3.0) / 2.0) * (game.grid_size - 1) + 0.35)
    ax.axis("off")


def make_figure_1() -> None:
    witness_path = ROOT / "state_aliasing" / "pairs_v1.json"
    payload = json.loads(witness_path.read_text(encoding="utf-8"))
    witness = next(p for p in payload["pairs"] if p["pair_id"] == "weak_grid_topology_n5_v1")
    game_a = replay(witness["grid_size"], witness["history_a"])
    game_b = replay(witness["grid_size"], witness["history_b"])
    assert game_a.grid == game_b.grid == witness["expected"]["board"]
    assert game_a.current_player is game_b.current_player is Player.WHITE
    assert game_a.consecutive_skips == game_b.consecutive_skips == 1
    assert game_a.legal_moves() == game_b.legal_moves() == [(0, 4)]

    point_a, point_b = witness["expected"]["logical_edges_only_in_a"]["WHITE"][0]
    differing_edge = tuple(sorted((game_a.point_to_index[tuple(point_a)], game_a.point_to_index[tuple(point_b)])))
    assert differing_edge in game_a.edges[Player.WHITE]
    assert differing_edge not in game_b.edges[Player.WHITE]

    fig, axes = plt.subplots(1, 2, figsize=(7.0, 3.05))
    draw_witness_panel(axes[0], game_a, "History A: edge present", differing_edge, True)
    draw_witness_panel(axes[1], game_b, "History B: same Grid view, edge absent", differing_edge, False)
    fig.suptitle("Reachable side-five states with identical Grid observations", y=0.98, fontsize=10)
    legend = [
        Line2D([0], [0], color="#D5D9DE", lw=1.0, label="physical lattice"),
        Line2D([0], [0], color="#1F4E79", lw=2.0, label="black logical edge"),
        Line2D([0], [0], color="#D97706", lw=2.0, ls="--", label="white logical edge"),
        Line2D([0], [0], marker="o", color="none", markerfacecolor="#222222", markeredgecolor="#222222", markersize=5, label="node"),
        Line2D([0], [0], marker="o", color="none", markerfacecolor="#1F4E79", markeredgecolor="#1F4E79", markersize=3, label="line point"),
    ]
    fig.legend(handles=legend, loc="lower center", ncol=5, frameon=False, bbox_to_anchor=(0.5, -0.01))
    fig.subplots_adjust(left=0.02, right=0.98, top=0.84, bottom=0.16, wspace=0.08)
    fig.savefig(FIGURE_DIR / "fig1_lifeline_logical_edges.png", dpi=320)
    plt.close(fig)


def read_csv(name: str) -> list[dict[str, str]]:
    with (AGGREGATE_DIR / name).open(newline="", encoding="utf-8") as stream:
        return list(csv.DictReader(stream))


def make_figure_2() -> None:
    rows = [row for row in read_csv("arena_learning_curve.csv") if row["agent_b_id"] == "uct_mcts_16"]
    expected_steps = [40, 80, 120, 160, 200]
    fig, axes = plt.subplots(1, 3, figsize=(7.15, 2.55), sharey=True)
    for ax, size in zip(axes, (5, 7, 9), strict=True):
        for model in MODEL_ORDER:
            subset = sorted(
                (row for row in rows if row["agent_a_id"] == model and int(row["eval_size"]) == size),
                key=lambda row: int(row["checkpoint_gradient_steps"]),
            )
            steps = [int(row["checkpoint_gradient_steps"]) for row in subset]
            assert steps == expected_steps
            games = [int(row["games_completed"]) for row in subset]
            assert games == [100, 100, 100, 100, 1000]
            scores = [float(row["a_score_rate"]) for row in subset]
            color, marker, linestyle = MODEL_STYLE[model]
            ax.plot(
                steps,
                scores,
                color=color,
                marker=marker,
                linestyle=linestyle,
                linewidth=1.5,
                markersize=4.0,
                label=MODEL_LABELS[model],
            )
        ax.axhline(0.5, color="#4B5563", linewidth=0.8, linestyle=(0, (3, 2)))
        ax.set_title(f"Side length {size}")
        ax.set_xticks(expected_steps)
        ax.set_xlabel("Gradient updates")
        ax.set_ylim(0.35, 0.98)
        ax.set_yticks([0.4, 0.5, 0.6, 0.7, 0.8, 0.9])
        ax.grid(axis="y")
        ax.grid(axis="x", visible=False)
    axes[0].set_ylabel("Score rate vs UCT-MCTS-16")
    handles, labels = axes[0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="upper center", ncol=3, frameon=False, bbox_to_anchor=(0.5, 1.01))
    fig.text(
        0.5,
        -0.01,
        "Five pooled probes; 100 games at steps 40-160 and 1,000 games at step 200.",
        ha="center",
        fontsize=7.5,
        color="#4B5563",
    )
    fig.subplots_adjust(left=0.08, right=0.99, top=0.78, bottom=0.23, wspace=0.12)
    fig.savefig(FIGURE_DIR / "fig2_checkpoint_curves.png", dpi=320)
    plt.close(fig)


def make_figure_3() -> None:
    rows = [row for row in read_csv("final_vs_search.csv") if row["agent_b_id"] == "uct_mcts_16"]
    by_key = {(row["agent_a_id"], int(row["eval_size"])): row for row in rows}
    assert set(by_key) == {(model, size) for model in MODEL_ORDER for size in (5, 7, 9)}
    assert all(int(row["games_completed"]) == 1000 for row in rows)

    scores = np.array(
        [[float(by_key[(model, size)]["a_score_rate"]) for size in (5, 7, 9)] for model in MODEL_ORDER]
    )
    lower_bounds = np.array(
        [
            [json.loads(by_key[(model, size)]["a_score_ci95_wilson"])[0] for size in (5, 7, 9)]
            for model in MODEL_ORDER
        ]
    )
    cmap = LinearSegmentedColormap.from_list("lifeline_blue", ["#F3F4F6", "#B8D1E6", "#1F4E79"])
    fig, ax = plt.subplots(figsize=(5.8, 2.75))
    image = ax.imshow(scores, cmap=cmap, vmin=0.50, vmax=0.95, aspect="auto")
    for row_index in range(scores.shape[0]):
        for col_index in range(scores.shape[1]):
            value = scores[row_index, col_index]
            lower = lower_bounds[row_index, col_index]
            text_color = "white" if value >= 0.78 else "#1F2937"
            ax.text(
                col_index,
                row_index,
                f"{100 * value:.1f}%\nLB {100 * lower:.1f}%",
                ha="center",
                va="center",
                fontsize=8.2,
                color=text_color,
                fontweight="semibold",
            )
    ax.set_xticks(range(3), ["5", "7", "9"])
    ax.set_yticks(range(3), [MODEL_LABELS[model] for model in MODEL_ORDER])
    ax.set_xlabel("Evaluation side length (jointly trained)")
    ax.set_title("Final score rate against UCT-MCTS-16")
    ax.grid(False)
    ax.set_xticks(np.arange(-0.5, 3, 1), minor=True)
    ax.set_yticks(np.arange(-0.5, 3, 1), minor=True)
    ax.grid(which="minor", color="white", linewidth=1.4)
    ax.tick_params(which="minor", bottom=False, left=False)
    colorbar = fig.colorbar(image, ax=ax, fraction=0.035, pad=0.035)
    colorbar.set_label("Score rate")
    colorbar.set_ticks([0.5, 0.6, 0.7, 0.8, 0.9])
    fig.text(
        0.5,
        -0.01,
        "Each cell: 1,000 games; score = wins + 0.5 draws; LB = descriptive Wilson 95% lower bound.",
        ha="center",
        fontsize=7.5,
        color="#4B5563",
    )
    fig.subplots_adjust(left=0.25, right=0.92, top=0.84, bottom=0.24)
    fig.savefig(FIGURE_DIR / "fig3_model_size_heatmap.png", dpi=320)
    plt.close(fig)


def main() -> None:
    FIGURE_DIR.mkdir(parents=True, exist_ok=True)
    configure_style()
    make_figure_1()
    make_figure_2()
    make_figure_3()
    for path in sorted(FIGURE_DIR.glob("fig*.png")):
        print(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()

