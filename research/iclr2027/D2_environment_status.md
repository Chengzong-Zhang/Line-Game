# D2 environment status

Date: 2026-08-25

## Completed in v0.1

- [x] Pure-Python, UI-free two-player engine for side lengths 5 through 15.
- [x] Canonical point actions followed by PASS.
- [x] Exact board, player-specific logical edges, and Superko state.
- [x] Legal-action masks and Gymnasium-shaped reset/step methods.
- [x] Terminal zero-sum rewards with both-player outcomes in `info`.
- [x] Lossless clone/restore, serialization, and replay.
- [x] Grid, GridGraph, Topology, and TopologyHistory observation protocols.
- [x] Permanent JSON fixture for the reachable weak-aliasing witness.
- [x] Standard-library unit tests.
- [x] Node-driven differential traces against the Web reference engine.
- [x] Multi-size throughput script and first local measurements.

## Evidence boundary

The D2-D3 implementation gate and the D4-D5 validation gate now pass for the
frozen dependency-free, two-player reference scope. The integrated suite has
55 tests after the D6 definition-regression checks, the enlarged Python/Web comparison has 65 matching complete traces,
and the attack/cascade cases have exact post-state assertions. Side length five
was also exhaustively enumerated: its 25,096-state, 67,505-transition raw graph
is a DAG and contains no natural Superko rejection. This exact absence result
is limited to side length five and is not extrapolated to larger boards.

The evidence still does not establish that topology improves learning or that
the omitted logical edges change an optimal decision. Those are scientific
questions rather than missing environment features.

## Next implementation gates

1. Search for a natural-Superko witness on sizes 6-15 without treating the
   exhaustive side-five negative result as evidence for those sizes.
2. Continue differential fuzzing beyond the current 60 random traces when the
   rules or transition core changes.
3. Profile legal-mask construction and implement search-oriented make/unmake or
   incremental caches without changing transition semantics.
4. Add an optional Gymnasium adapter after the training dependencies are
   installed; keep the core dependency-free.
5. Freeze a JSON experiment manifest and seed registry before any baseline
   training run.
