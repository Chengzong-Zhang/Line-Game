// Native Canvas renders for layout review; these are not WeChat device captures.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { uiHarness } from '../tests/ui-harness.mjs';
import { sut } from '../tests/helpers.mjs';
const [modulePath, output] = process.argv.slice(2);
if (!path.isAbsolute(modulePath || '') || !path.isAbsolute(output || '')) throw new Error('Absolute paths required');
const { createCanvas, GlobalFonts } = createRequire(import.meta.url)(modulePath);
if (process.platform === 'win32') GlobalFonts.registerFromPath('C:/Windows/Fonts/msyh.ttc', 'sans-serif');
await fs.mkdir(output, { recursive: true });
const records = [];
for (const [language, width, height, top, count] of [['zh', 390, 844, 88, 3], ['en', 320, 568, 64, 3], ['zh', 320, 568, 64, 6]]) {
  const canvas = createCanvas(width * 2, height * 2), h = uiHarness({ language, width, height, top, canvas });
  try {
    await h.render();
    const settings = sut.settingsFor(5, count), engine = sut.restoreGame(settings, []), actions = [];
    for (let index = 0; index < 3; index++) {
      const point = engine.getSnapshot().legalMoves[0].point;
      engine.playMove(point); actions.push({ type: 'move', point });
    }
    await h.app.session.load(settings, actions, { mode: 'human', paused: true });
    await h.app.session.replay(1); await h.render();
    const filename = `${language}-${count}p-${width}x${height}-replay.png`;
    await fs.writeFile(path.join(output, filename), canvas.toBuffer('image/png'));
    records.push({ filename, buttons: h.app.getButtons(), width, height, count });
  } finally { h.app.dispose(); }
}
await fs.writeFile(path.join(output, 'renders.json'), JSON.stringify({ status: 'NODE_CANVAS_RENDERED_NOT_DEVICE_VERIFIED', records }, null, 2));
console.log(JSON.stringify({ status: 'NODE_CANVAS_RENDERED_NOT_DEVICE_VERIFIED', output, renders: records.length }));
