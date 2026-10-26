import assert from 'node:assert/strict';
import {
  CONTRIBUTION_V2_POLICY,
  CONTRIBUTION_V3_MAX_ACTIONS,
  CONTRIBUTION_V3_POLICY,
  contributionProfileChoices,
  contributionV3ProfileChoices,
  normalizeV3Context,
} from '../../tools/training_contribution_schema.mjs';
import { validateContribution } from '../../tools/validate_contribution.mjs';
import { syntheticV2Contribution } from './fixtures/create-training-v2-fixture.mjs';
import { syntheticV3Contribution } from './fixtures/create-training-v3-fixture.mjs';

assert.equal(CONTRIBUTION_V3_POLICY, 'anonymous-replay-training-v3');
assert.equal(CONTRIBUTION_V3_MAX_ACTIONS, 3000);

let matrixCases = 0;
let moveCases = 0;
for (let playerCount = 2; playerCount <= 15; playerCount += 1) {
  for (const boardShape of ['triangle', 'hexagon']) {
    const modes = playerCount <= 6 ? ['default', 'random', 'custom'] : ['random', 'custom'];
    for (const startingPointMode of modes) {
      const payload = await syntheticV3Contribution({ playerCount, boardShape, startingPointMode, gridSize: 7, undoUsedCount: 1 });
      const verified = await validateContribution(payload);
      assert.equal(verified.protocol_version, 3);
      assert.equal(verified.replay.rulesVersion, 'territory-v3');
      assert.equal(verified.replay.config.rulesVersion, 'territory-v3');
      assert.equal(verified.replay.config.boardShape ?? (playerCount >= 4 ? 'hexagon' : 'triangle'), boardShape);
      assert.equal(verified.replay.terminal.status, 'completed');
      if (verified.replay.actions.some(action => action.type === 'move')) moveCases += 1;
      assert.ok(verified.replay.actions.some(action => action.type === 'skip'));
      assert.deepEqual(verified.context, normalizeV3Context(payload.context, payload.replay.config));
      assert.deepEqual(Object.keys(verified.engine_sources).sort(), [
        'GameEngine.js', 'ReplayCodec.js', 'ResearchAI.js', 'StartingPoints.js',
        'training_contribution_schema.mjs', 'validate_contribution.mjs',
      ]);
      if (startingPointMode === 'default') {
        assert.equal(verified.replay.config.startingPointMode, undefined);
        assert.equal(verified.replay.config.initialPositions, undefined);
      } else {
        assert.equal(verified.replay.config.startingPointMode, startingPointMode);
        assert.deepEqual(Object.keys(verified.replay.config.initialPositions), verified.replay.config.players);
      }
      matrixCases += 1;
    }
  }
}
assert.equal(matrixCases, 66);
assert.ok(moveCases > 0);

for (let gridSize = 5; gridSize <= 15; gridSize += 1) {
  const payload = await syntheticV3Contribution({ playerCount: 2, boardShape: 'triangle', startingPointMode: 'random', gridSize });
  const verified = await validateContribution(payload);
  assert.equal(verified.replay.config.gridSize, gridSize);
}

const resigned = await syntheticV3Contribution({ playerCount: 15, boardShape: 'hexagon', gridSize: 15,
  startingPointMode: 'custom', terminalMode: 'resign', profile: 'multiplayer-hard-v1' });
const resignedVerified = await validateContribution(resigned);
assert.equal(resignedVerified.replay.terminal.reason, 'resignation');
assert.ok(resignedVerified.replay.actions.some(action => action.type === 'move'));
assert.ok(resignedVerified.replay.actions.some(action => action.type === 'resign'));
assert.equal(resignedVerified.replay.terminal.resignedPlayers.length, 14);
assert.deepEqual(contributionV3ProfileChoices(resigned.replay.config),
  ['human', 'greedy', 'multiplayer-easy-v1', 'multiplayer-hard-v1']);
