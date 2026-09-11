# LIFELINE-RL post-D20 finalization checklist and claim-ledger patch plan

**Status:** static-consistency and finalization-preparation only, prepared on
2026-09-10 (Asia/Shanghai). This is neither a D20 result, an author decision,
a final paper, a submission gate, nor authorization to upload or submit.

**Scope boundary.** This plan does not modify `main.tex`, alter frozen
protocols/receipts/reviews, invent AI-use, author, COI, or live OpenReview
facts, or authorize a commit, push, upload, or submission. D20 quantities are
intentionally represented by placeholders until the whole formal acceptance
barrier below passes.

## 1. Audited starting point and static findings

| Item | Observed static state | Finalization implication |
| --- | --- | --- |
| Candidate PDF | `main.pdf` is `848C60359A0DCD829E33E8E0388F5FA0AA136A2E045215E0B8D63A8ABFFA99F6`, 11 US-Letter pages | This is an **old byte-bound candidate**, not the future final PDF. |
| Current source binding | `main.tex` is `FE16B0BCDE8A478319A33E4201E55D2279DAE93B90F1DBFF49E6A6033A4F3E21`; `references.bib` is `2AB031B8523D581DA9B807C128A9197F5BF687F730529A94C39645BAE3284659` | Any source, bibliography, figure, style, ledger, or evidence change requires new final-PDF bindings. |
| Current QA/review/gate | QA is PASS only for the old PDF; blind-first review is `4/10 Weak Reject`; v7 gate is `FAIL / Needs revision` | Neither the old QA pass nor the old score transfers to changed bytes. |
| D20 hygiene | `main.tex` contains no D20 result section or D20 numeric claim | Keep this invariant until the formal acceptance barrier passes. |
| AI-use section | No `\subsection*{AI use statement}` exists in the current source/PDF | A factual author-approved statement is required before the future PDF can be final. |
| Internal references | Static source scan finds 30 cited keys with 30 BibTeX entries, and no unresolved `\ref` labels | Re-run this check after every final-source change. |
| Existing claims | C1--C10 are bounded to the V6 ledger; the source explicitly limits non-Markov, ranking, sample-efficiency, and generalization claims | Preserve every applicable limitation when adding D20. |

### Time-consistency repair required

`PAPER_HANDOFF.md` and `CLAIM_EVIDENCE_LIMITATION_V6.md` were written before
the v7 QA/review/gate for `848C...FFA99F6`; their language that this candidate's
review routing was still pending is historically correct at their cutoff. Do
**not** overwrite those historical records. Instead create the new append-only
handoff and ledger named in Section 3 after final bytes exist.

The current v7 gate/review remain useful diagnostics, not acceptance evidence
for the next PDF. The central same-implemented-observation-and-mask
future-decision blocker is independent of D20 and remains open unless a
separate verified witness closes it.

## 2. Non-negotiable D20 admission barrier

No D20 number, arm ranking, effect, interval, table cell, figure, or conclusion
may enter `main.tex`, the abstract, the conclusion, or a new claim ledger until
**all** items below are true for the same D20-v2 run root and manifest:

1. The run metadata has the exact experiment ID, canonical manifest hash, and
   complete source-closure hashes required by
   `configs/d20_matched_ablation_manifest_v2.json`.
2. The independent strong-opponent calibration report is byte-bound, has
   `status=PASS` and `formal_ready=true`, names the registered opponent, and
   passes both registered held-out-size requirements.
3. The task plan, training receipts, evaluation receipts, checkpoints, and game
   rows have complete one-to-one coverage of the registered plan. Every
   training/evaluation receipt is complete; no checkpoint, replay, hash,
   non-finite-update, missing-seed, or truncation failure exists.
4. Evaluation replay verifies every registered game; every paired-color pair
   uses the same opening, all opening-diversity requirements pass, and the
   registered factorial cells retain all paired training seeds.
