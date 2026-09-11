# LIFELINE-RL paper handoff

Status date: 2026-09-10 (current-PDF and non-experiment update)

Research baseline: `bd66575f865d5b4bfbdeffc3ca7eea94b24a4f8c`
Input review PDF SHA-256:
`00FAD4373A8F04CB76CDA638014CEEF2FEC6EDBB95C68D97F92C836AFF96793E`

The current candidate is `main.pdf`: 12 US-Letter pages, 5 tables, 3
figures, and 30 cited bibliography entries. The main text and reproducibility
statement end on page 8, references occupy pages 9--11, and the appendix is on
pages 11--12.

Current candidate SHA-256:
`F57152C90C81C9A94D4CAEF5F4C64399B4802559DC91EF9EEF516ABC95CECC6D`

Current source SHA-256:
`E0A676689323BEC8AB0A7C045B893E1FD62DC504F9530354CEE1B3CEFA88CADE`

The current history-twin manuscript revision is working-tree evidence and is
not yet bound to a committed Git subject. The earlier manuscript build subject,
commit `2f4872c05f4d0e264d511255ee5fa4678310d024` and tree
`aca5c8e71dbcc16a767ed206b77d595d5c329ab6`, remains historical and does not
bind these bytes. Local deterministic build/render QA and an independent
blind-first review now bind the exact PDF above; the corresponding v8
submission gate remains `FAIL / Needs major revision`. Submission readiness
remains `NO`.

## Review routing

- Round 2 and `../submission_checks/submission_gate.md` are historical
  snapshots keyed to the full `00FAD...96793E` input hash above. They are not
  current-candidate gates.
- The `A615857B...127B75` post-run review and gate are historical snapshots
  that identified the pooled-Wilson headline issue; they were not rewritten.
- The `B746777E...543D0E` QA, review, and gate are also historical. Source
  changes to Eq. (3), baseline definitions, and compute terminology required a
  new build and invalidated their current-candidate binding.
- The `AB99EC04...1F6CC` and `69247087...D73B88C` QA, review, and gate sets
  are historical byte-bound snapshots. They must not be routed as current.
- The `2392F034...453822` QA, v5 independent review, and v6 submission gate are
  now historical byte-bound snapshots. Their `Reject, 4/10, confidence 4/5`
  and `FAIL / Needs revision` conclusions must not be copied forward as a
  blind-review score or gate for the exact current PDF.
- `ICLR2027_POSTRUN_QA_848C6035.md`,
  `../reviews/iclr2027_postrun_independent_review_v6_848C6035.md`, and
  `../submission_checks/submission_gate_postrun_v7_848C6035.md` are a
  historical 11-page chain for `848C6035...FFA99F6`; their review and gate
  cannot be routed to the current candidate.
- **Current routing at 2026-09-10:**
  `ICLR2027_POSTRUN_QA_F57152C9.md`,
  `../reviews/iclr2027_postrun_independent_review_v7_F57152C9.md`, and
  `../submission_checks/submission_gate_postrun_v8_F57152C9.md` bind the
  exact current 12-page PDF. QA is PASS, but the blind-first review is 4/10
  Weak Reject and v8 is `FAIL / Needs major revision`; readiness remains
  `NO`. All three receipts must be replaced after a paper or final-supplement
  byte change.
- The new C3 history-twin routing is byte-bound in
  `CLAIM_EVIDENCE_LIMITATION_V6.md` and
  `../D6_HISTORY_TWIN_EVIDENCE_ADDENDUM_V2.md`. It is a mask-free Topology
  legality witness, not an equal implemented-observation result.
- D17/D18-v1 canonical provenance is separately bound by
  `../results/validation/d17_d18_v1_canonical_closure_receipt_20260901_b07eb85.md`.
  Canonical integrity passes, but the scientific gate remains `FAIL_CLOSED`.
- `BAD6AF30...4F967` is a different seven-page checkout. Its page count,
  layout findings, and Round 1/Round 3 review conclusions must not be applied
  to this candidate.

