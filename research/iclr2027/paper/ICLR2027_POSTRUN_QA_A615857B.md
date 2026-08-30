# ICLR 2027 post-run PDF QA receipt

QA date: 2026-08-30 (Asia/Shanghai)  
Disposition: **PDF QA passes; submission gates remain open**

This is a new receipt for the post-D17/D18 paper candidate. It does not
rewrite the earlier template-migration QA or any historical review snapshot.

## Bound inputs

| Artifact | SHA-256 |
| --- | --- |
| `main.pdf` | `A615857BF315FFE85B371F220580160C7C3D0D5209BF14C5C0DE247063127B75` |
| `main.tex` | `7C95EA32B8140A95075D80040EAEFD6E0BF67789D3D909840511C26DA63A791A` |
| `references.bib` | `2AB031B8523D581DA9B807C128A9197F5BF687F730529A94C39645BAE3284659` |
| D17/D18 receipt ledger | `09AFC03CADFC54CC143D7049DFE78328C1665B3F698274C26A4DBF711C0F080A` |
| local independent verifier report | `2C8C98D9A49593A85E2C39EE2F5F4D250593F53A0F9A18BBE4EB262E58FF985E` |

The official ICLR 2027 style and bibliography-style hashes remain
`797DEEF4...98EA6` and `2D67552D...44C5`. The three vector figure hashes are
unchanged from `ICLR2027_MIGRATION_QA.md`.

## Scientific boundary

- D17/D18 execution completed 85/85 tasks and 8,320/8,320 games with no
  execution failure, missing task, or truncation.
- D17 passed 40/40 task diversity gates. D18 passed 23/45 and failed 22/45
  frozen trajectory-diversity gates, so the bundle remains
  `formal_ready=false`.
- The independent verifier replayed 8,320/8,320 games and returned
  `FAIL_CLOSED`. Canonical numeric equality was not supplied by the completed
  job.
- D19's conditional gate remained closed and no D19 task ran.
- `main.tex` includes only the exclusion boundary. It contains no D17--D19
  performance number, generalization result, confidence interval,
  significance claim, D16-v2 conclusion, or matched-architecture conclusion.

## Structural and build checks

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

All 11 pages were rendered with Poppler and inspected at full page resolution.

| Pages | Result |
| --- | --- |
| 1--6 | PASS; title, methods, tables, and vector figures are legible and aligned |
| 7 | PASS; heatmap, round-robin table, and ablation text are not clipped |
| 8 | PASS; limitations, conclusion, and reference transition are clean |
| 9 | PASS; bibliography entries and URLs stay within the text block |
| 10 | PASS; bibliography-to-appendix transition and Table 5 are intact |
| 11 | PASS; appendix text is present; remaining white space is intentional |

No page contains clipped text, overlap, broken tables, black squares,
unreadable glyphs, visible link boxes, or an accidental blank tail page.

## Remaining submission gates

This QA receipt closes only PDF rendering and current-candidate hash binding.
It does not close the independent post-run review, author-confirmed AI-use
disclosure, anonymous supplement, dependency-locking, or final submission
gate. No commit, staging, push, AutoDL action, or formal game was performed by
this QA step.
