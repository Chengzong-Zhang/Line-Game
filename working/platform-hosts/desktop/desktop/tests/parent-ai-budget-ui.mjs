import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";

const root = fileURLToPath(new URL("../../", import.meta.url));
const executable = path.join(root, "desktop/release/win-unpacked/LIFELINE.exe");
const archive = path.join(path.dirname(executable), "resources/app.asar");
const hash = () => createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
const evidence = fs.mkdtempSync(path.join(root, "local_artifacts/parent-ai-budget-ui-"));
const receipt = { status: "RUNNING", evidence, packageSha256: hash(), responses: [], cancellation: null, errors: [], externalRequests: [], badResponses: [] };
let app, page;
let phase = "startup";
const state = () => page.evaluate(() => {
  const vm = document.querySelector("#app")._vnode.component.proxy;
  return { actions: JSON.parse(JSON.stringify(vm.localGameActions)), thinking: vm.aiThinking, currentPlayer: vm.gameState.currentPlayer,
    gameOver: vm.gameState.gameOver, board: vm.controller.engine.getSnapshot().boardMatrix,
    frames: globalThis.__parentFrames, trace: JSON.parse(JSON.stringify(globalThis.__parentWorkers)) };
});
const clickLegal = async index => {
  const target = await page.evaluate(index => {
    const vm = document.querySelector("#app")._vnode.component.proxy;
    const renderer = vm.controller.renderer;
    const legal = vm.controller.engine.getSnapshot().legalMoves;
    const point = legal[index % legal.length]?.point;
    if (!point) throw new Error("Expected a legal human action");
    const pixel = renderer.getPointPixelCoordinates(point), rect = renderer.canvas.getBoundingClientRect();
    return { point, x: rect.left + pixel.x * rect.width / renderer.layout.cssWidth,
      y: rect.top + pixel.y * rect.height / renderer.layout.cssHeight };
  }, index);
  await page.mouse.click(target.x, target.y);
  return target.point;
};
const start = async (grid, difficulty) => {
  await page.locator(".dock-launcher-board").click();
  await page.locator("#grid-size").getByRole("radio", { name: String(grid), exact: true }).click();
  await page.locator("#local-player-BLACK").selectOption("human");
  await page.locator("#local-player-WHITE").selectOption("ai");
  await page.locator(".local-player-card.is-red").getByRole("button", { name: { 2: "Easy", 3: "Medium", 4: "Hard" }[difficulty], exact: true }).click();
  assert.equal(await page.locator(".local-player-card.is-red .local-player-advanced").getAttribute("open"), null);
  await page.screenshot({ path: path.join(evidence, `settings-${grid}-${difficulty}.png`) });
  await page.locator(".utility-overlay-board .utility-close").click();
  await page.locator(".duel-actions .action-button-secondary").click();
  await page.waitForFunction(() => {
    const vm = document.querySelector("#app")._vnode.component.proxy;
    return !vm.localSetupPending && vm.localGameActions.length === 0;
  });
};
try {
  const env = { ...process.env, LIFELINE_TEST_USER_DATA: path.join(evidence, "profile") };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ executablePath: executable, env, timeout: 60_000 });
  page = await app.firstWindow();
  page.on("pageerror", error => receipt.errors.push(error.message));
  page.on("request", request => { if (/^(https?|wss?):/i.test(request.url())) receipt.externalRequests.push(request.url()); });
  page.on("response", response => { if (response.status() >= 400) receipt.badResponses.push({ url: response.url(), status: response.status() }); });
  await page.addInitScript(() => {
    globalThis.__parentWorkers = [];
    globalThis.__parentFrames = 0;
    const countFrame = () => { globalThis.__parentFrames += 1; requestAnimationFrame(countFrame); };
    requestAnimationFrame(countFrame);
    const NativeWorker = globalThis.Worker;
    globalThis.Worker = new Proxy(NativeWorker, {
      construct(target, args) {
        const worker = new target(...args);
        const entry = { url: String(args[0]), requests: [], results: [], terminated: false };
        globalThis.__parentWorkers.push(entry);
        const post = worker.postMessage;
        worker.postMessage = function (message, ...rest) {
          entry.requests.push({ at: performance.now(), type: message.type, id: message.requestId,
            depth: message.depth, timeBudgetMs: message.timeBudgetMs, nodeBudget: message.nodeBudget,
            revision: message.serializedState?.positionRevision });
          return post.call(this, message, ...rest);
        };
        worker.addEventListener("message", event => {
          entry.results.push({ at: performance.now(), type: event.data?.type, id: event.data?.requestId,
            searchInfo: event.data?.searchInfo, moves: event.data?.moves });
        });
        const terminate = worker.terminate;
        worker.terminate = function (...rest) { entry.terminated = true; return terminate.apply(this, rest); };
        return worker;
      },
    });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#app")?._vnode?.component?.proxy?.controller?.renderer?.layout);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 720));
  await page.locator(".welcome-overlay").getByRole("button", { name: "English", exact: true }).click();
  await page.getByRole("button", { name: "Skip tutorial", exact: true }).click();
  for (const grid of [9, 15]) {
    for (const difficulty of [2, 3, 4]) {
      phase = `${grid} board, difficulty ${difficulty}`;
      await start(grid, difficulty);
      for (let turn = 0; turn < 2; turn += 1) {
        const before = await state();
        if (before.gameOver) break;
        const started = performance.now();
        const point = await clickLegal(turn);
        await page.waitForFunction(count => {
          const vm = document.querySelector("#app")._vnode.component.proxy;
          return vm.gameState.gameOver || (!vm.aiThinking && vm.localGameActions.length >= count + 2 && vm.gameState.currentPlayer === "BLACK");
        }, before.actions.length, { timeout: 15_000 });
        const elapsedMs = performance.now() - started, after = await state();
        assert.ok(after.actions.length >= before.actions.length + 2, "AI must actually reply");
        const worker = after.trace.filter(entry => /AIWorker\.js/.test(entry.url)).at(-1);
        const result = worker.results.at(-1), request = worker.requests.find(item => item.id === result.id);
        assert.equal(result.type, "RESULT");
        assert.equal(request.depth, grid === 15 ? difficulty - 1 : difficulty);
        assert.ok(request.timeBudgetMs <= 8000 && request.nodeBudget === 12000);
        assert.ok(elapsedMs < 12_000, `bounded user-visible response: ${elapsedMs} ms`);
        assert.ok(after.frames > before.frames, "render loop must remain responsive during real Worker computation");
        receipt.responses.push({ grid, difficulty, turn, point, actionCount: after.actions.length, elapsedMs,
          workerMs: result.at - request.at, request, searchInfo: result.searchInfo, renderedFrames: after.frames - before.frames });
      }
    }
  }
  phase = "cancel a real pending hard search by restarting";
  await start(15, 4);
  await clickLegal(0);
  await page.waitForFunction(() => globalThis.__parentWorkers.some(entry => /AIWorker\.js/.test(entry.url) && !entry.terminated && entry.requests.length > entry.results.length));
  const beforeCancel = await state();
  assert.equal(beforeCancel.thinking, true);
  assert.equal(await page.locator("canvas.game-canvas").getAttribute("aria-busy"), "true");
  assert.equal(await page.locator(".duel-actions .action-button-secondary").isEnabled(), true);
  const started = performance.now();
  await page.locator(".duel-actions .action-button-secondary").click();
  await page.waitForFunction(() => {
    const vm = document.querySelector("#app")._vnode.component.proxy;
    return vm.localGameActions.length === 0 && !vm.aiThinking;
  });
  const cancelMs = performance.now() - started, reset = await state();
  assert.ok(cancelMs < 2000, "restart must cancel without waiting for the computation budget");
  assert.ok(reset.trace.some(entry => /AIWorker\.js/.test(entry.url) && entry.terminated && entry.requests.length > entry.results.length));
  await page.waitForTimeout(9000);
  const settled = await state();
  assert.deepEqual(settled.actions, []);
  assert.deepEqual(settled.board, reset.board, "a cancelled request cannot move in the replacement game");
  receipt.cancellation = { cancelMs, waitedPastBudgetMs: 9000, staleMovesApplied: 0 };
  assert.deepEqual(receipt.errors, []);
  assert.deepEqual(receipt.externalRequests, []);
  assert.deepEqual(receipt.badResponses, []);
  assert.equal(hash(), receipt.packageSha256);
  receipt.status = "PACKAGED_AI_BUDGET_AND_CANCEL_PASS";
} catch (error) {
  receipt.status = "FAIL";
  receipt.phase = phase;
  receipt.error = String(error.stack ?? error);
  if (page) await page.screenshot({ path: path.join(evidence, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => {});
  fs.writeFileSync(path.join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
}
