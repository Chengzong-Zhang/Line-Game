# Claim - evidence - limitation ledger (v6)

Status: current-evidence routing frozen on 2026-09-01 for the exact PDF
`848C60359A0DCD829E33E8E0388F5FA0AA136A2E045215E0B8D63A8ABFFA99F6`
and formal bundle `d14_d16_three_representation_formal_v1`. This v6
supersedes v5 for current routing. Historical ledgers and frozen protocols,
receipts, tasks, results, reviews, and submission gates remain immutable.

This ledger changes routing and claim boundaries only. It is not a new
training result, author approval, anonymous-supplement approval, release
approval, or submission authorization. The current history-twin manuscript
revision is working-tree evidence and is not yet bound to a committed Git
subject.

## Bound current paper and history-twin evidence

| Evidence | Bytes | SHA-256 | Disposition |
| --- | ---: | --- | --- |
| `main.pdf` | 449,839 | `848C60359A0DCD829E33E8E0388F5FA0AA136A2E045215E0B8D63A8ABFFA99F6` | Current 11-page paper bytes; any byte change invalidates this ledger binding |
| `main.tex` | 33,017 | `FE16B0BCDE8A478319A33E4201E55D2279DAE93B90F1DBFF49E6A6033A4F3E21` | Current source for the bound PDF |
| `../D6_HISTORY_TWIN_EVIDENCE_ADDENDUM_V2.md` | 6,715 | `B4A91DFF91A3B2B94B85CBD8F123B96F57B98C2F435961E01B419229065C9B8D` | Append-only routing note; does not rewrite frozen D6 evidence |
| `../results/validation/targeted_history_twin_n6_stage5_search_25k_v1.json` | 7,684 | `4B87962DAFFB9AA44B2C67541EF420C8C1574C8E4D6820AFE518632BC10CF9E5` | Candidate-only bounded CPU search; not shortest or exhaustive |
| `../results/validation/targeted_history_twin_n6_stage5_verification_v1.json` | 7,261 | `555A97F4DA22EC1072AFD0C9B39B2269DA9A2DD30412528EF114013EB6FA1B1F` | PASS; independent Python replay plus tracked Web-engine replay |
| `../results/validation/history_superko_n6_strict_pair_candidate_v1.json` | 2,035 | `5796D643B9F6ED8716983EC3234B2398C7B50D221E2A16EBB9682BA1FB6479F5` | Candidate reconstructed from the pre-existing tracked Web verifier |
| `../results/validation/history_superko_n6_strict_pair_verification_v1.json` | 6,714 | `EF209D84F7906B1858E9954415CD5971AF1F6D2EE878A811BE27EF78B4AD41A1` | PASS; corroborating natural pair, not a wholly independent method |

The primary targeted witness starts from the standard side-six initial state.
Its reference history and twin history reach identical board values, typed
BLACK and WHITE logical-edge sets, player to act, consecutive-skip count, and
terminal flag. Their canonical mask-free Topology projection has SHA-256
`33EAB73543D4521C09423D9D97E5129E02C18401049463273182161DC2DD8577`.
The shared placement `(2,3)` is legal after the twin history and is rejected
after the reference history exactly with `SUPERKO_VIOLATION`; the legal
placement sets otherwise agree. The repeated candidate-result key has SHA-256
`C1362C7A100C1C512E2345740F4D9CBD1C34C12B7AB708D65DAC681365C14608`.

The targeted search had a 25,000-state ceiling, action depth at most 20, and no
wall-clock stop. It found the candidate after examining 8 states and 69
transitions at depth 6. Those counts characterize this targeted run only; they
do not establish prevalence, a shortest history, or exhaustive side-six
coverage. Both verifiers consume the same persisted targeted candidate, so
cross-engine agreement is replay corroboration rather than independent input
discovery.

