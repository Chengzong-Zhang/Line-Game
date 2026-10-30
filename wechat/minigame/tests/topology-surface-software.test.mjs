import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { GameEngine, TopologyRulesVersion } from '../src/core.js';
import { createTopologySetup, useTopologyPreset } from '../src/topology-setup.js';
import { buildSurfaceCells } from '../src/topology/TopologySurface3D.js';
import { hitTopologyDraftPoint, layoutTopologyDraft } from '../src/topology-board.js';
import { until } from './helpers.mjs';
import { uiHarness } from './ui-harness.mjs';

test('a blank fixed draft grid snaps to lattice points and stays stable as vertices are added', () => {
  const rect = { x: 10, y: 20, width: 300, height: 230 };
  const before = layoutTopologyDraft({ path: [] }, rect, { gridSize: 5 });
  assert.equal(before.gridPoints.length, 25);
  const chosen = before.gridPoints.find(point => point.coordinate.join(',') === '1,2');
  assert.deepEqual(hitTopologyDraftPoint(chosen.x, chosen.y, before), { index: null, coordinate: [1, 2] });
  const after = layoutTopologyDraft({ path: [[1, 2]] }, rect, { gridSize: 5 });
  assert.deepEqual(after.gridPoints.map(({ x, y }) => [x, y]), before.gridPoints.map(({ x, y }) => [x, y]));
  assert.deepEqual(hitTopologyDraftPoint(chosen.x, chosen.y, after), { index: 0, coordinate: [1, 2] });
  assert.equal(hitTopologyDraftPoint(-100, -100, after), null);
});

const canvasModule = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@napi-rs/canvas/index.js');
test('3D UI falls back to an actual 2D canvas and supports pause, drag, pinch, wheel and return', { skip: !fs.existsSync(canvasModule) }, async () => {
  const { createCanvas } = await import(pathToFileURL(canvasModule).href);
  const screen = createCanvas(780, 1688), screenContext = screen.getContext('2d');
  const realDrawImage = screenContext.drawImage.bind(screenContext), draws = [];
  screenContext.drawImage = (source, ...args) => {
    if (source === surface) {
      const bytes = source.getContext('2d').getImageData(0, 0, source.width, source.height).data;
      let hash = 2166136261, colored = 0;
      for (let i = 0; i < bytes.length; i += 4) { hash = Math.imul(hash ^ bytes[i] ^ (bytes[i+1] << 8) ^ (bytes[i+2] << 16), 16777619); if (bytes[i] !== 246 || bytes[i+1] !== 241 || bytes[i+2] !== 232) colored++; }
      draws.push({ args, hash, colored });
    }
    return realDrawImage(source, ...args);
  };
  let surface, wheel;
  const h = uiHarness({ canvas: screen, platformOverrides: {
    createWebGLCanvas: () => null,
    createSurfaceCanvas: (width, height) => (surface = createCanvas(width, height)),
    wheel: fn => { wheel = fn; },
  } });
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy);
    await h.tap('cabin-board'); await h.scrollTo('topology-setup'); await h.tap('topology-setup');
    await h.scrollTo('topology-torus'); await h.tap('topology-torus'); await h.scrollTo('new-game'); await h.tap('new-game');
    await until(() => h.app.session.snapshot?.rulesVersion === 'surface-v1' && !h.app.session.busy);
    const before = h.app.session.stateHash;
    await h.render(); await h.tap('topology-3d');
    assert.ok(draws.at(-1)?.colored > 500, 'the composited secondary canvas contains a surface');
    await h.tap('surface-pause');
    const pausedCount = draws.length;
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(draws.length, pausedCount, 'paused preview does not keep scheduling frames');
    const [x, y, side] = draws.at(-1).args;
    const p = (dx, dy) => ({ clientX: x + side * dx, clientY: y + side * dy });
    const startHash = draws.at(-1).hash;
    h.p.callbacks.start({ touches: [p(.5, .5)] }); h.p.callbacks.move({ touches: [p(.7, .7)] });
    h.p.callbacks.end({ touches: [], changedTouches: [p(.7, .7)] }); await h.render();
    const rotatedHash = draws.at(-1).hash; assert.notEqual(rotatedHash, startHash);
    h.p.callbacks.start({ touches: [p(.4, .5), p(.6, .5)] }); h.p.callbacks.move({ touches: [p(.3, .5), p(.7, .5)] });
    h.p.callbacks.end({ touches: [], changedTouches: [p(.3, .5), p(.7, .5)] }); await h.render();
    const zoomHash = draws.at(-1).hash; assert.notEqual(zoomHash, rotatedHash);
    wheel({ ...p(.5, .5), deltaY: 300 }); await h.render(); assert.notEqual(draws.at(-1).hash, zoomHash);
    await h.tap('surface-back'); assert.equal(h.app.getScene(), 'game'); assert.equal(h.app.session.stateHash, before);
  } finally { h.app.dispose(); }
});

