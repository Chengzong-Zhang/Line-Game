// Run `npm run build` first, then `node tools/check-desktop-input.mjs`.
// Real browser mouse input drives dist/game.js through the simulated native wx
// mouse bridge. The probe is read-only; there is no app.tap or state mutation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { gameRoot, startOfflineServer } from './offline-server.mjs';

const repo = path.resolve(gameRoot, '../..');
const output = path.join(repo, 'local_artifacts/ui-adaptation-20261026');
await fs.mkdir(output, { recursive: true });
const receipt = path.join(output, 'desktop-input-browser.json');
const report = {
  status: 'RUNNING', startedAt: new Date().toISOString(), checks: [], screenshots: [],
  scope: 'Headless browser; compiled production game and Worker; simulated wx API; native browser mouse and wheel events.',
  notVerified: ['Windows/Mac WeChat client', 'Physical touchscreen', 'Native WeChat wheel direction', 'Upload or release'],
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const persist = () => fs.writeFile(receipt, JSON.stringify(report, null, 2) + '\n');
const observe = page => page.evaluate(() => window.offlineProbe.read());
let host, browser, page;

async function launch() {
  const failures = [];
  for (const channel of process.platform === 'win32' ? ['msedge', 'chrome'] : ['chrome', 'chromium']) {
    try { browser = await chromium.launch({ channel, headless: true }); report.channel = channel; return; }
    catch (error) { failures.push(`${channel}: ${error.message.split('\n')[0]}`); }
  }
  throw new Error(`No supported browser: ${failures.join('; ')}`);
}
async function check(name, action) {
  await action(); report.checks.push({ name, status: 'PASS' }); await persist();
}
async function waitLabel(prefix) {
  await page.waitForFunction(prefix => window.offlineProbe.read().texts.some(item => item.text.startsWith(prefix)), prefix);
  return (await observe(page)).texts.findLast(item => item.text.startsWith(prefix));
}
async function screen(logical) {
  const box = await page.locator('#game').boundingBox(), { metrics } = await observe(page);
  assert.ok(box, 'Canvas must be visible');
  return { x: box.x + logical.x * box.width / metrics.width, y: box.y + logical.y * box.height / metrics.height };
}
async function clickLabel(text) {
  const label = await waitLabel(text), point = await screen(label);
  await page.mouse.click(point.x, point.y);
}
async function wheel(deltaY) {
  const before = await observe(page), clip = before.clip;
  assert.ok(clip && clip.height > 0, 'Cabin must expose its scroll region');
  const target = await screen({ x: clip.x + clip.width / 2, y: clip.y + clip.height / 2 });
  await page.mouse.move(target.x, target.y); await page.mouse.wheel(0, deltaY);
  await page.waitForFunction(frame => window.offlineProbe.read().frame > frame, before.frame);
}
async function visibleSlider(prefix) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const frame = await observe(page), clip = frame.clip;
    const label = frame.texts.findLast(item => item.text.startsWith(prefix));
    // A slider's label is 9 px below its start; its complete hit row ends at 62.
    if (label && label.y - 9 + 20 >= clip.y && label.y - 9 + 62 <= clip.y + clip.height)
      return { label, clip };
    await wheel(label && label.y < clip.y ? -90 : 90);
  }
  throw new Error(`Slider cannot be reached by wheel: ${prefix}`);
}
async function sliderPoint(slider, value, min, max) {
  const { label, clip } = slider;
  return screen({ x: label.x + 50 + 12 + (clip.width - 124) * (value - min) / (max - min), y: label.y + 32 });
}
async function dragSlider(prefix, min, max, values) {
  const slider = await visibleSlider(prefix), start = await sliderPoint(slider, min, min, max);
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  try {
    for (const value of values) {
      const target = await sliderPoint(slider, value, min, max);
      await page.mouse.move(target.x, target.y, { steps: 4 });
      await waitLabel(`${prefix} · ${value}`);
    }
  } finally { await page.mouse.up(); }
}
async function increment(prefix, direction, expected) {
  const { label, clip } = await visibleSlider(prefix);
  const point = await screen({ x: label.x + (direction > 0 ? clip.width - 21 : 21), y: label.y + 32 });
  await page.mouse.click(point.x, point.y); await waitLabel(`${prefix} · ${expected}`);
}
async function screenshot(name) {
  const filename = `${name}.png`, target = path.join(output, filename);
  await page.screenshot({ path: target, fullPage: true });
  report.screenshots.push({ path: filename, sha256: hash(await fs.readFile(target)) });
}

