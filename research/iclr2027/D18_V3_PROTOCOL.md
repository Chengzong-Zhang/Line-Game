# D18-v3 paired-opening zero-execution protocol

Protocol ID: `d18_v3_paired_openings_zero_execution_20260830_v1`
Experiment ID: `d18_d16_v3_paired_openings_formal_v1`
Status: **frozen preparation contract; no formal game or paid run authorized**

This protocol is a new, prospective experiment. It does not replace, edit,
relabel, re-aggregate, or relax D18/D16-v2. The v1 protocol, manifests,
receipts, failed diversity gates, and result tree remain immutable evidence.

## 1. Scientific scope

D18-v3 tests the same three frozen representations on a larger, explicitly
registered opening distribution while preserving deterministic evaluation.
The supported claim, if every future formal gate passes, is limited to paired
differences on this frozen v3 opening distribution. It is not a global model
ranking and does not retroactively make v1 pass.

The following inputs are unchanged from v1:

- fifteen `gradient_steps=200` checkpoints: three representations by five
  matched training seeds `20260825..20260829`;
- model pairs Padded-CNN/Grid-GNN, Padded-CNN/Topology-GNN, and
  Grid-GNN/Topology-GNN;
- evaluation sizes 5, 7, and 9;
- PUCT-16, `c_puct=1.5`, temperature 0, and no root noise;
- Superko `enforce`, BLACK start, and a 256-ply limit;
- the seed-by-opening statistical contract, bootstrap settings, and all three
  diversity thresholds.

No checkpoint may be fine-tuned, converted, merged, substituted, or selected
using v1 outcomes.

## 2. Prospective paired-opening registry

Each size has 32 statistical strata. Every stratum contains two independently
generated opening variants at the same target prefix depth. Depths 2, 4, 6,
and 8 each contain eight strata, so each size has 64 openings and the complete
registry has 192 openings.

The generator may read only:

1. the frozen game rules;
2. its fixed seed namespace and rejection rules; and
3. the 96 v1 prefix/state hashes solely to enforce disjointness.

It must not import or load a checkpoint, run a policy forward, inspect priors,
read v1 game trajectories or outcomes, or reject an opening based on expected
model behavior. An opening is accepted only when all of the following hold:

- the exact target depth is reached with legal point actions only;
- PASS is absent;
- the state remains nonterminal after every action and at prefix end;
- players alternate after every action, with `consecutive_skips=0`;
- its prefix SHA-256 and complete state SHA-256 are unique across all 192 v3
  openings; and
- both hashes are disjoint from all 96 frozen v1 openings.

The opening manifest stores explicit action indices and coordinates, base and
effective generation seeds, rejection attempt, prefix/state hashes, PASS
index, current player, turn count, and legality flags. Its generator path and
SHA-256 and the v1 opening-manifest path and SHA-256 are bound in the file.

## 3. Frozen task and game matrix

The formal design has exactly:

`3 model pairs x 5 matched training seeds x 3 sizes = 45 tasks`.

Within one task:

- there are 32 strata and two opening variants per stratum;
- variant 0 uses policy-seed assignment A=low/B=high;
- variant 1 crosses the assignment to A=high/B=low;
- each variant has one paired color swap; and
- the policy seed follows the agent identity across the color swap.

Thus each stratum contains four games, each task contains 64 color pairs and
128 games, and the complete prospective run contains exactly 5,760 games.
All tasks reuse the same registered opening, policy-seed, and color schedule.

Task and game manifests must bind the v3 protocol, opening manifest, formal
manifest, generator, preparation runner, and frozen checkpoint identities by
SHA-256. A bundle directory must be empty and is never overwritten.

## 4. Unchanged formal gates

Every future 128-game task must satisfy all of the following:

- at least 64 unique full trajectories under the v1 key
  `size + opening prefix + continuation`, ignoring color-slot labels;
- at least 32 unique prefix-stripped continuations;
- at least 24 of 32 registered strata with two distinct continuations;
- 128/128 complete and independently replayable records; and
- zero truncations.

The distinct v3 prefixes make the full-trajectory floor structural. It is not
by itself evidence of behavioral diversity; both unchanged continuation gates
remain binding. Slot labels must never mechanically increase a gate count.

Any missing task, failed replay, altered hash, incomplete seed, truncation, or
diversity failure sets `formal_ready=false`. Thresholds may not be lowered or
reinterpreted after observing v3.

## 5. Unchanged statistical contract

The basic cell is `training seed x opening stratum`. A stratum retains its two
opening variants and both color directions, so its four games form one equal-
weighted cluster mean. Every model difference is paired on training seed,
stratum, opening variant, policy seed, and color schedule.

The primary interval remains the frozen 20,000-replicate two-way crossed
training-seed/opening-stratum percentile bootstrap with seed `202608299902`.
The secondary interval remains the Student-t interval across the five matched
training-seed means with four degrees of freedom, clipped to `[0,1]`. Pooled
game intervals are descriptive only; 5,760 records are not independent
samples.

## 6. Zero-execution preparation gate

The v3 preparation package intentionally exposes no formal-run command. Before
any future execution authorization, the local preparation gate must prove:

1. the protocol and all source/config/opening files match their bound hashes;
2. all 192 openings replay exactly and meet every rule-only invariant;
3. the task bundle contains exactly 45 tasks, 64 pairs per task, and 5,760
   explicit game schedules;
4. all fifteen frozen checkpoint/config/source-receipt file hashes match;
5. search, rules, statistics, and diversity thresholds equal this protocol;
6. preparation self-tests pass; and
7. every readiness and dry-run receipt says `formal_games_executed=0`,
   `gpu_actions=0`, `external_actions=0`, and `paid_actions=0`.

Opening-state replay is a rule validation, not an arena game. Readiness may
hash frozen checkpoint files but must not load a model or perform inference.

## 7. Stop rules

This package must not start a game loop, GPU process, AutoDL workflow, cloud
instance, or paid action. It must not write under the v1 result tree. The only
permitted persistent files are the clearly named v3 protocol, source,
configuration, and frozen manifests.

A future formal runner is a separate, not-yet-authorized deliverable. Before
that deliverable can be used, the owner must confirm the exact reusable
instance or card, live hourly price, maximum RMB cost, and execution command.
If a future v3 run fails, it remains failed evidence; any redesign uses a new
protocol and experiment ID rather than editing this one.
