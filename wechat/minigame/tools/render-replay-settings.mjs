// Actual Canvas rendering only; no browser/native UI automation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { uiHarness } from '../tests/ui-harness.mjs';
import { until, sut } from '../tests/helpers.mjs';
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
    await render(); await tap('settings'); await save('settings'); await tap('players-setup');
    p.choose = async () => 4; await tap('controller-BLACK'); p.choose = async () => 2; await tap('controller-WHITE');
    await tap('starter-WHITE'); await save('players');
    await tap('home'); await tap('settings'); await tap('mode-three-human'); await tap('players-setup'); await tap('starter-PURPLE');
    await save('three-starter'); await tap('players-start'); await until(() => app.session.snapshot && !app.session.busy);
    await app.session.load(sut.settingsFor(5, 3), [{ type: 'move', point: [1, 0] }, { type: 'move', point: [0, 2] }, { type: 'move', point: [3, 1] }], { mode: 'human', paused: true });
    await app.session.replay(2); await save('replay');
    await tap('replay-options'); await tap('tool-inspectReplay'); await until(() => p.messages.length > 0);
    await fs.writeFile(path.join(output, `${language}-inspector-text.txt`), p.messages.at(-1));
  } finally { app.dispose(); }
}
await fs.writeFile(path.join(output, 'renders.json'), JSON.stringify({ status: 'NODE_CANVAS_RENDERED_NOT_DEVICE_VERIFIED', records }, null, 2));
console.log(JSON.stringify({ status: 'NODE_CANVAS_RENDERED_NOT_DEVICE_VERIFIED', count: records.length, output }));
