# Independent posttraining output verification

After the supervisor and trainer report complete, run:

```text
node --unhandled-rejections=strict web/tools/verify-three-player-posttraining.mjs
```

The defaults inspect the bounded v2 run under
`local_artifacts/three-player-ai-posttrain-v2-20261021`. Optional arguments are
`--run-root`, `--config`, `--parent-model`, `--model`, and `--output`.
The default output is `training-independent-verification.json` in the run
directory. The verifier reads frozen trainer evidence and writes its own report;
it does not train, alter the candidate, or open the final arena configuration.

Checks include:

- Exact source, protocol, parent, output-model, checkpoint, episode, and candidate
  hashes, with source hashes checked again after verification.
- Every saved episode action replayed through the canonical rules; legal masks,
  actor, all feature vectors, behavior mixture/RNG state, terminal discrete
  territory area, and train/validation stratification checked.
- Independent Adam updates from the original v1 weights for every configured
  epoch; candidate weights, losses, and final optimizer moments recomputed.
- Every development game reconstructed deterministically from its prefix seed
  and candidate/parent policy. Terminal state, action count, discrete area,
  shared-win score, paired comparison, and final candidate selection recomputed.
- One middle training sample per board-size/starting-player stratum has all
  MaxN teacher targets regenerated. The report includes its full action prefix.

All 72 generation episodes, all 900 optimizer epochs, three candidates, and all
171 development games are required by the frozen full configuration. Generation
episodes reaching the configured cap retain `terminal=false` and `outcome=null`;
they are permitted supervised training prefixes, not invented completed games.
Development games must reach a real terminal state.

The verifier shares the hash-checked application rule engine and feature
extractor. Its optimizer, loss, development replay loop, terminal scoring, and
selection arithmetic are implemented separately from trainer helpers. Teacher
labels outside the stratified sample receive shape and normalization checks,
not full teacher regeneration. Successful training verification does not prove
improved playing strength; the separate untouched final arena determines
promotion.

Verifier regression command:

```text
node --unhandled-rejections=strict web/web前端/tests/verify-three-player-posttraining-output.mjs
```

The compact `output-verifier-recovery-receipt.json` records a fresh passing
fixture plus three rejected semantic-corruption cases. Each corrupted episode,
candidate, or development result is resealed before verification, demonstrating
that these failures are detected beyond a simple checksum mismatch.
