# Web final candidate audit — 2026-10-29

Scope: local candidate `codex/unified-web-mini-20261029` after source stamp `20261029-unified-r1` and Hard Worker rebuild r4. This receipt covers source and local runtime assets; it is not a production deployment, browser/device acceptance, or verification of an eventual packaged release inventory.

## Findings

- No missing references in a static scan of 107 top-level JS/MJS files and their 269 literal relative JS/MJS references, including literal dynamic imports and the rebuilt Worker. Bootstrap computed paths were also checked manually (`OnlineApp.js`, topology bootstrap, both Worker routes, and the bundle's four external imports). This is not a proof of every computed path or network response.
- All 18 model entries carrying an asset SHA across the four research/model manifests have present, hash-matching assets. Twelve named guide documents and five image references exist. External runtime dependencies remain: Vue CDN fallback, MathJax CDN, and Google Fonts; their availability was not established by this file audit.
- The Ultimate product flag is `false`; the accepted-release list is empty. `verify-terminal-release-admission-v4.mjs` and `verify-ai-menu-simplification.mjs` pass; the existence of a model file does not admit it as a product model.
- No `.rej`, `.orig`, `.tmp`, `.bak`, `.log`, `.env`, `.pem`, `.p12`, or `.pfx` paths and no files over 10 MiB under the frontend tree. Heuristic text scans found no private-key blocks, AWS access-key-shaped strings, or provider API-key-shaped strings. This is a limited pattern scan, not proof that no secret exists. Review the exact release archive again before upload.
- Hard Worker `MultiplayerHardAIWorker.bundle.mjs` SHA-256 is `50c99eee18447cc0cf0f39ce848c651bed0ff3adb4078c817fc0f31db3b2b445`; it matches the manifest and all 36 declared source hashes match current files. The generated manifest retains `verified: false`; the separate checks below provide bounded evidence and do not change that flag.

## Current checks

- `python -X utf8 working/tmp/unified-web-final-audit.py`: literal imports, model hashes, guide references, bundle/source identities and heuristic file/security scan as described above. The script is scratch evidence, not a release packager.
- `node web/web前端/tests/verify-topology-assets-round2.mjs`: PASS, 82 stamped module identities.
- `node web/web前端/tests/verify-classic-minimax-complete-iterations.mjs`: PASS, complete depth 4/5/6, interrupted optional iterations discarded, explicit deadline and caller state restoration.
- `node web/web前端/tests/verify-diamond-hard-budget.mjs`, `verify-root-ai-deadline.mjs`, `verify-ai-budget-worker-r5.mjs`: PASS; the latter is a bounded Node Worker test, not a browser latency guarantee.
- `node web/web前端/tests/verify-hard-progress-bundle-r5.mjs` and `verify-hard-terminal-budget-r5.mjs`: PASS against rebuilt bundle/local assets; the latter tested a 128-move case and separate exact terminal scoring.
- `node web/tools/sync-implementation-guides.mjs --check` and `node web/web前端/tests/verify-guide-content.mjs`: PASS, including 11 source excerpts.
- `node --test wechat/minigame/tests/shared-password.test.mjs`: 11/11 PASS using real loopback HTTP and real Web handlers with mocked Vue/socket; `node --test wechat/minigame/tests/shared-web-ui.test.mjs`: 13/13 PASS with simulated Vue/network. `verify-unified-room-ui.mjs` and `verify-shared-topology-room.mjs`: PASS, simulated interfaces.

Outstanding: separately compare the actual release archive against its complete expected runtime inventory and hashes; perform live browser interaction, real shared-room/cross-client acceptance, CDN/network verification, and post-deployment checks as applicable. No device, production, or external release is claimed here.

## Final staging audit

- After the topology settings restore, duplicate contribution-control cleanup and legacy Unicode compatibility fixes, reran the local scan: 107 top-level JS/MJS files, 269 literal relative JS/MJS references and 18 manifest-bound model files remain present; 12 guide documents and five guide images exist. Computed paths, browser/network behavior and final archive inventory remain outside this scan.
- The r4 build receipt matches all 18 named evidence files and all 36 bundle sources; SHA-256 remains `50c99eee18447cc0cf0f39ce848c651bed0ff3adb4078c817fc0f31db3b2b445`. Its build receipt status remains `BUILT_NOT_VERIFIED`, and manifest `verified` remains false; bounded execution checks are documented above.
- `git diff --check` returned success, with Git line-ending normalization notices. Review at this point covered 286 changed/untracked paths under `web`, `working/docs`, `working/task` and `.gitignore`: 96 tracked changes, 190 untracked. No candidate file exceeded 1 MiB, and bounded filename/credential-pattern scans produced no matches. This is not a full secret audit; inspect the staged diff again before push.
- Eligible for scoped review and staging: related Web source, runtime Worker bundle/manifest, tests and fixtures, guide material, release code/configuration and compact evidence here. The two `working/task/board-topology-20261026/` documents are a plan and historical result; preserve their stated status. The compact historical `working/docs/verification/pass-discipline-20261025/combined-admission-v5-r2.json` is referenced by Mini package tests and is not a fresh admission.
- Exclude local scratch, caches, logs, databases, archives and raw execution evidence under `working/tmp/` and `working/local_artifacts/`. The untracked `web/web前端/assets/research-ai/multiplayer-v1/multiplayer-ultimate-v1.f32` is an unadmitted model used as build evidence, not a product admission; do not stage it via a broad `git add`. Seventeen other local research model weights are ignored by Git. Their presence in this checkout or hashes here do not prove they are included in a release archive; explicitly audit any required runtime assets in that archive.
- The main task reports Chrome retested the N5 torus after two moves: size 5 and torus label restored, and mobile replay played 2/2. This is a targeted browser observation, not blanket cross-platform, real-device or production acceptance.
