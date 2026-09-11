# S6 pre-D20 textual-consistency audit

**Status:** PASS for the exact pre-D20 working-tree candidate's claim-boundary
text only. This is not a final S6 gate, an experiment result, author approval,
or submission authorization.

**Audit date:** 2026-09-10 (Asia/Shanghai)

## Exact target

| Artifact | Binding |
| --- | --- |
| main.pdf | SHA-256 848C60359A0DCD829E33E8E0388F5FA0AA136A2E045215E0B8D63A8ABFFA99F6; 449,839 bytes; 11 US-Letter pages |
| main.tex | SHA-256 FE16B0BCDE8A478319A33E4201E55D2279DAE93B90F1DBFF49E6A6033A4F3E21; 33,017 bytes |
| references.bib | SHA-256 2AB031B8523D581DA9B807C128A9197F5BF687F730529A94C39645BAE3284659 |
| Claim routing | CLAIM_EVIDENCE_LIMITATION_V6.md |
| Final-source checklist | POST_D20_FINALIZATION_CHECKLIST_AND_LEDGER_PATCH_20260910.md, Section 5 |

The current PDF/source pair is a dirty working-tree subject, not a clean
commit. Any source, bibliography, figure, style, AI-use, or evidence change
requires a new source/PDF binding and a new final S6 audit.

## Audit method

The audit checked the abstract, introduction, state-aliasing discussion,
experiments, tables/figures and captions, limitations, conclusion, appendix,
and reproducibility statement against C1--C10 in the V6 ledger. It also
searched source and extracted PDF text for D20 text, author/path identifiers,
and unfinished markers. All 11 PDF pages were rendered and visually reviewed
at 144 dpi; the existing hash-bound technical QA receipt remains
ICLR2027_POSTRUN_QA_848C6035.md.

## Claim inventory and result

| Source region | Ledger claims | S6 result | Mandatory boundary retained |
| --- | --- | --- | --- |
| Title, abstract, and introduction | C1--C7 | PASS | Frames the work as a benchmark; the side-six witness is mask-free and the representation comparison has no global ranking. |
| State-aliasing diagnostics | C2--C3 | PASS | Calls the side-six result a mask-free Topology history-legality witness; it explicitly says legal masks differ and does not equate the implemented observations. |
| Protocol and model sections | C4, C9 | PASS | Counts and parameter closeness retain the architecture and compute confounds. |
| Result prose, Tables 3--4, Figures 2--3 | C5--C8 | PASS | Uses five training seeds, descriptive medians/ranges, and repeated color-conditioned trajectories; no independent-game inference, confidence interval, or ranking claim. |
| Ablations and limitations | C3, C9--C10 | PASS | Describes negative/inconclusive evidence as bounded and keeps learned-benefit, optimal-action, same-backbone, external-validity, and compute claims open. |
| Conclusion and reproducibility statement | C1--C10 | PASS | Restates the mask boundary and limits released artifacts to compact evidence/verifier materials. |

## Literal consistency checks

| Check | Result |
| --- | --- |
| D20 numerical text or D20 result claim in main.tex/extracted PDF | PASS: no occurrence found |
| D17/D18 positive-result claim in main.tex/extracted PDF | PASS: no occurrence found |
| TODO, TBD, FIXME, or PLACEHOLDER in extracted PDF text | PASS: no occurrence found |
| Chengzong, standalone zcz, Windows drive path, /Users/, or /home/ in extracted PDF text | PASS for this bounded pattern scan |
| non-Markov, unseen-size, confidence-interval, hypothesis-test, and global-ranking language | PASS: each occurrence is a negation or limitation, not a positive result |
| Side-six phrasing | PASS: every inspected substantive occurrence retains the mask-free qualifier or the legal-mask limitation |
| Current author-confirmed AI-use statement | OPEN: no statement is present; factual wording requires authors |

## Visual revalidation

The rendered pages have readable title/anonymous block, equations, tables,
figures, captions, references, appendix, and page numbering. No overlap,
clipping, blank tail page, broken figure, or visible link border was observed.
Figure 2/Table 4 captions on page 7 retain mildly loose justified spacing
around monospaced artifact names; this is non-blocking presentation debt, not
a technical failure.

## What this audit does not close

- No D20 result is admitted, and the final C11/C12 slots remain absent.
- The current scientific blockers (same implemented-observation-and-mask
  consequence and same-backbone edge-by-history ablation) remain open.
- Current-checkout C3 replay is fail-closed: the bound Web GameEngine hash is
  48317759E700DF1FCEFF97651BC1BA10EF07FA43EEDDF081473B0C02AA03B173,
  while the uncommitted Web source is 8DB6B7A516DFB63EFE4CA3ABE7ADAF35D563B48CFBC49130E71F03BCF0591B12.
  The targeted test module therefore has 9 passing tests and 10 source-binding
  errors; the historically bound C3 receipt is not a live replay pass for this
  dirty checkout.
- Fresh-install reproduction, the anonymous subject-bound archive, author
  identity review, author-approved AI-use wording, and live OpenReview facts
  remain open.
- A final S6 must be repeated after final source/evidence freeze and before
  final PDF QA, blind review, and submission gate.

**Pre-D20 S6 disposition:** TEXTUAL_BOUNDARY_PASS /
FINAL_SUBMISSION_READY=NO.
