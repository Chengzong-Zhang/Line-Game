# ICLR 2027 current-PDF technical and visual QA receipt

QA date: 2026-09-01 (Asia/Shanghai)

Disposition: **technical and visual PDF QA passes for the exact bound bytes;
scientific sufficiency, author approval, and submission readiness remain
false**

This append-only receipt supersedes only the current-PDF binding of the older
`2392F034...A453822` and `69247087...D73B88C` QA receipts. It does not rewrite
those historical receipts, and it does not convert an experiment, supplement,
author, clean-install, or live OpenReview gate into a pass.

## Bound subject and diagnostic bindings

| Artifact | Binding |
| --- | --- |
| `main.pdf` | SHA-256 `848C60359A0DCD829E33E8E0388F5FA0AA136A2E045215E0B8D63A8ABFFA99F6`; 449,839 bytes; 11 pages |
| `main.tex` | SHA-256 `FE16B0BCDE8A478319A33E4201E55D2279DAE93B90F1DBFF49E6A6033A4F3E21`; 33,017 bytes |
| `references.bib` | SHA-256 `2AB031B8523D581DA9B807C128A9197F5BF687F730529A94C39645BAE3284659` |
| retained final `main.log` | SHA-256 `681C5518FD4549253A1AFFA9A5E4905D19DCDD51C669D2B9379D2A1DFF44F529` |
| retained `main.blg` | SHA-256 `281519280288B785096CDAD95F01D8CF64F040D97B9497797ED449B72378C9AD` |
| inspection 11-page PNG set | 11 RGB images, each 1530 x 1980 pixels; canonical manifest SHA-256 `9EB04998DBB1AA7402031167A33EF7F47F12CF2A851C3A7D51160CED3411683C`; removed after QA |
| inspection contact sheet | SHA-256 `AF9B136F83034B8314F5444E0AC795F7078A5CB63DB9EF3CBBD6AECA2F681C35`; 1,209,948 bytes; removed after QA |

The PNG manifest digest is over the page files in lexical order using one row
per file: `filename`, NUL, uppercase file SHA-256, NUL, decimal byte length,
and LF. After all pages had been inspected and this receipt had recorded their
hashes, the exact temporary directory
`tmp/pdfs/iclr_history_twin_v6_qa` was removed. The page images and contact
sheet were local QA diagnostics, not claimed submission artifacts.

The working tree was not clean during this QA. This receipt therefore binds
the exact file bytes above, not a commit, Git tree, clean checkout, or public
archive.

## Fixed-environment build and log check

The recorded fallback build used:

```text
SOURCE_DATE_EPOCH=1788115675
FORCE_SOURCE_DATE=1
TZ=UTC
pdflatex -> bibtex -> pdflatex -> pdflatex -> pdflatex
```

All five recorded commands exited zero. The retained final log reports
`Output written on main.pdf (11 pages, 449839 bytes)` and 95 named
destinations. An additional pass under the same fixed environment reproduced
the PDF bytes exactly. This is a same-environment repeat, not a clean-install
or independent-runtime reproduction receipt.

The retained `main.log` and `main.blg` have:

- zero undefined citations or references;
- zero rerun requests;
- zero overfull boxes;
- zero LaTeX errors, emergency stops, or fatal errors;
- zero BibTeX warnings;
- four underfull hbox and three underfull vbox diagnostics.

The underfull diagnostics are presentation-only. Inspection of the affected
title, captions, table, and page transitions found no clipping or unreadable
content.

## PDF structure, actions, and attachments

Poppler `pdfinfo` and a strict `pypdf` 6.10.0 scan of all 457 xref objects
completed without an object-read error. The exact structural findings are:

- PDF 1.5; 11 pages; every effective MediaBox and CropBox is
  `[0, 0, 612, 792]`; rotation is zero; user unit is 1; Poppler reports US
  Letter for every page;
- the file is not encrypted;
- Catalog keys are exactly `/Names`, `/OpenAction`, `/Outlines`, `/PageMode`,
  `/Pages`, and `/Type`;
- the Catalog `/Names` dictionary exists and its concrete key set is exactly
  `/Dests`; the `/Dests` root has `/Kids` and `/Limits`, with 3 root kids,
  16 leaves, and 95 named-destination pairs;
- `/EmbeddedFiles` is absent from `/Names`, and the all-object scan found zero
  `/EmbeddedFiles`, `/EF`, or `/Type /Filespec` occurrences;
