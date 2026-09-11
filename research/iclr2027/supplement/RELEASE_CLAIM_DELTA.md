# LIFELINE-RL release-claim delta

**Status:** pre-submission release contract only; candidate_only_not_approved.

**Date:** 2026-09-10 (Asia/Shanghai)

This file fills the previously missing supplement/RELEASE_CLAIM_DELTA.md
reference. It does not create an archive, authorize a release, establish
anonymity, or change submission readiness.

## Bound paper and scope

This contract is written for the current working-tree manuscript only.

| Item | Binding |
| --- | --- |
| paper/main.pdf | SHA-256 848C60359A0DCD829E33E8E0388F5FA0AA136A2E045215E0B8D63A8ABFFA99F6; 449,839 bytes |
| paper/main.tex | SHA-256 FE16B0BCDE8A478319A33E4201E55D2279DAE93B90F1DBFF49E6A6033A4F3E21; 33,017 bytes |
| Claim ledger | paper/CLAIM_EVIDENCE_LIMITATION_V6.md |
| V2 payload profile | supplement_tools/claim_complete_profile_v2.json; SHA-256 0078709448adcf458bbe1bffa093f75641406dd9a32cf32e783cf8df1b680751 |
| V2 allowlist | supplement_tools/supplement_claim_complete_allowlist_v2.json; SHA-256 388b82d79ee57d6e6f380ee59d11ea53899f88a9ce9a480f88e25b963eb553d5 |

Any source, paper, evidence, profile, or allowlist change invalidates this
mapping. These working-tree bytes are not a clean Git subject.

## Release wording permitted only after the V2 candidate gate

A future anonymous supplement may state only that it contains the explicitly
allowlisted, subject-bound files needed to inspect the bounded paper claims:

- selected reference implementation, frozen protocols/configuration, compact
  aggregate CSV/JSON, receipt-ledger derivatives, and independent verifier
  sources/outputs;
- the claim ledger and bounded D14--D16 evidence routing;
- the C3 compact targeted-history candidate and verification JSON routing,
  not the narrative addendum itself; and
- a candidate README, exact member tree, SHA-256 manifest, and privacy-scan
  receipt produced by the verified builder.

The final wording must name the actual archive/member-manifest hashes and be
checked against the exact final paper. It must not say that a package exists
before build, privacy scan, author review, and independent verify-extract pass.

## Material intentionally outside the release

The following are not submission artifacts and must not be inferred from a
repository checkout:

- the whole repository, unreviewed branches, web worktrees, caches, logs,
  temporary directories, or local task trees;
- model checkpoints, raw per-game trajectories, ignored formal-output trees,
  local AutoDL state, credentials, host names, and absolute paths;
- D17/D18-v1 performance conclusions (their scientific gate is FAIL_CLOSED),
  D18-v3 capacity artifacts, D19/D20 plans or preflight records, and any
  future experiment result not admitted by a fresh ledger;
- private author identity variants, affiliations, e-mails, COI information,
  AI-use inventories, signatures, or author decisions; and
- the narrative file D6_HISTORY_TWIN_EVIDENCE_ADDENDUM_V2.md. The V2 verifier
  rejects that payload and requires C3 to route through compact JSON evidence.

## Delta from unsafe shorthand

The manuscript's reproducibility statement is deliberately narrower than an
unqualified "code and data are released" assertion. The allowed statement is
that specific compact evidence and verifier artifacts are intended for a future
anonymous candidate. It is not a claim that checkpoints, raw game logs, all
source files, or a final archive are already available.

## Required gates before this becomes a release statement

1. Freeze the reviewed V2 inputs in one clean subject commit/tree.
2. Re-derive and verify the 130-payload candidate against that subject.
3. Use an author-reviewed, untracked private identity list for the privacy
   scan and per-file decisions.
4. Build the deterministic archive and independently verify-extract it.
5. Bind the archive, final source, final PDF, and final claim ledger in a
   fresh submission gate.

Until all five gates pass, the only truthful release status is
candidate_only_not_approved; no archive hash, final member list, upload, or
submission is implied.