const browserPath = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
test('software surfaces render actual Canvas pixels with occlusion and rotation', { skip: !browserPath }, async () => {
  const bundle = await build({ entryPoints: ['src/topology-software-surface.js'], absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
    bundle: true, write: false, format: 'iife', globalName: 'surfaceAdapter', platform: 'browser', logLevel: 'silent' });
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const datasets = [];
    for (const preset of ['torus', 'double-torus', 'double-sphere']) {
      const result = useTopologyPreset(createTopologySetup(), preset, { gridSize: 7, playerCount: 2 });
      assert.equal(result.ok, true, JSON.stringify(result.errors));
      const engine = new GameEngine({ boardDefinition: result.setup.definition, rulesVersion: TopologyRulesVersion.SURFACE_V1, playerCount: 2 });
      const data = buildSurfaceCells(engine.getSnapshot());
      assert.equal(data.surface.kind, preset); assert.ok(data.cells.length); datasets.push(data);
    }
    const result = await page.evaluate((datasets) => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
      const renderer = surfaceAdapter.createSoftwareSurfaceRenderer(canvas), ctx = canvas.getContext('2d');
      const front = { player: 'BLACK', points: [[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]] };
      const back = { player: 'WHITE', points: [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1]] };
      const identity = p => p;
      const get = () => [...ctx.getImageData(128, 128, 1, 1).data];
      renderer.draw({ cells: [front, back], lines: [], nodes: [] }, 256, 256, identity, 1, {}, 1); const a = get();
      renderer.draw({ cells: [back, front], lines: [], nodes: [] }, 256, 256, identity, 1, {}, 1); const b = get();
      const hashes = datasets.map(data => {
        const render = angle => {
          renderer.draw(data, 256, 256, ([x,y,z]) => [x*Math.cos(angle)-z*Math.sin(angle), y, x*Math.sin(angle)+z*Math.cos(angle)], 1, {}, 1);
          const pixels = ctx.getImageData(0, 0, 256, 256).data; let hash = 2166136261, different = 0;
          for (let i = 0; i < pixels.length; i += 4) { hash = Math.imul(hash ^ pixels[i] ^ (pixels[i+1] << 8) ^ (pixels[i+2] << 16), 16777619); if (pixels[i] !== 246 || pixels[i+1] !== 241 || pixels[i+2] !== 232) different++; }
          return { hash, different };
        };
        return [render(0.3), render(1.1)];
      });
      return { a, b, hashes };
    }, datasets);
    assert.deepEqual(result.a, result.b, 'near surface wins regardless of drawing order');
    assert.ok(result.a[2] > result.a[0], 'front blue face occludes red back');
    for (const [first, second] of result.hashes) { assert.ok(first.different > 500); assert.notEqual(first.hash, second.hash); }
  } finally { await browser.close(); }
});
