# LIFELINE-RL paper handoff

Status date: 2026-08-31

Research baseline: `bd66575f865d5b4bfbdeffc3ca7eea94b24a4f8c`
Input review PDF SHA-256:
`00FAD4373A8F04CB76CDA638014CEEF2FEC6EDBB95C68D97F92C836AFF96793E`

The current candidate is `main.pdf`: 11 US-Letter pages, 5 tables, 3
figures, and 30 cited bibliography entries. The main text and reproducibility
statement end on page 8, references occupy pages 8--10, and the appendix is on
pages 10--11.

Current candidate SHA-256:
`AB99EC04D15D43FE59E5238D4ED48F07D10516CB3FEC0246D6B61454E2E1F6CC`

Current source SHA-256:
`8C3C439363D63E85063B80703D604E9ABDED3689F0AD9AAF86AE398474A86D55`

## Review routing

- Round 2 and `../submission_checks/submission_gate.md` are historical
  snapshots keyed to the full `00FAD...96793E` input hash above. They are not
  current-candidate gates.
- The `A615857B...127B75` post-run review and gate are historical snapshots
  that identified the pooled-Wilson headline issue; they were not rewritten.
- The `B746777E...543D0E` QA, review, and gate are also historical. Source
  changes to Eq. (3), baseline definitions, and compute terminology required a
  new build and invalidated their current-candidate binding.
- The current candidate is routed through
  `../reviews/iclr2027_postrun_independent_review_v3_ab99ec04.md` and
  `../submission_checks/submission_gate_postrun_v3_20260831_ab99ec04.md`.
  P0-C is closed for this hash, but the overall gate remains `FAIL` and does
  not authorize D23--D24.
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

The candidate remains bounded to accepted D14--D16 evidence:

1. The two-player environment has exact snapshots, legal masks, and replayable
   trajectories. Recorded Python/Web agreement is trace-level parity, not an
   exhaustive cross-implementation proof.
2. Complete side-five enumeration finds Grid-equivalent reachable states with
   different latent logical edges, but no legal-action, transition, value,
   shared-action-Q, or optimal-action difference. The paper does not call the
   implemented Grid observation non-Markov or strategically insufficient.
3. A standard-start side-six witness shows that Superko can reject an otherwise
   loop-closing move. This is a binding-rule witness, not a naturally reached
   paired-history legality alias.
4. The frozen formal bundle contains 15 training tasks, 315 evaluation tasks,
   1,500 self-play games, 3,000 gradient updates, 330 receipts, and 30,600
   task-indexed replay-verified game records, with no failed or truncated
   formal task.
5. On jointly trained sizes 5, 7, and 9, all nine model--size cells beat Random.
   Against UCT-MCTS-16, seven descriptive Wilson lower bounds exceed 0.5,
   Padded-CNN at side five is borderline, and Grid-GNN at side five is
   inconclusive.
6. Topology-GNN's pooled direct-play score exceeds Grid-GNN's on all three seen
   sizes in this run. Size-dependent reversals and two repeated
   color-conditioned trajectories per D16 task preclude a global
   representation ranking and independent-game inference.
7. Five checkpoint probes are non-monotone and size-dependent; they do not
   establish continuous convergence or relative sample efficiency.

The authoritative mapping for the current candidate is
`CLAIM_EVIDENCE_LIMITATION_V3.md`; v2 remains a frozen historical ledger.
`../D14_D16_TERMINOLOGY_ERRATUM.md` is the append-only clarification for the
historical `unique games` and `compute-matched` wording. The v3 mapping
preserves four non-negotiable limits: external validity is untested beyond one
hand-designed game; Grid-GNN and Topology-GNN differ in relation structure and
hidden width; each D16 200-game task has only two unique color-conditioned
trajectories; and parameters/data are near-matched while FLOPs, memory,
transitions, wall time, and evaluation compute are not fully matched.

## Formal artifacts used

- `../D4_D5_validation_report.md` and the recorded Python/Web parity traces.
- `../state_aliasing/pairs_v1.json` and the exhaustive side-five report.
- `../state_aliasing/superko_n6_witness_v1.json` and replay verifier.
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

The AutoDL P0 process completed 85/85 D17/D18 tasks and all 8,320 games with
zero execution failures, missing tasks, or truncations. D17 passed all 40 task
diversity gates, but D18 passed only 23/45: 22 D18 tasks failed the frozen
trajectory-diversity gate. The bundle therefore remains
`formal_ready=false`. A local independent verifier replayed 8,320/8,320 games
and returned `FAIL_CLOSED`; its report SHA-256 is
`2C8C98D9A49593A85E2C39EE2F5F4D250593F53A0F9A18BBE4EB262E58FF985E`.
Canonical numeric equality was not supplied, and D19's conditional P1 gate
remained closed. No D17--D19 performance, generalization, confidence interval,
significance, D16-v2, or matched-architecture result appears in the paper.

## Release statement

The requested `supplement/RELEASE_CLAIM_DELTA.md` does not exist anywhere in
the current repository. Release wording was therefore narrowed against the
applicable `../submission_checks/submission_gate.md`: the paper names compact
aggregate CSV/JSON, the append-only receipt-ledger JSONL, hashes, protocols, and
independent verifier outputs. It explicitly does not claim that checkpoints,
raw per-game logs, or local task directories are included in submission
artifacts.

`../supplement_tools/` now contains a strict allowlist, deterministic
builder/verifier, privacy scanner, and self-test for a narrow dependency-free
rules/search-agent candidate. Its status is hard-coded
`candidate_only_not_approved`; it excludes paper files, formal/smoke/pilot
result trees, raw trajectories, checkpoints, logs, databases, archives,
credentials, local paths, remotes, and private identity terms.

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
- P1: added an exact 19-package Windows/CUDA lock and a retained-environment
  verification receipt with `ok=true` and zero errors.
- The hash-bound QA snapshot recorded 261 tests plus 174 subtests. A later
  full-suite rerun on local HEAD `b6fca84` passed 275 tests plus 174 subtests
  after the D18 capacity-evidence commit and the Python 3.10 TOML-test
  compatibility fix; supplement-tool self-tests, `ruff check`, and
  `git diff --check` also pass.
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
3. The named `RELEASE_CLAIM_DELTA.md` input is missing; only the applicable
   submission gate could be followed.
4. D17/D18 execution is complete but the formal gate failed; D19 was not
   enabled. All D17--D19 performance claims remain excluded.
5. P0-D reproduction package. The retained environment matches the new exact
   lock, but a fresh clean-install/reproduction receipt is still outstanding.
6. The live OpenReview form has not been verified or completed by an author.
   The fresh independent gate on this PDF hash exists and returns `FAIL`; it
   must be rerun after any paper or supplement change.

## Build and QA

`latexmk` did not complete on this Windows host because its Perl/runtime
mapping was unavailable. The verified fallback build used BibTeX plus three
post-BibTeX stabilization passes:

```powershell
Set-Location 'C:\coding\py\line game\research\iclr2027\paper'
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

The latest PDF passed 11-page rendering, US-Letter, embedded-font, anonymity,
empty author/title metadata, hidden-link-border, vector-figure, and visual
checks. Current-candidate details are in
`ICLR2027_POSTRUN_QA_AB99EC04.md`; official-template provenance remains in
`ICLR2027_MIGRATION_QA.md`. The AB99 QA receipt, independent review, and gate
have SHA-256 values `8C98F8FC...CDA2B`, `213FB108...89451`, and
`E2ADAB2F...F2D23`, respectively.

No push, paid AutoDL action, formal game, or OpenReview action was performed by
this paper/reproduction update.
