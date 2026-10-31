# Product source synchronization, 2026-10-25

This branch starts at `origin/main` a1c95d56 and imports the reviewed product
closure. It does not publish the 46 mixed application/research commits from
the author's dirty main working tree. Unrelated working trees and their indexes
were preserved.

The browser source is the final 121-file Web release with cache tag
`20261025-unified1`. The native Mini Game is 0.12.8. Its explicit
`wechat/minigame/compat/web/manifest.json` pins both canonical browser bytes and
the native adapters; build, test and service packaging apply the same adapters.
The rebuilt native game/Worker/model runtime matches all 33 published candidate
runtime files. The service package matches all 69 deployed runtime source files.
The additional source records and build receipts intentionally differ.

The Mini suite passed 466/466 (including five new adapter drift/path tests), the
14 selected Web checks passed, 41 deployment/writer/metadata checks passed, 12
real-SQLite/Node room-switch regressions passed, and 10 CI transfer tests passed.
The Python scoring probe passed five actual-method fixtures; its LF-normalized
Git-source hash is recorded separately from the historical WORK receipt.
These local checks do not establish a new device test or AI strength result.

Large generated model binaries are excluded from ordinary Git history. Their
hashes remain in the model and release manifests; restore the reviewed assets
from the release asset channel into the ignored source/model directories before
rebuilding. `npm ci --prefix wechat/minigame` installs the pinned toolchain;
`npm test --prefix wechat/minigame` builds and runs the native checks. The public
benchmark descriptor is included for the existing project-root regression; the
benchmark executables and experiment data are outside this product closure.

Deployment tools retain source/unit/database identity checks, atomic source
exchange and recovery using the latest database. The descriptor scan now
excludes only a demonstrably read-only, identity-stable database descriptor;
unknown access modes and configured/service/working-directory writers still
block activation. Tencent Cloud security processes are not modified.

The dated server receipt reports activated Web and API components. The official
WeChat receipt reports a developer upload and preview for the frozen 0.12.8
candidate. It does not claim experience-version selection, review acceptance,
public Mini Game release or a new phone test. No credentials, private keys,
databases, logs, raw research trajectories or generated archives are included.
