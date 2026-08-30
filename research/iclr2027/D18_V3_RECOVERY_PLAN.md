# D18-v3 paired-opening recovery plan

Status: **draft, zero execution, not authorized for a paid run**
Date: 2026-08-30

## Current checkpoint

The D17/D18-v1 execution is complete at 85/85 tasks and 8,320/8,320
independently replayed games. D17 passed 40/40 tasks. D18 passed 23/45 tasks
and failed its preregistered diversity gate in 22/45, so `formal_ready=false`.
D19 has not run and remains blocked.

A separate D18-v3 formal runner and independent verifier now exist as
review-only sources. They bind the preparation runner, execution runner,
verifier, complete source/checkpoint closure, task/game manifests, immutable
pair evidence, receipts, and a runner-side canonical numeric artifact. The
execution runner can report only `execution_complete` and
`runner_gate_passed`; only the independent verifier may set v3
`formal_ready=true`. All preparation and structural validation to date remains
zero formal games, zero model forwards, zero GPU actions, zero AutoDL actions,
and zero paid actions.

The checked-in AutoDL policy is deliberately `live_enabled=false`. Any stage
or job generated from it is a non-runnable review candidate, not launch
authorization.

The execution layer now carries an offline dependency assertion at
`autodl/d18_v3_runtime_requirements.lock.txt`. Its SHA-256 is
`2df94edd048e9aa9990bce302672f6c71f0845e70fd0be43fbbdd719d869473a`;
the hash is included in the stage and execution source closure. The AutoDL
`setup_revision` binds the full stage-manifest SHA-256, which transitively
binds this lock and every staged file. Product readiness validates that exact
stage closure before any paid API write, and remote setup validates it again
before execution. Nine semantic paths are cross-bound to their manifest
digests, job generation also compares all 93 rows with the exact local source
and bundle closure, and CPU readiness loads its runner, manifest, checkpoints,
and bundle from the immutable stage copy rather than the mutable worktree. The
job still probes exact Python 3.12, PyTorch 2.8.0, CUDA 12.8, and CUDA
availability.

Formal export is a closed 3,019-file evidence set. The runner rejects unknown
files, symlinks, stale destination content, source mutation, or a payload that
cannot fit inside a 448 MiB runner limit with a 4 MiB manifest reservation.
The remaining 64 MiB under the policy's 512 MiB limit is reserved for AutoDL
worker run metadata. Historical D18 action-length modeling projects about
174 MiB, but the 256-ply protocol does not imply a structural sub-512-MiB
upper bound; an unexpectedly large valid run therefore fails closed and may
remain only on the stopped instance's work disk for explicit recovery rather
than silently dropping evidence.

This plan is append-only relative to D18 D16-v2. It does not modify the frozen
v1 protocol, manifests, runner, receipts, thresholds, or result tree.

## Why v1 stays failed

The D17/D18 P0 process completed 85/85 tasks and 8,320/8,320 replay-verified
games, but D18 failed its preregistered diversity gate in 22/45 tasks. All 22
had fewer than 64 unique full trajectories; all 15 side-five tasks also had
fewer than 24 opening clusters with at least two distinct continuations.

Across all 45 D18 tasks, the slot-bound trajectory count is exactly 64 and the
color-agnostic full-trajectory count equals 32 plus the number of clusters with
two continuations. Under temperature 0 and no root noise, the second policy-
seed assignment at a fixed opening therefore did not provide a reliable second
trajectory. Repeating v1 with the same frozen inputs is expected to reproduce
the same gate outcome.

The authoritative v1 receipt ledger SHA-256 is
`09afc03cadfc54cc143d7049dfe78328c1665b3f698274c26a4dbf711c0f080a`.
The local independent report is `FAIL_CLOSED` and has SHA-256
`2c8c98d9a49593a85e2c39ee2f5f4d250593f53a0f9a18bbe4eb262e58ff985e`.

## Proposed estimand-preserving replacement

