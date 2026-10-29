import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const require = createRequire(import.meta.url);
const { chromium } = require(option("--playwright-module", "playwright"));
const executablePath = option("--browser-executable", undefined);
const baseUrl = option("--base-url", "http://127.0.0.1:8767");
const vueRuntime = option("--vue-runtime", undefined);
const screenshotDirectory = option("--screenshots", undefined);
const outputPath = option("--output", undefined);
if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });

const modes = ["classic", "fixed-double", "relocate", "add"];
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const results = [];

const readState = page => page.evaluate(() => {
  const vm = document.querySelector("#app")?._vnode?.component?.proxy;
  const snapshot = vm?.controller?.engine?.getSnapshot?.();
  if (!snapshot) return null;
  return {
    rootMode: snapshot.rootMode,
    rootRulesVersion: snapshot.rootRulesVersion,
    rulesVersion: snapshot.rulesVersion,
    revision: snapshot.positionRevision,
    currentPlayer: snapshot.currentPlayer,
    gameOver: snapshot.gameOver,
    winner: snapshot.winner,
    consecutiveSkips: snapshot.consecutiveSkips,
    roots: snapshot.roots,
    rootActionsRemaining: snapshot.rootActionsRemaining,
    legalMoves: snapshot.legalMoves.map(move => ({ ...move, point: [...move.point] })),
    legalRootActions: snapshot.legalRootActions.map(action => ({ ...action, point: [...action.point] })),
    territories: snapshot.territories,
    actions: vm.localGameActions.map(action => ({ type: action.type, actor: action.actor, point: action.point ? [...action.point] : null })),
    replayMode: vm.replayMode,
  };
});

async function waitForApp(page) {
  await page.waitForFunction(() => document.querySelector("#app")?._vnode?.component?.proxy?.controller?.renderer?.layout, null, { timeout: 30_000 });
  const tutorial = page.getByRole("button", { name: /^(跳过教学|Skip tutorial)$/ });
  if (await tutorial.isVisible()) await tutorial.click();
}

async function clickFirstLegalMove(page, chooseMove = moves => moves[0]) {
  const before = await readState(page);
  assert.ok(before?.legalMoves?.length, `${before?.rootMode}: expected a legal placement`);
  const selected = chooseMove(before.legalMoves);
  assert.ok(selected?.point, `${before.rootMode}: move selector must return a legal move`);
  const point = selected.point;
  const pixel = await page.evaluate(target => {
    const vm = document.querySelector("#app")._vnode.component.proxy;
    return vm.controller.renderer.getPointPixelCoordinates(target);
  }, point);
  const canvas = page.locator("canvas.game-canvas");
  const box = await canvas.boundingBox();
  assert.ok(box, "game canvas must be visible");
  // Use Playwright's actionability-checked native input path so Chromium
  // generates the click consumed by GameController at the rendered point.
  const x = box.x + pixel.x, y = box.y + pixel.y;
  await canvas.click({ position: { x: pixel.x, y: pixel.y } });
  await page.waitForTimeout(250);
  const observed = await readState(page);
  if (!(observed.revision > before.revision)) {
    const diagnostics = await page.evaluate(({ x, y }) => ({
      feedback: document.querySelector(".action-feedback")?.textContent?.trim() ?? "",
      canvasDisabled: document.querySelector("canvas.game-canvas")?.getAttribute("aria-disabled"),
      setupPending: document.querySelector("#app")?._vnode?.component?.proxy?.localSetupPending,
      aiThinking: document.querySelector("#app")?._vnode?.component?.proxy?.aiThinking,
      hit: (() => {
        const element = document.elementFromPoint(x, y);
        return element ? { tag: element.tagName, className: element.className, ariaLabel: element.getAttribute("aria-label") } : null;
      })(),
      canvasRects: [...document.querySelectorAll("canvas")].map(element => ({
        className: element.className,
        pointerEvents: getComputedStyle(element).pointerEvents,
        rect: element.getBoundingClientRect().toJSON(),
      })),
      layout: document.querySelector("#app")?._vnode?.component?.proxy?.controller?.renderer?.layout,
      controllerCanvas: (() => {
        const vm = document.querySelector("#app")?._vnode?.component?.proxy;
        const canvas = document.querySelector("canvas.game-canvas");
        return {
          initialized: vm?.controller?._isInitialized,
          sameElement: vm?.controller?.canvas === canvas,
          connected: vm?.controller?.canvas?.isConnected,
        };
      })(),
    }), { x, y });
    throw new Error(`${before.rootMode}: canvas move did not advance: ${JSON.stringify({ point, pixel, box, diagnostics, before, observed })}`);
  }
  await page.waitForFunction(revision => {
    const vm = document.querySelector("#app")?._vnode?.component?.proxy;
    return vm?.gameState?.positionRevision > revision;
  }, before.revision, { timeout: 10_000 });
  return point;
}