5. The runner canonical aggregate and the separately implemented verifier's
   recomputation agree exactly. The independent verifier must report
   `status=PASS`, `formal_ready=true`, and `independent_of_runner_import=true`.
6. The final report, canonical numeric aggregate, manifest, protocol, source
   closure, and compact receipts each have recorded SHA-256 values. Raw
   trajectories and checkpoints remain local rather than being silently treated
   as paper or supplement payloads.

If any item fails, is missing, is still running, or cannot be independently
verified, record only `D20_STATUS=EXCLUDED_OR_PENDING`; leave every D20 result
placeholder below unresolved and retain `S2/A3=OPEN`.

Passing D20 closes neither the same-observation-and-mask mechanism question nor
the one-game external-validity limitation by itself. It may support a bounded
feature-isolating factorial claim under its frozen protocol; it must not be
described as a universal representation result, proof of non-Markovness, or a
complete submission-readiness repair.

## 3. Append-only artifact set to create after D20 acceptance

Use a date and the first 12 hexadecimal characters of the **new final PDF**
hash in every filename. Create new files; never overwrite V6, v7, or any
frozen receipt.

| Artifact | Required role |
| --- | --- |
| `paper/CLAIM_EVIDENCE_LIMITATION_V7_POST_D20_<PDF12>.md` | Final claim-to-evidence-to-limitation ledger, bound to final PDF/source/evidence bytes. |
| `paper/PAPER_HANDOFF_POST_D20_<PDF12>.md` | Current operational handoff that explicitly supersedes only routing, not historical records. |
| `paper/ICLR2027_FINAL_QA_<PDF12>.md` | Exact-PDF technical/visual/anonymity QA receipt. |
| `reviews/iclr2027_final_blind_review_<PDF12>.md` | Fresh, blind-first, PDF-only review frozen before repository unblinding. |
| `submission_checks/submission_gate_final_<PDF12>.md` | Final gate binding exact PDF, final ledger, reproducibility/supplement state, and author-owned gates. |

Each artifact must list its own byte count and SHA-256, the final PDF SHA-256,
and the relevant source/evidence hashes. A change to any named input invalidates
the corresponding binding and starts the relevant QA/review/gate stage again.

## 4. Exact V7 claim-ledger patch shape

Create a new ledger, rather than editing V6, with the following content and
order. Square brackets are deliberately unresolved placeholders; do not replace
them from console output, a partial run, or memory.

~~~markdown
# Claim - evidence - limitation ledger (V7 post-D20)

Status: finalization candidate only. `submission_ready=false` until final PDF
QA, fresh blind review, submission gate, reproduction/supplement gates, and
author-owned gates all close.

## Bound final subject

| Artifact | Bytes | SHA-256 | Role |
| --- | ---: | --- | --- |
| `main.pdf` | [FINAL_PDF_BYTES] | [FINAL_PDF_SHA256] | Exact final manuscript |
| `main.tex` | [FINAL_TEX_BYTES] | [FINAL_TEX_SHA256] | Source used for that PDF |
| `references.bib` | [BIB_BYTES] | [BIB_SHA256] | Bibliography input |
| Final figure/style inputs | [PER_FILE_BYTES] | [PER_FILE_SHA256] | Build closure |
| D20-v2 manifest | [BYTES] | [MANIFEST_SHA256] | Frozen registered design |
| D20 protocol | [BYTES] | [PROTOCOL_SHA256] | Protocol scope and limits |
| D20 canonical numeric aggregate | [BYTES] | [CANONICAL_NUMERIC_SHA256] | Sole numerical source for paper tables/figures |
| D20 independent verification report | [BYTES] | [INDEPENDENT_REPORT_SHA256] | Must be PASS/formal_ready/independent-of-runner-import |
| D20 compact receipt index | [BYTES] | [RECEIPT_INDEX_SHA256] | Coverage and replay binding |

## Admission invariant

`D20_ADMITTED=true` only if every Section-2 condition is recorded above. If
false, C11 and C12 below are absent from the paper and are marked
`EXCLUDED_OR_PENDING` here.

