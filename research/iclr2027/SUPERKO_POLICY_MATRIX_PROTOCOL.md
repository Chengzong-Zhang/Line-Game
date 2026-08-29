# Fresh-seed Superko policy-matrix protocol

Status: budget-frozen internal preregistration, updated on 2026-08-26 after one
timing-only dry-run and before any of the five fresh seed roots were executed.
The dry-run was used only for completion-time feasibility. This document
contains no five-seed policy-matrix results.

## Question and scope

Compare `superko_mode="enforce"` with `superko_mode="observe"` on side lengths
6 and 7 under six fixed policy conditions:

1. uniform Random;
2. one-step Greedy;
3. Minimax-2;
4. adversarial UCT-MCTS;
5. one frozen Topology AlphaZero engineering-smoke checkpoint; and
6. a bounded, generic CycleSeeking stress policy.

Every focal policy is anchored against Random and evaluated in both color
orientations. Random itself is the role-labelled Random-versus-Random control.
This is not a round robin. The primary comparison is always the paired
`observe - enforce` difference for the same policy, board size, formal seed,
replicate, and color orientation.

`observe` retains the complete history and records repetitions, but permits an
otherwise-Superko-forbidden point move. It is therefore a semantic rule
ablation, not a benchmark of a genuinely history-free `off` implementation.

## Frozen formal seeds

For integer `i` from 0 through 4, define

```text
message_i = UTF8("superko-policy-matrix-v1|" + decimal(i))
digest_i  = SHA256(message_i)
seed_i    = int.from_bytes(digest_i[0:4], byteorder="big") & 0x7fffffff
```

The resulting formal seed roots are fixed in this order:

| i | SHA-256 prefix | seed |
| ---: | --- | ---: |
| 0 | `fdda2735` | `2111448885` |
| 1 | `46554a4a` | `1179994698` |
| 2 | `c4688f07` | `1147703047` |
| 3 | `fb979a15` | `2073532949` |
| 4 | `90c6bd89` | `281460105` |

These seeds must not be used for smoke tests, budget selection, debugging, or
fixture development. A formal seed cannot be dropped or replaced after its
outcome is known. Any failed run is retained as a failed run and rerun under a
new, explicitly linked attempt identifier without overwriting the first
artifact.

Decision seeds use domain-separated SHA-256 over the experiment version,
formal root, replicate index, board size, policy, orientation, agent slot,
acting color, and paired ply. The Superko mode must **not** enter that
derivation: enforce and observe receive identical policy/search seeds within
the same orientation. The two color-swap orientations intentionally use
distinct deterministic substreams.

## Match construction and pairing

For each policy `P`, size `n in {6, 7}`, formal seed, and replicate:

- orientation 0 plays `P` as Black and Random as White;
- orientation 1 plays Random as Black and `P` as White;
- each orientation is run once with `enforce` and once with `observe`;
- the two modes begin from the same standard initial state and use the same
  agent-specific stochastic substreams; and
- an enforce Black game is paired only with the observe Black game of the same
  orientation, never with the color-swapped game.

For the Random condition, the two agents remain role-labelled focal and anchor
Random policies. The color swap exchanges their board colors while preserving
their roles; its orientation-labelled deterministic substream is distinct,
even though both roles implement the same policy.

Random choices use candidate-set-independent keyed priorities, so introducing
one observe-only repetition cannot remap the same random variate to a different
shared ordinary action. UCT rollouts and neural PUCT receive the same search
seed in the two modes. Their trees may legitimately differ once their legal
sets or trajectories differ. The runner records the exact coupling version
and all derived substream seeds.

All games have a fixed horizon of 120 plies. Hitting that horizon is
`truncated`, not a draw. There are no wall-clock move cutoffs in a formal game;
resource failure produces a failed episode rather than a game outcome.

## Frozen policy definitions

### Non-learning policies

- **Random** samples uniformly from all legal point actions plus PASS, using
  the keyed coupling above.
- **Greedy** uses the already frozen one-step heuristic and canonical
  deterministic tie-break described in `BASELINES.md`.
- **Minimax-2** uses depth 2, alpha-beta pruning, the frozen Greedy heuristic at
  depth-cutoff leaves and exact outcomes at terminal leaves, the frozen move
  ordering, at most 20 point moves per node, and PASS as the additional branch.
