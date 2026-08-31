# ICLR 2027 current-PDF QA receipt

QA date: 2026-08-31 (Asia/Shanghai)

Disposition: **PDF and current-environment reproducibility QA pass for the
exact bound bytes; submission readiness remains false**

This receipt supersedes the technical binding of the earlier
`69247087...D73B88C` QA. It does not overwrite that historical receipt, and it
does not convert scientific, author, supplement, clean-install, or live-form
gates into passes.

## Bound subject and inputs

| Artifact | Binding |
| --- | --- |
| Subject commit | `2f4872c05f4d0e264d511255ee5fa4678310d024` |
| Subject tree | `aca5c8e71dbcc16a767ed206b77d595d5c329ab6` |
| `main.pdf` | SHA-256 `2392F034DA6D5C435C7CB9AFCCF6BF615F7EF6F2A87B455D32138B608A453822`; 448,039 bytes |
| `main.tex` | SHA-256 `3B107FB96825955EBF5B7177D30B471938EE1128A3214FFC1C2CCAC1CE580402` |
| `references.bib` | SHA-256 `2AB031B8523D581DA9B807C128A9197F5BF687F730529A94C39645BAE3284659` |
| Build tool | SHA-256 `211E2E27C89357511D3319D918D648A59063D9A739CFDA1ECDC77F1D0F009074` |
| Fixed nine-input tree | SHA-256 `E53963DFC1996676C369B93E032922E57CC4FEDC72500A90EB27192EE5E194A4` |

The detached worktree was clean before and after both builds. The builder
verified that HEAD, the Git tree, index bytes, worktree bytes, all nine fixed
input blobs, and the tracked builder source matched the explicit subject.

## Clean A/B build receipt

Two new output directories were built independently under the detached
worktree. Neither directory existed before its run. Both invocations exited
zero and emitted byte-identical `main.pdf` and `build_receipt.json` files.

| Check | A | B |
| --- | --- | --- |
| PDF SHA-256 | `2392F034...A453822` | `2392F034...A453822` |
| PDF bytes | 448,039 | 448,039 |
| Receipt SHA-256 | `9EDA9A4148C16562C6421F58D7CD0F872F3FADA1362FDEBA8056ABF764E8C6A5` | same |
| Stable output tree | `78B3EEACD155D642A886EE3D269D1FE483334DCF3DFB461E66E480EB663240A2` | same |
| Canonical LaTeX runtime tree | `8164BC39AD3A0925620DB4CC7302B479EE17EC3A1DD985BABD698F070CD7EE22` | same |

The schema-v3 receipt binds 129 canonical runtime files totaling 15,819,929
bytes. It records four parsed `pdflatex` passes, 280 final-pass input events,
two source/tool/Git/runtime rechecks, and one MiKTeX-root recheck. The final
stable build required three post-BibTeX LaTeX passes.

The following trust-anchor values were resampled immediately before the runs.
They are session-observed preflight evidence. The Git executable is also bound
inside the receipt; the Python executable hash is not a schema-v3 receipt
field.

- Python 3.10.20 executable SHA-256:
  `AB4EEA482338433355B60533C0F4AF111A0CA21B392B4C4A4DB35077DE21EDA6`;
- Git 2.51.0 executable SHA-256:
  `34A408843194BE320D8A87A3C12CD5C7D2E08D03B24567A41DB32E21D12569D2`;
- MiKTeX 25.4 `pdflatex`, BibTeX, and `initexmf` executable hashes match the
  hashes recorded in the byte-identical receipts.

Receipt claim boundaries are intentionally asymmetric:

- exact PDF reproduction: **true**;
- subject checkout and fixed paper inputs: **true**;
- all-LaTeX-pass `main.fls` input closure: **true**;
- BibTeX runtime input closure: **false**;
- complete TeX-plus-BibTeX runtime input closure: **false**;
- scientific claims, author approval, and submission readiness: **false**.

Raw `.fls` and LaTeX log files are local diagnostics and are marked ineligible
for an archive because they may contain host paths. The A/B `.fls` bytes differ
where the two absolute output directories differ. An independent 27-file
comparison found only five differing `.fls` files; each had exactly one
differing `PWD` row, zero differing `INPUT`/`OUTPUT` rows, and zero difference
after normalizing the A/B directory name. The other 22 files, including logs
and combined command output, were byte-identical. Raw contents and hashes are
excluded from the canonical runtime tree and public-safe receipt; only stable
relative diagnostic paths and the privacy/exclusion policy are recorded.

The independent check also recomputed the stable output digest from the actual
`aux`/`bbl`/`out`/PDF bytes and the canonical runtime digest from all 129 typed
rows. Both recomputations matched the receipt exactly.

## PDF structural and privacy checks

- `pdfinfo`: exit zero; 11 pages; 612 x 792 pt US Letter; rotation zero;
  unencrypted; no form; no JavaScript; 448,039 bytes.
- PDF title, subject, keywords, and author metadata are empty. The visible
  author block is `Anonymous authors`.
- `pdffonts`: exit zero; all 24 entries are embedded and subset.
- `pdfdetach -list`: exit zero; zero embedded files.
- `pdftotext -layout`: exit zero; the complete 11-page text was extracted.
- The extracted text contains no private local path, account username, author
  identity, email, TODO/TBD/FIXME/placeholder marker, or broken citation token.
  A surname match belongs to a cited paper, not to the submission authors.
- The required author-confirmed AI-use statement is absent.

The final LaTeX log contains no undefined citation/reference, overfull box,
rerun request, LaTeX error, emergency stop, or fatal error. It contains one
benign warning that shell escape is disabled and six underfull box/vbox
diagnostics. All affected pages were inspected; no clipping or unreadable
content resulted.

## Full-page visual check

The exact A-build PDF was freshly rendered with bundled Poppler at 150 dpi.
All 11 PNG pages were opened and inspected individually. Their SHA-256 values
also match the independently rendered current-PDF page set on all 11 pages.

| Pages | Result |
| --- | --- |
| 1-2 | PASS; title, anonymous author block, abstract, related work, and equations are intact |
| 3-5 | PASS; Figure 1, Tables 1-2, definitions, baselines, and model equation are aligned and legible |
| 6-7 | PASS; Tables 3-4 and Figures 2-3 are complete, readable, and unclipped |
| 8-10 | PASS; limitations, conclusion, reproducibility statement, and references remain within margins |
| 11 | PASS; appendix table and text are complete; remaining whitespace is intentional |

No page contains overlap, clipped text, black squares, missing figures,
unreadable glyphs, broken tables, visible link boxes, or an accidental blank
tail page. The justified captions around monospaced artifact names on pages
6-7 have visibly loose spacing, and page 11 has substantial unused space;
these are minor presentation issues, not technical failures.

## Scope and invalidation rule

**Technical QA: PASS only for
`2392F034DA6D5C435C7CB9AFCCF6BF615F7EF6F2A87B455D32138B608A453822`.**

This receipt does not close:

- the scientific Reject-level weaknesses identified by independent review;
- the absent author-confirmed AI-use paper statement and separate form answer;
- a real author identity profile, per-file supplement approval, or final
  archive approval;
- fresh-install reproduction outside the retained Windows/MiKTeX environment;
- complete BibTeX runtime input closure;
- live OpenReview metadata and submission-form verification.

Any byte change to `main.tex`, `references.bib`, any of the fixed figure/style
inputs, or `main.pdf` invalidates this receipt. No network access, upload,
submission, push, training, GPU work, or paid compute was performed by this
QA.
