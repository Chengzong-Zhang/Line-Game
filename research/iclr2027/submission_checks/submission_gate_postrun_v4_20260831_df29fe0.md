# LIFELINE-RL post-run submission gate v4

Gate date: 2026-08-31 (Asia/Shanghai)  
Role: independent evidence and submission gate  
Supplement commit:
`df29fe04631552ebd01146db46c09a494a246321`

## Gate decision

Decision: **FAIL / Needs revision**

PDF and technical QA: **PASS for the bound PDF only**.  
D14--D16 bounded formal evidence: **ADMITTED, descriptive only**.  
Claim-complete supplement tooling: **TECHNICAL PASS, candidate only**.  
Scientific acceptance threshold: **FAIL; frozen recommendation Reject**.  
Final anonymous supplement: **OPEN**.  
AI-use paper statement and live-form answer: **OPEN**.  
Live submission form: **NOT VERIFIED**.

The new supplement tooling closes a substantial packaging and verification
gap. It does not establish the central scientific effect, author approval,
complete anonymity, clean-install reproduction, or submission readiness.

## Bound manuscript and review evidence

- `paper/main.pdf`:
  `69247087CFE0A4F3DB6FFB95E00A536F544889F8C1030E0AF134A5A39D73B88C`
- `paper/main.tex`:
  `3B107FB96825955EBF5B7177D30B471938EE1128A3214FFC1C2CCAC1CE580402`
- `paper/references.bib`:
  `2AB031B8523D581DA9B807C128A9197F5BF687F730529A94C39645BAE3284659`
- PDF QA receipt v4:
  `ED15A39F05F8DD71A101E0AA1EC8C7B1F464601B1D18E5B0C9B7A2BF6E93A7E3`
- Independent review v4:
  `0EF010F867EA7337753A6FF334A6C6975C374F45671F41A3E0664E997EAF4289`
- Claim/evidence/limitation ledger v4:
  `5BE319CE1424ADA24A701418923965DAB47864F2F59CAB4F7ADB1D43C1D6422C`
- D14--D16 receipt ledger:
  `FF3EF8BFD9B7A443BC42BA16AB9D4DAA9F855A5D0432D58A62322686247B8114`
- D14--D16 canonical aggregate:
  `59C264FC65D7B11357B0D718D38371DF1BA44BE4B92E7EF41FF995BF088F501C`
- Exact dependency lock:
  `CE828028578A87CAA31E7B3B69C0191458546533E21C0E1DE6180ACCDFBB879F`

The QA receipt reports 11/11 rendered pages passing, embedded and subset
fonts, anonymous visible and metadata author fields, no forms, no JavaScript,
and no embedded files. Any PDF or TeX byte change invalidates that receipt.

The blind-first review is frozen at **Reject, 4/10, confidence 4/5**. Its
scientific decision predates the artifact audit and is not changed by stronger
supplement bookkeeping.

## Bound claim-complete tooling

The parent-to-commit diff for
`df29fe04631552ebd01146db46c09a494a246321` changes exactly these seven
supplement-tool files:

- `README.md`:
  `107828E2826E9C0FACEE6EA3C37BF689CE6FFD1E487D83F75451C42A49ABE9A4`
- builder and scanner v3:
  `FA50993238E0DBC236E2A2E0BD1B90CE241B95612A38E42B2AE28E43C78DECFD`
- claim-complete profile:
  `C13845C630637B9B171C22242C138A89D6CAF680450D04FD3308E638DD9520FE`
- claim-complete self-test:
  `2A5E09C318C3B4E15D5B4D5CBA142C125B9D32FA59C6ED441930CE5B133F7086`
- derivation tool:
  `9AC36D7C82559FAAF2DE267912E3D4C34F5CA059238A108DEF59209C72FE0F91`
- claim-complete allowlist:
  `B88136606F49B21C2090E8F7F013CCDACD16AEF8DF2C58B196FE5EB76C3E8308`
- claim-complete verifier:
  `E1C3523F126C3CE933B2479210FCA6DE57E3BFF1A768CB31774B104F8C7514A9`

