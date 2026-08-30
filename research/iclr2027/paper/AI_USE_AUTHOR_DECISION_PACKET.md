# ICLR 2027 AI-use author decision packet

> **status: `author_confirmation_required`**
>
> **submission gate: P0-A OPEN**
>
> Internal one-page decision aid only. This file is neither the paper's required
> AI-use statement nor the OpenReview form disclosure. It does not establish any
> fact about AI use and must not be treated as author approval.

Source worksheet: `AI_USE_DISCLOSURE_DRAFT.md`. Each author must answer from
personal knowledge. Use `unknown` instead of guessing; missing records do not
mean `not used`. Do not insert either wording skeleton below into `main.tex` or
a submission form until all six rows are completed and all authors approve the
exact final text.

## Author decision matrix

| # | Confirmation category | Required author input — leave every placeholder unresolved until confirmed | Completion |
| --- | --- | --- | --- |
| 1 | **Tools and tasks** | `[PRODUCT / PROVIDER / MODEL-VERSION OR UNKNOWN]`; `[PAPER-RELEVANT TASKS AND RETAINED OUTPUTS]`; for every ICLR required task, record `[AI USED / AI NOT USED / NOT APPLICABLE]`. Required-task inventory: synthetic data; theory/conceptual frameworks; mathematical claims/proofs; hypotheses; methodology or experiment design; method implementation; translation; dataset cleaning/reformatting; qualitative/thematic analysis; result interpretation. | [ ] All authors confirmed |
| 2 | **Research methods or result interpretation** | `[DID AI AFFECT METHODS, EXPERIMENT DESIGN, PARAMETERS, CLAIMS, HYPOTHESES, PROOFS, OR RESULT INTERPRETATION? YES / NO / UNKNOWN]`; if yes, `[EXACT TASKS, OUTPUTS, AND RETAINED INFLUENCE]`; distinguish method implementation from general code editing and substantive claim work from wording-only edits. | [ ] All authors confirmed |
| 3 | **Unpublished-material transmission** | For each external service: `[WAS NON-PUBLIC MANUSCRIPT, CODE, DATA, RESULTS, FIGURES, LOGS, PROMPTS, OR SUPPLEMENT SENT? YES / NO / UNKNOWN]`; if yes, `[WHAT / SERVICE / PURPOSE / KNOWN ACCESS-RETENTION-TRAINING CONTROLS]`. Do not include account identifiers, secrets, or private prompts in the disclosure. | [ ] All authors confirmed |
| 4 | **Human verification** | `[AUTHOR-VERIFIED RETAINED OUTPUTS]`; `[CHECKS PERSONALLY COMPLETED: CODE OR RULE TESTS / ARTIFACT RECOMPUTATION / SOURCE-CITATION CHECKS / FIGURE-TABLE CHECKS / CLAIM-LEDGER REVIEW / LATEX-PDF QA / OTHER]`; do not rely only on an AI-generated test or review report. | [ ] All authors confirmed |
| 5 | **Additional co-author use** | Each co-author records `[ADDITIONAL PRODUCT / MODEL OR UNKNOWN]`, `[TASKS AND RETAINED OUTPUTS]`, or explicitly `[NO ADDITIONAL USE]`. Repository silence is not evidence of no additional use. | [ ] Every co-author responded |
| 6 | **Final paper/form wording consistency** | `[APPROVED PAPER STATEMENT]`; `[APPROVED LIVE-FORM ANSWERS AFTER INSPECTING ACTUAL FIELDS]`; `[LINE-BY-LINE CONSISTENCY CHECK]`; `[ALL-AUTHOR RESPONSIBILITY APPROVAL]`. The paper section and form disclosure are separate requirements. | [ ] Exact final wording approved |

## Wording skeletons — placeholders are intentionally unresolved

**Paper section (`\subsection*{AI use statement}`):**

> Generative AI tools `[CONFIRMED TOOLS OR UNKNOWN VERSION]` were used for
> `[CONFIRMED REQUIRED-DISCLOSURE TASKS]` and `[CONFIRMED RECOMMENDED-DISCLOSURE
> TASKS]`. For the remaining required tasks, `[CONFIRMED NOT-USED / NOT-
> APPLICABLE ACCOUNT]`. Retained AI-assisted outputs were `[CONFIRMED OUTPUTS]`
> and were checked by the authors using `[CONFIRMED HUMAN VERIFICATION]`. The
> authors take responsibility for the final text, claims, code, figures,
> references, and other submission artifacts.

**Submission form:**

> `[ADAPT THE APPROVED PAPER FACTS TO THE ACTUAL LIVE FORM FIELDS; DO NOT INVENT
> FIELD NAMES OR ANSWERS]`. Record `[CONFIRMED UNPUBLISHED-MATERIAL HANDLING IF
> REQUESTED OR PERMITTED]` and verify consistency with the paper statement.

## Closure rule

P0-A remains **OPEN** until all six rows are completed by the authors, the exact
paper and form wording is approved, the paper statement is added and rebuilt,
the live form is completed by an author, and the new candidate passes a fresh
hash-bound submission gate.