- **UCT-MCTS** uses the frozen adversarial UCT implementation, uniform random
  rollouts, no learned policy/value, no transposition merging, exploration
  constant `sqrt(2)`, and seeded final tie-breaking. It uses 16 simulations
  per move and rollout depth 24 as frozen in the budget table below.

No heuristic, tie-break, move cap, or opponent may be changed after formal
results are inspected.

### Frozen Topology AlphaZero smoke checkpoint

The only neural policy admitted to this matrix is the existing local artifact:

```text
results/smoke/alphazero/d9_d10_topology_smoke_verified_seed20260825/
  checkpoints/checkpoint_000001.pt
checkpoint SHA-256:
  24fc1e93b74b64e2fdcd79f126f14377916557ac4e1b770b57662a1fe77dc423
training source SHA-256:
  90fffac7a50fdcf25b5d2fcd2bcb8e109d176fa261ef6766715f87e2b95124df
training config SHA-256:
  4941d9d2c45615592672dacfa7624f2095d045dc74f48a7df6b8eb464bf253fd
```

This checkpoint was trained on side length 5 only, with Topology observation,
`superko_mode="enforce"`, **one self-play game, and one gradient step**. It is
an engineering smoke artifact, not a paper-grade trained RL checkpoint.

Evaluation on n=6 and n=7 is fixed-weight rule extrapolation: load exactly the
weight bytes above, use the same shared topology/message-passing rule on the
larger graphs, and perform no fine-tuning, calibration, replay update, or
weight selection. The identical weights are used in enforce and observe. The
observe evaluation is an explicit, logged evaluation-time Superko override;
it does not retroactively make the training rule observe-mode.

Neural action selection uses evaluation-only PUCT on CPU with `c_puct=1.5`,
four simulations per move, temperature 0, and no Dirichlet/root noise. Before
formal execution, the loader or compatibility adapter must pass fixed-weight
n=6/n=7 inference tests and its source SHA-256 must be frozen in the run
manifest. Loading requires an explicit legacy source-migration waiver: the
saved source hash remains frozen, the current source hash is recorded, and the
weight SHA-256 must remain unchanged. Checkpoint bytes, training manifest and
config, representation metadata, parameter count, and adapter source digests
are verified. If the exact artifact cannot be loaded without changing its
weights, this cell is reported as blocked; no replacement checkpoint may be
silently substituted.

### Generic CycleSeeking stress policy

CycleSeeking is a diagnostic adversary, not a strength baseline. At each move
it first identifies an immediately selectable repetition in observe mode; if
none exists, it searches a cloned observe-mode counterfactual with finite
depth, branch, and node limits. Attack, PASS, and high repetition-potential
successors may be search-order priorities. The search must not mutate the
input game, and every returned root action must be legal in the actual mode.

The policy receives no witness coordinates, witness prefix, saved witness
state, or hard-coded n=6 action sequence in the main matrix. Its depth, branch,
node, and fallback settings are frozen only after the timing dry-run. A miss
means only that this implementation did not find a repetition within those
limits.

## Budget freeze after timing dry-run

The following values are frozen for the five-seed engineering extension:

| Budget field | Frozen value |
| --- | --- |
| Formal replicate blocks per seed, Random | `1` |
| Formal replicate blocks per seed, Greedy | `1` |
| Formal replicate blocks per seed, Minimax-2 | `1` |
| Formal replicate blocks per seed, UCT-MCTS | `1` |
| Formal replicate blocks per seed, neural smoke | `1` |
| Formal replicate blocks per seed, CycleSeeking | `1` |
| UCT simulations per move | `16` |
| UCT rollout depth | `24` |
| Neural PUCT simulations per move | `4` |
| CycleSeeking maximum depth | `4` |
| CycleSeeking branch limit | `5` |
| CycleSeeking node budget per move | `1000` |
| CycleSeeking fallback | `random` |

One block comprises both color orientations and both rule modes, hence four
games. Each policy-by-size cell therefore contains five independent seed
blocks, ten games per mode, and twenty games total. This is intentionally a
fresh-seed engineering extension, not the 300-block design needed for a zero
event rate to have a one-sided 95% upper bound below 1%.

The timing-only artifact used the disjoint seed `1266014321`, completed all 12
policy-by-size blocks in 199.183 seconds, and is stored at:

