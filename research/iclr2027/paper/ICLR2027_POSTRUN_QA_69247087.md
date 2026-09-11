# ICLR 2027 post-run PDF QA receipt v4

QA date: 2026-08-31 (Asia/Shanghai)  
Disposition: **PDF/technical QA passes for this exact hash; submission gates
remain open**

This receipt applies only to the candidate rebuilt after replacing pooled-game
headline summaries with five-training-seed descriptive summaries. It does not
overwrite the historical A615, B746, or AB99 receipts, reviews, or gates.

## Bound inputs

| Artifact | SHA-256 |
| --- | --- |
| `main.pdf` | `69247087CFE0A4F3DB6FFB95E00A536F544889F8C1030E0AF134A5A39D73B88C` |
| `main.tex` | `3B107FB96825955EBF5B7177D30B471938EE1128A3214FFC1C2CCAC1CE580402` |
| `references.bib` | `2AB031B8523D581DA9B807C128A9197F5BF687F730529A94C39645BAE3284659` |
| seed-pair descriptive audit JSON | `E8DBB1CBAFC15DE0C7B2879CA3697E8F21F3F8C6D84354715B75A5F4D078C7CD` |
| seed-pair descriptive audit Markdown | `73AAB2C79C19402651170939C11819CBAF69A76D59AF0D33AB82C9EC2202188F` |
| `D14_D16_TERMINOLOGY_ERRATUM.md` | `275B303903A89C3C7697BC76A4E7D59E93325B281334CD9F6072DFD14FDDAF3E` |
| D14--D16 receipt ledger | `FF3EF8BFD9B7A443BC42BA16AB9D4DAA9F855A5D0432D58A62322686247B8114` |
| D14--D16 canonical aggregate | `59C264FC65D7B11357B0D718D38371DF1BA44BE4B92E7EF41FF995BF088F501C` |

The seed-pair audit was rerun independently for this receipt. Its self-test
passed, it reconstructed all 330 receipts and 30,600 task-indexed game records,
and its regenerated JSON and Markdown were byte-identical to the bound files.
Its status is `PASS_DESCRIPTIVE_ONLY_NO_INFERENCE`.

## Claim-boundary check

The live PDF now treats the training seed as the primary descriptive unit:

- Table 3 reports median and min--max range across five training-seed scores;
- Table 4 reports the same five-seed summary for representation round robin;
- the abstract, within-size results, limitations, conclusion, Figure 2 caption,
  Figure 3 caption, and Appendix B distinguish primary seed summaries from
  pooled reconciliation views;
- ranges are explicitly not confidence intervals, and the paper claims no
  independent-game, hypothesis-test, multiple-comparison, or global-ranking
  inference;
- each 200-game D16 seed-task is still disclosed as two deterministic
  color-conditioned trajectories repeated 100 times.

The pooled checkpoint curves and heatmap remain visibly labelled as secondary
reconciliation views. No D17--D19 performance result is admitted. These checks
establish wording consistency, not scientific sufficiency or acceptance merit.

## Structural checks

- `pdfinfo`: 11 pages, 612 x 792 pt US Letter, rotation 0, unencrypted, no
  form, and no JavaScript.
- `pdffonts`: every listed font is embedded and subset.
- `pdfdetach`: zero embedded files.
- PDF title, subject, keywords, and author metadata are empty; the visible
  author block is anonymous.
- Extracted-text and source scans found no author name, username, email,
  Windows/POSIX local path, placeholder marker, or literal D17/D18/D19 label.
- The stable LaTeX log has no overfull box, undefined citation/reference,
  rerun request, LaTeX error, or fatal error.

The non-blocking MiKTeX `log4cxx` message about its user log directory occurred
while running Poppler commands. Each command returned success and produced the
expected complete output; it is an environment logging-permission diagnostic,
not a PDF failure.

## Page-by-page visual check

All 11 pages were freshly rendered with Poppler at 150 dpi and inspected.

| Pages | Result |
| --- | --- |
| 1--2 | PASS; title, anonymous author block, seed-level abstract, related work, and Eqs. (1)--(2) are intact |
| 3--5 | PASS; Figure 1, Tables 1--2, definitions, baselines, and Eq. (3) are aligned and legible |
| 6--7 | PASS; Tables 3--4 and Figures 2--3 are readable with complete captions and no clipping |
| 8--10 | PASS; limitations, conclusion, reproducibility statement, and references remain within margins |
| 11 | PASS; Appendix Tables/text are present and the remaining white space is intentional |

No page contains clipped text, overlap, broken tables, black squares,
unreadable glyphs, visible link boxes, or an accidental blank tail page. Main
text and the reproducibility statement finish on page 8; references occupy
pages 8--10 and Appendix A--B occupies page 11.

## Scope and remaining gates

**PDF/technical QA: PASS for
`69247087CFE0A4F3DB6FFB95E00A536F544889F8C1030E0AF134A5A39D73B88C`.**

This receipt does not close:

- the absent author-confirmed AI-use statement and separate live-form answer;
- author approval of the exact anonymous supplement allowlist and identity
  profile;
- fresh clean-install reproduction from the exact candidate bytes;
- the scientific limitation that the admitted neural evaluation is
  descriptive and trajectory-poor;
- live OpenReview metadata or submission-form verification.

Any byte change to `main.tex` or `main.pdf` invalidates this receipt and
requires a new hash-bound QA, independent review, and submission gate. No
training, paid AutoDL action, OpenReview action, push, or publication was
performed by this QA.