The earlier PDF, source, QA, independent review, and gate bound to
`2392F034...453822` are historical snapshots. They do not gate the current
bytes. A fresh hash-bound QA receipt, blind review, and submission gate are
required for `848C6035...FFA99F6` before any current review or readiness verdict
may be claimed.

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
| C3 | At side six, two legal histories from the standard initial state can reach identical mask-free Topology projections while a shared placement is legal after one history and rejected after the other exactly by Superko. | `../D6_HISTORY_TWIN_EVIDENCE_ADDENDUM_V2.md`; targeted candidate and PASS verification JSON bound above; strict-pair candidate and PASS verification JSON as corroboration | The legal masks differ, so the implemented Grid and Topology observations are not equal. This is not a same-observation-and-mask future-decision witness and does not establish different exact values or optimal actions, learning benefit, TopologyHistory benefit, or a same-backbone ablation result. Neither shortest history nor exhaustive side-six coverage is claimed. |
| C4 | The D14--D16 bundle contains 15 training tasks, 315 evaluation tasks, 1,500 self-play games, 3,000 updates, and 30,600 task-indexed replay-verified game records. | `../results/formal/d14_d16/run_v1/result_ledger_status.json`; `../results/formal/d14_d16/run_v1/result_receipts.jsonl`; `../results/formal/d14_d16/aggregate_v1/aggregate.json`; independent receipt audit | `formal_ready=true` applies only to artifact completeness. Repeated trajectories mean records are not unique games or independent trials; two interrupted runners lack independent canonical attempt files. |
| C5 | At the final checkpoint, all 45 training-seed scores against Random exceed 0.5 on jointly trained sizes 5, 7, and 9. | `../reviews/d14_d16_seed_pair_descriptive_audit.json`; `../results/formal/d14_d16/aggregate_v1/final_vs_search.csv` | The primary unit is five training-seed scores per model--size cell. The summaries establish neither unseen-size generalization nor independent-game inference. |
| C6 | Against UCT-MCTS-16, five-seed cell medians span 0.477--0.920 and the seed ranges vary by model and size. | `../reviews/d14_d16_seed_pair_descriptive_audit.json`; `../results/formal/d14_d16/aggregate_v1/final_vs_search.csv` | Medians and min--max ranges are not confidence intervals or hypothesis tests. Search is fixed at 16 simulations and is not compute-matched to the learned agents. |
| C7 | Direct-play seed summaries are heterogeneous: only Topology-GNN versus Grid-GNN at side 7 has median 1.00; the other eight model-pair--size medians are 0.50 with wide ranges. | `../reviews/d14_d16_seed_pair_descriptive_audit.json`; `../results/formal/d14_d16/aggregate_v1/representation_round_robin.csv` | Each 200-game seed-task contains two deterministic color-conditioned trajectories repeated 100 times. No global representation ordering is supported. |
| C8 | The five frozen pooled checkpoint probes are non-monotone and size dependent as schedule and reconciliation views. | `../results/formal/d14_d16/aggregate_v1/arena_learning_curve.csv`; Figure 2 | Only five checkpoints were recorded; no AUC or fixed-strength learning estimator was preregistered. The probes do not support uncertainty, continuous-convergence, or relative sample-efficiency inference. |
| C9 | Parameter counts differ by at most 0.6982% under the frozen protocol. | `../configs/d14_d16_parameter_counts.json`; `../D14_D16_EXPERIMENT_PROTOCOL.md` | Grid-GNN and Topology-GNN differ in typed relations and hidden width, so representation and architecture are confounded. FLOPs, memory, transitions, wall time, and evaluation compute are not matched. |
| C10 | The five-seed Superko extension observed no trigger or outcome effect in 240 games. | `../SUPERKO_POLICY_MATRIX_RESULTS.md`; independent verification JSON | Every 1% similarity gate failed because each cell has ten observe games and a 27.753% Wilson upper bound. Neural/CycleSeeking rows remain smoke or bounded evidence. |

The D14--D16 formal receipt ledger, canonical aggregate, and independent audit
remain bound as
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
ablation, or BASE-SEARCH result is admitted. The existing 120-payload,
124-member supplement candidate predates the v6 history-twin evidence and does
not cover the new paper claim. It must not be silently amended or called
claim-complete for this PDF.

## Prohibited short forms

- No n=10/12 generalization claim.
- No universal or global model ranking.
- No confidence interval, hypothesis test, or independent per-game inference
  from repeated deterministic trajectories.
- No claim that the implemented Grid or Topology observations are equal for
  the side-six paired-history witness; their legal masks differ.
- No claim that a same-observation-and-mask future-decision witness has been
  found.
- No logical-edge or compact-history learning benefit, TopologyHistory
  superiority or necessity, optimal-action difference, or same-backbone
  ablation result.
- No rule equivalence or claim that Superko is unnecessary.
- No relative sample-efficiency claim from the pooled checkpoint probes.
- No statement that canonical integrity makes D17/D18 scientifically ready.

## Scientific and submission disposition

The v6 witness closes one narrow mechanism question: naturally reachable
paired histories with the same mask-free topology can differ in Superko
legality. The central construct-validity blocker remains **OPEN** because the
implemented observation includes the legal mask. The current evidence does not
show two identical implemented observations and masks that require different
future decisions, nor does it show a learned benefit from history, logical
edges, TopologyHistory, or an architecture-matched representation change.

The prior **Reject, 4/10, confidence 4/5** verdict belongs to the historical
`2392F034...453822` PDF. It must not be copied forward as a blind-review score
for `848C6035...FFA99F6`. Until a fresh PDF-bound blind review exists, the
current review verdict is pending. Submission readiness remains **NO**.

The following gates remain open:

1. a fresh hash-bound QA receipt, blind review, and submission gate for the
   exact current PDF;
2. the stronger same-observation-and-mask future-decision witness and a
   prospectively frozen same-backbone logical-edge-by-compact-history ablation;
3. wheel acquisition and preflight, an offline clean export/build, a genuinely
   fresh installation, the scoped verification run, a hash-bound reproduction
   receipt, and complete TeX-plus-BibTeX runtime closure; the existing
   contract-only PASS does not close these execution steps;
4. a v2 anonymous-supplement profile and allowlist covering the new paper and
   evidence, an author-reviewed private identity list, per-file approval,
   subject-bound final archive, and independent verify-extract receipt;
5. author-confirmed AI-use facts and exact paper/form disclosure wording;
6. author inspection and completion of the live OpenReview form.

The current supplement tooling and historical candidate/archive receipts remain
`candidate_only_not_approved`. The private verifier receipt remains only a
`contract-only PASS`; neither status changes `author_approved=false`,
`anonymity_coverage_established=false`, `final_archive=false`, or
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
