# Minimax Hard integration and package receipt

This receipt covers source integration, deterministic regressions, generated
bundles and the isolated Mini Game 0.12.16 candidate. It does not establish
playing strength, browser/device latency, upload, review or public release.

## Product change and quality boundary

The Web Worker, room-bot bridge/runtime and native Mini Worker now select the
same `BudgetedMinimaxAI.js` for Minimax Hard. The shared 3,000 ms budget starts
before engine reconstruction/replay. Search reserves 200 ms for the outer PASS
guard; that guard receives only the time still available. Search may deepen to
eight plies and publishes only completed iterations. A difficult position may
return a completed shallow search or a legal fallback. This is a documented
quality tradeoff, not an equivalent optimization of the old mandatory
four-ply search.

`minimax-4` remains the existing profile ID; it is not evidence that a request
actually completed four plies. The returned diagnostics expose actual depth,
discarded partial work and total elapsed time. New product search results are
explicitly marked `trainingLabel: false`.

The original `AIEngine.js`, exact-depth/core iterative-deepening regressions,
Easy/Medium, and the existing multiplayer Hard route are retained. No new
neural weights or training labels were promoted. The defensive teacher and its
completed-depth label contract are unchanged. User-facing bilingual text now
describes Hard as approximately three seconds rather than promising depth four.

## Regressions executed

All commands below exited 0:

```text
node web/web前端/tests/verify-budgeted-hard-integration-v1.mjs
node web/web前端/tests/verify-online-room-settings.mjs
node web/web前端/tests/verify-minimax-deepening.mjs
node web/web前端/tests/verify-worker-terminal-winning-pass.mjs
node web/web前端/tests/verify-online-bot-bridge.mjs
```

From `wechat/minigame`:

```text
node --test --test-timeout=180000 tests/minimax-speed-strength.test.mjs
```

The native targeted suite passed 15/15 tests. It retains exact-depth 2–6 and
the old complete-base-four-plus-100-ms core tests. New product tests cover the
shared budgeted implementation, accurate completed-depth reporting, legal
expiry fallback, source-state preservation and absence of browser globals.
The integration script checks Web Worker/room runtime/bridge parity,
Easy/Medium identity, zero-output requests and expiry during reconstruction.

`npm test` rebuilt the native dist and ran the complete suite: **522 tests,
514 passed, 8 failed**, exit 1. Its raw local log is
`local_artifacts/hard-budget-20261026/native-tests-r1.log`. The failures are two
historical Greedy/PASS expectation mismatches, one obsolete native AIEngine
hash assertion, and five candidate tests that omit the required sealed
terminal-admission argument. Original tests and gates were not weakened.
Baseline attribution is recorded separately by
`verify-inherited-native-failures-v1.mjs` /
`working/docs/verification/hard-budget-20261026/inherited-native-failures-v1.json`.
Attribution passed against baseline commit
`14685b2c883991a2e870ef179941456ff7df6f31`: 90 repository dependencies retain
their source content, with four clean checkout CRLF/LF differences recorded;
four third-party modules use the same installed bytes and unchanged dependency
lock entries. The original generic-Greedy assertion first fails for six
players on a triangle; historical and current Worker outputs match. The old
unique-terminal-PASS fixture likewise returns the same safe placements in
both versions. This is bounded attribution, not a rerun or passing claim for
the entire historical suite.

## Build and isolated candidate

The generated multiplayer Hard bundle was rebuilt using compiler 0.25.12 and
its existing pinned toolroot:

```text
node web/tools/build-multiplayer-hard-worker-v1.mjs "C:/coding/py/line game/local_artifacts/territory-v3-hard-worker-20261024/toolroot" local_artifacts/hard-budget-20261026/hard-worker-build-r1 e5c855c2441291ee4f6961be26c86a16a4320040c545d8fcc84e241373d84d38
node web/web前端/tests/verify-territory-v3-hard-worker.mjs local_artifacts/hard-budget-20261026/hard-worker-build-r1 local_artifacts/hard-budget-20261026/hard-worker-build-r1/actual-worker-verification.json
```