```text
results/smoke/superko_policy_matrix/
  superko_policy_matrix_dryrun_all_n6_n7.json
SHA-256:
  4e6f8ca9afd241728e5c217e7ad182f9fbdcc99cbf997cad130524074627219c
runner SHA-256 at dry-run:
  2309f7a5e3780eee9bd4f2f0c4b650ae0bf3252745e27a22fb42302ad7b361e6
```

The CycleSeeking blocks dominated wall time (37.14 seconds at n=6 and 133.59
seconds at n=7); the retained 1,000-node budget preserves the stronger stress
configuration while keeping the complete five-seed extension bounded. These
times, rather than wins or trigger outcomes, determined the replicate count.

After that timing-only run, the runner received instrumentation, statistical
summary, provenance, formal-manifest, block-journal, and independent-verifier
changes. No formal seed, policy definition, search budget, or intended
game-generating setting changed. A disjoint-seed n=6 preflight covering Random
and the frozen neural smoke policy reproduced all eight corresponding action
traces from the timing artifact and was independently replayed successfully:

```text
results/smoke/superko_policy_matrix/
  superko_policy_matrix_revised_runner_preflight.json
SHA-256:
  2e764f5307c3543a4bb68a62ceb482360ced1bc42d352dbe8083ea20d14c0379
formal-runner SHA-256 before manifest freeze:
  249ce4e63ba511d2d7cd29ba89c0b4f6dd91375cc175a4ef7cc45da56292eed4
independent-verifier SHA-256:
  0c7bb0fe56a4c1e65115633e608e5b59ab100bc792c5d467373d43193a58c1e2
```

The original `2309f7...` runner digest identifies only the timing artifact.
The formal manifest, generated after the final regression suite, is the
authoritative source freeze for formal execution.

One non-formal seed outside the five-seed set may be used to measure wall time,
memory, node counts, and completion feasibility. The dry-run output is stored
under `results/smoke/`, is never pooled with formal data, and must not be used
to choose budgets based on wins, trigger frequency, trajectory differences, or
whether a desired conclusion appears. The budget table, dry-run artifact hash,
runner hash, and hardware/runtime manifest are frozen before the first formal
seed is launched. Any subsequent source change must be recorded by the run
artifact and prevents silently pooling the affected run with this protocol
version.

## Separately labelled fixture-guided n=6 positive control

The frozen natural witness in
`state_aliasing/superko_n6_witness_v1.json` is replayed as a
**fixture-guided positive control** outside the policy matrix. The check must
establish all of the following:

1. the stored prefix is legal from the standard n=6 initial state;
2. enforce mode transactionally rejects the closing point move with
   `SUPERKO_VIOLATION`;
3. observe mode accepts that same move;
4. the documented six-transition loop returns exactly to the same
   rule-relevant position and can be repeated; and
5. the matrix instrumentation records the candidate, selected repetition, and
   resulting divergence on this supplied path.

This check is expected detector sensitivity, not a sampled episode. It is not
included in rates, confidence intervals, wins, or policy comparisons. Supplying
the path to this helper must remain visibly separate from generic
CycleSeeking. Passing the fixture cannot be described as the generic agent
discovering the cycle.

## Episode records and metrics

The atomic statistical and audit unit is a complete paired episode, nested
within its formal seed. Plies, search nodes, and repeated visits are not
independent samples. Every episode record retains the full actions, acting
players, policy/search seeds, orientation, mode, terminal reason, and first
relevant event.

Report the following separately for every policy-by-size cell and for every
formal seed before any pooled summary:

- number attempted, completed, failed, and truncated in each mode;
- Black/White/draw/truncated counts and focal-agent W/D/L/score after
  orientation normalization;
- paired outcome contingency, exact outcome agreement, and nonzero paired
  focal-score differences;
- mean/median plies in each mode, paired ply difference, and relative mean-ply
  difference using enforce mean plies as denominator;
- aligned Superko-trigger episodes and plies, where a still-paired state first
  exposes at least one observe-legal action rejected by enforce;
- observe episodes/actions in which the policy actually selects a repetition;
- first action/state trajectory divergence and whether it occurs at a
  Superko-different legal set;
- post-divergence repetition candidates and selections on each trajectory,
  kept distinct from aligned triggers;
- exact repeated-state/cycle-closure digests when a cycle is detected;
- CycleSeeking plans found, reasons, nodes expanded, maximum depth reached,
  and fallbacks; and
