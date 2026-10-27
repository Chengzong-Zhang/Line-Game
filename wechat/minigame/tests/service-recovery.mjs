import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { device } from './transport-device.mjs';
import { until } from './helpers.mjs';

const [origin, control] = process.argv.slice(2);
const blue = device(origin, 'blue'), red = device(origin, 'red');
async function operation(name, seq) {
  const expected = red.client.game.stateHash;
  await fs.writeFile(path.join(control, `${name}.request`), JSON.stringify({ seq, stateHash: expected }));
  const deadline = Date.now() + 30000;
  while (true) {
    try { await fs.access(path.join(control, `${name}.done`)); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.ok(Date.now() < deadline, `operator timeout: ${name}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await until(() => blue.client.connected && red.client.connected && !blue.client.pending, 10000);
  assert.equal(await blue.client.refresh(), true); assert.equal(await red.client.refresh(), true);
  for (const { client } of [blue, red]) {
    assert.equal(client.room.seq, seq); assert.equal(client.game.stateHash, expected);
    assert.equal(new Set(client.room.actionIds).size, seq);
  }
}
try {
  await blue.client.enter('create', 7); await red.client.enter('join', blue.client.room.code);
  await until(() => blue.client.connected && red.client.connected);
  await blue.client.command('ready'); await red.client.command('ready');
  await until(() => blue.client.canPlay());
  blue.faults.dropReply = blue.faults.dropMessages = true;
  assert.equal(await blue.client.act({ type: 'move', point: [1, 0] }), false);
  assert.ok(blue.client.pending);
  await until(() => red.client.room.seq === 1 && !red.client.game.busy);
  blue.faults.dropMessages = false;
  await operation('restart', 1);
  await until(() => red.client.canPlay());
  assert.equal(await red.client.act({ type: 'skip' }), true);
  await until(() => blue.client.room.seq === 2 && !blue.client.game.busy);
  await operation('restore', 2);
  await until(() => blue.client.canPlay());
  assert.equal(await blue.client.act({ type: 'resign' }), true);
  await until(() => red.client.room.status === 'finished');
  assert.equal(blue.client.game.stateHash, red.client.game.stateHash);
  assert.equal(red.client.game.snapshot.winner, 'WHITE');
  assert.equal(red.client.room.seq, 3);
  console.log(JSON.stringify({ status: 'PASS_REAL_PROCESS_RESTART_AND_BACKUP_RESTORE_LOCAL', acceptedActions: 3,
    pendingActionRecoveredOnce: true, existingClientsReconnectedTwice: true, winner: 'WHITE', stateHash: red.client.game.stateHash }));
} finally { blue.stop(); red.stop(); }