Both exited 0. The bundle has 29 input modules, 375,036 bytes and SHA256
`aa0310a17dfc9d6ce829957d524abd2890a60d777ea68a7048fbf9e734a32369`.
`PASS_V3_HARD_WORKER_SOURCE_AND_ROUTE` verifies emitted bytes and the production
multiplayer route under a controlled Node shim; it is not a browser benchmark.

The isolated online recipe was run from `wechat/minigame`:

```text
node tools/prepare-candidate.mjs --online --api-base https://lifelinegame.cn --terminal-admission "C:/Users/zcz/.codex/worktrees/pass-discipline/line game/docs/verification/pass-discipline-20261025/combined-admission-v5-r2.json"
node tools/prepare-candidate.mjs --verify "C:/Users/zcz/.codex/worktrees/pass-discipline/line game/local_artifacts/wechat-candidates/0.12.16-36fc9ff53923-zIqb9H"
```

The candidate is **PREPARED_LOCAL_NOT_UPLOADED**, version **0.12.16**; static
verification returned `PASS_CANDIDATE_FILES` for 35 files. The recipe compares
fresh isolated rebuilds byte for byte, including all 17 verified model assets.
The online recipe preserved the tested offline dist. Total package size is
19,948,691 bytes; the main package is 1,794,875 bytes.

The additional static verifier
`working/docs/verification/hard-budget-20261026/verify-package-snapshot-v1.mjs`
passed and wrote `integration-package-v1.json` beside it (SHA256
`f0390db63b8070519ed0b66d49583c0464d645208695f81359c6ece329d15e93`).
It binds all 170 frozen candidate inputs to current bytes, records the Web,
room and native entry-point hashes, checks all 17 packaged model identities,
and verifies that the candidate Worker equals the tested offline dist.

| Item | SHA256 |
| --- | --- |
| Canonical BudgetedMinimaxAI.js | `6083b9a3516c16fb835bf33f1c4cfb31f668444f57491f00a3bd7a3ee0305ccf` |
| Native worker-runtime.js | `a5e9f9b294cec0fc04f224931c4684f950e576cbbfc00d35cc9bd56e8c99e0a0` |
| Candidate and offline dist workers/index.js | `5d2e5b8ed99254529c6d2d124faff59f12ff4676c43ee50616d73c7ad9158a40` |
| Candidate build-manifest.json | `36fc9ff53923853bf114f4452f382dd140d8d9943498f671fea721a870719c5c` |
| Candidate candidate.json | `0211dd1695c88844488ed4c525142b2a5728261261a0d0267f6d2179de5416a3` |
| Unchanged canonical AIEngine.js | `695c8ddf1db6e8d897929da7660dc8dc9f7e66e219b80e6dfab4c38067e4a082` |
| Unchanged native AIEngine.js adapter | `f5dc5b498ae9b684c1d7f4152b5f853e45d884894553894e9bbdbbe284280a95` |
| Unchanged native compatibility manifest | `96dae636e96019bc14003eb2ec297bdd5bf994e7e708b5bf58d40f4051c17890` |

## Historical admission scope

The sealed report `pass-discipline-20261025/combined-admission-v5-r2.json`
retains SHA256
`c49570f4a3d0a6c35d02049f0aeec74f1b43aa240e983c06983f4d424c8f0f11`.
The preparation gate binds unchanged terminal-policy overlay bytes, four
candidate identities (`easy`, `three-v4`, `three-v1`, `hex-v1`), their runtime
parameters and the existing scoped report. Its result explicitly retains
`global_runtime_admission: false` and `strength_verified: false`.

That historical evidence does **not** admit the new budgeted Hard module or
the changed entry points. Its old runtime source snapshots remain historical
snapshots. New Hard integration, independent complete-pipeline timing and any
release decision require fresh evidence. This receipt neither changes the
sealed report nor represents the narrow policy gate as new Hard admission.

No commit, push, deployment, Mini upload, review submission or public release
was performed by this integration/package task.