## Official ICLR 2027 template

- Author Guidelines:
  <https://iclr.cc/Conferences/2027/AuthorGuidelines>
- Official archive:
  <https://media.iclr.cc/Conferences/ICLR2027/iclr-2027-style-files.zip>
- Archive SHA-256:
  `0D940DFA9398AE99A18F24A85A8A683F367204B6AF6D17D2899E60A67102529E`
- `iclr2027_conference.sty` SHA-256:
  `797DEEF41724E93761426AC0CBCCA46279A91CC650DD1F0CE76A4F08D2098EA6`
- `iclr2027_conference.bst` SHA-256:
  `2D67552DB7ED38CCFCCB5957B52F95656E25C249724761D3CF5F7922AD1844C5`

The style and bibliography style are byte-identical to the official archive
and were not modified. `main.tex` uses `iclr2027_conference`; it contains no
manual `\lhead`, no handwritten review-year header, and no
`\iclrfinalcopy`. The visible ICLR 2027 review header, anonymous author block,
and line numbers are produced by the official style.

## Current claims

The candidate's admitted performance claims remain bounded to accepted
D14--D16 evidence. Its only D17/D18-v1 statement is the separately bound
execution-and-exclusion status described below:

1. The two-player environment has exact snapshots, legal masks, and replayable
   trajectories. Recorded Python/Web agreement is trace-level parity, not an
   exhaustive cross-implementation proof.
2. Complete side-five enumeration finds Grid-equivalent reachable states with
   different latent logical edges, but no legal-action, transition, value,
   shared-action-Q, or optimal-action difference. The paper does not call the
   implemented Grid observation non-Markov or strategically insufficient.
3. Two legal histories from the standard side-six initial state reach the same
   board, typed logical edges, player to act, consecutive-skip count, and
   terminal flag, while placement `(2,3)` is legal after one history and is
   rejected after the other exactly by Superko. This is a naturally reachable
   mask-free Topology history-legality witness. The legal masks differ, so the
   implemented Grid and Topology observations are not equal; the result does
   not establish a same-observation-and-mask future-decision difference,
   optimal-action difference, learning benefit, TopologyHistory benefit, or
   same-backbone ablation result.
4. The frozen formal bundle contains 15 training tasks, 315 evaluation tasks,
   1,500 self-play games, 3,000 gradient updates, 330 receipts, and 30,600
   task-indexed replay-verified game records, with no failed or truncated
   formal task.
5. On jointly trained sizes 5, 7, and 9, all 45 final-checkpoint training-seed
   scores against Random exceed 0.5. This is a five-seed descriptive result,
   not unseen-size or independent-game inference.
6. Against UCT-MCTS-16, five-seed cell medians span 0.477--0.920. Direct-play
   seed summaries are heterogeneous: only Topology-GNN versus Grid-GNN at side
   7 has median 1.00; the other eight model-pair--size medians are 0.50 with
   wide ranges. These summaries support no global representation ranking.
7. Five checkpoint probes are non-monotone and size-dependent; they do not
   establish continuous convergence or relative sample efficiency.

The authoritative mapping for the current candidate is
`CLAIM_EVIDENCE_LIMITATION_V6.md`; v3, the local v4 snapshot, and v5 remain
frozen historical ledgers.
`../D14_D16_TERMINOLOGY_ERRATUM.md` is the append-only clarification for the
historical `unique games` and `compute-matched` wording. The v6 mapping
preserves four non-negotiable limits: external validity is untested beyond one
hand-designed game; Grid-GNN and Topology-GNN differ in relation structure and
hidden width; each D16 200-game task has only two unique color-conditioned
trajectories; and parameters/data are near-matched while FLOPs, memory,
transitions, wall time, and evaluation compute are not fully matched.

## Formal artifacts used

