import assert from 'node:assert/strict';
import {createSurfacePreset} from '../BoardPresets.js';
import {compileBoardOrThrow} from '../BoardCompiler.js';
import {prepareTopologyNewMatchSettings} from '../TopologyStartingPoints.js';
import {createTopologyReplayDocument,validateTopologyReplayDocument} from '../ReplayCodec.js';
import '../TopologyGameEngine.js';
import {GameEngine} from '../GameEngine.js';

for (const strategy of ['simple-rays-v1','simple-rays-v2']) {
  const definition = createSurfacePreset('cylinder',{width:8,height:8});
  definition.topology.movementStrategy = strategy;
  definition.startingVertices = {BLACK:'v:3,2',WHITE:'v:4,8'};
  const game = new GameEngine({boardDefinition:definition});
  const first = game._canonicalId([1,5]);
  assert.equal(game.playMove(first).success,true);
  const oldState = game.encodeTopologyState();
  const oldPaths = game.getTopologyRuleState().logicPaths.map(path => path.pathId);
  assert.ok(oldPaths.length);
  const document = await createTopologyReplayDocument({boardDefinition:definition},[{type:'move',vertexId:first}]);
  assert.equal((await validateTopologyReplayDocument(document)).success,true);
  const oldDefinition = structuredClone(definition);
  const settings = {boardShape:'custom',playerCount:2,boardDefinition:definition,boardHash:game.boardHash,
    initialPositions:structuredClone(game.initialPositions),startPlayer:'BLACK'};
  const candidate = prepareTopologyNewMatchSettings(settings);
  assert.deepEqual(definition,oldDefinition, 'upgrade must not change saved/selected old definition');
  assert.equal(candidate.boardDefinition.topology.movementStrategy,'simple-rays-v3');
  assert.equal(candidate.boardHash,compileBoardOrThrow(candidate.boardDefinition).boardHash);
  assert.notEqual(candidate.boardHash,game.boardHash);
  const canonicalOld = compileBoardOrThrow(oldDefinition).definition;
  for(const key of ['vertices','faces','seamPairs','startingVertices'])
    assert.deepEqual(candidate.boardDefinition[key],canonicalOld[key],`${key} stays the same`);
  const fresh = new GameEngine({boardDefinition:candidate.boardDefinition});
  assert.deepEqual(fresh.initialRoots,game.initialRoots);
  assert.equal(fresh.playMove(first).success,false,'new rule no longer accepts the bent line');
  const oldRestored = new GameEngine({boardDefinition:oldDefinition});
  assert.equal(oldRestored.restoreTopologyState(oldState),true);
  assert.deepEqual(oldRestored.getTopologyRuleState().logicPaths.map(path=>path.pathId),oldPaths);
  assert.equal((await validateTopologyReplayDocument(document)).success,true,
    'the old replay is still validated against its original v1/v2 path identity');
}

const modern = {boardDefinition:createSurfacePreset('cylinder',{gridSize:5})};
assert.equal(prepareTopologyNewMatchSettings(modern),modern,'v3 definition is not rewritten');
assert.throws(()=>prepareTopologyNewMatchSettings({boardDefinition:{topology:{movementStrategy:'simple-rays-v2'}}}),
  /INVALID_NEW_MATCH_TOPOLOGY/);
console.log('PASS: v1/v2 old state and replay stay intact; explicit fresh match upgrades rules and preserves geometry and roots');