## Carry-forward claims

C1--C10 retain their V6 wording and mandatory limitations unless a final-source
edit changes a claim. Rebind their authoritative evidence to exact final hashes;
do not silently strengthen, delete, or reinterpret any limitation.

## New D20 claims (include only when D20_ADMITTED=true)

| ID | Claim permitted in the paper | Authoritative evidence | Mandatory limitation |
| --- | --- | --- | --- |
| C11 | Under the registered four-arm, same-backbone factorial, the per-training-seed estimates for logical-edge main effect, compact-history main effect, and their interaction are [COPY EXACT CANONICAL ESTIMATES AND TWO-SIDED t INTERVALS]. | D20 manifest/protocol; canonical numeric aggregate; independent verification report; compact receipt index. | Training seed is the analysis unit. Pooled W/D/L is descriptive only. The finding is bounded to this game, registered training/evaluation protocol, model backbone, seeds, openings, and opponents; it does not establish universal superiority, necessity, sample efficiency, or a same-observation-and-mask witness. |
| C12 | On registered seen and held-out evaluation sizes against registered opponents, the per-seed scores are [COPY EXACT CANONICAL CELL SUMMARIES]. | Same D20 bindings plus registered calibration report. | State whether each size was train-seen or held out. The calibrated search opponent is not compute-matched to the learned policy. Do not pool games as independent trials, infer cross-game transfer, or call an estimate a global ranking. |

## Prohibited D20 short forms

- No D20 conclusion before `D20_ADMITTED=true`.
- No claim that D20 proves history is necessary, Topology is superior, Grid is
  non-Markov, Superko is unnecessary, or the same-observation/mask blocker is
  closed.
- No unqualified `significant`, `robust`, `generalizes`, `state of the art`,
  `sample efficient`, or `causal` wording. Report the registered seed-level
  estimand and interval, then state its bounded interpretation.
- No use of pooled games as independent samples or of a positive/negative
  result to hide a failed, missing, or inconclusive registered cell.
~~~

### Main-source integration map (do not apply before the barrier)

When, and only when, C11/C12 are admitted and the author facts in Section 7 are
complete:

1. Add a new `\subsubsection{Matched logical-edge × compact-history factorial}`
   directly inside existing `\subsection{Ablations}` (currently anchored near
   `main.tex` line 518). Preserve the existing Superko-policy matrix paragraph
   as C10; do not relabel it as D20.
2. Add one seed-level results table whose rows are registered main effects and
   interaction, and whose cells are copied exactly from `canonical_numeric`.
   The caption must say: primary unit = training seed; intervals are registered
   two-sided t intervals; pooled game totals are descriptive only.
3. Add, only if useful for reading, one table for registered seen versus
   held-out evaluation cells. Label held-out sizes explicitly and state the
   calibrated-opponent/compute-matching limitation in the caption or adjoining
   text.
4. Keep D20 out of abstract and contribution list by default. Promote it there
   only after final ledger, final blind review, and author sign-off agree that
   the exact bounded result is a principal contribution.
5. In `Limitations and Broader Impact`, retain a sentence with this minimum
   meaning: the factorial does not supply an equal implemented observation plus
   legal-mask future-decision witness, and it is limited to one game and the
   registered backbone/seed/opening/opponent protocol.
6. Recheck every occurrence in abstract, introduction, state-aliasing,
   experiments, limitations, conclusion, captions, appendix, and
   reproducibility statement for the prohibited forms above.

## 5. S6 textual-consistency checklist for final source

Before building final PDF, make a claim inventory with one row per sentence,
table caption, figure caption, abstract sentence, and conclusion sentence that
contains an empirical or mechanism assertion. Each row must contain:

`source location | claim ID | exact evidence path | evidence SHA-256 | allowed
estimand | required limitation location | reviewer-facing wording`.

The S6 gate passes only if all items below are true:

- C1--C10 preserve V6 evidence boundary; C11/C12 exist only under the D20
  admission invariant.
