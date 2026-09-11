# Claim - evidence - limitation ledger (v4)

Status: seed-level descriptive revision frozen on 2026-08-31 for PDF
`69247087CFE0A4F3DB6FFB95E00A536F544889F8C1030E0AF134A5A39D73B88C`
and formal bundle `d14_d16_three_representation_formal_v1`. This v4
supersedes v3 for current paper routing. Historical ledgers and frozen formal
protocols, receipts, tasks, and results remain immutable.

Bound seed/pair audit:

- JSON SHA-256:
  `E8DBB1CBAFC15DE0C7B2879CA3697E8F21F3F8C6D84354715B75A5F4D078C7CD`;
- Markdown SHA-256:
  `73AAB2C79C19402651170939C11819CBAF69A76D59AF0D33AB82C9EC2202188F`;
- status: `PASS_DESCRIPTIVE_ONLY_NO_INFERENCE`.

| ID | Claim permitted in the paper | Authoritative evidence | Required limitation |
| --- | --- | --- | --- |
| C1 | The two-player environment is replayable and the tested Python transitions agree with the independent Web engine. | `../D4_D5_validation_report.md`; frozen environment/search tests and parity receipts | The 88-test discovery snapshot had seven optional PyTorch-dependent skips. Parity covers the recorded traces, not every reachable state. |
| C2 | Reachable side-five states can share the implemented Grid observation while differing in latent logical edges. | `../state_aliasing/pairs_v1.json`; `../state_aliasing/search_report_v1.json`; exhaustive side-five certificate | The exhaustive side-five audit found no legal-action, transition, value, Q-value, or optimal-action difference. Do not call Grid non-Markov or strategically insufficient. |
| C3 | A naturally reached side-six move can be rejected by Superko and otherwise close a repeatable six-transition loop. | `../state_aliasing/superko_n6_witness_v1.json`; replay verification artifact | One witness is not a shortest-loop result and is not a naturally reached paired-history legality alias. |
| C4 | The D14--D16 bundle contains 15 training tasks, 315 evaluation tasks, 1,500 self-play games, 3,000 updates, and 30,600 task-indexed replay-verified game records. | `../results/formal/d14_d16/run_v1/result_ledger_status.json`; `result_receipts.jsonl`; `aggregate_v1/aggregate.json`; independent receipt audit | `formal_ready=true` applies only to artifact completeness. Repeated trajectories mean records are not unique games or independent trials; two interrupted runners lack independent canonical attempt files. |
| C5 | At the final checkpoint, all 45 training-seed scores against Random exceed 0.5 on jointly trained sizes 5, 7, and 9. | `../reviews/d14_d16_seed_pair_descriptive_audit.json`; `../results/formal/d14_d16/aggregate_v1/final_vs_search.csv` | The primary unit is five training-seed scores per model--size cell. The summaries are descriptive and establish neither unseen-size generalization nor independent-game inference. |
| C6 | Against UCT-MCTS-16, five-seed cell medians span 0.477--0.920 and the seed ranges vary by model and size. | `../reviews/d14_d16_seed_pair_descriptive_audit.json`; `../results/formal/d14_d16/aggregate_v1/final_vs_search.csv` | Medians and min--max ranges are not confidence intervals or hypothesis tests. Search is fixed at 16 simulations and is not compute-matched to the learned agents. |
| C7 | Direct-play seed summaries are heterogeneous: only Topology-GNN versus Grid-GNN at side 7 has median 1.00; the other eight model-pair--size medians are 0.50 with wide ranges. | `../reviews/d14_d16_seed_pair_descriptive_audit.json`; `../results/formal/d14_d16/aggregate_v1/representation_round_robin.csv` | Each 200-game seed-task contains two deterministic color-conditioned trajectories repeated 100 times. No global representation ordering is supported. |
| C8 | The five frozen pooled checkpoint probes are non-monotone and size dependent as schedule and reconciliation views. | `../results/formal/d14_d16/aggregate_v1/arena_learning_curve.csv`; Figure 2 | Only five checkpoints were recorded; no AUC or fixed-strength learning estimator was preregistered. The pooled probes do not support uncertainty, continuous-convergence, or relative sample-efficiency inference. |
| C9 | Parameter counts differ by at most 0.6982% under the frozen protocol. | `../configs/d14_d16_parameter_counts.json`; `../D14_D16_EXPERIMENT_PROTOCOL.md` | Grid-GNN and Topology-GNN differ in typed relations and hidden width, so representation and architecture are confounded. FLOPs, memory, transitions, and wall time are not matched. |
| C10 | The five-seed Superko extension observed no trigger or outcome effect in 240 games. | `../SUPERKO_POLICY_MATRIX_RESULTS.md`; independent verification JSON | Every 1% similarity gate failed because each cell has ten observe games and a 27.753% Wilson upper bound. Neural/CycleSeeking rows remain smoke/bounded evidence. |

## Non-admitted D17--D19 evidence

The D17/D18 extension executed 85/85 tasks and 8,320/8,320 replayable games,
but 22/45 D18 trajectory-diversity gates failed. The bundle remains
`formal_ready=false`; canonical numeric equality was not established, D19 did
not run, and no D17--D19 performance row is admitted into the paper or this
ledger.

## Prohibited short forms

- No n=10/12 generalization claim.
- No universal or global model ranking.
- No confidence interval, hypothesis test, or independent per-game inference
  from repeated deterministic trajectories.
- No logical-edge or history-feature causal effect.
- No rule equivalence or claim that Superko is unnecessary.
- No relative sample-efficiency claim from the pooled checkpoint probes.

## Submission-artifact boundary

The paper maps claims to protocol/config hashes, compact aggregate CSV/JSON,
the append-only receipt ledger, the seed/pair descriptive audit, and
independent verifier outputs. Checkpoints, raw per-game logs, and local task
directories are not claimed as submission artifacts. The anonymous candidate
must rewrite historical source paths to the exact candidate destinations and
verify that every path named in its admitted ledger exists. Candidate
integrity does not replace author approval, a real identity-variant scan,
clean-install reproduction, or the final live-submission gate.
