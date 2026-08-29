# D11--D13 representation baselines and first result gate

Date: 2026-08-26

Status: **D11/D12 implementations and parameter audit complete; D13 formal
joint gate passed. D14--D16 representation-comparison claims remain gated on
the complete formal aggregate.**

Postscript (2026-08-28): the D14--D16 formal ledger and aggregate are now
complete. See `D14_D16_RESULTS.md` for the full results and the deterministic
round-robin/statistical limitations. The narrow D13 claim below is unchanged.

## Delivery summary

| Milestone | Acceptance item | Verified evidence |
| --- | --- | --- |
| D11 | A topology-blind baseline and a Grid-GNN using only triangular-grid edges | `padded_cnn` and `grid_gnn` share the policy/value, PUCT, and training interfaces; mixed-size batching, PASS, legal masking, relation isolation, and backward passes are tested. |
| D12 | A relation GNN with physical, own, and opponent logical edges | `topology_gnn` uses three current-player-normalized relation channels; tests prevent the CNN and Grid-GNN from consuming logical edges. |
| D13 | AlphaZero beats Random and the topology model learns | Learning-health and 200-game color-balanced arena gates bind the same formal Topology-GNN checkpoint; the joint evidence is `PASS` and `claim_eligible=true`. |

D13 closes only the first result gate. It does not show that Topology-GNN is
better than the CNN or Grid-GNN, establish multi-seed sample efficiency, or
demonstrate unseen-size generalization. Those claims require D14--D16 or later
experiments.

## Shared interface and representation boundaries

All three models reuse the D9--D10 PUCT, self-play, replay buffer, masked policy
loss, terminal value loss, checkpoint, and strict-resume pipeline. Each
position supplies 11 current-player-view node features:

- five occupancy classes: empty, own node, own line point, opponent node, and
  opponent line point;
- normalized two-dimensional coordinates;
- boundary membership;
- own and opponent initial-node indicators;
- the consecutive-PASS count.

Every network returns per-node action logits, one independent PASS logit, and
a scalar `tanh` value. Padding and illegal actions are masked. In mixed-size
batches, each board's PASS target is relocated to the batch's final action
column.

| ID | Observation | Explicit relation input | Width / depth | Trainable parameters |
| --- | --- | --- | ---: | ---: |
| `padded_cnn` | `grid_graph` | Does not read adjacency; maps the triangular board into a zero-padded square tensor and applies three masked residual-convolution blocks | 33 / 3 | 62,868 |
| `grid_gnn` | `grid_graph` | Relation 0 only: fixed physical edges of the triangular grid | 82 / 3 | 62,733 |
| `topology_gnn` | `topology` | Relations 0/1/2: physical, current player's logical, and opponent's logical edges | 64 / 3 | 63,171 |

The CNN uses the shared encoder only for identical node features, padding
metadata, and legal masks; its forward pass does not read adjacency. The
Grid-GNN explicitly selects relation 0. The Topology-GNN remaps BLACK/WHITE
logical relations to own/opponent according to the player to act, preventing a
fixed-color identity leak.

Implementation entry points are
`lifeline_rl/alphazero/network.py`'s
`PaddedCNNPolicyValueNetwork`, `GridGNNPolicyValueNetwork`,
`TopologyGNNPolicyValueNetwork`, and `build_policy_value_network`.

## Parameter and protocol fairness

The frozen audit is `configs/d14_d16_parameter_counts.json`:

- `padded_cnn`: 62,868 parameters, 0.48% below Topology-GNN;
- `grid_gnn`: 62,733 parameters, 0.69% below Topology-GNN;
- `topology_gnn`: 63,171 parameters, the reference model;
- maximum relative spread: 0.70%, below the frozen 1% tolerance.

Widths differ because the fairness target is a matched parameter budget, not
layer-by-layer isomorphism. The formal manifest also matches board and seed
schedules, PUCT simulations, self-play games, gradient steps, iteration and
checkpoint schedules, evaluation games, terminal rewards, maximum plies,
Superko, optimizer, temperature, and Dirichlet noise.

The defensible statement is therefore **matched parameter and
training/search/evaluation budgets**. Wall-clock time is reported but not
matched; the CNN and GNNs do not have identical compute or memory cost.

## D13 formal learning-health gate

Formal checkpoint:

```text
results/formal/d14_d16/run_v1/tasks/train.mixed_n5-7-9.topology_gnn.seed20260825__dd47afdb1e6c/training_run/snapshots/gradient_000200/checkpoint_000010.pt
```

Identity and training counts:

- model: `topology_gnn`, 63,171 parameters;
- mixed-size training: side lengths 5, 7, and 9;
- 100 complete self-play games and 200 gradient steps;
- checkpoint SHA-256:
  `7180ca466e1f657ed2359e13f4b42fbd133b8e973081a295ef66600a18481207`;
- trainer source hash:
  `21a46dbd787090fc18c24cb4e29ebe1dd743203d31abeda43b3ce421833b596c`;
- strict source verification: true.

`results/formal/d13/topology_seed20260825_learning_health.json` evaluates the
same checkpoint on 1,564 retained replay examples under the frozen health
gate.

| Metric | Deterministically reconstructed initialization | Checkpoint |
| --- | ---: | ---: |
| Policy loss | 2.099188 | 1.939316 |
| Value loss | 0.976989 | 0.916178 |
| Total loss | 3.076178 | 2.855494 |

Total replay loss improved by 7.1739%, and the parameter-delta L2 norm was
4.276982. All 11 checks are true, with `passed=true` and
`claim_eligible=true`.

This is an optimizer-health result: finite parameters changed and the
checkpoint improves on its retained replay relative to the matching
initialization. It is not held-out generalization evidence or evidence that one
representation is superior.

## D13 formal Random gate

