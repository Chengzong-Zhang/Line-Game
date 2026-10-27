// Actual Canvas output; no browser or desktop automation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { uiHarness } from '../tests/ui-harness.mjs';
import { until } from '../tests/helpers.mjs';
import { MODEL_CATALOG } from '../src/model-catalog.js';
const [modulePath, output] = process.argv.slice(2);
if (!path.isAbsolute(modulePath || '') || !path.isAbsolute(output || '')) throw new Error('Absolute paths required');
const { createCanvas, GlobalFonts } = createRequire(import.meta.url)(modulePath);
if (process.platform === 'win32') GlobalFonts.registerFromPath('C:/Windows/Fonts/msyh.ttc', 'sans-serif');
await fs.mkdir(output, { recursive: true }); const records = [];
for (const [language, width, height, top] of [['zh', 390, 844, 88], ['en', 320, 568, 64]]) {
  const canvas = createCanvas(width * 2, height * 2), h = uiHarness({ language, width, height, top, canvas });
  const { app, p, tap, render } = h;
  p.loadSubpackage = async (_, progress) => progress(100);
  p.readAsset = async filePath => {
    const model = MODEL_CATALOG.find(model => model.assetPath === filePath);
    const data = await fs.readFile(new URL(`../${model.sourcePath}`, import.meta.url));
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  };
  const save = async name => { await render(); const filename = `${language}-${name}.png`;
    await fs.writeFile(path.join(output, filename), canvas.toBuffer('image/png'));
    records.push({ filename, width: canvas.width, height: canvas.height, kind: 'NODE_CANVAS_RENDER_NOT_DEVICE_SCREENSHOT' }); };
  try {
    await render(); await tap('settings'); await tap('players-setup'); p.choose = async () => 5;
    await tap('controller-WHITE'); await save('research-models'); await tap('models-policy'); await save('policy-models');
    await tap('model-dqn-all-sizes-e2000'); await save('players'); await tap('players-start');
    await until(() => app.session.canPlay()); await app.session.act({ type: 'move', point: [1, 0] }); await until(() => !app.session.busy);
    await app.session.replay(0); await render(); await tap('replay-options'); await tap('tool-analyzeReplay');
    await until(() => !app.session.busy); await save('rule-analysis');
    p.choose = async () => 4; await tap('analysis-choose'); await tap('models-policy'); await tap('model-dqn-all-sizes-e2000');
    await until(() => !app.session.busy); await save('model-analysis');
    let release;
    p.loadSubpackage = (_, progress) => { progress(42); return new Promise(resolve => { release = resolve; }); };
    p.choose = async () => 4; await tap('analysis-choose'); await tap('models-policy'); await tap('model-ppo-all-sizes-e2000');
    await until(() => release); await save('loading'); app.session.pause(); release();
  } finally { app.dispose(); }
}
await fs.writeFile(path.join(output, 'renders.json'), JSON.stringify({ status: 'NODE_CANVAS_RENDERED_NOT_DEVICE_VERIFIED', records }, null, 2));
console.log(JSON.stringify({ status: 'NODE_CANVAS_RENDERED_NOT_DEVICE_VERIFIED', count: records.length, output }));