The commit was reviewed with an explicit seven-file staged allowlist.
`git diff --cached --check` passed, the largest file was 92,032 bytes, and
targeted private-key, token, author-identity, email, and host-path scans found
no hit. It was not pushed.

## Fresh A/B candidate evidence

Fresh outputs were created under new names; no prior strict-v3 tree was reused:

- `local_artifacts/claim_complete_candidate_submissionv4_20260831_a`
- `local_artifacts/claim_complete_candidate_submissionv4_20260831_b`

Both derivations report:

- 115 payload files and 3,186,772 staged payload bytes;
- profile hash `C13845C6...DD9520FE`;
- allowlist hash `B8813660...6C3E8308`;
- admitted claims C1 through C10;
- status `candidate_only_not_approved`.

Both candidates report:

- 119 total files and 3,223,405 total bytes;
- 117 manifest-bound files and 3,195,062 manifest bytes;
- scanner version 3;
- 118 scanned files and 3,223,084 scanned bytes;
- zero privacy, identity, credential, or host-path findings;
- 330 compact receipts and 4,695 typed hash bindings;
- eight exact formal-source exceptions;
- GameEngine byte identity preserved;
- later-extension labels absent;
- descriptive-only status retained.

Canonical tree digest construction used ordinally sorted POSIX relative paths,
decimal byte lengths, and lowercase per-file SHA-256 values as tab-separated,
LF-terminated rows. Both trees produced:

`6AE7E43CE0F0A79F67857EFE32EDB267ED00B5B866CD642BA784AD324D8E144B`

Additional identical bindings are:

- `SHA256_MANIFEST.json`:
  `522B644F09F984D0B53E92806E40EC23410D5FBD65765EA1406234CC18AF1A9F`
- `PRIVACY_SCAN.json`:
  `F1FF7EC113D46B096BF034C1063ADB0ACFC5CBE58146247BE1294415D7232176`
- A/B per-path hash-and-size mismatches: **0**.

The privacy receipt records one dummy identity term with normalized-list hash:

`B583DF555A45403BDEFC3D23BDD49CE7BCE08342C8078F440971D606C0FBAD28`

This proves only that the scanner mechanism ran. It does not prove that all
real author names, usernames, student identifiers, affiliations, hosts, or
variants were supplied.

## Verification receipt

| Check | Result |
| --- | --- |
| Markdown lint | PASS; 0 issues |
| Ruff | PASS |
| scanner implementation audit | P0=0, P1=0 |
| scanner differential matrix | 50/50 PASS |
| claim-complete self-test | 28/28 PASS; 108.165 s |
| narrow builder self-test | 11 PASS + 1 capability skip |
| reparse-flag rejection | PASS |
| candidate A tests | 176/176 PASS; 21.158 s |
| candidate B tests | 176/176 PASS; 21.334 s |
| candidate A verifier before/after tests | PASS / PASS |
| candidate B verifier before/after tests | PASS / PASS |
| source regeneration per verifier | two byte-identical derivations |
| post-test A/B comparison | 119 files; 0 mismatches |

The authoritative candidate test runs used normal project permissions. A
restricted-ACL diagnostic produced a false early error; the exact first case
passed in 0.032 seconds under normal permissions, after which both complete
176-test suites passed. The narrow self-test skip is Windows `WinError 1314`
for unavailable symbolic-link privilege; the separate simulated reparse-point
rejection test passed.

The code-audit, differential, self-test, and candidate-test totals above are
session-observed terminal results. They were not separately persisted as
machine-readable, hash-bound test receipts. The candidate files, manifests,
privacy reports, and A/B tree digests are byte-bound; the reported timings and
terminal totals should not be treated as an independent durable receipt.

Scanner code-audit `P0=0 / P1=0` is not the same as closing the paper's
scientific or submission-level P0 blockers.

## Scanner proof boundary and remaining P2 behavior

The static scanner is intentionally fail-closed. The following limitations
remain and must stay disclosed:

- privacy-sensitive strings or property values computed arbitrarily at runtime
  are outside the static proof, including values assembled from runtime-derived
  fragments or calls such as `String.fromCharCode`;
- an unquoted JavaScript `-->` is rejected conservatively, so a valid
  expression such as `x-->y` can be a false positive;