Create a new experiment ID, provisionally
`d18_d16_v3_paired_openings_formal_v1`, with a new protocol, explicit opening
manifest, task/game manifests, runner identity, and empty run root.

- Retain the same 3 model pairs, 5 matched training seeds, sizes 5/7/9,
  checkpoints, PUCT-16, `c_puct=1.5`, temperature 0, no root noise, Superko,
  and 256-ply limit.
- Retain 32 registered statistical strata per size. Each stratum contains two
  newly generated opening variants at the same prefix-depth stratum.
- Use one crossed policy-seed assignment and one swapped-color pair per opening
  variant. Two variants therefore retain four games per stratum.
- Retain 128 games per task, 45 tasks, and 5,760 games total.
- Retain the original gates without relaxation: at least 64 unique full
  trajectories, at least 32 unique prefix-stripped continuations, at least
  24/32 strata with two continuations, complete replay, and zero truncations.
- Retain the `training seed x 32 opening stratum` statistical unit and the
  frozen crossed-cluster bootstrap and seed-t intervals.

The 192 explicit openings must all be legal, nonterminal, PASS-free,
auto-skip-free, prefix/state unique, and disjoint from the 96 v1 openings.
Opening generation may read only the game rules and fixed generation seeds; it
must not read checkpoints, policy priors, v1 outcomes, or v1 trajectories.

## Zero-execution gate

Before any formal game or paid API write:

1. Freeze the new protocol, opening generator inputs, manifest, source hashes,
   and a new runner file; do not edit the v1 runner whose hash is receipt-bound.
2. Verify exactly 192 openings, 45 tasks, 5,760 games, 2 variants per stratum,
   paired colors, and the unchanged statistical contract.
3. Run source/manifest self-tests and an exact dry-run that executes zero
   formal games. The task-shaped CPU readiness that loads all 15 checkpoints
   and performs real forwards is invoked once by the future product command
   before any paid API write; do not invoke it manually during candidate
   preparation.
4. Record the frozen Git commit and all protocol/config/runner hashes.
5. Estimate wall time from a task-shaped smoke and confirm at least a 2x wall-
   clock envelope.

## Paid-run stop rule

Do not start AutoDL, create or change an instance, or incur a new charge until
the user confirms the exact reusable instance or card, live hourly price, and
maximum total RMB cost. Only the 45 D18-v3 tasks are candidates for rerun; the
passed D17 run is not repeated. D19 remains blocked until the new D18 gate and
independent canonical comparison both pass.

If v3 fails, preserve it as another fail-closed run. Any further design change
must use a new protocol and experiment ID rather than post-hoc threshold or
opening selection.

## Budget and exact-instance blockers

At the sampled price of 2.880 RMB/hour, a 9,000-second product command is 7.20
RMB. AutoDL Runner Direct 1.15.0 has no per-job total-cost hard cap: startup,
probe, transfer, delivery, idle grace, and shutdown time are not covered by a
currency counter, and `min_balance_milliyuan` is only a wallet-balance
precondition. Therefore the `d18_v3_10yuan` policy name is not proof of a
10-RMB maximum.

The prior 5,760-game run took about 1.6 hours. A preregistered 2x wall-clock
envelope is about 11,520 product seconds (9.216 RMB before overhead), so the
9,000-second candidate does not satisfy the 2x gate. A planning ceiling of at
least 12 RMB is recommended, but it is still not a technical currency hard
cap in runner version 1.15.0.

The product also treats `preferred_instance_uuid` as a tie-break rather than a
hard filter on its READY-session fast path. Before a single future `run`, the
local registry must contain no compatible READY session, the provider must
show only `pro-788096a9e3b2` as the intended stopped 5090-P, and the live price
must be at most 2.880 RMB/hour. Any stale/ambiguous/extra session, failed live
read, or price increase blocks launch. Never use `reap --live`, stop, or
release another instance as an automatic workaround.
