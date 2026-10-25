# Portable multiplayer rules references

`multiplayer-r4-rules-v1.json` and `six-player-area-r4-v1.json` are compact,
deterministic regression fixtures from frozen Web r4 sources. The default test
suite consumes these files directly and requires no private reference directory.
They are not training data, arena results or device measurements.

The main fixture pins its source and generator hashes, has 41 scenarios and 294
checkpoints, and includes five complete replay documents. During generation,
all 14 two-/three-player scenarios were compared with the then-current 0.9.2
source before its replacement; every rule-state hash and complete replay
document matched. The supplemental fixture adds one six-player nonzero-area
scenario and eight checkpoints.

Run the complete focused check from the repository root:

```text
node --test --test-timeout=180000 wechat/minigame/tests/multiplayer-rules-codec.test.mjs
```

Reference regeneration is an explicit maintenance operation, never part of a
test or build:

```text
node wechat/minigame/tests/fixtures/generate-multiplayer-reference.mjs <frozen-r4-web-dir> <pre-migration-0.9.2-web-dir> <new-output.json>
```

Both input directories must contain the exact `GameEngine.js` and
`ReplayCodec.js` hashes recorded in the fixture. The generator rejects a wrong
source version and refuses to overwrite an existing output. Keep those original
inputs in a separate local archive if new reference generation is needed. The
current migrated `web/web前端` directory is **not** the old 0.9.2 source and must
not be passed as the legacy input.

The successful original invocation, performed before source replacement, was:

```text
node wechat/minigame/tests/fixtures/generate-multiplayer-reference.mjs local_artifacts/wechat-emotes-deploy-20261021/candidate-r4/frontend/web/web前端 web/web前端 wechat/minigame/tests/fixtures/multiplayer-r4-rules-v1.json
```

The supplemental witness was generated separately from the same frozen r4
sources. Its recorded deterministic procedure is: size 5, six players, BLACK
starts; choose `legal[(step * 17 + 11) % legal.length]`; stop at the first nonzero
discrete territory area, with a maximum of 48 actions. The first such state is
after seven moves, with BLACK area 4. It records its complete actions, initial
geometry, checkpoint hashes and replay commitments. Do not silently replace
either fixture when behavior changes; add a separately justified reference
version and review the resulting differences.
