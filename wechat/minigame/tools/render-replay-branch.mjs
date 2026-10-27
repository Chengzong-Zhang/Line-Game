// Real Canvas rasterization, without operating a browser or device UI.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { uiHarness } from '../tests/ui-harness.mjs';
import { sut, until } from '../tests/helpers.mjs';
const [modulePath, output] = process.argv.slice(2);
if (!path.isAbsolute(modulePath || '') || !path.isAbsolute(output || '')) throw Error('Absolute paths required');
const { createCanvas, GlobalFonts } = createRequire(import.meta.url)(modulePath);
if (process.platform === 'win32') GlobalFonts.registerFromPath('C:/Windows/Fonts/msyh.ttc', 'sans-serif');
await fs.mkdir(output, { recursive: true });
const records = [];
for (const [language, width, height, top] of [['zh', 390, 844, 88], ['en', 320, 568, 64]]) {
  const canvas = createCanvas(width * 2, height * 2), h = uiHarness({ canvas, language, width, height, top });
  const { app, p, tap, render } = h;
  const save = async name => {
    await render(); const filename = `${language}-${name}.png`;
    await fs.writeFile(path.join(output, filename), canvas.toBuffer('image/png'), { flag: 'wx' });
    records.push({ filename, width: canvas.width, height: canvas.height, kind: 'NODE_CANVAS_NOT_DEVICE_SCREENSHOT' });
  };
  try {
    await render(); await tap('new-game'); await until(() => app.session.snapshot && !app.session.busy);
    const level = sut.TUTORIAL_LEVELS.find(level => level.id === 'L3-cut-and-clear');
    await app.session.load({ ...sut.settingsFor(level.gridSize), startPlayer: level.startPlayer }, [...level.prefix, level.objective],
      { mode: 'ai-white', controllers: { BLACK: 'human', WHITE: 'minimax-3' }, paused: true });
    await app.session.replay(app.session.actions.length); await render(); await tap('replay-options'); await save('tools');
    await tap('tool-inspectReplay'); await until(() => !app.session.busy); await save('inspected-cut');
    await tap('display-open'); await tap('display-highContrast'); await tap('display-coordinates'); await save('display');
    await tap('display-back');
    if (app.getButtons().some(button => button.id === 'board-zoom')) await tap('board-zoom');
    await save('coordinates');
    await app.session.replay(level.prefix.length); await render(); await tap('replay-options'); await tap('tool-branchReplay'); await tap('branch-keep'); await save('branch');
    await tap('branch-start'); await until(() => app.getScene() === 'game'); await save('branch-paused');
  } finally { app.dispose(); }
}
await fs.writeFile(path.join(output, 'renders.json'), JSON.stringify({ status: 'NODE_CANVAS_RENDERED_NOT_DEVICE_VERIFIED', records }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ status: 'NODE_CANVAS_RENDERED_NOT_DEVICE_VERIFIED', count: records.length, output }));
