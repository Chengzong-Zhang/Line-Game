# Independent Hard request-to-action check

All 15 committed actions passed native legality and state checks using the same
five frozen development inputs. This is a Node/VM check of the final 0.12.16
candidate, not phone, browser rendering, server network or general strength
evidence. Source and final Worker hashes matched before and after every unit.

| Input | Web Worker → action | Room stdin/stdout → action | Compiled Mini Worker → APPLY | Completed depths Web/room/Mini |
| --- | ---: | ---: | ---: | --- |
| Previous 9-road slowest, reference 50.402 s | 2.899 s | 3.215 s | 2.904 s | 2 / 2 / 2 |
| Previous 9-road second slowest, reference 36.704 s | 2.882 s | 3.051 s | 2.863 s | 2 / 2 / 2 |
| Previous 9-road third slowest, reference 31.464 s | 2.838 s | 3.042 s | 2.910 s | 2 / 2 / 2 |
| Ordinary 7-road, reference 0.520 s | 2.809 s | 2.295 s | 2.837 s | 5 / 6 / 5 |
| Known solved 5-road witness | 1.184 s | 0.999 s | 1.396 s | 8 / 8 / 8 |

The old timings are references from the completed frozen arena; old Hard was
not rerun. The three slow positions now return the same legal choices at a
completed two-ply horizon, with `shallowQualityTradeoff:true`. This is a deliberate
depth/latency tradeoff. The ordinary position spends more time searching deeper
than the old reference, so the check does not show that every position is faster.
All pipelines select `[2,0]` in the existing uniquely winning 5-road witness.
That is one tactical success, not an overall strength result.

The Web check sends real messages to `AIWorker.js` in a Node worker thread with
only the `self` bridge supplied. It verifies request/revision/rules/actor freshness,
unchanged source state and the native consumer action. The room check launches
the actual `online_bot_bridge.mjs` with stdin/stdout and includes cold Node
imports, canonical replay and the already-applied action. The Mini check reads
the exact final candidate `workers/index.js` in an independent Worker VM using
the existing native `worker.onMessage/postMessage` surface. The VM has no
`performance`, DOM, `wx` or `structuredClone`. It sends the actual `AI` request,
then actual `APPLY`, and checks the complete resulting rule state against the
canonical Web engine.

All three source routes pass the same absolute deadline and the remaining
budget to one external PASS guard. The internal reconstruction/search/guard
measurements stayed below 3 seconds here. All 15 selected placements, so the
observed guard branch was `placement-policy-preserved`; this is not latency
coverage of a long PASS certificate. Room process startup makes its maximum
3.215 seconds. Worker creation is reported separately; adding it gives observed
maxima of 3.138 seconds for Web and 3.021 seconds for Mini. There is no strict
end-to-end 3-second guarantee.

The first harness incorrectly asserted exact floating subtraction equality to
3000 ms. It rejected `2999.999999999999` after the third Web decision. Its first
two completed receipts and the uncommitted third-case failure remain untouched.
The replacement uses a 1e-6 ms comparison tolerance and persists raw responses
before assertions. It reuses the first two bound receipts without rerunning
them and explicitly repeats only the uncommitted third Web measurement.
There were 15 committed units and 16 new-candidate invocations including that
failed measurement, with no old-Hard rerun, training or battle.

New raw outputs live under the canonical `working/local_artifacts/` entry in
the primary checkout. The original frozen r1 harness, inputs and candidate
retain their original paths. Durable raw-journal time is reported separately
and excluded from the displayed request-to-action timings. The adjacent JSON
records per-unit results, source/candidate hashes, invocation command, incident
scope and raw receipt SHA-256. Candidate version: `0.12.16`; final Worker SHA:
`5d2e5b8ed99254529c6d2d124faff59f12ff4676c43ee50616d73c7ad9158a40`.
