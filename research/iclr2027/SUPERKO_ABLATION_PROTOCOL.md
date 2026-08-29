# Superko ablation protocol

Status: analysis plan frozen on 2026-08-25 before inspecting the 2,000-episode-per-size pilot output. The earlier 100-episode smoke result was already known, so this is an internal pilot protocol rather than an externally preregistered confirmatory study.

## Question and scope

For the fixed attack-biased plus voluntary-PASS policy implemented by `scripts/run_superko_ablation.py`, compare `superko_mode="enforce"` with `superko_mode="observe"` on board sizes 6 and 7. The two modes receive common random numbers at every paired ply. `observe` records repetitions but permits them.

The target claim is deliberately narrow: *the two modes have practically similar empirical outcomes under this policy, these board sizes, and this rollout budget*. The experiment can never establish rule equivalence, because `state_aliasing/superko_n6_witness_v1.json` is a natural reachable counterexample and the no-enforcement rule admits an indefinitely repeatable cycle.

## Original frozen pilot invocation

The following command produced the exploratory schema-v1 artifact with the pre-audit runner. The schema-v1 artifact did not record its script hash, and the current runner now implements the schema-v2 canonical coupling, so rerunning this command from the current tree will not reproduce the old file byte-for-byte. The old artifact is retained only for audit history.

```powershell
python -B .\research\iclr2027\scripts\run_superko_ablation.py --sizes 6 7 --episodes 2000 --max-plies 120 --seed 20260826 --pass-probability 0.12 --attack-bias 0.95 --progress --summary-only --output .\research\iclr2027\results\validation\superko_ablation_n6_n7_pilot_20260825.json
```

Inference resamples complete episodes, not within-game decision states. Truncated games remain a separate outcome and are never relabelled as draws.

## Practical-similarity gates

Report all gates separately for each board size. The phrase “practically similar under the sampled policy” is allowed only if all of the following hold:

1. The 95% paired-bootstrap interval for `observe - enforce` mean Black outcome score lies wholly inside `[-0.05, +0.05]`. This endpoint uses only pairs in which both games terminate, and the retained-pair fraction must also be reported.
2. The 95% paired-bootstrap interval for the mean ply difference, divided by the enforce mean plies, lies wholly inside `[-0.05, +0.05]`.
3. The 95% paired-bootstrap interval for the truncation-rate difference lies wholly inside `[-0.01, +0.01]`, and the Wilson 95% upper bound for the observe truncation rate is below `0.01`.
4. Trigger, selected-repetition, trajectory-divergence, winner-agreement, and candidate-share statistics are reported even when they are zero. They are mechanism diagnostics, not substitutes for the outcome gates.

A zero-event nonparametric bootstrap interval is not treated as proof of a zero population effect. The episode-level Wilson interval and the explicit counterexample must accompany any such result.

## Post-audit coupling addendum

The first 2,000-episode output was inspected and is retained as exploratory evidence only. It used `floor(U * number_of_candidates)` independently in each action set. Although each mode had the intended marginal policy, adding one legal action could remap the same `U` to a different shared ordinary action, so pathwise divergence depended on candidate ordering and that coupling choice.

Before the canonical rerun was inspected, the coupling was changed to `canonical_keyed_action_priority_v1`: every concrete point receives a shared, set-independent SHA-256 priority at each paired ply. Adding a lower-priority action leaves the selected shared action unchanged. The revised schema-v2 artifact also records the coupling definition, script SHA-256, first-divergence actions, four-class outcome contingency, all-pair truncation sensitivity bounds, nonzero score-difference event rates, and relative mean-ply bootstrap intervals.

The canonical rerun uses the same gates above and writes to:

```powershell
python -B .\research\iclr2027\scripts\run_superko_ablation.py --sizes 6 7 --episodes 2000 --max-plies 120 --seed 20260826 --pass-probability 0.12 --attack-bias 0.95 --progress --summary-only --output .\research\iclr2027\results\validation\superko_ablation_n6_n7_canonical_pilot_20260825.json
```

Because the coupling was revised after inspecting the exploratory run and the base seed was reused, the canonical run is still an engineering validation, not a confirmatory or externally preregistered equivalence study.

## Paper-level follow-up

The 2,000-episode run is an engineering pilot. A paper-level robustness claim requires multiple independently seeded runs and at least one learned-policy or search-policy evaluation, because a single hand-designed random policy may systematically avoid the rare cycle. The Superko witness, source artifact hash, exact replay tests, and the enforce/observe implementation remain valid independently of this empirical ablation.
