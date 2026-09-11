# D20: Matched logical-edge × compact-history formal ablation

Protocol ID: `d20_matched_logical_edges_compact_history_protocol_20260909_v1`  
Experiment ID: `d20_matched_logical_edges_compact_history_formal_v1`  
Status: local formal execution authorized; results absent until independently verified.

## Purpose and boundary

D20 is an append-only experiment. It does not modify or reinterpret the
frozen D19-v2 candidate. Its purpose is to supply the previously missing
same-backbone 2×2 evidence for logical edges and the one-bit immediate
Superko-membership feature, alongside held-out-size and stronger-fixed-opponent
evaluation.

The experiment does **not** establish a same-implemented-observation-and-mask
future-decision witness. D19-v2's construct-validity blocker remains open, and
no D20 result may be described as solving it. A positive D20 contrast would
only be evidence about the declared feature-gated implementation and training
distribution.

## Matched factorial design

All four arms use `MatchedD19V2PolicyValueNetwork`: width 12, three relations,
64 hidden channels, three message-passing layers, and exactly 63,235 trainable
parameters. Within each training seed, all four arms begin from byte-identical
weights. The only gates are:

| Arm | Logical-edge relations | Compact history plane |
| --- | ---: | ---: |
| `edge0_history0` | off | off |
| `edge1_history0` | on | off |
| `edge0_history1` | off | on |
| `edge1_history1` | on | on |

The compact plane is computed from the complete immutable pre-action
`GameSnapshot`: for each point action it is one only if the candidate would
immediately violate Superko. It never replaces the legal-action mask and does
not include a pass bit, successor state, reward, rollout, or future action.

## Training registration

There are five paired training seeds: 20260825–20260829. Each arm/seed trains
on mixed sizes 5, 7, and 9 for 10 iterations × 10 self-play games, with PUCT-16
and root Dirichlet noise. Each iteration performs 20 AdamW updates on batches
of 16 from a FIFO capacity-10,000 replay buffer. The rule is enforced Superko,
the ply cap is 256, and any truncation, missing seed, non-finite loss, or count
mismatch fails the run rather than silently retrying it.

This creates exactly 20 training tasks, 2,000 self-play games, 4,000 gradient
steps, and 20 final checkpoints.

## Evaluation registration

Each final checkpoint is evaluated with fixed PUCT-16 at temperature zero,
without root noise or fine-tuning. Evaluation is color-balanced: every opening
is played twice with A as Black and A as White, retaining the same opening and
the same pair-level policy seeds.

For each size, a model-independent registry contains 32 legal opening strata
and two variants per stratum. The generator uses only rule transitions and a
counter-based seed; it never loads a checkpoint or any outcome. Thus every
task has 64 distinct nonterminal openings and 128 games.

| Opponent | Size(s) | Fixed definition |
| --- | --- | --- |
| Random | 9, 10, 12 | uniform legal action baseline |
| UCT-16 | 9, 10, 12 | 16 simulations, rollout depth 80, `sqrt(2)` exploration |
| UCT-64 | 10, 12 | 64 simulations, rollout depth 80, `sqrt(2)` exploration |

Sizes 10 and 12 are held out from training. UCT-64 is a pre-specified
larger-search reference, but the wording “stronger” remains conditional on a
separate calibrated-search assessment; a larger simulation budget alone is not
a proof of game-playing strength.

The exact total is 160 evaluation tasks and 20,480 games. Raw games are
replayed independently; every task requires all 64 opening fingerprints,
complete color pairs, and zero truncations.

## Inference and reporting

The primary statistical unit is the training seed, not an individual game.
For each `(opponent, evaluation size, arm)`, the five seed-level score rates
are reported with paired two-sided Student-t 95% intervals (`df=4`). The
five registered factorial contrasts are logical-at-history-0,
logical-at-history-1, history-at-edge-0, history-at-edge-1, and the 2×2
interaction. Pooled W/D/L rates, if shown, are descriptive only.

## Reproducibility and fail-closed evidence

The runner records the manifest and protocol hashes, full source closure,
deterministic task/opening registry, per-task receipts, self-play/arena action
logs, checkpoint byte and model-state hashes, canonical aggregate, and an
independent replay/aggregate report. Raw trajectories and checkpoints remain
under `local_artifacts/`; compact receipts and aggregates may be curated only
after independent verification. Any source drift, hash mismatch, missing task,
failed checkpoint load, replay mismatch, diversity failure, or truncation
makes `formal_ready=false`.

CUDA executions set `CUBLAS_WORKSPACE_CONFIG=:4096:8` before Torch import and
enable deterministic Torch algorithms. A CUDA smoke must pass before the
formal run; a failed smoke invalidates the pre-execution configuration rather
than being treated as a partial experiment.

`d20_matched_ablation_runner.py` performs an internal fail-closed check during
execution, while `verify_d20_matched_ablation.py` is a separate implementation
that does not import the runner. The final completion receipt requires their
canonical numeric aggregates to agree exactly.
