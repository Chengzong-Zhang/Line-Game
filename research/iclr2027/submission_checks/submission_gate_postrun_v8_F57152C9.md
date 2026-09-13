# LIFELINE-RL post-run submission gate v8

Status date: 2026-09-10  
Disposition: **FAIL / Needs major revision. `submission_ready=false`.**

This is the only submission gate in this directory that binds the current
12-page manuscript bytes.  It supersedes v7 **only for routing the current
candidate**; v7 and every earlier receipt remain immutable historical evidence
for their own PDFs.

## Exact subject and receipt chain

| Item | SHA-256 | Status / scope |
|---|---|---|
| `paper/main.pdf` | `F57152C90C81C9A94D4CAEF5F4C64399B4802559DC91EF9EEF516ABC95CECC6D` | 455,696 bytes; 12 US-Letter pages |
| `paper/main.tex` | `E0A676689323BEC8AB0A7C045B893E1FD62DC504F9530354CEE1B3CEFA88CADE` | source for the bound PDF only |
| `paper/references.bib` | `3BEEACFBDCF4CFF4D793B2982E61BCAB5DA0FAC0C9609EF26E995A631F6078A2` | 30 cited, metadata-audited entries |
| `paper/ICLR2027_POSTRUN_QA_F57152C9.md` | `F9493BCF630E308261A9303ADEA654571863C3C51FB90426791BA5AF08C2F63E` | technical and visual PDF QA: PASS only for this PDF |
| `reviews/iclr2027_postrun_independent_review_v7_F57152C9.md` | `4D0438205DA37AD1B6266DC434328EE5A7C5607E213291597BDEFC62C9474298` | blind-first review: 4/10, Weak Reject; confidence 4/5 |

Any change to the PDF, `main.tex`, bibliography, figures, final supplement,
or author-required statement invalidates this chain and requires a fresh build,
QA, independent review, and submission gate.

## Gate matrix

| Gate | Current result | Evidence and boundary |
|---|---|---|
| PDF mechanics and visual export | **PASS, narrow** | The named QA receipt records a stable build, 24/24 embedded fonts, no encryption/forms/attachments/JavaScript, 90 borderless links, and full visual review of all 12 pages. This is not a scientific, anonymity, or author-approval pass. |
| ICLR public-format preflight | **PASS, narrow** | On 2026-09-10 the public ICLR 2027 Author Guidelines returned HTTP 200. They require an anonymous paper/supplement and at most 9 main-text pages; the bound manuscript's main text ends on page 8 and uses the official anonymous review style. This does not verify the live submission form or any author-entered field. |
| Required AI-use statement | **OPEN / FAIL** | The live AI Policy for Authors requires disclosure both in the paper and the submission form. No author-confirmed inventory or exact wording exists, and the bound `main.tex` contains no AI-use section. `paper/AI_USE_AUTHOR_DECISION_PACKET.md` is intentionally an unfilled author worksheet, not a disclosure. |
| Independent blind assessment | **WEAK REJECT** | The bound blind review finds the benchmark/diagnostic work promising but the central ML value proposition unsupported at ICLR strength. Its score is evidence, not an official prediction. |
| Same implemented observation-and-mask decision witness | **OPEN / FAIL** | The side-six witness is equal only under a deliberately mask-free projection. Its legal masks differ, so it does not establish a decision-relevant alias under the actual learning interface. |
| Controlled representation/history ablation | **OPEN / FAIL** | The reported CNN, Grid-GNN, and Topology-GNN differ in more than the logical-edge/history input. No fixed-backbone, fixed-capacity logical-edge-by-history ablation supports a causal feature claim. |
| Evaluation estimand and external validity | **OPEN / FAIL** | The admitted D14--D16 evidence is five-seed descriptive evidence on jointly trained sizes. Its 200-game tasks repeat two deterministic color-conditioned trajectories; it does not establish comparative efficacy, uncertainty, strong-opponent robustness, or unseen-size generalization. |
| D17/D18-v1 and D19 admission | **FAIL_CLOSED** | D18-v1 misses 22 of 45 trajectory-diversity criteria and remains `formal_ready=false`; D19 is not admitted. No later smoke, checkpoint, preflight, or planned run is a paper result. |
| Clean-install reproduction | **OPEN** | A retained-environment PDF rebuild is not a clean committed checkout, fresh environment/install, scoped test run, or independently checked reproduction receipt. |
| Anonymous final supplement | **OPEN** | No clean subject, author-approved private identity list, per-file decision sheet, production candidate/archive, or independent verify-extract receipt exists. Supplement tooling remains `candidate_only_not_approved`. |
| Supplement-tool safety self-tests | **PASS / correctly fail-closed** | On 2026-09-10 the base builder self-test passed 12/12 with one Windows symlink-permission skip; subject-binding self-test passed 8/8. Claim-complete and archive self-tests stopped at the expected frozen-input hash mismatch for `web/web前端/GameEngine.js`. That refusal proves no production candidate and must not be bypassed by rewriting the old anchor. |
| Author, COI, anonymity, and live OpenReview fields | **OPEN / NOT VERIFIED** | These facts cannot be inferred from repository files or an anonymous PDF. No upload, form completion, or submission has occurred. |

## Why this remains a fail gate

The paper is now technically well formed and unusually explicit about its
limitations.  That transparency is valuable, but it cannot substitute for the
missing construct-validity witness, controlled ablation, redesigned evaluation,
and accessible anonymous reproduction artifact.  The independent reviewer
reached the same conclusion from the PDF alone.  Consequently, do not upload,
submit, or describe this candidate as ICLR-ready.

## Required closure order

1. Close the scientific gates with prospectively frozen, independently
   verifiable evidence; do not alter prior evidence or promote smoke/pilot
   output as a result.
2. Freeze a clean source subject, then run a fresh-install reproduction and
   build the one exact, private-identity-scanned supplement candidate/archive.
3. Authors complete the private AI-use, anonymity, COI, authorship, licensing,
   and live-form fact package; approve the exact paper and archive bytes.
4. Incorporate only author-approved disclosure/release changes, then rerun the
   full hash-bound chain (build, QA, blind review, and this gate).
5. Only after every scientific, reproducibility, author, and live-form gate
   passes may the authorized submitter upload or submit.

## Non-actions recorded

This gate did not run a formal game, launch or recover a paid AutoDL job,
create a production supplement/archive, commit or push, access a private
identity list, upload a file, complete an OpenReview form, or submit a paper.
