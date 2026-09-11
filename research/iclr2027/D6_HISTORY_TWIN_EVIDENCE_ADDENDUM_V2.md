# D6 history-twin evidence addendum v2

Date: 2026-09-01

Status: append-only post-D6 evidence. This file does not rewrite
`D6_state_aliasing.md`, `state_aliasing/search_report_v1.json`,
`state_aliasing/superko_n6_witness_v1.json`, the frozen D6 red-team audit, or
any historical review or submission gate. Their negative statements remain
valid only for the searches, evidence cutoff, and claim scope recorded there.

This addendum records a later positive witness. It is working-tree evidence,
not a committed Git subject, formal training result, author approval, release
approval, or submission authorization.

## Conclusion

Two legal histories from the standard side-six initial state reach states with
the same mask-free topology but different retained Superko histories. The
shared candidate placement `(2,3)` is legal after one history and is rejected
after the other exactly with `SUPERKO_VIOLATION`. The two legal placement sets
differ only at `(2,3)`.

This closes the narrow question of whether a naturally reachable paired-history
Superko-legality witness exists. It does not close the paper's stronger
construct-validity question because the implemented Grid and Topology
observations include `legal_action_mask`; that mask exposes the legality
difference, so the implemented mask-bearing observations are not equal.

## Primary targeted witness

The reference history is the ten-action natural prefix already frozen in
`state_aliasing/superko_n6_witness_v1.json`:

```text
B(0,1), W(4,0), B(2,0), W(1,4), B(2,3),
W(2,2), B(3,1), W(1,4), B PASS, W(1,1)
```

The newly found twin history is:

```text
B(2,0), W(1,4), B(0,1), W(1,1), B PASS, W(4,0)
```

Both replays end with BLACK to act. Their exact equal projection contains:

- side length;
- complete board values;
- typed BLACK and WHITE logical-edge sets;
- current player;
- consecutive-skip count; and
- terminal flag.

It deliberately excludes the Superko history and legal-action mask. The
canonical projection SHA-256 is
`33EAB73543D4521C09423D9D97E5129E02C18401049463273182161DC2DD8577`.
The repeated candidate-result key SHA-256 is
`C1362C7A100C1C512E2345740F4D9CBD1C34C12B7AB708D65DAC681365C14608`.
The reference contains that key; the twin does not.

The candidate was obtained by deterministic target-prioritized best-first
search with PASS included, a 25,000-state ceiling, action depth at most 20,
and no wall-clock stop. The heuristic changed frontier order only. It found
the twin after examining 8 states and 69 transitions at depth 6. These small
counts describe this targeted run, not prevalence, shortest history, or a
global exhaustive search.

## Byte-bound evidence

| File | Bytes | SHA-256 | Role |
| --- | ---: | --- | --- |
| `results/validation/targeted_history_twin_n6_stage5_search_25k_v1.json` | 7,684 | `4B87962DAFFB9AA44B2C67541EF420C8C1574C8E4D6820AFE518632BC10CF9E5` | Bounded search candidate |
| `results/validation/targeted_history_twin_n6_stage5_verification_v1.json` | 7,261 | `555A97F4DA22EC1072AFD0C9B39B2269DA9A2DD30412528EF114013EB6FA1B1F` | Independent Python plus Web replay receipt |
| `scripts/search_targeted_history_twin.py` | 24,657 | `B7C8E87169D5B573136FFB276B4B747339B9B4009D72A9EB427B863AF163B052` | Candidate-only bounded search |
| `scripts/verify_targeted_history_twin.py` | 37,556 | `6FFDF25842481E419C36EB2F067020BEF88DE586220C71F8F24659885CD3DD8C` | Search-independent Python verifier |
| `scripts/verify_targeted_history_twin_web.mjs` | 8,962 | `87F5A0DB7C3DC6E4E4B4224FEEEB0387DF99D344E31A30F06F1B239FF9D54795` | Independent Web-engine replay verifier |

The persisted verification receipt has `status="PASS"`, `ok=true`, and
`cross_engine_replay_verified=true`. Both implementations consume the same
persisted candidate JSON, replay both histories from the standard initial
state, compare exact mask-free topology, require different exact history sets,
and require the legal-set difference to be exactly the candidate. The receipt
binds the candidate, frozen fixture, Python core, Python verifier, Web
`GameEngine.js`, and Web verifier bytes.

## Corroborating pre-existing pair

The tracked Web theory verifier already contained a second natural side-six
pair for candidate `(1,1)`. The new Python verifier independently replays it,
and the tracked Web program confirms the same histories and legal-set
difference. Its compact working-tree artifacts are:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `results/validation/history_superko_n6_strict_pair_candidate_v1.json` | 2,035 | `5796D643B9F6ED8716983EC3234B2398C7B50D221E2A16EBB9682BA1FB6479F5` |
| `results/validation/history_superko_n6_strict_pair_verification_v1.json` | 6,714 | `EF209D84F7906B1858E9954415CD5971AF1F6D2EE878A811BE27EF78B4AD41A1` |

This is corroboration by a second witness instance, not a wholly independent
methodological replication: the receipts share current rule engines and the
new Python verifier.

## Claim boundary

Supported:

> At side six, naturally reachable paired histories can have identical
> mask-free topology but different Superko legality for a shared placement.

Not supported:

- equal implemented Grid or Topology observations, because their legal masks
  differ;
- a pair with identical observations and masks but different future optimal
  decisions;
- Grid, Topology, or any trained model input being non-Markov;
- a learning benefit from logical edges or compact history;
- TopologyHistory necessity, superiority, or a same-backbone ablation result;
- different exact game values, optimal actions, or unavoidable regret;
- a shortest witness, an exhaustive side-six classification, or a prevalence
  estimate; or
- promotion of D17-D19 or any failed scientific gate.

The central construct-validity blocker from the independent paper review
therefore remains open: a mask-free legality witness is useful mechanism
evidence but is not the stronger identical-observation-and-mask decision
witness requested by that review.

## Reproduction

From `research/iclr2027`:

```powershell
$env:PYTHONPATH='.'
python -B scripts/search_targeted_history_twin.py --max-states 25000 --max-depth 20 --no-time-limit --progress-every 1000 --output <create-only-candidate.json>
python -B scripts/verify_targeted_history_twin.py --candidate <create-only-candidate.json> --require-web-replay --output <create-only-receipt.json>
python -B -m unittest tests.test_targeted_history_twin tests.test_d6_aliasing -v
```

The current normal-permission combined regression result is 30/30 PASS. Ruff
lint and formatter checks pass for the three new Python files. No network,
GPU, package installation, self-play, optimizer update, evaluation game,
upload, or submission was used to produce this addendum.
