import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../wechat/minigame/node_modules/playwright-core/index.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = path.join(repo, 'web/web前端');
const output = path.join(repo, 'local_artifacts/start-protection-browser');
await fs.mkdir(output, { recursive: true });

const contentType = file => file.endsWith('.html')
  ? 'text/html; charset=utf-8'
  : file.endsWith('.json') ? 'application/json' : 'text/javascript; charset=utf-8';
const server = http.createServer(async (request, response) => {
  try {
    const relative = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).slice(1);
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) throw new Error('Outside fixture');
    const body = await fs.readFile(file);
    response.writeHead(200, { 'Content-Type': contentType(file) });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const pageErrors = [];
const results = [];

const cases = [
  { name: 'black-first-duel', players: 2, shape: 'triangle', start: 'BLACK', modern: true },
  { name: 'white-first-duel', players: 2, shape: 'triangle', start: 'WHITE', modern: true },
  { name: 'two-player-hex', players: 2, shape: 'hexagon', start: 'BLACK', modern: false },
  { name: 'three-player-triangle', players: 3, shape: 'triangle', start: 'BLACK', modern: false },
];

try {
  for (const item of cases) {
    const context = await browser.newContext({ viewport: { width: 720, height: 720 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(`${item.name}: ${error.message}`));
    await page.goto(`${origin}/tests/start-protection-browser.html?players=${item.players}&shape=${item.shape}&start=${item.start}`);
    await page.waitForFunction(() => window.fixture?.controller?.renderer?.layout && window.fixture.controller.renderer.lastSnapshot);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const position = await page.evaluate(() => {
      const { controller } = fixture;
      const engine = controller.engine;
      const first = engine.startPlayer;
      const second = engine.activePlayers.find(player => player !== first);
      const firstNeighbors = engine.getAdjacentPositions(engine.initialPositions[first]);
      const secondNeighbors = engine.getAdjacentPositions(engine.initialPositions[second]);
      const firstMove = firstNeighbors[1] ?? firstNeighbors[0];
      const secondInvadesFirst = firstNeighbors.find(point => String(point) !== String(firstMove));
      const firstInvadesSecond = secondNeighbors[0];
      const pixel = point => controller.renderer._gridToPixel(...point, controller.renderer.layout);
      return {
        first,
        second,
        protectionRule: engine.protectionRule,
        firstMove,
        secondInvadesFirst,
        firstInvadesSecond,
        firstMovePixel: pixel(firstMove),
        secondInvadesFirstPixel: pixel(secondInvadesFirst),
        firstInvadesSecondPixel: pixel(firstInvadesSecond),
      };
    });
    assert.equal(position.protectionRule, item.modern ? 'duel-first-unprotected-v1' : 'symmetric-v1', item.name);

    // The actual first player must still be unable to enter the second player's protected zone.
    await page.mouse.click(...position.firstInvadesSecondPixel);
    await settle();
    assert.equal(await page.evaluate(() => fixture.controller.engine.currentPlayer), position.first, item.name);
    assert.equal(await page.evaluate(point => fixture.controller.engine._getState(point), position.firstInvadesSecond), 0, item.name);

    await page.mouse.click(...position.firstMovePixel);
    await settle();
    assert.equal(await page.evaluate(() => fixture.controller.engine.currentPlayer), position.second, item.name);

    await page.mouse.click(...position.secondInvadesFirstPixel);
    await settle();
    const observed = await page.evaluate(point => ({
      currentPlayer: fixture.controller.engine.currentPlayer,
      pointState: fixture.controller.engine._getState(point),
      lastFeedback: fixture.feedback.at(-1)?.success ?? null,
    }), position.secondInvadesFirst);
    if (item.modern) {
      assert.notEqual(observed.currentPlayer, position.second, item.name);
      assert.notEqual(observed.pointState, 0, item.name);
      assert.equal(observed.lastFeedback, true, item.name);
    } else {
      assert.equal(observed.currentPlayer, position.second, item.name);
      assert.equal(observed.pointState, 0, item.name);
      assert.equal(observed.lastFeedback, false, item.name);
    }
    await page.screenshot({ path: path.join(output, `${item.name}.png`) });
    results.push({ ...item, actualRule: position.protectionRule, secondInvasionAccepted: item.modern });
    await context.close();
  }
  assert.deepEqual(pageErrors, []);
  const receipt = {
    status: 'PASS',
    environment: 'headless Microsoft Edge; real Canvas and mouse input',
    results,
    pageErrors,
  };
  await fs.writeFile(path.join(output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
