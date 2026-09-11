# D14--D16 fresh-install execution plan

## Status and authority boundary

Status: **PLAN ONLY / NOT EXECUTED**.

This document specifies the next reproducibility gate after
`D14_D16_FRESH_INSTALL_PREFLIGHT.md`. It does not authorize downloading a
wheel, accessing an index, creating a virtual environment, installing a
package, running a clean-room test, retraining a model, or changing any formal
artifact. Each execution must use a new output directory and must refuse to
overwrite earlier evidence.

A private subject-bound run of the execution-contract verifier now records
`contract-only PASS`. It closes the pre-execution profile, package-source,
claim/allowlist, fixed-byte, and ten-path Git transport checks only. It did not
access a network, create an environment, build or install a package, run a
test/game, reproduce training, export the clean source tree, or generate any of
the eleven future outputs. Gates A--E below therefore remain unexecuted. The
internal receipt contains real Git object identifiers and is deliberately
outside the anonymous/public supplement topology.

The repeated 2026-09-01 inventory has no `.whl` below the repository's
`research/iclr2027` or ignored `local_artifacts` trees. Therefore no wheelhouse
manifest, wheelhouse-preflight receipt, fresh environment, or fresh-install
execution receipt exists. This inventory is a dated snapshot and must be
repeated at execution time.

The tracked compact independent receipt auditor is implemented and available
as a future Gate E command. The contract-only verifier hash-binds that tool and
its eleven tracked metadata inputs; it does not run the auditor. The auditor,
its future receipt, and the contract receipt are not members of the current
120-payload/124-member supplement topology. Availability is not a compact-audit
result, a supplement output, or a fresh-install `PASS`.

## Fixed starting contract

| Input | Current binding |
| --- | --- |
| Target | CPython 3.10.20, Windows x86-64, `win_amd64` |
| Exact dependency lock | `requirements-d14-d16-win-cu118.lock.txt` |
| Lock SHA-256 | `380cab994906a45f60fba3a4c00f818f3724070666dfeef737f3f5a0e1a5d272` |
| Exact pins | 20 |
| Wheelhouse preflight | `scripts/d14_d16_fresh_install_preflight.py` |
| Preflight implementation SHA-256 | `b6307c20229ecfbe1976ede0775d0c4138676b22f1049ab4ba943125d727888f` |
| Retained-environment verifier | `scripts/verify_d14_d16_environment.py` |
| Environment-verifier SHA-256 | `4600be6f89abd868388c50a248fe4a503f29747078f571979f43329917e96901` |
| Project discovery root | `research/iclr2027`, represented as `where = ["."]` in that project |
| Included packages | exact `lifeline_rl` and `lifeline_rl.*` only |
| Explicitly excluded top-level package | `lifeline_rl_autodl` |
| Frozen-byte transport policy | root `.gitattributes`, SHA-256 `b5580b068874c753566140e0cc563c819b317ddc9e31c01f260697baf5b0a3dc` |
| Verbatim transport exceptions | 10 exact frozen evidence paths, each with `-text` |
| Compact independent auditor | `reviews/compact_independent_receipt_audit.py` |
| Compact-auditor SHA-256 | `44a9e922aebd3ec8d30e40af35dbde459869a774971796251ab5317184583e7c` |
| Future compact verdict/exit/skips | `PASS_TRACKED_METADATA_CONSISTENCY_ONLY` / `0` / `0` |
| Compact tracked-input closure | 11 distinct tracked metadata files; manifest byte pin required |

These hashes describe the inputs observed when this plan was written. A future
run must bind its own exact subject commit and tree, recompute every input hash,
and stop if any expected file is staged, dirty, missing, untracked where a
tracked input is required, or changed during the run. Updating the subject is a
new execution, not a continuation of an older receipt.

## Gate A: authorized wheel acquisition

This is the only networked phase. It is a separate external-action gate and
must not begin without action-time authorization for the exact target, index
hosts, output directory, and command. Authorization for Gate A does not
authorize Gate B or any experiment.

1. Start from an empty, newly created wheelhouse directory outside the clean
   source and receipt directories.
2. Record the absolute executable and SHA-256 of the approved CPython 3.10.20
   interpreter and Git executable. Record the pip version used for acquisition.
