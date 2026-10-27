import test from 'node:test';
import assert from 'node:assert/strict';
import { sut, web, plain } from './helpers.mjs';

test('shared bundled core preserves the existing three-player v2 witness and terminal cases', () => {
  const settings = { ...sut.settingsFor(5), playerCount: 3, rulesVersion: 'territory-v2' };
  const prefix = [[1, 0], [0, 2], [3, 1], [1, 2], [1, 3], [2, 0], [2, 1], [1, 1]];
  for (const ending of ['natural', 'pass', 'resign']) {
    const actual = new sut.GameEngine(settings), expected = new web.GameEngine(settings);
    const equal = () => {
      assert.deepEqual(plain(sut.serializeRuleState(actual)), plain(sut.serializeRuleState(expected)));
      assert.deepEqual(plain(actual.getSnapshot()), plain(expected.getSnapshot()));
    };
    equal();
    for (const point of ending === 'natural' ? prefix : prefix.slice(0, 3)) {
      assert.equal(actual.playMove(point).success, true);
      assert.equal(expected.playMove(point).success, true);
      equal();
    }
    if (ending === 'natural') {
      const snapshot = actual.getSnapshot();
      assert.deepEqual(Object.fromEntries(snapshot.players.map(p => [p, snapshot.territories[p].area])), { BLACK: 0, WHITE: 6, PURPLE: 4 });
      assert.equal(snapshot.winner, 'WHITE');
    } else if (ending === 'pass') {
      for (let i = 0; i < 3 && !actual.gameOver; i++) {
        assert.equal(actual.skipTurn().success, true); assert.equal(expected.skipTurn().success, true); equal();
      }
    } else {
      for (const player of ['BLACK', 'WHITE']) {
        assert.equal(actual.resignPlayer(player).success, true); assert.equal(expected.resignPlayer(player).success, true); equal();
      }
      assert.equal(actual.getSnapshot().winner, 'PURPLE');
    }
    assert.equal(actual.gameOver, true);
  }
  assert.equal(sut.validateSettings(settings), settings);
});
