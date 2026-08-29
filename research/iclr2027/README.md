# ICLR 2027 research sprint

This directory contains the frozen research contract, paper scaffold, tested
LIFELINE-RL environment, search baselines, D9--D13 AlphaZero/representation
milestones, and the D14--D16 formal experiment protocol and verified results.

## Files

- `D1_research_contract.md`: research question, hypotheses, contribution
  contract, evidence status, scope, and acceptance gates.
- `D2_environment_status.md`: implemented environment features, verified
  evidence, remaining correctness gates, and next work.
- `D4_D5_validation_report.md`: targeted rules tests, 65 Python/Web traces,
  exhaustive side-five Superko analysis, and repeated throughput evidence.
- `D6_state_aliasing.md`: paired-state definitions, versioned weak-pair
  dataset, exhaustive side-five negative result, natural side-six Superko
  witness, and larger-board boundaries.
- `SUPERKO_ABLATION_PROTOCOL.md`, `SUPERKO_ABLATION_RESULTS.md`: canonical
  coupling protocol, internal similarity gates, results, and claim boundaries.
- `d6_redteam_audit.md`: independent definition and exact-solver audit.
- `ENVIRONMENT.md`: environment API, action/reward/observation contracts,
  usage, validation commands, and current throughput evidence.
- `BASELINES.md`: Random, Greedy, alpha-beta Minimax, adversarial UCT-MCTS,
  color-balanced arena, artifact, replay, and metric contracts.
- `D3_search_baselines_status.md`: historical Random/UCT checkpoint retained
  for the sprint audit trail.
- `D7_D8_search_report.md`: completed five-agent search implementation,
  validation evidence, and the replay-verified all-pairs smoke matrix.
- `D9_D10_alphazero_framework.md`: PUCT, replay, policy/value learning,
  checkpoint/resume contracts, commands, tests, and verified smoke evidence.
- `D11_D13_DELIVERY.md`: padded-CNN, Grid-GNN, and Topology-GNN input
  boundaries, parameter matching, D13 formal gates, reproduction commands, and
  claim limits.
- `D14_D16_EXPERIMENT_PROTOCOL.md`: frozen five-seed, three-representation
  training/evaluation matrix, receipt schema, deep validation, and aggregation
  contract.
- `D14_D16_RESULTS.md`: completed 15-training/315-evaluation formal ledger,
  D14 learning curves, D15 Random/UCT-16 results, D16 pairwise results,
  artifact hashes, recovery audit, and statistical limitations.
- `AUTODL_GPU_PATH.md`: isolated multi-actor/batched-inference AutoDL v2 path,
  local readiness evidence, paid-run gates, and operator commands.
- `experiment_matrix.csv`: machine-readable minimum experiment matrix.
- `lifeline_rl/`: dependency-free Python rules engine and training wrapper;
  `lifeline_rl/alphazero/` loads PyTorch only for neural training.
- `state_aliasing/`: versioned paired-state dataset, natural n=6 Superko
  witness, and machine-readable search report.
- `tests/`: deterministic unit tests, paired-state checks, and replay fixtures.
- `scripts/`: Python/Web differential checker, throughput benchmark, and
  paired Superko rule-ablation runner.
- `results/smoke/`: explicitly non-paper end-to-end smoke artifacts.
- `paper/main.tex`: compilable English paper outline. Red `TBD` boxes are
  evidence that must be filled from completed experiments, not promises.
- `paper/references.bib`: verified-reference staging file.

## Compile the outline

From `research/iclr2027/paper`:

```powershell
pdflatex -interaction=nonstopmode -halt-on-error main.tex
```

The current scaffold deliberately uses the standard `article` class so it can
compile before the official style files are added. Replace it with the official
ICLR 2027 template before submission and re-check page limits and policies.

## Verify the environment

From the repository root:

```powershell
Push-Location .\research\iclr2027
python -B -m unittest discover -s . -t . -v
Pop-Location
python .\research\iclr2027\scripts\check_reference_parity.py --random-games 60 --max-plies 120
python .\research\iclr2027\scripts\validate_or_search_superko.py --mode exhaustive --grid-size 5
python .\research\iclr2027\scripts\d6_redteam_exact_audit.py --output .\research\iclr2027\d6_redteam_exact_audit.json
python .\research\iclr2027\scripts\validate_or_search_throughput.py --transitions 200 --warmup-transitions 20 --repeats 3
python -B .\research\iclr2027\scripts\run_superko_ablation.py --sizes 6 7 --episodes 2000 --max-plies 120 --seed 20260826 --pass-probability 0.12 --attack-bias 0.95 --progress --summary-only --output .\research\iclr2027\results\validation\superko_ablation_n6_n7_canonical_pilot_20260825.json
```

