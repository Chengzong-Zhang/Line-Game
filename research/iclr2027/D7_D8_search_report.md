# D7-D8 search baseline report

Date: 2026-08-25

## Outcome

The five frozen non-learning agent types now share one arena interface and one
CLI construction path:

| Stable CLI kind | Implementation | Frozen smoke configuration |
| --- | --- | --- |
| `random` | uniform legal point/PASS sampling | seeded policy RNG |
| `greedy` | deterministic one-successor heuristic | all legal actions |
| `minimax-2` | adversarial alpha-beta | depth 2, top-20 points + PASS |
| `minimax-3` | adversarial alpha-beta | depth 3, top-20 points + PASS |
| `mcts` | adversarial UCT with random rollout | 4 simulations, rollout depth 8 |

The MCTS values above are deliberately tiny matrix-smoke settings, not frozen
formal evaluation budgets.

## Greedy score contract

For a non-terminal successor and root player `p`, Greedy computes:

```text
H(s,p) = 100 * (own_nodes - opponent_nodes)
       +  10 * (own_line_cells - opponent_line_cells)
       +   5 * (own_logical_edges - opponent_logical_edges)
       +       (own_frontier - opponent_frontier)
```

`frontier` counts distinct empty physical neighbours of node cells. The score
does not call exact territory or any approximate territory routine. Exact
rules reward is used only after an action has actually produced a terminal
state. Canonical action order resolves equal scores, so Greedy is deterministic
independent of the provided RNG.

## Minimax contract

Minimax uses the same non-terminal leaf score and exact terminal outcomes. At
each node it determines maximization/minimization from the actual player to act
rather than blindly alternating a Boolean; this remains correct when automatic
skips return the turn to the same player.

The top-20 rule is public and test-covered. Point moves use the legacy tactical
ordering (attack an opponent line, then adjacency to an own line, then other),
with canonical order inside each tier. The first 20 point moves plus PASS are
searched. Alpha-beta cutoffs, searched nodes, leaf evaluations, maximum point
branching, root action values, depth, cap, and heuristic weights are logged.

Every branch restores `GameSnapshot`, including both logical-edge sets and the
entire Superko history. A reachable multi-step state is used in the regression
test to verify that search leaves that full immutable snapshot exactly equal.

## Arena and artifact contract

`scripts/run_arena.py` accepts either side from all five stable kinds. It keeps
the existing strict color swap, agent-specific seeds, legality checks,
non-mutation checks, truncation accounting, JSONL action log, CSV, summary, and
independent replay verifier. If the caller does not choose `--output-dir`, it
creates a UTC-microsecond-prefixed unique directory. Existing explicit outputs
are protected unless `--overwrite` is deliberately supplied.

`scripts/run_baseline_matrix.py` executes unordered combinations with
replacement because each matchup already swaps colors. Five kinds therefore
produce 15 cells rather than redundant ordered duplicates. It creates fresh
Agent objects per cell, writes normal arena artifacts, immediately replays each
game, and writes `matrix_summary.json` plus `matrix.csv`.

## Verification evidence

Commands were run from `research/iclr2027`:

```powershell
python -c "import lifeline_rl; print(lifeline_rl.AGENT_KINDS)"
python -m unittest discover -s . -p 'test*.py' -v
python scripts/run_baseline_matrix.py --grid-size 5 --games 2 `
  --seed 20260825 --max-plies 80 --minimax-move-cap 20 `
  --mcts-simulations 4 --mcts-rollout-depth 8
Get-ChildItem -Directory results\smoke\baseline_matrix\20260825T123419.575786Z_all_baselines_n5_g2_seed20260825 |
  ForEach-Object { python scripts\verify_arena_results.py $_.FullName }
```

Observed engineering checks:

- package import and all five stable factory kinds: PASS;
- final integrated D1--D8 repository suite: 55/55 PASS;
- new focused search-baseline tests: 8/8 PASS;
- complete matrix: 15/15 matchup cells produced;
- games: 30/30 completed, 0 truncated;
- inline replay: 30/30 PASS;
- independent per-directory replay/summary verification: 15/15 PASS;
- summed logged game time: 4.973 seconds;
- mean game length across these equally sized cells: 8.77 plies.

The focused tests cover the unified runtime Agent protocol, all factory kinds,
legal output, deterministic Greedy/Minimax decisions, root non-mutation,
absence of non-terminal exact-territory calls in Greedy, the public point cap,
PASS retention, complete Superko-history preservation, and a real depth-2
enumeration showing that an opponent node takes the minimum rather than the
cooperative maximum.

## Smoke matrix

The persisted result root is:

```text
results/smoke/baseline_matrix/
20260825T123419.575786Z_all_baselines_n5_g2_seed20260825/
```

Each score below is Agent A's score over only two color-balanced games:

| Agent A | Agent B | A W-D-L | A score | Mean plies |
| --- | --- | ---: | ---: | ---: |
| Random | Random | 2-0-0 | 1.00 | 9.5 |
| Random | Greedy | 0-0-2 | 0.00 | 8.0 |
| Random | Minimax-2 | 0-0-2 | 0.00 | 9.0 |
| Random | Minimax-3 | 0-0-2 | 0.00 | 3.5 |
| Random | MCTS-4 | 0-0-2 | 0.00 | 6.5 |
| Greedy | Greedy | 1-0-1 | 0.50 | 12.0 |
| Greedy | Minimax-2 | 2-0-0 | 1.00 | 10.5 |
| Greedy | Minimax-3 | 0-0-2 | 0.00 | 13.5 |
| Greedy | MCTS-4 | 1-0-1 | 0.50 | 11.5 |
| Minimax-2 | Minimax-2 | 1-0-1 | 0.50 | 7.0 |
| Minimax-2 | Minimax-3 | 0-1-1 | 0.25 | 9.0 |
| Minimax-2 | MCTS-4 | 2-0-0 | 1.00 | 7.5 |
| Minimax-3 | Minimax-3 | 1-0-1 | 0.50 | 8.0 |
| Minimax-3 | MCTS-4 | 2-0-0 | 1.00 | 6.5 |
| MCTS-4 | MCTS-4 | 0-0-2 | 0.00 | 9.5 |

These cells are deliberately too small for ranking agents. Diagonal 2-0 and
0-2 outcomes also demonstrate why two games are only a software smoke test:
policy seeds and first-player geometry can dominate a tiny sample. No row is a
paper result and no superiority claim is made from this matrix.

## Remaining gate before paper evidence

1. Benchmark MCTS simulations/second and Minimax decision latency on side
   lengths 5, 7, and 9.
2. Freeze compute-matched formal MCTS budgets before inspecting formal results.
3. Run the pre-registered 200-game color-balanced evaluation cells with unique
   seeds and retain every failure/truncation.
4. Report confidence intervals and compute, and describe the Minimax top-20
   approximation wherever its results appear.
