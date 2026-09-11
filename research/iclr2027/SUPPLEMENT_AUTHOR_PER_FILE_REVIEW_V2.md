# Exact per-file supplement author review sheet V2

## Status and privacy boundary

Status: **REVIEW TEMPLATE / ALL DECISIONS OPEN / NOT APPROVED**.

This sheet defines the append-only V2 review surface for a future
subject-bound claim-complete supplement. It does not prove that a candidate or
archive exists, that any private identity list is complete, that anonymity has
been reviewed, or that release or submission is approved. The earlier
120-payload/124-member topology and every earlier candidate remain unchanged.

Do not place author names, identifying initials, private identity variants,
affiliations, host labels, usernames, signatures, or absolute paths in this
tracked sheet. Authors must complete a private local copy against the exact
future production candidate. The private identity list remains untracked and
must never be copied, counted, or fingerprinted here.

## Policy snapshot

| Binding | Value |
| --- | --- |
| V2 claim profile | `research/iclr2027/supplement_tools/claim_complete_profile_v2.json` |
| V2 claim-profile SHA-256 | `0078709448adcf458bbe1bffa093f75641406dd9a32cf32e783cf8df1b680751` |
| V2 allowlist | `research/iclr2027/supplement_tools/supplement_claim_complete_allowlist_v2.json` |
| V2 allowlist SHA-256 | `388b82d79ee57d6e6f380ee59d11ea53899f88a9ce9a480f88e25b963eb553d5` |
| Frozen V1 profile SHA-256 | `d14c30a4d7946d225f120d0d6f7f5856ab2de7575809e5e4c5b066e487132b1c` |
| Frozen V1 allowlist SHA-256 | `ca2977716d2f6d772e7e8c8701589b88c58bae60dfe33477add24d5659c7ce3a` |
| Claim IDs | `C1` through `C10` |
| Status / approval | `candidate_only_not_approved` / `author_approval_required` |
| Allowlisted payload rows | 130 |
| Direct-copy / derived rows | 118 / 12 |
| Generated control files | 4 |
| Expected archive members | 134 regular files under one fixed root |

The V2 profile and allowlist retain all 120 V1 identity triples and add nine
direct-copy rows plus one derived ASCII history-twin witness. A local static
check found 130 unique profile identities, 130 unique allowlist identities, an
exact profile/allowlist identity match,
exactly one permitted null hash for
`ANONYMIZATION_DERIVATION.json`, and zero hash mismatches across all 118
current direct-copy source files. The project loaders accepted both V2 files.

Those checks bind only the currently observed worktree bytes. They are not a
clean subject-commit/tree receipt. The V2 files and their ten new inputs must
first enter one reviewed clean subject commit before derive/build/verify can
produce production evidence. The existing fresh-install contract is V1-scoped
and does not validate this V2 topology.

## V2-only append

| Candidate path | Category | Worktree-observed SHA-256 | Decision |
| --- | --- | --- | --- |
| `research/iclr2027/results/validation/history_superko_n6_strict_pair_candidate_v1.json` | `validation_evidence` | `5796d643b9f6ed8716983ec3234b2398c7b50d221e2a16ebb9682ba1fb6479f5` | OPEN |
| `research/iclr2027/results/validation/history_superko_n6_strict_pair_verification_v1.json` | `validation_evidence` | `ef209d84f7906b1858e9954415cd5971af1f6d2ee878a811be27ef78b4ad41a1` | OPEN |
| `research/iclr2027/results/validation/targeted_history_twin_n6_stage5_search_25k_v1.json` | `validation_evidence` | `4b87962daffb9aa44b2c67541ef420c8c1574c8e4d6820afe518632bc10cf9e5` | OPEN |
| `research/iclr2027/results/validation/targeted_history_twin_n6_stage5_verification_v1.json` | `validation_evidence` | `555a97f4da22ec1072afd0c9b39b2269da9a2dd30412528ef114013eb6fa1b1f` | OPEN |
| `research/iclr2027/scripts/search_targeted_history_twin.py` | `reproducibility_runner` | `b7c8e87169d5b573136ffb276b4b747339b9b4009d72a9eb427b863af163b052` | OPEN |
| `research/iclr2027/scripts/verify_targeted_history_twin.py` | `independent_verifier` | `6ffdf25842481e419c36eb2f067020bef88de586220c71f8f24659885cd3dd8c` | OPEN |
| `research/iclr2027/scripts/verify_targeted_history_twin_web.mjs` | `independent_verifier` | `87f5a0db7c3dc6e4e4b4224feeeb0387df99d344e31a30f06f1b239ff9d54795` | OPEN |
| `web/history_twin_web_witness.mjs` | `independent_reference` | `a9356765aa5f9938aed14ef9b7409c2e2e501e2f69f4d6d855f13c481e2b7fb2` | OPEN |
| `research/iclr2027/scripts/run_history_twin_candidate_verifiers.py` | `independent_verifier` | `d8f2e8cc9a01bf3f411e5e3eb9ebf12d773925e34692af844ed23a2d528b7bfd` | OPEN |
| `research/iclr2027/tests/test_targeted_history_twin.py` | `targeted_test` | `dd32968c390c9427ef817c7556ed0163bca122af8ed50a6433a1e3a9b4816377` | OPEN |

Scientific scope for these ten rows is narrow: two natural side-6 histories
reach the same mask-free topology while Superko changes legality of one shared
candidate action. The implemented legal masks differ, so the implemented
mask-bearing observations are not equal. This evidence does not establish a
same-observation/mask future-correct-decision pair, a different optimal action,
a learning-performance effect, TopologyHistory necessity or superiority, a
same-backbone ablation, a shortest witness, or an exhaustive search result.

## Production binding to fill before review

| Field | Value | Decision |
| --- | --- | --- |
| Internal subject commit, private local review only | OPEN | OPEN |
| Internal subject tree, private local review only | OPEN | OPEN |
| V2 profile and allowlist tracked with exact bytes above | OPEN | OPEN |
| Candidate directory basename | OPEN | OPEN |
| `SHA256_MANIFEST.json` SHA-256 | OPEN | OPEN |
| `CANDIDATE_TREE.txt` SHA-256 | OPEN | OPEN |
| `PRIVACY_SCAN.json` SHA-256 | OPEN | OPEN |
| Candidate tree SHA-256 | OPEN | OPEN |
| Archive SHA-256 | OPEN | OPEN |
| `ARCHIVE_RECEIPT.json` SHA-256 | OPEN | OPEN |
| `EXTRACTION_RECEIPT.json` SHA-256 | OPEN | OPEN |
| Complete private identity input supplied and author-reviewed | OPEN | OPEN |
| Subject binding independently verified | OPEN | OPEN |
| Final archive independently verify-extracted | OPEN | OPEN |

Any source, destination, category, mode, hash, subject, profile, allowlist, or
identity-input change invalidates approvals and requires a new review.

## Exact 130-payload review

For direct copies, `<subject-bound commit blob>` is a required future
production binding, not a hash exemption. The allowlist output hash must also
match the indexed and worktree bytes of the clean subject commit. Derived rows
must satisfy their fixed transformation contracts. The sole null output hash
is the cycle-broken derivation receipt and must be filled from the same
production manifest after deterministic double derivation.

