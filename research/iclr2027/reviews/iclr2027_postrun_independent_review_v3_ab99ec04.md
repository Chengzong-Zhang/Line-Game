# LIFELINE-RL ICLR 2027 post-run independent review v3

## Hash binding and review protocol

- Review object: `research/iclr2027/paper/main.pdf`
- PDF SHA-256:
  `AB99EC04D15D43FE59E5238D4ED48F07D10516CB3FEC0246D6B61454E2E1F6CC`
- Source SHA-256:
  `8C3C439363D63E85063B80703D604E9ABDED3689F0AD9AAF86AE398474A86D55`
- Review date: 2026-08-31 (Asia/Shanghai)
- PDF QA receipt:
  `paper/ICLR2027_POSTRUN_QA_AB99EC04.md`, SHA-256
  `8C98F8FC82B2AB9E7FC4C35724334A69D6F2D97B7F9689864BEFC01C6DFCDA2B`
- D14--D16 independent aggregate audit: `ok=true`, 72/72 rows compared,
  zero score/WDL/Wilson mismatches, and 630/630 sampled replays passed.
- D17/D18 local independent verifier report SHA-256:
  `2C8C98D9A49593A85E2C39EE2F5F4D250593F53A0F9A18BBE4EB262E58FF985E`

This is a new review of the `AB99EC04...E1F6CC` candidate. It does not
rewrite or inherit the historical `A615857B...127B75` or
`B746777E...543D0E` reviews, QA receipts, or submission gates. Any byte change
to the PDF invalidates the PDF findings below.

The review was read-only. All 11 pages were freshly rendered and inspected;
PDF metadata, fonts, geometry, extracted text, the corrected source passages,
their implementation counterparts, the frozen D14--D16 aggregates, the
environment receipt, and the candidate-only supplement tooling were checked.

## Overall assessment

**Recommendation: Weak Reject / Needs revision. Current submission gate:
FAIL.**

The candidate is technically clean and substantially more defensible than the
historical versions. The official template, anonymity, layout, references,
Eq. (3), search-baseline definitions, simulation-count wording, and 30,600
record terminology all pass for this exact hash. These corrections do not,
however, remove the mandatory AI-use and release-package blockers or the main
scientific limitation: the admitted learned-model evaluation repeats only two
deterministic trajectories per 200-game task.

## PDF and presentation integrity

The live file cross-checks against the QA receipt:

- 11 US-Letter pages, rotation 0, unencrypted, no form or JavaScript;
- main text and reproducibility statement finish on page 8, with references
  on pages 8--10 and appendix material on pages 10--11;
- all listed fonts are embedded and subset;
- official ICLR 2027 review style, anonymous visible author block, and empty
  author/title metadata;
- 11/11 pages have no clipping, overlap, broken table, unreadable glyph,
  visible link box, or accidental blank tail page;
- extracted text has no author name, username, email, local path, or literal
  D17/D18/D19 label.

**PDF/technical QA: PASS for `AB99EC04...E1F6CC`.** The absent AI-use
statement is recorded below as a blocking policy failure, not hidden inside
the presentation pass.

## Method and baseline correction review

Eq. (3) now matches the implementation: biased self projection, bias-free
relation projections over degree-normalized relation messages with a
zero-degree clamp, ReLU residual addition, LayerNorm, and masking of padded
nodes after every block and before pooling. The equation is legible and
correctly numbered in the rendered PDF.

The search-baseline paragraph now defines Random, Greedy, approximate
depth-2/3 Minimax, and adversarial UCT-MCTS-16 sufficiently to interpret the
reported comparisons. It also correctly states that 16 matches only the
nominal simulation count. It does not claim matched FLOPs, wall time, rollout
transitions, expanded nodes, memory, or hardware cost.

**Source--implementation consistency for the corrected passages: PASS.**

## D14--D16 evidence and claim boundary

The independent audit loaded the frozen manifest, task bundles, receipt
ledger, per-game artifacts, checkpoints, and canonical aggregate. It reported
`ok=true`, 330/330 complete receipts, no failures or truncations, 1,500
self-play games, 3,000 gradient updates, 30,600 task-indexed replay-verified
records, 72/72 canonical rows with zero numeric mismatch, and 630 sampled
replays without failure.

The manuscript keeps the correct limitations:

- results cover jointly trained sizes 5, 7, and 9 only;
- Wilson intervals are pooled descriptive summaries, not independent-game
  inference;
- each D16 200-game task repeats only two deterministic color-conditioned
  trajectories;
