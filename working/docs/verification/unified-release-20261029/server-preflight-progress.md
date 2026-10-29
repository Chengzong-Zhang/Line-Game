# Unified release server preflight — 2026-10-29

This is progress evidence, not activation or final-candidate approval. The Web,
Mini and common core were still being integrated when these snapshots were made.

## Collector

- Local transaction fault injection: five test methods passed, including pre-stop
  failure, post-stop recovery, snapshot failure and uncertain recovery retaining
  the lock. These are simulations, not a production restart drill.
- Real local Node validation accepted synthetic v1/v2/v3 replays, rejected missing
  consent and handled duplicates. Old collector source also opened a synthetic
  database containing the v3 table and continued to accept v1/v2 fixtures.
- First server check-only attempt stopped before any service mutation because
  systemd omitted the optional `EnvironmentFiles` property. The wrapper now
  normalizes that absent property to the empty value while preserving exact
  unit-file hashes and all other identity checks.
- Second server attempt: `PASS_COLLECTOR_PREFLIGHT_NO_LIVE_CHANGE`. It used the
  actual Python/Node runtime, service UID and a private SQLite backup. Existing
  table schemas/counts and integrity were checked; real replay rows were not
  selected or compared. No live submission was made.
- Probe manifest SHA-256:
  `e42cfa4dcc53019145365475882c9697307a3571a9fc067dddf3cbc5b6d98db5`.
- Remote evidence directory:
  `.deploy-artifacts/unified-collector-preflight-20261029-r1/probe-r2`.

## Legacy room service

- `PASS_LEGACY_RELEASE_PREFLIGHT`, `liveChanged:false` on the server.
- Candidate server/board validator and both Node bridge files were verified with
  the candidate frontend and, separately, the currently active frontend. Synthetic
  rooms, settings, undo, v2/v3 AI bridge, diamond/15-seat settings, protection rule
  and root mode were checked in private disposable databases.
- Probe manifest SHA-256:
  `7eba5c1b3d7f5fe466121af771c330a97cac4b39d9b17f73961b9147888d96aa`.
- Remote evidence directory:
  `.deploy-artifacts/unified-legacy-preflight-20261029-r1/probe-r1`.

## Boundaries

These temporary source snapshots are not the final release. Rebuild their
manifests after shared source/asset stamping stabilizes, then repeat the relevant
preflight before activation. No production unit was stopped, no live code tree
was exchanged, and no production database was restored by these checks. Real
Chrome flows, native WeChat execution, final package upload and public release
remain separate acceptance stages.
