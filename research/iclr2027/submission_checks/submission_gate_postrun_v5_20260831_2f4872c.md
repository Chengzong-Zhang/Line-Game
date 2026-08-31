# LIFELINE-RL post-run submission gate v5

- Gate date: 2026-08-31 (Asia/Shanghai)
- Subject commit: `2f4872c05f4d0e264d511255ee5fa4678310d024`
- Subject tree: `aca5c8e71dbcc16a767ed206b77d595d5c329ab6`

## Decision

**FAIL / Needs revision**

| Domain | Current status | Boundary |
| --- | --- | --- |
| Exact PDF/render QA | PASS | only SHA-256 `2392F034...A453822` |
| Current-environment paper A/B | PASS | byte-identical PDF and schema-v3 receipt |
| Complete TeX plus BibTeX input closure | FAIL / not claimed | only all-`pdflatex`-pass `.fls` inputs are closed |
| D14-D16 evidence | PASS, bounded | descriptive accounting only |
| D17/D18-v1 execution | complete | 85/85 tasks; 8,320/8,320 games |
| D17/D18 scientific gate | FAIL_CLOSED | 22/45 D18 gates fail; `formal_ready=false` |
| D19 | CLOSED | prerequisite gate failed |
| D18-v3 formal evidence | ZERO | no formal run receipts or verifier |
| Claim-complete tooling | TECHNICAL PASS | subject-bound code; candidate only |
| Scientific sufficiency | FAIL | Reject, 4/10, confidence 4/5 |
| AI-use paper statement | OPEN | author facts and wording unconfirmed |
| Real anonymity coverage | OPEN | complete author identity variants absent |
| Final supplement archive | OPEN | per-file and archive approval absent |
| Fresh clean install | NOT VERIFIED | retained environment only |
| Live OpenReview form | NOT VERIFIED | no external form inspection or submission |

Technical paper reproducibility improved materially, but no technical pass in
this table overrides the scientific or author gates.

## Current manuscript binding

- `main.pdf`:
  `2392F034DA6D5C435C7CB9AFCCF6BF615F7EF6F2A87B455D32138B608A453822`
  (448,039 bytes; 11 pages);
- `main.tex`:
  `3B107FB96825955EBF5B7177D30B471938EE1128A3214FFC1C2CCAC1CE580402`;
- `references.bib`:
  `2AB031B8523D581DA9B807C128A9197F5BF687F730529A94C39645BAE3284659`;
- build receipt A/B:
  `9EDA9A4148C16562C6421F58D7CD0F872F3FADA1362FDEBA8056ABF764E8C6A5`;
- fixed input tree:
  `E53963DFC1996676C369B93E032922E57CC4FEDC72500A90EB27192EE5E194A4`;
- stable output tree:
  `78B3EEACD155D642A886EE3D269D1FE483334DCF3DFB461E66E480EB663240A2`;
- canonical LaTeX runtime tree:
  `8164BC39AD3A0925620DB4CC7302B479EE17EC3A1DD985BABD698F070CD7EE22`.

Both clean builds reproduced the checked-in PDF exactly and produced the same
receipt bytes. The receipt binds the explicit commit/tree, nine Git blobs,
tool hashes, stable outputs, and 129 canonical runtime files. Raw host-specific
`.fls`/log diagnostics remain local-only and are excluded from release.

The receipt truthfully leaves scientific claims, author approval, submission
readiness, BibTeX input closure, and complete TeX-toolchain input closure false.

## Evidence anchors

The following SHA-256 values were resampled from the exact files used by this
gate. The first two bind the companion human-readable receipts; they do not
make either receipt independent scientific evidence. Paths below are relative
to `research/iclr2027/`.

- current-PDF QA receipt,
  `paper/ICLR2027_POSTRUN_QA_2392F034.md`:
  `F743140082A979D5AB43E98FB541D59ACDE4AE12C68CDE575504C83FB545F7CA`;
- independent review v5,
  `reviews/iclr2027_postrun_independent_review_v5_2392F034.md`:
  `5A20F9F91735E49FF3512CA589D4CB154D018D59C10D6CE0904EA167AEBB2F22`;
- D14-D16 receipt ledger, `results/formal/d14_d16/run_v1/`
  `result_receipts.jsonl`:
  `FF3EF8BFD9B7A443BC42BA16AB9D4DAA9F855A5D0432D58A62322686247B8114`;
- D14-D16 canonical aggregate,
  `results/formal/d14_d16/aggregate_v1/aggregate.json`:
  `59C264FC65D7B11357B0D718D38371DF1BA44BE4B92E7EF41FF995BF088F501C`;
- D14-D16 independent receipt audit,
  `results/validation/d14_d16_independent_receipt_audit_20260831.json`:
  `F64C8DE1A2FCA86CF7681A855EDFB244033B318E65E14B2ADD64EDE27E4EF648`;