- no global representation ranking or logical-edge causal conclusion is
  claimed;
- Grid-GNN and Topology-GNN differ in both relation structure and hidden width;
- model parameters and data are near-matched, while broader compute is not.

**D14--D16 number and wording boundary: PASS.** This is a bounded evidence
pass, not a judgment that the experiment is sufficiently persuasive for
acceptance.

## D17--D19 fail-closed review

The later D17/D18 execution completed 85/85 tasks and 8,320/8,320 games, but
D18 passed only 23/45 frozen trajectory-diversity gates. The bundle therefore
remains `formal_ready=false`; canonical numeric equality is not established,
and D19 did not run. The manuscript admits no D17--D19 performance row.

**D17--D19 exclusion boundary: PASS. Scientific experiment gate:
FAIL_CLOSED.** Frozen thresholds must not be lowered after observing the
failure, and no failed or diagnostic row may be promoted into the paper.

## Reproducibility and engineering status

- The final local suite passed 261 tests plus 174 subtests.
- The supplement-builder self-test passed ten cases; one real-symlink test was
  skipped because this Windows account lacks symlink-creation privilege, while
  the simulated reparse-point rejection test passed.
- `ruff check` and `git diff --check` passed.
- A 19-package Windows/CUDA lock and retained-environment receipt now exist.
  The receipt reports `ok=true` for CPython 3.10.20, PyTorch 2.7.1+cu118,
  CUDA 11.8, and cuDNN 90100.
- The supplement builder uses a strict explicit allowlist, hash binding,
  overwrite refusal, deterministic metadata, and identity/path/credential/
  host scans. Its status is intentionally `candidate_only_not_approved`.

The old statement that no dependency lock exists is now stale. The current
lock verifies the retained environment, but no fresh clean-room environment
has yet been installed and used to reproduce the package. Likewise, the
builder is not a final archive: there is no author-approved allowlist, private
identity profile, final tree, archive hash, or independent clean-copy gate.

## Blocking P0 submission gates

### P0-A: author-confirmed AI-use disclosure

Neither source nor PDF contains the mandatory AI-use statement.
`AI_USE_DISCLOSURE_DRAFT.md` is explicitly an unconfirmed worksheet. Closure
requires every author to confirm actual tools, paper-relevant tasks, retained
outputs, unpublished-material handling, and human verification; approve the
wording; add the statement to the paper; complete the separate live form; then
rebuild and re-gate the new hash.

**Status: OPEN; blocks submission.**

### P0-B: anonymous final supplement and release decision

Candidate-only tooling now exists, but no final candidate or archive is
approved. Closure requires author review of every allowlisted file, a complete
private identity-term profile, a fresh build and verification, archive-level
hash/metadata checks, clean-copy execution, and independent gating of the
exact bytes offered for submission.

**Status: OPEN; blocks the project-defined submission gate.**

### Live submission form

The live OpenReview form, including its separate AI-use disclosure, has not
been verified or completed by an author.

**Status: NOT VERIFIED; blocks final submission.**

## Scientific work most likely to change the review outcome

1. Run a prospectively frozen paired-opening/trajectory-diverse learned-model
   evaluation with seed-aware inference. The failed D18 run cannot be repaired
   by lowering observed thresholds; a replacement needs a new protocol,
   manifest, experiment ID, runner identity, and run root.
2. Isolate logical-edge input with a same-architecture, same-width controlled
   ablation and record FLOPs, memory, transitions, wall time, and evaluation
   cost. D19 must stay disabled until its prerequisites pass and paid execution
   receives separate authorization.
3. Strengthen external and opponent validity: independent zero-shot board
   sizes, calibrated stronger search baselines, and ideally another game or
   environment. If these are out of scope, position the paper more explicitly
   as an auditable benchmark/system contribution rather than a general
   representation result.

These are acceptance-strength recommendations, not authorization to start a
paid experiment.

## Final recommendation

Do not submit the current PDF, do not enter D23--D24, and do not add D17--D19
performance numbers. Preserve the technical corrections and the failed run as
append-only evidence. Close the author AI-use and final-package gates first;
then decide whether the larger scientific additions are feasible before the
deadline.

**Final recommendation: Weak Reject / Needs revision. Confidence: 0.90.**

This report applies only to PDF SHA-256
`AB99EC04D15D43FE59E5238D4ED48F07D10516CB3FEC0246D6B61454E2E1F6CC`
and QA receipt SHA-256
`8C98F8FC82B2AB9E7FC4C35724334A69D6F2D97B7F9689864BEFC01C6DFCDA2B`.
