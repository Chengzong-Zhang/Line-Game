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

## Build and verify

Run from the repository root. The output parent must already exist, and the
output directory itself must not exist:

```powershell
python -B research/iclr2027/supplement_tools/build_supplement_candidate.py build `
  --identity-file <private-identity-terms.json> `
  --output <new-candidate-directory>
```

Recheck the exact tree with the same allowlist and private identity list:

```powershell
python -B research/iclr2027/supplement_tools/build_supplement_candidate.py verify `
  --identity-file <private-identity-terms.json> `
  --candidate <candidate-directory>
```

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

## Scope boundary

A `PASS` means only that this exact candidate matches this exact allowlist and
scan profile. It does not make the candidate an anonymous final supplement,
does not validate scientific claims, and does not establish a complete
D14--D19 reproduction contract. Any expansion requires explicit per-file
review, new source hashes, a fresh private identity scan, clean-copy execution,
and an independent submission gate.
