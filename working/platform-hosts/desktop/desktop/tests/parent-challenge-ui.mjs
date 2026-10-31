import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";

const root = fileURLToPath(new URL("../../", import.meta.url));
const executable = path.join(root, "desktop/release/win-unpacked/LIFELINE.exe");
const archive = path.join(path.dirname(executable), "resources/app.asar");
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const english = process.argv.includes("--english");
const compact = process.argv.includes("--compact");
const keyboardBoard = process.argv.includes("--keyboard-board");
const allLevels = process.argv.includes("--all-levels");
fs.mkdirSync(path.join(root, "local_artifacts"), { recursive: true });
const evidence = fs.mkdtempSync(path.join(root, "local_artifacts/parent-challenge-"));
const profile = path.join(evidence, "profile");
const saveFile = path.join(profile, "saves/current.json");
const progressFile = path.join(profile, "profile/progress/profile.json");
const preferencesFile = path.join(profile, "profile/settings/preferences.json");
const receipt = { status: "RUNNING", packageSha256: hash(archive), evidence, language: english ? "en" : "zh", compact, allLevels, milestones: [], interactions: [], findings: [], errors: [], badResponses: [], externalRequests: [] };
let application;
let page;
let phase = "startup";
const label = (zh, en) => english ? en : zh;
const launch = async () => {
  const env = { ...process.env, LIFELINE_TEST_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath: executable, env, timeout: 60_000 });
  page = await application.firstWindow();
  page.on("pageerror", error => receipt.errors.push(error.message));
  page.on("response", response => { if (response.status() >= 400) receipt.badResponses.push({ url: response.url(), status: response.status() }); });
  page.on("request", request => { if (/^(https?|wss?):/i.test(request.url())) receipt.externalRequests.push(request.url()); });
  await page.waitForFunction(() => document.querySelector("#app")?._vnode?.component?.proxy?.controller?.renderer?.layout);
  if (compact) await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 720));
};
const close = async () => { if (application) await application.close(); application = null; page = null; };
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const snapshot = () => page.evaluate(() => {
  const vm = document.querySelector("#app")._vnode.component.proxy;
  const engine = vm.controller.engine;
  const s = engine.getSnapshot();
  return {
    challengeActive: vm.challengeActive, challengeStatus: vm.challengeStatus, index: vm.activeChallengeIndex,
    tutorialActive: vm.tutorialActive,
    notice: vm.challengeNotice, revision: vm.gameState.positionRevision,
    actions: JSON.parse(JSON.stringify(vm.localGameActions)), players: JSON.parse(JSON.stringify(vm.activeLocalPlayers)),
    currentPlayer: s.currentPlayer, completed: [...vm.completedChallenges], activeUtilityDeck: vm.activeUtilityDeck,
    rule: { gridSize: s.gridSize, playerCount: s.playerCount, startPlayer: s.startPlayer, currentPlayer: s.currentPlayer,
      rulesVersion: s.rulesVersion, gameOver: s.gameOver, winner: s.winner, turnCount: s.turnCount,
      consecutiveSkips: s.consecutiveSkips, resignedPlayers: [...s.resignedPlayers], boardMatrix: s.boardMatrix,
      edges: s.edges, territories: s.territories, historyHashes: [...engine.historyHashes].sort() },
  };
});
const expectedRule = actions => page.evaluate(actions => {
  const vm = document.querySelector("#app")._vnode.component.proxy;
  const level = vm.challengeLevels[vm.activeChallengeIndex];
  const engine = new vm.controller.engine.constructor(level);
  for (const action of [...level.prefix, ...actions]) {
    if (engine.getCurrentPlayer() !== action.player) throw new Error("Reference turn mismatch");
    const result = action.type === "skip" ? engine.skipTurn() : engine.playMove(action.point);
    if (!result.success) throw new Error(`Illegal reference move: ${JSON.stringify(action)}`);
  }
  const s = engine.getSnapshot();
  return { gridSize: s.gridSize, playerCount: s.playerCount, startPlayer: s.startPlayer, currentPlayer: s.currentPlayer,
    rulesVersion: s.rulesVersion, gameOver: s.gameOver, winner: s.winner, turnCount: s.turnCount,
    consecutiveSkips: s.consecutiveSkips, resignedPlayers: [...s.resignedPlayers], boardMatrix: s.boardMatrix,
    edges: s.edges, territories: s.territories, historyHashes: [...engine.historyHashes].sort() };
}, actions);
const clickPoint = async (point, expectMove = true) => {
  const target = await page.evaluate(point => {
    const vm = document.querySelector("#app")._vnode.component.proxy;
    const pixel = vm.controller.renderer.getPointPixelCoordinates(point);
    const rect = vm.controller.renderer.canvas.getBoundingClientRect();
    const layout = vm.controller.renderer.layout;
    const x = rect.left + pixel.x * rect.width / layout.cssWidth;
    const y = rect.top + pixel.y * rect.height / layout.cssHeight;
    const hit = document.elementFromPoint(x, y);
    return { x, y, point, revision: vm.gameState.positionRevision, index: vm.activeChallengeIndex,
      localSetupPending: vm.localSetupPending, selectedPlayers: JSON.parse(JSON.stringify(vm.selectedLocalPlayers)),
      selectedSettings: [vm.selectedPlayerCount, vm.selectedGridSize, vm.selectedStartPlayer, vm.selectedTurnTimerEnabled, vm.selectedTurnTimeLimitSeconds, vm.selectedHintEnabled, vm.selectedHintMaxCount],
      canvasPointerEvents: getComputedStyle(vm.controller.renderer.canvas).pointerEvents,
      readOnlyMode: vm.controller.readOnlyMode, canvasRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      hitElement: hit ? { tag: hit.tagName, className: hit.className } : null,
      legal: vm.controller.engine.getSnapshot().legalMoves.some(move => move.point[0] === point[0] && move.point[1] === point[1]) };
  }, point);
  receipt.interactions.push(target);
  await page.mouse.click(target.x, target.y);
  if (expectMove) await page.waitForFunction(revision => document.querySelector("#app")._vnode.component.proxy.gameState.positionRevision > revision, target.revision, { timeout: 5_000 });
  else await page.waitForTimeout(400);
  return snapshot();
};
const clickAnyMove = async (index = 0, expectMove = true) => {
  const point = await page.evaluate(index => {
    const moves = document.querySelector("#app")._vnode.component.proxy.controller.engine.getSnapshot().legalMoves;
    return moves[index % moves.length]?.point;
  }, index);
  assert.ok(point, "a legal move must exist for the intended lock test");
  return clickPoint(point, expectMove);
};
const openCampaign = async () => {
  if (!await page.locator(".utility-overlay-campaign").isVisible()) await page.locator(".dock-launcher-campaign").click();
  await page.locator(".campaign-level-list").waitFor();
};
const enter = async index => {
  await openCampaign();
  await page.locator(".campaign-level-card").nth(index).click();
  await page.waitForFunction(index => {
    const vm = document.querySelector("#app")._vnode.component.proxy;
    return vm.challengeActive && vm.challengeStatus === "running" && vm.activeChallengeIndex === index;
  }, index);
  // Let the actual closing transition detach the outgoing level-list hit area.
  await page.locator(".utility-overlay-campaign").waitFor({ state: "detached" });
  await settle();
  assert.deepEqual((await snapshot()).rule, await expectedRule([]), "loaded challenge must match direct engine prefix replay");
};
const expectStatus = status => page.waitForFunction(status => document.querySelector("#app")._vnode.component.proxy.challengeStatus === status, status, { timeout: 5_000 });
const verifyTerminalLock = async () => {
  const before = await snapshot();
  assert.equal(before.challengeActive, true, "challenge mode stays active after a result");
  if (await page.locator("canvas.game-canvas").getAttribute("aria-disabled") !== "true") {
    receipt.findings.push(`Terminal challenge ${before.index} exposes aria-disabled=false; its real click lock is checked separately.`);
  }
  const after = await clickAnyMove(0, false);
  assert.deepEqual(after.rule, before.rule, "terminal challenge canvas click cannot change engine state");
  assert.equal(await page.getByRole("button", { name: label("跳过回合", "Skip Turn"), exact: true }).isDisabled(), true,
    "terminal challenge skip action must be disabled");
};