3. Download binary wheels for the 20 exact pins only. Resolution must target
   CPython 3.10 / Windows x86-64; source distributions and unpinned additions
   are forbidden. The lock's PyTorch index directive may be used only as part
   of this authorized acquisition.
4. Produce a version-1 wheelhouse manifest with exactly one wheel per pin and
   each wheel's basename, decimal byte length, and lowercase SHA-256. Record the
   exact lock hash and target tuple. No credential, URL token, cache path, or
   private absolute path may enter the manifest.
5. End network access. The acquired wheelhouse and manifest become immutable
   inputs to Gate B. Any later download or replacement requires a new
   directory, manifest, and preflight.

The intended acquisition semantics are equivalent to `pip download --no-deps`
against the exact lock on the approved target. The eventual receipt must record
the real argv and exit code; this sentence is not an executable command or an
authorization.

## Gate B: offline wheelhouse preflight

Gate B begins only in a network-disabled clean environment. In addition to the
external isolation, set pip to offline mode and suppress user configuration and
cache use. Offline flags reduce accidental access but do not by themselves
prove that the host had no network path.

Run the checked-in preflight against the immutable lock, manifest, and
wheelhouse, writing to a new receipt path outside every input. Exit code `0`
and receipt status `PASS` are required. The receipt must prove all of the
following:

- exactly 20 declared and discovered wheels;
- one compatible wheel for every exact pin and no undeclared wheel;
- exact filename, size, and SHA-256 equality;
- exact lock hash and target equality;
- no symlinked wheel and no schema drift;
- a hash of the preflight implementation and the manifest itself.

A preflight `PASS` closes only wheel inventory. It is not installation or test
evidence.

## Gate C: clean source and project wheel

1. Record a full Git subject commit and its exact tree object. Require `HEAD`
   and the commit tree to remain unchanged before and after every publication
   step.
2. Export a new clean copy with `git archive` from that exact commit, including
   the tracked `research/iclr2027` tree and any tracked independent reference
   file required by the selected tests. The archive's Git blob bytes are the
   transport authority. Do not copy from the live worktree and do not treat an
   ordinary checkout as equivalent evidence for this gate.
3. Persist a sorted member list with decimal sizes and lowercase SHA-256 values,
   plus the exported archive SHA-256. Reject missing, extra, symlink, junction,
   reparse-point, or special-file members.
4. In the offline build environment, build the `lifeline-rl` project wheel with
   build isolation disabled, using only the already verified setuptools and
   wheel pins. Hash the project wheel and record its filename and size. Do not
   publish it and do not add it to Git.

Package discovery must begin at the exported `research/iclr2027` project root
and apply the exact include list `lifeline_rl`, `lifeline_rl.*`. The sibling
top-level package `lifeline_rl_autodl` is outside this wheel contract. The
subject-bound verifier must enumerate the package tree twice under this rule,
obtain the same 25 Python source paths both times, and preserve all three Git
subject snapshot checks around those enumerations.

Before export, the verifier must also bind the exact root `.gitattributes`
bytes and its ten-path `-text` closure. Those ten accepted evidence files use
CRLF bytes whose existing SHA-256 values are authoritative; Git must store and
archive those bytes verbatim rather than normalize them. Every fixed input
must have identical accepted/worktree and subject-blob bytes before Gate C can
pass. Any additional path mismatch, transport rule, or text conversion blocks
the run.

The claim profile and resolved allowlist currently contain 120 rows in 28
categories. Their complete two-way `(category, destination, source)` identity
set has canonical SHA-256
`95933b2b39d57495c9e945b95c6dd2f024270f1784d6221163540ec552a707f8`.
Before a future execution, bind all 109 copy sources to their actual subject
bytes and all ten one-input derivative rows to their input bytes. The eleven
derived sources, including the unique null-hash/zero-input derivation receipt,
are future build contracts and are not generated or output-byte-verified by
the current profile check.

The source export, dependency wheelhouse, and project wheel must occupy
disjoint directories. Any input mutation blocks the run and leaves no `PASS`
receipt.

## Gate D: new offline environment and installation

Gate D requires a second action-time confirmation because it creates and
modifies a new local environment. It must not reuse `rl310`, another retained
environment, a pip cache, user site packages, or an earlier failed directory.

1. Create a new CPython 3.10.20 virtual environment in a new ignored local
   directory. Record the base interpreter path, version, implementation, and
   SHA-256 before creation.
