// Actual Canvas rasterization and full reader layout checks; no browser/device UI.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { uiHarness } from '../tests/ui-harness.mjs';
import { help, sut, until } from '../tests/helpers.mjs';
import { readerLayout } from '../src/help-ui.js';
const [modulePath, output] = process.argv.slice(2);
if (!path.isAbsolute(modulePath || '') || !path.isAbsolute(output || '')) throw Error('Absolute paths required');
const { createCanvas, GlobalFonts } = createRequire(import.meta.url)(modulePath);
if (process.platform === 'win32') GlobalFonts.registerFromPath('C:/Windows/Fonts/msyh.ttc', 'sans-serif');
await fs.mkdir(output, { recursive: true });
const records = [], readerChecks = [];
for (const [language, width, height, top] of [['zh', 390, 844, 88], ['en', 320, 568, 64]]) {
  const canvas = createCanvas(width * 2, height * 2), h = uiHarness({ canvas, language, width, height, top });
  const { app, p, tap, render } = h;
  const save = async name => {
    await render(); const filename = `${language}-${name}.png`;
    await fs.writeFile(path.join(output, filename), canvas.toBuffer('image/png'), { flag: 'wx' });
    records.push({ filename, width: canvas.width, height: canvas.height, kind: 'NODE_CANVAS_NOT_DEVICE_SCREENSHOT' });
  };
  try {
    const ctx = canvas.getContext('2d');
    for (const kind of ['rules', 'controls', 'privacy', 'credits']) {
      const sections = help.helpDocument(kind, language, true);
      const layout = readerLayout({ ctx, top: top + 72, metrics: p.metrics() }, sections);
      for (const page of layout.pages) {
        ctx.font = '19px sans-serif'; assert.ok(ctx.measureText(page.title).width <= width - 48, page.title);
        ctx.font = '15px sans-serif';
        page.lines.forEach((line, i) => {
          assert.ok(ctx.measureText(line).width <= width - 64 + 0.01, line);
          assert.ok(layout.y + i * 23 + 12 < layout.footer, 'Body overlaps footer');
        });
      }
      for (const section of sections) assert.equal(layout.pages.filter(page => page.id === section.id).flatMap(page => page.lines).join('').replace(/\s/g, ''),
        section.paragraphs.join('').replace(/\s/g, ''));
      readerChecks.push({ language, width, height, kind, pages: layout.pages.length, textComplete: true, textFits: true });
    }
    await render(); await tap('about'); await save('help');
    await tap('help-rules'); await save('rules-first');
    while (!app.getButtons().find(b => b.id === 'reader-next').disabled) await tap('reader-next');
    await save('rules-last');
    await tap('reader-back'); await tap('help-credits'); await save('credits');
    while (!app.getButtons().find(b => b.id === 'reader-next').disabled) await tap('reader-next');
    await save('credits-last');
    await tap('reader-back'); await tap('help-privacy'); await save('privacy');
    await tap('home'); await tap('new-game'); await until(() => app.session.snapshot && !app.session.busy);
    for (const [name, settings, actions] of [
      ['result-resign', sut.settingsFor(6, 3), [{ type: 'resign', player: 'WHITE' }, { type: 'resign', player: 'BLACK' }]],
      ['result-tie', sut.settingsFor(6, 3), [{ type: 'skip' }, { type: 'skip' }, { type: 'skip' }]],
      ['result-score', sut.settingsFor(6), [...sut.TUTORIAL_LEVELS[1].prefix, sut.TUTORIAL_LEVELS[1].objective, { type: 'skip' }, { type: 'skip' }]],
    ]) {
      await app.session.load(settings, actions, { mode: 'human', paused: true }); await render();
      await tap('result-detail'); await save(name); await tap('result-back');
    }
  } finally { app.dispose(); }
}
await fs.writeFile(path.join(output, 'renders.json'), JSON.stringify({ status: 'NODE_CANVAS_RENDERED_NOT_DEVICE_VERIFIED', records, readerChecks }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ status: 'NODE_CANVAS_RENDERED_NOT_DEVICE_VERIFIED', count: records.length, readerChecks, output }));
