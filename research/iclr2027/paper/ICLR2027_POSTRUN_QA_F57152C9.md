# ICLR 2027 current-PDF technical and visual QA receipt

QA date: 2026-09-10 (Asia/Shanghai)

Disposition: **technical and visual PDF QA passes for the exact bound bytes;
scientific sufficiency, author approval, and submission readiness remain
false.**

This append-only receipt supersedes only current-PDF QA binding for prior
hashes. It does not rewrite earlier receipts or convert an experiment,
supplement, author, clean-install, or OpenReview gate into a pass.

## Bound subject

| Artifact | Binding |
| --- | --- |
| `main.pdf` | SHA-256 `F57152C90C81C9A94D4CAEF5F4C64399B4802559DC91EF9EEF516ABC95CECC6D`; 455,696 bytes; 12 pages |
| `main.tex` | SHA-256 `E0A676689323BEC8AB0A7C045B893E1FD62DC504F9530354CEE1B3CEFA88CADE`; 33,400 bytes |
| `references.bib` | SHA-256 `3BEEACFBDCF4CFF4D793B2982E61BCAB5DA0FAC0C9609EF26E995A631F6078A2` |
| isolated final `main.log` | SHA-256 `B6F842456B36BA9D945722C859715B08CC1BF0305AFC68F9B1260187B9AA67D1` |
| isolated final `main.blg` | SHA-256 `819BE6CC7455BD446F77726F74428426D383796E43B36FA709157C46B1E6A553` |
| inspection PNG set | 12 RGB pages at 1445 x 1870 pixels; canonical page-manifest SHA-256 `277FA58C8732E371C86060C7EFEA32FF8387042CA2531748D73F41EF0AA478BF` |

The render manifest covers PNG files in lexical order. Each row is
`filename`, NUL, uppercase SHA-256, NUL, decimal byte length, and LF. The
working tree was not clean, so this receipt binds exact file bytes rather
than a commit, Git tree, clean checkout, or public archive.

## Fixed-environment build and log check

The isolated fallback build used:

```text
SOURCE_DATE_EPOCH=1788115675
FORCE_SOURCE_DATE=1
TZ=UTC
pdflatex -> bibtex -> pdflatex -> pdflatex -> pdflatex
```

All five commands exited zero. A sixth `pdflatex` pass under the same fixed
environment reproduced the exact PDF bytes. This is a same-environment
repeat, not a clean-install or independent-runtime reproduction receipt.

The recorded build transcripts contain no undefined citation/reference,
cross-reference rerun request, overfull box, LaTeX error, or BibTeX warning.
The completed text extraction confirms all four added citations, including
`Wu et al., 2006`, and contains no malformed `che Wu et al.` citation.

## PDF structure, attachments, and metadata

Poppler and a bundled `pypdf` scan completed without an object-read error:

- PDF 1.5; 12 pages; US Letter (612 x 792 pt); not encrypted.
- Empty standard `/Title` and `/Author`; visible author block is `Anonymous authors`.
- Catalog keys are `/Names`, `/OpenAction`, `/Outlines`, `/PageMode`, `/Pages`, and `/Type`; `/Names` contains only `/Dests`.
- No `/EmbeddedFiles`, `/EF`, `/Filespec`, `/JavaScript`, `/JS`, `/AA`, `/AcroForm`, or `/Metadata` key was found; `pdfdetach -list` independently reports `0 embedded files`.
- `/OpenAction` is the benign page-one `{/S /GoTo, /D [102 0 R /Fit]}` destination, not script execution.
- All 90 page annotations are borderless `/Link` annotations: 73 `/GoTo` and 17 `/URI`; there are no Widget or FileAttachment annotations.
- `pdffonts` lists 24 resources, all embedded, subset, and Unicode-mapped.

The PDF is not metadata-free: its creator is `LaTeX with hyperref`, its
producer is `MiKTeX pdfTeX-1.40.27`, and fixed creation/modification dates
are present. A bounded layout-text scan found no `Chengzong`, `Nanjing
University`, or `zcz` token. This is not a universal anonymity proof and
does not replace author-provided identity-variant review.

## Full-page visual check

All 12 rendered pages were individually inspected at 170 dpi:

| Pages | Result |
| --- | --- |
| 1-2 | PASS; anonymous author block, abstract, related work, equations, and the new citations are readable and within margins |
| 3-6 | PASS; Figure 1, Tables 1-3, definitions, protocol, and model equation are aligned and unclipped |
| 7-8 | PASS; Figures 2-3 and Table 4 are complete; the long Figure 2 and Table 4 captions are now left-aligned without loose justification spacing |
| 9-10 | PASS; references are readable, with the new Campbell, Ben-Assayag, and Koyamada entries correctly rendered |
| 11-12 | PASS; remaining references, Appendices A-B, Table 5, and final text are complete; page 12 contains the Appendix B conclusion, not an accidental blank tail |

No page has overlap, clipped text, black squares, missing figure, broken
table, unreadable glyph, visible link box, or blank tail page.

## Scope and invalidation rule

**Technical and visual PDF QA: PASS only for
`F57152C90C81C9A94D4CAEF5F4C64399B4802559DC91EF9EEF516ABC95CECC6D`.**

This receipt does not establish or approve:

- the same-implemented-observation-and-mask future-decision witness;
- a learning benefit, optimal-action difference, TopologyHistory benefit, or same-backbone logical-edge-by-history ablation;
- scientific acceptance merit or a changed independent-review score;
- fresh clean-install reproduction;
- author approval, the AI-use inventory, identity profile, COI, or final supplement;
- OpenReview form completion, upload, or submission.

Any byte change to `main.tex`, `references.bib`, a fixed figure/style input,
or `main.pdf` invalidates this receipt.
