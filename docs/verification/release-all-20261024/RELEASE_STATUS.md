# All-feature synchronization and territory-v3 correction

Status: Mini **0.12.7 officially uploaded**; server activation awaits native SSH
authentication. Experience selection, phone verification, review and public
publication are not established by this receipt. See `release-state-20261024.json`.

The public shared API still reported `territory-v2` before this attempt. Earlier
room/Android repair uploads deliberately retained v2, so those uploads never
delivered the new scoring rule. The new candidates use the current main engine,
SHA256 `3b70b69c4c480117a4952b06c279054ec535268b4293b04b4d63f960ac4b0fca`.
Official developer upload is recorded in `official-upload-0.12.7.json`.

New local games and explicitly created new rooms use v3. Continuing an old save,
replaying an old game or restoring an old room preserves its stored rules.
Fresh creation after old-room detach, Web logout and returning to the local board
now uses v3 instead of inheriting v2. These are separate regression cases.

The formal score counts friendly nodes/line points plus individually enclosed
enemy-free pockets. The deployment probe checks initial 1:1, an open two-step
extension scoring 3, a safe six-point ring scoring 7, exclusion of an occupied
pocket, and a ten-move closed position scoring 10:9 rather than White's geometric
polygon value 11. Rendering polygons do not determine the score.

The final Web input is `local_artifacts/release-all-20261024-web-r3/bundle-r3`;
the final shared-service input is `local_artifacts/wechat-service-all-20261024-r2`.
The unified immutable transfer is in
`local_artifacts/release-all-20261024-deployment-r3`, with remote release identity
`web-all-features-20261024-r1`. Earlier local r1/r2 bundles were not activated.
The final local native transport is
`local_artifacts/release-all-20261024-native-r3/transport.json`.

The coordinator verifies both API candidates before stopping either service,
uses each API's rollback, and atomically changes the Web directory last. It
preserves the current databases, unit configuration and secrets. A failed Web
switch restores that Web tree; successfully upgraded compatible APIs can remain
active, with an explicitly incomplete global receipt. Interrupted activation is
given a TERM recovery interval rather than immediately killed. An independent
systemd worker and single-use receipts prevent a dropped SSH session from
silently replaying deployment.

Mini source/candidate checks are in `../release-all-20261024-mini/`; Web evidence
is in `WEB_CANDIDATE.md`; service evidence is in
`../wechat-service-all-20261024-r2/`. Exact source patches and manifests are
retained there. Current v3 games remain outside the older v2 research contribution
protocol; this release does not invent a new training-data protocol.