Arena directory:
`results/formal/d13/topology_seed20260825_vs_random/`.

The frozen gate uses side length 5, Random as the opponent, 200 games arranged
as 100 same-seed color-swapped pairs, 16 PUCT simulations, `c_puct=1.5`, zero
evaluation temperature, enforced Superko, a 256-ply limit, and zero tolerated
truncations. A draw contributes half a point. Passing requires the score's
Wilson 95% lower bound to be strictly greater than 0.5.

Verified result:

- 166 wins, 8 losses, and 26 draws;
- score rate 0.895;
- Wilson 95% interval `[0.8448186, 0.9302930]`;
- 100 games as BLACK and 100 as WHITE;
- 200/200 games replayed successfully;
- zero truncated games;
- `passed=true` and `claim_eligible=true`.

The supported statement is: **under the frozen side-5, single-checkpoint,
200-game color-balanced formal gate, AlphaZero-style Topology-GNN clearly beats
Random.** This must not be generalized to every representation, size, seed, or
search opponent.

## Joint evidence binding

`results/formal/d13/d13_joint_evidence.json` requires the learning-health and
arena evidence to be formal and claim-eligible while binding the same
checkpoint SHA, source hash, model, and training counters. The current joint
receipt has:

- schema `lifeline-d13-joint-evidence` version 1;
- `status=PASS`;
- `claim_eligible=true`;
- 200 arena games replayed;
- consistent checkpoint, model, and source identity.

Key SHA-256 values:

- joint receipt:
  `4209d7401e8a89f95756f38cd97eea12ea93532bc89af24b3e16a0ba914536ea`;
- learning-health report:
  `f463dd1ad6829aa8ff0728ab4822ca1834cad01df6f575f9721325b5926561fe`;
- arena summary:
  `ab14341f24e0f3c1370f876cb6a4e1107f216244f6f6bdba4671109642af25f2`;
- replay-bound arena JSONL:
  `8a6ca0904b4eb26a135ebf96d7fad6a2fa4faadd426fc73e95efb3d2356e288e`;
- arena gate:
  `464630200799577217b278d27e7e9597b90d9ddcce3c1d37f1f9b8277547cc51`.

The convenience `games.csv` is not bound by the joint receipt. Formal claims
therefore cite `games.jsonl`, which is bound and replay-verified. The arena
metadata records a dirty Git worktree; the strict source hash nevertheless
matches the checkpoint, training receipt, and current trainer source. The six
runner/verifier/source files also match their own SHA values recorded in the
joint receipt. Both facts must remain visible in any downstream report.

## Verification without changing canonical evidence

From the repository root in PowerShell:

```powershell
$py = 'C:\Users\zcz\anaconda3\envs\rl310\python.exe'
$checkpoint = '.\research\iclr2027\results\formal\d14_d16\run_v1\tasks\train.mixed_n5-7-9.topology_gnn.seed20260825__dd47afdb1e6c\training_run\snapshots\gradient_000200\checkpoint_000010.pt'

& $py -B .\research\iclr2027\scripts\d14_d16_experiments.py audit-parameters --manifest .\research\iclr2027\configs\d14_d16_formal_manifest.json --counts .\research\iclr2027\configs\d14_d16_parameter_counts.json
& $py -B .\research\iclr2027\scripts\verify_topology_learning.py --checkpoint $checkpoint --tier formal
& $py -B .\research\iclr2027\scripts\verify_neural_arena_results.py .\research\iclr2027\results\formal\d13\topology_seed20260825_vs_random
```

The first three commands are read-only. The joint verifier writes a
non-overwritable JSON receipt, so recheck the binding only with a unique
temporary output:

```powershell
$jointCheck = Join-Path $env:TEMP ("lifeline-d13-joint-{0}.json" -f [guid]::NewGuid().ToString('N'))
& $py -B .\research\iclr2027\scripts\verify_d13_formal_evidence.py --learning-health .\research\iclr2027\results\formal\d13\topology_seed20260825_learning_health.json --arena-dir .\research\iclr2027\results\formal\d13\topology_seed20260825_vs_random --output $jointCheck
```

Formal verifiers intentionally reject source mismatch, missing checkpoints,
and relaxed thresholds. The arena and joint formal receipts also reject
overwrites; although the learning-health CLI exposes `--overwrite`, it must not
be used for a formal rerun. Such a failure is an integrity safeguard and must
not be bypassed.

## Focused tests

```powershell
$env:PYTHONPATH = "$PWD\research\iclr2027"
& $py -B -m unittest discover -s .\research\iclr2027\tests -t .\research\iclr2027 -p 'test_alphazero_model_families.py' -v
& $py -B -m unittest discover -s .\research\iclr2027\tests -t .\research\iclr2027 -p 'test_alphazero_learning_health.py' -v
& $py -B -m unittest discover -s .\research\iclr2027\tests -t .\research\iclr2027 -p 'test_alphazero_evaluation.py' -v
& $py -B -m unittest discover -s .\research\iclr2027\tests -t .\research\iclr2027 -p 'test_alphazero_neural_agent.py' -v
& $py -B -m unittest discover -s .\research\iclr2027\tests -t .\research\iclr2027 -p 'test_d13_formal_evidence.py' -v
```

## Evidence boundary and next gate

Verified now: isolated inputs for the three representations, mixed-size
masking, matched parameter budgets, Topology-GNN optimizer health, and one
formal Topology-GNN checkpoint beating Random at side length 5.

Not yet established by D13: Topology-GNN over Grid-GNN/CNN, multi-seed sample
efficiency, stable UCT-MCTS win rates, the side-7/9 main results, unseen-size
generalization, or logical-edge ablations. D14--D16 conclusions require all 330
formal receipts to deep-validate and the aggregate to report
`formal_ready=true`.