- D17/D18-v1 local independent verification report,
  `results/formal/d17_d19/run_20260830_p0_autodl_canonical_v1/verification/local_independent_v1/independent_verification.json`:
  `2C8C98D9A49593A85E2C39EE2F5F4D250593F53A0F9A18BBE4EB262E58FF985E`;
- frozen D17-D19 manifest, `configs/d17_d19_formal_manifest.json`:
  `2349C2B47AC06CD0632F6B06AEA8950A21846F9FFA88320DE4BCC7A49639FFB9`.

The D17/D18-v1 verification report remains inside the ignored local formal
result tree. Hash-binding it here does not add that tree to Git or to an
anonymous supplement.

## Current evidence boundaries

### D14-D16

The formal ledger remains 330/330 complete with compact independent audit and
replay evidence. It supports task/hash/count reconciliation and the paper's
five-seed descriptive summaries. Each D16 200-game task still has exactly two
full-trajectory clusters repeated 100 times. The authoritative status remains
`PASS_DESCRIPTIVE_ONLY_NO_INFERENCE`; no global ranking, causal effect,
sample-efficiency, unseen-size, or independent-game inference is admitted.

### D17/D18-v1 and later work

D17/D18-v1 completed 85 tasks and 8,320 games without a failed/truncated task,
but failed the frozen scientific gate. Direct recomputation finds 22 failed
D18 cells: 15/15 at size 5, 5/15 at size 7, and 2/15 at size 9. The canonical
numeric interface is also absent. Producing that numeric artifact is a useful
pure-CPU integrity task, but it cannot erase the 22 trajectory-diversity
failures or make `formal_ready` true.

D19 remains closed. D18-v3 directories contain preparation artifacts only;
there is no formal run, result receipt ledger, or independent verifier. The
BASE-SEARCH matrix likewise has no admitted formal result. None may be run or
described as complete without a separately frozen protocol, budget, cost,
stop policy, and action-time authorization.

## Claim-complete supplement status

Tooling commit `f3789671934f37a799e42cc3b09c3dd2fb35de4e` adds explicit Git-subject
binding and immutable candidate snapshots to the claim-complete derivation,
verification, candidate, and archive workflows. The tooling and tests, not a
production candidate/archive receipt, exercised those code paths. The
session-observed terminal results were:

- generic self-test: 12 pass and one Windows symlink-capability skip;
- subject-binding self-test: 8/8 pass;
- claim-complete self-test: 36/36 pass;
- archive self-test: 34/34 pass;
- four isolated CLI `-I -S -B --help` launches;
- Ruff Python 3.10 format/check and staged diff checks.

No separate hash-bound machine-readable test receipt was persisted for those
terminal totals. Existing local submission-v5 candidate and archive receipts
predate this commit and do not themselves carry `subject_commit`,
`subject_tree`, or `subject_binding_verified` fields. The results establish
tooling capability and close the tested workflow-local replacement windows;
they do not prove that a production candidate is subject-bound or anonymous.
A real complete identity list, author review of each allowlist entry, a rebuilt
exact candidate/archive with the new fields, final archive approval, and
clean-copy verification are still required.

## Scientific decision

The exact current PDF was independently re-reviewed and remains:

- recommendation: **Reject**;
- score: **4/10**;
- confidence: **4/5**.

The score-driving blockers are unchanged:

1. no decision-relevant topology/history witness in the evaluated benchmark
   distribution;
2. no controlled single-architecture topology/history ablation;
3. trajectory-poor deterministic evaluation and weakly calibrated opponents;
4. an incomplete standalone benchmark/rule contract.

Artifact bookkeeping cannot substitute for those scientific results.

## Required closure

### Local technical work that can continue without external action

1. Persist a current-hash QA/review/gate chain and keep every later byte change
   fail-closed.
2. Build the missing D17/D18-v1 canonical numeric artifact from frozen receipts
   and independently verify it, while preserving `formal_ready=false`.
3. Prepare a fresh-install/wheelhouse plan and run it only in a genuinely clean
   environment with a hash-bound receipt.
4. Prepare the exact per-file supplement review sheet for author approval.

### Author or external gates

1. Authors complete the AI-use fact inventory and approve the paper statement;
   any insertion creates a new PDF that requires full rebuild and QA.
2. Authors supply the complete private identity variant list and approve every
   supplement file plus the final archive.
3. An author inspects and completes the live OpenReview fields, including the
   separate AI-use answer, and checks consistency with the paper.
4. Any new D18-v3, D19, BASE-SEARCH, GPU, AutoDL, or paid run requires an exact
   manifest, cost, instance, budget, stop rule, and action-time authorization.

## Final gate

- Submission readiness: **NO**.
- Entry to paid extension work: **NO without new authorization**.
- Current PDF technical quality: **PASS for `2392F034...A453822` only**.
- Current-environment reproducibility: **PASS with narrow LaTeX closure only**.
- Scientific recommendation: **Reject, unchanged**.
- External upload or submission performed: **NO**.