- `../D4_D5_validation_report.md` and the recorded Python/Web parity traces.
- `../state_aliasing/pairs_v1.json` and the exhaustive side-five report.
- `../state_aliasing/superko_n6_witness_v1.json` and replay verifier.
- `../D6_HISTORY_TWIN_EVIDENCE_ADDENDUM_V2.md`, SHA-256
  `B4A91DFF91A3B2B94B85CBD8F123B96F57B98C2F435961E01B419229065C9B8D`.
- `../results/validation/targeted_history_twin_n6_stage5_search_25k_v1.json`,
  SHA-256
  `4B87962DAFFB9AA44B2C67541EF420C8C1574C8E4D6820AFE518632BC10CF9E5`,
  and its independent Python-plus-Web verification receipt, SHA-256
  `555A97F4DA22EC1072AFD0C9B39B2269DA9A2DD30412528EF114013EB6FA1B1F`.
- The corroborating strict-pair candidate and verification JSON, SHA-256
  `5796D643B9F6ED8716983EC3234B2398C7B50D221E2A16EBB9682BA1FB6479F5`
  and
  `EF209D84F7906B1858E9954415CD5971AF1F6D2EE878A811BE27EF78B4AD41A1`.
- `../D14_D16_EXPERIMENT_PROTOCOL.md`.
- `../D14_D16_RESULTS.md`.
- `../configs/d14_d16_parameter_counts.json`.
- `../results/formal/d14_d16/run_v1/result_ledger_status.json`, where
  `formal_ready=true` and `valid=true`.
- `../results/formal/d14_d16/run_v1/result_receipts.jsonl`, SHA-256
  `FF3EF8BFD9B7A443BC42BA16AB9D4DAA9F855A5D0432D58A62322686247B8114`.
- `../results/formal/d14_d16/aggregate_v1/aggregate.json`, SHA-256
  `59C264FC65D7B11357B0D718D38371DF1BA44BE4B92E7EF41FF995BF088F501C`.
- The frozen D14--D16 aggregate CSV files named in the claim ledger and figure
  contracts.
- `../SUPERKO_POLICY_MATRIX_RESULTS.md` and its independent verification
  artifact.

## Related work and figures

The bibliography contains 30 cited, metadata-audited records with no missing or
uncited key. It now directly covers Ludii, Regular Boardgames, Polygames,
Hex board-size/game-variant transfer, chess graph RL, and GNN-based Hex, in
addition to self-play, environments, graph learning, state aliasing, masking,
and repetition rules. Registry sources and the Polygames year decision are
recorded in `LITERATURE_METADATA_AUDIT.md`.

The three figures remain source-bound to frozen D14--D16 artifacts. The paper
uses vector PDF assets with embedded Times New Roman text; 320 dpi PNG copies
are retained only for inspection and previews. Body text keeps the official
Times family with T1 encoding, and bibliography URLs use the surrounding text
font rather than a separate monospace face.

1. `figures/fig1_lifeline_logical_edges.pdf`: side-five latent topology
   witness and its decision-relevance limitation.
2. `figures/fig2_checkpoint_curves.pdf`: five formal score-rate probes against
   UCT-MCTS-16.
3. `figures/fig3_model_size_opponent_heatmap.pdf`: final seen-size score rate
   by model and opponent.

The figure builder SHA-256 is
`C08FE66F4E239FD7D7F071E68E37DBF7720CCB37BB951E7EAEF6A0C6F5F04916`.

No training or AutoDL work was initiated by this paper-writing, figure, or PDF
workflow.

## D17--D19 exclusion gate

