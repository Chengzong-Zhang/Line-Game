# Claim - evidence - limitation ledger (v5)

Status: current-evidence routing frozen on 2026-09-01 for the exact PDF
`2392F034DA6D5C435C7CB9AFCCF6BF615F7EF6F2A87B455D32138B608A453822`
and formal bundle `d14_d16_three_representation_formal_v1`. This v5
supersedes v3 and the local v4 snapshot for current routing. Historical
ledgers and frozen protocols, receipts, tasks, and results remain immutable.

This ledger changes routing and claim boundaries only. It is not a new
experiment result, author approval, anonymous-supplement approval, or
submission authorization.

## Bound current evidence

| Evidence | SHA-256 | Disposition |
| --- | --- | --- |
| `main.pdf` | `2392F034DA6D5C435C7CB9AFCCF6BF615F7EF6F2A87B455D32138B608A453822` | Technical/render QA PASS for these bytes only |
| `main.tex` | `3B107FB96825955EBF5B7177D30B471938EE1128A3214FFC1C2CCAC1CE580402` | Source bound by the current-PDF QA receipt |
| `ICLR2027_POSTRUN_QA_2392F034.md` | `F743140082A979D5AB43E98FB541D59ACDE4AE12C68CDE575504C83FB545F7CA` | Current-environment A/B reproduction PASS; fresh clean-install reproduction remains OPEN / NOT VERIFIED |
| `../reviews/iclr2027_postrun_independent_review_v5_2392F034.md` | `5A20F9F91735E49FF3512CA589D4CB154D018D59C10D6CE0904EA167AEBB2F22` | Reject, 4/10, confidence 4/5 |
| `../submission_checks/submission_gate_postrun_v6_20260901_b07eb85.md` | `975E7C6F0F3ED03AB53AAC8EF0605F65F10A055E3871A6D6EA56362A5F262E2D` | FAIL / needs revision |
| `../results/validation/d17_d18_v1_canonical_closure_receipt_20260901_b07eb85.md` | `DA346F73BAE880DEF896F4E18C285A4E93DC45DD6E9FC76D0B93DAE32DE5CDBC` | Canonical integrity PASS; scientific gate FAIL_CLOSED |

The manuscript build subject is commit
`2f4872c05f4d0e264d511255ee5fa4678310d024`, tree
`aca5c8e71dbcc16a767ed206b77d595d5c329ab6`. The later D17/D18-v1
canonical-closure subject is commit
`b07eb852573acb6a635d3045ccbbadd9a5759b06`, tree
`fd86b192f25f619a6e3dd5014117e687827db86e`. The gate verifies that the
intervening research-tool changes did not alter the bound paper bytes or paper
inputs. These subjects must not be conflated.

A separate private execution-contract verifier receipt now records only a
`contract-only PASS`. It byte-binds 126 files in total, comprising 124 frozen
inputs and two verifier tool sources, proves the exact 25-file `lifeline_rl`
package-source closure, closes the 120-row claim/allowlist identity in both
directions, confirms that all eleven future outputs are absent, and verifies
ten verbatim Git transport rules. It accessed no network, created no
environment, built or installed no package, ran no test/game, and did not
reproduce training. Fresh clean-install reproduction remains
`OPEN / NOT VERIFIED`.

The compact auditor, SHA-256
`44A9E922AEBD3EC8D30E40AF35DBDE459869A774971796251AB5317184583E7C`,
is a future Gate E `tracked-metadata-consistency-only` tool. This contract run
did not execute it. Its contract binds 11 tracked metadata inputs and requires
exit 0, zero skips, and the public verdict
`PASS_TRACKED_METADATA_CONSISTENCY_ONLY`, while opening zero external artifact
bytes. It does not verify raw games, checkpoints, logs, trajectory replay, or
retraining. Neither the auditor nor the private execution-contract receipt is
part of the 120-payload/124-member supplement topology. All real Git
commit/tree OIDs and internal receipt paths remain private; anonymous release
must bind only archive/member-manifest content hashes or an anonymized subject.

