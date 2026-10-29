# Contribution v4: bounded validation timing

Source checkout: `ea651f7f2d4bf4995541662fd0465da67da77a6d`.
The synthetic trajectories and generator remain local in `working/local_artifacts/contribution-v4-perf/`; they are not uploaded to the contribution inbox.

| Fixture | Board and outcome | Actions | Bytes | Local Windows Node | Server Node, reported by release operator |
| --- | --- | ---: | ---: | ---: | ---: |
| `root-payload.json` | 15×15 triangle; two human seats; root-v2 add twice; two final skips | 102 | 68,455 | 7.357 s, valid | 6.636 s, valid |
| `root-payload-180.json` | Same deterministic configuration; no legal moves remain and both players skip | 126 | 84,626 | 8.891 s, valid | 7.839 s, valid |

Both tests invoked `node web/tools/validate_contribution.mjs` with the exact synthetic JSON bytes on stdin and checked exit code 0 and `protocol_version: 4`. The local process had a 20-second timeout, matching the collector. Server timings were obtained by the release operator using the already deployed validator on synthetic input only, without writing the production inbox.

SHA-256:

- `root-payload.json`: `f16f4707511125030cdb13661b694ecf8f38c7120deb0401dcac030938ba7583`
- `root-payload-180.json`: `ea026b32520f50238c151ae3b539defb41fc5690b8e1a1d354ca797bfd892c9e`
- `web/tools/validate_contribution.mjs`: `e8dcfcb4cc61266cf54ee398082271e160762628f36088da19c24bf8c0e6e9e4`
- `web/tools/validate_contribution_v4.mjs`: `26e289ee2de886c1db01daaadc601c9d8b6301b1b480ba9048e4492d1c234220`
- `web/web前端/GameEngine.js`: `83663d85e2f5373d6818c467b82e2fc3c502cecb7a9c6136cf025a5927da9f0a`
- `web/web前端/ReplayCodec.js`: `144a93d35269a50271233df1f8c5e401431a6564b7a142fac9da6aecd21ae848`
- `web/web后端/training_contributions.py`: `0b721905758558d5080e7134c86b787795ab8fc43b78d525d06adf85642c5072`

These timings cover one deterministic game and do not establish a worst-case bound for every legal game, concurrent collector load, topology boards, or the 3,000-action protocol limit. An over-20-second validator run produces a retriable 503 and leaves the local outbox intact.
