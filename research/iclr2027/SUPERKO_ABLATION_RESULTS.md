# Superko counterexample and rule-ablation results

## Bottom line

Superko is semantically necessary on side length 6: a standard-start legal trajectory reaches a move that Superko rejects, while the non-enforcing dynamics admit the move and close a repeatable six-transition cycle. Therefore the two rule systems are not equivalent.

They were nevertheless empirically very similar under one fixed attack-biased plus voluntary-PASS random policy. In a canonical common-random-number pilot with 2,000 paired episodes at each of side lengths 6 and 7, all pre-specified practical-similarity gates passed. This is a policy-, size-, seed-, and horizon-conditional engineering result, not a proof that Superko can be removed.

## Natural side-six witness

From the standard 6x6 initial state, replay:

```text
B(0,1), W(4,0), B(2,0), W(1,4), B(2,3),
W(2,2), B(3,1), W(1,4), B PASS, W(1,1),
B(2,3) -> SUPERKO_VIOLATION
```

The loop is:

```text
W(2,2) -> B(3,1) -> W(1,4) -> B PASS -> W(1,1) -> B(2,3)
```

With `superko_mode="observe"`, the loop returns exactly to the position after the first `B(2,3)`: board, both logical-edge sets, player to act, consecutive-PASS count, and terminal flag all match. It can be replayed again. With `superko_mode="enforce"`, the final move is transactionally rejected.

Frozen evidence:

- witness: `state_aliasing/superko_n6_witness_v1.json`;
- source search artifact: `results/validation/superko_random_n6_seed20260826.json`;
- source SHA-256: `EFB6BF27D35E8894D9F8C749C8C86765CBCF957060B55AA8456C006051A84CA0`;
- stage-position digest: `c1362c7a100c1c512e2345740f4d9cbd1c34c12b7ab708d65dac681365c14608`.

This is a natural trigger and a counterfactual history-dependence witness. It is not a pair of two Superko-legal natural histories with identical mask-free Topology and different legality, and it is not a global shortest-cycle proof.

## Canonical paired pilot

The schema-v2 runner assigns every concrete point a shared keyed SHA-256 priority at each paired ply. This avoids the action-set-size remapping present in the earlier exploratory rank coupling. Truncations remain a fourth outcome and are never scored as draws.

Configuration:

- sizes: 6 and 7;
- 2,000 paired episodes per size;
- horizon: 120 plies;
- base seed: `20260826`;
- voluntary-PASS probability: `0.12`;
- attack bias: `0.95`;
- 10,000 episode-level paired bootstrap resamples;
- coupling: `canonical_keyed_action_priority_v1`.

| Measure | n=6 | n=7 |
| --- | ---: | ---: |
| Superko-trigger episodes | 0/2,000 | 2/2,000 |
| Trigger-rate Wilson 95% CI | 0%-0.1917% | 0.0274%-0.3639% |
| Observe selected a repetition | 0 episodes / 0 actions | 1 episode / 2 actions |
| Trajectory divergences | 0/2,000 | 1/2,000 |
| Winner agreement | 2,000/2,000 | 2,000/2,000 |
| Enforce B/W/D | 1,020/948/32 | 1,043/934/23 |
| Observe B/W/D | 1,020/948/32 | 1,043/934/23 |
| Truncations, either mode | 0 | 0 |
| Mean plies, enforce / observe | 17.3725 / 17.3725 | 24.5780 / 24.5755 |
| Relative mean-ply difference | 0 | -0.01017% |
| Relative-ply bootstrap 95% CI | [0, 0] | [-0.03076%, 0] |
| Mean Black-score difference | 0 | 0 |
| Nonzero Black-score differences | 0/2,000 | 0/2,000 |

For n=7, the trigger episodes were 929 and 1524. Only episode 1524 diverged: at paired ply 15, enforce selected `(2,0)` and observe selected the repeated action `(1,1)`. The trajectories then differed, but both still ended in a White win. Observe used five fewer plies in that episode, producing the very small aggregate length difference above.

## Gate assessment

