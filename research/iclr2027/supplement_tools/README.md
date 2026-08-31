# Supplement candidate builder

This directory provides a local, deterministic, fail-closed builder and
verifier for a **candidate only** supplement tree. It does not approve a
release, close the submission gate, create a release decision, run an
experiment, use the network, or overwrite any earlier candidate directory.

The checked-in allowlist is intentionally narrow. It contains only the
dependency-free rules environment, fixed search agents, and targeted
deterministic tests. Formal result trees, paper files, raw trajectories,
checkpoints, logs, caches, databases, archives, credentials, private paths,
and ignored local result trees are outside its source policy.

## Private identity scan input

Before building, create a local JSON file that is not committed. It must be a
non-empty list containing every exact private identity variant that should be
rejected, for example full names, usernames, student identifiers, affiliation
strings, and host labels:

```json
[
  "replace-with-private-name-variant",
  "replace-with-private-user-variant",
  "replace-with-private-id-variant"
]
```

The terms are never copied into the candidate or printed in a failure. The
privacy receipt records only their count and the SHA-256 of the normalized
list, so the same scan profile can be checked again without disclosing it.

## Narrow candidate build and verify

The builder's default allowlist remains `supplement_allowlist.json`, the narrow
dependency-free rules/search candidate. Claim-complete work must select its
separate profile and allowlist explicitly as documented below.

Run from the repository root. The output parent must already exist, and the
output directory itself must not exist:

```powershell
python -B `
  research/iclr2027/supplement_tools/build_supplement_candidate.py build `
  --identity-file <private-identity-terms.json> `
  --output <new-candidate-directory>
```

Recheck the exact tree with the same allowlist and private identity list:

```powershell
python -B `
  research/iclr2027/supplement_tools/build_supplement_candidate.py verify `
  --identity-file <private-identity-terms.json> `
  --candidate <candidate-directory>
```

## Claim-complete C1--C10 candidate

The claim-complete path is a separate deterministic candidate workflow. Run it
from the repository root after activating the exact verified Python
environment. Choose new output names for every run; derive and build refuse to
overwrite an existing directory.

First set local paths. The identity file must remain private and untracked:

```powershell
$ClaimIdentity = "local_artifacts/private_identity_terms.json"
$ClaimStage = "local_artifacts/claim_complete_stage_<new-id>"
$ClaimCandidate = "local_artifacts/claim_complete_candidate_<new-id>"
```

Derive the hash-pinned staging tree from the tracked repository inputs:

```powershell
python -B research/iclr2027/supplement_tools/derive_claim_complete_payload.py `
  --output $ClaimStage
```

Build the candidate with the claim-complete allowlist rather than the builder's
narrow default:

```powershell
python -B `
  research/iclr2027/supplement_tools/build_supplement_candidate.py build `
  --source-root $ClaimStage `
  --allowlist `
  research/iclr2027/supplement_tools/supplement_claim_complete_allowlist.json `
  --identity-file $ClaimIdentity `
  --output $ClaimCandidate
```

Verify the exact candidate against the live tracked inputs. This command
performs two fresh byte-identical derivations in addition to the manifest,
privacy, claim, receipt, exception, and GameEngine checks:

```powershell
python -B research/iclr2027/supplement_tools/verify_claim_complete.py `
  --candidate $ClaimCandidate `
  --identity-file $ClaimIdentity
```

Run the candidate's included Python tests under normal project permissions,
not a restricted sandbox/temp ACL. For the current 120-payload allowlist the
expected completion line is `Ran 176 tests` followed by `OK`:

```powershell
Push-Location "$ClaimCandidate/research/iclr2027"
python -B -m unittest discover -s tests -t . -p "test_*.py"
Pop-Location
```

The two retained-environment pytest modules add 29 cases covering the
fresh-install preflight contract and the path-free environment verifier. They
remain preflight/retained-environment checks, not a fresh installation:

```powershell
Push-Location "$ClaimCandidate/research/iclr2027"
python -B -m pytest -p no:cacheprovider -q `
  tests/test_d14_d16_fresh_install_preflight.py `
  tests/test_verify_d14_d16_environment.py
