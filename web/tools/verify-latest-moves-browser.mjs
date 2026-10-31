import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../wechat/minigame/node_modules/playwright-core/index.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = path.join(repo, 'web/web前端');
const output = path.join(repo, 'local_artifacts/latest-moves-browser');
await fs.mkdir(output, { recursive: true });
const server = http.createServer(async (req, res) => {
  try {
    const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).slice(1);
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) throw Error('Outside fixture');
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [], errors = [];
try {
  for (const [width, height, players] of [[1024, 800, 3], [390, 844, 3], [1024, 800, 15]]) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/tests/latest-moves-browser.html?players=${players}`);
    await page.waitForFunction(() => window.fixture?.controller.renderer.layout && window.fixture.controller.renderer.lastSnapshot);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const move = async () => {
      const target = await page.evaluate(() => {
        const { controller } = fixture;
        const point = controller.engine.getLegalMoves()[0].point;
        const actor = controller.engine.currentPlayer;
        const [x, y] = controller.renderer._gridToPixel(...point, controller.renderer.layout);
        return { point, actor, x, y };
      });
      await page.mouse.click(target.x, target.y);
      await settle();
      return target;
    };
    assert.deepEqual(await page.evaluate(() => fixture.controller.getGameState().lastMoves), {});
    const first = await move(), second = await move();
    const marks = await page.evaluate(() => fixture.controller.renderer.lastSnapshot.lastMoves);
    assert.deepEqual(marks[first.actor], first.point);
    assert.deepEqual(marks[second.actor], second.point);
    const whites = await page.evaluate(() => Object.values(fixture.controller.renderer.lastSnapshot.lastMoves).filter(Boolean).map(point => {
      const renderer = fixture.controller.renderer;
      const [x, y] = renderer._gridToPixel(...point, renderer.layout);
      return [...renderer.ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data];
    }));
    await page.screenshot({ path: path.join(output, `${width}-${players}-moves.png`) });
    assert.ok(whites.every(pixel => pixel[0] > 230 && pixel[1] > 230 && pixel[2] > 230), `both actual Canvas nodes have white centers: ${JSON.stringify({ first, second, whites })}`);
    await page.locator('#undo').click(); await settle();
    assert.deepEqual(await page.evaluate(() => fixture.controller.getGameState().lastMoves), { [first.actor]: first.point });
    await page.locator('#pass').click(); await settle();
    const afterPass = await page.evaluate(() => fixture.controller.getGameState().lastMoves);
    assert.deepEqual(afterPass, { [first.actor]: first.point, [second.actor]: null });
    // Return to a player with an existing mark, then verify PASS clears it.
    for (let index = 0; index < players - 2; index++) await move();
    await page.locator('#pass').click(); await settle();
    assert.equal(await page.evaluate(actor => fixture.controller.renderer.lastSnapshot.lastMoves[actor], first.actor), null);
    await page.locator('#reset').click(); await settle();
    assert.deepEqual(await page.evaluate(() => fixture.controller.renderer.lastSnapshot.lastMoves), {});
    results.push({ width, height, players, checks: ['real Canvas clicks', 'two white centers', 'undo', 'PASS preserves others', 'PASS clears own previous node', 'restart'] });
    await context.close();
  }
  assert.deepEqual(errors, []);
  const receipt = { status: 'PASS', environment: 'headless Microsoft Edge; real Canvas, mouse and Worker', results, pageErrors: errors };
  await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
