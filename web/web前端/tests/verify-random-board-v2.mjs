import assert from 'node:assert/strict';
import {generateBoard, RandomBoardGeneratorVersion} from '../RandomBoard.js';
import {compileBoardOrThrow} from '../BoardCompiler.js';

const options = {gridSize:9, playerCount:4, roughness:0.65};
const frozen = {
  'random-board-v2': ['eca97b1dcf8db760c46dbb2795fa5cb64f48d77ab7187d5b82614cf8127c2847', '98d593ac0e627bae28f94663b4bb0db4df44e2bcb5291de7507e3173fc29c00e', '5b671772c708d660a942fe468c801a6b5b8fa4680ac110093e0ede83d8dac37c'],
  'random-board-v3': ['3d6df3e61f42d794ffe25a111f372056ba61a0e26c1f3f74c33780e8a0efe7c6', '8eef4cbfe53191ef0231247ba01203d999bc9b0223d0c4d07594a523d3158550', 'f45779d8b8806f2b25967e4acba6ca9d0b01669f5259be6b931b80f45b425a4d'],
};
assert.equal(RandomBoardGeneratorVersion,'random-board-v4');
for (const [index, seed] of ['alpha','beta',12345].entries()) {
  const fresh=generateBoard(options,seed,'random-board-v2');
  assert.equal(fresh.ok,true);
  assert.deepEqual(generateBoard(options,seed,'random-board-v2'),fresh);
  assert.deepEqual(generateBoard(options,seed,'random-board-v2'),fresh);
  assert.equal(fresh.definition.generator.generatorVersion,'random-board-v2');
  assert.equal(fresh.definition.topology.movementStrategy,'simple-rays-v2');
  const board=compileBoardOrThrow(fresh.definition);
  assert.equal(board.boardHash, frozen['random-board-v2'][index]);
  assert.equal(board.rules.movementStrategy,'simple-rays-v2');
  assert.equal(board.definition.generator.generatorVersion,'random-board-v2');
  const legacy=generateBoard(options,seed,'random-board-v1');
  assert.equal(legacy.ok,true);
  assert.equal(legacy.definition.generator.generatorVersion,'random-board-v1');
  assert.equal(legacy.definition.topology.movementStrategy,'simple-rays-v1');
  assert.deepEqual(generateBoard(options,seed,'random-board-v1'),legacy);
  assert.notEqual(compileBoardOrThrow(legacy.definition).boardHash,board.boardHash);
  const previous=generateBoard(options,seed,'random-board-v3');
  assert.deepEqual(previous,generateBoard(options,seed,'random-board-v3'));
  assert.equal(compileBoardOrThrow(previous.definition).boardHash, frozen['random-board-v3'][index]);
  assert.equal(previous.definition.topology.movementStrategy,'simple-rays-v3');
}
assert.equal(generateBoard(options,'alpha','random-board-v5').errors[0].code,'UNSUPPORTED_GENERATOR_VERSION');
console.log('random board: PASS (v4 default, explicit v1/v2/v3, determinism and compiler metadata)');
