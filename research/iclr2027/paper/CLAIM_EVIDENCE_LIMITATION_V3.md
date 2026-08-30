# Claim - evidence - limitation ledger (v3)

Status: post-D17/D18 fail-closed revision frozen on 2026-08-30 for the current
paper candidate. This v3 supersedes `CLAIM_EVIDENCE_LIMITATION.md` v2 for
current routing; v2 and the repository-root ledger remain immutable historical
versions. This revision changes claim boundaries, not a frozen protocol,
receipt, result, or statistical conclusion.

| ID | Claim permitted in the paper | Authoritative evidence | Required limitation |
| --- | --- | --- | --- |
| C1 | The two-player environment is replayable and the tested Python transitions agree with the independent Web engine. | `../D4_D5_validation_report.md`; frozen environment/search tests and parity receipts | The 88-test discovery snapshot had seven optional PyTorch-dependent skips. Parity covers the recorded traces, not every reachable state. |
| C2 | Reachable side-five states can share the implemented Grid observation while differing in latent logical edges. | `../state_aliasing/pairs_v1.json`; `../state_aliasing/search_report_v1.json`; exhaustive side-five certificate | The exhaustive side-five audit found no legal-action, transition, value, Q-value, or optimal-action difference. Do not call Grid non-Markov or strategically insufficient. |
| C3 | A naturally reached side-six move can be rejected by Superko and otherwise close a repeatable six-transition loop. | `../state_aliasing/superko_n6_witness_v1.json`; replay verification artifact | One witness is not a shortest-loop result and is not a naturally reached paired-history legality alias. |
| C4 | The D14--D16 formal bundle contains 15 training tasks, 315 evaluation tasks, 1,500 self-play games, 3,000 updates, and 30,600 task-indexed replay-verified game records. | `../results/formal/d14_d16/run_v1/result_ledger_status.json`; `result_receipts.jsonl`; `aggregate_v1/aggregate.json` | `formal_ready=true` applies only to the D14--D16 ledger and means artifact completeness, not superiority. Repeated trajectories mean records are not unique games or independent trials; two interrupted runner attempts lack independent canonical attempt files. |
| C5 | At the final checkpoint, all nine model-size cells beat Random on jointly trained sizes 5, 7, and 9. | `../results/formal/d14_d16/aggregate_v1/final_vs_search.csv` | These are pooled descriptive score rates on seen sizes; no zero-shot size generalization or independent-game inference is claimed. |
| C6 | Against UCT-MCTS-16, seven cells are clear under the descriptive Wilson summary, Padded-CNN at side five is borderline, and Grid-GNN at side five is inconclusive. | `../results/formal/d14_d16/aggregate_v1/final_vs_search.csv` | Intervals are descriptive, not multiplicity-adjusted tests; search strength is fixed at 16 simulations. |
| C7 | Topology-GNN's pooled direct-play score exceeds Grid-GNN's at sides 5, 7, and 9 in this run. | `../results/formal/d14_d16/aggregate_v1/representation_round_robin.csv` | Each 200-game task contains two color-conditioned trajectories. Size-dependent reversals against Padded-CNN rule out a global ranking. |
| C8 | Five checkpoint probes are non-monotone and size dependent. | `../results/formal/d14_d16/aggregate_v1/arena_learning_curve.csv` | Only five checkpoints were recorded; no AUC or fixed-strength estimator was preregistered. Do not claim sample efficiency. |
| C9 | Parameter counts differ by at most 0.6982% under the frozen protocol. | `../configs/d14_d16_parameter_counts.json`; `../D14_D16_EXPERIMENT_PROTOCOL.md` | Grid-GNN and Topology-GNN differ in typed relations and hidden width, so representation and architecture are confounded. FLOPs, memory, transitions, and wall time are not matched. |
| C10 | The five-seed Superko extension observed no trigger or outcome effect in 240 games. | `../SUPERKO_POLICY_MATRIX_RESULTS.md`; independent verification JSON | Every 1% similarity gate failed because each cell has only ten observe games and a 27.753% Wilson upper bound. Neural/CycleSeeking rows remain smoke/bounded evidence. |

## Non-admitted D17-D19 evidence

The D17/D18 P0 process executed 85/85 tasks and 8,320/8,320 replayable games
with no execution failure, missing task, or truncation. D18 nevertheless failed
its preregistered diversity gate in 22/45 tasks, so the bundle is
`formal_ready=false`. The local independent report replayed all 8,320 games
and returned `FAIL_CLOSED`; canonical numeric equality was not supplied. D19's
conditional P1 gate remained closed and no D19 task ran.

This execution state supports no D17 zero-shot-size claim, no D18/D16-v2
performance or inference claim, and no D19 architecture-matched ablation claim.
The 85/85 execution count must never be shortened to "formal evidence ready."

## Prohibited short forms

- No n=10/12 generalization claim.
- No universal or global model ranking.
- No independent per-game significance claim for duplicated deterministic
  trajectories.
- No rule-equivalence or "Superko is unnecessary" claim.
- No relative sample-efficiency claim.
- No statement that D17--D19 passed its formal gate.

## Submission-artifact boundary

The paper maps admitted claims to frozen protocol/config hashes, compact
aggregate CSV/JSON summaries, an append-only receipt ledger, and verifier
outputs. It does not claim that checkpoints, raw per-game logs, or task
directories are included in the submission artifacts. The D17/D18 failure
audit remains local-only and is not an allowlisted submission artifact. The
single hand-designed game does not establish external validity to other board
games.
