import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startOfflineServer } from './offline-server.mjs';

const output = path.resolve(process.argv[2]);
await fs.mkdir(output, { recursive: true });
const host = await startOfflineServer();
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 700, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const trace = () => page.evaluate(() => globalThis.offlineProbe.read());
const pause = () => page.waitForTimeout(150);
async function clickText(pattern, { scroll = true } = {}) {
  for (let step = 0; step < 22; step++) {
    const state = await trace(), box = await page.locator('#game').boundingBox();
    const low = state.clip ? state.clip.y + 23 : 95, high = state.clip ? state.clip.y + state.clip.height - 23 : 790;
    const row = state.texts.find(row => pattern.test(row.text) && row.y > low && row.y < high);
    if (row) {
      await page.mouse.click(box.x + row.x * box.width / 390, box.y + row.y * box.height / 844);
      await pause(); return;
    }
    if (!scroll) break;
    await page.mouse.move(box.x + box.width * .9, box.y + box.height * .8);
    await page.mouse.wheel(0, 210); await pause();
  }
  throw new Error(`Visible text not found: ${pattern}`);
}
try {
  await page.goto(host.origin);
  await page.waitForFunction(() => globalThis.offlineProbe?.read().lastState?.snapshot);
  await clickText(/^棋盘舱$/, { scroll: false });
  await page.locator('#game').screenshot({ path: path.join(output, 'board-panel.png') });
  await clickText(/^拓扑棋盘/);
  await clickText(/^环面$/);
  assert.equal((await trace()).lastState.snapshot.rulesVersion, 'territory-v3', 'selecting only changes next-game settings');
  await page.locator('#game').screenshot({ path: path.join(output, 'topology-inline.png') });
  await clickText(/^按当前配置重置$/);
  await page.waitForFunction(() => globalThis.offlineProbe.read().lastState?.snapshot?.rulesVersion === 'surface-v1');
  await page.locator('#game').screenshot({ path: path.join(output, 'topology-game.png') });
  const state = await trace();
  assert.ok(state.texts.some(row => row.text === '认输'));
  assert.ok(state.texts.some(row => row.text === '重置'));
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.equal(state.errors.length, 0, state.errors.join('\n'));
  assert.equal(state.loginCalls + state.requestCalls + state.socketCalls, 0);
  const result = { status: 'PASS_OFFLINE_NATIVE_HOST_BOARD_FLOW', browser: await browser.version(),
    sameDistAsMiniBuild: true, pageErrors: errors, nativeWxCallsMocked: true, deviceVerified: false,
    checks: ['native createWxPlatform and real Worker', 'inline topology selection', 'selection preserves active game',
      'shared reset starts saved surface', 'resign and reset are drawn', 'no account/network calls'],
    screenshots: ['board-panel.png', 'topology-inline.png', 'topology-game.png'] };
  await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ status: result.status, output }));
} finally { await browser.close(); await host.close(); }