Pop-Location
```

Build a deterministic candidate-only archive only after the directory verifier
passes. The archive output directory must not exist or overlap the candidate
tree, and its complete ancestor chain must contain no symlink, junction, or
reparse point. The ZIP uses a fixed
`lifeline_rl_claim_complete_candidate/` root, stored members, fixed 1980
timestamps, fixed regular-file modes, and an external canonical receipt:

```powershell
$ClaimArchive = "local_artifacts/claim_complete_archive_<new-id>"
python -B `
  research/iclr2027/supplement_tools/archive_claim_complete_candidate.py build `
  --candidate $ClaimCandidate `
  --identity-file $ClaimIdentity `
  --output $ClaimArchive
```

Verify the receipt, reject non-canonical or unsafe members, extract without
`extractall`, and rerun the complete candidate verifier in a random
owner-marked sibling staging directory. The tool snapshots the identity,
profile, allowlist, and verifier/tool inputs, rejects any byte drift before
publication, compares the receipt as exact canonical bytes, performs a final
tree rescan, and only then atomically publishes without replacing an existing
output directory:

```powershell
$ClaimExtract = "local_artifacts/claim_complete_extract_<new-id>"
python -B `
  research/iclr2027/supplement_tools/archive_claim_complete_candidate.py `
  verify-extract `
  --archive "$ClaimArchive/lifeline_rl_claim_complete_candidate.zip" `
  --receipt "$ClaimArchive/ARCHIVE_RECEIPT.json" `
  --identity-file $ClaimIdentity `
  --output $ClaimExtract
