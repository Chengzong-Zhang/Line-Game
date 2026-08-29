# Random, Greedy, Minimax, UCT-MCTS, and arena baselines

This document freezes the first non-learning baseline implementation. These
agents use the exact dependency-free rules state, including logical edges and
Superko history.

## Random policy

`RandomAgent` samples uniformly from the complete legal action list:

```text
all legal point actions, followed by PASS
```

PASS is not silently removed or assigned a hand-tuned probability. This keeps
the baseline definition simple and reproducible, although it is intentionally
weak.

## One-step Greedy

`GreedyAgent` evaluates every legal successor, including PASS, and chooses the
first maximum in canonical action order. It is deterministic and uses this
root-player-perspective score at non-terminal states:

```text
H = 100 * node_advantage
  +  10 * line_advantage
  +   5 * logical_edge_advantage
  +       frontier_advantage
```

The frontier is the number of distinct empty physical neighbours of a player's
node cells. This score is intentionally cheap and inspectable: it uses no
contour construction, flood-fill territory estimate, exact intermediate
territory, learned value, or lookahead beyond the successor. An actually
terminal successor uses the exact `{-1, 0, +1}` rules reward multiplied by a
dominating constant. Every root feature vector and score is persisted in arena
diagnostics.

## Alpha-beta Minimax

`MinimaxAgent` supplies the frozen depth-2 and depth-3 baselines. Leaf states
use the same heuristic as Greedy, while terminal leaves use exact outcomes.
Opponent nodes minimize the root player's value. Search uses alpha-beta
pruning and restores a lossless `GameSnapshot` at every branch; the snapshot
contains the board, both logical-edge sets, player to act, skip/terminal state,
turn count, and complete Superko history.

The disclosed move approximation is retained at every node. Legal point moves
are ordered by:

1. attacks on an opponent line cell;
2. moves adjacent to an own line cell;
3. all other moves;

with canonical point order inside each tier. Only the first 20 point moves are
searched by the frozen baseline. PASS is then appended as an extra branch, so
the maximum branching factor is 21. The cap is configurable for diagnostics,
but paper results must report its value and use `20` for the named
`Minimax-2`/`Minimax-3` baselines.

## UCT-MCTS

`MCTSAgent` implements adversarial UCT with:

- exact clone/restore of the full simulator state at every simulation root;
- one-node expansion per simulation;
- uniform random rollouts over legal point actions and PASS;
- terminal values in `{-1, 0, +1}` from the root player's perspective;
- value `0` when the configured rollout depth is reached before termination;
- final action selection by visit count, then root value, then seeded tie-break;
- no learned policy, learned value, heuristic evaluation, or transposition
  merging.

At opponent nodes, the exploitation term is negated. This is essential:
otherwise the opponent would cooperate by maximizing the root player's value.
The behavior has a dedicated regression test.

Configuration fields are:

```text
simulations, exploration, rollout_depth
```

The current default exploration constant is `sqrt(2)`. Search diagnostics log
the root visit distribution and root-perspective mean value for every action.

## Color-balanced arena

`run_matchup` requires an even number of games. Every seed produces a pair:

1. agent A as BLACK and agent B as WHITE;
2. agent B as BLACK and agent A as WHITE.

The same agent-specific policy seeds are reused across the color swap. Every
game stores the point/action sequence, acting player, decision time, search
diagnostics, final territory, and winner. Agent selection is checked for state
mutation, and every returned action is validated by the rule engine.

Games that hit `max_plies` are marked `truncated`; they are not counted as
draws, wins, or losses. The arena reports color-separated W/D/L, mean score, a
descriptive Wilson interval (draws treated as half-successes), and Elo
difference when the empirical score is strictly between zero and one. Formal
paper inference will use the pre-registered multi-seed protocol, not a tiny
arena interval.

## Run and verify

Select either side from `random`, `greedy`, `minimax-2`, `minimax-3`, and
`mcts`. This example runs Minimax-3 against Greedy:

```powershell
python .\research\iclr2027\scripts\run_arena.py `
  --agent-a minimax-3 `
  --agent-b greedy `
  --grid-size 5 `
  --games 4 `
  --seed 20260825 `
  --max-plies 120 `
  --minimax-move-cap 20
```

When `--output-dir` is omitted, the CLI creates a UTC-microsecond-prefixed
unique directory under `results/arena`. An explicit existing directory is
never overwritten unless `--overwrite` is passed.

The output directory contains:

- `summary.json`: configuration, seeds, aggregate metrics, runtime and Git
  provenance;
- `games.jsonl`: one complete replayable record per game;
- `games.csv`: compact per-game table.

Replay and validate every game and the aggregate counts:

```powershell
python .\research\iclr2027\scripts\verify_arena_results.py `
  .\research\iclr2027\results\smoke\mcts_s32_d40_vs_random_n5_seed20260825
```

Run all 15 unordered pairings (the diagonal included), with two color-balanced
games per matchup, and replay-check all 30 games:

```powershell
python .\research\iclr2027\scripts\run_baseline_matrix.py `
  --grid-size 5 `
  --games 2 `
  --seed 20260825 `
  --minimax-move-cap 20 `
  --mcts-simulations 4 `
  --mcts-rollout-depth 8
```

The matrix runner writes its own manifest/CSV plus a normal replayable arena
directory for each pairing. It refuses to reuse a matrix run directory.

## Verified smoke evidence

The 2026-08-25 engineering smoke used side length 5, four color-balanced games,
32 simulations per MCTS move, rollout depth 40, seed 20260825, and a 120-ply
limit. It completed without truncation or illegal actions:

```text
MCTS wins: 4
Random wins: 0
Draws: 0
MCTS as BLACK: 2-0
MCTS as WHITE: 2-0
Mean game length: 8.5 plies
```

The score is `1.0`, but the descriptive 95% Wilson interval is approximately
`[0.51, 1.00]`. Four games are sufficient only for an end-to-end smoke check;
they are not paper evidence of strength.

The complete five-agent engineering smoke is recorded separately in
`D7_D8_search_report.md`. Its two games per cell validate plumbing only; none
of its observed win rates or rankings is a scientific result.
