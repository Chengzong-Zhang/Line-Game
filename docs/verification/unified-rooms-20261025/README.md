# Unified human/AI rooms, 2026-10-25

## Contract

Web, shared room service, and native Mini Game use one create-room flow and the existing full board cabin. Each of 2–6 seats is human or a selected AI; the creator occupies the first human seat, and other human seats wait for invitations. AI seats may be interleaved. Host edits before play reset human readiness; edits during/after play are pending for the next agreed rematch and preserve the active game. Occupied human seats cannot be removed or converted to AI.

The common settings cover board shape/size, fixed/random/custom starts, starting color, individual AI policy, hints, undo, and authoritative turn timing. Undo and rematch consent count actual human members. New games use territory-v3; persisted older rooms retain their rules version. Formal scores use discrete area.

## Verification

- Mini Game complete suite before cache refresh: 474/474 passed. Final cache/pin refresh plus the subsequently repaired zero-hint-budget toggle: 48/48 targeted tests passed. The final online candidate was rebuilt independently and verified byte for byte.
- Shared-room and prior AI/random-start Python suites: 14/14 passed, including a real service producing 15 snapshots accepted by both Web and Mini Game reconstruction, six interleaved seats, a non-BLACK host, actual AI moves, resignation, and next-match board/count changes. Both clients reject tampered state hashes.
- Compatibility probe: 19 checks passed, including stored v2 hashes, restart, unanimous undo, and new v3 rooms.
- Deployment builder: 3 tests passed, including real 2-player Minimax / 6-player AI and authoritative validator agreement, and rejected tampered/incomplete bundles.
- Actual Vue 3.5.22 watchers verified draft isolation and custom starts/model identities across queued updates. Web recovery, starts/undo, room AI/profile, legacy bridge, hex bridge, and Node crypto regressions passed.
- A local browser fixture completed create/invite/ready/AI-move and pending next-game edits using a six-seat mixed room. No browser errors were recorded. This is a synthetic localhost session, not WeChat device acceptance.
- The rebuilt hard Worker passed source/route verification with SHA-256 e408e7318653345f6a53c31a3e7c36d7c7ffe68896a9e5e803e5d6ce4be03862. This makes no playing-strength or device-latency claim.

## Release boundaries

Web cache version: 20261025-room1. Mini Game version: 0.12.11. Deployment identity: web-unified-rooms-20261025-r1. Complete Web runtime and both Node ESM bridges are deployed together; server databases are preserved. The deployment validates freshly read predecessor hashes, probes staged/live runtime, retains backups, and rolls back on failure.

Activation, public-resource verification, GitHub delivery, and official Mini Game upload are recorded separately in delivery.json after execution. A code-upload receipt does not establish experience-version selection, device acceptance, review, or public publication.
