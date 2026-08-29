# D3 search-baseline status

Date: 2026-08-25

> Historical checkpoint after the first Random/UCT implementation. The
> completed five-agent status and current remaining gates are in
> `D7_D8_search_report.md`.

## Completed

- [x] Uniform random legal policy including PASS.
- [x] Full-state UCT-MCTS with seeded random rollouts.
- [x] Correct adversarial selection at opponent nodes.
- [x] Root visit/value diagnostics.
- [x] Strictly color-balanced matchup scheduling.
- [x] Separate policy seeds preserved across color swaps.
- [x] Maximum-ply truncation reported separately from draws.
- [x] Full JSONL action/search logs and compact CSV output.
- [x] Refusal to overwrite an existing result by default.
- [x] Independent replay and summary verification.
- [x] Four-game MCTS-32 versus Random smoke run.

## Evidence boundary

The smoke run demonstrates that MCTS receives a usable terminal signal and that
the arena, logging, replay, and summary pipeline work end to end. A 4-0 result
does not establish baseline strength, a stable Elo difference, or statistical
superiority. The MCTS rollout cutoff also assigns zero to unfinished rollouts;
this is a documented baseline choice, not a claim of optimal evaluation.

## Next gates

1. Benchmark simulations/second and decision latency for candidate MCTS budgets
   across side lengths 5, 7, and 9.
2. Freeze the formal MCTS simulation budgets from measured compute rather than
   convenience.
3. Run the 200-game color-balanced Random-vs-Random calibration and selected
   MCTS-vs-Random matchups with unique output directories.
4. Port or wrap the existing one-step greedy and Minimax-2/3 agents into the
   same interface, preserving the documented top-20 Minimax move cap.
5. Add bootstrap confidence intervals for the formal multi-seed arena report.