async function skipTurn(page) {
  const before = await readState(page);
  const button = page.locator(".duel-actions button").filter({ hasText: /跳过|Skip/ });
  await button.click();
  await page.waitForFunction(({ revision, gameOver }) => {
    const vm = document.querySelector("#app")?._vnode?.component?.proxy;
    return vm?.gameState?.positionRevision > revision || (!gameOver && vm?.gameState?.gameOver);
  }, { revision: before.revision, gameOver: before.gameOver }, { timeout: 10_000 });
}

try {
  for (const mode of modes) {
    const context = await browser.newContext({ viewport: { width: 1180, height: 900 }, locale: "zh-CN" });
    if (vueRuntime) await context.route("**/vue@3/dist/vue.global.prod.js", route => route.fulfill({ path: vueRuntime, contentType: "application/javascript" }));
    await context.route("https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js", route => route.fulfill({
      contentType: "application/javascript",
      body: "globalThis.MathJax = globalThis.MathJax || {}; globalThis.MathJax.typesetPromise = () => Promise.resolve();",
    }));
    await context.route("https://fonts.googleapis.com/**", route => route.fulfill({ contentType: "text/css", body: "" }));
    await context.route(`${baseUrl}/api/training/contributions`, route => route.fulfill({ status: 204 }));
    await context.addInitScript(() => localStorage.setItem("triaxis-language", "zh"));
    const page = await context.newPage();
    const consoleErrors = [];
    const badResponses = [];
    const externalRequests = [];
    page.on("pageerror", error => consoleErrors.push(error.message));
    page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("response", response => {
      if (response.status() >= 400 && !/favicon\.ico/.test(response.url())) badResponses.push({ url: response.url(), status: response.status() });
    });
    page.on("request", request => {
      if (/^(https?|wss?):/i.test(request.url()) && !request.url().startsWith(baseUrl)
        && !/vue@3\/dist\/vue\.global\.prod\.js/.test(request.url())
        && request.url() !== "https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js"
        && !request.url().startsWith("https://fonts.googleapis.com/")) externalRequests.push(request.url());
    });

    await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 60_000 });
    await waitForApp(page);
    await page.locator(".dock-launcher-board").click();
    await page.locator(`[data-root-mode="${mode}"]`).click();
    await page.locator(".starting-point-start").click();
    await page.waitForFunction(expected => document.querySelector("#app")?._vnode?.component?.proxy?.gameState?.rootMode === expected, mode);

    const started = await readState(page);
    assert.equal(started.rootMode, mode);
    assert.equal(started.rootRulesVersion, mode === "classic" ? "root-v1" : "root-v2");
    assert.equal(started.rulesVersion, mode === "classic" ? started.rulesVersion : "territory-v3");
    const expectedRootCount = mode === "fixed-double" ? 2 : 1;
    assert.ok(Object.values(started.roots).every(roots => roots.length === expectedRootCount));

    const firstMove = await clickFirstLegalMove(page);
    const secondMove = await clickFirstLegalMove(page, moves => {
      if (mode !== "relocate" && mode !== "add") return moves[0];
      return moves.reduce((best, move) => {
        const distance = (move.point[0] - firstMove[0]) ** 2 + (move.point[1] - firstMove[1]) ** 2;
        const bestDistance = (best.point[0] - firstMove[0]) ** 2 + (best.point[1] - firstMove[1]) ** 2;
        return distance > bestDistance ? move : best;
      }, moves[0]);
    });
    const played = [firstMove, secondMove];
    let rootAction = null;
    if (mode === "relocate" || mode === "add") {
      const available = await readState(page);
      assert.ok(available.legalRootActions.length > 0, `${mode}: root action must be available after both opening moves: ${JSON.stringify(available)}`);
      const beforeRevision = available.revision;
      rootAction = available.legalRootActions[0];
      await page.locator(".root-action-targets button").first().click();
      await page.waitForFunction(revision => document.querySelector("#app")?._vnode?.component?.proxy?.gameState?.positionRevision > revision, beforeRevision);
      const afterRoot = await readState(page);
      assert.equal(afterRoot.rootActionsRemaining.BLACK[mode], 0);
      assert.ok(afterRoot.actions.some(action => action.type === `player_root_${mode}`));
    }

    await skipTurn(page);
    await skipTurn(page);
    await page.locator(".result-overlay").waitFor({ state: "visible", timeout: 10_000 });
    const terminal = await readState(page);
    assert.equal(terminal.gameOver, true);
    assert.equal(terminal.consecutiveSkips, 2);
    assert.ok(Object.values(terminal.territories).every(territory => Number.isInteger(territory.area)));
    if (mode === "fixed-double") assert.ok(Object.values(terminal.roots).every(roots => roots.length === 2));

    if (screenshotDirectory) await page.screenshot({ path: join(screenshotDirectory, `${mode}-terminal.png`), fullPage: true });

    let replayVerified = false;
    let refreshVerified = false;
    if (mode === "add") {
      await page.reload({ waitUntil: "networkidle" });
      await waitForApp(page);
      await page.locator(".result-overlay").waitFor({ state: "visible", timeout: 10_000 });
      const restored = await readState(page);
      assert.equal(restored.rootMode, "add");
      assert.equal(restored.gameOver, true);
      assert.equal(restored.rootActionsRemaining.BLACK.add, 0);
      assert.equal(restored.roots.BLACK.length, 2);
      refreshVerified = true;
      await page.locator(".result-overlay .action-button-ghost").click();
      await page.locator(".dock-launcher-board").click();
      await page.getByRole("button", { name: /复盘本局/ }).click();
      const progress = page.getByRole("slider", { name: "复盘进度", exact: true });
      await progress.waitFor({ state: "visible", timeout: 10_000 });
      const end = Number(await progress.getAttribute("max"));
      assert.ok(end >= 5);
      await page.getByRole("button", { name: "上一步", exact: true }).click();
      assert.equal(Number(await progress.getAttribute("value")), end - 1);
      await page.getByRole("button", { name: "下一步", exact: true }).click();
      assert.equal(Number(await progress.getAttribute("value")), end);
      await page.getByRole("button", { name: "退出复盘", exact: true }).first().click();
      replayVerified = true;
    }

    assert.deepEqual(consoleErrors, [], `${mode}: browser console must be clean`);
    assert.deepEqual(badResponses, [], `${mode}: browser responses must be clean`);
    assert.deepEqual(externalRequests, [], `${mode}: candidate must remain offline after the local Vue substitution`);
    results.push({ mode, played, rootAction, winner: terminal.winner,
      areas: Object.fromEntries(Object.entries(terminal.territories).map(([player, territory]) => [player, territory.area])),
      actions: terminal.actions.map(action => action.type), refreshVerified, replayVerified,
      consoleErrors, badResponses, externalRequests });
    await context.close();
  }
} finally {
  await browser.close();
}

const receipt = {
  status: "PASS",
  browser: "isolated headless Chromium",
  coverage: ["four selectable modes", "real canvas placement", "full-turn root actions", "PASS terminal", "territory-v3 area", "add refresh", "add replay"],
  results,
};
if (outputPath) await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
