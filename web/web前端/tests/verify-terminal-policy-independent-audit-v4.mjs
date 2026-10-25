import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { auditTerminalPolicyEvidence } from '../../tools/verify-terminal-policy-evidence-v4.mjs';
import { sealed, unseal, sha } from '../../tools/neural-posttraining-data-v2.mjs';

// Takes an actual completed bounded fixture; never fabricates training evidence.
const argv = process.argv.slice(2), option = name => argv.includes(name) ? argv[argv.indexOf(name) + 1] : null;
if (!option('--training-root') || !option('--config')) throw Error('Use --training-root COMPLETED_BOUNDED_FIXTURE --config ITS_FROZEN_PROTOCOL');
const originalRoot = resolve(option('--training-root')), config = resolve(option('--config')),
  options = { configPath: config, checkCurrentSource: false };
const baseline = await auditTerminalPolicyEvidence(originalRoot, options);
assert.equal(baseline.status, 'PASS');
const temp = await mkdtemp(resolve(tmpdir(), 'lifeline-terminal-audit-'));
await cp(originalRoot, temp, { recursive: true });
const checkpointPath = resolve(temp, 'checkpoint.json'), checkpointBytes = await readFile(checkpointPath),
  checkpoint = unseal(JSON.parse(checkpointBytes));
const [alias, model] = Object.entries(checkpoint.models).find(([, value]) => value.eligibleSamples > 0);
const episodeIndex = model.completed.findIndex(value => value.eligibleSamples > 0);
assert.ok(episodeIndex >= 0, 'Fixture needs a real nonzero policy-gradient episode');
const reference = model.completed[episodeIndex], episodePath = resolve(temp, reference.path), episodeBytes = await readFile(episodePath),
  originalEpisode = unseal(JSON.parse(episodeBytes));
const cases = ['real terminal reward, legal-state, masked-probability and gradient reconstruction'];
const restore = async () => { await writeFile(episodePath, episodeBytes); await writeFile(checkpointPath, checkpointBytes); };
async function rewriteEpisode(change) {
  const episode = structuredClone(originalEpisode); change(episode);
  const encoded = JSON.stringify(sealed(episode)); await writeFile(episodePath, encoded);
  const current = structuredClone(checkpoint); current.models[alias].completed[episodeIndex].sha256 = sha(encoded);
  await writeFile(checkpointPath, JSON.stringify(sealed(current)));
}
for (const [label, change, error] of [
  ['intermediate area/duration reward', episode => { episode.reward_sequence[0] += 0.1; }, /Intermediate\/duration reward/],
  ['discounted eligible-time return', episode => { episode.eligibleSamples[0].return += 0.1; }, /discounted\/nonterminal\/unproved return/],
  ['invented optimizer parameter update', episode => { episode.updatedWeights[0] += 0.1; }, /independently reconstructed terminal policy gradient/],
  ['false natural-terminal completion', episode => { episode.naturalTerminal = false; episode.truncated = true; }, /terminal\/canonical final state/],
]) {
  await rewriteEpisode(change); await assert.rejects(auditTerminalPolicyEvidence(temp, options), error);
  await restore(); cases.push(`reject correctly sealed ${label}`);
}
const eligiblePly = originalEpisode.eligibleSamples[0].ply,
  stepPath = resolve(temp, originalEpisode.steps[eligiblePly].path), stepBytes = await readFile(stepPath);
const step = unseal(JSON.parse(stepBytes)); step.analysis.search.completedDepth = 1; step.analysis.label.search.completedDepth = 1;
await writeFile(stepPath, JSON.stringify(sealed(step)));
await rewriteEpisode(episode => { episode.steps[eligiblePly].sha256 = sha(JSON.stringify(sealed(step))); });
await assert.rejects(auditTerminalPolicyEvidence(temp, options), /actual completed depth/);
await writeFile(stepPath, stepBytes); await restore();
cases.push('reject correctly sealed/reindexed shallow Minimax eligibility');
const opponentPly = await (async () => {
  for (const [ply, item] of originalEpisode.steps.entries()) {
    const row = unseal(JSON.parse(await readFile(resolve(temp, item.path)))); if (row.actor !== originalEpisode.learner) return ply;
  }
  return -1;
})();
assert.ok(opponentPly >= 0);
const opponentPath = resolve(temp, originalEpisode.steps[opponentPly].path), opponentBytes = await readFile(opponentPath),
  opponent = unseal(JSON.parse(opponentBytes)); opponent.eligibleForPolicyGradient = true;
await writeFile(opponentPath, JSON.stringify(sealed(opponent)));
await rewriteEpisode(episode => { episode.steps[opponentPly].sha256 = sha(JSON.stringify(sealed(opponent))); });
await assert.rejects(auditTerminalPolicyEvidence(temp, options), /Opponent context entered policy gradient/);
await writeFile(opponentPath, opponentBytes); await restore();
cases.push('reject correctly sealed/reindexed opponent context gradient');
assert.equal((await auditTerminalPolicyEvidence(temp, options)).status, 'PASS');
console.log(JSON.stringify({ schema: 'lifeline-terminal-policy-independent-audit-tests-v4', status: 'PASS', total: cases.length, cases,
  actualFixtureEpisodes: baseline.total_episodes, actualFixtureActions: baseline.total_actions,
  scope: 'bounded evidence audit and deliberate corruption rejection; no additional training, strength, promotion or external release' }, null, 2));
