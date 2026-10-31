# Mini 0.12.8 latest AI synchronization

Status: `PASS_EXACT_SOURCE_0128_LOCAL_CANDIDATE_NOT_UPLOADED`.

Built from the verified 0.12.7 snapshot in a new isolated directory. UI, account/avatar handling, root markers, V3 rules, shared rooms, replay, local multiplayer and existing model integrity checks are preserved. New raw inputs are MAIN `77c6c05` plus the explicitly authorized dirty AI closure; exact raw hashes and native compatibility deltas are in `source-overlays.json`.

The Mini Worker itself invokes the same 60ms isolated-engine terminal PASS function as current Web AIWorker, after profile and model checks. Only an immediately terminal unique winner returns PASS; draws, losses, errors and deadlines fall through. Model-free PASS heads and the standard completed countercut-defense gate are active. Latest Minimax defense/offensive-chain code is used directly from the pinned AIEngine.

Verification: 461/461 full tests, 11 focused tests, two extra offensive-cut cases against the exact frozen compiled Worker, 14 Canvas/browser Worker scenarios, 35/35 frozen files. All 561 source/test/tool inputs remained unchanged before and after the full run. Browser and VM fixtures do not establish real WeChat login or phone acceptance.

`from-verified-0127.patch` is a compact reproducible source/test/config delta; `git-source-manifest.json` describes source files suitable for the integration branch. Do not copy this snapshot's complete ancillary Web directory over the final Web peer. The CI SDK is linked locally and must not enter Git/package. Raw model staging and generated dist stay local.

No official upload, SSH activation, experience switch or public release was performed by this subtask. V3 games remain outside the older V2 training contribution protocol; unqualified Ultimate stays disabled. No closed Hard experiment was run or modified.
