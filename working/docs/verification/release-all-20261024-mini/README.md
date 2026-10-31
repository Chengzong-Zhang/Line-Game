# Mini 0.12.7 all-feature integration

Status: `PASS_EXACT_SOURCE_LOCAL_CANDIDATE_NOT_UPLOADED`.

The isolated candidate uses `territory-v3` and the exact 2026-10-24 Web engine (`3b70b69c...`). It includes the current four-cabin UI, account/profile recovery, root markers, undo/replay, board shapes and starting points, local 2–6 player modes and admitted model choices. The latest Web multiplayer Hard implementation is retained; Mini supplies verified embedded resources and native-compatible clocks/cloning/hash adapters. Unqualified Ultimate remains disabled.

New local games and new shared rooms explicitly select V3. Existing V2 saves/rooms retain their original rules. A detached old V2 room no longer contaminates a newly created room. V2 training contribution consent is preserved; V3 games are excluded from that older data protocol.

`mini-integration.patch` is relative to the migration worktree; `web-portability.patch` is relative to the frozen Web peer. Both have exact before/after hashes in `source-overlays.json`. The Web patch includes harmless cache-query differences needed to reproduce the exact bundled source hashes. Historical candidates/dist remain untouched.

Verification: 457/457 Node tests, zero failures/skips; input hashes unchanged before/after; 35/35 frozen candidate files; 14 real Canvas/browser Worker scenarios; six real loopback HTTP/WebSocket Web/Mini scenarios with this candidate's exact Worker. Login in the loopback fixture is synthetic. These checks do not establish phone acceptance, production activation, experience selection, review, or public publication.

Commands: `npm test` in snapshot `wechat/minigame`; `node tools/offline-check.mjs --browser-only` there; `node wechat/minigame/tools/prepare-candidate.mjs --verify local_artifacts/wechat-candidates/0.12.7-e7945958e106-W7RCGP` at snapshot root. Detailed paths, hashes and results are in `verification.json`.

The Web peer used to describe portability changes is r1. Final Web r3 subsequently added GUI-only return-to-local guards in OnlineApp; that file is not in the Mini bundle. This receipt does not claim whole-directory identity with Web r3. The actual shared engine and compiled Worker bindings remain unchanged.
