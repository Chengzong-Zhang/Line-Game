# D17/D18-v1 canonical closure receipt

- Receipt date: 2026-09-01 (Asia/Shanghai)
- Subject commit: `b07eb852573acb6a635d3045ccbbadd9a5759b06`
- Subject tree: `fd86b192f25f619a6e3dd5014117e687827db86e`
- Disposition: **CANONICAL INTEGRITY CLOSED / SCIENTIFIC GATE FAIL_CLOSED**

## Decision

| Question | Result | Boundary |
| --- | --- | --- |
| Frozen canonical numeric recovered | PASS | exact SHA-256 bound below |
| Producer input snapshot stable | PASS | 347/347 roles; before/after fingerprint identical |
| Independent numeric reproduction | PASS | byte-identical to producer numeric |
| Independent replay and accounting | PASS | 85/85 tasks; 8,320/8,320 records |
| Canonical verifier gates | PASS | 3/3 true |
| Overall verifier gates | FAIL_CLOSED | 24/25 true; one diversity gate false |
| Scientific gate | FAIL | 22/45 D18 tasks do not satisfy the diversity criteria |
| Submission readiness | NO | integrity closure is not scientific sufficiency |

This receipt closes the previously missing canonical generation and independent
recomputation interface for the frozen D17/D18-v1 export. It does not change
the frozen experiment outcome, repair trajectory diversity, open D19, admit
D18-v3 or BASE-SEARCH evidence, approve a supplement, or authorize submission.

## Subject and code bindings

All repository paths in this receipt are relative to `research/iclr2027/`.

| Artifact | SHA-256 |
| --- | --- |
| `scripts/d17_d19_build_canonical_from_export.py` | `B65585B023FA6A6A1AD2BBD0CD221637B0B34B60622814251B7928A5C16E0503` |
| `tests/test_d17_d19_canonical_recovery.py` | `EF2E43BC273513D5FA277F79314FC6972ADB40CB3650933F8E716CBECE514BCE` |
| `scripts/d17_d19_verify_evidence.py` | `E6C90F82CBDBEC5FA2116CC642D98C1A09D234B076E55934DF06A4F2A06A9861` |
| Exact formal-source digest | `21A46DBD787090FC18C24CB4E29EBE1DD743203D31ABEDA43B3CE421833B596C` |

The producer authenticates its captured source bytes before execution and
uses a private runtime namespace. The source and test hashes above bind that
implementation; they are technical code evidence, not evidence that the
scientific diversity threshold passed.

## Frozen evidence inputs

| Input | SHA-256 |
| --- | --- |
| `configs/d17_d19_formal_manifest.json` | `2349C2B47AC06CD0632F6B06AEA8950A21846F9FFA88320DE4BCC7A49639FFB9` |
| Canonical manifest content | `9D0D69A0D41A18837188E78F42A0C14A704C8DF265A8A1A2FD251A13F6B36580` |
| Local task bundle `tasks.jsonl` | `1C0677CA6B07BDE67CE0B970FC84372AADA626D0DCCD2CB9636AABB65BD2541B` |
| Local task bundle `game_manifest.jsonl` | `4FB1D54AFFF58E9197EC163A966A4BCC6ADFB885EEBB7E72B49BFD053FE0F7A7` |
| Formal export receipt ledger | `09AFC03CADFC54CC143D7049DFE78328C1665B3F698274C26A4DBF711C0F080A` |
| Formal export ledger status | `4AC0A2A518244B0F8D26D827FC490B1E868D0FE3353559E4AAFAEC6E7B2E8AC1` |
| Frozen runner | `D128DFE4A2480B4523CA6BC37642BC393BEAD4C7BA0D037DC692808FC3D52991` |
| Frozen experiment definitions | `34D4ABA6D38D51B1AF1602745AAEE8A234C611ED9EFF985FE218F68FC83FEB05` |
| Frozen protocol | `98A55CA40006639BD572D83071D0D5535D4E1A17F71050E7E7444EDC6DAB9726` |
| Execution metadata | `BB145D7FE187664D2A5A76AF3030874EE4C23A6EDD177896D738F6DFB5E7FA7E` |
| Execution summary | `52CA00D3C0219C58EB539915CB04663E1C1D40D657A4BE20B0F525FE383BE560` |
| Export manifest | `C765C3C2B5B5D38BC4B4309F4A575666D622C78680343C7A5203054F2B940156` |
| Export payload tree | `BC891B6CE917F094DD6EEB030A3E5A9E3B2754BC3479619E34B656324D57375E` |

The eight explicit verifier inputs were SHA-256 sampled both before and after
the independent replay. Every post-run value matched its preflight value.

