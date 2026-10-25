// Runs an existing production dist in real headless Edge. Does not build, seed storage,
// expose app state, or substitute the production Canvas / Worker implementation.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { gameRoot, startOfflineServer } from './offline-server.mjs';

const repo = path.resolve(gameRoot, '../..');
const script = fileURLToPath(import.meta.url);
const prefix = 'lifeline-offline-host-v1:';
const savePrefix = `${prefix}lifeline-wechat-session-v1-`;
const preferencesKey = `${prefix}lifeline-wx-preferences-v1`;
const disabled = ['#9ba596', '#9b9183'];
const sha = data => createHash('sha256').update(data).digest('hex');
const fileHash = async file => sha(await fs.readFile(file));
const relative = file => path.relative(repo, file).split(path.sep).join('/');
const observe = page => page.evaluate(() => window.offlineProbe.read());
const timeout = 25000;

function parseArguments(args) {
  assert.equal(args.length, 2, 'Usage: node tools/three-player-browser-check.mjs --expected-version VERSION');
  assert.equal(args[0], '--expected-version');
  assert.match(args[1], /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/);
  return args[1];
}
async function bindInputs(expectedVersion) {
  const packageFile = path.join(gameRoot, 'package.json');
  const packageInfo = JSON.parse(await fs.readFile(packageFile, 'utf8'));
  assert.equal(packageInfo.version, expectedVersion, 'The requested package version must match');
  const manifestFile = path.join(gameRoot, 'dist/build-manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.rulesVersion, 'territory-v3');
  assert.equal(manifest.config.onlineEnabled, false, 'Only the offline build is permitted');
  assert.equal(manifest.config.apiBase, '', 'The build must not contain an online service URL');
  const files = new Map();
  for (const entry of manifest.outputs) {
    const file = path.resolve(gameRoot, 'dist', entry.path);
    assert.ok(file.startsWith(path.join(gameRoot, 'dist') + path.sep));
    const data = await fs.readFile(file);
    assert.equal(data.length, entry.bytes, `Output bytes: ${entry.path}`);
    assert.equal(sha(data), entry.sha256, `Output hash: ${entry.path}`);
    files.set(file, entry.sha256);
  }
  for (const [name, hash] of Object.entries(manifest.sourceHashes)) {
    const file = path.resolve(repo, name);
    assert.ok(file.startsWith(repo + path.sep));
    assert.equal(await fileHash(file), hash, `Stale production dist: ${name}`);
    files.set(file, hash);
  }
  for (const file of [manifestFile, packageFile, script, path.join(gameRoot, 'tools/offline-server.mjs'),
    path.join(gameRoot, 'preview/offline.html'), path.join(gameRoot, 'preview/offline-host.js'), path.join(gameRoot, 'preview/worker.js')]) {
    files.set(file, await fileHash(file));
  }
  return { files, manifestSha256: files.get(manifestFile), mainSha256: files.get(path.join(gameRoot, 'dist/game.js')),
    workerSha256: files.get(path.join(gameRoot, 'dist/workers/index.js')) };
}
async function saved(page) {
  return page.evaluate(({ savePrefix, preferencesKey }) => {
    const records = [0, 1].map(slot => {
      const value = localStorage.getItem(savePrefix + slot);
      return value ? JSON.parse(value) : null;
    }).filter(Boolean).sort((a, b) => b.sequence - a.sequence);
    return { record: records[0], preferences: JSON.parse(localStorage.getItem(preferencesKey) || '{}') };
  }, { savePrefix, preferencesKey });
}
async function waitText(page, text, { startsWith = false, center = false, enabled = false } = {}) {
  await page.waitForFunction(({ text, startsWith, center, enabled, disabled }) => window.offlineProbe?.read().texts.some(item =>
    (startsWith ? item.text.startsWith(text) : item.text === text) && (!center || item.align === 'center')
    && (!enabled || !disabled.includes(item.color))), { text, startsWith, center, enabled, disabled }, { timeout });
}
async function clickLogical(page, point) {
  await page.locator('#game').scrollIntoViewIfNeeded();
  const box = await page.locator('#game').boundingBox(), { metrics } = await observe(page);
  assert.ok(box);
  assert.ok(point.x >= 0 && point.x <= metrics.width && point.y >= 0 && point.y <= metrics.height, 'Visible Canvas point');
  await page.mouse.click(box.x + point.x * box.width / metrics.width, box.y + point.y * box.height / metrics.height);
}
async function clickText(page, text, options = {}) {
  const query = { center: true, enabled: true, ...options };
  await waitText(page, text, query);
  const item = (await observe(page)).texts.findLast(item => (query.startsWith ? item.text.startsWith(text) : item.text === text)
    && (!query.center || item.align === 'center') && !disabled.includes(item.color));
  await clickLogical(page, item);
}
async function dragLogical(page, start, end) {
  await page.locator('#game').scrollIntoViewIfNeeded();
  const box = await page.locator('#game').boundingBox(), { metrics } = await observe(page);
  const point = p => ({ x: box.x + p.x * box.width / metrics.width, y: box.y + p.y * box.height / metrics.height });
  const a = point(start), b = point(end);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function cabinLabel(page, text, { startsWith = false, slider = false } = {}) {
  await page.waitForFunction(() => window.offlineProbe?.read().clip, undefined, { timeout });
  for (let attempt = 0; attempt < 20; attempt++) {
    const frame = await observe(page), clip = frame.clip;
    assert.ok(clip, 'Cabin must be open');
    const candidates = frame.texts.filter(item => (startsWith ? item.text.startsWith(text) : item.text === text)
      && (slider ? item.align === 'left' : item.align === 'center') && !disabled.includes(item.color));
    for (const item of candidates.reverse()) {
      // Wrapped controller captions have two centered lines, 17 px apart.
      const continuation = !slider && frame.texts.find(other => other !== item && other.align === 'center'
        && other.x === item.x && Math.abs(other.y - item.y - 17) < 0.1);
      const centerY = continuation ? (item.y + continuation.y) / 2 : item.y;
      const top = slider ? item.y + 11 : centerY - 22, bottom = slider ? item.y + 53 : centerY + 22;
      if (top >= clip.y && bottom <= clip.y + clip.height) return { ...item, y: centerY, clip,
        renderedText: item.text + (continuation ? ` ${continuation.text}` : '') };
    }
    const x = clip.x + clip.width - 8, distance = Math.min(120, clip.height * 0.45);
    await dragLogical(page, { x, y: clip.y + clip.height - 25 }, { x, y: clip.y + clip.height - 25 - distance });
  }
  throw new Error(`Cabin control not reachable: ${text}`);
}
async function clickCabin(page, text, options) { await clickLogical(page, await cabinLabel(page, text, options)); }
async function choose(page, label) {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: label, exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
}
async function waitNewTask(page, before, kind) {
  await page.waitForFunction(({ before, kind }) => window.offlineProbe.read().tasks.slice(before).some(task => task.kind === kind), { before, kind }, { timeout });
  const task = (await observe(page)).tasks.slice(before).find(task => task.kind === kind);
  assert.equal(task.response.ok, true, `${kind} must succeed: ${task.response.error || ''}`);
  return task;
}
function checkPolicyTask(task, kind, playerCount, profile) {
  assert.equal(task.kind, kind); assert.equal(task.payload.settings.playerCount, playerCount);
  assert.equal(task.payload.profile, profile); assert.equal(task.response.ok, true);
  if (kind === 'ANALYZE') {
    assert.equal(task.response.result.profile, profile); assert.equal(task.response.result.metric, 'policy-score');
  }
  assert.ok(task.response.result.moves.length > 0);
}
function summarizeTask(task) {
  const result = task.response.result;
  return { kind: task.kind, playerCount: task.payload?.settings?.playerCount, profile: task.payload?.profile,
    ok: task.response.ok, player: result?.player, stateHash: result?.stateHash, metric: result?.metric,
    candidates: result?.moves?.length, top: result?.moves?.[0] && { point: result.moves[0].point, score: result.moves[0].score } };
}
async function waitHumanTurn(page, count, player, playLabel, timeoutMs = timeout) {
  await page.waitForFunction(({ savePrefix, count, player, playLabel, disabled }) => {
    const records = [0, 1].map(slot => { try { return JSON.parse(localStorage.getItem(savePrefix + slot)); } catch { return null; } })
      .filter(Boolean).sort((a, b) => b.sequence - a.sequence);
    const frame = window.offlineProbe.read();
    return records[0]?.payload.session.actions.length === count && frame.lastState?.snapshot.currentPlayer === player
      && frame.texts.some(t => t.text === playLabel)
      && frame.texts.some(t => t.text === (playLabel === 'Play move' ? 'Hint' : '提示') && !disabled.includes(t.color));
  }, { savePrefix, count, player, playLabel, disabled }, { timeout: timeoutMs });
}

export async function runThreePlayerBrowserCheck(expectedVersion, {
  scenarioSpecs = [{ language: 'zh', playerCount: 3, humanIndex: 0 }, { language: 'en', playerCount: 3, humanIndex: 1 }],
  outputName = 'wechat-three-player-browser', passStatus = 'PASS_REAL_EDGE_THREE_PLAYER_CANVAS_WORKER', extraInputs = [],
} = {}) {
  const binding = await bindInputs(expectedVersion); // Fail before creating artifacts or a server on stale builds.
  for (const file of extraInputs) binding.files.set(file, await fileHash(file));
  const outputBase = path.join(repo, 'local_artifacts', outputName);
  await fs.mkdir(outputBase, { recursive: true });
  const output = await fs.mkdtemp(path.join(outputBase, 'run-'));
  const report = { schemaVersion: 1, status: 'RUNNING', startedAt: new Date().toISOString(), expectedVersion,
    scope: 'Real headless Edge, production game.js and browser Worker, actual Canvas pointer operations; simulated wx host; no WeChat/device/performance/strength/online claim.',
    build: { manifestSha256: binding.manifestSha256, mainSha256: binding.mainSha256, workerSha256: binding.workerSha256 },
    inputHashes: Object.fromEntries([...binding.files].map(([file, hash]) => [relative(file), hash])),
    checks: [], scenarios: [], screenshots: [], externalRequests: [], browserErrors: [], cleanup: {} };
  let server, browser, currentPage, failure;
  const contexts = [], resources = new Set();
  const screenshot = async (page, name, fullPage = false) => {
    const file = path.join(output, `${name}.png`);
    if (fullPage) await page.screenshot({ path: file, fullPage: true });
    else await page.locator('#game').screenshot({ path: file });
    report.screenshots.push({ file: path.basename(file), sha256: await fileHash(file) });
  };
  const check = async (name, action) => {
    const start = Date.now();
    try { await action(); report.checks.push({ name, status: 'PASS', elapsedMs: Date.now() - start }); console.log(`PASS ${name}`); }
    catch (error) { report.checks.push({ name, status: 'FAIL', elapsedMs: Date.now() - start, error: error.message }); throw error; }
  };
  try {
    server = await startOfflineServer({ port: 0 });
    browser = await chromium.launch({ channel: 'msedge', headless: true, timeout: 20000 });
    report.browser = { channel: 'msedge', version: browser.version(), headless: true };
    for (const { language, playerCount, humanIndex, size = 7 } of scenarioSpecs) {
      assert.ok([3, 4, 5, 6].includes(playerCount) && ['zh', 'en'].includes(language) && Number.isInteger(humanIndex) && humanIndex >= 0 && humanIndex < playerCount);
      assert.ok(Number.isInteger(size) && size >= 5 && size <= 15);
      const locale = `${language}-${playerCount}`, en = language === 'en', width = en ? 320 : 390, height = en ? 568 : 844;
      const profile = playerCount === 3 ? 'three-player-policy-v1' : 'hex-player-policy-v1';
      const seats = ['BLACK', 'WHITE', 'PURPLE', 'GREEN', 'ORANGE', 'CYAN'].slice(0, playerCount);
      const labels = en ? { board: 'Board', back: 'Back', play: 'Play move', reset: 'Reset', hint: 'Hint', human: 'Human', ai: playerCount === 3 ? 'Three-player AI' : 'Hex AI',
        sides: ['Blue', 'Red', 'Purple', 'Green', 'Orange', 'Cyan'], players: 'Players', replayMode: 'Replay mode', replay: 'Replay', more: 'More', analyze: 'AI suggestions',
        analysis: 'Analysis', analysisBack: 'Back to board', exitReplay: 'Exit replay', resume: 'Continue' }
        : { board: '棋盘舱', back: '返回棋盘', play: '确认落子', reset: '重置', hint: '提示', human: '真人', ai: playerCount === 3 ? '三人 AI' : '六边形 AI',
          sides: ['蓝方', '红方', '紫方', '绿方', '橙方', '青方'], players: '玩家人数', replayMode: '复盘模式', replay: '复盘', more: '更多', analyze: '策略建议',
          analysis: '策略分析', analysisBack: '返回棋盘', exitReplay: '退出复盘', resume: '继续对局' };
      const humanPlayer = seats[humanIndex], actionCount = playerCount + humanIndex;
      const expectedControllers = Object.fromEntries(seats.map(player => [player, player === humanPlayer ? 'human' : profile]));
      const scenario = { locale, playerCount, size, logicalCanvas: { width, height }, browserViewport: { width, height }, expectedControllers, actions: [], taskEvidence: [] };
      report.scenarios.push(scenario);
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, serviceWorkers: 'block' });
      contexts.push(context);
      context.on('request', request => {
        const url = new URL(request.url());
        if (url.origin !== server.origin) report.externalRequests.push({ locale, url: url.origin + url.pathname });
        else resources.add(url.pathname);
      });
      await context.route('**/*', route => new URL(route.request().url()).origin === server.origin ? route.continue() : route.abort());
      const page = await context.newPage(); currentPage = page;
      page.on('pageerror', error => report.browserErrors.push({ locale, type: 'pageerror', message: error.message }));
      page.on('console', message => { if (message.type() === 'error') report.browserErrors.push({ locale, type: 'console', message: message.text() }); });
      await check(`${locale}: production Canvas and Worker boot`, async () => {
        await page.goto(`${server.origin}/?width=${width}&height=${height}`, { waitUntil: 'networkidle' });
        await waitText(page, '确认落子');
        const frame = await observe(page);
        assert.equal(frame.metrics.width, width); assert.equal(frame.metrics.height, height);
        assert.equal(frame.workersCreated, 1); assert.equal(frame.activeWorkers, 1); assert.deepEqual(frame.errors, []);
        const response = await page.request.get(`${server.origin}/dist/game.js`);
        assert.equal(sha(await response.body()), binding.mainSha256);
      });
      await check(`${locale}: player slider and every seat menu`, async () => {
        await clickText(page, '棋盘舱');
        if (en) { await clickCabin(page, '语言 · 中文'); await waitText(page, 'Language ·', { startsWith: true }); }
        const slider = await cabinLabel(page, `${labels.players} · 2`, { slider: true });
        await clickLogical(page, { x: slider.clip.x + 12 + (slider.clip.width - 24) * (playerCount - 2) / 4, y: slider.y + 29 });
        await waitText(page, `${labels.players} · ${playerCount}`);
        for (const [index, player] of seats.entries()) {
          for (const [choice, value] of [[labels.human, 'human'], [labels.ai, profile]]) {
            await clickCabin(page, `${labels.sides[index]} ·`, { startsWith: true });
            const menu = await page.getByRole('dialog').getByRole('button').allTextContents();
            assert.deepEqual(menu, [labels.human, labels.ai, '取消 / Cancel'], 'Seat menus must not offer strategies for another geometry');
            await choose(page, choice);
            assert.equal((await saved(page)).preferences.controllers[player], value);
          }
        }
        if (size !== 7) {
          const sizeLabel = en ? 'Points per side' : '棋盘边长';
          const sizeSlider = await cabinLabel(page, `${sizeLabel} · 7`, { slider: true });
          await clickLogical(page, { x: sizeSlider.clip.x + 12 + (sizeSlider.clip.width - 24) * (size - 5) / 10, y: sizeSlider.y + 29 });
          await waitText(page, `${sizeLabel} · ${size}`);
          assert.equal((await saved(page)).preferences.size, size);
        }
        await clickText(page, labels.back); await clickText(page, labels.board); // Return scroll to the first seat.
        await clickCabin(page, `${labels.sides[humanIndex]} ·`, { startsWith: true }); await choose(page, labels.human);
        assert.deepEqual((await saved(page)).preferences.controllers, expectedControllers);
        await screenshot(page, `${locale}-seat-settings`);
      });
      await check(`${locale}: reset, human move and real multiplayer AI replies`, async () => {
        await clickText(page, labels.back);
        const before = (await observe(page)).tasks.length;
        await clickText(page, labels.reset);
        if (await page.getByRole('dialog').count()) await choose(page, '确定 / OK');
        await waitNewTask(page, before, 'STATE');
        await waitHumanTurn(page, humanIndex, humanPlayer, labels.play);
        await page.waitForFunction(() => window.offlineProbe.read().circles.some(c => c.fill === '#8ab397' && c.radius > 0 && c.radius <= 2.4), undefined, { timeout });
        scenario.selectionSteps = [];
        for (let attempt = 0; attempt < 2; attempt++) {
          const boardFrame = await observe(page), boardClip = boardFrame.clip;
          const point = boardFrame.circles.find(c => c.fill === '#8ab397' && c.radius > 0 && c.radius <= 2.4 && (!boardClip ||
            c.x > boardClip.x + 8 && c.x < boardClip.x + boardClip.width - 8
            && c.y > boardClip.y + 8 && c.y < boardClip.y + boardClip.height - 8
            && !(c.x > boardClip.x + boardClip.width - 80 && c.y < boardClip.y + 42)));
          assert.ok(point, 'A legal point must be visibly inside the board clip, clear of the Full button');
          await clickLogical(page, point);
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const after = await observe(page), selected = after.texts.some(t => t.text === labels.play && !disabled.includes(t.color));
          scenario.selectionSteps.push({ point: { x: point.x, y: point.y }, boardClip, selected });
          if (selected) break;
          // Dense mobile boards intentionally use the first tap to zoom, then a second to select.
          assert.ok(attempt === 0 && after.texts.some(t => t.text === (en ? 'Full' : '全盘')), 'First tap must either select or visibly zoom');
        }
        await clickText(page, labels.play);
        // Several AI seats run serially through one Worker; each retains the product's 15s limit.
        await waitHumanTurn(page, actionCount, humanPlayer, labels.play, Math.max(timeout, (playerCount - 1) * 15000 + 5000));
        const frame = await observe(page), data = await saved(page);
        assert.deepEqual(data.record.payload.controllers, expectedControllers);
        assert.equal(data.record.payload.session.settings.playerCount, playerCount);
        assert.equal(data.record.payload.session.settings.gridSize, size);
        assert.equal(data.record.payload.session.settings.hintEnabled, true);
        assert.equal(data.record.payload.session.settings.turnTimerEnabled, false);
        const expectedActors = [...seats, ...seats.slice(0, humanIndex)];
        const applies = frame.tasks.slice(before).filter(task => task.kind === 'APPLY');
        assert.deepEqual(applies.map(task => task.payload.action.player), expectedActors);
        assert.ok(applies.every(task => task.response.ok));
        assert.deepEqual(applies.map(task => task.payload.action.point), data.record.payload.session.actions.map(action => action.point));
        const aiTasks = frame.tasks.slice(before).filter(task => task.kind === 'AI');
        assert.equal(aiTasks.length, actionCount - 1);
        aiTasks.forEach(task => checkPolicyTask(task, 'AI', playerCount, profile));
        scenario.actions = data.record.payload.session.actions;
        scenario.actorsFromApplyRequests = applies.map(task => task.payload.action.player);
        scenario.liveHash = frame.lastState.stateHash;
        scenario.taskEvidence.push(...aiTasks.map(summarizeTask));
        await screenshot(page, `${locale}-multiplayer-game`);
      });
      await check(`${locale}: hint uses the matching policy and preserves the game`, async () => {
        const before = (await observe(page)).tasks.length;
        await clickText(page, labels.hint);
        const task = await waitNewTask(page, before, 'HINT'); checkPolicyTask(task, 'HINT', playerCount, profile);
        assert.equal(task.response.result.stateHash, scenario.liveHash);
        assert.equal(task.response.result.player, humanPlayer);
        assert.equal((await saved(page)).record.payload.session.actions.length, actionCount);
        scenario.taskEvidence.push(summarizeTask(task));
      });
      await check(`${locale}: replay analysis shows raw policy score without changing live actions`, async () => {
        await clickText(page, labels.board); await clickCabin(page, labels.replayMode);
        await clickText(page, labels.replay); await waitText(page, `${labels.replay} · 0 / ${actionCount}`);
        await clickText(page, labels.more);
        const before = (await observe(page)).tasks.length;
        await clickText(page, labels.analyze, { center: false, startsWith: true });
        const task = await waitNewTask(page, before, 'ANALYZE'); checkPolicyTask(task, 'ANALYZE', playerCount, profile);
        await waitText(page, `${labels.analysis} · 0`);
        await waitText(page, labels.ai);
        const score = Number(task.response.result.moves[0].score).toFixed(2);
        await waitText(page, score);
        const texts = (await observe(page)).texts;
        assert.ok(texts.some(t => t.text.includes(en ? 'Policy score' : '策略评分')));
        assert.ok(!texts.some(t => t.align === 'right' && t.text.includes('%')), 'Linear scores must not display as probability');
        assert.equal((await saved(page)).record.payload.session.actions.length, actionCount);
        scenario.taskEvidence.push(summarizeTask(task));
        scenario.analysisVisibleScores = texts.filter(t => t.align === 'right').map(t => t.text);
        await screenshot(page, `${locale}-multiplayer-analysis`);
        await clickText(page, labels.analysisBack);
        await waitText(page, `${labels.replay} · 0 / ${actionCount}`);
        await clickText(page, labels.exitReplay); await clickText(page, labels.resume);
        // exitReplay restores a cached snapshot, so request a fresh hint to bind its real live state.
        const afterReplay = (await observe(page)).tasks.length;
        await clickText(page, labels.hint);
        const liveHint = await waitNewTask(page, afterReplay, 'HINT'); checkPolicyTask(liveHint, 'HINT', playerCount, profile);
        assert.equal(liveHint.response.result.stateHash, scenario.liveHash);
        assert.equal((await saved(page)).record.payload.session.actions.length, actionCount);
      });
      await check(`${locale}: real page reload preserves every controller and live position`, async () => {
        await page.reload({ waitUntil: 'networkidle' });
        await waitHumanTurn(page, actionCount, humanPlayer, labels.play);
        const frame = await observe(page), data = await saved(page);
        assert.equal(frame.lastState.stateHash, scenario.liveHash);
        assert.equal(frame.lastState.snapshot.playerCount, playerCount);
        assert.equal(data.record.payload.session.settings.gridSize, size);
        assert.deepEqual(data.preferences.controllers, expectedControllers);
        assert.deepEqual(data.record.payload.controllers, expectedControllers);
        assert.deepEqual(data.record.payload.session.actions, scenario.actions);
        await clickText(page, labels.board);
        await cabinLabel(page, `${labels.players} · ${playerCount}`, { slider: true });
        for (const [index, player] of seats.entries()) {
          const label = await cabinLabel(page, `${labels.sides[index]} ·`, { startsWith: true });
          assert.ok(label.renderedText.includes(expectedControllers[player] === 'human' ? labels.human : labels.ai), label.renderedText);
        }
        await clickText(page, labels.back);
        scenario.restored = { stateHash: frame.lastState.stateHash, controllers: data.record.payload.controllers,
          playerCount: data.record.payload.session.settings.playerCount, size: data.record.payload.session.settings.gridSize, actionCount: data.record.payload.session.actions.length };
        const finalFrame = await observe(page);
        scenario.networkCounters = { login: finalFrame.loginCalls, request: finalFrame.requestCalls, socket: finalFrame.socketCalls };
        assert.deepEqual(scenario.networkCounters, { login: 0, request: 0, socket: 0 });
        // Opening a cabin cancels/terminates the worker; the scheduler recreates it on demand.
        assert.ok(finalFrame.activeWorkers >= 0 && finalFrame.activeWorkers <= 1);
        assert.ok(finalFrame.workersCreated >= 1); assert.deepEqual(finalFrame.errors, []);
        scenario.workerCountsAfterCabin = { created: finalFrame.workersCreated, active: finalFrame.activeWorkers };
        await screenshot(page, `${locale}-restored`);
      });
      await context.close(); contexts.splice(contexts.indexOf(context), 1); currentPage = null;
    }
    await check('No external requests or browser errors; production Worker resource loaded', async () => {
      assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.browserErrors, []);
      for (const resource of ['/dist/game.js', '/preview/worker.js', '/dist/workers/index.js']) assert.ok(resources.has(resource), resource);
    });
  } catch (error) {
    failure = error;
    report.failure = { message: error.message, stack: error.stack };
    if (currentPage) {
      await screenshot(currentPage, 'failure', true).catch(error => { report.failureScreenshotError = error.message; });
      const frame = await observe(currentPage).catch(() => null);
      if (frame) report.failureObservation = { texts: frame.texts, clip: frame.clip, errors: frame.errors,
        lastTasks: frame.tasks.slice(-5).map(summarizeTask), network: [frame.loginCalls, frame.requestCalls, frame.socketCalls] };
    }
  } finally {
    for (const context of contexts) await context.close().catch(error => { report.cleanup.contextError = error.message; });
    if (browser) { await browser.close().catch(error => { report.cleanup.browserError = error.message; }); report.cleanup.browserClosed = !browser.isConnected(); }
    if (server) { await server.close().catch(error => { report.cleanup.serverError = error.message; }); report.cleanup.serverClosed = !report.cleanup.serverError; }
    const changed = [];
    for (const [file, hash] of binding.files) if (await fileHash(file).catch(() => null) !== hash) changed.push(relative(file));
    report.inputsUnchanged = changed.length === 0; report.changedInputs = changed;
    if (changed.length && !failure) failure = new Error('Inputs changed during browser verification');
    if (Object.keys(report.cleanup).some(key => key.endsWith('Error')) && !failure) failure = new Error('Cleanup failed');
    report.resources = [...resources].sort(); report.finishedAt = new Date().toISOString();
    report.status = failure ? 'FAIL' : passStatus;
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, checksPassed: report.checks.filter(c => c.status === 'PASS').length, output }));
  }
  if (failure) throw failure;
  return { output, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  runThreePlayerBrowserCheck(parseArguments(process.argv.slice(2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