```

The archive verifier rejects duplicate and case-colliding members, NULs,
backslashes, absolute/drive/UNC/traversal paths, extra roots, directory entries,
symlink or special-file modes, encryption, compression or metadata drift,
missing/extra/tampered files, and any byte sequence that is not the canonical
stored ZIP encoding. It writes an external `EXTRACTION_RECEIPT.json`; neither
receipt contains the private identity terms, their count, a deterministic
identity-list fingerprint, or local absolute paths. Scanner version 4 records
only that a private identity input was supplied; verification still requires
that private input and reruns the complete scan.

The standard Windows runtime does not provide handle-relative filesystem
operations or symlink-safe `shutil.rmtree`. On such a runtime, a failed
workflow deliberately retains an owner-marked staging/output directory for
manual review instead of recursively deleting a path that could have been
replaced concurrently. The random name and post-write reparse scans are not a
security boundary against a malicious process running under the same local
account; run publication in a trusted, non-concurrently-written parent.

`local_artifacts/claim_complete_dummy_identity.json`, or any similar dummy
list, is suitable only for testing the scanner mechanism. A dummy-list PASS
does not show that real author names, usernames, identifiers, affiliations, or
host labels were covered. The production candidate requires an author-reviewed
private identity list and a fresh build and verification with that same list.

None of the commands above performs or proves a fresh clean install, clean-room
reproduction, real-identity coverage, author approval, release approval, or
submission readiness. The archive workflow produces and hashes only a
`candidate_only_not_approved` archive. Its receipts set `final_archive=false`
and cannot be promoted without author-approved identity coverage and a fresh
independent gate.

The candidate contains:

- exactly the explicitly allowlisted payload files;
- `README.md`, a deterministic candidate-only handoff template;
- `CANDIDATE_TREE.txt`, the exact expected member tree;
- `SHA256_MANIFEST.json`, hashes and sizes for the payload, README, and tree;
- `PRIVACY_SCAN.json`, the fresh path, identity, credential, and host scan.

The manifest deliberately excludes itself and the scan receipt to avoid
self-reference. Verification reconstructs both files and rejects missing,
extra, changed, non-UTF-8, symlink, junction, reparse-point, or special-file
members.

JSON and JSON Lines inputs use strict parsing: duplicate object keys,
non-standard or non-finite numbers, malformed records, and ambiguous hash-path
bindings are rejected. The privacy scanner checks both raw text and decoded
JSON strings. Sensitive credential field names are forbidden even when their
values appear empty, null, or redacted. Candidate manifest and privacy receipts
must match their canonical UTF-8/LF bytes, not merely parse to equivalent
objects.

The source scan never imports or executes candidate code. Python files must use
UTF-8 or UTF-8-SIG under Python's PEP 263 encoding rules. Their scan uses the
AST to inspect static string and byte constants, constant joins, dictionary and
subscript keys, attributes, names, parameters, aliases, exception bindings,
pattern bindings, and supported type-parameter bindings. A non-UTF-8 encoding
cookie, invalid syntax, a non-UTF-8 static byte key, or an unsupported static
expression is rejected rather than interpreted under a different runtime
encoding.

JavaScript and MJS files receive cooked string/template escape views, static
literal-chain and computed-key views, normalized code-only identifier checks,
and recursive checks of executable template interpolations. Regex-versus-
division states and legacy HTML-comment syntax that the lightweight lexer
cannot prove under one unambiguous Script/Module goal are fail-closed. Invalid
or uncertain JavaScript is not accepted as evidence of an anonymous source
tree.

Markdown is checked through raw, entity-decoded, punctuation-unescaped,
link-label, HTML-visible, whitespace-folded, and markup-stripped views. Config
and delimited text receive conservative key/header and whitespace-folded
checks. YAML/TOML string continuations and escapes, TOML multiline strings,
YAML doubled quotes, tags, anchors and aliases, INI/CFG interpolation, and Excel
CSV `sep=` directives are outside the dependency-free semantic proof and are
therefore rejected.

These fail-closed rules deliberately have P2 false positives. Examples include
escaped interpolation markers or markers in comments, backslashes in YAML/TOML
comments or literals, all TOML triple-quoted strings, YAML custom tags,
anchors/aliases, ambiguous JavaScript slash or HTML-comment contexts, and some
Markdown, array/argument, or static computed-property strings that merely
mention a sensitive field name. Arbitrarily runtime-computed identity or
property values are not proved absent. Source inclusion, the complete private
identity list, and any
exception to these conservative rules still require author review.

## Self-test

The isolated self-test creates only temporary fixtures and candidate trees. It
also builds the checked-in project allowlist, verifies it, and runs the tests
inside that temporary clean candidate:

```powershell
python -B research/iclr2027/supplement_tools/selftest.py
```

Coverage includes valid build/verify, hash drift, output overwrite refusal,
unlisted-file exclusion, extra candidate files, absolute paths, credential
shapes, private identity terms, forbidden artifact trees, and symlink/reparse
rejection where the host permits symlink creation.

The independent claim-complete self-test exercises dual derivation, full
verification, exact formal/checkpoint exceptions, Unicode-to-ASCII GameEngine
mapping, typed hash-path provenance, strict JSON/JSONL and source-escape privacy
boundaries, Python encoding and AST bindings, JavaScript lexical/template/key
contexts, Markdown rendered-text views, structured-text fail-closed rules,
canonical metadata, and fail-closed profile/hash/overwrite/tamper/extra-file/
identity cases:

```powershell
python -B research/iclr2027/supplement_tools/claim_complete_selftest.py
```

The archive self-test additionally covers byte-identical A/B archives and
receipts, safe verified extraction, overwrite canaries, duplicate members,
unsafe paths, symlink modes, missing/extra/tampered members, metadata drift,
non-canonical trailing bytes, EOCD/ZIP64 rejection, exact receipt-byte type
checking, workflow-input drift, identity-fingerprint exclusion, nested-output
refusal, atomic no-overwrite publication, and fail-retain cleanup behavior:

```powershell
python -B research/iclr2027/supplement_tools/archive_claim_complete_selftest.py
```

## Scope boundary

A `PASS` means only that this exact candidate matches this exact allowlist and
scan profile. It does not make the candidate an anonymous final supplement,
does not validate scientific claims, and does not establish a complete
D14--D19 reproduction contract. Any expansion requires explicit per-file
review, new source hashes, a fresh private identity scan, clean-copy execution,
and an independent submission gate.
