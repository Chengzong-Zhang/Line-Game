// Node Canvas/Worker evidence only. This is NOT WeChat device latency.
// node tools/benchmark-render-perf.mjs <frozen baseline dir> <output.json> <absolute @napi-rs/canvas module>
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { sut } from '../tests/helpers.mjs';
import { renderPerfFixtures } from '../tests/render-perf-fixtures.mjs';
const [baselinePath, outputPath, canvasModule] = process.argv.slice(2);
const drawingOnly = process.argv.includes('--drawing-only');
if (!baselinePath || !outputPath || !path.isAbsolute(canvasModule || '')) throw Error('Baseline, output and absolute Canvas module are required');
const baseline = path.resolve(baselinePath), output = path.resolve(outputPath);
const oldBoard = await import(pathToFileURL(path.join(baseline, 'board.mjs')));
const oldScheduler = await import(pathToFileURL(path.join(baseline, 'scheduler.mjs')));
const { createCanvas } = createRequire(import.meta.url)(canvasModule);
const sha = value => createHash('sha256').update(value).digest('hex');
const fixtureFile = path.join(baseline, '../fixtures.json');
let fixtures;
try { fixtures = JSON.parse(await fs.readFile(fixtureFile, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  fixtures = renderPerfFixtures(sut); await fs.writeFile(fixtureFile, JSON.stringify(fixtures));
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const summaries = [], equivalence = [];
function commands(draw, snapshot, layout, options) {
  const calls = [], ctx = new Proxy({}, { get: (_, key) => (...args) => calls.push([key, ...args]),
    set: (_, key, value) => { calls.push(['=', key, value]); return true; } });
  draw(ctx, snapshot, layout, options); return calls;
}
function canvasDraw(draw, snapshot, layout, options, canvas, dpr) {
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#eee9dd'; ctx.fillRect(0, 0, 390, 844); draw(ctx, snapshot, layout, options);
}
for (const fixture of fixtures) {
  const snapshot = structuredClone(fixture.snapshot);
  const full = sut.boardLayout(snapshot.gridSize, { x: 30, y: 300, width: 330, height: 410 }, snapshot.players.length, snapshot.boardShape);
  const zoom = sut.focusBoardLayout(snapshot.gridSize, { x: 30, y: 300, width: 330, height: 410 }, [3, 4], 44, snapshot.players.length, snapshot.boardShape);
  for (const [view, layout] of [['full', full], ['zoom', zoom]]) {
    for (const highContrast of [false, true]) {
      const effects = { addedEdgesByPlayer: snapshot.edges, capturedPoints: [[1, 2]] };
      const options = { display: { ...sut.DEFAULT_DISPLAY, coordinates: true, highContrast },
        selected: [3, 4], hint: [4, 4], target: [2, 3], blocked: [1, 2], lastMove: [2, 3], effects };
      for (const dpr of [1, 2]) {
        const a = createCanvas(390 * dpr, 844 * dpr), b = createCanvas(390 * dpr, 844 * dpr);
        assert.deepEqual(commands(oldBoard.drawBoard, snapshot, layout, options), commands(sut.drawBoard, snapshot, layout, options));
        canvasDraw(oldBoard.drawBoard, snapshot, layout, options, a, dpr); canvasDraw(sut.drawBoard, snapshot, layout, options, b, dpr);
        const before = a.getContext('2d').getImageData(0, 0, a.width, a.height).data;
        const after = b.getContext('2d').getImageData(0, 0, b.width, b.height).data;
        assert.equal(Buffer.compare(Buffer.from(before), Buffer.from(after)), 0);
        equivalence.push({ fixture: fixture.id, view, highContrast, dpr, rgbaSha256: sha(before), commandsEqual: true });
      }
    }
  }
  // Same snapshot object and revision with changed nested content must be read.
  const player = snapshot.players[0];
  snapshot.territories[player].polygon = [[0.5, 0.25], [1.25, 2.5], [3, 4]];
  snapshot.edges[player] = ['0,0|0.5,0.25']; snapshot.boardMatrix[0][0] = 3;
  snapshot.legalMoves = [{ point: [1, 1] }];
  const options = { display: { ...sut.DEFAULT_DISPLAY, highContrast: true } };
  assert.deepEqual(commands(oldBoard.drawBoard, snapshot, full, options), commands(sut.drawBoard, snapshot, full, options));
  for (let i = 0; i < 20; i++) {
    const layout = { ...zoom, left: zoom.left + i * 0.125, bottom: zoom.bottom - i * 0.2 };
    for (const p of [[0, 0], [100.5, 350.25], [195, 422], [390, 844]]) assert.deepEqual(sut.hitPoint(...p, layout), oldBoard.hitPoint(...p, layout));
    assert.deepEqual(commands(oldBoard.drawBoard, snapshot, layout, options), commands(sut.drawBoard, snapshot, layout, options));
  }
  const canvas = createCanvas(780, 1688), measures = { before: [], after: [], hitBefore: [], hitAfter: [] };
  const plain = fixture.snapshot, drawOptions = { display: sut.DEFAULT_DISPLAY };
  const measure = (callback, count) => { const begin = performance.now(); for (let i = 0; i < count; i++) callback(i); return (performance.now() - begin) / count; };
  for (let sample = -2; sample < 9; sample++) {
    for (const key of sample % 2 ? ['after', 'before'] : ['before', 'after']) {
      const board = key === 'before' ? oldBoard : sut;
      const elapsed = measure(() => canvasDraw(board.drawBoard, plain, full, drawOptions, canvas, 2), 20);
      const hit = measure(i => board.hitPoint(130 + i % 70, 350 + i % 100, full), 300);
      if (sample >= 0) { measures[key].push(elapsed); measures[key === 'before' ? 'hitBefore' : 'hitAfter'].push(hit); }
    }
  }
  summaries.push({ fixture: fixture.id, drawingMs: { before: median(measures.before), after: median(measures.after) },
    hitPointMs: { before: median(measures.hitBefore), after: median(measures.hitAfter) }, samples: measures });
}
// Same bundled Worker, messages and rule engine for both schedulers. Only idle
// cancellation differs; first-start and warm-state measurements are separate.
const workerRuns = [], workerResults = {};
for (let round = 0; round < (drawingOnly ? 0 : 3); round++) for (const variant of round % 2 ? ['after', 'before'] : ['before', 'after']) {
  let starts = 0;
  const exits = [], samples = [], resultHashes = [];
  const Type = variant === 'before' ? oldScheduler.ComputeScheduler : sut.ComputeScheduler;
  const scheduler = new Type(() => {
    starts++;
    const thread = new Worker(new URL('../tests/render-perf-worker.mjs', import.meta.url), { workerData: { source: path.join(baseline, 'worker.js') } });
    return { postMessage: message => thread.postMessage(message), onMessage: fn => thread.on('message', fn),
      onError: fn => thread.on('error', fn), terminate: () => { exits.push(thread.terminate()); } };
  }, { timeoutMs: 15000 });
  try {
    const fixture = fixtures[0];
    for (let turn = 0; turn < 8; turn++) {
      const begin = performance.now(); scheduler.cancel({ keepIdle: true });
      const result = await scheduler.request('STATE', { settings: fixture.settings, actions: fixture.actions.slice(0, turn) },
        { epoch: turn + 1, revision: turn, rulesVersion: fixture.settings.rulesVersion });
      samples.push(performance.now() - begin); resultHashes.push(sha(JSON.stringify(result)));
    }
  } finally { scheduler.cancel(); await Promise.allSettled(exits); }
  const key = String(round); if (workerResults[key]) assert.deepEqual(resultHashes, workerResults[key]); else workerResults[key] = resultHashes;
  workerRuns.push({ variant, round, starts, firstRequestMs: samples[0], subsequentMedianMs: median(samples.slice(1)), samples, resultHashes });
}
const candidateHashes = {};
for (const name of ['board', 'scheduler', 'session']) candidateHashes[`wechat/minigame/src/${name}.js`] = sha(await fs.readFile(new URL(`../src/${name}.js`, import.meta.url)));
const report = { status: drawingOnly ? 'PASS_NODE_CANVAS_NOT_WECHAT_DEVICE' : 'PASS_NODE_CANVAS_AND_NODE_WORKER_NOT_WECHAT_DEVICE', recordedAtUtc: new Date().toISOString(), candidateHashes,
  node: process.version, fixtureSha256: sha(await fs.readFile(fixtureFile)), baselineHashes: JSON.parse((await fs.readFile(path.join(baseline, 'source-hashes.json'), 'utf8')).replace(/^\uFEFF/, '')),
  exactCanvasCases: equivalence.length, sameObjectMutationAndPanChecks: true, equivalence, drawing: summaries, workers: workerRuns,
  bounds: ['Desktop Node Canvas is not browser Canvas or WeChat Canvas.', 'Node worker_threads is not wx.createWorker.', 'No AI settings or engine code changed.'] };
await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, exactCanvasCases: report.exactCanvasCases, drawing: summaries.map(({ samples, ...rest }) => rest),
  workers: workerRuns.map(({ samples, resultHashes, ...rest }) => rest), output }));
