// Actual Canvas drawing; no browser or native desktop automation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { uiHarness } from '../tests/ui-harness.mjs';
import { until } from '../tests/helpers.mjs';
const [modulePath, output] = process.argv.slice(2);
if (!path.isAbsolute(modulePath || '') || !path.isAbsolute(output || '')) throw new Error('Absolute paths required');
const { createCanvas, GlobalFonts } = createRequire(import.meta.url)(modulePath);
if (process.platform === 'win32') GlobalFonts.registerFromPath('C:/Windows/Fonts/msyh.ttc', 'sans-serif');
await fs.mkdir(output, { recursive: true }); const records = [];
for (const [language, width, height, top] of [['zh', 390, 844, 88], ['en', 320, 568, 64]]) {
  const canvas = createCanvas(width * 2, height * 2), h = uiHarness({ language, width, height, top, canvas });
  const { app, p, tap, render } = h;
  const save = async name => { await render(); const filename = `${language}-${name}.png`;
    await fs.writeFile(path.join(output, filename), canvas.toBuffer('image/png'));
    records.push({ filename, width: canvas.width, height: canvas.height, kind: 'NODE_CANVAS_RENDER_NOT_DEVICE_SCREENSHOT' }); };
  try {
    await render(); await tap('settings'); await tap('mode-human'); await save('settings');
    await tap('play-options'); await tap('timer-toggle'); p.input = async () => '45'; await tap('timer-duration');
    await tap('hints-minus'); await save('options');
    await tap('options-start'); await until(() => app.session.canPlay()); await save('clock');
    await app.session.act({ type: 'move', point: [1, 0] }); await save('clock-move');
  } finally { app.dispose(); }
}
await fs.writeFile(path.join(output, 'renders.json'), JSON.stringify({ status: 'NODE_CANVAS_RENDERED_NOT_DEVICE_VERIFIED', records }, null, 2));
console.log(JSON.stringify({ status: 'NODE_CANVAS_RENDERED_NOT_DEVICE_VERIFIED', count: records.length, output }));