| # | Decision | Candidate destination | Category / mode | Build source | Profile-bound input(s) | Expected output SHA-256 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | OPEN | `research/iclr2027/lifeline_rl/__init__.py` | `reference_implementation` / `copy` | `research/iclr2027/lifeline_rl/__init__.py` | `research/iclr2027/lifeline_rl/__init__.py` / `<subject-bound commit blob>` | `6e40ede87432a3b4258d0f31a9bbe87c92bb668885cc5c020e420c1388f47592` |
| 2 | OPEN | `research/iclr2027/lifeline_rl/agents/__init__.py` | `reference_implementation` / `copy` | `research/iclr2027/lifeline_rl/agents/__init__.py` | `research/iclr2027/lifeline_rl/agents/__init__.py` / `<subject-bound commit blob>` | `19018efcaba773b02152d92657893745d0a8a0b59684cb5333603e7f6fefe892` |
| 3 | OPEN | `research/iclr2027/lifeline_rl/agents/base.py` | `reference_implementation` / `copy` | `research/iclr2027/lifeline_rl/agents/base.py` | `research/iclr2027/lifeline_rl/agents/base.py` / `<subject-bound commit blob>` | `1ddec90c62491f747fdb670d042b60a99f7559487afdfc42e468f16990fd8b6c` |
| 4 | OPEN | `research/iclr2027/lifeline_rl/agents/cycle_seeking.py` | `reference_implementation` / `copy` | `research/iclr2027/lifeline_rl/agents/cycle_seeking.py` | `research/iclr2027/lifeline_rl/agents/cycle_seeking.py` / `<subject-bound commit blob>` | `1a227ccb1cce0bfe1a78dcc99baf6df05f0697fcf9f5fee12841bc3c661e552d` |
| 5 | OPEN | `research/iclr2027/lifeline_rl/agents/factory.py` | `reference_implementation` / `copy` | `research/iclr2027/lifeline_rl/agents/factory.py` | `research/iclr2027/lifeline_rl/agents/factory.py` / `<subject-bound commit blob>` | `737be45b442b17cf9d76c1f6223ed0c6e0dd059aebeaa3a25793a5f5d7d63481` |
| 6 | OPEN | `research/iclr2027/lifeline_rl/agents/greedy.py` | `reference_implementation` / `copy` | `research/iclr2027/lifeline_rl/agents/greedy.py` | `research/iclr2027/lifeline_rl/agents/greedy.py` / `<subject-bound commit blob>` | `6c7cd96cc96a7c4789ff0f78a08f40ba92ec4a5e7199f125978fd3c3483ba622` |
| 7 | OPEN | `research/iclr2027/lifeline_rl/agents/heuristic.py` | `reference_implementation` / `copy` | `research/iclr2027/lifeline_rl/agents/heuristic.py` | `research/iclr2027/lifeline_rl/agents/heuristic.py` / `<subject-bound commit blob>` | `f5a90d1989fa1d2466e9908e905026867fe1b3b9afd8f5027a17f466dc807a0c` |
| 8 | OPEN | `research/iclr2027/lifeline_rl/agents/mcts.py` | `reference_implementation` / `copy` | `research/iclr2027/lifeline_rl/agents/mcts.py` | `research/iclr2027/lifeline_rl/agents/mcts.py` / `<subject-bound commit blob>` | `0ab01dae6a796b00c61748a30670c2e6195b14f8edd02152fa1f6ffb4998acaf` |
| 9 | OPEN | `research/iclr2027/lifeline_rl/agents/minimax.py` | `reference_implementation` / `copy` | `research/iclr2027/lifeline_rl/agents/minimax.py` | `research/iclr2027/lifeline_rl/agents/minimax.py` / `<subject-bound commit blob>` | `4c905517cce420aa6b678975f208c370b02f252e4d39caa07d456ab164babb68` |
| 10 | OPEN | `research/iclr2027/lifeline_rl/agents/random_agent.py` | `reference_implementation` / `copy` | `research/iclr2027/lifeline_rl/agents/random_agent.py` | `research/iclr2027/lifeline_rl/agents/random_agent.py` / `<subject-bound commit blob>` | `416b7c94bc8cd989165a18543cefab03810561ae243958a4f42946305d3d628a` |
| 11 | OPEN | `research/iclr2027/lifeline_rl/alphazero/__init__.py` | `reference_implementation` / `copy` | `research/iclr2027/lifeline_rl/alphazero/__init__.py` | `research/iclr2027/lifeline_rl/alphazero/__init__.py` / `<subject-bound commit blob>` | `9e39d68620b6e914770f94faf3a3a803253530e824d1c50d76cf01e160c1cdea` |
| 12 | OPEN | `research/iclr2027/lifeline_rl/alphazero/checkpoint.py` | `reference_implementation` / `copy` | `research/iclr2027/lifeline_rl/alphazero/checkpoint.py` | `research/iclr2027/lifeline_rl/alphazero/checkpoint.py` / `<subject-bound commit blob>` | `ae296c577a1f08f1477dd2e2b6dbc699de1757923cf616ba89ae13ce9713a601` |
| 13 | OPEN | `research/iclr2027/lifeline_rl/alphazero/config.py` | `reference_implementation` / `copy` | `research/iclr2027/lifeline_rl/alphazero/config.py` | `research/iclr2027/lifeline_rl/alphazero/config.py` / `<subject-bound commit blob>` | `8b7657f77d1ba20f502b888ae52844af799e9dd863daf6c95eeb24c4fd2fd0f3` |
| 14 | OPEN | `research/iclr2027/lifeline_rl/alphazero/evaluation.py` | `reference_implementation` / `copy` | `research/iclr2027/lifeline_rl/alphazero/evaluation.py` | `research/iclr2027/lifeline_rl/alphazero/evaluation.py` / `<subject-bound commit blob>` | `c2a9e3afaeac0803c15e71d04a86526194f4d84ebc7f68649525b8bb2b07c225` |
| 15 | OPEN | `research/iclr2027/lifeline_rl/alphazero/learning_health.py` | `reference_implementation` / `copy` | `research/iclr2027/lifeline_rl/alphazero/learning_health.py` | `research/iclr2027/lifeline_rl/alphazero/learning_health.py` / `<subject-bound commit blob>` | `fb65f691aeb50f4f22294f36686a8ba25fe632a6588f19f16bb7b0187798b794` |
| 16 | OPEN | `research/iclr2027/lifeline_rl/alphazero/network.py` | `reference_implementation` / `copy` | `research/iclr2027/lifeline_rl/alphazero/network.py` | `research/iclr2027/lifeline_rl/alphazero/network.py` / `<subject-bound commit blob>` | `02d92f165ff445aa9e92266933d5ed83fe04c19d3201fcde6803705762c41f09` |
| 17 | OPEN | `research/iclr2027/lifeline_rl/alphazero/neural_agent.py` | `reference_implementation` / `copy` | `research/iclr2027/lifeline_rl/alphazero/neural_agent.py` | `research/iclr2027/lifeline_rl/alphazero/neural_agent.py` / `<subject-bound commit blob>` | `b75890109bd7b0a60948a5d63bf5e180048a6100a4e48a08ee1bd850736c200d` |
| 18 | OPEN | `research/iclr2027/lifeline_rl/alphazero/puct.py` | `reference_implementation` / `copy` | `research/iclr2027/lifeline_rl/alphazero/puct.py` | `research/iclr2027/lifeline_rl/alphazero/puct.py` / `<subject-bound commit blob>` | `8609060212d517dd98a5567aabd6e26f016e0524ce392641abcdc5c6e1a3f979` |
| 19 | OPEN | `research/iclr2027/lifeline_rl/alphazero/replay.py` | `reference_implementation` / `copy` | `research/iclr2027/lifeline_rl/alphazero/replay.py` | `research/iclr2027/lifeline_rl/alphazero/replay.py` / `<subject-bound commit blob>` | `c8dcd0cb744daf43715b95a8ce70a613ba03a411a38442a628956d6607c28bdf` |
| 20 | OPEN | `research/iclr2027/lifeline_rl/alphazero/self_play.py` | `reference_implementation` / `copy` | `research/iclr2027/lifeline_rl/alphazero/self_play.py` | `research/iclr2027/lifeline_rl/alphazero/self_play.py` / `<subject-bound commit blob>` | `b0c910488a7e0cd54f4b06cf222e0626bbd768af25fa8592623f08b98cf56f9a` |
| 21 | OPEN | `research/iclr2027/lifeline_rl/alphazero/trainer.py` | `reference_implementation` / `copy` | `research/iclr2027/lifeline_rl/alphazero/trainer.py` | `research/iclr2027/lifeline_rl/alphazero/trainer.py` / `<subject-bound commit blob>` | `d9782ead5b7ef31c40a4ab6d233ecebf08e82f56f599f161b5fd56e75d7b3c54` |
| 22 | OPEN | `research/iclr2027/lifeline_rl/arena.py` | `reference_implementation` / `copy` | `research/iclr2027/lifeline_rl/arena.py` | `research/iclr2027/lifeline_rl/arena.py` / `<subject-bound commit blob>` | `a613574baee606c2ed87de9eb0408dc61356b9ee2d41ed7a6f5b099d22ae9599` |
| 23 | OPEN | `research/iclr2027/lifeline_rl/core.py` | `reference_implementation` / `copy` | `research/iclr2027/lifeline_rl/core.py` | `research/iclr2027/lifeline_rl/core.py` / `<subject-bound commit blob>` | `a3219c931608ab76f466cf5278e6297ddfdf128b19d721a16fab895eb81e05e7` |
| 24 | OPEN | `research/iclr2027/lifeline_rl/encoding.py` | `reference_implementation` / `copy` | `research/iclr2027/lifeline_rl/encoding.py` | `research/iclr2027/lifeline_rl/encoding.py` / `<subject-bound commit blob>` | `b9a6a14cb627853936333968c8e931d7622b56ad6f0c48251b5e658d5494c33d` |
| 25 | OPEN | `research/iclr2027/lifeline_rl/env.py` | `reference_implementation` / `copy` | `research/iclr2027/lifeline_rl/env.py` | `research/iclr2027/lifeline_rl/env.py` / `<subject-bound commit blob>` | `b6b1d53b49057995a9b37bf1d87fd19fda15c68253fbaf9e2d8c6b032c6da03c` |
| 26 | OPEN | `research/iclr2027/pyproject.toml` | `package_config` / `copy` | `research/iclr2027/pyproject.toml` | `research/iclr2027/pyproject.toml` / `<subject-bound commit blob>` | `03b9e027be0bc9c6618175d5a1f36d074fa250f4747cc0d51bdeda9f126d8839` |
| 27 | OPEN | `research/iclr2027/requirements-d14-d16-win-cu118.lock.txt` | `environment_lock` / `copy` | `research/iclr2027/requirements-d14-d16-win-cu118.lock.txt` | `research/iclr2027/requirements-d14-d16-win-cu118.lock.txt` / `<subject-bound commit blob>` | `380cab994906a45f60fba3a4c00f818f3724070666dfeef737f3f5a0e1a5d272` |
| 28 | OPEN | `research/iclr2027/scripts/check_reference_parity.py` | `reproducibility_runner` / `copy` | `research/iclr2027/scripts/check_reference_parity.py` | `research/iclr2027/scripts/check_reference_parity.py` / `<subject-bound commit blob>` | `2e986b3b3f1394c8a862ada264a42143892b4ca2bb342b5a6325ba0aa84c2ef5` |
| 29 | OPEN | `research/iclr2027/scripts/search_state_aliasing.py` | `reproducibility_runner` / `copy` | `research/iclr2027/scripts/search_state_aliasing.py` | `research/iclr2027/scripts/search_state_aliasing.py` / `<subject-bound commit blob>` | `c95d772e0d2aa826b58839e4b7509d173161258630a197bdf7b839266d7c81df` |
| 30 | OPEN | `research/iclr2027/scripts/validate_or_search_superko.py` | `reproducibility_runner` / `copy` | `research/iclr2027/scripts/validate_or_search_superko.py` | `research/iclr2027/scripts/validate_or_search_superko.py` / `<subject-bound commit blob>` | `edb95d30f2bda58f2cb87d21b728854690fc4e49e71ce002a2f2bcd89e5199c8` |
| 31 | OPEN | `research/iclr2027/scripts/d6_redteam_exact_audit.py` | `reproducibility_runner` / `copy` | `research/iclr2027/scripts/d6_redteam_exact_audit.py` | `research/iclr2027/scripts/d6_redteam_exact_audit.py` / `<subject-bound commit blob>` | `66d44b914c1d9d33a41bcf16f9329be9342ac4773b95d2f81ebfedf84b9b18d0` |
| 32 | OPEN | `research/iclr2027/scripts/run_superko_ablation.py` | `reproducibility_runner` / `copy` | `research/iclr2027/scripts/run_superko_ablation.py` | `research/iclr2027/scripts/run_superko_ablation.py` / `<subject-bound commit blob>` | `38fd1d436f7ab9c416bd540c09969bc99646bc16a051d292d855e02916ac162f` |
| 33 | OPEN | `research/iclr2027/scripts/run_superko_policy_matrix.py` | `reproducibility_runner` / `copy` | `research/iclr2027/scripts/run_superko_policy_matrix.py` | `research/iclr2027/scripts/run_superko_policy_matrix.py` / `<subject-bound commit blob>` | `249ce4e63ba511d2d7cd29ba89c0b4f6dd91375cc175a4ef7cc45da56292eed4` |
| 34 | OPEN | `research/iclr2027/scripts/verify_superko_policy_matrix.py` | `reproducibility_runner` / `copy` | `research/iclr2027/scripts/verify_superko_policy_matrix.py` | `research/iclr2027/scripts/verify_superko_policy_matrix.py` / `<subject-bound commit blob>` | `0c7bb0fe56a4c1e65115633e608e5b59ab100bc792c5d467373d43193a58c1e2` |
| 35 | OPEN | `research/iclr2027/scripts/d14_d16_experiments.py` | `reproducibility_runner` / `copy` | `research/iclr2027/scripts/d14_d16_experiments.py` | `research/iclr2027/scripts/d14_d16_experiments.py` / `<subject-bound commit blob>` | `1b4ca0a7f9115df4b4ecf95fa326425ce77caf6cf57e6a12c26625e279d2145d` |
| 36 | OPEN | `research/iclr2027/scripts/run_d14_d16_task_bundle.py` | `reproducibility_runner` / `copy` | `research/iclr2027/scripts/run_d14_d16_task_bundle.py` | `research/iclr2027/scripts/run_d14_d16_task_bundle.py` / `<subject-bound commit blob>` | `55c077c3fe08f7d3527be3950fb4e70b54a743130acaa911da8949f37ec59937` |
| 37 | OPEN | `research/iclr2027/scripts/train_alphazero.py` | `reproducibility_runner` / `copy` | `research/iclr2027/scripts/train_alphazero.py` | `research/iclr2027/scripts/train_alphazero.py` / `<subject-bound commit blob>` | `4fccf4addf91b8a9a517e94896e294b6b3917f7dc893c234222fe7898dddcb26` |
| 38 | OPEN | `research/iclr2027/scripts/verify_d14_d16_environment.py` | `reproducibility_runner` / `copy` | `research/iclr2027/scripts/verify_d14_d16_environment.py` | `research/iclr2027/scripts/verify_d14_d16_environment.py` / `<subject-bound commit blob>` | `4600be6f89abd868388c50a248fe4a503f29747078f571979f43329917e96901` |
| 39 | OPEN | `research/iclr2027/scripts/run_neural_arena.py` | `reproducibility_runner` / `copy` | `research/iclr2027/scripts/run_neural_arena.py` | `research/iclr2027/scripts/run_neural_arena.py` / `<subject-bound commit blob>` | `1d82c61b8fa60f06c3006dea7b7ca1cb5dfa240f6c66e2535668da4144e3c2f5` |
| 40 | OPEN | `research/iclr2027/scripts/verify_neural_arena_results.py` | `reproducibility_runner` / `copy` | `research/iclr2027/scripts/verify_neural_arena_results.py` | `research/iclr2027/scripts/verify_neural_arena_results.py` / `<subject-bound commit blob>` | `f587beccf5800c18c691b6f34e689e27903a56814b11e9bf1cf5acd822b03e38` |
| 41 | OPEN | `research/iclr2027/tests/__init__.py` | `targeted_test` / `copy` | `research/iclr2027/tests/__init__.py` | `research/iclr2027/tests/__init__.py` / `<subject-bound commit blob>` | `e92117063636447c87b1f1b232faff3ed86c1bdb141d5989b948d6b260d541b6` |
| 42 | OPEN | `research/iclr2027/tests/test_agents.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_agents.py` | `research/iclr2027/tests/test_agents.py` / `<subject-bound commit blob>` | `cda817a1d4d5e21dcaf10c03c1b7ba4e564cd18e047896257cb5777424c0e7cb` |
| 43 | OPEN | `research/iclr2027/tests/test_arena.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_arena.py` | `research/iclr2027/tests/test_arena.py` / `<subject-bound commit blob>` | `6d44210e9c7cc1452d7b591059a6bb6e6c957e92ac137a72b87bab1cc6f85388` |
| 44 | OPEN | `research/iclr2027/tests/test_core.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_core.py` | `research/iclr2027/tests/test_core.py` / `<subject-bound commit blob>` | `8c43d5b4eb96ffdb7319fe5545ecd3eeadaeebc0b08681068a2b2e23fcefec11` |
| 45 | OPEN | `research/iclr2027/tests/test_cycle_seeking_agent.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_cycle_seeking_agent.py` | `research/iclr2027/tests/test_cycle_seeking_agent.py` / `<subject-bound commit blob>` | `631358f9ee62cdc1adb380fea3b1ab0bd968b304aa56bbef7d37c1ae41b206c9` |
| 46 | OPEN | `research/iclr2027/tests/test_env.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_env.py` | `research/iclr2027/tests/test_env.py` / `<subject-bound commit blob>` | `89e1ac59b4660d1caf8a9e00a6cf68d5b9d2e908d187a827a3b4a2feb785e4bd` |
| 47 | OPEN | `research/iclr2027/tests/test_serialization.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_serialization.py` | `research/iclr2027/tests/test_serialization.py` / `<subject-bound commit blob>` | `68221c20b3d1fab2bc4af897d13ebc42fa0e2b505d00afed2b697731d54f4d4f` |
| 48 | OPEN | `research/iclr2027/tests/test_validation.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_validation.py` | `research/iclr2027/tests/test_validation.py` / `<subject-bound commit blob>` | `1e403cb1fd15c1510a75a720235f1bfec43aebad7818d87e9c54c40b0dc4cd1d` |
| 49 | OPEN | `research/iclr2027/tests/test_search_baselines.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_search_baselines.py` | `research/iclr2027/tests/test_search_baselines.py` / `<subject-bound commit blob>` | `d409928cb9877d85e751637ab5b497128418bde4d8b453ba0683b7c52a2504df` |
| 50 | OPEN | `research/iclr2027/tests/test_d6_aliasing.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_d6_aliasing.py` | `research/iclr2027/tests/test_d6_aliasing.py` / `<subject-bound commit blob>` | `af35986ad7debc9b7d5fd2df0765bfe5fafdf43be035a197c9d6f22b4d797f07` |
| 51 | OPEN | `research/iclr2027/tests/test_alphazero_checkpoint.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_alphazero_checkpoint.py` | `research/iclr2027/tests/test_alphazero_checkpoint.py` / `<subject-bound commit blob>` | `240cf1d201156e8a082bbd09c079cd09c980669ad7e083a41856370a33df0cdb` |
| 52 | OPEN | `research/iclr2027/tests/test_alphazero_config.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_alphazero_config.py` | `research/iclr2027/tests/test_alphazero_config.py` / `<subject-bound commit blob>` | `9596c978cfb8f8309eec6d17a42b8a03261c5f7acd2efa61bf5ff0f7c3411cf6` |
| 53 | OPEN | `research/iclr2027/tests/test_alphazero_evaluation.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_alphazero_evaluation.py` | `research/iclr2027/tests/test_alphazero_evaluation.py` / `<subject-bound commit blob>` | `b89d1aad3df494a6c854502b9e017c0dce7f2dd45695e58bd0747b0baca05a99` |
| 54 | OPEN | `research/iclr2027/tests/test_alphazero_learning_health.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_alphazero_learning_health.py` | `research/iclr2027/tests/test_alphazero_learning_health.py` / `<subject-bound commit blob>` | `602f17c547ffe324df9d8af287585e26d543a6d5bf97edeab604988e802a7dfe` |
| 55 | OPEN | `research/iclr2027/tests/test_alphazero_model_families.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_alphazero_model_families.py` | `research/iclr2027/tests/test_alphazero_model_families.py` / `<subject-bound commit blob>` | `efbc5009666fb71e9d261a27599eeb4eae0cef6a142aee6cbee417804a9ab8e8` |
| 56 | OPEN | `research/iclr2027/tests/test_alphazero_network.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_alphazero_network.py` | `research/iclr2027/tests/test_alphazero_network.py` / `<subject-bound commit blob>` | `5c5a2d9f79a4ea2a049444ae76592a2abed1703271fd0b884d77f5ff1ff4f126` |
| 57 | OPEN | `research/iclr2027/tests/test_alphazero_neural_agent.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_alphazero_neural_agent.py` | `research/iclr2027/tests/test_alphazero_neural_agent.py` / `<subject-bound commit blob>` | `8e62415fc95bbe52854006c3d8071eef4e97872cf465a7443fe8c3ceda592f84` |
| 58 | OPEN | `research/iclr2027/tests/test_alphazero_puct.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_alphazero_puct.py` | `research/iclr2027/tests/test_alphazero_puct.py` / `<subject-bound commit blob>` | `4061b565c68ff8e44d00d3d3c4966b1bafa4ab5e191f7210d1f5248c9a54c89f` |
| 59 | OPEN | `research/iclr2027/tests/test_alphazero_replay.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_alphazero_replay.py` | `research/iclr2027/tests/test_alphazero_replay.py` / `<subject-bound commit blob>` | `2e85c0a58b06101c98627bb50e16f523cdd13f197aac87fd31c4ca00cbdd9c3d` |
| 60 | OPEN | `research/iclr2027/tests/test_alphazero_self_play.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_alphazero_self_play.py` | `research/iclr2027/tests/test_alphazero_self_play.py` / `<subject-bound commit blob>` | `8d3ff70267cf50706e6f7d252877d613972046aa95096aca2ec70a570fd76685` |
| 61 | OPEN | `research/iclr2027/tests/test_alphazero_trainer.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_alphazero_trainer.py` | `research/iclr2027/tests/test_alphazero_trainer.py` / `<subject-bound commit blob>` | `9af5437cbc71d1be0515407c75cc097386d6170cbddb9f30f77fc49f531ebad8` |
| 62 | OPEN | `research/iclr2027/tests/test_d14_d16_executor.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_d14_d16_executor.py` | `research/iclr2027/tests/test_d14_d16_executor.py` / `<subject-bound commit blob>` | `fb629544fa8b547096326a470bf772f15d9ad4e4782f08bc1cf8867275697021` |
| 63 | OPEN | `research/iclr2027/tests/test_d14_d16_experiment_protocol.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_d14_d16_experiment_protocol.py` | `research/iclr2027/tests/test_d14_d16_experiment_protocol.py` / `<subject-bound commit blob>` | `f289fb33fbeb387b2571cce6819d5a55128852c752907a8d5cc907473f97c6c8` |
| 64 | OPEN | `research/iclr2027/tests/test_superko_ablation.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_superko_ablation.py` | `research/iclr2027/tests/test_superko_ablation.py` / `<subject-bound commit blob>` | `1d0e83a929ecaaa45a441fc1d9c5a4e772c0abd755446092031c22ee241e3a16` |
| 65 | OPEN | `research/iclr2027/tests/test_superko_pilot.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_superko_pilot.py` | `research/iclr2027/tests/test_superko_pilot.py` / `<subject-bound commit blob>` | `0f4243d23903cb8b972aa0ec92a9a3ea902f0c578146c84dbd2e8fb8173c70ee` |
| 66 | OPEN | `research/iclr2027/tests/test_superko_policy_matrix.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_superko_policy_matrix.py` | `research/iclr2027/tests/test_superko_policy_matrix.py` / `<subject-bound commit blob>` | `d19458ad7d87c2365b7e84fd0eb097481c7a599e2322a259631fe7ececc3b7aa` |
| 67 | OPEN | `research/iclr2027/tests/test_verify_superko_policy_matrix.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_verify_superko_policy_matrix.py` | `research/iclr2027/tests/test_verify_superko_policy_matrix.py` / `<subject-bound commit blob>` | `c2489f9d7786fcd6d698a0681c80d88656ede96306c96f83f9b40bdde70f30e0` |
| 68 | OPEN | `research/iclr2027/tests/fixtures/aliasing_pair.json` | `test_fixture` / `copy` | `research/iclr2027/tests/fixtures/aliasing_pair.json` | `research/iclr2027/tests/fixtures/aliasing_pair.json` / `<subject-bound commit blob>` | `9551679f8b02eba12c9402792210ffe32f4fefb004a5de1d72ab72b375f02b4b` |
| 69 | OPEN | `research/iclr2027/D2_environment_status.md` | `claim_evidence_narrative` / `copy` | `research/iclr2027/D2_environment_status.md` | `research/iclr2027/D2_environment_status.md` / `<subject-bound commit blob>` | `5593c6241f4833ecd76fe63b96907bd2bef75c1b80610396af09eec54898df30` |
| 70 | OPEN | `research/iclr2027/D4_D5_validation_report.md` | `claim_evidence_narrative` / `copy` | `research/iclr2027/D4_D5_validation_report.md` | `research/iclr2027/D4_D5_validation_report.md` / `<subject-bound commit blob>` | `370e4e810836fb4c807c173bca53b160c553ec2bc1433674954d193b80294237` |
| 71 | OPEN | `research/iclr2027/D6_state_aliasing.md` | `claim_evidence_narrative` / `copy` | `research/iclr2027/D6_state_aliasing.md` | `research/iclr2027/D6_state_aliasing.md` / `<subject-bound commit blob>` | `1b88941ad0919e3845600bfd541bd879d15aae8cea7526c08d5a15944c6dc275` |
| 72 | OPEN | `research/iclr2027/d6_redteam_audit.md` | `claim_evidence_narrative` / `copy` | `research/iclr2027/d6_redteam_audit.md` | `research/iclr2027/d6_redteam_audit.md` / `<subject-bound commit blob>` | `a1a1420c7921c4507b52da408ca0b5094b9c1124d09b803113ffd91ed2537125` |
| 73 | OPEN | `research/iclr2027/D14_D16_RESULTS.md` | `claim_evidence_narrative` / `copy` | `research/iclr2027/D14_D16_RESULTS.md` | `research/iclr2027/D14_D16_RESULTS.md` / `<subject-bound commit blob>` | `2306adffaf32b52cce50037b1ff96edf866d1609a3fac2344aebc3c6a9d26ebe` |
| 74 | OPEN | `research/iclr2027/SUPERKO_ABLATION_PROTOCOL.md` | `claim_evidence_narrative` / `copy` | `research/iclr2027/SUPERKO_ABLATION_PROTOCOL.md` | `research/iclr2027/SUPERKO_ABLATION_PROTOCOL.md` / `<subject-bound commit blob>` | `1d5c5484dc77eeae614184f7889b5fbe10de259f2f19be662b0a4902830bd845` |
| 75 | OPEN | `research/iclr2027/SUPERKO_ABLATION_RESULTS.md` | `claim_evidence_narrative` / `copy` | `research/iclr2027/SUPERKO_ABLATION_RESULTS.md` | `research/iclr2027/SUPERKO_ABLATION_RESULTS.md` / `<subject-bound commit blob>` | `4dac096a6557de378e24def42cf5bdcf4c9cbe3dc905c4cb9cbf615c776b5146` |
| 76 | OPEN | `research/iclr2027/SUPERKO_POLICY_MATRIX_PROTOCOL.md` | `claim_evidence_narrative` / `copy` | `research/iclr2027/SUPERKO_POLICY_MATRIX_PROTOCOL.md` | `research/iclr2027/SUPERKO_POLICY_MATRIX_PROTOCOL.md` / `<subject-bound commit blob>` | `e3cd42c3574c5633b0a20955f00617bbb8403148df770141e53805b46054e026` |
| 77 | OPEN | `research/iclr2027/SUPERKO_POLICY_MATRIX_RESULTS.md` | `claim_evidence_narrative` / `copy` | `research/iclr2027/SUPERKO_POLICY_MATRIX_RESULTS.md` | `research/iclr2027/SUPERKO_POLICY_MATRIX_RESULTS.md` / `<subject-bound commit blob>` | `8d54ca1c5f139583516d582720fe2757ae9c45255659074d619f57edcb7daca3` |
| 78 | OPEN | `research/iclr2027/d6_redteam_exact_audit.json` | `validation_evidence` / `copy` | `research/iclr2027/d6_redteam_exact_audit.json` | `research/iclr2027/d6_redteam_exact_audit.json` / `<subject-bound commit blob>` | `e3fb3adc6cf2610e645663fc5122e9b6383344a954fc74cf33b2e2659ff97b34` |
| 79 | OPEN | `research/iclr2027/state_aliasing/pairs_v1.json` | `validation_evidence` / `copy` | `research/iclr2027/state_aliasing/pairs_v1.json` | `research/iclr2027/state_aliasing/pairs_v1.json` / `<subject-bound commit blob>` | `204068e8565097d1456cbd748ce4a3716e3e8ac9907523e9530850f7d40a2174` |
| 80 | OPEN | `research/iclr2027/state_aliasing/search_report_v1.json` | `validation_evidence` / `copy` | `research/iclr2027/state_aliasing/search_report_v1.json` | `research/iclr2027/state_aliasing/search_report_v1.json` / `<subject-bound commit blob>` | `e4ea56cc3d59faa385b44bf6112a06eb0005839bb837c3d266dd27a384903e34` |
| 81 | OPEN | `research/iclr2027/state_aliasing/superko_n6_witness_v1.json` | `validation_evidence` / `copy` | `research/iclr2027/state_aliasing/superko_n6_witness_v1.json` | `research/iclr2027/state_aliasing/superko_n6_witness_v1.json` / `<subject-bound commit blob>` | `a2916486d2a9c4738b1b8a01f72a91a689f968e20d1b6673b5e4f05a15927155` |
| 82 | OPEN | `research/iclr2027/results/validation/d6_random_n5_final.json` | `validation_evidence` / `copy` | `research/iclr2027/results/validation/d6_random_n5_final.json` | `research/iclr2027/results/validation/d6_random_n5_final.json` / `<subject-bound commit blob>` | `a03f3243aaea3dae5b87c25285814b46a0ae7d85857e28e761cade57aaa2b56a` |
| 83 | OPEN | `research/iclr2027/results/validation/d6_random_n6_final.json` | `validation_evidence` / `copy` | `research/iclr2027/results/validation/d6_random_n6_final.json` | `research/iclr2027/results/validation/d6_random_n6_final.json` / `<subject-bound commit blob>` | `ac5c6f46ad3f33aa2bdb8dff9c67fd9e9afcf86f038bacf911d97e8ea425e788` |
| 84 | OPEN | `research/iclr2027/results/validation/superko_exhaustive_n5_20260825.json` | `validation_evidence` / `copy` | `research/iclr2027/results/validation/superko_exhaustive_n5_20260825.json` | `research/iclr2027/results/validation/superko_exhaustive_n5_20260825.json` / `<subject-bound commit blob>` | `5918b039f7def6b200a256e0894daad343d2dbe6fcccf5679fc79b5a778b6de8` |
| 85 | OPEN | `research/iclr2027/results/validation/superko_random_n6_seed20260826.json` | `validation_evidence` / `copy` | `research/iclr2027/results/validation/superko_random_n6_seed20260826.json` | `research/iclr2027/results/validation/superko_random_n6_seed20260826.json` / `<subject-bound commit blob>` | `efb6bf27d35e8894d9f8c749c8c86765cbcf957060b55aa8456c006051a84ca0` |
| 86 | OPEN | `research/iclr2027/results/validation/superko_random_n7_seed20260826.json` | `validation_evidence` / `copy` | `research/iclr2027/results/validation/superko_random_n7_seed20260826.json` | `research/iclr2027/results/validation/superko_random_n7_seed20260826.json` / `<subject-bound commit blob>` | `a3fe7a94f508da8931126c8842ddc425acb90079c3b918d91cf62e1f08a20db0` |
| 87 | OPEN | `research/iclr2027/results/validation/superko_policy_matrix_attempt2_link.json` | `validation_evidence` / `copy` | `research/iclr2027/results/validation/superko_policy_matrix_attempt2_link.json` | `research/iclr2027/results/validation/superko_policy_matrix_attempt2_link.json` / `<subject-bound commit blob>` | `02888c872bb438963745e07ee8a97ad98bc9677b9988b327a025da901718e381` |
| 88 | OPEN | `research/iclr2027/configs/d14_d16_formal_manifest.json` | `frozen_config` / `copy` | `research/iclr2027/configs/d14_d16_formal_manifest.json` | `research/iclr2027/configs/d14_d16_formal_manifest.json` / `<subject-bound commit blob>` | `9439c3b9b52ed13a8c489969dfbafddd59e75af2579274b7275258b693d8782f` |
| 89 | OPEN | `research/iclr2027/configs/d14_d16_parameter_counts.json` | `frozen_config` / `copy` | `research/iclr2027/configs/d14_d16_parameter_counts.json` | `research/iclr2027/configs/d14_d16_parameter_counts.json` / `<subject-bound commit blob>` | `4b55c2e45f27dec83b1cc51a03674232eaab693a63dbef38cf9f85c4c725cef9` |
| 90 | OPEN | `research/iclr2027/configs/seed_registry.json` | `frozen_config` / `copy` | `research/iclr2027/configs/seed_registry.json` | `research/iclr2027/configs/seed_registry.json` / `<subject-bound commit blob>` | `afaf0d6f17f0aaffaa1480dacec824a23deb937748a3cba9c5182926fde12247` |
| 91 | OPEN | `research/iclr2027/results/validation/d14_d16_independent_receipt_audit_20260831.json` | `independent_audit_receipt` / `copy` | `research/iclr2027/results/validation/d14_d16_independent_receipt_audit_20260831.json` | `research/iclr2027/results/validation/d14_d16_independent_receipt_audit_20260831.json` / `<subject-bound commit blob>` | `f64c8de1a2fca86cf7681a855edfb244033b318e65e14b2add64ede27e4ef648` |
| 92 | OPEN | `research/iclr2027/reviews/independent_receipt_audit.py` | `independent_audit_runner` / `copy` | `research/iclr2027/reviews/independent_receipt_audit.py` | `research/iclr2027/reviews/independent_receipt_audit.py` / `<subject-bound commit blob>` | `09b91f43c9feaf3f23d29b36328276800689c3c7581da5c554fce8497a02924e` |
| 93 | OPEN | `research/iclr2027/reviews/d14_d16_seed_pair_descriptive_audit.py` | `descriptive_audit_runner` / `copy` | `research/iclr2027/reviews/d14_d16_seed_pair_descriptive_audit.py` | `research/iclr2027/reviews/d14_d16_seed_pair_descriptive_audit.py` / `<subject-bound commit blob>` | `ce000497b7600972cd1aceed17a008e2c349d1d09493cf75a27dd619f65153d9` |
| 94 | OPEN | `research/iclr2027/reviews/d14_d16_seed_pair_descriptive_audit.json` | `descriptive_only_no_inference` / `copy` | `research/iclr2027/reviews/d14_d16_seed_pair_descriptive_audit.json` | `research/iclr2027/reviews/d14_d16_seed_pair_descriptive_audit.json` / `<subject-bound commit blob>` | `e8dbb1cbafc15de0c7b2879ca3697e8f21f3f8c6d84354715b75a5f4d078c7cd` |
| 95 | OPEN | `research/iclr2027/reviews/d14_d16_seed_pair_descriptive_audit.md` | `descriptive_only_no_inference` / `copy` | `research/iclr2027/reviews/d14_d16_seed_pair_descriptive_audit.md` | `research/iclr2027/reviews/d14_d16_seed_pair_descriptive_audit.md` / `<subject-bound commit blob>` | `73aab2c79c19402651170939c11819cbaf69a76d59af0d33ab82c9ec2202188f` |
| 96 | OPEN | `research/iclr2027/results/formal/d14_d16/aggregate_v1/aggregate.json` | `formal_aggregate` / `copy` | `research/iclr2027/results/formal/d14_d16/aggregate_v1/aggregate.json` | `research/iclr2027/results/formal/d14_d16/aggregate_v1/aggregate.json` / `<subject-bound commit blob>` | `59c264fc65d7b11357b0d718d38371df1ba44be4b92e7ef41ff995bf088f501c` |
| 97 | OPEN | `research/iclr2027/results/formal/d14_d16/aggregate_v1/arena_learning_curve.csv` | `formal_aggregate` / `copy` | `research/iclr2027/results/formal/d14_d16/aggregate_v1/arena_learning_curve.csv` | `research/iclr2027/results/formal/d14_d16/aggregate_v1/arena_learning_curve.csv` / `<subject-bound commit blob>` | `40f531f0f974f75cf8921499d209eb529bc2f99308390f8ce753f63047f5b616` |
| 98 | OPEN | `research/iclr2027/results/formal/d14_d16/aggregate_v1/final_vs_search.csv` | `formal_aggregate` / `copy` | `research/iclr2027/results/formal/d14_d16/aggregate_v1/final_vs_search.csv` | `research/iclr2027/results/formal/d14_d16/aggregate_v1/final_vs_search.csv` / `<subject-bound commit blob>` | `8fdcba541d8c62b9697be5bd17f512c76976e0acb4d1a6a3f8c785d3959b0fa8` |
| 99 | OPEN | `research/iclr2027/results/formal/d14_d16/aggregate_v1/representation_round_robin.csv` | `formal_aggregate` / `copy` | `research/iclr2027/results/formal/d14_d16/aggregate_v1/representation_round_robin.csv` | `research/iclr2027/results/formal/d14_d16/aggregate_v1/representation_round_robin.csv` / `<subject-bound commit blob>` | `b06659670c5bd199fcbefaa808398859ff220a4ce60cae9ddd47d04fa4f25fff` |
| 100 | OPEN | `research/iclr2027/results/formal/d14_d16/aggregate_v1/training_curve.csv` | `formal_aggregate` / `copy` | `research/iclr2027/results/formal/d14_d16/aggregate_v1/training_curve.csv` | `research/iclr2027/results/formal/d14_d16/aggregate_v1/training_curve.csv` / `<subject-bound commit blob>` | `af96f5a9cfb5fc1f343953d1ad2b1bbabff96f078f002e4ee2e57dc048b4fae0` |
| 101 | OPEN | `research/iclr2027/results/formal/d14_d16/task_bundle_v1/training_tasks.jsonl` | `formal_task_definition` / `copy` | `research/iclr2027/results/formal/d14_d16/task_bundle_v1/training_tasks.jsonl` | `research/iclr2027/results/formal/d14_d16/task_bundle_v1/training_tasks.jsonl` / `<subject-bound commit blob>` | `1457459c6fc910a4d083a0a9a24287c15805dfbaa881b71b3ee28ee96bca95e7` |
| 102 | OPEN | `research/iclr2027/results/formal/d14_d16/task_bundle_v1/evaluation_tasks.jsonl` | `formal_task_definition` / `copy` | `research/iclr2027/results/formal/d14_d16/task_bundle_v1/evaluation_tasks.jsonl` | `research/iclr2027/results/formal/d14_d16/task_bundle_v1/evaluation_tasks.jsonl` / `<subject-bound commit blob>` | `34929f8006605fc011f91394dd95402607540e8f4d06b12711464338bea1455c` |
| 103 | OPEN | `research/iclr2027/results/formal/d14_d16/task_bundle_v1/manifest_snapshot.json` | `formal_task_definition` / `copy` | `research/iclr2027/results/formal/d14_d16/task_bundle_v1/manifest_snapshot.json` | `research/iclr2027/results/formal/d14_d16/task_bundle_v1/manifest_snapshot.json` / `<subject-bound commit blob>` | `9439c3b9b52ed13a8c489969dfbafddd59e75af2579274b7275258b693d8782f` |
| 104 | OPEN | `research/iclr2027/configs/d14_d16_executor_smoke_manifest.json` | `engineering_test_config` / `copy` | `research/iclr2027/configs/d14_d16_executor_smoke_manifest.json` | `research/iclr2027/configs/d14_d16_executor_smoke_manifest.json` / `<subject-bound commit blob>` | `04b5a06902859e5ac51212a84998c2c1dbd271f16ac9d711056b2a8e2b23a4fb` |
| 105 | OPEN | `research/iclr2027/D14_D16_FRESH_INSTALL_PREFLIGHT.md` | `reproducibility_guide` / `copy` | `research/iclr2027/D14_D16_FRESH_INSTALL_PREFLIGHT.md` | `research/iclr2027/D14_D16_FRESH_INSTALL_PREFLIGHT.md` / `<subject-bound commit blob>` | `fac413f699eb0e221ca8bd11164da022aad93e495753075cce863d6a624eeb43` |
| 106 | OPEN | `research/iclr2027/scripts/d14_d16_fresh_install_preflight.py` | `reproducibility_runner` / `copy` | `research/iclr2027/scripts/d14_d16_fresh_install_preflight.py` | `research/iclr2027/scripts/d14_d16_fresh_install_preflight.py` / `<subject-bound commit blob>` | `b6307c20229ecfbe1976ede0775d0c4138676b22f1049ab4ba943125d727888f` |
| 107 | OPEN | `research/iclr2027/tests/test_d14_d16_fresh_install_preflight.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_d14_d16_fresh_install_preflight.py` | `research/iclr2027/tests/test_d14_d16_fresh_install_preflight.py` / `<subject-bound commit blob>` | `5a7ea5c0cad88691c05294a1b235ec22251c215faef52fcbf31871194c282f0d` |
| 108 | OPEN | `research/iclr2027/results/validation/d14_d16_execution_metadata_portable_20260831.json` | `environment_metadata` / `copy` | `research/iclr2027/results/validation/d14_d16_execution_metadata_portable_20260831.json` | `research/iclr2027/results/validation/d14_d16_execution_metadata_portable_20260831.json` / `<subject-bound commit blob>` | `2d953a5dccbd989b5e8d38e52b0f8c2a53bca33b65aa267d129ab2eff5293663` |
| 109 | OPEN | `research/iclr2027/tests/test_verify_d14_d16_environment.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_verify_d14_d16_environment.py` | `research/iclr2027/tests/test_verify_d14_d16_environment.py` / `<subject-bound commit blob>` | `15c044d3f30a3742a75b066201a87461bf498d799f9bdf14a23b1a58b9e14652` |
| 110 | OPEN | `research/iclr2027/results/validation/history_superko_n6_strict_pair_candidate_v1.json` | `validation_evidence` / `copy` | `research/iclr2027/results/validation/history_superko_n6_strict_pair_candidate_v1.json` | `research/iclr2027/results/validation/history_superko_n6_strict_pair_candidate_v1.json` / `<subject-bound commit blob>` | `5796d643b9f6ed8716983ec3234b2398c7b50d221e2a16ebb9682ba1fb6479f5` |
| 111 | OPEN | `research/iclr2027/results/validation/history_superko_n6_strict_pair_verification_v1.json` | `validation_evidence` / `copy` | `research/iclr2027/results/validation/history_superko_n6_strict_pair_verification_v1.json` | `research/iclr2027/results/validation/history_superko_n6_strict_pair_verification_v1.json` / `<subject-bound commit blob>` | `ef209d84f7906b1858e9954415cd5971af1f6d2ee878a811be27ef78b4ad41a1` |
| 112 | OPEN | `research/iclr2027/results/validation/targeted_history_twin_n6_stage5_search_25k_v1.json` | `validation_evidence` / `copy` | `research/iclr2027/results/validation/targeted_history_twin_n6_stage5_search_25k_v1.json` | `research/iclr2027/results/validation/targeted_history_twin_n6_stage5_search_25k_v1.json` / `<subject-bound commit blob>` | `4b87962daffb9aa44b2c67541ef420c8c1574c8e4d6820afe518632bc10cf9e5` |
| 113 | OPEN | `research/iclr2027/results/validation/targeted_history_twin_n6_stage5_verification_v1.json` | `validation_evidence` / `copy` | `research/iclr2027/results/validation/targeted_history_twin_n6_stage5_verification_v1.json` | `research/iclr2027/results/validation/targeted_history_twin_n6_stage5_verification_v1.json` / `<subject-bound commit blob>` | `555a97f4da22ec1072afd0c9b39b2269da9a2dd30412528ef114013eb6fa1b1f` |
| 114 | OPEN | `research/iclr2027/scripts/search_targeted_history_twin.py` | `reproducibility_runner` / `copy` | `research/iclr2027/scripts/search_targeted_history_twin.py` | `research/iclr2027/scripts/search_targeted_history_twin.py` / `<subject-bound commit blob>` | `b7c8e87169d5b573136ffb276b4b747339b9b4009d72a9eb427b863af163b052` |
| 115 | OPEN | `research/iclr2027/scripts/verify_targeted_history_twin.py` | `independent_verifier` / `copy` | `research/iclr2027/scripts/verify_targeted_history_twin.py` | `research/iclr2027/scripts/verify_targeted_history_twin.py` / `<subject-bound commit blob>` | `6ffdf25842481e419c36eb2f067020bef88de586220c71f8f24659885cd3dd8c` |
| 116 | OPEN | `research/iclr2027/scripts/verify_targeted_history_twin_web.mjs` | `independent_verifier` / `copy` | `research/iclr2027/scripts/verify_targeted_history_twin_web.mjs` | `research/iclr2027/scripts/verify_targeted_history_twin_web.mjs` / `<subject-bound commit blob>` | `87f5a0db7c3dc6e4e4b4224feeeb0387df99d344e31a30f06f1b239ff9d54795` |
| 117 | OPEN | `web/history_twin_web_witness.mjs` | `independent_reference` / `history_twin_web_witness_copy` | `research/iclr2027/supplement_tools/derived_claim_complete/history_twin_web_witness.mjs` | `web/web前端/guide/interesting/verify-superko-history-divergence.mjs` / `a9356765aa5f9938aed14ef9b7409c2e2e501e2f69f4d6d855f13c481e2b7fb2` | `a9356765aa5f9938aed14ef9b7409c2e2e501e2f69f4d6d855f13c481e2b7fb2` |
| 118 | OPEN | `research/iclr2027/scripts/run_history_twin_candidate_verifiers.py` | `independent_verifier` / `copy` | `research/iclr2027/supplement_tools/run_history_twin_candidate_verifiers.py` | `research/iclr2027/supplement_tools/run_history_twin_candidate_verifiers.py` / `<subject-bound commit blob>` | `d8f2e8cc9a01bf3f411e5e3eb9ebf12d773925e34692af844ed23a2d528b7bfd` |
| 119 | OPEN | `research/iclr2027/tests/test_targeted_history_twin.py` | `targeted_test` / `copy` | `research/iclr2027/tests/test_targeted_history_twin.py` | `research/iclr2027/tests/test_targeted_history_twin.py` / `<subject-bound commit blob>` | `dd32968c390c9427ef817c7556ed0163bca122af8ed50a6433a1e3a9b4816377` |
| 120 | OPEN | `research/iclr2027/scripts/reference_trace.mjs` | `reproducibility_runner` / `reference_trace` | `research/iclr2027/supplement_tools/derived_claim_complete/reference_trace.mjs` | `research/iclr2027/scripts/reference_trace.mjs` / `7d0336ddb682c0d486dc988b71944a196b458e0f75f5c2c3333c2e3cf901b4a1` | `952ec6713e66d50c9254113997ad3682883a963622c60c0077fc16f9a97808c1` |
| 121 | OPEN | `web/GameEngine.js` | `independent_reference` / `game_engine_copy` | `research/iclr2027/supplement_tools/derived_claim_complete/GameEngine.js` | `web/web前端/GameEngine.js` / `48317759e700df1fceff97651bc1ba10ef07fa43eeddf081473b0c02aa03b173` | `48317759e700df1fceff97651bc1ba10ef07fa43eeddf081473b0c02aa03b173` |
| 122 | OPEN | `research/iclr2027/CLAIM_EVIDENCE_LIMITATION.admitted.json` | `admitted_claim_ledger` / `claim_ledger` | `research/iclr2027/supplement_tools/derived_claim_complete/CLAIM_EVIDENCE_LIMITATION.admitted.json` | `research/iclr2027/CLAIM_EVIDENCE_LIMITATION.md` / `11f34debb6c865cc52067149b5beba43ec04de1296b89f4575d00233917d6be7` | `75a3a3fd7f60486942e3654f50d8e1d68c87c971397a1ed7c863fa804a472f60` |
| 123 | OPEN | `research/iclr2027/D14_D16_EXPERIMENT_PROTOCOL.anonymized.md` | `frozen_protocol_derivative` / `d14_protocol` | `research/iclr2027/supplement_tools/derived_claim_complete/D14_D16_EXPERIMENT_PROTOCOL.anonymized.md` | `research/iclr2027/D14_D16_EXPERIMENT_PROTOCOL.md` / `aa6b361e07efaf85844281aa8d8839abd2ae667bb52816ec77ade39a80ff8850` | `382606f87e77ef317dc84561314eeeaf0b11e89af48caace22f8894b3a8b922e` |
| 124 | OPEN | `research/iclr2027/results/compact/d14_d16/d14_d16_compact_receipts.jsonl` | `compact_receipt_ledger` / `compact_ledger` | `research/iclr2027/supplement_tools/derived_claim_complete/d14_d16_compact_receipts.jsonl` | `research/iclr2027/results/formal/d14_d16/run_v1/result_receipts.jsonl` / `ff3ef8bfd9b7a443bc42ba16ab9d4daa9f855a5d0432d58a62322686247b8114` | `f6276b30a3078ec95ebed100da57ff5c62c3e8b6e5f94cb6d9b19dee7bdff0db` |
| 125 | OPEN | `research/iclr2027/results/compact/d14_d16/d14_d16_ledger_status.anonymized.json` | `compact_receipt_status` / `ledger_status` | `research/iclr2027/supplement_tools/derived_claim_complete/d14_d16_ledger_status.anonymized.json` | `research/iclr2027/results/formal/d14_d16/run_v1/result_ledger_status.json` / `4fafef3e26d3a8d8b544ef6a40d8a8a21e73efb6177b748f3f44e777d2d7d898` | `33f33013627917c39729b43d2d5bab76258043a0f1b9fd51690a8319237cc45d` |
| 126 | OPEN | `research/iclr2027/configs/superko_policy_matrix_v1_attempt2.anonymized.json` | `frozen_config_derivative` / `superko_config` | `research/iclr2027/supplement_tools/derived_claim_complete/superko_policy_matrix_v1_attempt2.anonymized.json` | `research/iclr2027/configs/superko_policy_matrix_v1_attempt2_manifest.json` / `d7df1541145e30401d299dd3bb59980195d6081a6eb6774473c48165dff0419b` | `b6f587ad83578c94ce1a01365c1b05c9ed549e20fbcb91052ff4aaa945ae386d` |
| 127 | OPEN | `research/iclr2027/results/validation/superko_policy_matrix_attempt2_verification.anonymized.json` | `verifier_receipt_derivative` / `superko_verification` | `research/iclr2027/supplement_tools/derived_claim_complete/superko_policy_matrix_attempt2_verification.anonymized.json` | `research/iclr2027/results/validation/superko_policy_matrix_five_seed_v1_attempt2_verification.json` / `1a24d6bf21c11046fd004b1ac4fc0f667495a842395d2b2805763d14b9feca01` | `839931a8d23a5cce3ef645acfd1cb6ec128b99d7fc14171939b2af3f6bc97075` |
| 128 | OPEN | `research/iclr2027/results/validation/d14_d16_environment_verification.anonymized.json` | `environment_receipt_derivative` / `environment_receipt` | `research/iclr2027/supplement_tools/derived_claim_complete/d14_d16_environment_verification.anonymized.json` | `research/iclr2027/results/validation/d14_d16_environment_verification_20260831_v2.json` / `af9ff287c4522f61fb714f70e20392af6185e70db4a00335447c62ef5076868a` | `c9d575e62224e2238e18490947123948bf1c84ecf0e266407391d2510148bc29` |
| 129 | OPEN | `research/iclr2027/D14_D16_TERMINOLOGY_ERRATUM.anonymized.md` | `claim_boundary_derivative` / `terminology_erratum` | `research/iclr2027/supplement_tools/derived_claim_complete/D14_D16_TERMINOLOGY_ERRATUM.anonymized.md` | `research/iclr2027/D14_D16_TERMINOLOGY_ERRATUM.md` / `275b303903a89c3c7697bc76a4e7d59e93325b281334cd9f6072dfd14fddaf3e` | `62a54dea7efe73f0bacfa151fe68a5a92cef817020ab59ff2328f3a8b72eeed0` |
| 130 | OPEN | `research/iclr2027/results/validation/ANONYMIZATION_DERIVATION.json` | `transformation_receipt` / `derivation_receipt` | `research/iclr2027/supplement_tools/derived_claim_complete/ANONYMIZATION_DERIVATION.json` | <none; generated from bound workflow snapshot> | <fill from production candidate manifest> |

