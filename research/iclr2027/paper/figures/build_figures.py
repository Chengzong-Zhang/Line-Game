"""Rebuild paper figures from frozen, replay-verified artifacts only."""

from __future__ import annotations

import csv
import json
import math
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.cm import ScalarMappable
from matplotlib.colors import LinearSegmentedColormap, Normalize
from matplotlib.lines import Line2D
from matplotlib.patches import Rectangle
from matplotlib.ticker import PercentFormatter
import numpy as np


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from lifeline_rl.core import LifelineGame, Player, PointState  # noqa: E402


OUT = Path(__file__).resolve().parent
AGG = ROOT / "results" / "formal" / "d14_d16" / "aggregate_v1"
MODELS = ["grid_gnn", "padded_cnn", "topology_gnn"]
LABEL = {"grid_gnn": "Grid-GNN", "padded_cnn": "Padded-CNN", "topology_gnn": "Topology-GNN"}
STYLE = {
    "grid_gnn": ("#1F4E79", "o", "-"),
    "padded_cnn": ("#6F9FC8", "s", "--"),
    "topology_gnn": ("#B07A13", "^", ":"),
}
INK = "#20242A"
MUTED = "#566273"
GRID = "#D7DCE2"
PHYSICAL = "#D0D5DC"
GOLD = "#D97706"
GOLD_DARK = "#9A6700"


def style() -> None:
    plt.rcParams.update(
        {
            "font.family": "serif",
            "font.serif": ["Times New Roman", "STIXGeneral", "DejaVu Serif"],
            "mathtext.fontset": "stix",
            "font.size": 8.5,
            "text.color": INK,
            "axes.titlesize": 9.2,
            "axes.titleweight": "semibold",
            "axes.labelsize": 8.5,
            "axes.labelcolor": INK,
            "legend.fontsize": 7.7,
            "legend.handlelength": 2.4,
            "xtick.labelsize": 7.7,
            "ytick.labelsize": 7.7,
            "xtick.color": INK,
            "ytick.color": INK,
            "axes.edgecolor": MUTED,
            "axes.linewidth": 0.75,
            "axes.grid": True,
            "grid.color": GRID,
            "grid.linewidth": 0.55,
            "grid.alpha": 0.9,
            "pdf.fonttype": 42,
            "ps.fonttype": 42,
            "savefig.bbox": "tight",
            "savefig.facecolor": "white",
            "savefig.pad_inches": 0.025,
        }
    )


def save_figure(fig: plt.Figure, stem: str) -> None:
    """Write a vector paper asset and a high-resolution inspection copy."""
    fig.savefig(
        OUT / f"{stem}.pdf",
        metadata={"Author": "", "Title": "", "Subject": "LIFELINE-RL scientific figure"},
    )
    fig.savefig(OUT / f"{stem}.png", dpi=320)


def replay(size: int, actions: list[list[int] | None]) -> LifelineGame:
    game = LifelineGame(size)
    for action in actions:
        result = game.skip_turn() if action is None else game.play_move(action)
        if not result.success:
            raise AssertionError(f"failed witness action {action}: {result}")
    return game


def xy(point: tuple[int, int]) -> tuple[float, float]:
    x, y = point
    return x + 0.5 * y, math.sqrt(3.0) * y / 2.0