The frozen D1--D8 core suite has 62/62 passing tests. At
`2026-08-26`, the expanded core-only discovery ran 102 tests: 94 passed and
eight optional PyTorch-dependent tests were skipped; the `rl310` AlphaZero
suite passed all 30 focused tests and the full `rl310` discovery passed 102/102.
Skipped tests are not failures. The D6 result is a
genuine negative result at side length five. At side length six, a standard-start
natural trajectory now reaches a `SUPERKO_VIOLATION`; disabling enforcement
closes a repeatable six-transition loop. This is a trigger witness, not a pair
of natural histories with identical mask-free Topology and different legality,
so no strict history/Superko paired alias is claimed. The existing 100-game-per-
size smoke is superseded for primary pathwise comparison by the canonical
schema-v2 pilot. Under one fixed attack+PASS policy and 120-ply horizon, n=6
had 0/2,000 trigger/divergence/truncation episodes (zero-trigger Wilson 95%
upper bound 0.1917%); n=7 had 2/2,000 trigger episodes (95% CI
0.0274%--0.3639%), one selected-repeat episode with two repeated actions, and
one trajectory divergence. Winners agreed in all 2,000 pairs at both sizes,
B/W/D counts matched (1,020/948/32 at n=6 and 1,043/934/23 at n=7), and no
game truncated. At n=7, mean plies were 24.5780 versus 24.5755, with relative
difference -0.01017% and paired-bootstrap 95% CI [-0.03076%, 0]. Nonzero score
differences were 0/2,000 at each size, with Wilson upper bound 0.1917%.

All internal fixed similarity gates pass for this sampled policy, sizes, and
horizon. The coupling was revised after exploratory output, the seed was
reused, and only one handcrafted policy was tested. Therefore the supported
claim is "empirically similar under the sampled policy," not rule equivalence,
safe deletion, trained-agent invariance, or runtime equivalence. Strict-pair
questions remain open; natural triggers are now observed at n=6 and n=7, while
n=8--15 remain open beyond bounded searches. The canonical artifact SHA-256 is
`4F31ECB8F53ADD3151CE0B879CB3C9AD296F21C5D4B6B9553A9E6DD21221EE09`.

## AlphaZero D9--D10

PyTorch remains optional:

```powershell
python -m pip install -e ".\research\iclr2027[train]"
```

On the verified local environment, run a non-writing preflight with:

```powershell
& 'C:\Users\zcz\anaconda3\envs\rl310\python.exe' -B .\research\iclr2027\scripts\train_alphazero.py --config .\research\iclr2027\configs\alphazero_d9_d10_smoke.json --smoke --dry-run --device cpu
```

Fresh-run, resume, verification commands and the precise evidence boundary are
in `D9_D10_alphazero_framework.md`. Smoke artifacts are engineering evidence,
not formal AZ-GRID/AZ-TOPO results.

## Representation baselines and D13 first gate

`D11_D13_DELIVERY.md` records the topology-blind padded CNN, physical-edge-only
Grid-GNN, and physical/own/opponent-edge Topology-GNN. Their frozen parameter
counts are 62,868 / 62,733 / 63,171, a maximum relative spread below 1%.

The D13 joint formal receipt is `PASS` and claim-eligible for one frozen
Topology-GNN checkpoint. On side length 5 it scored 0.895 against Random over
200 replay-verified, color-balanced games (166/8/26 W/L/D; Wilson 95% interval
[0.8448, 0.9303]; zero truncations). Its separate retained-replay
learning-health gate also passed. This closes only the D13 first gate; it is not
evidence that Topology-GNN outperforms the other representations or generalizes
across sizes. The later complete D14--D16 ledger and its bounded conclusions are
reported separately in `D14_D16_RESULTS.md`.

## D14--D16 formal results

The frozen run completed 15/15 training tasks and 315/315 evaluation tasks with
zero failures or truncations. All 330 artifacts passed deep validation; the
result ledger and aggregate both report `formal_ready=true`. The three models
beat Random on all seen sizes. Against UCT-MCTS-16, Grid-GNN at n=5 was
inconclusive and Padded-CNN at n=5 was only borderline; the other seven pooled
model-by-size cells were above 0.5.

The pairwise representation results depend on board size and do not establish a
global ranking. In addition, deterministic D16 games repeat only two action
trajectories per 200-game task, so the reported game-level Wilson intervals are
descriptive rather than seed-level inference. See `D14_D16_RESULTS.md` for the
full tables, hashes, and unsupported-claim boundary.

## AutoDL GPU v2 path

The AutoDL path is an isolated v2 execution layer under
`lifeline_rl_autodl/`. It batches independent self-play actors and neural leaf
evaluations without changing the frozen D14--D16 source identity. The local
readiness gate has passed; the paid CUDA smoke and bounded remote benchmark
remain intentionally unrun. See `AUTODL_GPU_PATH.md` before any paid launch.

## Change control

The Day-1 contract is the default scope for the 24-day sprint. A change to the
primary research question, mandatory baselines, or main evaluation protocol
must be recorded in the research log together with the evidence that forced the
change. UI work, three-player training, and gameplay feature development are
out of scope.