Bound seed/pair descriptive audit:

- JSON SHA-256:
  `E8DBB1CBAFC15DE0C7B2879CA3697E8F21F3F8C6D84354715B75A5F4D078C7CD`;
- Markdown SHA-256:
  `73AAB2C79C19402651170939C11819CBAF69A76D59AF0D33AB82C9EC2202188F`;
- status: `PASS_DESCRIPTIVE_ONLY_NO_INFERENCE`.

## Admitted claims and mandatory limits

| ID | Claim permitted in the paper | Authoritative evidence | Required limitation |
| --- | --- | --- | --- |
| C1 | The two-player environment is replayable and the tested Python transitions agree with the independent Web engine. | `../D4_D5_validation_report.md`; frozen environment/search tests and parity receipts | Parity covers the recorded traces, not every reachable state. |
| C2 | Reachable side-five states can share the implemented Grid observation while differing in latent logical edges. | `../state_aliasing/pairs_v1.json`; `../state_aliasing/search_report_v1.json`; exhaustive side-five certificate | The exhaustive side-five audit found no legal-action, transition, value, Q-value, or optimal-action difference. Do not call Grid non-Markov or strategically insufficient. |
| C3 | A standard-start side-six witness shows that Superko can reject an otherwise loop-closing move. | `../state_aliasing/superko_n6_witness_v1.json`; replay verification artifact | One witness is not a shortest-loop result and is not a naturally reached paired-history legality alias. |
| C4 | The D14--D16 bundle contains 15 training tasks, 315 evaluation tasks, 1,500 self-play games, 3,000 updates, and 30,600 task-indexed replay-verified game records. | `../results/formal/d14_d16/run_v1/result_ledger_status.json`; `../results/formal/d14_d16/run_v1/result_receipts.jsonl`; `../results/formal/d14_d16/aggregate_v1/aggregate.json`; independent receipt audit | `formal_ready=true` applies only to artifact completeness. Repeated trajectories mean records are not unique games or independent trials; two interrupted runners lack independent canonical attempt files. |
| C5 | At the final checkpoint, all 45 training-seed scores against Random exceed 0.5 on jointly trained sizes 5, 7, and 9. | `../reviews/d14_d16_seed_pair_descriptive_audit.json`; `../results/formal/d14_d16/aggregate_v1/final_vs_search.csv` | The primary unit is five training-seed scores per model--size cell. The summaries establish neither unseen-size generalization nor independent-game inference. |
| C6 | Against UCT-MCTS-16, five-seed cell medians span 0.477--0.920 and the seed ranges vary by model and size. | `../reviews/d14_d16_seed_pair_descriptive_audit.json`; `../results/formal/d14_d16/aggregate_v1/final_vs_search.csv` | Medians and min--max ranges are not confidence intervals or hypothesis tests. Search is fixed at 16 simulations and is not compute-matched to the learned agents. |
| C7 | Direct-play seed summaries are heterogeneous: only Topology-GNN versus Grid-GNN at side 7 has median 1.00; the other eight model-pair--size medians are 0.50 with wide ranges. | `../reviews/d14_d16_seed_pair_descriptive_audit.json`; `../results/formal/d14_d16/aggregate_v1/representation_round_robin.csv` | Each 200-game seed-task contains two deterministic color-conditioned trajectories repeated 100 times. No global representation ordering is supported. |
| C8 | The five frozen pooled checkpoint probes are non-monotone and size dependent as schedule and reconciliation views. | `../results/formal/d14_d16/aggregate_v1/arena_learning_curve.csv`; Figure 2 | Only five checkpoints were recorded; no AUC or fixed-strength learning estimator was preregistered. The probes do not support uncertainty, continuous-convergence, or relative sample-efficiency inference. |
| C9 | Parameter counts differ by at most 0.6982% under the frozen protocol. | `../configs/d14_d16_parameter_counts.json`; `../D14_D16_EXPERIMENT_PROTOCOL.md` | Grid-GNN and Topology-GNN differ in typed relations and hidden width, so representation and architecture are confounded. FLOPs, memory, transitions, wall time, and evaluation compute are not matched. |
| C10 | The five-seed Superko extension observed no trigger or outcome effect in 240 games. | `../SUPERKO_POLICY_MATRIX_RESULTS.md`; independent verification JSON | Every 1% similarity gate failed because each cell has ten observe games and a 27.753% Wilson upper bound. Neural/CycleSeeking rows remain smoke or bounded evidence. |