## Authenticated producer v2

The ignored local producer directory contains exactly two regular files:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `producer_v2/canonical_numeric.json` | 38,434 | `F26E3745A5F28A7575FCE66517B1C2D0CB8C2B4FCC9EC3C4D416926B5A10DD19` |
| `producer_v2/canonical_derivation_receipt.json` | 2,891 | `C6D800C111AC39DDBFF128AC53BAEA60213FE2CA12503766882A91984F6E7E4E` |

The producer receipt records:

- 347 fingerprinted input files and 347 stable input roles;
- identical before/after producer input fingerprint
  `1139706DEB7A7E0429F0C81A7DF7AA3E13EA2CC27A2EECF60E8A01396AE7182D`;
- 85 complete tasks and 8,320 game rows;
- 22 of 45 D18 tasks that do not satisfy the task-level diversity criteria;
- `execution_complete=true`, `formal_task_gates_all_passed=false`,
  `publication_ready=false`, and `formal_ready=false`.

The producer receipt also records `independent_verification_passed=false`.
That is the truthful generation-time state before `independent_v2` existed;
the immutable producer receipt was not rewritten after the independent run.

## Independent v2 verification

The new ignored local verifier directory contains exactly two regular files
and no subdirectories:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `independent_v2/independent_numeric.json` | 38,434 | `F26E3745A5F28A7575FCE66517B1C2D0CB8C2B4FCC9EC3C4D416926B5A10DD19` |
| `independent_v2/independent_verification.json` | 299,904 | `79DDC3F58C418CB476E1520B1357F74680D811559CFC240F58101131B10604BB` |

The independently written numeric file is byte-identical to the producer
numeric file. The report also binds all four producer-v2 identities:

| Binding | Verified value |
| --- | --- |
| Producer adapter | `B65585B023FA6A6A1AD2BBD0CD221637B0B34B60622814251B7928A5C16E0503` |
| Producer receipt | `C6D800C111AC39DDBFF128AC53BAEA60213FE2CA12503766882A91984F6E7E4E` |
| Producer input fingerprint | `1139706DEB7A7E0429F0C81A7DF7AA3E13EA2CC27A2EECF60E8A01396AE7182D` |
| Formal-source digest | `21A46DBD787090FC18C24CB4E29EBE1DD743203D31ABEDA43B3CE421833B596C` |

The independent replay result is:

- `status=FAIL_CLOSED` and `formal_ready=false`;
- `issues=[]` and `failed_tasks=[]`;
- 85 expected, 85 receipts, and 85 independently verified tasks;
- zero missing, extra, failed/invalid, or truncated tasks/games;
- 8,320 raw game records replayed and 4,160 paired-color units;
- 4,321 unique full color-aware trajectories;
- 4,214 unique full sequences ignoring color;
- 4,198 unique continuations ignoring opening and color;
- 85 task audits, 17 comparison rows, and 17 read-only bindings verified.

### Gate accounting

Exactly 24 of 25 verifier gates are true. The only false gate is
`unique_trajectory_thresholds_met`. The canonical integrity subset is 3/3:

- `canonical_derivation_receipt_bound=true`;
- `canonical_hash_verified=true`;
- `canonical_numeric_match=true`.

An independent task-level threshold recomputation finds that 22 of 45 D18
tasks do not satisfy the diversity criteria: 15/15 at size 5, 5/15 at size 7,
and 2/15 at size 9. Those 22 criteria misses roll up to the single false
bundle-level verifier gate; they are not 22 verifier gates and are not entries
in `failed_tasks`.

## Verifier input closure

The independent report snapshots 337 verifier inputs and confirms the input
snapshot was unchanged after verification:

| Closure field | Value |
| --- | --- |
| Input count | 337 |
| Content-set SHA-256 | `5D51D7E95B2AA4A50CD09E42AC4271EF7E91F5ED09DF042ABE1084112F3EFCC7` |
| Complete fingerprint SHA-256 | `B893045B856F62C949A5B87C57AF58235E9797479D70417C805044D9D27DB720` |
| Unchanged after verification | `true` |

The content-set digest binds stable relative roles, sizes, and content hashes.
The complete fingerprint additionally binds local filesystem identities. Raw
allowlisted roots, per-file identity rows, host paths, and local execution
identifiers are intentionally excluded from this public-safe receipt.

## Final boundaries

- `canonical_integrity_closed=true`
- `scientific_gate_passed=false`
- `formal_ready=false`
- `submission_ready=false`
- `d19_open=false`
- `external_action_performed=false`

The full formal result and independent report remain local and ignored. This
compact hash receipt does not add those trees to Git or approve them for an
anonymous supplement.
