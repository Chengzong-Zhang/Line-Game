import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gameRoot } from './offline-server.mjs';

const prefix = 'lifeline-offline-host-v1:lifeline-wechat-session-v1-';
const sha = value => createHash('sha256').update(value).digest('hex');
async function launchBrowser() {
  const failures = [];
  for (const channel of process.platform === 'win32' ? ['msedge', 'chrome'] : ['chrome', 'chromium']) {
    try { return { browser: await chromium.launch({ channel, headless: true, timeout: 20000 }), channel }; }
    catch (error) { failures.push(`${channel}: ${error.message.split('\n')[0]}`); }
  }
  throw new Error(`No supported browser available. Install Edge or Chrome, then retry. ${failures.join('; ')}`);
}
const observe = page => page.evaluate(() => window.offlineProbe.read());
const disabledColors = ['#9ba596', '#9b9183'];
async function waitText(page, text, startsWith = false, enabled = false) {
  try {
    await page.waitForFunction(({ text, startsWith, enabled, disabledColors }) => window.offlineProbe?.read().texts.some(item =>
      (startsWith ? item.text.startsWith(text) : item.text === text) && (!enabled || !disabledColors.includes(item.color))),
    { text, startsWith, enabled, disabledColors }, { timeout: 25000 });
  } catch (error) { throw new Error(`Rendered text not found: ${text}. ${error.message}`); }
}
async function clickLogical(page, point) {
  await page.locator('#game').scrollIntoViewIfNeeded();
  const bounds = await page.locator('#game').boundingBox(), { metrics } = await observe(page);
  assert.ok(bounds);
  await page.mouse.click(bounds.x + point.x * bounds.width / metrics.width, bounds.y + point.y * bounds.height / metrics.height);
}
async function clickText(page, text, startsWith = false) {
  await waitText(page, text, startsWith, true);
  const frame = await observe(page);
  const label = frame.texts.findLast(item => (startsWith ? item.text.startsWith(text) : item.text === text)
    && !disabledColors.includes(item.color));
  await clickLogical(page, label);
}
async function choose(page, text, exact = true) {
  await page.getByRole('dialog').getByRole('button', { name: text, exact }).click();
}
async function records(page) {
  return page.evaluate(prefix => [0, 1].map(slot => {
    const raw = localStorage.getItem(prefix + slot);
    if (!raw) return null;
    try { return { ...JSON.parse(raw), slot, raw }; } catch (_) { return { slot, raw, damaged: true }; }
  }).filter(Boolean).sort((a, b) => (b.sequence || 0) - (a.sequence || 0)), prefix);
}
async function waitActions(page, count) {
  await page.waitForFunction(({ prefix, count }) => [0, 1].some(slot => {
    try { return JSON.parse(localStorage.getItem(prefix + slot))?.payload.session.actions.length === count; }
    catch (_) { return false; }
  }), { prefix, count }, { timeout: 25000 });
}
async function waitTurn(page, turn, english = false) {
  await waitText(page, `${english ? 'Turn' : '回合'} ${turn}`);
}
async function clickLegal(page) {
  await page.waitForFunction(() => window.offlineProbe.read().circles.some(c => c.fill === '#8ab397' && c.radius > 0 && c.radius <= 2.4));
  const frame = await observe(page), clip = frame.clip;
  const candidate = frame.circles.find(circle => circle.fill === '#8ab397' && circle.radius > 0 && circle.radius <= 2.4 && (!clip ||
    circle.x > clip.x + 4 && circle.x < clip.x + clip.width - 4 && circle.y > clip.y + 4 && circle.y < clip.y + clip.height - 4));
  assert.ok(candidate, 'A rendered legal point must be visible');
  await clickLogical(page, candidate);
}
async function tutorialTarget(page) {
  await page.waitForFunction(() => window.offlineProbe.read().circles.some(c => c.stroke === '#cda04d'));
  const target = (await observe(page)).circles.find(c => c.stroke === '#cda04d');
  await clickLogical(page, target);
  await clickText(page, '确认落子');
}
async function dragLogical(page, start, end) {
  await page.locator('#game').scrollIntoViewIfNeeded();
  const box = await page.locator('#game').boundingBox(), { metrics } = await observe(page);
  const point = p => ({ x: box.x + p.x * box.width / metrics.width, y: box.y + p.y * box.height / metrics.height });
  const a = point(start), b = point(end);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(40);
}
async function scrollText(page, text, startsWith = false, enabled = true) {
  await page.waitForFunction(() => window.offlineProbe.read().clip);
  for (let attempt = 0; attempt < 16; attempt++) {
    const frame = await observe(page), clip = frame.clip;
    assert.ok(clip, 'Cabin scroll area must be rendered');
    const item = frame.texts.find(item => (startsWith ? item.text.startsWith(text) : item.text === text)
      && (!enabled || !disabledColors.includes(item.color))
      && item.y >= clip.y + 22 && item.y <= clip.y + clip.height - 22);
    if (item) return item;
    const x = clip.x + clip.width - 8;
    await dragLogical(page, { x, y: clip.y + clip.height - 25 }, { x, y: clip.y + 25 });
  }
  throw new Error(`Cabin action not reachable: ${text}`);
}
async function clickCabinText(page, text, startsWith = false) {
  await clickLogical(page, await scrollText(page, text, startsWith));
}
async function localPlayers(page, english, blueAI = false) {
  await clickText(page, english ? 'Board' : '棋盘舱');
  await clickCabinText(page, english ? 'Red ·' : '红方 ·', true);
  await choose(page, english ? 'Human' : '真人');
  await waitText(page, english ? 'Red · Human' : '红方 · 真人');
  if (blueAI) {
    await clickCabinText(page, 'Blue ·', true); await choose(page, 'Standard AI');
    await waitText(page, 'Blue · Standard', true);
  }
}
async function returnBoard(page, english = false) {
  const label = english ? 'Back' : '返回棋盘';
  await clickText(page, label);
  await page.waitForFunction(label => !window.offlineProbe.read().texts.some(item => item.text === label), label);
}
async function resetMatch(page, english = false) {
  await returnBoard(page, english);
  const before = (await observe(page)).tasks.length;
  await clickText(page, english ? 'Reset' : '重置');
  await page.waitForFunction(before => window.offlineProbe.read().tasks.slice(before).some(task => task.kind === 'STATE' && task.response.ok), before);
  await waitText(page, english ? 'Play move' : '确认落子');
}