try {
  const manifest = JSON.parse(await fs.readFile(path.join(gameRoot, 'dist/build-manifest.json'), 'utf8'));
  assert.equal(manifest.config.onlineEnabled, false, 'Use an isolated offline build');
  report.gameSha256 = hash(await fs.readFile(path.join(gameRoot, 'dist/game.js')));
  await launch(); report.browserVersion = browser.version(); host = await startOfflineServer();
  const context = await browser.newContext({ viewport: { width: 1120, height: 980 }, serviceWorkers: 'block' });
  const errors = [], externalRequests = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== host.origin) {
      externalRequests.push(route.request().url()); return route.abort();
    }
    return route.continue();
  });
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${host.origin}/?width=390&height=844`, { waitUntil: 'networkidle' });
  await page.locator('#game').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => window.offlineProbe?.read().lastState?.snapshot);
  await waitLabel('确认落子');
  const initial = await observe(page), initialState = JSON.stringify(initial.lastState);
  await clickLabel('棋盘舱'); await waitLabel('玩家人数 · 2');

  await check('Continuous mouse drag changes players 2→3→6 without release', async () => {
    await dragSlider('玩家人数', 2, 15, [3, 6]);
    await screenshot('mini-desktop-players-six');
  });
  await check('Player plus/minus respond once per mouse click', async () => {
    await increment('玩家人数', 1, 7); await increment('玩家人数', -1, 6);
  });
  await check('Wheel scrolls settings down and back up', async () => {
    const before = await waitLabel('玩家人数 · 6');
    await wheel(100); const down = await waitLabel('玩家人数 · 6');
    assert.ok(down.y < before.y, 'Positive browser wheel scroll moves content upward');
    await wheel(-100); const up = await waitLabel('玩家人数 · 6');
    assert.ok(up.y > down.y, 'Negative browser wheel scroll moves content downward');
  });
  await check('Wheel reaches board size; mouse drag and plus/minus remain usable', async () => {
    await dragSlider('棋盘边长', 5, 15, [9, 13]);
    await increment('棋盘边长', 1, 14); await increment('棋盘边长', -1, 13);
    await screenshot('mini-desktop-board-size');
  });
  await check('Settings interactions preserve the active match and do not play moves', async () => {
    assert.equal(JSON.stringify((await observe(page)).lastState), initialState);
    await clickLabel('返回棋盘'); await waitLabel('确认落子');
    const final = await observe(page);
    assert.equal(JSON.stringify(final.lastState), initialState);
    assert.deepEqual(final.errors, []); assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
    for (const key of ['loginCalls', 'requestCalls', 'socketCalls']) assert.equal(final[key], 0);
    await screenshot('mini-desktop-return-board');
  });
  report.status = 'PASS_BROWSER_SIMULATED_WX_NOT_NATIVE_WECHAT';
} catch (error) {
  report.status = 'FAIL'; report.error = error.stack || String(error);
  if (page) { try { await screenshot('mini-desktop-failure'); } catch (_) { /* Preserve the original failure. */ } }
  process.exitCode = 1;
} finally {
  if (browser) await browser.close(); if (host) await host.close();
  report.finishedAt = new Date().toISOString(); await persist();
}
console.log(JSON.stringify({ status: report.status, checks: report.checks.length, receipt, error: report.error }, null, 2));
