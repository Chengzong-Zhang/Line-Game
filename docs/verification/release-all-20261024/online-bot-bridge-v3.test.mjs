import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const bridge = process.env.LIFELINE_LEGACY_BRIDGE;
assert.ok(bridge, 'Select the frozen bridge under test');
const { processBotRequest } = await import(pathToFileURL(bridge));

for (const players of [3, 4, 5, 6]) {
  test(`${players} players: v3 AI rooms score the initial owned point and accept the new rules`, async () => {
    let examined = false;
    const result = await processBotRequest({ settings: { playerCount: players, gridSize: 5,
      rulesVersion: 'territory-v3', startPlayer: 'BLACK' }, actions: [], botColors: ['BLACK'] }, {
      chooseBotPoint: async engine => {
        examined = true;
        assert.equal(engine.rulesVersion, 'territory-v3');
        for (const color of engine.activePlayers) assert.equal(engine.getScoreboard()[color].area, 1);
        return engine.getLegalMoves()[0].point;
      },
    });
    assert.equal(examined, true);
    assert.equal(result.success, true);
    assert.equal(result.fallback, false);
  });
  test(`${players} players: actual existing model can act under v3 without fallback`, async () => {
    const result = await processBotRequest({ settings: { playerCount: players, gridSize: 5,
      rulesVersion: 'territory-v3', startPlayer: 'BLACK' }, actions: [], botColors: ['BLACK'] });
    assert.equal(result.success, true);
    assert.equal(result.fallback, false);
    assert.equal(result.action.color, 'BLACK');
  });
}

test('existing v2 rooms stay v2 and an unknown rule version is rejected', async () => {
  let calls = 0;
  const chooseBotPoint = async engine => {
    calls++;
    assert.equal(engine.rulesVersion, 'territory-v2');
    assert.equal(engine.getScoreboard().BLACK.area, 0);
    return engine.getLegalMoves()[0].point;
  };
  const request = { settings: { playerCount: 3, gridSize: 5,
    rulesVersion: 'territory-v2', startPlayer: 'BLACK' }, actions: [], botColors: ['BLACK'] };
  assert.equal((await processBotRequest(request, { chooseBotPoint })).success, true);
  assert.equal(calls, 1);
  assert.deepEqual(await processBotRequest({ ...request, settings: { ...request.settings, rulesVersion: 'unknown' } },
    { chooseBotPoint }), { success: false, reason: 'INVALID_CONFIGURATION' });
  assert.equal(calls, 1);
});
