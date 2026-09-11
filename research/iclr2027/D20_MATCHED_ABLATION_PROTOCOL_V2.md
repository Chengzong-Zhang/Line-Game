# D20-v2: matched logical-edge × compact-history formal ablation

Protocol ID: `d20_matched_logical_edges_compact_history_protocol_20260909_v2`  
Experiment ID: `d20_matched_logical_edges_compact_history_formal_v2`  
Status: local formal execution authorized after calibration gate.

## Scope and preserved boundary

D20-v2 is a new, append-only protocol replacing the unexecuted v1 plan; the
reason and archived hashes are recorded in
`D20_PREEXECUTION_REVISION_LOG_20260909.md`. It never changes frozen D19-v2.
It tests the same 2×2 model family, but it does not prove a same-implemented-
observation-and-mask future-decision witness. That construct-validity blocker
remains explicitly open.

## Factorial training

The four arms `edge0_history0`, `edge1_history0`, `edge0_history1`, and
`edge1_history1` share the 12-feature, 3-relation, 64-channel, 3-layer
`MatchedD19V2PolicyValueNetwork` (63,235 parameters). Only the logical-edge
relations and one-bit immediate Superko-membership plane change. All arms for a
training seed start from byte-identical weights.

Five paired seeds (20260825–20260829) train on mixed sizes 5/7/9 with 10 × 10
PUCT-16 self-play games and 10 × 20 AdamW updates. The rules are enforced
Superko, the replay capacity is 10,000, batch size is 16, and the maximum is
256 plies. Any mismatch, truncation, missing seed, or non-finite update fails
closed. This is 20 training tasks, 2,000 self-play games, 4,000 updates, and
20 final checkpoints.

## Strong-opponent calibration gate

The candidate fixed opponent is `minimax_d2_cap8_v1`: alpha-beta Minimax,
depth two, tactical move cap eight, and the frozen repository heuristic. It is
not called strong merely because it is a search algorithm.

Before any D20-v2 evaluation, a distinct calibration protocol plays it against
the pre-existing UCT-16/depth-80 baseline on n=10 and n=12. Each size uses five
fixed RNG blocks, four nonterminal rule-generated openings per block, and a
colour-swapped pair per opening (40 games per size). The primary unit is the
five block means. The candidate passes for a size only when its two-sided
Student-t 95% lower bound (`df=4`) for score against UCT-16 is strictly above
0.5, with no truncations or replay failures. A failed or inconclusive
calibration stops D20-v2 rather than replacing the candidate post hoc.

## Evaluation

Only after both calibration sizes pass, each final D20 checkpoint is evaluated
at fixed PUCT-1, temperature zero, and no root noise. PUCT-1 intentionally
measures the frozen policy/value model with one legal masked model expansion;
it is not presented as compute-matched to the training PUCT-16.

Each task has 32 distinct model-independent nonterminal openings (one variant
per stratum), with the same opening and policy seeds played once per colour:
64 games/task. The opening generator uses only the rules engine and
counter-based seeds; it cannot load a model or prior result.

| Opponent | Evaluation sizes | Tasks | Games |
| --- | --- | ---: | ---: |
| Random | 9, 10, 12 | 60 | 3,840 |
| Calibrated `minimax_d2_cap8_v1` | held-out 10, 12 | 40 | 2,560 |

The total is 100 evaluation tasks and 6,400 games. n=10 and n=12 are held out
from all D20 training. The Minimax comparison is a robustness test against a
calibrated stronger fixed opponent; it is not a compute-matched comparison.

## Statistics and evidence

Training seed is the inferential unit. For every arm/opponent/size cell, report
the five seed score rates and paired two-sided t intervals (`df=4`), followed by
the predeclared main effects and interaction. Pooled game W/D/L is descriptive
only.

Raw trajectories and checkpoints remain local. The runner writes source,
protocol, manifest, task-plan, opening, checkpoint, receipt, and model-state
hashes. It replays all games; then a separate verifier that does not import the
runner recomputes every replay and aggregate. Completion is formal only if both
aggregates match exactly and all gates pass. CUDA execution uses
`CUBLAS_WORKSPACE_CONFIG=:4096:8` before Torch import and deterministic Torch
algorithms.
