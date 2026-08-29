# Fresh-seed Superko policy-matrix results

Status: completed and independently verified on 2026-08-26.

## Bottom line

The preregistered engineering matrix completed 12 policy-by-size cells, 60
five-seed blocks, 120 matched color-orientation pairs, and 240 individual
games. In this finite sample, no game exposed a Superko candidate, selected a
repetition, diverged between `enforce` and `observe`, or truncated. Every
observed paired score, length, and truncation effect was therefore zero.

This is not evidence that the rules are equivalent. All 12 full practical-
similarity gates failed: each cell has only 10 observe games, so even `0/10`
observe truncations has a Wilson 95% upper bound of 27.753%, far above the
preregistered 1% limit. The independently verified n=6 positive control still
shows a reachable move that `enforce` rejects and `observe` accepts, followed
by a repeatable six-transition loop.

## Frozen design and acceptance

- policies: Random, Greedy, Minimax-2, UCT-MCTS, a fixed-weight Topology
  AlphaZero engineering-smoke checkpoint, and bounded CycleSeeking;
- sizes: n=6 and n=7;
- five frozen seeds: `2111448885`, `1179994698`, `1147703047`, `2073532949`,
  and `281460105`;
- per cell: five seed blocks, two color orientations, and both rule modes;
- horizon: 120 plies; a horizon hit is truncated and never relabelled a draw;
- total: 12 cells, 60 blocks, 120 matched mode pairs, and 240 games.

The accepted attempt is `20260825T181100.857057Z_2b973f822cb6`. The independent
verifier returned `PASS` after replaying every action and checking 12
conditions, 60 blocks, 240 games, 62 journal records, the formal manifest, all
state digests and summaries, the positive control, and the frozen checkpoint.
No checkpoint or sidecar check was skipped.

## Per-cell results

W-D-L and score are from the focal policy's perspective against the keyed
Random anchor. They are not a round-robin strength ranking. Enforce and observe
were identical in every row.

| Focal policy | n | Enforce W-D-L | Observe W-D-L | E/O mean score | E/O mean plies |
| --- | ---: | ---: | ---: | ---: | ---: |
| Random | 6 | 5-0-5 | 5-0-5 | 0.50 / 0.50 | 14.2 / 14.2 |
| Random | 7 | 7-0-3 | 7-0-3 | 0.70 / 0.70 | 18.1 / 18.1 |
| Greedy | 6 | 10-0-0 | 10-0-0 | 1.00 / 1.00 | 10.0 / 10.0 |
| Greedy | 7 | 10-0-0 | 10-0-0 | 1.00 / 1.00 | 11.4 / 11.4 |
| Minimax-2 | 6 | 9-0-1 | 9-0-1 | 0.90 / 0.90 | 11.6 / 11.6 |
| Minimax-2 | 7 | 10-0-0 | 10-0-0 | 1.00 / 1.00 | 11.5 / 11.5 |
| UCT-MCTS | 6 | 8-0-2 | 8-0-2 | 0.80 / 0.80 | 13.0 / 13.0 |
| UCT-MCTS | 7 | 7-1-2 | 7-1-2 | 0.75 / 0.75 | 20.7 / 20.7 |
| Frozen Topology smoke | 6 | 10-0-0 | 10-0-0 | 1.00 / 1.00 | 13.2 / 13.2 |
| Frozen Topology smoke | 7 | 8-0-2 | 8-0-2 | 0.80 / 0.80 | 17.8 / 17.8 |
| CycleSeeking | 6 | 5-0-5 | 5-0-5 | 0.50 / 0.50 | 14.4 / 14.4 |
| CycleSeeking | 7 | 5-0-5 | 5-0-5 | 0.50 / 0.50 | 22.1 / 22.1 |

Every cell retained all 10 orientation pairs. For each cell:

- enforce and observe truncations were both `0/10`;
- trigger games, selected-repetition games, aligned triggers, and trajectory
  divergences were all `0/10`;
- winner agreement was `10/10`;
- `observe - enforce` mean score was 0 with a 10,000-resample hierarchical
  bootstrap interval `[0, 0]`;
- absolute and relative mean-ply effects were 0 with intervals `[0, 0]`; and
- the truncation-rate effect was 0 with interval `[0, 0]`.