The D17/D18-v1 process completed 85/85 tasks and all 8,320 games with zero
execution failures, missing tasks, or truncations. The authenticated producer
and independent verifier now produce byte-identical canonical numeric files,
and all three canonical-integrity gates pass. D18 still passes only 23/45
task-level diversity criteria: the other 22 criteria misses roll up to the
single false overall gate `unique_trajectory_thresholds_met`. The bundle
therefore remains `formal_ready=false`, the scientific gate remains
`FAIL_CLOSED`, and D19 remains closed. The public-safe closure receipt is
`../results/validation/d17_d18_v1_canonical_closure_receipt_20260901_b07eb85.md`
with SHA-256
`DA346F73BAE880DEF896F4E18C285A4E93DC45DD6E9FC76D0B93DAE32DE5CDBC`.
No D17--D19 performance, generalization, confidence interval, significance,
D16-v2, or matched-architecture result is admitted.

## Release statement

The release-claim contract now exists at
`../supplement/RELEASE_CLAIM_DELTA.md`. It preserves the narrowed wording
derived from the applicable `../submission_checks/submission_gate.md`: the
paper names compact aggregate CSV/JSON, the append-only receipt-ledger JSONL,
hashes, protocols, and independent verifier outputs. It explicitly does not
claim that checkpoints, raw per-game logs, or local task directories are
included in submission artifacts. The contract is
`candidate_only_not_approved`, not an archive, author approval, or release
receipt.

`../supplement_tools/` contains the historical narrow candidate policy and
historical 120-payload candidate policy, plus a separate V2
130-payload/134-member topology reconciled against the V2 profile. Every
workflow remains hard-coded `candidate_only_not_approved`. Existing local
candidate/archive receipts predate production subject binding and remain
historical engineering evidence. The old 120-payload/124-member topology
predates the v6 paper and is not claim-complete for the current PDF. The V2
profile, allowlist, review template, and portable runner are still untracked
working-tree inputs; a clean subject, author review, identity scan, and fresh
archive gate are required. Neither candidate may be silently promoted.

A private subject-bound execution-contract receipt now records only a
`contract-only PASS`: 126 files are byte-bound in total, comprising 124 frozen
inputs and two verifier tool sources. The exact 25-file `lifeline_rl`
package-source closure passes, all 120 claim rows close in both directions, the
eleven future outputs remain absent, and all ten verbatim Git transport rules
pass. This run accessed no network, created no environment, built or installed
no package, and ran no test, game, or training. The private receipt, all real
Git commit/tree object identifiers, and internal build identifiers are
local-only and must not enter the anonymous supplement; public closure must
bind archive/member-manifest content hashes or an anonymized subject. The
receipt is not one of the 120 payloads or 124 archive members. The compact
auditor is a future Gate E `tracked-metadata-consistency-only` tool; this
contract run did not execute it, and it is likewise not a member of that
topology.

This tooling does not create or approve the final anonymous supplement. No
author-approved allowlist, private identity profile, final archive, archive
hash, or independent clean-copy gate currently exists.

## P0 and P1 status

Resolved for this candidate:

- P0-1: migrated from the 2026 placeholder to byte-identical official ICLR 2027
  style, removed the handwritten year header, rebuilt, and rechecked all pages.
- P1: replaced every `30,600 unique games` form with
  `30,600 task-indexed replay-verified game records`.
- P1: added the requested closest-neighbor literature and retained explicit
  single-game, architecture-confounding, repeated-trajectory, and compute
  limitations.
- P1: corrected Eq. (3) against the live relational-block implementation and
  fully specified the fixed search baselines.
- P1: narrowed `compute-matched` to simulation-count matching and preserved
  the historical evidence through an append-only terminology erratum.
- P1: added an exact 20-package Windows/CUDA lock and a retained-environment
  verification receipt with `ok=true` and zero errors.
- Earlier repository test totals remain historical hash-bound snapshots. The
  current local paper build is byte-stable under the recorded deterministic
  environment; it does not claim a fresh install or a current full-repository
  test total. `ICLR2027_POSTRUN_QA_F57152C9.md` supplies a named current-PDF
  technical QA; its matching blind review and v8 gate remain negative
  scientific/submission evidence rather than a readiness pass.
- The overbroad release inventory in the manuscript was narrowed to compact
  artifacts actually named by the evidence mapping.

Still open:

