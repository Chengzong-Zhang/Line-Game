// Real Canvas rasterization of the rule reader; this does not operate a browser or device.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { GUIDE_ASSETS, GUIDE_EDITIONS } from '../src/guide-assets.js';
import { drawReader, readerLayout } from '../src/help-ui.js';
import { TEXT } from '../src/i18n.js';
const [modulePath, output] = process.argv.slice(2);
if (!path.isAbsolute(modulePath || '') || !path.isAbsolute(output || '')) throw Error('Absolute module/output paths required');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), repo = path.resolve(root, '../..');
const { createCanvas, loadImage, GlobalFonts } = createRequire(import.meta.url)(modulePath);
if (process.platform === 'win32') GlobalFonts.registerFromPath('C:/Windows/Fonts/msyh.ttc', 'sans-serif');
const bundled = await build({ entryPoints: [path.join(root, 'src/help-content.js')], bundle: true,
  format: 'esm', platform: 'node', loader: { '.md': 'text' }, write: false });
const { helpDocument } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const images = new Map();
for (const asset of GUIDE_ASSETS) images.set(asset.path, await loadImage(path.join(repo, 'web/web前端/guide/guide-images', asset.source)));
await fs.mkdir(output, { recursive: true });
const records = [], checks = [];
for (const [language, width, height, safeTop] of [['zh', 390, 844, 88], ['en', 320, 568, 64]]) {
  const canvas = createCanvas(width * 2, height * 2), ctx = canvas.getContext('2d'), top = safeTop + 72;
  let buttons = [];
  const text = (value, x, y, font = 16, color = '#244d3d', align = 'left', weight = '') => {
    ctx.font = `${weight} ${font}px sans-serif`.trim(); ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'middle';
    const size = ctx.measureText(String(value)).width;
    assert.ok(size <= width - 32 + .1, `Text exceeds screen: ${value}`);
    ctx.fillText(String(value), x, y);
  };
  const rect = (x, y, w, h, radius = 12, color = '#fffef9') => {
    ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x, y, w, h, radius); ctx.fill();
  };
  const ui = { ctx, language, top, metrics: { width, height, bottom: 24 }, text, rect,
    label: key => TEXT[language][key], guideImages: { get: asset => ({ status: 'ready', image: images.get(asset) }) },
    button(id, title, x, y, w, action, options = {}) {
      const h = options.height || 48;
      rect(x, y, w, h, 12, options.disabled ? '#e5e8de' : options.primary ? '#244d3d' : '#fffef9');
      text(title, x + w / 2, y + h / 2, language === 'en' ? 14 : 16, options.primary ? '#fffef9' : '#244d3d', 'center');
      buttons.push({ id, x, y, w, h });
    },
  };
  function clear() {
    buttons = []; ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.fillStyle = '#f4f3e9'; ctx.fillRect(0, 0, width, height);
    text('LIFELINE', 24, safeTop + 28, 24, '#244d3d', 'left', 'bold');
  }
  const save = async name => {
    const filename = `${language}-${name}.png`;
    for (const b of buttons) assert.ok(b.x >= 0 && b.x + b.w <= width && b.y >= 0 && b.y + b.h <= height - 24, b.id);
    await fs.writeFile(path.join(output, filename), canvas.toBuffer('image/png'), { flag: 'wx' });
    records.push({ filename, width, height, evidence: 'NODE_CANVAS_NOT_DEVICE_SCREENSHOT' });
  };
  const actions = { page() {}, back() {}, select() {}, contents() {}, practice() {} };
  // The guide cabin now scrolls inside the app. This isolated tool checks the
  // reader only; it must not recreate the removed help hub or a clipped cabin.
  for (const edition of GUIDE_EDITIONS) {
    const sections = helpDocument(edition.kind, language), layout = readerLayout(ui, sections);
    let drawnPages = 0;
    for (let page = 0; page < layout.pages.length; page++) {
      clear(); drawReader(ui, { sections, kind: edition.kind, page, canPractice: true }, actions);
      if (page === 0 || (layout.pages[page].image && drawnPages === 1)
        || (edition.kind === 'rules-essential' && layout.pages[page].id.startsWith('multiplayer-'))) {
        await save(`${edition.kind}-${page}`); drawnPages++;
      }
    }
    checks.push({ language, width, height, kind: edition.kind, pages: layout.pages.length, font: layout.font,
      lineHeight: layout.lineHeight, allPagesRasterized: true });
  }
}
await fs.writeFile(path.join(output, 'renders.json'), `${JSON.stringify({ status: 'CANVAS_RULE_READER_RENDERED_NOT_WECHAT_VERIFIED', records, checks }, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ status: 'CANVAS_RULE_READER_RENDERED_NOT_WECHAT_VERIFIED', images: records.length, checks, output }));
