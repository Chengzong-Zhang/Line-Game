import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTopologySetup, createTopologyEditorLegacyDefinition } from '../src/topology-setup.js';
import { layoutBoardEditor, hitTestBoardEditor, renderBoardEditor } from '../src/board-editor-ui.js';

const rect = { x: 40, y: 50, width: 270, height: 240 };
const setup = () => createTopologySetup({ definition: createTopologyEditorLegacyDefinition({
  gridSize: 15, boardShape: 'diamond', playerCount: 2,
}) });
const point = (layout, xy) => layout.gridPoints.find(p => p.coordinate.join(',') === xy.join(','));

test('default and zoom 1 match, zoom centres the board and pan uses pixels without changing the definition', () => {
  const state = setup(), original = JSON.stringify(state.definition);
  const normal = layoutBoardEditor(state, rect, { gridSize: 15 });
  const identity = layoutBoardEditor(state, rect, { gridSize: 15, zoom: 1, pan: {x: 0, y: 0} });
  assert.deepEqual(identity, normal);
  const enlarged = layoutBoardEditor(state, rect, { gridSize: 15, zoom: 3, pan: {x: 14, y: -9} });
  assert.equal(enlarged.scale, normal.scale * 3);
  const a = point(normal, [7, 7]), b = point(enlarged, [7, 7]);
  const centerX = rect.x + rect.width / 2, centerY = rect.y + rect.height / 2;
  assert.ok(Math.abs(b.x - (centerX + (a.x-centerX)*3 + 14)) < 1e-9);
  assert.ok(Math.abs(b.y - (centerY + (a.y-centerY)*3 - 9)) < 1e-9);
  assert.deepEqual(hitTestBoardEditor(enlarged, b.x, b.y, 'contour'), { type: 'coordinate', coordinate: [7, 7] });
  const root = enlarged.points.find(p => p.coordinate.join(',') === '7,7');
  assert.equal(hitTestBoardEditor(enlarged, root.x, root.y, 'root').vertexId, root.vertexId);
  assert.equal(hitTestBoardEditor(enlarged, rect.x - 1, b.y, 'contour'), null);
  assert.equal(hitTestBoardEditor(enlarged, rect.x + rect.width + 1, b.y, 'root'), null);
  assert.equal(JSON.stringify(state.definition), original);
  assert.equal(layoutBoardEditor(state, rect, { zoom: 20 }).scale, layoutBoardEditor(state, rect, { zoom: 4 }).scale);
  assert.equal(layoutBoardEditor(state, rect, { zoom: -1 }).scale, layoutBoardEditor(state, rect).scale);
});

const canvasModule = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@napi-rs/canvas/index.js');
test('zoomed and panned drawing clips to the editor rectangle on a real Canvas', { skip: !fs.existsSync(canvasModule) }, async () => {
  const { createCanvas } = await import(pathToFileURL(canvasModule).href);
  const canvas = createCanvas(350, 340), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  renderBoardEditor(ctx, rect, setup(), { gridSize: 15, zoom: 4, pan: { x: 35, y: -25 } });
  const bytes = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let changedInside = 0, changedOutside = 0;
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    const i = (y * canvas.width + x) * 4;
    if (bytes[i] === 255 && bytes[i+1] === 255 && bytes[i+2] === 255) continue;
    if (x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) changedInside++;
    else changedOutside++;
  }
  assert.ok(changedInside > 100, 'the zoomed board is drawn');
  assert.equal(changedOutside, 0, 'no pixels overpaint controls outside the editor');
  ctx.fillStyle = '#ff0000'; ctx.fillRect(2, 2, 1, 1);
  assert.deepEqual([...ctx.getImageData(2, 2, 1, 1).data], [255, 0, 0, 255], 'canvas state is restored');
});
