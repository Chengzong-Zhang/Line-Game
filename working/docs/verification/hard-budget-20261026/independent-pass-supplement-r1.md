# Actual PASS branch supplement

Six additional real pipeline actions passed on the same frozen 0.12.16 candidate.
The original fifteen timing cases were not rerun. No source, candidate, history,
actor or AI ranking was modified. The actual Web Worker, room stdin/stdout bridge
and final compiled Mini Worker VM all share the 3000 ms reconstruction/search/guard
budget. Mini executes the actual subsequent APPLY and matches the complete
canonical resulting rule state.

| Existing natural fixture | Raw policy | Final action Web / room / Mini | Request → action seconds Web / room / Mini | Completed depth |
| --- | --- | --- | --- | --- |
| BLACK legally plays `[1,0]`, WHITE legally passes | PASS | `[0,4]` / `[0,4]` / `[0,4]` | 2.831 / 3.041 / 2.839 | 7 / 7 / 6 |
| Existing nine-placement settlement prefix, then legal WHITE PASS | PASS | PASS / PASS / PASS | 0.318 / 0.490 / 0.432 | 8 / 8 / 8 |

The first fixture's guard returns `safe-profitable-expansion` with all six actual
opponent responses completed, including PASS. Its native-area lower bound is
6 versus the original 2, and its minimum reply margin is 2. This certifies one
complete opponent round; it is not an unlimited-horizon guarantee. The second
fixture's complete solved candidate tree retains the genuine voluntary PASS;
the guard returns complete `no-certified-expansion` with all four legal roots
exhausted. These are actual PASS branches, unlike the earlier placement-only
timing sample.

The protocol does not directly expose raw ranking. A separate call to the real,
unmodified Budgeted core observed raw PASS on both exact matching source states.
For each pipeline, the selected guard receipt branch and frozen guard source
also require a nonempty original ranking headed by PASS. The JSON records this
evidence distinction rather than claiming that the transport returned a raw-rank
field. The native two-player route enters V4 and delegates to its existing
legacy guard; the resulting receipt schema is correctly recorded as v1.

An optional, existing fifteen-birth fully occupied canonical initial fixture
also passed: zero legal placements, real core PASS and real `forced-pass` guard,
about 6.4 ms. It has no inserted history or actor edits. This is a core/guard
boundary check, not a fifteen-seat product minimax route. The four-to-six-seat
hex V4 fixtures were not forced through Mini's unsupported basic minimax profile.

All source and final Worker hashes remained unchanged. Room process cold start
again makes its growth request exceed 3 seconds; no strict request-to-action
3-second or phone claim is made. The root task reported concurrent R2 selfplay
work; PID 60456 was absent at the local precheck, and CPU load was not isolated.
This remains Node/VM evidence, without browser render/cache/network or device
acceptance. The adjacent JSON preserves each full guard receipt and source,
input, candidate and raw-evidence hashes.
