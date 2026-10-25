// Actual board Canvas rendering, not a native-device acceptance test.
// node tools/render-starting-points.mjs <absolute @napi-rs/canvas module> <absolute output directory>
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { sut } from '../tests/helpers.mjs';

const [modulePath, output] = process.argv.slice(2);
if (!path.isAbsolute(modulePath || '') || !path.isAbsolute(output || '')) throw Error('Absolute module and output paths required');
const { createCanvas } = createRequire(import.meta.url)(modulePath);
await fs.mkdir(output, { recursive: true });
let seed = 0x2310;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
const adjacent = { BLACK: [14, 14], WHITE: [15, 14], PURPLE: [16, 14], GREEN: [14, 15], ORANGE: [15, 15], CYAN: [16, 15] };
const scenes = [
  { id: 'triangle-default-2p', gridSize: 7, playerCount: 2, boardShape: 'triangle' },
  { id: 'triangle-random-3p', gridSize: 7, playerCount: 3, boardShape: 'triangle', random: true },
  { id: 'hexagon-random-6p', gridSize: 15, playerCount: 6, boardShape: 'hexagon', random: true },
  { id: 'hexagon-adjacent-6p', gridSize: 15, playerCount: 6, boardShape: 'hexagon', initialPositions: adjacent },
  { id: 'hexagon-adjacent-zoom', gridSize: 15, playerCount: 6, boardShape: 'hexagon', initialPositions: adjacent, zoom: true },
  { id: 'triangle-random-replay', gridSize: 7, playerCount: 3, boardShape: 'triangle', random: true, replay: true },
];
const sheet = createCanvas(320 * 3 * 2, 360 * 2 * 2), sheetContext = sheet.getContext('2d'), records = [];
for (const [index, scene] of scenes.entries()) {
  const initialPositions = scene.random ? sut.randomInitialPositions(scene.gridSize, scene.playerCount, random, scene.boardShape) : scene.initialPositions;
  const engine = new sut.GameEngine({ ...sut.settingsFor(scene.gridSize, scene.playerCount), boardShape: scene.boardShape, initialPositions });
  const actions = [];
  for (let turn = 0; turn < 4; turn++) {
    const point = engine.getLegalMoves()[0]?.point;
    const action = point ? { type: 'move', player: engine.currentPlayer, point } : { type: 'skip', player: engine.currentPlayer };
    if (!sut.applyAction(engine, action).success) throw Error('Invalid render fixture');
    actions.push(action);
  }
  const snapshot = scene.replay ? sut.restoreGame({ ...sut.settingsFor(scene.gridSize, scene.playerCount), boardShape: scene.boardShape, initialPositions }, actions.slice(0, 2)).getSnapshot() : engine.getSnapshot();
  const canvas = createCanvas(640, 720), ctx = canvas.getContext('2d'); ctx.scale(2, 2);
  ctx.fillStyle = '#ece7db'; ctx.fillRect(0, 0, 320, 360);
  ctx.fillStyle = '#244d3d'; ctx.font = 'bold 15px sans-serif'; ctx.fillText(scene.id, 15, 27);
  ctx.font = '12px sans-serif'; ctx.fillText('Canvas render / not a device screenshot', 15, 48);
  const rect = { x: 30, y: 82, width: 260, height: 234 };
  const layout = scene.zoom ? sut.focusBoardLayout(scene.gridSize, rect, [15, 14.5], 44, scene.playerCount, scene.boardShape)
    : sut.boardLayout(scene.gridSize, rect, scene.playerCount, scene.boardShape);
  ctx.save(); ctx.beginPath(); ctx.rect(12, 65, 296, 272); ctx.clip();
  sut.drawBoard(ctx, { ...snapshot, legalMoves: [] }, layout, { display: sut.DEFAULT_DISPLAY }); ctx.restore();
  const filename = `${scene.id}.png`; await fs.writeFile(path.join(output, filename), canvas.toBuffer('image/png'));
  sheetContext.drawImage(canvas, index % 3 * 640, Math.floor(index / 3) * 720);
  records.push({ id: scene.id, filename, initialPositions: snapshot.initialPositions, spacing: layout.spacing, players: snapshot.players });
}
await fs.writeFile(path.join(output, 'starting-points-sheet.png'), sheet.toBuffer('image/png'));
await fs.writeFile(path.join(output, 'renders.json'), JSON.stringify({ status: 'NODE_CANVAS_RENDERED_NOT_DEVICE_VERIFIED', records }, null, 2));
console.log(JSON.stringify({ status: 'NODE_CANVAS_RENDERED_NOT_DEVICE_VERIFIED', count: records.length, output }));