1. P0-A AI-use disclosure. `AI_USE_DISCLOSURE_DRAFT.md` is the detailed audit,
   and `AI_USE_AUTHOR_DECISION_PACKET.md` is an unfilled one-page author
   worksheet. The authors have not confirmed the inventory or wording, so no
   AI-use statement is present in `main.tex` and P0-A remains open.
2. P0-B anonymous supplement. Candidate-only builder tooling exists, but no
   author-approved, identity-scanned, hash-bound final archive has been
   assembled or independently gated.
3. The named `RELEASE_CLAIM_DELTA.md` contract is now present, but it remains
   candidate-only. It does not substitute for a subject-bound, identity-scanned,
   author-approved archive and independent verify-extract receipt.
4. D17/D18-v1 execution and canonical integrity are complete, but the frozen
   scientific gate failed; D19 remains closed. All D17--D19 performance claims
   remain excluded.
5. The side-six witness closes only natural paired-history legality under a
   mask-free Topology projection. Because the legal masks differ, the central
   same-observation-and-mask future-decision construct-validity blocker remains
   open. No learning benefit, optimal-action difference, TopologyHistory
   benefit, or same-backbone logical-edge-by-history ablation is established.
6. P0-D reproduction package. The retained environment matches the new exact
   lock, but the private verifier has only a `contract-only PASS`; no wheelhouse,
   offline clean export/build, fresh environment, installation, scoped test
   run, or fresh clean-install/reproduction receipt exists. Fresh clean-install
   reproduction therefore remains `OPEN / NOT VERIFIED`.
7. The live OpenReview form has not been verified or completed by an author.
   Current-PDF QA, blind review, and v8 gate are bound, but v8 is negative and
   all three must be rerun after any paper or final-supplement byte change.

## Build and QA

`latexmk` did not complete on this Windows host because its Perl/runtime
mapping was unavailable. The verified fallback build used the deterministic
environment `SOURCE_DATE_EPOCH=1788115675`, `FORCE_SOURCE_DATE=1`, and
`TZ=UTC`, followed by BibTeX and three post-BibTeX stabilization passes:

```powershell
# From the repository root:
Set-Location 'research/iclr2027/paper'
$env:SOURCE_DATE_EPOCH='1788115675'
$env:FORCE_SOURCE_DATE='1'
$env:TZ='UTC'
pdflatex -interaction=nonstopmode -halt-on-error main.tex
bibtex main
pdflatex -interaction=nonstopmode -halt-on-error main.tex
pdflatex -interaction=nonstopmode -halt-on-error main.tex
pdflatex -interaction=nonstopmode -halt-on-error main.tex
```

All five commands exited 0. The stable `main.log`/`main.blg` contains no
undefined citation/reference, rerun request, overfull box, LaTeX error, or
BibTeX warning. Non-blocking underfull boxes and MiKTeX's denied access to its
global diagnostic log remain, but the PDF build itself succeeded.

The exact `F57152C9...CECC6D` PDF was reproduced byte-identically by an
additional fixed-environment pass. It passed 12-page rendering, US-Letter,
24/24 embedded-font, anonymous-author/title-info, hidden-link-border,
vector-figure, and visual checks. Its Catalog `/Names` dictionary contains
only `/Dests`; it has no `/EmbeddedFiles`, `/EF`, `/Filespec`, `/JavaScript`,
`/JS`, `/AA`, `/AcroForm`, or `/Metadata`. `/OpenAction` is present only as a
page-one `/GoTo` destination, not a script. All 90 annotations are borderless
links, with no Widget or FileAttachment annotation. The named current-PDF QA
receipt is `ICLR2027_POSTRUN_QA_F57152C9.md`; it records that the PDF still has
standard creator/producer metadata and requires a private author identity
review. Official-template provenance remains in `ICLR2027_MIGRATION_QA.md`.

No push, paid AutoDL action, formal game, or OpenReview action was performed by
this paper/reproduction update.