## Generated control-file review

These four generated files are archive members in addition to the 130
payloads. Record their exact hashes from the same production candidate.

| Decision | Candidate path | Actual SHA-256 | Required check |
| --- | --- | --- | --- |
| OPEN | `README.md` | OPEN | candidate-only wording, V2 scope, exact commands, and no approval claim |
| OPEN | `CANDIDATE_TREE.txt` | OPEN | exactly 134 regular-file members, sorted, one fixed root, no extra path |
| OPEN | `SHA256_MANIFEST.json` | OPEN | exact 130 payloads plus README/tree bindings; no private subject value or local path |
| OPEN | `PRIVACY_SCAN.json` | OPEN | fresh PASS with complete private identity input; no identity value, count, or fingerprint serialized |

## Archive and extraction review

| Decision | Artifact | Actual SHA-256 | Required check |
| --- | --- | --- | --- |
| OPEN | `lifeline_rl_claim_complete_candidate.zip` | OPEN | deterministic stored ZIP, fixed root, 134 members, exact candidate-tree equality |
| OPEN | `ARCHIVE_RECEIPT.json` | OPEN | candidate-only status, exact archive/tree bindings, `final_archive=false` until approval |
| OPEN | `EXTRACTION_RECEIPT.json` | OPEN | safe extraction and complete V2 verifier PASS using the same private identity input |

