# D14--D16 runner recovery incident record

This is an external operations record. It is not a formal task receipt and is
intentionally stored outside the frozen `run_v1` evidence tree.

## Frozen identity

- canonical manifest SHA-256: `1bbf2c9a9ecc9174cd2d4b4299e22289dea58b7a53885e1be923374add2841cb`
- trainer source SHA-256: `21a46dbd787090fc18c24cb4e29ebe1dd743203d31abeda43b3ce421833b596c`
- runner SHA-256: `55c077c3fe08f7d3527be3950fb4e70b54a743130acaa911da8949f37ec59937`
- protocol/aggregator SHA-256: `1b4ca0a7f9115df4b4ecf95fa326425ce77caf6cf57e6a12c26625e279d2145d`

## Timeline

All local times are Asia/Shanghai (UTC+08:00).

1. The canonical task
   `eval.final_vs_search.n9.topology_gnn.seed20260826.gs200.vs.uct_mcts_16`
   began attempt 1 at `2026-08-27T05:52:21.427561Z`. The formal runner was
   PID 57900. At approximately `2026-08-27 14:43:32` local time, PID 57900
   disappeared while CPU had been increasing normally. Its Codex unified exec
   session 76562 returned `exit_code=-1` with no Python traceback. The task
   directory contained only `state.json`; no arena or receipt had been written.

2. A read-only executor status validation then exited 0 with exactly
   `266 complete`, `266 artifacts_deep_validated`, `0 failed`, and `64 missing`.
   The manifest SHA-256 remained frozen. No existing receipt was rewritten.

3. The same formal command was resumed as PID 64336. After the mandatory
   pre-validation, canonical state recorded attempt 2 beginning at
   `2026-08-27T07:05:45Z` and retained the attempt-1 start as the interrupted
   attempt. At approximately `2026-08-27 15:12:26` local time, PID 64336 also
   disappeared before producing an arena or receipt. Unified exec session
   41819 again returned `exit_code=-1` with no stderr or traceback.

4. Windows Application, System, and Defender event queries around both exits
   found no matching Python crash, critical system event, or Defender action.
   Because both failed runs were tied to Codex unified exec sessions, the next
   recovery was detached from that session lifecycle.

5. The identical formal command was launched with hidden `Start-Process` as
   PID 36632 at `2026-08-27T17:45:36+08:00`, with separate stdout and stderr
   logs in this directory. After pre-validation, canonical state recorded
   `attempts=3` and attempt 3 starting at `2026-08-27T09:54:54Z`.

## Lineage limitation

The executor increments `attempts`, but an interrupted evaluation has no
`attempt_XXXX.json` until a final receipt exists. `state.json` stores only the
most recent interrupted attempt. Consequently, after attempt 3 started, the
attempt-1 timestamp was no longer present in canonical `run_v1` state; the
attempt count remains `3`, and the two exact earlier start times are preserved
in this external operations record. This limitation must be disclosed in the
final results audit and must not be described as complete per-attempt canonical
lineage.