- UCT/neural PUCT simulation counts, root visits, decision time, and any
  non-finite diagnostic.

All finite-value, action-legality, input-nonmutation, replay, and artifact-hash
checks must pass. Counts must reconcile from episode records to seed summaries
and from seed summaries to the matrix summary.

Truncated games are never relabelled as draws. Score effects use only pairs in
which both modes terminate normally, with the retained-pair fraction reported.
Also report all-pair worst/best-case sensitivity bounds that assign truncated
or failed members adversarially. Length and truncation effects retain all
successfully executed paired games as appropriate.

## Estimation and practical-similarity gates

For event rates, report numerator/denominator and Wilson 95% intervals,
including when the numerator is zero. For paired effects, report all five
seed-level estimates and a 10,000-resample 95% paired bootstrap that resamples
seed blocks and then complete paired episodes within selected seed blocks. Do
not bootstrap plies or search nodes as if they were games. These intervals are
descriptive with only five seed roots; no zero-width interval proves a zero
population effect.

For each n=6/n=7 cell, practical similarity under a sampled policy may be
stated only if all previously used margins pass:

1. the 95% interval for `observe - enforce` focal-agent mean outcome score is
   wholly inside `[-0.05, +0.05]`;
2. the 95% interval for the mean ply difference divided by enforce mean plies
   is wholly inside `[-0.05, +0.05]`; and
3. the 95% interval for the truncation-rate difference is wholly inside
   `[-0.01, +0.01]`, while the observe truncation-rate Wilson upper bound is
   below `0.01`.

Trigger, selected-repetition, divergence, agreement, retained-pair, and
sensitivity statistics are mandatory mechanism diagnostics and cannot replace
these gates. No pooling across policies or sizes may hide a failed cell.

The four ordinary non-learning cells (Random, Greedy, Minimax-2, and UCT-MCTS)
may support only a policy-family-conditional robustness statement if every
named cell passes. The neural-smoke cell is reported as engineering evidence
regardless of its gate result. CycleSeeking is an adversarial stress test and
is reported separately rather than folded into an ordinary-policy similarity
claim.

## Claim boundary

Allowed, conditional on the recorded results, is wording of the form:

> Under the named policies, side lengths, five fresh seed roots, frozen search
> budgets, color swaps, and 120-ply horizon, the paired empirical effects of
> enforcing versus observing Superko were [reported estimates], and the stated
> practical-similarity gates [passed or failed].

The experiment may not establish or imply any of the following:

- that enforce and observe define equivalent games;
- that the game without history is Markov with respect to the current visible
  encoding;
- that Superko can be deleted safely for all policies or trained agents;
- that a zero observed trigger rate proves cycles do not exist;
- that a bounded CycleSeeking miss proves no reachable cycle exists;
- that `observe` measures the runtime or memory benefit of removing history;
  or
- that the one-game, one-gradient-step smoke checkpoint is a paper-grade RL
  result or evidence about converged learned play.

The natural n=6 witness already demonstrates a reachable semantic difference.
This matrix asks how often and how consequentially that difference appears
under specified policies; it does not reopen the rule-equivalence question.

## Artifact freeze and failure policy

Before formal execution, write a machine-readable manifest containing the
resolved budget values, all runner and library SHA-256 digests, and the exact
checkpoint path, weight digest, saved training-config digest, and saved source
digest. The full result additionally records Python and Torch versions, CPU
device choice, current AlphaZero source digest, migration waiver, model
metadata, and every agent configuration. The runner must refuse formal mode if
a formal seed is missing or duplicated, any frozen budget or policy cell
differs, the checkpoint path or identity differs, an explicit migration waiver
is absent, the output or journal already exists, or any required source digest
differs.

Formal output uses an exclusive-create full JSON artifact plus an append-only
block journal. Each committed block record contains all four complete episode
records; a hard interruption may lose the currently uncommitted block, but it
cannot silently turn a partial block into an outcome. The successful receipt
must contain 12 conditions, 60 blocks, 240 replayed games, 62 journal records,
one verified checkpoint, and an independent verifier `PASS` without skipped
file or sidecar checks. Smoke data, fixture-positive-control data, and formal
matrix data use separate directories and are never silently combined. Any
deviation is documented before reading the affected outcome and produces a new
protocol version rather than an in-place reinterpretation.
