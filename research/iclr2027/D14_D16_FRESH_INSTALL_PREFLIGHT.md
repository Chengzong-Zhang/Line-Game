# D14--D16 fresh-install preflight

## Status and boundary

`scripts/d14_d16_fresh_install_preflight.py` is an offline, fail-closed
inventory check for a candidate CPython 3.10.20 / Windows x86-64 dependency
wheelhouse. It does not create a virtual environment, install or import any
package, access the network, run tests or games, or reproduce training.

A `PASS` receipt means only that every exact pin in
`requirements-d14-d16-win-cu118.lock.txt` has exactly one declared wheel, the
manifest binds the exact lock, each declared filename/size/SHA-256 matches the
wheelhouse, there are no undeclared wheels, and the parsed wheel tags are
compatible with the retained target. It is not a clean-install execution
receipt, a D14--D16 retraining result, submission readiness, or evidence that
any later extension is formal-ready.

## Required manifest

The manifest is supplied explicitly and is itself SHA-256-bound in the output
receipt. Its version-1 shape is:

```json
{
  "schema_name": "lifeline-d14-d16-wheelhouse-manifest",
  "schema_version": 1,
  "lock_sha256": "<lowercase SHA-256 of the exact lock>",
  "target": {
    "python_version": "3.10.20",
    "implementation": "CPython",
    "platform_tag": "win_amd64"
  },
  "artifacts": [
    {
      "package": "colorama",
      "version": "0.4.6",
      "filename": "colorama-0.4.6-py2.py3-none-any.whl",
      "size_bytes": 0,
      "sha256": "<lowercase SHA-256 of the wheel>"
    }
  ]
}
```

The example is structural only: its placeholder hash and size deliberately
cannot pass. Filenames must be basenames. Wheels are treated as immutable
regular files; symlinked wheels, missing metadata, duplicate/missing pins,
hash or size mismatches, incompatible tags, and undeclared wheels all produce
`BLOCKED`. Unknown manifest or artifact keys also block, so schema drift cannot
silently change the preflight meaning.

## Read-only invocation

From `research/iclr2027`, inspect a prepared local wheelhouse without writing:

```powershell
python -B scripts\d14_d16_fresh_install_preflight.py `
  --wheelhouse ..\offline-wheelhouse `
  --manifest ..\wheelhouse-manifest.json
```

Add an output path outside all inputs only when a durable receipt is wanted:

```powershell
python -B scripts\d14_d16_fresh_install_preflight.py `
  --wheelhouse ..\offline-wheelhouse `
  --manifest ..\wheelhouse-manifest.json `
  --output results\validation\d14_d16_fresh_install_preflight.json
```

Exit code `0` means `PASS`; exit code `2` means `BLOCKED`. JSON is sorted,
timestamp-free, LF-terminated, and reports repository inputs relatively while
redacting external directory locations. The output path may not overwrite the
lock or manifest, reside inside the wheelhouse, or replace an existing receipt.

## What remains after `PASS`

A separate, explicitly authorized clean-room run must still build/install the
project from a source-hash-bound clean copy using offline-only installer flags,
record commands and exit codes, verify installed versions and Torch/CUDA facts,
run the scoped core/network/receipt tests, and bind those results to a new
execution receipt. Retraining and all later extensions remain separate
scientific gates.
