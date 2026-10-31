import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";

const root = fileURLToPath(new URL("../../", import.meta.url));
const executable = path.join(root, "desktop/release/win-unpacked/LIFELINE.exe");
const archive = path.join(path.dirname(executable), "resources/app.asar");
const difficultyArgument = process.argv.find(argument => argument.startsWith("--difficulty="));
const difficulty = difficultyArgument ? Number(difficultyArgument.split("=")[1]) : null;
if (difficulty !== null) assert.ok([2, 3, 4].includes(difficulty), "difficulty must be 2, 3 or 4");
assert.ok(fs.existsSync(executable), "Build desktop:pack:dir before this test.");
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), "lifeline-full-match-"));
const profile = path.join(evidence, "profile");
const replayPath = path.join(evidence, "match-replay.json");
const packageHash = () => createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
const receipt = { status: "RUNNING", packageSha256: packageHash(), evidence, difficulty, errors: [], badResponses: [], externalRequests: [], workers: [], modelAssets: [], responseTimesMs: [], milestones: [] };
let application;

const attachDiagnostics = async (app) => {
  const page = await app.firstWindow();
  page.on("pageerror", error => receipt.errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") receipt.errors.push(message.text()); });
  page.on("response", response => {
    if (response.status() >= 400) receipt.badResponses.push({ url: response.url(), status: response.status() });
    if (/assets\/research-ai\/.*\.(f32|json)/.test(response.url())) receipt.modelAssets.push({ url: response.url(), status: response.status() });
  });
  page.on("request", request => {
    if (/^(https?|wss?):/i.test(request.url())) receipt.externalRequests.push(request.url());
  });
  page.on("worker", worker => receipt.workers.push(worker.url()));
  await page.addInitScript(() => {
    const NativeWorker = globalThis.Worker;
    globalThis.__lifelineWorkerTrace = [];
    globalThis.Worker = new Proxy(NativeWorker, {
      construct(target, args) {
        globalThis.__lifelineWorkerTrace.push(String(args[0]));
        return new target(...args);
      },
    });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#app")?._vnode?.component?.proxy?.controller?.renderer?.layout, null, { timeout: 30_000 });
  const welcome = page.locator(".welcome-overlay");
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "简体中文", exact: true }).click();
  return page;
};

const vmSnapshot = (page) => page.evaluate(() => {
  const vm = document.querySelector("#app")._vnode.component.proxy;
  const save = window.lifelineDesktop.readProgressSync();
  return {
    tutorialActive: vm.tutorialActive,
    gameOver: vm.gameState.gameOver,
    winner: vm.gameState.winner,
    currentPlayer: vm.gameState.currentPlayer,
    revision: vm.gameState.positionRevision,
    actions: JSON.parse(JSON.stringify(vm.localGameActions)),
    settings: save.ok && save.value ? JSON.parse(save.value).settings : null,
    players: JSON.parse(JSON.stringify(vm.activeLocalPlayers)),
    aiThinking: vm.aiThinking,
    engine: (() => {
      const engine = vm.controller.engine;
      const snapshot = engine.getSnapshot();
      return {
        gridSize: snapshot.gridSize,
        playerCount: snapshot.playerCount,
        rulesVersion: snapshot.rulesVersion,
        startPlayer: snapshot.startPlayer,
        currentPlayer: snapshot.currentPlayer,
        gameOver: snapshot.gameOver,
        winner: snapshot.winner,
        consecutiveSkips: snapshot.consecutiveSkips,
        resignedPlayers: [...snapshot.resignedPlayers],
        turnCount: snapshot.turnCount,
        boardMatrix: snapshot.boardMatrix,
        edges: snapshot.edges,
        territories: snapshot.territories,
        historyHashes: [...engine.historyHashes].sort(),
      };
    })(),
    save,
    workerTrace: [...(window.__lifelineWorkerTrace ?? [])],
  };
});

// Rebuild reference states directly from legal engine actions, independently of
// the renderer's replay/restore controller and its displayed cursor.
const expectedEngineState = (page, savedSession, cursor = savedSession.actions.length) => page.evaluate(({ savedSession, cursor }) => {
  const Engine = document.querySelector("#app")._vnode.component.proxy.controller.engine.constructor;
  const engine = new Engine(savedSession.settings);
  for (const [index, action] of savedSession.actions.slice(0, cursor).entries()) {
    const result = action.type === "player_move" ? engine.playMove(action.point)
      : action.type === "player_skip" ? engine.skipTurn()
        : action.type === "player_resign" ? engine.resignPlayer(action.color) : null;
    if (!result?.success) throw new Error(`Reference action ${index + 1} is illegal`);
  }
  const snapshot = engine.getSnapshot();
  return {
    gridSize: snapshot.gridSize, playerCount: snapshot.playerCount, rulesVersion: snapshot.rulesVersion,
    startPlayer: snapshot.startPlayer, currentPlayer: snapshot.currentPlayer, gameOver: snapshot.gameOver,
    winner: snapshot.winner, consecutiveSkips: snapshot.consecutiveSkips,
    resignedPlayers: [...snapshot.resignedPlayers], turnCount: snapshot.turnCount,
    boardMatrix: snapshot.boardMatrix, edges: snapshot.edges, territories: snapshot.territories,
    historyHashes: [...engine.historyHashes].sort(),
  };
}, { savedSession, cursor });

const clickLegalMove = async (page, moveIndex = 0) => {
  const target = await page.evaluate((index) => {
    const vm = document.querySelector("#app")._vnode.component.proxy;
    const legal = vm.controller.engine.getSnapshot().legalMoves;
    if (!legal.length) return null;
    const point = legal[index % legal.length].point;
    const pixel = vm.controller.renderer.getPointPixelCoordinates(point);
    const rect = vm.controller.renderer.canvas.getBoundingClientRect();
    return { x: rect.left + pixel.x * rect.width / vm.controller.renderer.layout.cssWidth,
      y: rect.top + pixel.y * rect.height / vm.controller.renderer.layout.cssHeight, point };
  }, moveIndex);
  assert.ok(target, "current player should have a legal move");
  await page.mouse.click(target.x, target.y);
  return target.point;
};

try {
  const env = { ...process.env, LIFELINE_TEST_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath: executable, env, timeout: 60_000 });
  let page = await attachDiagnostics(application);
  const initialSkip = page.getByRole("button", { name: "跳过教学", exact: true });
  if (await initialSkip.isVisible()) await initialSkip.click();
  await page.getByRole("button", { name: "棋盘舱", exact: true }).click();
  await page.locator("#grid-size").getByRole("radio", { name: "5", exact: true }).click();
  const whiteSelector = page.locator("#local-player-WHITE");
  const primaryChoices = await whiteSelector.locator("option").evaluateAll(options => options.map(option => option.value));
  if (primaryChoices.includes("ai")) {
    await whiteSelector.selectOption("ai");
    if (!difficulty) {
      await page.locator(".local-player-card.is-red .local-player-advanced > summary").click();
      await page.locator("#local-model-WHITE").selectOption("padded-cnn");
    }
  } else await whiteSelector.selectOption(difficulty ? "minimax" : "padded-cnn");
  if (difficulty) {
    await page.locator(".local-player-card.is-red").getByRole("button", { name: { 2: "简单", 3: "中等", 4: "困难" }[difficulty], exact: true }).click();
  }
  await page.locator(".utility-overlay-board .utility-close").click();
  await page.locator(".utility-overlay-board").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "开始对局", exact: true }).click();
  await page.waitForFunction(() => {
    const vm = document.querySelector("#app")._vnode.component.proxy;
    return !vm.localSetupPending && vm.gameState.positionRevision === 0;
  });
  receipt.milestones.push(`5x5 territory-v2 local AI match started with ${difficulty ? `Minimax depth ${difficulty}` : "padded-cnn pilot model"}`);

  const firstResponseStart = performance.now();
  await clickLegalMove(page, 0);
  await page.waitForFunction(() => {
    const vm = document.querySelector("#app")._vnode.component.proxy;
    return vm.localGameActions.length >= 2 || vm.gameState.gameOver || vm.localGameNotice;
  }, null, { timeout: 60_000 });
  let state = await vmSnapshot(page);
  receipt.responseTimesMs.push(performance.now() - firstResponseStart);
  assert.ok(state.actions.length >= 2, `AI did not respond to first human move: ${JSON.stringify(state)}`);
  assert.ok(state.workerTrace.some(url => /AIWorker\.js/.test(url)), "real AI module Worker should be created");
  if (!difficulty) assert.ok(receipt.modelAssets.some(({ url, status }) => /\.f32/.test(url) && status < 400), "research model tensor should load from packaged assets");
  else assert.equal(state.players.WHITE.depth, difficulty);
  receipt.milestones.push({ milestone: difficulty ? "selected AI difficulty replied through the actual Worker" : "AI Worker replied and packaged model tensor loaded", actions: state.actions.length, workerTrace: state.workerTrace, modelAssets: receipt.modelAssets });

  // A challenge must restore the actual AI matchup, not turn it into a local
  // human game or save its temporary board over the existing match.
  const beforeChallenge = await vmSnapshot(page);
  await page.locator(".dock-launcher-campaign").click();
  await page.locator(".campaign-level-card").first().click();
  await page.locator(".utility-overlay-campaign").waitFor({ state: "detached" });
  await page.waitForFunction(() => document.querySelector("#app")._vnode.component.proxy.challengeActive);
  const challengeTarget = await page.evaluate(() => {
    const renderer = document.querySelector("#app")._vnode.component.proxy.controller.renderer;
    const point = renderer.getPointPixelCoordinates([0, 2]);
    const rect = renderer.canvas.getBoundingClientRect();
    return { x: rect.left + point.x * rect.width / renderer.layout.cssWidth, y: rect.top + point.y * rect.height / renderer.layout.cssHeight };
  });
  await page.mouse.click(challengeTarget.x, challengeTarget.y);
  await page.waitForFunction(() => document.querySelector("#app")._vnode.component.proxy.challengeStatus === "won");
  assert.equal((await vmSnapshot(page)).save.value, beforeChallenge.save.value);
  await page.getByRole("button", { name: "返回关卡", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("#app")._vnode.component.proxy.challengeActive);
  await page.locator(".utility-overlay-campaign .utility-close").click();
  await page.locator(".utility-overlay-campaign").waitFor({ state: "detached" });
  const afterChallenge = await vmSnapshot(page);
  assert.deepEqual(afterChallenge.engine, beforeChallenge.engine);
  assert.deepEqual(afterChallenge.actions, beforeChallenge.actions);
  assert.deepEqual(afterChallenge.players, beforeChallenge.players);
  assert.equal(afterChallenge.save.value, beforeChallenge.save.value);
  if (!afterChallenge.gameOver) {
    const responseStart = performance.now();
    await clickLegalMove(page, 1);
    await page.waitForFunction(count => {
      const vm = document.querySelector("#app")._vnode.component.proxy;
      return vm.gameState.gameOver || (vm.localGameActions.length >= count + 2 && !vm.aiThinking && vm.gameState.currentPlayer === "BLACK");
    }, afterChallenge.actions.length, { timeout: 60_000 });
    receipt.responseTimesMs.push(performance.now() - responseStart);
  }
  const resumedAfterChallenge = await vmSnapshot(page);
  assert.ok(resumedAfterChallenge.gameOver || resumedAfterChallenge.actions.length >= afterChallenge.actions.length + 2);
  receipt.milestones.push({ milestone: "actual challenge completion/exit preserved the full AI matchup and save", subsequentActions: resumedAfterChallenge.actions.length - afterChallenge.actions.length, subsequentlyTerminal: resumedAfterChallenge.gameOver });

  // Export and import a real replay file through the renderer's UI and IPC.
  await application.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
  }, replayPath);
  await page.getByRole("button", { name: "棋盘舱", exact: true }).click();
  await page.getByRole("button", { name: "导出棋谱", exact: true }).click();
  const exportDeadline = Date.now() + 30_000;
  while (!fs.existsSync(replayPath) && Date.now() < exportDeadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(fs.existsSync(replayPath), "export IPC should create the replay file");
  const replay = JSON.parse(fs.readFileSync(replayPath, "utf8"));
  assert.equal(replay.format, "lifeline-replay");
  receipt.milestones.push({ milestone: "replay export wrote validated document through IPC", events: replay.actions.length });
  await page.locator(".replay-file-input").setInputFiles(replayPath);
  await page.waitForFunction(() => document.querySelector("#app")._vnode.component.proxy.replaySource === "imported");
  const liveBeforeReplay = await vmSnapshot(page);
  const replaySession = JSON.parse(liveBeforeReplay.save.value);
  await page.getByRole("button", { name: /复盘导入棋谱/ }).click();
  await page.waitForFunction(() => document.querySelector("#app")._vnode.component.proxy.replayMode);
  const firstReplayButton = page.getByRole("button", { name: "到起点", exact: true });
  if (await firstReplayButton.isEnabled()) await firstReplayButton.click();
  for (let cursor = 0; cursor <= replaySession.actions.length; cursor += 1) {
    if (cursor > 0) await page.getByRole("button", { name: "下一步", exact: true }).click();
    await page.waitForFunction(cursor => {
      const vm = document.querySelector("#app")._vnode.component.proxy;
      return vm.replayCursor === cursor && !vm.replayBusy;
    }, cursor);
    const displayed = await vmSnapshot(page);
    assert.deepEqual(displayed.engine, await expectedEngineState(page, replaySession, cursor), `replay UI at step ${cursor} must show the actual prefix state`);
  }
  await page.getByRole("button", { name: "上一步", exact: true }).click();
  await page.waitForFunction(cursor => document.querySelector("#app")._vnode.component.proxy.replayCursor === cursor, replaySession.actions.length - 1);
  assert.deepEqual((await vmSnapshot(page)).engine, await expectedEngineState(page, replaySession, replaySession.actions.length - 1));
  await page.getByRole("button", { name: "到终点", exact: true }).click();
  await page.waitForFunction(cursor => document.querySelector("#app")._vnode.component.proxy.replayCursor === cursor, replaySession.actions.length);
  const replayEnd = await vmSnapshot(page);
  assert.deepEqual(replayEnd.engine, liveBeforeReplay.engine, "replay must reconstruct full board and rule history through the final event");
  await page.getByRole("button", { name: "退出复盘", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("#app")._vnode.component.proxy.replayMode);
  const returnedToLive = await vmSnapshot(page);
  assert.deepEqual(returnedToLive.engine, liveBeforeReplay.engine, "exiting review must return the complete live state");
  assert.deepEqual(returnedToLive.actions, liveBeforeReplay.actions);
  assert.deepEqual(JSON.parse(returnedToLive.save.value), replaySession, "review must never rewrite the active save");
  receipt.milestones.push({ milestone: "actual replay UI stepped forward/back; independent engine prefixes and return to live/save all match", checkedPrefixes: replaySession.actions.length + 1 });

  // Abruptly terminate only this test-launched Electron process after a durable save.
  state = await vmSnapshot(page);
  assert.equal(state.save.ok, true);
  const savedBeforeCrash = JSON.parse(state.save.value);
  assert.equal(savedBeforeCrash.actions.length, state.actions.length);
  const revisionBeforeCrash = state.revision;
  const appProcess = application.process();
  const appPid = appProcess.pid;
  const launchCommand = appProcess.spawnargs.join(" ");
  assert.ok(launchCommand.includes(path.resolve(executable)), "only the verified package launch tree may be terminated");
  execFileSync("taskkill", ["/PID", String(appPid), "/T", "/F"], { stdio: "ignore" });
  await new Promise(resolve => {
    const timeout = setTimeout(resolve, 10_000);
    appProcess.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
  application = null;
  receipt.milestones.push({ milestone: "packaged Electron process terminated after durable save", pid: appPid });

  const resumedEnv = { ...process.env, LIFELINE_TEST_USER_DATA: profile };
  delete resumedEnv.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath: executable, env: resumedEnv, timeout: 60_000 });
  page = await attachDiagnostics(application);
  const skipTutorial = page.getByRole("button", { name: "跳过教学", exact: true });
  if (await skipTutorial.isVisible().catch(() => false)) await skipTutorial.click();
  await page.waitForFunction(() => {
    const vm = document.querySelector("#app")._vnode.component.proxy;
    return vm.localGameActions.length > 0 && vm.gameState.positionRevision > 0;
  }, null, { timeout: 30_000 });
  let restored = await vmSnapshot(page);
  assert.deepEqual(restored.actions, savedBeforeCrash.actions);
  assert.equal(restored.engine.rulesVersion, "territory-v2");
  assert.equal(restored.revision, revisionBeforeCrash);
  assert.deepEqual(restored.engine, state.engine, "crash recovery must recreate board, territory, player, and superko history");
  receipt.milestones.push({ milestone: "crash/restart restored identical rule history", restoredActions: restored.actions.length, revision: restored.revision, gameOver: restored.gameOver });

  let moveIndex = 1;
  const turnDeadline = Date.now() + 8 * 60_000;
  while (!restored.gameOver && Date.now() < turnDeadline && moveIndex < 100) {
    const responseStart = performance.now();
    if (restored.currentPlayer === "BLACK") {
      await clickLegalMove(page, moveIndex++);
    }
    await page.waitForFunction(() => {
      const vm = document.querySelector("#app")._vnode.component.proxy;
      return vm.gameState.gameOver || (!vm.aiThinking && vm.gameState.currentPlayer === "BLACK");
    }, null, { timeout: 90_000 });
    restored = await vmSnapshot(page);
    receipt.responseTimesMs.push(performance.now() - responseStart);
  }
  assert.equal(restored.gameOver, true, `AI match did not reach terminal state within bounds; state=${JSON.stringify({ revision: restored.revision, currentPlayer: restored.currentPlayer, actionCount: restored.actions.length })}`);
  assert.ok(restored.winner, "terminal match must have a settled winner or draw");
  const diskAtEnd = JSON.parse(restored.save.value);
  assert.deepEqual(diskAtEnd.actions, restored.actions);
  const expectedTerminal = await expectedEngineState(page, diskAtEnd);
  assert.deepEqual(restored.engine, expectedTerminal, "terminal board, territory scores, winner and full rule history match independent action replay");
  assert.equal(restored.winner, expectedTerminal.winner);
  assert.ok(Object.values(restored.engine.territories).every(territory => Number.isFinite(territory.area) && territory.area >= 0));
  receipt.milestones.push({ milestone: "full AI game reached verified terminal score", winner: restored.winner, actions: restored.actions.length, revision: restored.revision, territories: restored.engine.territories });

  await application.close();
  application = await _electron.launch({ executablePath: executable, env: resumedEnv, timeout: 60_000 });
  page = await attachDiagnostics(application);
  const skipAfterNormalClose = page.getByRole("button", { name: "跳过教学", exact: true });
  if (await skipAfterNormalClose.isVisible().catch(() => false)) await skipAfterNormalClose.click();
  await page.waitForFunction(length => document.querySelector("#app")._vnode.component.proxy.localGameActions.length === length, diskAtEnd.actions.length);
  const terminalAfterReopen = await vmSnapshot(page);
  assert.equal(terminalAfterReopen.gameOver, true);
  assert.deepEqual(terminalAfterReopen.engine, expectedTerminal);
  assert.deepEqual(terminalAfterReopen.actions, diskAtEnd.actions);
  assert.deepEqual(terminalAfterReopen.settings, diskAtEnd.settings);
  receipt.milestones.push("normal close/reopen retained terminal score, winner, settings and complete history");

  assert.deepEqual(receipt.errors, []);
  assert.deepEqual(receipt.badResponses, []);
  assert.deepEqual(receipt.externalRequests, []);
  assert.equal(packageHash(), receipt.packageSha256, "packaged app must remain byte-identical during acceptance");
  receipt.status = "AI_MATCH_RECOVERY_REPLAY_WORKER_PASS";
} catch (error) {
  receipt.status = "FAIL";
  receipt.error = String(error.stack ?? error);
  if (application) {
    const page = await application.firstWindow().catch(() => null);
    if (page) await page.screenshot({ path: path.join(evidence, "failure.png"), fullPage: true }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  if (application) await application.close().catch(error => { receipt.closeError = String(error); });
  fs.writeFileSync(path.join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
}