def draw_state(ax: plt.Axes, game: LifelineGame, title: str, differing: tuple[int, int], present: bool) -> None:
    pos = [xy(point) for point in game.valid_positions]
    for a, b in game.physical_edges:
        ax.plot([pos[a][0], pos[b][0]], [pos[a][1], pos[b][1]], color=PHYSICAL, lw=0.7, zorder=0)
    for player, color, line_style in (
        (Player.BLACK, "#1F4E79", "-"),
        (Player.WHITE, GOLD, "--"),
    ):
        for a, b in sorted(game.edges[player]):
            highlight = player is Player.WHITE and (a, b) == differing
            ax.plot(
                [pos[a][0], pos[b][0]],
                [pos[a][1], pos[b][1]],
                color=color,
                ls=line_style,
                lw=3.0 if highlight else 1.8,
                zorder=2,
            )
    if not present:
        a, b = differing
        ax.plot(
            [pos[a][0], pos[b][0]],
            [pos[a][1], pos[b][1]],
            color="#8C97A5",
            ls=(0, (1, 2)),
            lw=1.35,
            zorder=1,
        )
    glyph = {
        PointState.EMPTY: ("white", "#9CA3AF", 18),
        PointState.BLACK_NODE: ("#222222", "#222222", 68),
        PointState.BLACK_LINE: ("#1F4E79", "#1F4E79", 23),
        PointState.WHITE_NODE: ("#F6E7C1", GOLD_DARK, 68),
        PointState.WHITE_LINE: (GOLD, GOLD, 23),
    }
    for index, raw in enumerate(game.grid):
        face, edge, size = glyph[PointState(raw)]
        ax.scatter(*pos[index], s=size, facecolor=face, edgecolor=edge, lw=0.8, zorder=3)
    if present:
        a, b = differing
        midpoint = ((pos[a][0] + pos[b][0]) / 2.0, (pos[a][1] + pos[b][1]) / 2.0)
        ax.annotate(
            "A-only logical edge",
            xy=midpoint,
            xytext=(midpoint[0] - 1.05, midpoint[1] + 0.58),
            fontsize=7.2,
            color=GOLD_DARK,
            ha="center",
            arrowprops={"arrowstyle": "-|>", "color": GOLD_DARK, "lw": 0.75, "shrinkA": 2, "shrinkB": 2},
            zorder=4,
        )
    ax.set_title(title, pad=4)
    ax.set_aspect("equal")
    ax.set_xlim(-0.3, game.grid_size - 0.7)
    ax.set_ylim(-0.3, math.sqrt(3.0) * (game.grid_size - 1) / 2.0 + 0.3)
    ax.axis("off")


def figure_1() -> None:
    data = json.loads((ROOT / "state_aliasing" / "pairs_v1.json").read_text(encoding="utf-8"))
    witness = next(row for row in data["pairs"] if row["pair_id"] == "weak_grid_topology_n5_v1")
    a = replay(5, witness["history_a"])
    b = replay(5, witness["history_b"])
    assert a.grid == b.grid == witness["expected"]["board"]
    assert a.current_player is b.current_player is Player.WHITE
    assert a.consecutive_skips == b.consecutive_skips == 1
    assert a.legal_moves() == b.legal_moves() == [(0, 4)]
    p, q = witness["expected"]["logical_edges_only_in_a"]["WHITE"][0]
    edge = tuple(sorted((a.point_to_index[tuple(p)], a.point_to_index[tuple(q)])))
    assert edge in a.edges[Player.WHITE] and edge not in b.edges[Player.WHITE]

    fig, axes = plt.subplots(1, 2, figsize=(7.0, 2.52))
    draw_state(axes[0], a, "A  Edge present", edge, True)
    draw_state(axes[1], b, "B  Same Grid view; edge absent", edge, False)
    handles = [
        Line2D([0], [0], color=PHYSICAL, lw=1, label="physical lattice"),
        Line2D([0], [0], color="#1F4E79", lw=2, label="black logical edge"),
        Line2D([0], [0], color=GOLD, lw=2, ls="--", label="white logical edge"),
        Line2D([0], [0], color="#8C97A5", lw=1.2, ls=(0, (1, 2)), label="A-only edge location"),
        Line2D([0], [0], marker="o", color="none", markerfacecolor="#222222", markeredgecolor="#222222", markersize=5, label="node"),
        Line2D([0], [0], marker="o", color="none", markerfacecolor="#1F4E79", markeredgecolor="#1F4E79", markersize=3, label="line point"),
    ]
    fig.legend(handles=handles, loc="lower center", ncol=3, frameon=False, bbox_to_anchor=(0.5, -0.015))
    fig.subplots_adjust(left=0.02, right=0.98, top=0.91, bottom=0.255, wspace=0.10)
    save_figure(fig, "fig1_lifeline_logical_edges")
    plt.close(fig)


def rows(name: str) -> list[dict[str, str]]:
    with (AGG / name).open(newline="", encoding="utf-8") as stream:
        return list(csv.DictReader(stream))