try {
  await launch();
  const welcome = page.locator(".welcome-overlay");
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: english ? "English" : "简体中文", exact: true }).click();
  if (english && await page.evaluate(() => document.querySelector("#app")._vnode.component.proxy.language !== "en")) {
    await page.locator(".player-preferences > summary").click();
    await page.locator(".player-preferences select").first().selectOption("en");
    await page.locator(".player-preferences > summary").click();
  }
  const skip = page.getByRole("button", { name: label("跳过教学", "Skip tutorial"), exact: true });
  if (await skip.isVisible()) await skip.click();
  await page.waitForFunction(() => !document.querySelector("#app")._vnode.component.proxy.tutorialActive);
  if (keyboardBoard) {
    receipt.findings.push("Core logic run uses keyboard to open Board because the six-level package has a separately reproduced Campaign/Board mouse-target overlap.");
    await page.locator(".dock-launcher-board").focus();
    await page.locator(".dock-launcher-board").press("Enter");
  } else await page.locator(".dock-launcher-board").click();
  await page.locator("#grid-size").getByRole("radio", { name: "5", exact: true }).click();
  await page.locator("#local-player-BLACK").selectOption("human");
  await page.locator("#local-player-WHITE").selectOption("human");
  await page.locator(".utility-overlay-board .utility-close").click();
  await page.locator(".utility-overlay-board").waitFor({ state: "detached" });
  await page.getByRole("button", { name: label("开始对局", "Start match"), exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("#app")._vnode.component.proxy.localSetupPending);
  await clickAnyMove(0);
  await clickAnyMove(2);
  const ordinary = await snapshot();
  const ordinarySave = fs.readFileSync(saveFile, "utf8");
  const assertOrdinaryFile = () => assert.equal(fs.readFileSync(saveFile, "utf8"), ordinarySave, "challenge activity must preserve ordinary save bytes");
  receipt.ordinaryBefore = ordinary;
  const levels = await page.evaluate(() => JSON.parse(JSON.stringify(document.querySelector("#app")._vnode.component.proxy.challengeLevels)));
  receipt.levelCount = levels.length;
  const playedLevels = allLevels ? levels.map((_, index) => index) : [0, 1, 2, 3, 4, 5];
  if (allLevels) assert.ok(levels.length >= 24 && levels.length <= 36, "full campaign must have 24–36 authored entries");
  const playReference = async index => {
    phase = `actual UI ${levels[index].id}`;
    await enter(index);
    const applied = [];
    for (let cursor = 0; cursor < levels[index].referenceSolution.length; cursor += 1) {
      const action = levels[index].referenceSolution[cursor];
      assert.equal(action.player, "BLACK", "a challenge decision starts with a Blue action");
      await page.waitForFunction(() => document.querySelector("#app")._vnode.component.proxy.gameState.currentPlayer === "BLACK");
      await clickPoint(action.point);
      applied.push(action);
      if (levels[index].referenceSolution[cursor + 1]?.player === "WHITE") {
        applied.push(levels[index].referenceSolution[++cursor]);
        const expected = await expectedRule(applied);
        await page.waitForFunction(turnCount => {
          const vm = document.querySelector("#app")._vnode.component.proxy;
          return vm.controller.engine.getSnapshot().turnCount >= turnCount;
        }, expected.turnCount, { timeout: 5_000 });
      }
      assert.deepEqual((await snapshot()).rule, await expectedRule(applied), "actual player and scripted opponent actions match independent engine replay");
    }
    await expectStatus("won");
    await verifyTerminalLock();
    assertOrdinaryFile();
    const persisted = JSON.parse(fs.readFileSync(progressFile, "utf8")).payload.completedChallenges;
    assert.ok(persisted.includes(levels[index].id), `${levels[index].id} completion must be durable`);
    receipt.milestones.push({ id: levels[index].id, status: "won", actions: applied });
  };
  // Play the first two lessons before exercising C03 so this path also works
  // if the catalog later introduces sequential chapter unlocking.
  await playReference(0);
  await playReference(1);

  phase = "legal failure and retry";
  await enter(2);
  assertOrdinaryFile();
  const initialChallenge = await snapshot();
  await clickPoint([2, 1]);
  await expectStatus("failed");
  assert.match(await page.locator(".challenge-banner").innerText(), english ? /Move limit reached/ : /步数已用完/);
  await verifyTerminalLock();
  assertOrdinaryFile();
  await page.screenshot({ path: path.join(evidence, "failure-retry-visible.png"), fullPage: true });
  await page.getByRole("button", { name: label("重试", "Retry"), exact: true }).click();
  await expectStatus("running");
  assert.deepEqual((await snapshot()).rule, initialChallenge.rule, "retry restores exact prefix rule state");
  receipt.milestones.push("legal C03 failure, terminal board lock, exact retry and ordinary-save isolation passed");

  phase = "alternate solution";
  await clickPoint([3, 0]);
  await expectStatus("won");
  assert.deepEqual((await snapshot()).rule, await expectedRule([{ type: "move", player: "BLACK", point: [3, 0] }]));
  await verifyTerminalLock();
  assertOrdinaryFile();
  assert.ok(JSON.parse(fs.readFileSync(progressFile, "utf8")).payload.completedChallenges.includes("C03-close-corner"));
  receipt.milestones.push("C03 alternative solution [3,0] accepted by actual UI and persisted");

  for (const index of playedLevels.filter(index => index > 2)) await playReference(index);

  phase = "original match restoration";
  await page.getByRole("button", { name: label("返回关卡", "Back to levels"), exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("#app")._vnode.component.proxy.challengeActive);
  await settle();
  const restored = await snapshot();
  assert.deepEqual(restored.rule, ordinary.rule, "leaving challenges restores the exact free match");
  assert.deepEqual(restored.actions, ordinary.actions);
  assert.deepEqual(restored.players, ordinary.players);
  assertOrdinaryFile();
  if (!await page.locator(".utility-overlay-campaign").isVisible()) receipt.findings.push("The Back to levels button restores the free match but does not open the advertised level list.");
  receipt.milestones.push("change/retry/win/leave challenges retained one exact original free match");

  phase = "preferences and restart";
  if (await page.locator(".utility-overlay-campaign").isVisible()) await page.locator(".utility-overlay-campaign .utility-close").click();
  await page.locator(".player-preferences > summary").click();
  await page.locator(".player-preferences input[type=checkbox]").nth(0).uncheck();
  await page.locator(".player-preferences input[type=checkbox]").nth(1).check();
  await settle();
  assertOrdinaryFile();
  const preferencePayload = JSON.parse(fs.readFileSync(preferencesFile, "utf8")).payload;
  assert.equal(preferencePayload.audioEnabled, false);
  assert.equal(preferencePayload.reducedMotion, true);
  await page.locator(".player-preferences > summary").click();
  await openCampaign();
  receipt.completed = (await snapshot()).completed;
  assert.deepEqual([...receipt.completed].sort(), playedLevels.map(index => levels[index].id).sort());
  await page.screenshot({ path: path.join(evidence, "completed-levels.png"), fullPage: true });
  receipt.viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(receipt.viewport.scrollWidth <= receipt.viewport.width);
  await close();
  await launch();
  const restartSkip = page.getByRole("button", { name: label("跳过教学", "Skip tutorial"), exact: true });
  if (await restartSkip.isVisible()) {
    receipt.findings.push("Returning player was sent into teaching again; visible Skip tutorial restores their existing free match.");
    await restartSkip.click();
  }
  await settle();
  const reopened = await snapshot();
  assert.deepEqual(reopened.completed.sort(), receipt.completed.sort());
  assert.deepEqual(reopened.rule, ordinary.rule);
  assert.deepEqual(reopened.actions, ordinary.actions);
  assertOrdinaryFile();
  assert.deepEqual(JSON.parse(fs.readFileSync(preferencesFile, "utf8")).payload, preferencePayload);
  receipt.milestones.push(`all ${playedLevels.length} challenge successes, preferences and original free match persisted through close/reopen`);
  assert.deepEqual(receipt.errors, []);
  assert.deepEqual(receipt.badResponses, []);
  assert.deepEqual(receipt.externalRequests, []);
  assert.equal(hash(archive), receipt.packageSha256);
  receipt.status = receipt.findings.length ? "CORE_PASS_WITH_FINDINGS" : allLevels ? "FULL_CAMPAIGN_UI_PASS" : "SIX_CHALLENGE_UI_PASS";
  if (receipt.findings.length) process.exitCode = 1;
} catch (error) {
  receipt.status = "FAIL";
  receipt.phase = phase;
  receipt.error = String(error.stack ?? error);
  if (page) {
    receipt.failedState = await snapshot().catch(() => null);
    await page.screenshot({ path: path.join(evidence, "failure.png"), fullPage: true }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  await close().catch(error => { receipt.closeError = String(error); });
  fs.writeFileSync(path.join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ ...receipt, ordinaryBefore: undefined, interactions: undefined, failedState: undefined }));
}
