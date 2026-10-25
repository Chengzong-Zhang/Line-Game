import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { sut, root, plain } from './helpers.mjs';

const settings = { gridSize: 5, playerCount: 4, boardShape: 'hexagon', startPlayer: 'BLACK',
  rulesVersion: 'territory-v2', initialPositions: {
    BLACK: [2,4], WHITE: [4,0], PURPLE: [8,2], GREEN: [6,6],
  } };
const points = [[6,4], null, null, null, [2,8], [4,4], [4,2], [4,6]];
const actions = points.map(point => point ? { type: 'move', point } : { type: 'skip' });

function assertRestored(snapshot, final) {
  assert.equal(snapshot.boardMatrix[4][4], 2, 'C captures B: restore A\'s physical a1');
  assert.equal(snapshot.boardMatrix[4][6], 1, 'A\'s node a must survive D cutting a2');
  assert.ok(snapshot.edges.BLACK.includes('2,4|6,4'), 'restore the logical a1 edge as well');
  if (final) assert.equal(snapshot.boardMatrix[6][4], 7, 'D occupies the a2 cut');
}

test('main-program core and frozen Worker reconnect before the next attack', async () => {
  const bundle = await fs.readFile(process.env.LIFELINE_RECONNECTION_WORKER
    || path.join(root, 'dist/workers/index.js'), 'utf8');
  let receive, answer;
  const context = vm.createContext({ worker: { onMessage: f => { receive = f; },
    postMessage: message => { answer = plain(message); } } });
  vm.runInContext(bundle, context, { timeout: 10000 });
  for (let length = 1; length <= actions.length; length++) {
    const prefix = actions.slice(0, length);
    const game = sut.restoreGame(settings, prefix);
    receive({ id: length, kind: 'STATE', payload: { settings, actions: prefix }, context: { epoch: 1 } });
    assert.equal(answer?.ok, true, answer?.error);
    assert.deepEqual(answer.result.ruleState, plain(sut.serializeRuleState(game)));
    assert.deepEqual(answer.result.snapshot, plain(game.getSnapshot()));
    if (length >= 7) assertRestored(answer.result.snapshot, length === 8);
  }
});

test('backend action validator uses the same corrected state hash', () => {
  for (const length of [7, 8]) {
    const payload = { settings, actions: actions.slice(0, length - 1), action: actions[length - 1] };
    const result = spawnSync(process.execPath, [path.join(root, 'tools/validate-action.mjs')], {
      input: JSON.stringify(payload), encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    const expected = sut.executeTask({ kind: 'APPLY', payload });
    assertRestored(expected.snapshot, length === 8);
    assert.equal(JSON.parse(result.stdout).stateHash, expected.stateHash);
  }
});
