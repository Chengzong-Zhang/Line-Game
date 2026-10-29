import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { verifySharedRoom, sharedRoomPayload } from '../SharedRoomClient.js';
import { validateTopologyRoomSnapshot } from '../OnlineRoomSync.js';
globalThis.crypto ??= webcrypto;
const path = process.argv[2];
if (!path) throw new Error('usage: node verify-shared-service-responses.mjs <sanitized-fixtures.json>');
const rooms = JSON.parse(await readFile(path, 'utf8'));
assert.equal(rooms.length, 2);
for (const room of rooms) {
  const restored = await verifySharedRoom(room);
  const payload = sharedRoomPayload(room);
  assert.equal(restored.getSnapshot().currentPlayer, room.currentPlayer);
  assert.equal(payload.matchState.actions.length, room.seq);
}
assert.equal(rooms[0].settings.rulesVersion, 'surface-v1');
assert.equal(validateTopologyRoomSnapshot(sharedRoomPayload(rooms[0])).ok, true, 'actual service response passes the Web topology preflight');
assert.equal(rooms[1].settings.rootRulesVersion, 'root-v2');
assert.equal(sharedRoomPayload(rooms[1]).matchState.actions.at(-1).type, 'player_root_add');
console.log('verify-shared-service-responses: PASS (real service topology and root-v2 recovery snapshots)');