export async function runBrowserChecks({ origin, output }) {
  const { browser, channel } = await launchBrowser(), checks = [], screenshots = [], resources = new Set(), violations = [], errors = [];
  const contexts = [], networkCounters = [];
  const version = browser.version();
  const saveScreenshot = async (page, name) => {
    const filename = `${name}.png`; await page.screenshot({ path: path.join(output, filename), fullPage: true });
    screenshots.push({ path: filename, sha256: sha(await fs.readFile(path.join(output, filename))) });
  };
  const check = async (name, run) => {
    const start = Date.now();
    try { await run(); checks.push({ name, status: 'PASS', elapsedMs: Date.now() - start }); console.log(`BROWSER PASS: ${name}`); }
    catch (error) { checks.push({ name, status: 'FAIL', elapsedMs: Date.now() - start, error: error.message }); throw error; }
  };
  async function open(width, height, deferFrames = false) {
    const context = await browser.newContext({ viewport: { width: 1120, height: 980 }, serviceWorkers: 'block' }); contexts.push(context);
    if (deferFrames) await context.addInitScript(() => { window.requestAnimationFrame = () => 1; window.cancelAnimationFrame = () => {}; });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { violations.push(url.origin + url.pathname); return route.abort(); }
      resources.add(url.pathname); return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`${origin}/?width=${width}&height=${height}`, { waitUntil: 'networkidle' });
    try {
      await page.waitForFunction(() => window.offlineProbe?.read().lastState?.snapshot || window.offlineProbe?.read().errors.length);
      assert.deepEqual((await observe(page)).errors, [], 'The production bundle must boot without errors');
      await waitText(page, '确认落子'); return page;
    } catch (error) {
      await saveScreenshot(page, `failure-launch-${width}`).catch(() => {}); throw error;
    }
  }
  let failure = null, page, small, deferred;
  try {
    page = await open(390, 844);
    await check('生产游戏包直接启动；首次进入无需登录', async () => {
      const t = await observe(page); assert.equal(t.loginCalls, 0); assert.equal(t.requestCalls, 0); assert.equal(t.socketCalls, 0);
      assert.equal(t.workersCreated, 1); assert.equal(t.activeWorkers, 1);
      assert.equal(t.lastState.snapshot.rulesVersion, 'territory-v3');
      assert.equal(t.lastState.snapshot.territories.BLACK.area, 1);
      assert.equal(t.lastState.snapshot.territories.WHITE.area, 1);
      for (const label of ['棋盘舱', '对战舱', '指南舱', '新手引导', '确认落子']) assert.ok(t.texts.some(x => x.text === label), label);
      const result = await page.request.get(`${origin}/dist/game.js`);
      assert.equal(sha(await result.body()), sha(await fs.readFile(path.join(gameRoot, 'dist/game.js'))));
      await saveScreenshot(page, 'home');
    });
    await check('未配置好友服务时说明清楚，且不发起登录', async () => {
      await clickText(page, '对战舱');
      await scrollText(page, '好友对战尚未配置服务', true, false);
      const t = await observe(page);
      assert.ok(t.texts.some(item => item.text === '创建房间' && disabledColors.includes(item.color)));
      assert.equal(t.loginCalls, 0); assert.equal(await page.getByRole('dialog').count(), 0);
      await returnBoard(page);
    });
    await check('同机双人：鼠标点选后确认，真实 Worker 执行落子', async () => {
      await localPlayers(page, false); await resetMatch(page); await waitTurn(page, 1);
      await clickLegal(page); await waitText(page, '落点已选好，确认后落子');
      assert.equal((await records(page))[0].payload.session.actions.length, 0);
      await clickText(page, '确认落子'); await waitTurn(page, 2); await waitActions(page, 1);
      const t = await observe(page); assert.ok(t.tasks.some(x => x.kind === 'APPLY' && x.response.ok));
      assert.equal(t.activeWorkers, 1); assert.equal(t.lastState.snapshot.rulesVersion, 'territory-v3');
      assert.equal(t.lastState.snapshot.currentPlayer, 'WHITE');
      assert.equal(t.lastState.snapshot.territories.BLACK.area, 2);
      assert.equal(t.lastState.snapshot.territories.WHITE.area, 1);
    });
    const originalHash = (await observe(page)).lastState.stateHash;
    await check('提示使用真实计算线程，保留原局和行动数', async () => {
      await clickText(page, '提示');
      await page.waitForFunction(() => window.offlineProbe.read().tasks.some(t => t.kind === 'HINT' && t.response.ok));
      await waitTurn(page, 2);
      assert.equal((await observe(page)).lastState.stateHash, originalHash);
      assert.equal((await records(page))[0].payload.session.actions.length, 1);
    });
    await check('复盘逐步前进，退出恢复原局', async () => {
      await clickText(page, '棋盘舱'); await clickCabinText(page, '复盘模式'); await clickText(page, '复盘'); await waitText(page, '复盘 · 0 / 1');
      await clickText(page, '下一步'); await waitText(page, '复盘 · 1 / 1');
      await clickText(page, '退出复盘'); await waitText(page, '继续对局');
      assert.equal((await observe(page)).lastState.stateHash, originalHash);
      await clickText(page, '继续对局'); await waitText(page, '确认落子');
    });
    await check('模拟微信前后台回调：暂停后显式继续', async () => {
      await page.getByRole('button', { name: '模拟切到后台', exact: true }).click();
      await page.getByRole('button', { name: '返回游戏', exact: true }).click();
      await clickText(page, '继续对局'); await waitTurn(page, 2);
      assert.equal((await observe(page)).lastState.stateHash, originalHash);
    });
    await check('真正刷新页面，重建 Worker 并恢复同一存档', async () => {
      await page.reload({ waitUntil: 'networkidle' });
      await waitTurn(page, 2); assert.equal((await observe(page)).lastState.stateHash, originalHash);
      await saveScreenshot(page, 'restored');
    });
    await check('五关教学完整操作：围地、切断、禁手、自动跳过与结算', async () => {
      await clickText(page, '新手引导'); await clickCabinText(page, '1  连成第一条生命线');
      for (let index = 0; index < 5; index++) {
        await waitText(page, `${index + 1}/5 ·`, true);
        if (index === 3) {
          const before = (await observe(page)).lastState.stateHash;
          await tutorialTarget(page);
          await page.waitForFunction(() => window.offlineProbe.read().tasks.at(-1)?.response.error === 'INVALID_MOVE');
          assert.equal((await observe(page)).lastState.stateHash, before);
        }
        if (index === 4) await clickText(page, '跳过'); else await tutorialTarget(page);
        await waitText(page, `${index + 1}/5 · 完成了！`);
        const state = (await observe(page)).lastState.snapshot;
        if (index === 1) assert.equal(state.territories.BLACK.area, 10);
        if (index === 3) assert.equal(state.territories.BLACK.area, 6);
        if (index === 4) { assert.equal(state.gameOver, true); assert.equal(state.winner, 'BLACK'); assert.equal(state.territories.BLACK.area, 7); }
        if (index === 1) await saveScreenshot(page, 'tutorial-territory');
        await clickText(page, index === 4 ? '完成教学' : '下一关');
      }
      await waitText(page, '继续对局');
      await waitTurn(page, 2);
      assert.equal((await records(page))[0].payload.session.actions.length, 1);
      await clickText(page, '继续对局');
      // Tutorial/replay exits restore a cached snapshot without a new STATE request.
      // A new HINT must be computed from the restored game's actual action log.
      const before = (await observe(page)).tasks.length;
      await clickText(page, '提示');
      await page.waitForFunction(before => window.offlineProbe.read().tasks.slice(before).some(t => t.kind === 'HINT' && t.response.ok), before);
      const hint = (await observe(page)).tasks.filter(t => t.kind === 'HINT').at(-1);
      assert.equal(hint.response.result.stateHash, originalHash);
      await waitTurn(page, 2);
    });
    await check('认输结算；终局复盘退出后保留重新开始按钮', async () => {
      await clickText(page, '认输'); await choose(page, '确定 / OK');
      await waitText(page, '蓝方 获胜');
      await clickText(page, '复盘'); await waitText(page, '复盘 · 0 / 2');
      await clickText(page, '退出复盘'); await waitText(page, '重新开始');
      await waitText(page, '蓝方 获胜');
      assert.equal((await records(page))[0].payload.session.actions.at(-1).type, 'player_resign');
      await saveScreenshot(page, 'terminal');
    });
    small = await open(320, 568);
    await check('320×568 英文界面：15 边长、普通 AI 先手', async () => {
      await clickText(small, '棋盘舱'); await clickCabinText(small, '语言 · 中文'); await returnBoard(small, true);
      await localPlayers(small, true, true);
      const size = await scrollText(small, 'Points per side · 7'), frame = await observe(small);
      await clickLogical(small, { x: frame.clip.x + frame.clip.width - 12, y: size.y + 29 });
      await waitText(small, 'Points per side · 15');
      await resetMatch(small, true); await waitTurn(small, 2, true); await waitActions(small, 1);
      const t = await observe(small); assert.ok(t.tasks.some(x => x.kind === 'AI' && x.payload.difficulty === 'normal' && x.response.ok));
      assert.equal(t.lastState.snapshot.gridSize, 15); assert.equal(t.activeWorkers, 1);
      assert.equal(t.lastState.snapshot.currentPlayer, 'WHITE');
      const buttons = t.texts.filter(x => x.align === 'center' && ['Play move', 'Zoom', 'Resign', 'Reset'].includes(x.text));
      assert.ok(buttons.every(x => x.x >= 0 && x.x <= 320 && x.y >= 88 && x.y <= 568 - 24));
    });
    await check('密集棋盘先放大；拖动不落子；确认后人机继续', async () => {
      await clickLegal(small); await waitText(small, 'Full');
      assert.equal((await records(small))[0].payload.session.actions.length, 1);
      await small.locator('#game').scrollIntoViewIfNeeded();
      const box = await small.locator('#game').boundingBox(), t = await observe(small), clip = t.clip; assert.ok(clip);
      const x = box.x + (clip.x + clip.width / 2) * box.width / 320, y = box.y + (clip.y + clip.height / 2) * box.height / 568;
      await small.mouse.move(x, y); await small.mouse.down(); await small.mouse.move(x + 24, y + 12, { steps: 6 }); await small.mouse.up();
      assert.equal((await records(small))[0].payload.session.actions.length, 1);
      await clickLegal(small); await waitText(small, 'Point selected. Confirm to play.');
      await clickText(small, 'Play move'); await waitTurn(small, 4, true); await waitActions(small, 3);
      await saveScreenshot(small, 'dense-board');
    });
    await check('最新存档损坏后回退备份；保留损坏原记录', async () => {
      // Inject on the next boot: the old page may legitimately save on visibilitychange
      // during reload. Corrupting earlier would be repaired before restore is exercised.
      const marker = 'offline-check-damage-next-boot';
      await small.evaluate(marker => sessionStorage.setItem(marker, 'pending'), marker);
      await small.addInitScript(({ prefix, marker }) => {
        if (sessionStorage.getItem(marker) !== 'pending') return;
        const saved = [0, 1].map(slot => ({ ...JSON.parse(localStorage.getItem(prefix + slot)), slot }))
          .sort((a, b) => b.sequence - a.sequence);
        const bad = 'BROKEN_ON_NEXT_BOOT';
        localStorage.setItem(prefix + saved[0].slot, bad);
        sessionStorage.setItem(marker, JSON.stringify({ key: prefix + saved[0].slot, bad, backup: saved[1] }));
      }, { prefix, marker });
      await small.reload({ waitUntil: 'networkidle' });
      await waitText(small, 'Recovered the previous valid save.');
      const injected = await small.evaluate(marker => JSON.parse(sessionStorage.getItem(marker)), marker);
      assert.equal(await small.evaluate(key => localStorage.getItem(key), injected.key), injected.bad);
      const last = (await observe(small)).tasks.filter(t => t.kind === 'STATE' && t.response.ok).at(-1);
      assert.deepEqual(last.payload.actions, injected.backup.payload.session.actions);
      assert.ok((await observe(small)).texts.some(t => t.text === 'LIFELINE'));
      await saveScreenshot(small, 'backup-recovery');
    });
    await check('浏览器延后动画帧时，首屏和实际落子仍可绘制', async () => {
      deferred = await open(390, 844, true);
      await localPlayers(deferred, false); await resetMatch(deferred); await waitTurn(deferred, 1);
      await clickLegal(deferred); await clickText(deferred, '确认落子');
      await waitTurn(deferred, 2); await waitActions(deferred, 1);
      assert.ok((await observe(deferred)).frame >= 3);
    });
    await check('全程零微信登录、零外部请求，主包和 Worker 均实际加载', async () => {
      for (const current of [page, small, deferred]) {
        const t = await observe(current); networkCounters.push({ login: t.loginCalls, request: t.requestCalls, socket: t.socketCalls });
        assert.deepEqual([t.loginCalls, t.requestCalls, t.socketCalls], [0, 0, 0]); assert.deepEqual(t.errors, []);
      }
      assert.deepEqual(errors, []); assert.deepEqual(violations, []);
      assert.ok(resources.has('/dist/game.js')); assert.ok(resources.has('/dist/workers/index.js'));
    });
  } catch (error) {
    failure = error.message;
    await fs.writeFile(path.join(output, 'failure-observation.json'), JSON.stringify({ message: error.message, stack: error.stack,
      main: page && !page.isClosed() ? await observe(page).catch(() => null) : null,
      compact: small && !small.isClosed() ? await observe(small).catch(() => null) : null }, null, 2));
    for (const [name, current] of [['failure-main', page], ['failure-compact', small], ['failure-deferred', deferred]]) {
      if (current && !current.isClosed()) await saveScreenshot(current, name).catch(() => {});
    }
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    await browser.close();
  }
  return { status: failure ? 'FAIL' : 'PASS_BROWSER_OFFLINE_NOT_WECHAT_VERIFIED', browser: { channel, version, headless: true, temporaryProfile: true },
    checks, screenshots, resources: [...resources].sort(), violations, errors, networkCounters, failure,
    scope: 'Unmodified production game.js + real Canvas and browser Worker. WeChat API/lifecycle adapter is simulated; no native WeChat or phone acceptance.' };
}
