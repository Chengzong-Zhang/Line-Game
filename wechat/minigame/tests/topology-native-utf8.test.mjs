import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { sha256Hex } from '../src/topology/BoardDefinition.js';
import { createTopologySetup, useTopologyPreset, generateTopologyBoard, addTopologyBoundaryVertex,
  closeTopologyBoundary, changeTopologyStarts } from '../src/topology-setup.js';
import { restoreGame } from '../src/state.js';
import { decodeTopologyState } from '../src/core.js';

test('topology creation and state round trip work without the browser TextEncoder global', () => {
  const NativeTextEncoder = globalThis.TextEncoder;
  const expected = createHash('sha256').update('拓扑😀\ud800').digest('hex');
  try {
    globalThis.TextEncoder = undefined;
    assert.equal(sha256Hex('拓扑😀\ud800'), expected);
    for (const name of ['cylinder', 'mobius', 'torus', 'klein-bottle', 'tetrahedron', 'cone', 'sphere', 'double-sphere', 'double-torus']) {
      const result = useTopologyPreset(createTopologySetup(), name, { gridSize: 9, playerCount: 2 });
      assert.equal(result.ok, true, `${name}: ${JSON.stringify(result.errors)}`);
    }
    const random = generateTopologyBoard(createTopologySetup(), { gridSize: 9, playerCount: 2 }, 'wx-native-随机');
    assert.equal(random.ok, true, JSON.stringify(random.errors));
    let custom = createTopologySetup();
    for (const point of [[0,0], [1,0], [2,0], [2,1], [1,1], [1,2], [0,2], [0,1]]) {
      const next = addTopologyBoundaryVertex(custom, point);
      assert.equal(next.ok, true); custom = next.setup;
    }
    let result = closeTopologyBoundary(custom);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    result = changeTopologyStarts(result.setup, { mode: 'default', playerCount: 2 });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    const setup = random.setup;
    const settings = { gridSize: 9, playerCount: 2, startPlayer: 'BLACK', rulesVersion: 'surface-v1', boardShape: 'custom',
      boardDefinition: setup.definition, boardHash: setup.boardHash, topologyProtocolVersion: 'board-topology-v1' };
    const engine = restoreGame(settings);
    const encoded = engine.encodeTopologyState();
    const decoded = decodeTopologyState(encoded);
    assert.equal(decoded.board.boardHash, setup.boardHash);
  } finally { globalThis.TextEncoder = NativeTextEncoder; }
});