- array, argument, and conservative computed-key contexts can reject benign
  strings such as `["api_key"]` or `f("api_key", 1)`;
- NFKC-normalized fullwidth JavaScript identifiers are rejected even where
  runtime identifier semantics differ from the ASCII spelling;
- YAML/TOML continuations, backslashes, tags, aliases, anchors, and triple
  strings can be rejected conservatively;
- INI interpolation and escaped comment markers can produce false positives;
- Markdown multi-view scanning can over-approximate rendered adjacency;
- source inclusion and the complete private identity list cannot be proved by
  the scanner and require author review.

These are known conservative limitations, not evidence that the candidate is
anonymous or final.

## Scientific and artifact decision matrix

| Domain | Status | Boundary |
| --- | --- | --- |
| PDF/render/technical QA | PASS | exact bound PDF only |
| D14--D16 accounting | PASS, bounded | descriptive evidence only |
| D17/D18-v1 P0 execution | complete | 85 tasks and 8,320 games |
| D17--D19 scientific gate | FAIL_CLOSED | 22/45 D18 gates failed |
| D17--D19 paper admission | PASS | no performance claim admitted |
| supplement derivation | PASS | exact profile and allowlist |
| supplement integrity | PASS | fresh A/B mismatch count 0 |
| supplement privacy mechanism | PASS | dummy one-term scan only |
| real anonymity coverage | FAIL / OPEN | author list not supplied |
| final archive | FAIL / OPEN | candidate directories only |
| fresh clean install | NOT VERIFIED | retained environment only |
| scientific sufficiency | FAIL | frozen Reject, 4/10 |
| AI-use paper section | FAIL / OPEN | author facts unresolved |
| live-form AI answer | FAIL / OPEN | separate author action |
| live submission form | NOT VERIFIED | actual system not inspected |

D17/D18-v1 P0 execution completeness does not override the frozen scientific
gate. The bundle remains `formal_ready=false`; D19 remains closed and no
failed-bundle performance claim is admitted.

## Minimum closure conditions

### Scientific work that could change the recommendation

1. Produce a replay-verifiable naturally reachable decision-relevance witness,
   or a rigorous larger-board result, showing that topology or history changes
   a legal shared action, transition, value, or optimal action.
2. Prospectively freeze a controlled causal ablation using one architecture
   with logical-edge and history inputs toggled independently while matching
   compute closely enough to isolate those inputs.
3. Replace repeated deterministic evaluation with frozen diverse openings or
   another valid independent unit, report uncertainty at that unit, and test
   stronger calibrated opponents or a search-budget sweep.
4. Provide a complete rule specification and independently runnable benchmark
   contract, not only compact accounting artifacts.

Additional paid execution is not authorized by this gate. A replacement
experiment requires a new protocol, experiment ID, manifest, run root, and
action-time approval. Existing D17/D18 v1 evidence must remain append-only.

### Author and release work required before submission

1. All authors complete and approve the factual AI-use inventory, add the
   required paper statement, rebuild the PDF, and obtain new QA and review.
2. An author supplies and reviews the complete private identity-term list and
   approves every included source and allowlist entry.
3. Rebuild with that real identity list, verify the exact bytes, create the
   final archive, hash it, and obtain an independent clean-copy gate.
4. Install from the exact lock in a fresh environment and record a hash-bound
   candidate test and reproduction receipt.
5. An author inspects and completes the actual live submission form, including
   the separate AI-use answer, then verifies consistency with the paper.

## Final decision

Current gate: **FAIL / Needs revision**.  
Entry to further paid extension work: **NO without new authorization**.  
PDF technical quality: **PASS for `69247087...D73B88C`**.  
Supplement technical candidate: **PASS for the exact A/B tree digest**.  
Scientific recommendation: **Reject, unchanged**.  
Submission readiness: **NO**.

This gate supersedes earlier supplement-candidate technical snapshots only.
It does not overwrite the frozen blind-first review, prior PDF gates, protocol
evidence, or author decisions. The earlier review's rootcheck candidate hashes
remain historical and are not presented as hashes of the fresh A/B trees.