- The side-six result is always called a **mask-free Topology
  history-legality witness**; no text equates it with the implemented
  mask-bearing Grid/Topology observation.
- D14--D16 and D20 use registered seed-level unit where applicable; repeated
  game records are never called independent trials.
- No text converts an absent/failed/inconclusive result into evidence of
  equivalence, necessity, irrelevance, superiority, or a global ranking.
- Every held-out-size statement names its training boundary and avoids
  cross-game or universal generalization language.
- All result numbers in prose, tables, figures, captions, appendix, and
  supplement agree byte-for-byte with canonical aggregate; no manual
  spreadsheet copy is authoritative.
- All `TODO`, `TBD`, `FIXME`, bracketed placeholders, private filesystem paths,
  author names, unapproved AI wording, and D20 intermediate-result text are
  absent from final source and extracted PDF text.

## 6. A1 exact-final-PDF hash-bound QA

Perform this only after final source, figures, bibliography, approved AI-use
statement, and final ledger are frozen. Record commands, tool versions, exit
status, inputs, outputs, and SHA-256 values in
`ICLR2027_FINAL_QA_<PDF12>.md`.

1. **Build closure.** Record exact `main.tex`, `references.bib`, style/BST,
   figure, and final-ledger hashes. Build with documented deterministic sequence
   `pdflatex -> bibtex -> pdflatex -> pdflatex -> pdflatex`; record actual
   `SOURCE_DATE_EPOCH`, `FORCE_SOURCE_DATE`, `TZ`, TeX, BibTeX, and MiKTeX
   versions. Do not claim deterministic reproduction unless an additional
   same-input pass reproduces final PDF hash exactly.
2. **Logs and cross-references.** Require zero LaTeX errors, emergency stops,
   fatal errors, undefined citations/references, rerun requests, BibTeX
   warnings, and overfull boxes. Inspect each underfull diagnostic in rendered
   pages rather than treating it as automatically harmless.
3. **Exact byte binding.** Record final PDF byte count and SHA-256 alongside
   all final source/evidence hashes. Give every downstream review/gate exact PDF
   rather than a same-name rebuilt copy.
4. **PDF structure.** Verify page count and US-Letter page boxes with
   `pdfinfo`; check every font is embedded/subset/Unicode with `pdffonts`; scan
   for encryption, attachments, forms, widgets, file attachments, JavaScript,
   embedded files, and actions using Poppler plus an all-object PDF scan. A
   benign `GoTo` OpenAction must be reported accurately, not misdescribed as no
   OpenAction.
5. **Anonymity and text.** Extract layout text. Scan it and source against
   author-provided private identity-variant list, email addresses, local paths,
   author/institution tokens, `TODO/TBD/FIXME/PLACEHOLDER`, and unapproved
   AI-use placeholders. Confirm review-mode template behavior. Record actual
   metadata fields; do not claim metadata-free if creator/producer/dates remain.
6. **Links and citations.** Verify hidden link borders, internal destinations,
   external URI actions, bibliography resolution, and static
   citation/BibTeX/label counts. Re-run 30-citation/30-entry and
   label/reference consistency check on final source.
7. **Visual QA.** Render every final page at recorded resolution, inspect every
   page individually plus a contact sheet, and record page-range findings for
   title/author block, equations, tables, figures, captions, references,
   appendix, clipping, overlap, glyphs, link boxes, blank pages, and page-limit
   compliance. Temporary renders are QA diagnostics, not submission payloads.
8. **Verdict.** State only `technical_visual_qa=PASS for [FINAL_PDF_SHA256]`
   if all preceding checks pass. Explicitly keep scientific,
   reproduction, supplement, author, live-form, upload, and submission statuses
   separate.

## 7. A2 fresh blind review and final submission gate

### Fresh blind review

1. Give reviewers only exact anonymized final PDF (and page-marked extracted
   text if workflow requires it), its bytes/hash/page count, and review rubric.
   Do not provide prior reviews, ledgers, gates, repository evidence, author
   identities, or D20 console output.
