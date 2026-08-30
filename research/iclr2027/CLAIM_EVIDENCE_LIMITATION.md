# Frozen claim--evidence--limitation ledger

Status: frozen for the current `d14_d16_three_representation_formal_v1`
artifact bundle on 2026-08-29. New evidence must be appended as a new ledger
version; frozen protocols and accepted formal artifacts are not edited here.

| ID | Claim permitted in the paper | Authoritative evidence | Required limitation | Paper locations |
| --- | --- | --- | --- | --- |
| C1 | The released two-player environment is replayable and its Python transitions agree with the independent Web engine on the tested traces. | `D4_D5_validation_report.md`; `D2_environment_status.md`; frozen environment/search test suite; targeted and seeded parity receipts | The expanded 88-test snapshot had seven optional PyTorch-dependent skips. Parity covers the recorded traces and sizes, not every reachable state. | Abstract; Introduction; Implementation and validation |
| C2 | Reachable side-five states can share the implemented Grid observation while differing in latent logical edges. | `state_aliasing/pairs_v1.json`; `state_aliasing/search_report_v1.json`; `results/validation/superko_exhaustive_n5_20260825.json` | Exhaustive side-five analysis found no legal-action, transition, value, Q-value, or optimal-action difference. Do not call the implemented Grid observation non-Markov or strategically insufficient. | Abstract; State-Aliasing Diagnostics; Figure 1 |
| C3 | Superko can reject a naturally reached side-six move that otherwise closes a repeatable six-transition loop. | `state_aliasing/superko_n6_witness_v1.json`; `results/validation/superko_random_n6_seed20260826.json` | This is one verified witness, not a shortest-loop result and not a naturally reached paired-history alias with different legality. | Abstract; State-Aliasing Diagnostics; Conclusion |
| C4 | The formal bundle is complete at its declared scope: 15 training tasks, 315 evaluation tasks, 1,500 self-play games, 3,000 updates, and 30,600 unique replay-verified arena games. | `results/formal/d14_d16/run_v1/result_ledger_status.json`; `results/formal/d14_d16/run_v1/result_receipts.jsonl`; `results/formal/d14_d16/aggregate_v1/aggregate.json`; independent verifier receipts | `formal_ready=true` means artifact completeness, not model superiority. Two interrupted runner attempts lack independent canonical attempt files. | Abstract; Contributions; Experiments; Reproducibility Checklist |
| C5 | At the final checkpoint, every model--size cell beats Random on jointly trained sizes 5, 7, and 9. | `results/formal/d14_d16/aggregate_v1/final_vs_search.csv`; 9,000 color-balanced games against Random | These are pooled descriptive score rates on seen sizes. They do not establish zero-shot size generalization or independent-game inference. | Abstract; Table 3; Experiments; Conclusion |
| C6 | Against UCT-MCTS-16, seven cells are clear under the descriptive Wilson summary, Padded-CNN at side five is borderline, and Grid-GNN at side five is inconclusive. | `results/formal/d14_d16/aggregate_v1/final_vs_search.csv`; 9,000 color-balanced games against UCT-MCTS-16 | The intervals are descriptive, not multiplicity-adjusted hypothesis tests. Search strength is fixed at 16 simulations. | Abstract; Table 3; Figures 2--3; Experiments |
| C7 | Topology-GNN's pooled direct-play score exceeds Grid-GNN's at sides 5, 7, and 9 in this run. | `results/formal/d14_d16/aggregate_v1/representation_round_robin.csv` | Each 200-game task contains only two color-conditioned trajectories. Size-dependent reversals against Padded-CNN rule out a global representation ranking. | Abstract; Table 4; Representation round robin; Conclusion |
| C8 | Five checkpoint probes are non-monotone and size dependent. | `results/formal/d14_d16/aggregate_v1/arena_learning_curve.csv`; Figure 2 | Only five checkpoints were recorded; no AUC or fixed-strength learning estimator was preregistered. Do not claim relative sample efficiency. | Figure 2; Within-size self-play |
| C9 | The three networks are matched within 0.6982% in parameter count under the frozen protocol. | `configs/d14_d16_parameter_counts.json`; `D14_D16_EXPERIMENT_PROTOCOL.md` | Architectures, FLOPs, memory, transitions, and wall time are not matched. | Table 2; Compute matching; Limitations |
| C10 | A five-seed Superko extension observed zero triggers or outcome effects in 240 games. | `SUPERKO_POLICY_MATRIX_RESULTS.md`; `results/validation/superko_policy_matrix_five_seed_v1_attempt2_verification.json` | Every 1% practical-similarity gate failed: each cell has only 10 observe games and a 27.753% Wilson upper bound. The CycleSeeking and neural conditions are bounded/smoke evidence. | Ablations; Limitations |

## Prohibited short forms

- Do not write that Topology-GNN is universally superior.
- Do not write that the Grid observation is non-Markov.
- Do not write that Superko is unnecessary or that enforce/observe rules are
  equivalent.
- Do not write that the models generalize to unseen sizes or are sample
  efficient.
- Do not treat duplicated deterministic trajectories as independent games.
