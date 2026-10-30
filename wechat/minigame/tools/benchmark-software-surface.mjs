// Compare a saved baseline with the current renderer using a native Canvas.
// Usage: node tools/benchmark-software-surface.mjs <baseline.js> <output.json>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { GameEngine } from '../src/core.js';
import { createTopologySetup, useTopologyPreset } from '../src/topology-setup.js';
import { buildSurfaceCells } from '../src/topology/TopologySurface3D.js';
import { createSoftwareSurfaceRenderer } from '../src/topology-software-surface.js';

const [baselinePath, outputPath] = process.argv.slice(2);
if (!baselinePath || !outputPath) throw Error('Specify baseline source and output JSON paths');
const sourceDir = fileURLToPath(new URL('../src/', import.meta.url));
const baselineSource = fs.readFileSync(baselinePath, 'utf8').replace(/^\uFEFF/, '');
const bundled = await build({ stdin: { contents: baselineSource, resolveDir: sourceDir, sourcefile: 'baseline.js' }, bundle: true, write: false, format: 'esm', platform: 'node' });
const baseline = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const modulePath = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@napi-rs/canvas/index.js');
const { createCanvas } = await import(pathToFileURL(modulePath).href);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const rotate = ([x, y, z]) => { const yaw = .45, pitch = -.3; const a = x*Math.cos(yaw)-z*Math.sin(yaw), b = x*Math.sin(yaw)+z*Math.cos(yaw); return [a,y*Math.cos(pitch)-b*Math.sin(pitch),y*Math.sin(pitch)+b*Math.cos(pitch)]; };
const median = a => [...a].sort((x,y) => x-y)[Math.floor(a.length / 2)];
const results = [];
for (const preset of ['torus', 'double-torus']) for (const gridSize of [9, 15]) {
  const setup = useTopologyPreset(createTopologySetup(), preset, { gridSize, playerCount: 2 });
  assert.equal(setup.ok, true, JSON.stringify(setup.errors));
  const engine = new GameEngine({ boardDefinition: setup.setup.definition, rulesVersion: 'surface-v1', playerCount: 2 });
  const data = buildSurfaceCells(engine.getSnapshot());
  assert.equal(data.surface.kind, preset);
  const canvases = [createCanvas(320,320),createCanvas(320,320)];
  const renderers = [baseline.createSoftwareSurfaceRenderer(canvases[0]),createSoftwareSurfaceRenderer(canvases[1])];
  const draw = i => renderers[i].draw(data, 320, 320, rotate, 1, {}, 1);
  for (let j=0;j<3;j++) { draw(0); draw(1); }
  const pixels = canvases.map(c => Buffer.from(c.getContext('2d').getImageData(0,0,320,320).data));
  assert.deepEqual(pixels[1], pixels[0], `${preset} N${gridSize} pixel difference`);
  const samples = [[],[]];
  for (let round=0;round<12;round++) for (const i of round%2 ? [1,0] : [0,1]) { const t=performance.now(); draw(i); samples[i].push(performance.now()-t); }
  results.push({preset, gridSize, cells:data.cells.length, lines:data.lines.length, nodes:data.nodes.length, pixelSha256:sha(pixels[0]), medianMs:samples.map(median), samplesMs:samples});
  renderers.forEach(r => r.destroy());
  console.log(preset, gridSize, results.at(-1).medianMs);
}
const output = { node:process.version, platform:process.platform, arch:process.arch, canvas:'@napi-rs/canvas', width:320, height:320, yaw:.45, pitch:-.3, zoom:1, dpr:1, warmup:3, rounds:12, baselineSha256:sha(baselineSource), candidateSha256:sha(fs.readFileSync(path.join(sourceDir,'topology-software-surface.js'))), results };
fs.writeFileSync(outputPath, JSON.stringify(output,null,2));