2. Record the new environment's Python and pip facts before installation.
3. Install the exact dependency lock with `--no-index`, an explicit
   `--find-links` pointing only to the verified wheelhouse, and cache disabled.
   The wheelhouse preflight is the file-integrity authority; pip must not select
   any artifact outside it.
4. Install only the hash-bound project wheel with `--no-index`, `--no-deps`,
   and build isolation inapplicable. Editable installation is not accepted for
   this gate.
5. Capture every semantic argv, start/end ordering, exit code, and stdout/stderr
   hash in the private execution tree. Public receipts must redact absolute
   paths and must not embed environment variables or credentials.

Any resolver access, source build of a dependency, unexpected installed
distribution, nonzero exit code, or input drift makes the gate `BLOCKED`.

## Gate E: installed-environment and scoped test verification

Run from a directory that cannot import `lifeline_rl` from the exported source
tree. First prove that the imported package resolves inside the new environment
and not to the repository or source export.

The run must then:

1. execute `scripts/verify_d14_d16_environment.py` against the exact lock and
   portable formal metadata, persisting a new canonical receipt;
2. expand and persist the exact targeted-test set bound by the current
   claim-complete profile/allowlist rather than relying on ambient test
   discovery;
3. run the dependency-free core/search/serialization tests, the PyTorch network
   and trainer tests, the D14--D16 protocol/receipt tests, and the two retained
   environment/preflight pytest modules as separate recorded commands;
4. run the compact independent auditor against the eleven tracked D14--D16
   metadata inputs present in the clean copy. Require exit code `0`, zero
   skips, `manifest_byte_pin_enforced=true`, 11 distinct files, and public
   verdict `PASS_TRACKED_METADATA_CONSISTENCY_ONLY`;
5. record every selected test file hash, collected/passed/failed/skipped/error
   count, exit code, and output hash.

Skips are not silently accepted. Each skip must be listed and classified as
expected or blocking before the final status is computed. Missing ignored raw
tasks or checkpoints must not be fabricated or replaced with smoke fixtures.
The compact verdict establishes tracked-metadata accounting consistency only:
it verifies zero external artifact bytes and does not verify raw games,
checkpoints, logs, trajectory replay, or retraining. The retained prior full
audit is contrast-only and is not the current accounting or artifact-byte
authority.

## Required execution receipt

The final receipt must be deterministic UTF-8/LF JSON, timestamp-free in its
scientific content, written once to a new path, and independently hashable. It
must include at least:

- schema name/version and `PASS` or `BLOCKED` status;
- subject commit/tree and clean-source archive/member-manifest hashes;
- Python, pip, and Git executable identities and versions;
- dependency lock, wheelhouse manifest, preflight implementation, preflight
  receipt, wheel-tree, and project-wheel bindings;
- new-environment package inventory and environment-verifier receipt binding;
- exact semantic commands, exit codes, test selections/counts, and output
  hashes;
- before/after input-tree fingerprints and an explicit no-overwrite result;
- the compact-auditor path/hash, 11 input bindings, expected narrow verdict,
  zero-skips result, and its explicit limitations;
- scope flags stating that no training, evaluation games, new scientific
  result, supplement approval, upload, or submission occurred.

The status is `PASS` only when every gate above passes and an independent
read-only check reproduces the receipt's hashes and decisions. Otherwise the
status remains `BLOCKED`, with every blocker listed.

The current contract verifier publishes its own optional receipt create-only.
It first writes and fsyncs a complete deliberately invalid payload beginning
with `!`; one unbuffered `os.write(fd, b"{")` returning one byte is the sole
commit point. Pre-commit failure cannot leave parseable `PASS` JSON even if
cleanup fails. Post-commit fsync and close are best-effort and do not downgrade
the already committed report. This does not claim crash durability or
resistance to same-user concurrent mutation, Git ABA, or output-path ABA.

## Meaning of a future PASS

A future `PASS` would establish only that the exact checked-in D14--D16 code and
selected evidence checks install and run in one new, offline, hash-bound
Windows CPython 3.10.20 environment. It would not reproduce training, establish
hardware equivalence, approve the anonymous supplement, validate D17--D19, fix
the current scientific weaknesses, close the paper's TeX/BibTeX runtime gate,
or make the submission ready.
