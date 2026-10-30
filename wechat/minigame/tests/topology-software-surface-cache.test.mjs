import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSoftwareSurfaceRenderer } from '../src/topology-software-surface.js';

const canvasModule = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@napi-rs/canvas/index.js');
test('software surface reuses buffers without retaining stale pixels across changes', { skip: !fs.existsSync(canvasModule) }, async () => {
  const { createCanvas } = await import(pathToFileURL(canvasModule).href);
  const canvas = createCanvas(80, 80), ctx = canvas.getContext('2d');
  const createImage = ctx.createImageData.bind(ctx); let allocations = 0;
  ctx.createImageData = (...args) => { allocations++; return createImage(...args); };
  const renderer = createSoftwareSurfaceRenderer(canvas);
  const quad = (z, player) => ({ player, points: [[-1,-1,z],[1,-1,z],[1,1,z],[-1,1,z]] });
  const data = { cells: [quad(1, 'BLACK'), quad(-1, 'WHITE')],
    lines: [{ player: 'WHITE', points: [[-1,0,2],[1,0,2]] }, { player: null, points: [[0,-1,-2],[0,1,-2]] }],
    nodes: [{ player:'BLACK', point:[.5,.5,3], start:true }, { player:'WHITE', point:[-.5,-.5,-3], start:false }] };
  const identity = p => p;
  const turn = ([x,y,z]) => [z,y,-x];
  const pixels = c => Buffer.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data);
  const draw = (w,h,rotate,zoom,palette) => renderer.draw(data,w,h,rotate,zoom,palette,1);
  const freshEquals = (w,h,rotate,zoom,palette) => {
    draw(w,h,rotate,zoom,palette);
    const reference = createCanvas(w,h), other = createSoftwareSurfaceRenderer(reference);
    other.draw(data,w,h,rotate,zoom,palette,1);
    assert.deepEqual(pixels(canvas), pixels(reference)); other.destroy();
  };
  freshEquals(80,80,identity,1,{}); assert.equal(allocations, 1);
  const first = pixels(canvas); freshEquals(80,80,turn,.7,{BLACK:{surface:'#123'}}); assert.equal(allocations, 1);
  assert.notDeepEqual(pixels(canvas), first);
  data.cells.reverse(); data.nodes.pop(); freshEquals(96,72,identity,1,{}); assert.equal(allocations, 2);
  renderer.destroy(); freshEquals(96,72,identity,1,{}); assert.equal(allocations, 3);
  renderer.destroy();
});
