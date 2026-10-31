# Unified Web product candidate — 2026-10-25

Status: **FROZEN_LOCALLY_VERIFIED_NOT_DEPLOYED**. No SSH, upload, Git push or public activation was performed by the Web candidate agent.

Final directory: `local_artifacts/release-all-20261025-web-unified-r3/bundle`.

- Release: `web-all-features-20261025-r3`; cache graph: `20261025-unified1`.
- ZIP SHA-256: `7e65262a81f81d1b3edb0512f7c6ccd757a56e7e5467917d311d808c03f8192f` (18,539,563 bytes).
- Manifest SHA-256: `a99f981627c52861f244dca7e1487361dc6e4021e963769b270a2fdd7a632ad8`.
- 121 public runtime files, including `MultiplayerStandardDefense.js`; all 108 actual predecessor runtime pins remain enforced.
- 164 literal module/asset references and 66 JavaScript syntax checks pass.

This candidate combines MAIN commit `77c6c05ad9cc4eafa7bf1bd6de043644c72d568d` plus the current product changes with the previously reviewed production account/8-character shared-room bridge. It retains V3 explicit new-game defaults, V2 save/room continuation, V3 local state after leaving a room or signing out, shared settings/undo, and the old connection replacement/timeout correction.

The latest Minimax offensive-cut and voluntary-PASS logic, ModelFree PASS probabilities, native Worker terminal winning-PASS gate, AI failure pause behavior, and multiplayer StandardDefense are included. MAIN is authoritative for rule/AI behavior. Eight key rule/AI modules were compared to MAIN after removing cache-token/newline differences and match exactly. ModelFree retains the previously reviewed synchronous factory and strict tensor-schema adapter while receiving the current PASS policy. Its synthetic test manifests were completed with the real production dimensions/tensor shapes; runtime validation was not weakened.

The Hard bundle was rebuilt once because the module graph was stamped with the new cache identity. Its hash is `d7326a7780428a496090696c33d95df5960adf6c5886588eb6cfa8ebd0270768`. Its 20 embedded input modules and external runtime evidence are bound by the immutable build receipt. The actual production Worker route returns a V3 result, and the bundle contract passes 8 groups across 20 contexts. The shared GameEngine remains `3b70b69c4c480117a4952b06c279054ec535268b4293b04b4d63f960ac4b0fca`.

Focused product checks cover Minimax PASS/attack, model-free PASS and its actual Worker route, terminal winning PASS, multiplayer safe PASS, StandardDefense, Hard reply resilience, the complete AI UI session including rejected-PASS pause, control flow, online settings/undo, replay and V3 scoring. The 26 production account/shared-room/password/leave/logout regression cases pass. StandardDefense first used its unchanged 60ms safe fallback during a concurrent check; the isolated same-budget original fixture then passed all 16 cases. This is not a general latency or playing-strength claim.

The historical `verify-neural-voluntary-pass.mjs` depends on a research training checkpoint and is outside this product release; no replay run began. Product `verify-research-ai.mjs` passed instead. The permanently closed `hard-early-comparison-v1-r1` experiment was not run or modified.

`web-production-merge.patch` is the compact source-only integration diff against current MAIN, normalizing cache identities to `VERSION`. `web-production-sources.json` binds original and candidate module hashes. `web-local-verification.json` preserves initial failures and subsequent fixture/environment resolutions, exact commands, source stability, actual Worker receipts and known verification boundaries. The runtime ZIP excludes tests, training receipts, unregistered candidate models, source maps, credentials, local databases and logs.

Default V3 replay contribution remains outside the older reviewed-training schema. V3 games stay local/exportable; this candidate does not claim a new V3 training upload protocol. Native WeChat acceptance, server activation and public HTTPS checks belong to separate release receipts.