The internal margins were fixed before inspecting the first 2,000-episode output: Black-score difference within +/-5 percentage points, relative mean length within +/-5%, truncation-rate difference within +/-1 percentage point, and observe truncation-rate Wilson upper bound below 1%.

- Outcome score: pass for this pilot. Every paired winner matched. The percentile bootstrap is `[0,0]`, but that zero-width interval is not treated as population certainty; the Wilson 95% upper bound for a nonzero score-difference episode is 0.1917% at both sizes.
- Game length: pass. The canonical n=7 relative interval is `[-0.03076%, 0]`, far inside +/-5%; n=6 has no observed length difference.
- Truncation: pass. Both modes had 0/2,000 truncations at both sizes; the per-mode Wilson upper bound is 0.1917%, below 1%.

Thus the defensible statement is:

> Superko has a real, naturally reachable semantic effect and prevents a repeatable cycle. Under this one attack-plus-PASS policy on side lengths 6 and 7 with a 120-ply horizon, its observed effect was rare and the paired outcome and length effects fell inside the frozen practical-similarity margins.

Do not replace this with “the rules are equivalent”, “Superko can be deleted”, or “trained agents will be unaffected”.

## Fresh-seed multi-policy extension

The preregistered follow-up is now complete and independently verified. It used
five fresh seeds, both color orientations, n=6/n=7, and six focal conditions:
Random, Greedy, Minimax-2, UCT-MCTS, a fixed-weight Topology AlphaZero
engineering-smoke checkpoint, and bounded CycleSeeking. The accepted matrix
contains 12 cells, 60 seed blocks, 120 matched mode pairs, and 240 games.

No sampled game exposed a Superko candidate, selected a repetition, diverged
between `enforce` and `observe`, or truncated. Every per-cell score, relative
length, and truncation-difference estimate was zero with a descriptive
hierarchical-bootstrap interval `[0,0]`. However, all 12 complete practical-
similarity gates **failed**: each cell has only 10 observe games, and `0/10`
truncations has a Wilson 95% upper bound of 27.753%, above the frozen 1%
threshold. This small extension therefore does not inherit the gate-passing
claim of the earlier 2,000-pair pilot.

CycleSeeking found zero plans and used its Random fallback on all 360 focal
decisions. That is a depth-4, branch-5 bounded miss, not evidence that cycles do
not exist. The known n=6 fixture-guided positive control still passes and
establishes that the two rule systems are semantically different. The neural
rows use an n=5 checkpoint trained with one self-play game and one gradient
step; they are engineering smoke, not a paper-grade learned baseline.

Full per-cell results, retry lineage, hashes, and the independent replay receipt
are in `SUPERKO_POLICY_MATRIX_RESULTS.md`.

## Artifacts and verification

Canonical artifact:

```text
results/validation/superko_ablation_n6_n7_canonical_pilot_20260825.json
SHA-256 4F31ECB8F53ADD3151CE0B879CB3C9AD296F21C5D4B6B9553A9E6DD21221EE09
```

Runner:

```text
scripts/run_superko_ablation.py
SHA-256 38FD1D436F7AB9C416BD540C09969BC99646BC16A051D292D855E02916AC162F
```

The artifact contains 4,000 unique episode records, finite-value checks, four-class outcome contingency tables, all-pair truncation sensitivity bounds, and first-divergence actions plus shared randomness. The run exited 0 in 541.388 seconds. Superko-specific tests passed 16/16; the live repository discovery passed 102 tests with eight optional PyTorch-dependent skips.

The earlier rank-coupled artifact, `superko_ablation_n6_n7_pilot_20260825.json`, is retained as exploratory evidence only. Its coupling was revised after audit, and it must not supply the primary pathwise-divergence claim.

## Paper-level next step

The five-seed Random/Greedy/Minimax/MCTS/frozen-smoke/CycleSeeking extension is
complete, but it is underpowered at 10 observe games per cell and its neural
condition is not trained to paper quality. The remaining paper-level work is a
powered replication with genuinely trained frozen checkpoints and a stronger
cycle-directed policy or conditional witness-prefix evaluation. `observe`
still maintains history for diagnostics, so neither existing experiment
measures the runtime savings of a genuinely history-free `off` implementation.
