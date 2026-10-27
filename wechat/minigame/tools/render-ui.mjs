// Renders the actual Canvas drawing code without a browser or WeChat UI.
// Usage: node tools/render-ui.mjs <absolute @napi-rs/canvas module path> <output directory>
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { uiHarness } from '../tests/ui-harness.mjs';
import { until, sut } from '../tests/helpers.mjs';

const [modulePath, outputDirectory] = process.argv.slice(2);
if (!path.isAbsolute(modulePath || '') || !path.isAbsolute(outputDirectory || '')) throw new Error('Absolute module and output paths required');
const { createCanvas, GlobalFonts } = createRequire(import.meta.url)(modulePath);
if (process.platform === 'win32') GlobalFonts.registerFromPath('C:/Windows/Fonts/msyh.ttc', 'sans-serif');
await fs.mkdir(outputDirectory, { recursive: true });
const records = [];
for (const [language, width, height, top] of [['zh', 390, 844, 88], ['en', 320, 568, 64]]) {
  const canvas = createCanvas(width * 2, height * 2);
  const h = uiHarness({ width, height, top, language, canvas }), { app, tap, render } = h;
  const images = [];
  const save = async scene => {
    await render();
    const image = createCanvas(canvas.width, canvas.height); image.getContext('2d').drawImage(canvas, 0, 0); images.push({ scene, image });
    const filename = `${language}-${scene}.png`; await fs.writeFile(path.join(outputDirectory, filename), canvas.toBuffer('image/png'));
    records.push({ filename, width: canvas.width, height: canvas.height, kind: 'NODE_CANVAS_RENDER_NOT_DEVICE_SCREENSHOT' });
  };
  try {
    await render(); await save('home');
    await tap('settings'); await tap('mode-three-human'); await save('setup');
    await tap('home'); await tap('learn'); await save('lessons');
    await tap('home'); await tap('new-game'); await until(() => app.session.snapshot && !app.session.busy);
    await app.session.newGame(5, 'human', 'easy', 3);
    for (const point of [[1, 0], [0, 2], [3, 1], [1, 2], [1, 3]]) await app.session.act({ type: 'move', point });
    await save('three-player');
    await tap('home'); await tap('library'); await tap('save-replay'); await save('library');
    await tap('home'); await tap('continue'); await app.session.replay(2); await save('replay');
    const sheet = createCanvas(width * 3, (height + 34) * 2), ctx = sheet.getContext('2d');
    ctx.fillStyle = '#e5e8de'; ctx.fillRect(0, 0, sheet.width, sheet.height);
    images.forEach(({ scene, image }, index) => {
      const x = index % 3 * width, y = Math.floor(index / 3) * (height + 34);
      ctx.fillStyle = '#244d3d'; ctx.font = '14px sans-serif'; ctx.fillText(`0.2.0 · ${language} · ${scene} · Canvas`, x + 12, y + 22);
      ctx.drawImage(image, x, y + 34, width, height);
    });
    await fs.writeFile(path.join(outputDirectory, `${language}-overview.png`), sheet.toBuffer('image/png'));
  } finally { app.dispose(); }
}
await fs.writeFile(path.join(outputDirectory, 'renders.json'), JSON.stringify({ status: 'NODE_CANVAS_RENDERED_NOT_DEVICE_VERIFIED', records }, null, 2));
console.log(JSON.stringify({ status: 'NODE_CANVAS_RENDERED_NOT_DEVICE_VERIFIED', count: records.length, outputDirectory }));