## External gates outside the archive topology

| Gate | Current disposition |
| --- | --- |
| V2 profile/allowlist schema, identity, and current direct-byte check | PASS, local static check only |
| Clean subject commit/tree binding for V2 | OPEN / NOT RUN |
| V2 candidate build and directory verification | OPEN / NOT RUN |
| Complete real private-identity scan | OPEN / NOT RUN |
| V2 archive build and independent verify-extract | OPEN / NOT RUN |
| Fresh clean-install reproduction | OPEN / NOT VERIFIED |
| D17/D18 scientific gate | FAIL_CLOSED |
| Same-observation/mask future-decision construct evidence | OPEN |
| Same-backbone compact-history ablation | OPEN |
| Submission readiness | NO |

## Final private author decision

| Gate | Decision |
| --- | --- |
| All 130 payload rows approved | OPEN |
| All four generated control files approved | OPEN |
| Complete private identity coverage approved | OPEN |
| Exact candidate, archive, and receipts approved | OPEN |
| No byte or binding changed after review | OPEN |
| Scientific limitations accepted as written | OPEN |
| Final anonymous supplement approval | OPEN |

The final decision remains **BLOCKED** while any cell is `OPEN` or
`REJECT`. A completed identity-bearing or signed copy must remain private
during blind review. A future public approval receipt must be separately
privacy-reviewed and bind only the exact approved public-safe hashes.