2. Freeze PDF-only recommendation before repository or artifact unblinding. The
   receipt must record reviewer isolation, prompt/configuration identity, date,
   PDF hash, page coverage, and nonofficial/offline boundary when applicable.
3. After recommendation is frozen, run separate claim-to-evidence audit. It may
   correct unsupported wording but must not rewrite blind score.
4. Never copy old `4/10 Weak Reject`, Day-3 diagnostic, or any older review
   conclusion onto new bytes. A changed PDF has a new review state.

### Final submission gate

The final gate must bind exact final PDF; V7 ledger; D20 admission record (if
used); final QA; fresh review; fresh-install receipt; subject-bound supplement
manifest/archive/verify-extract receipt; and author-owned facts. It must
separately report:

`S1 construct validity | S2 factorial evidence | S5 evaluation scope | S6 text
consistency | A1 PDF QA | A2 blind review | A4 ledger | R1--R4 supplement and
fresh install | G1--G4 author/form/submission gates`.

It may report `submission_ready=true` only if every required scientific,
artifact, author, and external gate is actually closed. D20 completion does not
automatically close S1, S5, R1--R4, or G1--G4.

## 8. Minimal private author fact package (do not infer or publish it)

The following is minimum information authors must supply privately to finalizer.
It is not safe to synthesize from repository history, branch names, agent
labels, or current PDF.

| Packet item | Required factual content | Used by |
| --- | --- | --- |
| A. AI-use inventory | For each author: product/provider/model or `unknown`; every paper-relevant task; retained outputs; required-task classification; human verification; whether unpublished material was transmitted and known controls; additional co-author use | G1 paper statement and G2 live form |
| B. Approved wording | Exact approved paper AI-use statement and exact live-form answers after inspecting real field labels; line-by-line consistency attestation | `main.tex`, G1/G2 |
| C. Anonymous identity scan input | Private author-name variants, initials, aliases, affiliations, institutions, emails, usernames, project/repository aliases, and other strings to scan; explicit per-file supplement decisions | A1 anonymity and R2/R3; never place list in public supplement |
| D. Final paper/supplement approval | All-author approval of exact PDF hash, source/ledger binding, supplement archive hash, and intended public artifacts | final gate |
| E. Live OpenReview facts | Actual title, author roster/order, affiliations/contact fields, areas/keywords, COI answers, required checkboxes, live AI-form field names/answers, and submission target as shown in live form | G3 only; do not infer fields or answers locally |
| F. External action authorization | Separate action-time confirmation naming exact final PDF/archive hashes, destination, and authorized submitter | G4 only |

`unknown` is acceptable where it is true, but it is not equivalent to `not used`
or `no conflict`. Any unresolved required fact keeps corresponding G/R gate
open. The package must remain private; anonymous paper and supplement only
contain approved policy-appropriate public disclosure.

## 9. Required order and stop rules

1. Wait for D20 formal acceptance barrier. If it fails, preserve current D20
   exclusion and use narrowed non-D20 framing.
2. Obtain minimum author fact package; only authors resolve AI-use, identity,
   COI, live-form, and final-approval facts.
3. Create V7 ledger and post-D20 handoff with exact accepted evidence hashes.
4. Make authorized final-source changes, including only author-approved AI-use
   wording and admitted D20 content. Freeze inputs.
5. Build final PDF, perform A1, then run fresh blind review and final submission
   gate. Re-run affected stages after every byte change.
6. Finalize fresh-install and anonymous-supplement evidence in parallel where
   possible, but do not call either final before subject is bound and author
   approved.
7. Do not upload, submit, commit, push, or change readiness to `true` merely
   because this checklist, a local PDF QA, a D20 runner, or a draft disclosure
   exists.

## 10. Current disposition

At this document's creation, correct status remains
`submission_ready=NO / needs revision`. The only completed work here is a
static finalization plan. No D20 result, author fact, main-source change,
commit, push, upload, or submission is represented as completed.
