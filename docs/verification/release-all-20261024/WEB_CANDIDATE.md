# Web all-feature candidate, 2026-10-24

Status: **FROZEN_LOCALLY_VERIFIED_NOT_DEPLOYED**. Actual server activation and public HTTPS verification belong to the deployment coordinator's separate receipt.

Final immutable bundle directory: `local_artifacts/release-all-20261024-web-r3/bundle-r3`.

- Release ID: `web-all-features-20261024-r1`; complete module cache identity: `20261024-all1`.
- 120 runtime files, 21,470,213 bytes; 108 previous-production runtime pins.
- Archive SHA-256: `b35ad4df3fe77b43d05384af7467c46b87bf8a31952a20f612bb1cffedbf20dd`.
- Manifest SHA-256: `9bfaaf64d6299eabc25360be6626c8ad4813942dd7ce2a6d6f2c6ee79b2732c4`.
- GameEngine SHA-256: `3b70b69c4c480117a4952b06c279054ec535268b4293b04b4d63f960ac4b0fca`.
- Rebuilt native Hard Worker SHA-256: `a6621442b775d6a6b8acdaed1cfbcf91b0ac3d24b4b4606b46274d324d6e7ec7`.

## Included behavior

New local, legacy-online and shared-online matches explicitly select `territory-v3`. Its formal score always includes the player's owned nodes/line points and separately adds every enemy-free pocket disconnected from the outside. A new untouched player's starting point therefore scores 1. Existing V1/V2 local saves, replays and V2 rooms retain their recorded rules. Explicitly starting a new local game, leaving a V2 room or signing out creates a V3 local state with matching settings and an empty action list.

Current main product sources supply the latest rule engine, 2–6-player board options, random/custom starting points, replay and local undo, rendering/territory workers, Minimax defense calibration, and native multiplayer Easy/Medium/Hard implementations. The newest cut-resilience Hard source is included in the rebuilt Worker; the earlier main bundle contained older source. Ultimate remains unavailable because it has not passed its admission gates. No unfinished training experiment or research candidate was promoted.

The existing production Web/WeChat account bridge, password-session prompts, 8-character rooms, connection replacement/timeout fixes, server-authoritative moves and emotes are preserved. Main's new legacy settings/undo API is retained. Shared V3 rooms pass complete normalized two-player settings, support host setting changes before readiness, and use two-party undo with actions locked during voting. Shared turn clocks remain unavailable because the shared server does not implement timed turns. The corresponding control is disabled.

Default V3 games stay local and export normally. They are deliberately rejected before entering the old reviewed-data upload queue; this release does **not** claim a new V3 training-contribution schema or automatic V3 training. Existing supported old-rule contribution behavior is retained.

## Source integration and reproduction

Main checkout was read only. Work was isolated in the existing `codex/wechat-minigame` worktree's local release snapshots. OnlineApp, GameController and I18n use the exact r2 main input for a three-way merge with production. NetworkManager uses commit `19221448d92798d88877b3b9a9c955c2da2a22bd` as its merge base, retaining production's connection lifecycle fix while adding current settings/undo messages.

`web-production-sources.json` pins the main source baseline and final runtime bytes. `web-production-merge.patch` contains the reviewable source-only changes after normalizing cache tokens to `VERSION`. Apply only to a matching baseline, stamp every relative JS/MJS module edge with `20261024-all1`, regenerate the four bilingual implementation guide Markdown articles, and rebuild the Hard Worker with pinned esbuild 0.25.12. The generated bundle manifest identifies the actual `multiplayer-hard-cut-resilience-v1` implementation.

The integration preserves the Mini-specific pure exports/hash injection/lazy model-loading extensions in ReplayCodec and ModelFreeAI and the portable guide-anchor parser. No credentials, databases, generated archive, raw game trajectories, source maps or logs are included in the deployment overlay or this compact evidence directory.

## Checks and scope

The final package passes 65 JavaScript syntax checks and 161 literal runtime-dependency references, with all target assets present.

Fourteen selected Node regressions cover V2 and V3 scoring, replay coding, local saves, complete local AI play, hex AI, online settings/undo, reconnection, guide assets plus 11 source excerpts, Minimax defense/state invariants, territory Worker and the shared V3 protocol. The 120 runtime hashes were unchanged before/after that regression pass. This complete pass belongs to the r1 runtime before the final two GUI return-to-local fixes. The final r3 changes then passed the complete local AI session regression and all 26 shared UI/password cases, including two new leave/logout V2-to-V3 cases.

The rebuilt r3 Hard bundle additionally passes 8 contract groups across 20 contexts, and its actual production Worker route returns a V3 result while embedding the exact current GameEngine source. These are controlled Node Worker checks, not browser timing or strength claims.

A frozen r2 shared service, actual Node rules validator, actual Web client and Mini compiled Worker (`38b8f5dcc7b43643c9691a01c3f437af578b1c0c3764fd87f0057fa95e923811`) passed six loopback HTTP/WebSocket flows: V3 creation with starting score 1; Mini join and state-hash agreement; host settings and starter updates; one move per side; two-party undo with sequence/hash rollback and action locking; and Web socket recovery. Login alone was synthetic. This test does not establish production-domain transport or phone behavior.

Exact commands and exit codes are in `web-local-verification.json`. Final raw logs, build receipts, test fixtures and the temporary loopback database remain in ignored local artifacts. Public activation, actual WeChat experience selection, platform review and public release are separate gates.
