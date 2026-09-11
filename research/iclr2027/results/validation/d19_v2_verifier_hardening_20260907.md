# D19-v2 verifier hardening — 2026-09-07

## Scope and boundary

- Repository: `C:\coding\py\line game`
- Branch: `codex/territory-v2-page-correctness`
- HEAD at validation: `db469b380812e5b254c61b55682679700f5fc65d`
- The worktree was already dirty. Existing user changes were preserved; the
  pre-existing `d19_v2_formal_runner.py` was inspected but not edited.
- The manifest remains `preflight_only_not_authorized`; its training,
  evaluation, GPU, and formal-result authorization flags remain false.
- No formal D19-v2 training, self-play, evaluation, checkpoint production,
  network request, GPU operation, or AutoDL operation was run.

## Hardening applied

Before this change, `verify_d19_v2_evidence.py` only checked that a referenced
checkpoint was non-empty and matched its declared SHA-256. It did not load the
model state-dict.

The verifier now independently and fail-closed:

1. Loads the local checkpoint with `map_location="cpu"` and
   `weights_only=True`; loader errors are rejected without an unrestricted
   pickle fallback.
2. Requires a mapping-valued `model_state_dict` with the exact 35 D19-v2
   entries and exact fixed shapes.
3. Requires every entry to be a CPU tensor, checks each tensor's shape and
   `numel()`, and requires the aggregate count to be exactly `63,235`.
4. Performs this state-dict check on the first checkpoint for each arm/seed
   binding; later matrix rows must reuse the same checkpoint binding.

The expected key/shape contract is duplicated locally in the independent
verifier rather than imported from the model implementation. This keeps a
model-shape drift from silently updating both the implementation and its
verifier together.

## Validation commands and facts

| Command | Environment | Result |
|---|---|---|
| `python -B -m unittest tests.test_d19_v2_verifier -v` | core-only Python 3.12 (`C:\msys64\mingw64\bin\python.exe`) | exit `0`; 10 tests, 1 expected PyTorch-unavailable skip |
| `C:\Users\zcz\anaconda3\envs\rl310\python.exe -B -m unittest tests.test_d19_v2_verifier -v` | PyTorch `2.7.1+cu118` | exit `0`; 10/10 passed, including real CPU torch round-trip |
| `python -B -m unittest tests.test_d19_v2_formal_runner tests.test_d19_v2_matched_history_preflight -v` | core-only Python 3.12 | exit `0`; 13 tests, 4 expected PyTorch-unavailable skips |
| `C:\Users\zcz\anaconda3\envs\rl310\python.exe -B -m unittest tests.test_d19_v2_formal_runner tests.test_d19_v2_matched_history_preflight -v` | PyTorch `2.7.1+cu118` | exit `0`; 13/13 passed |
| AST parse of the verifier and test files | core-only Python 3.12 | `AST_OK` |

The first sandboxed attempts of the two verifier test commands exited `1` only
because Windows temporary-directory ACLs rejected fixture writes and cleanup
with `PermissionError`/`WinError 5`. The same commands were rerun under normal
project permissions above and passed; no source workaround was made for that
environmental failure.

## Files and hashes

- `research/iclr2027/scripts/verify_d19_v2_evidence.py`
  - SHA-256: `4D2275FC93A785E1D6AD56435C97BF319AD97E65771D601280AE51F6315D45F6`
- `research/iclr2027/tests/test_d19_v2_verifier.py`
  - SHA-256: `5F1ACD9215F6CF84AFB0DF49D517B14AA07D97F90310AFCBCA593548EBE03F3F`
- This report is the only new result note for this hardening pass.

## Interpretation

This is a verifier-contract and test result only. It is not a D19-v2 formal
result, does not certify any training or evaluation outcome, and does not open
the D19 submission gate. A future formal artifact must provide a
`weights_only`-compatible checkpoint container in addition to satisfying the
existing hash, schedule, replay, and statistical gates.