- Poppler `pdfdetach -list` independently reports `0 embedded files`;
- `/JavaScript` is absent from `/Names`, and the all-object scan found zero
  `/JavaScript` or `/JS` keys;
- `/OpenAction` is present. Object `101 0 R` resolves to
  `{/S /GoTo, /D [102 0 R /Fit]}`; object `102 0 R` is page 1. This is a
  benign page-one fit destination, not JavaScript;
- the all-object scan found no `/AA`, `/AcroForm`, or `/Metadata`; form-field
  enumeration returned none;
- all 76 page annotations are `/Link`; there are no `/Widget` or
  `/FileAttachment` annotations and no page or annotation additional actions;
- link destinations comprise 65 `/GoTo` actions and 11 `/URI` actions, with
  no other link action type; every link has `/Border [0 0 0]`, no `/BS`, and
  therefore a hidden border;
- `pdffonts` lists 24 font-resource entries; all 24 are embedded, subset, and
  Unicode-mapped.

These checks support an attachment/script/form/encryption/font/link-border
technical pass. They must not be shortened to either "no OpenAction" or "no
metadata": both statements would be false.

## Metadata and anonymity boundary

The trailer `/Info` dictionary exists. Its identity-bearing standard fields
`/Author`, `/Title`, `/Subject`, and `/Keywords` are empty, and the visible
author block is `Anonymous authors`. However, the PDF is not metadata-free:

- `/Creator` is `LaTeX with hyperref`;
- `/Producer` is `MiKTeX pdfTeX-1.40.27`;
- `/PTEX.Fullbanner` records the MiKTeX/pdfTeX toolchain;
- `/CreationDate` and `/ModDate` are `D:20260830184755Z`;
- `/Trapped` is `/False`.

There is no Catalog `/Metadata` entry and no XMP metadata stream. Poppler
accordingly reports custom metadata present but no metadata stream.

A complete layout-text extraction contains the anonymous author string once
and contains no `Chengzong` token, standalone `zcz` token, email address,
Windows drive path, `/home/` or `/Users/` path, or
`TODO`/`TBD`/`FIXME`/`PLACEHOLDER` marker. This is a bounded pattern scan, not
a universal privacy proof. No author-confirmed AI-use statement was found.

## Full-page visual check

No new PDF or PNG was generated for this receipt. The inspection render set,
created immediately after the bound PDF build, contained all 11 pages at
1530 x 1980 RGB pixels. The contact sheet and every page PNG were opened and
inspected individually before the temporary render directory was removed.

| Pages | Result |
| --- | --- |
| 1-2 | PASS; title, anonymous author block, abstract, contributions, related work, and equations are complete and readable |
| 3-5 | PASS; Figure 1, Tables 1-2, the side-six witness discussion, definitions, protocol text, and model equation are aligned and unclipped |
| 6-7 | PASS; Tables 3-4 and Figures 2-3 are complete, legible, and within the page margins |
| 8-10 | PASS; limitations, conclusion, reproducibility statement, and references are readable and remain within margins |
| 11 | PASS; remaining references, Appendix A-B, Table 5, and final text are complete; lower-page white space is intentional |

No page has overlap, clipped text, black squares, a missing figure, broken
table, unreadable glyph, visible link box, or accidental blank tail page. The
justified Figure 2 and Table 4 captions on page 7 have visibly loose word
spacing around monospaced artifact names, and page 11 retains unused lower
space. These are minor presentation issues, not technical failures.

## Scope and invalidation rule

**Technical and visual PDF QA: PASS only for
`848C60359A0DCD829E33E8E0388F5FA0AA136A2E045215E0B8D63A8ABFFA99F6`.**

This receipt does not establish or approve:

- the central same-observation-and-mask decision witness; the new side-six
  history twin is equal only under a mask-free Topology projection because
  its implemented legal masks differ;
- a learning benefit, optimal-action difference, TopologyHistory benefit, or
  same-backbone logical-edge-by-history ablation result;
- scientific acceptance merit or a change to the independent review score;
- a fresh clean-install reproduction or complete runtime-input closure;
- author approval of the paper, identity profile, supplement contents,
  release allowlist, AI-use disclosure, or final submission bytes;
- live OpenReview metadata, form completion, upload, or submission.

Any byte change to `main.tex`, `references.bib`, a fixed figure/style input, or
`main.pdf` invalidates this receipt. No network access, upload, submission,
push, commit, training, GPU work, or paid compute was performed by this QA.
