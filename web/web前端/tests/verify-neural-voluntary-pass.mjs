// Regression for the application arena: voluntary PASS is in Research PUCT's
// documented action contract and is legal in territory-v2.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadArenaModels } from '../../tools/neural-posttraining-arena-v2.mjs';
import { replay, sha, unseal } from '../../tools/neural-posttraining-data.mjs';

const run = resolve(process.argv[2] ?? 'local_artifacts/ai-improvement-round2-20261021/neural-confirmation');
const identity = JSON.parse(await readFile(resolve(run, 'identity.json'), 'utf8'));
const checkpoint = unseal(JSON.parse(await readFile(resolve(run, 'checkpoint.json'), 'utf8')));
assert.equal(checkpoint.identity, identity.identity);
const { policies, source_hashes } = await loadArenaModels(identity.candidateManifestPath);
for (const [path, hash] of Object.entries(source_hashes)) assert.equal(identity.source_hashes[path], hash);
const checked = [];
for (const ref of checkpoint.completed) {
  const bytes = await readFile(resolve(run, ref.path));
  assert.equal(sha(bytes), ref.sha256);
  const game = JSON.parse(bytes), engine = replay({ size: game.size, start: game.start, actions: [] });
  for (const [ply, action] of game.actions.entries()) {
    assert.equal(engine.gameOver, false);
    assert.equal(action.player, engine.currentPlayer);
    if (ply >= game.prefixLength && action.point === null) {
      const legalPlacements = engine.getLegalMoves(engine.currentPlayer).length;
      if (legalPlacements) {
        const ai = policies.get(action.modelId);
        assert.equal(ai.model.spec.action_contract?.pass, 'always legal in nonterminal Web state; maps to skipTurn',
          'Voluntary PASS requires the frozen model action contract');
        const expected = ai.getTopMoves(engine, engine.currentPlayer, 1)[0];
        assert.ok(expected, 'PUCT must return an explicit action');
        assert.equal(expected.point, null, 'Frozen policy must actually choose PASS');
        checked.push({ game: game.id, ply, modelId: action.modelId, legalPlacements });
      }
    }
    assert.ok((action.point === null ? engine.skipTurn() : engine.playMove(action.point)).success);
  }
}
assert.ok(checked.length > 0, 'Regression fixture must exercise voluntary PASS');
for (const [path, hash] of Object.entries(identity.source_hashes)) assert.equal(sha(await readFile(resolve(path))), hash);
const report = {
  status: 'PASS_REAL_VOLUNTARY_PASS_REGRESSION', arenaIdentity: identity.identity,
  voluntaryPassDecisionsRecomputed: checked.length, checked,
  test_sha256: sha(await readFile(fileURLToPath(import.meta.url))),
  command: ['node', 'web/web前端/tests/verify-neural-voluntary-pass.mjs', run],
  conclusion: 'The frozen Research PUCT policy legally chooses PASS with placements available. Removing the extra forced-pass assertion corrects a verifier implementation error; it changes no game, model, threshold or statistical result.',
};
await writeFile(resolve(run, 'voluntary-pass-regression.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: report.status, voluntaryPassDecisionsRecomputed: checked.length, first: checked[0] }));
