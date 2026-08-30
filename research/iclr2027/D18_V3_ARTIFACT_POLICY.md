# D18-v3 artifact policy

Status: **fail-closed; no result-tree file is approved for Git**.

## Boundary

The complete `research/iclr2027/results/formal/d18_v3/` tree is local-only.
It contains generated task bundles, immutable per-pair and per-task evidence,
AutoDL stages, runner-control state, exports, and verification workspaces. The
repository ignores this tree as one unit and has no negated (`!`) exception
for it.

The frozen protocol, manifests, runners, tests, execution receipts copied to a
separately reviewed compact evidence package, and independent reports remain
trackable outside the ignored tree. A filename alone never promotes an
artifact out of the local-only boundary.

## Promotion gate

Any future compact package must be materialized outside the ignored tree and
reviewed separately. It may be considered only after the declared formal run
is complete, every game replays, all source and receipt hashes match, the
independent gate passes, and raw trajectories, checkpoints, credentials,
local paths, logs, stages, and transient state are absent.

Do not add a negated ignore rule and do not use `git add -A` around the formal
result tree.