The zero-width bootstrap intervals describe only these five deterministic seed
blocks. They do not establish a zero population effect. Pooling all policies
and sizes gives 0/120 observe trigger games, whose descriptive Wilson 95% upper
bound is still 3.102%; this pooled number is not used to rescue any failed
per-cell gate.

## Practical-similarity gates

All 12 cells had the same gate pattern:

- score-effect interval inside +/-0.05: pass;
- relative-length interval inside +/-0.05: pass;
- truncation-difference interval inside +/-0.01: pass;
- observe truncation Wilson upper bound below 0.01: fail (`0/10`, upper
  `0.2775328`); and
- complete gate: fail.

Accordingly, the defensible statement is limited to the absence of sampled
Superko effects under the named policies, sizes, seeds, budgets, and horizon.
The matrix does not pass its preregistered practical-similarity criterion.

## CycleSeeking diagnostic

CycleSeeking was a bounded stress policy, not a competitive baseline and not a
fixture-guided solver. It found no counterfactual cycle plan and used its
Random fallback on all 360 focal decisions.

| n / mode | Focal decisions | Plans | Fallbacks | Mean / max expanded nodes | Reached depth 4 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 6 enforce | 73 | 0 | 73 | 409.42 / 781 | 70/73 |
| 6 observe | 73 | 0 | 73 | 409.42 / 781 | 70/73 |
| 7 enforce | 107 | 0 | 107 | 470.92 / 781 | 104/107 |
| 7 observe | 107 | 0 | 107 | 470.92 / 781 | 104/107 |

The maximum 781 nodes is the complete depth-4, branch-5 tree, so the nominal
1,000-node budget did not bind. This is a bounded miss, not a proof that no
cycle is reachable. The separate fixture-guided positive control passed and
must not be described as CycleSeeking discovering the known witness.

## Frozen neural checkpoint boundary

The machine key `frozen-rl` refers only to a fixed-weight Topology AlphaZero
engineering-smoke artifact. It was trained at n=5 with one self-play game and
one gradient update. Evaluation at n=6/n=7 is out of distribution, and observe
mode is also a rule-mode override. These rows are loader and inference evidence,
not a paper-grade learned baseline or evidence about converged RL behavior.

## Failed-attempt lineage

Attempt 1 (`20260825T174713.323613Z_2b973f822cb6`) passed its manifest at
startup but detected a concurrent edit to
`lifeline_rl/alphazero/evaluation.py` at the end of the run. It failed closed,
wrote no formal JSON, and is excluded from every result above. Its journal is
retained without overwrite. Before inspecting formal outcomes, attempt 2 reused
the exact preregistered seeds, policies, and budgets under a newly frozen
manifest and reran the complete matrix from scratch.

Static import and call-graph review found no expected computational effect on
attempt 1 action selection: the edited arena-gating module had been loaded
before gameplay, was not reloaded, and is not called by game generation or
frozen-checkpoint inference. The attempt remains excluded because the formal
source-integrity rule failed, regardless of that forensic assessment.

## Artifacts

```text
accepted formal JSON:
  results/validation/superko_policy_matrix_five_seed_v1_attempt2.json
  SHA-256 b19739867173759a2edd5986d360520084bc9c8a9bbc31ac0fa40306a7345548

append-only block journal:
  results/validation/superko_policy_matrix_five_seed_v1_attempt2.json.blocks.jsonl
  SHA-256 630cf24bab3d825b8ebd82d86ee9cf3822c2c4430caf4b0af0e2d503a18412e0

formal manifest:
  configs/superko_policy_matrix_v1_attempt2_manifest.json
  SHA-256 d7df1541145e30401d299dd3bb59980195d6081a6eb6774473c48165dff0419b

verification receipt:
  results/validation/superko_policy_matrix_five_seed_v1_attempt2_verification.json

retry lineage:
  results/validation/superko_policy_matrix_attempt2_link.json
```

The run exited 0 in 1018.325 seconds. The accepted report contains 3,560 action
records. The full claim boundary and frozen design are in
`SUPERKO_POLICY_MATRIX_PROTOCOL.md`; that preregistration file is intentionally
left byte-for-byte unchanged after the accepted run.
