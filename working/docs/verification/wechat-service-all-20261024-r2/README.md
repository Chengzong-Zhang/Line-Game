# Complete shared-service release 2026-10-24 r2

Status: PASS_LOCAL_COMPLETE_SERVICE_NOT_DEPLOYED.

Candidate: `local_artifacts/wechat-service-all-20261024-r2/package/service`.
Activation input: sibling `release-manifest.json`, SHA256 `914fb6d38d4626c0e2bfe4e5ef0894a986c9bcc26de644625b7758fddf05c16c`.
The package carries original source paths and bytes for the complete 57-file Node/Python import closure. The 58th retained runtime file is the existing `service-manifest.json`, copied from the hash-matched live tree rather than regenerated.

The API defaults old create requests without `rulesVersion` to v2; new clients explicitly request v3. Stored v2 settings and hashes remain valid. Existing rooms never change rules through waiting-room settings. The shared API supports two-player waiting-room settings and mutual undo, including terminal actions. Empty sole-owner waiting rooms are closed atomically on joining another room. Shared timer requests fail closed because server-enforced timing is not implemented.

The local checks include 18 synthetic SQLite + real Node cases, 12 empty-room regression tests with the real verifier, six activation failure/recovery models and the current main v3 scoring fixture against the frozen engine. Model tests are not Linux or production proof. The old shared scoring fixture fails its obsolete single-rendering-polygon assumption; the current main fixture matches the owned-wall/safe-cavity rule.

CLI: `python3 activate_service_release.py preflight|activate --manifest release-manifest.json --expected-sha256 HASH --bundle package --run-dir NEW [--execute]`. Put `activate_profile_service_live.py` beside this entry. Preflight and activation each need a different new run directory directly below `/home/ubuntu/line-game/.deploy-artifacts`. Root:ubuntu readable permissions are required for synthetic-user probes.

The tool checks the exact 52-file live baseline, actual service identity/environment, database inode, writer ownership, Node/Pillow dependencies and isolated compatibility before stop. It retains the current complete tree for rollback, captures a stopped database backup for investigation, atomically exchanges code, starts the same systemd unit and verifies v3 capabilities plus schema3 integrity. It never restores a database or changes credentials, environment or unit configuration. Uncertain recovery retains the deployment lock and journal.
