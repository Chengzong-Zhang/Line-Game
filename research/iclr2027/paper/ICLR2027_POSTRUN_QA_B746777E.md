# ICLR 2027 post-run PDF QA receipt v2

QA date: 2026-08-30 (Asia/Shanghai)  
Disposition: **PDF QA passes; pooled-Wilson headline remediated; other gates remain open**

This is a new receipt for the candidate rebuilt after the independent
`A615857B...127B75` review. It preserves that review, gate, and QA receipt as
historical hash-bound snapshots.

## Bound inputs

| Artifact | SHA-256 |
| --- | --- |
| `main.pdf` | `B746777E1D525BC43F1AC823C5F9CFCEF629861273BB47F699740BDEFF543D0E` |
| `main.tex` | `DCC791432DBF6728703AC0F53B502DD219D1F472BAB94F86B238B501D432F3E4` |
| `references.bib` | `2AB031B8523D581DA9B807C128A9197F5BF687F730529A94C39645BAE3284659` |
| D17/D18 receipt ledger | `09AFC03CADFC54CC143D7049DFE78328C1665B3F698274C26A4DBF711C0F080A` |
| local independent verifier report | `2C8C98D9A49593A85E2C39EE2F5F4D250593F53A0F9A18BBE4EB262E58FF985E` |

The official ICLR 2027 style/BST and the three vector figures are unchanged
from `ICLR2027_MIGRATION_QA.md`.

## Claim remediation

The previous review identified the abstract's pooled-game Wilson lower-bound
sentence as a headline uncertainty claim. The abstract now states only that
scores against the fixed UCT-MCTS-16 opponent vary by model and size and are
pooled descriptive evidence. It no longer counts lower bounds above 0.5 or
uses Wilson interval language as a headline.

The detailed result paragraph and table retain the numeric descriptive
intervals with their explicit pooled-game and non-independence limitations.
This edit changes framing only; it does not change any D14--D16 number or admit
any D17--D19 result.

## Scientific boundary

- D17/D18 execution completed 85/85 tasks and 8,320/8,320 games with no
  execution failure, missing task, or truncation.
- D18 failed 22/45 frozen trajectory-diversity gates, so the bundle remains
  `formal_ready=false`; the local independent verifier returned
  `FAIL_CLOSED`.
- D19's conditional gate remained closed and no D19 task ran.
- The PDF contains only the exclusion boundary and no D17--D19 performance,
  generalization, confidence interval, significance, D16-v2, or
  matched-architecture claim.

## Build and structural checks

The verified build used BibTeX plus three post-BibTeX stabilization passes.
All five commands exited 0.

- `pdfinfo`: 11 pages, 612 x 792 pt US Letter, rotation 0, unencrypted, no
  form, and no JavaScript.
- `pdffonts`: every listed font is embedded and subset.
- Stable `main.log`: no overfull box, undefined citation/reference, LaTeX
  error, fatal error, or rerun request. Two non-blocking underfull diagnostics
  remain.
- `main.blg`: zero BibTeX warnings or errors.
- PDF author and title metadata remain empty; the visible author block remains
  anonymous under the official review style.

## Page-by-page visual check

All 11 pages were rendered with Poppler at 144 dpi and inspected.

| Pages | Result |
| --- | --- |
| 1 | PASS; revised abstract is legible and the title/author block is intact |
| 2--6 | PASS; text, equations, tables, and vector figures are aligned |
| 7--8 | PASS; heatmap, round robin, limitations, conclusion, and references are intact |
| 9--10 | PASS; bibliography and appendix transition stay within the text block |
| 11 | PASS; appendix text is present; remaining white space is intentional |

No page contains clipped text, overlap, broken tables, black squares,
unreadable glyphs, visible link boxes, or an accidental blank tail page.

## Remaining submission gates

This receipt closes PDF rendering and records the pooled-Wilson headline edit
for this exact hash. It does not close author-confirmed AI-use disclosure, the
live submission form, an anonymous independently gated supplement, the
self-contained reproduction package, dependency locking, or a fresh
independent submission gate on this rebuilt candidate. No commit, staging,
push, AutoDL action, or formal game was performed by this paper edit.