assert.ok(!contributionV3ProfileChoices(resigned.replay.config).includes('multiplayer-medium-v1'));
assert.ok(!contributionV3ProfileChoices(resigned.replay.config).includes('multiplayer-ultimate-v1'));
for (const profile of ['greedy', 'multiplayer-easy-v1', 'multiplayer-hard-v1']) {
  const supported = structuredClone(resigned);
  supported.context.actors.WHITE = { kind: 'ai', profile };
  assert.equal((await validateContribution(supported)).protocol_version, 3);
}
for (const profile of ['multiplayer-medium-v1', 'multiplayer-ultimate-v1']) {
  const unsupported = structuredClone(resigned);
  unsupported.context.actors.WHITE = { kind: 'ai', profile };
  await assert.rejects(validateContribution(unsupported), /unsupported v3 actor profile/i);
}

// V3 must not silently broaden or relabel the frozen v2 contract.
const v2 = await syntheticV2Contribution({ playerCount: 3, startingPointMode: 'random', profile: 'three-player-policy-v2' });
const v2Verified = await validateContribution(v2);
assert.equal(v2Verified.protocol_version, 2);
assert.equal(v2Verified.replay.rulesVersion, 'territory-v2');
assert.equal(CONTRIBUTION_V2_POLICY, 'anonymous-replay-training-v2');
assert.ok(contributionProfileChoices(v2.replay.config).includes('three-player-policy-v2'));
assert.deepEqual(contributionProfileChoices({ ...v2.replay.config, rulesVersion: 'territory-v3' }), []);
assert.ok(contributionV3ProfileChoices({ ...v2.replay.config, rulesVersion: 'territory-v3' }).includes('three-player-policy-v2'));
const v3ForV2Gate = await syntheticV3Contribution({ playerCount: 6, boardShape: 'hexagon', startingPointMode: 'random' });
await assert.rejects(validateContribution({ ...v3ForV2Gate, version: 2, consent_policy: CONTRIBUTION_V2_POLICY }), /Unsupported v2 rules/);
await assert.rejects(validateContribution({ ...v2, version: 3, consent_policy: CONTRIBUTION_V3_POLICY }), /Unsupported v3 rules/);

const forgedCandidates = [];
const forgedWinner = structuredClone(resigned);
forgedWinner.replay.terminal.winner = forgedWinner.replay.terminal.winner === 'BLACK' ? 'WHITE' : 'BLACK';
forgedCandidates.push(forgedWinner);
const forgedScores = structuredClone(resigned);
forgedScores.replay.terminal.scores.BLACK.area += 1;
forgedCandidates.push(forgedScores);
const forgedStateHash = structuredClone(resigned);
forgedStateHash.replay.integrity.finalStateHash = 'sha256:' + '0'.repeat(64);
forgedCandidates.push(forgedStateHash);
const forgedEvent = structuredClone(resigned);
forgedEvent.replay.actions[0].postStateHash = 'sha256:' + '1'.repeat(64);
forgedCandidates.push(forgedEvent);
for (const payload of forgedCandidates) await assert.rejects(validateContribution(payload));

const privateCandidates = [
  { ...resigned, openid: 'PRIVATE' },
  { ...resigned, context: { ...resigned.context, deviceId: 'PRIVATE' } },
  { ...resigned, context: { ...resigned.context, actors: { ...resigned.context.actors,
    BLACK: { kind: 'human', name: 'PRIVATE' } } } },
  { ...resigned, replay: { ...resigned.replay, config: { ...resigned.replay.config, account: 'PRIVATE' } } },
];
for (const payload of privateCandidates) await assert.rejects(validateContribution(payload));

process.stdout.write(JSON.stringify({ status: 'PASS_V3_CONTRIBUTION_PROTOCOL', matrixCases,
  pass: true, resign: true, authoritativeForgeryRejection: forgedCandidates.length,
  privacyRejection: privateCandidates.length, v2Unchanged: true }) + '\n');
