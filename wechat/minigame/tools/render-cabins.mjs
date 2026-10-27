// Actual Canvas drawing without browser or desktop automation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { uiHarness } from '../tests/ui-harness.mjs';
import { until } from '../tests/helpers.mjs';

const [modulePath, output] = process.argv.slice(2);
if (!path.isAbsolute(modulePath || '') || !path.isAbsolute(output || '')) throw Error('Absolute paths required');
const { createCanvas, GlobalFonts } = createRequire(import.meta.url)(modulePath);
if (process.platform === 'win32') { GlobalFonts.registerFromPath('C:/Windows/Fonts/msyh.ttc', 'sans-serif'); GlobalFonts.registerFromPath('C:/Windows/Fonts/seguiemj.ttf', 'Emoji'); }
await fs.mkdir(output, { recursive: true });
const records = [];
for (const [language, width, height, top] of [['zh', 390, 844, 88], ['zh', 320, 568, 64], ['en', 390, 844, 88], ['en', 320, 568, 64]]) {
  const canvas = createCanvas(width * 2, height * 2), h = uiHarness({ language, width, height, top, canvas });
  const save = async name => {
    await h.render();
    const filename = `${language}-${width}-${name}.png`;
    await fs.writeFile(path.join(output, filename), canvas.toBuffer('image/png'));
    records.push({ filename, width, height, kind: 'ACTUAL_CANVAS_RENDER_NOT_DEVICE_SCREENSHOT' });
  };
  try {
    await until(() => h.app.session.snapshot && !h.app.session.busy);
    await save('stage');
    for (const cabin of ['board', 'battle', 'guide', 'tutorial']) {
      await h.tap(`cabin-${cabin}`); await save(cabin); await h.tap('cabin-close');
    }
    await h.tap('cabin-tutorial'); await h.tap('lesson-0');
    await until(() => !h.app.session.busy && h.app.session.tutorial);
    await save('lesson');
  } finally { h.app.dispose(); }
}
await fs.writeFile(path.join(output, 'renders.json'), JSON.stringify({ status: 'CANVAS_RENDERED_NOT_PHONE_VERIFIED', records }, null, 2));
console.log(JSON.stringify({ status: 'CANVAS_RENDERED_NOT_PHONE_VERIFIED', count: records.length, output }));