def figure_2() -> None:
    data = [r for r in rows("arena_learning_curve.csv") if r["agent_b_id"] == "uct_mcts_16"]
    steps_expected = [40, 80, 120, 160, 200]
    fig, axes = plt.subplots(1, 3, figsize=(7.15, 2.42), sharey=True)
    for ax, size in zip(axes, (5, 7, 9), strict=True):
        for model in MODELS:
            subset = sorted(
                (r for r in data if r["agent_a_id"] == model and int(r["eval_size"]) == size),
                key=lambda r: int(r["checkpoint_gradient_steps"]),
            )
            steps = [int(r["checkpoint_gradient_steps"]) for r in subset]
            games = [int(r["games_completed"]) for r in subset]
            assert steps == steps_expected and games == [100, 100, 100, 100, 1000]
            color, marker, line_style = STYLE[model]
            ax.plot(
                steps,
                [float(r["a_score_rate"]) for r in subset],
                color=color,
                marker=marker,
                ls=line_style,
                lw=1.65,
                ms=4.4,
                markeredgecolor="white",
                markeredgewidth=0.55,
                label=LABEL[model],
            )
        ax.axhline(0.5, color=MUTED, lw=0.85, ls=(0, (3, 2)))
        ax.set_title(f"Side length {size}")
        ax.set_xticks(steps_expected)
        ax.set_xlabel("Gradient updates")
        ax.set_ylim(0.35, 0.98)
        ax.set_yticks([0.4, 0.5, 0.6, 0.7, 0.8, 0.9])
        ax.yaxis.set_major_formatter(PercentFormatter(1.0, decimals=0))
        ax.grid(axis="y")
        ax.grid(axis="x", visible=False)
    axes[0].set_ylabel("Score rate vs UCT-MCTS-16")
    handles, labels = axes[0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="upper center", ncol=3, frameon=False, bbox_to_anchor=(0.5, 1.01))
    fig.text(0.5, -0.005, "Five pooled probes; N=100 at steps 40-160 and N=1,000 at step 200.", ha="center", fontsize=7.5, color=MUTED)
    fig.subplots_adjust(left=0.085, right=0.995, top=0.775, bottom=0.24, wspace=0.12)
    save_figure(fig, "fig2_checkpoint_curves")
    plt.close(fig)


def figure_3() -> None:
    data = rows("final_vs_search.csv")
    opponent_order = ["random", "uct_mcts_16"]
    opponent_label = {"random": "Random", "uct_mcts_16": "UCT-MCTS-16"}
    cmap = LinearSegmentedColormap.from_list("lifeline_blue", ["#F3F4F6", "#B8D1E6", "#1F4E79"])
    norm = Normalize(vmin=0.50, vmax=1.00)
    fig, axes = plt.subplots(1, 2, figsize=(7.05, 2.48), sharey=True)
    for ax, opponent in zip(axes, opponent_order, strict=True):
        lookup = {(r["agent_a_id"], int(r["eval_size"])): r for r in data if r["agent_b_id"] == opponent}
        assert set(lookup) == {(model, size) for model in MODELS for size in (5, 7, 9)}
        assert all(int(r["games_completed"]) == 1000 for r in lookup.values())
        matrix = np.array([[float(lookup[(model, size)]["a_score_rate"]) for size in (5, 7, 9)] for model in MODELS])
        for i in range(3):
            for j in range(3):
                value = matrix[i, j]
                ax.add_patch(
                    Rectangle(
                        (j - 0.5, i - 0.5),
                        1,
                        1,
                        facecolor=cmap(norm(value)),
                        edgecolor="white",
                        linewidth=1.4,
                    )
                )
                ax.text(j, i, f"{100 * value:.1f}%", ha="center", va="center", color="white" if value >= 0.78 else INK, fontweight="semibold")
        ax.set_xlim(-0.5, 2.5)
        ax.set_ylim(2.5, -0.5)
        ax.set_title(f"Opponent: {opponent_label[opponent]}")
        ax.set_xticks(range(3), ["5", "7", "9"])
        ax.set_xlabel("Side length")
        ax.set_yticks(range(3), [LABEL[model] for model in MODELS])
        ax.grid(False)
    colorbar = fig.colorbar(ScalarMappable(norm=norm, cmap=cmap), ax=axes, fraction=0.025, pad=0.035)
    colorbar.set_label("Score rate")
    colorbar.set_ticks([0.5, 0.6, 0.7, 0.8, 0.9, 1.0])
    colorbar.ax.yaxis.set_major_formatter(PercentFormatter(1.0, decimals=0))
    fig.text(0.5, 0.012, "Each cell: N=1,000; score = (wins + 0.5 draws) / games.", ha="center", fontsize=7.5, color=MUTED)
    fig.subplots_adjust(left=0.18, right=0.89, top=0.87, bottom=0.235, wspace=0.14)
    save_figure(fig, "fig3_model_size_opponent_heatmap")
    plt.close(fig)


def main() -> None:
    style()
    figure_1()
    figure_2()
    figure_3()
    for path in sorted(p for p in OUT.glob("fig*.*") if p.suffix in {".pdf", ".png"}):
        print(f"{path.name}: {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