The D14--D16 formal receipt ledger, canonical aggregate, and independent audit
were rehashed for this routing snapshot as
`FF3EF8BFD9B7A443BC42BA16AB9D4DAA9F855A5D0432D58A62322686247B8114`,
`59C264FC65D7B11357B0D718D38371DF1BA44BE4B92E7EF41FF995BF088F501C`,
and `F64C8DE1A2FCA86CF7681A855EDFB244033B318E65E14B2ADD64EDE27E4EF648`,
respectively.

## D17--D19 status claim, not an admitted performance result

The paper may state only that the preregistered D17/D18-v1 extension completed
85/85 tasks and 8,320/8,320 replayable game records, then remained excluded
because 22/45 D18 tasks did not satisfy the frozen trajectory-diversity
criteria. The canonical producer and independent numeric files are
byte-identical, all three canonical-integrity gates pass, and the independent
verifier replays every task and record. Exactly one of 25 overall verifier
gates remains false: `unique_trajectory_thresholds_met`.

These facts close canonical provenance only. The scientific gate remains
`FAIL_CLOSED`, `formal_ready=false`, and D19 remains closed. No D17 zero-shot
performance, D18/D16-v2 inference, D18-v3 result, D19 architecture-matched
ablation, or BASE-SEARCH result is admitted. The current claim-complete
supplement candidate does not yet cover this v5 status claim, so final artifact
closure remains open.

## Prohibited short forms

- No n=10/12 generalization claim.
- No universal or global model ranking.
- No confidence interval, hypothesis test, or independent per-game inference
  from repeated deterministic trajectories.
- No logical-edge or history-feature causal effect.
- No rule equivalence or claim that Superko is unnecessary.
- No relative sample-efficiency claim from the pooled checkpoint probes.
- No statement that canonical integrity makes D17/D18 scientifically ready.

## Scientific and submission disposition

The exact current PDF remains **Reject, 4/10, confidence 4/5**. Canonical
provenance and stronger bookkeeping do not supply the missing
decision-relevant witness, controlled same-architecture ablation, diverse
evaluation unit, stronger calibrated opponents, or standalone benchmark
contract.

Submission readiness remains **NO**. The following gates are still open:

1. wheel acquisition and preflight, an offline clean export/build, a genuinely
   fresh installation, the scoped verification run, a hash-bound reproduction
   receipt, and complete TeX-plus-BibTeX runtime closure; the existing
   contract-only PASS does not close any of these execution steps;
2. an author-reviewed private identity list, per-file supplement approval,
   subject-bound final archive, and independent verify-extract receipt;
3. author-confirmed AI-use facts and the exact paper/form disclosure wording;
4. author inspection and completion of the live OpenReview form;
5. the score-driving scientific work identified by independent review.

The current supplement tooling and historical candidate/archive receipts remain
`candidate_only_not_approved`. The private verifier receipt remains only a
`contract-only PASS`; neither status changes `author_approved=false`,
`anonymity_coverage_established=false`, `final_archive=false`, and
`submission_ready=false`. AI-use, identity coverage, per-file approval, final
archive approval, and the live-form decision all remain **OPEN**.

The paper maps admitted claims to protocol/config hashes, compact aggregate
CSV/JSON, the append-only receipt ledger, the seed/pair descriptive audit, and
independent verifier outputs. Checkpoints, raw per-game logs, local task
directories, build logs, and private paths are not submission artifacts.

Any change to the paper bytes, evidence files, ledger, supplement payload,
identity input, author decision, or current gate invalidates the corresponding
binding and requires fresh hashes and a new gate. No upload, submission, paid
experiment, or author approval is performed or implied by this ledger.
