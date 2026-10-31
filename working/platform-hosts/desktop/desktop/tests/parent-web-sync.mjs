import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";

// All game actions use the shipped UI. Evaluation reads state/geometry only;
// the Worker observer forwards native messages and never fabricates results.
const root = fileURLToPath(new URL("../../", import.meta.url));
const executable = path.resolve(process.env.LIFELINE_WEB_SYNC_APP_PATH ?? path.join(root, "desktop/release/win-unpacked/LIFELINE.exe"));
const legacyExecutable = path.resolve(process.env.LIFELINE_WEB_SYNC_LEGACY_APP_PATH ?? path.join(root, "desktop/release/candidates/0.3.0-rc1/win-unpacked/LIFELINE.exe"));
const archive = file => path.join(path.dirname(file), "resources/app.asar");
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
fs.mkdirSync(path.join(root, "local_artifacts"), { recursive: true });
const evidence = fs.mkdtempSync(path.join(root, "local_artifacts/parent-web-sync-"));
const receipt = { status: "RUNNING", evidence, executable, milestones: [], errors: [], badResponses: [], externalRequests: [], modelAssets: [] };
let application, page, phase = "preflight";
const record = (name, details = {}) => {
  receipt.milestones.push({ name, ...details });
  fs.writeFileSync(path.join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2));
};
const observeWorkers = () => {
  globalThis.__parentSyncWorkers = [];
  const NativeWorker = globalThis.Worker;
  globalThis.Worker = new Proxy(NativeWorker, {
    construct(target, args) {
      const worker = new target(...args);
      const trace = { url: String(args[0]), requests: [], replies: [], terminated: false };
      globalThis.__parentSyncWorkers.push(trace);
      const post = worker.postMessage;
      worker.postMessage = function (message, ...rest) {
        trace.requests.push({ id: message.requestId, type: message.type, at: performance.now(),
          player: message.aiPlayer, strategy: message.strategy, modelId: message.modelId,
          revision: message.serializedState?.positionRevision, playerCount: message.serializedState?.playerCount,
          boardShape: message.serializedState?.boardShape });
        return post.call(this, message, ...rest);
      };
      worker.addEventListener("message", ({ data }) => trace.replies.push({ id: data?.requestId, type: data?.type,
        at: performance.now(), player: data?.currentPlayer, modelInfo: data?.modelInfo, moves: data?.moves, message: data?.message }));
      const terminate = worker.terminate;
      worker.terminate = function (...rest) { trace.terminated = true; return terminate.apply(this, rest); };
      return worker;
    },
  });
};
const launch = async (profile, file = executable) => {
  const env = { ...process.env, LIFELINE_TEST_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath: file, env, timeout: 60_000 });
  page = await application.firstWindow();
  page.on("pageerror", error => receipt.errors.push({ phase, message: error.message }));
  page.on("response", response => {
    if (response.status() >= 400) receipt.badResponses.push({ phase, url: response.url(), status: response.status() });
    if (/assets\/research-ai\/.+\.(json|f32)/.test(response.url())) receipt.modelAssets.push({ phase, url: response.url(), status: response.status() });
  });
  page.on("request", request => { if (/^(https?|wss?):/i.test(request.url())) receipt.externalRequests.push({ phase, url: request.url() }); });
  await page.addInitScript(observeWorkers);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelector("#app")?._vnode?.component?.proxy?.controller?.renderer?.layout, null, { timeout: 30_000 });
  const welcome = page.locator(".welcome-overlay");
  if (await welcome.isVisible()) await welcome.getByRole("button", { name: "English", exact: true }).click();
};
const close = async () => { if (application) await application.close(); application = null; page = null; };
const skipTutorial = async () => {
  const skip = page.getByRole("button", { name: /^(Skip tutorial|跳过教学)$/, exact: true });
  if (await skip.isVisible()) await skip.click();
  await page.waitForFunction(() => !document.querySelector("#app")._vnode.component.proxy.tutorialActive);
};
const state = () => page.evaluate(() => {
  const vm = document.querySelector("#app")._vnode.component.proxy;
  const engine = vm.controller.engine, snapshot = engine.getSnapshot();
  return JSON.parse(JSON.stringify({ actions: vm.localGameActions, thinking: vm.aiThinking,
    currentPlayer: snapshot.currentPlayer, playerCount: snapshot.playerCount, boardShape: engine.boardShape,
    starts: engine.initialPositions, territoryPending: snapshot.territoryPending, territories: snapshot.territories,
    undoRemaining: vm.undoRemainingCount, undoDisabled: vm.undoDisabled, undoUsage: vm.undoUsage,
    replayMode: vm.replayMode, replayCursor: vm.replayCursor, replayError: vm.replayError,
    tutorialActive: vm.tutorialActive, challengeActive: vm.challengeActive,
    rule: { gridSize: snapshot.gridSize, playerCount: snapshot.playerCount, startPlayer: snapshot.startPlayer,
      currentPlayer: snapshot.currentPlayer, rulesVersion: snapshot.rulesVersion, gameOver: snapshot.gameOver,
      consecutiveSkips: snapshot.consecutiveSkips, resignedPlayers: snapshot.resignedPlayers, turnCount: snapshot.turnCount,
      boardMatrix: snapshot.boardMatrix, edges: snapshot.edges, territories: snapshot.territories,
      historyHashes: [...engine.historyHashes].sort() }, workers: globalThis.__parentSyncWorkers }));
});
const settled = async () => {
  await page.waitForFunction(() => !document.querySelector("#app")._vnode.component.proxy.controller.engine.getSnapshot().territoryPending, null, { timeout: 60_000 });
  return state();
};
const clickLegal = async (index = 0) => {
  // A closing Vue transition can still intercept pointers after its reactive
  // visible flag has cleared. Wait for a real hit target, never retry a move.
  await page.waitForFunction(index => {
    const vm = document.querySelector("#app")._vnode.component.proxy, renderer = vm.controller.renderer;
    const point = vm.controller.engine.getSnapshot().legalMoves[index]?.point;
    if (!point || !renderer.layout) return false;
    const pixel = renderer.getPointPixelCoordinates(point), rect = renderer.canvas.getBoundingClientRect();
    return document.elementFromPoint(rect.left + pixel.x * rect.width / renderer.layout.cssWidth,
      rect.top + pixel.y * rect.height / renderer.layout.cssHeight) === renderer.canvas;
  }, index, { timeout: 5_000 });
  const target = await page.evaluate(index => {
    const vm = document.querySelector("#app")._vnode.component.proxy, renderer = vm.controller.renderer;
    const point = vm.controller.engine.getSnapshot().legalMoves[index]?.point;
    if (!point) throw new Error("Expected a legal human move");
    const pixel = renderer.getPointPixelCoordinates(point), rect = renderer.canvas.getBoundingClientRect();
    return { point, x: rect.left + pixel.x * rect.width / renderer.layout.cssWidth,
      y: rect.top + pixel.y * rect.height / renderer.layout.cssHeight, revision: vm.gameState.positionRevision };
  }, index);
  await page.mouse.click(target.x, target.y);
  await page.waitForFunction(revision => document.querySelector("#app")._vnode.component.proxy.gameState.positionRevision > revision, target.revision, { timeout: 5_000 });
  return target.point;
};
const boardOpen = async () => {
  const resultClose = page.getByRole("button", { name: /^(Close Prompt|关闭提示)$/, exact: true });
  if (await resultClose.isVisible()) {
    await resultClose.click();
    await page.locator(".result-overlay").waitFor({ state: "detached", timeout: 5_000 });
  }
  if (!await page.locator(".utility-overlay-board").isVisible()) await page.locator(".dock-launcher-board").click();
};
const boardClose = async () => {
  const overlay = page.locator(".utility-overlay-board");
  if (await overlay.isVisible() && await page.evaluate(() => document.querySelector("#app")._vnode.component.proxy.activeUtilityDeck === "board")) {
    await overlay.locator(".utility-close").click();
  }
  await overlay.waitFor({ state: "detached", timeout: 5_000 });
};
const choose = async (selector, desired, alternate) => {
  const select = page.locator(selector);
  const values = await select.locator("option").evaluateAll(options => options.map(option => option.value));
  assert.ok(values.includes(desired) || alternate && values.includes(alternate), `${selector} is missing ${desired}`);
  await select.selectOption(values.includes(desired) ? desired : alternate);
};
const setup = async ({ count = 2, shape = "triangle", grid = 5, ai = {}, undo = false, starts = "default" } = {}) => {
  await boardOpen();
  await page.locator("#player-count").getByRole("radio", { name: String(count), exact: true }).click();
  await page.locator(`[data-board-shape="${shape}"]`).click();
  await page.locator("#grid-size").getByRole("radio", { name: String(grid), exact: true }).click();
  for (const color of ["BLACK", "WHITE", "PURPLE", "GREEN", "ORANGE", "CYAN"].slice(0, count)) {
    await choose(`#local-player-${color}`, ai[color] ?? "human", ai[color] === "minimax" ? "ai" : undefined);
  }
  await page.locator("#local-start-player").selectOption("BLACK");
  await page.locator("#turn-timer-enabled").uncheck();
  await page.locator("#undo-enabled").setChecked(undo);
  if (undo) { await page.locator("#undo-max-count").fill("2"); await page.locator("#undo-max-count").press("Tab"); }
  await page.locator(`[data-start-mode="${starts}"]`).click();
  const preview = starts === "random" ? await page.locator(".starting-point-seat").allTextContents() : null;
  await page.locator(".starting-point-start").click();
  await page.waitForFunction(() => !document.querySelector("#app")._vnode.component.proxy.localSetupPending);
  await boardClose();
  const initial = await settled();
  assert.equal(initial.playerCount, count);
  assert.equal(initial.boardShape, shape);
  assert.equal(initial.actions.length, 0);
  return { initial, preview };
};
const undoButton = () => page.locator(".duel-actions").getByRole("button", { name: /^(Undo|悔棋)/ });
const assertUndoBlocked = async name => {
  assert.equal((await state()).undoDisabled, true, `${name} must block undo in its handler`);
  if (await undoButton().count()) assert.ok(!await undoButton().isVisible() || await undoButton().isDisabled(), `${name} must not offer an active undo button`);
};
const menuClick = async name => {
  const menu = page.locator(".player-menu");
  if (await menu.getAttribute("open") === null) await menu.locator(":scope > summary").click();
  await menu.getByRole("button", { name, exact: true }).click();
};
const waitAI = async (before, replies = 1) => {
  await page.waitForFunction(({ before, replies }) => {
    const vm = document.querySelector("#app")._vnode.component.proxy;
    // Canonical auto-skips can leave the only human without a legal move. The
    // AI seats may then finish the game without returning control to BLACK.
    return vm.gameState.gameOver || !vm.aiThinking && vm.localGameActions.length >= before + replies + 1 && vm.gameState.currentPlayer === "BLACK";
  }, { before, replies }, { timeout: 45_000 });
  return settled();
};
const successfulAI = snapshot => snapshot.workers.filter(worker => /AIWorker\.js/.test(worker.url)).flatMap(worker =>
  worker.replies.filter(reply => reply.type === "RESULT").map(reply => ({ request: worker.requests.find(request => request.id === reply.id), reply })));
const checkGuideContents = async () => {
  const reader = await page.locator(".guide-reader").elementHandle();
  const links = page.locator('.guide-reader a.guide-inline-link[href^="#"]');
  const entries = await links.evaluateAll(nodes => nodes.map(node => ({ href: node.getAttribute("href"), text: node.textContent,
    tag: document.getElementById(decodeURIComponent(node.getAttribute("href").slice(1)))?.tagName })));
  assert.ok(entries.length >= 6, "each article needs a substantive linked chapter/subsection contents list");
  assert.ok(entries.every(entry => ["H3", "H4", "H5"].includes(entry.tag)), "every contents link must resolve to a packaged heading");
  const identity = await page.evaluate(() => ({ url: location.href.split("#")[0],
    entry: document.querySelector("#app")._vnode.component.proxy.activeGuideEntry.key,
    tab: document.querySelector('.guide-sub-tab[aria-selected="true"]')?.textContent }));
  const clicks = [];
  for (const index of [0, entries.length - 1]) {
    const link = links.nth(index), entry = entries[index];
    await link.scrollIntoViewIfNeeded();
    const before = await page.locator(".guide-reader-layout").evaluate(node => node.scrollTop);
    await link.click();
    await page.waitForFunction(href => {
      const heading = document.getElementById(decodeURIComponent(href.slice(1)));
      const scroller = document.querySelector(".guide-reader-layout");
      if (!heading || !scroller || decodeURIComponent(location.hash) !== decodeURIComponent(href)) return false;
      const rect = heading.getBoundingClientRect(), clip = scroller.getBoundingClientRect();
      return rect.top >= Math.max(0, clip.top) - 1 && rect.bottom <= Math.min(innerHeight, clip.bottom) + 1;
    }, entry.href, { timeout: 5_000 });
    const after = await page.locator(".guide-reader-layout").evaluate(node => node.scrollTop);
    assert.ok(Math.abs(after - before) > 20, "a contents click must actually scroll the reader to its heading");
    assert.equal(await reader.evaluate(node => node === document.querySelector(".guide-reader")), true, "contents navigation must retain the same reader DOM");
    assert.deepEqual(await page.evaluate(() => ({ url: location.href.split("#")[0],
      entry: document.querySelector("#app")._vnode.component.proxy.activeGuideEntry.key,
      tab: document.querySelector('.guide-sub-tab[aria-selected="true"]')?.textContent })), identity);
    clicks.push({ ...entry, scrollBefore: before, scrollAfter: after, sameReader: true, headingVisible: true });
  }
  await reader.dispose();
  return { links: entries.length, clicks };
};

try {
  assert.ok(fs.existsSync(executable), "Build the current unpacked desktop before running this check");
  receipt.packageSha256 = hash(archive(executable));
  assert.ok(fs.existsSync(legacyExecutable), "The frozen 0.3.0-rc1 unpacked candidate is needed for the upgrade path");
  receipt.legacyPackageSha256 = hash(archive(legacyExecutable));
  const profile = path.join(evidence, "profile");
  phase = "old real package creates a save";
  await launch(profile, legacyExecutable);
  await skipTutorial();
  await boardOpen();
  await page.locator("#grid-size").getByRole("radio", { name: "5", exact: true }).click();
  await page.locator("#local-player-BLACK").selectOption("human");
  await page.locator("#local-player-WHITE").selectOption("human");
  await boardClose();
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await clickLegal(); await clickLegal();
  await page.keyboard.press("Control+s");
  const legacy = await settled();
  assert.equal(legacy.actions.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, "saves/current.json"), "utf8")).schemaVersion, 1);
  await close();
  phase = "current package upgrades the existing save";
  await launch(profile);
  await skipTutorial();
  const upgraded = await settled();
  assert.deepEqual(upgraded.actions, legacy.actions);
  assert.deepEqual(upgraded.rule, legacy.rule, "upgrade must preserve the complete old rule state including history and territory");
  await page.keyboard.press("Control+s");
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, "saves/current.json"), "utf8")).schemaVersion, 2);
  record(phase, { actionCount: upgraded.actions.length, saveSha256: hash(path.join(profile, "saves/current.json")) });

  phase = "old 0.3 package preserves newer native save as read-only";
  await close();
  const downgradeProfile = path.join(evidence, "downgrade-profile");
  fs.cpSync(profile, downgradeProfile, { recursive: true, errorOnExist: true });
  const preservedFiles = ["current.json", "current.json.bak"].map(name => {
    const file = path.join(downgradeProfile, "saves", name);
    return { file, name, text: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null };
  });
  await launch(downgradeProfile, legacyExecutable);
  await skipTutorial();
  assert.match(await page.locator("body").innerText(), /newer version.*read-only/i);
  await boardOpen();
  await page.locator("#local-player-BLACK").selectOption("human");
  await page.locator("#local-player-WHITE").selectOption("human");
  await boardClose();
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await clickLegal();
  assert.match(await page.locator("body").innerText(), /newer version.*read-only/i);
  await page.screenshot({ path: path.join(evidence, "old-version-readonly.png"), fullPage: true });
  await close();
  for (const file of preservedFiles) {
    assert.equal(fs.existsSync(file.file) ? fs.readFileSync(file.file, "utf8") : null, file.text, `old package must preserve ${file.name} byte-for-byte`);
  }
  record(phase, { scope: "frozen 0.3.0-rc1, synthetic cloned profile, startup/new match/one real move/close",
    preserved: preservedFiles.map(file => ({ name: file.name, sha256: file.text === null ? null : hash(file.file) })) });
  await launch(profile);
  await skipTutorial();

  phase = "real AI reply and configurable undo";
  const { initial } = await setup({ ai: { WHITE: "minimax" }, undo: true });
  await clickLegal();
  const replied = await waitAI(0);
  assert.ok(successfulAI(replied).length, "a real AI Worker must reply before undo");
  await undoButton().click();
  await page.waitForFunction(() => document.querySelector("#app")._vnode.component.proxy.localGameActions.length === 0);
  const undone = await settled();
  assert.deepEqual(undone.rule, initial.rule, "undo restores the human move and AI reply, history, current player and scores");
  assert.equal(undone.undoRemaining, 1);
  // A rewind changes the engine revision. The very next live move must still
  // append exactly once rather than colliding with the pre-rewind revision.
  await clickLegal();
  const playedAgain = await waitAI(0);
  assert.equal(playedAgain.actions.length, 2);
  assert.equal(playedAgain.undoRemaining, 1);
  const playedAgainSave = JSON.parse(fs.readFileSync(path.join(profile, "saves/current.json"), "utf8")).payload;
  assert.deepEqual(playedAgainSave.actions, playedAgain.actions);
  assert.equal(playedAgainSave.match.undo.usedCount, 1);
  await close(); await launch(profile); await skipTutorial();
  const resumedUndo = await settled();
  assert.equal(resumedUndo.undoRemaining, 1, "restart must not refill the configured undo quota");
  assert.deepEqual(resumedUndo.actions, playedAgain.actions);
  await undoButton().click();
  await page.waitForFunction(() => document.querySelector("#app")._vnode.component.proxy.localGameActions.length === 0);
  const exhausted = await settled();
  assert.equal(exhausted.undoRemaining, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, "saves/current.json"), "utf8")).payload.match.undo.usedCount, 2);
  record(phase, { replayedActions: playedAgain.actions, remainingAfterRestart: resumedUndo.undoRemaining, remainingAfterSecondUndo: exhausted.undoRemaining });

  phase = "three-player triangle medium Worker";
  await setup({ count: 3, ai: { WHITE: "ai-medium", PURPLE: "ai-easy" } });
  await clickLegal();
  const three = await waitAI(0, 2);
  const medium = successfulAI(three).find(result => result.request?.modelId === "multiplayer-medium-v1");
  assert.ok(medium, "native three-player medium must load its actual runtime model");
  assert.equal(medium.reply.modelInfo.id, "multiplayer-medium-v1");
  record(phase, { actions: three.actions, medium });

  phase = "six-player hexagon mixed human and AI round";
  await setup({ count: 6, shape: "hexagon", ai: { WHITE: "ai-easy", GREEN: "ai-medium", CYAN: "ai-hard" } });
  for (let turn = 0; turn < 3; turn++) {
    const before = (await state()).actions.length;
    await clickLegal();
    await page.waitForFunction(before => {
      const vm = document.querySelector("#app")._vnode.component.proxy;
      return !vm.aiThinking && vm.localGameActions.length >= before + 2;
    }, before, { timeout: 45_000 });
  }
  const six = await settled();
  assert.equal(six.actions.length, 6);
  assert.equal(six.currentPlayer, "BLACK");
  assert.equal(Object.keys(six.territories).length, 6);
  const sixResults = successfulAI(six).filter(result => result.request?.playerCount === 6);
  assert.deepEqual(sixResults.map(result => result.request.player).sort(), ["CYAN", "GREEN", "WHITE"]);
  assert.ok(sixResults.every(result => result.request.boardShape === "hexagon" && result.reply.modelInfo.id === result.request.modelId));
  await page.screenshot({ path: path.join(evidence, "six-player-round.png"), fullPage: true });
  record(phase, { actions: six.actions, territories: six.territories, workers: sixResults });

  phase = "non-native triangle hard Worker";
  await setup({ count: 4, shape: "triangle", ai: { WHITE: "ai-hard", PURPLE: "ai-easy", GREEN: "ai-easy" } });
  await clickLegal();
  const generic = await waitAI(0, 3);
  const hard = successfulAI(generic).find(result => result.request?.modelId === "multiplayer-hard-v1" && result.request.boardShape === "triangle");
  assert.ok(hard, "non-native board hard must execute the generic multiplayer runtime");
  record(phase, { actions: generic.actions, hard });

  phase = "random and custom starting-point UI";
  const random = await setup({ count: 3, starts: "random" });
  assert.equal(new Set(Object.values(random.initial.starts).map(point => point.join(","))).size, 3);
  for (const [index, point] of Object.values(random.initial.starts).entries()) {
    assert.ok(random.preview[index].includes(`(${point[0] + 1}, ${point[1] + 1})`), "started random roots match the visible preview");
  }
  await boardOpen();
  await page.locator('[data-start-mode="custom"]').click();
  await page.locator('[data-start-player="BLACK"]').click();
  const available = await page.locator(".starting-point-preview [data-start-point]").evaluateAll(nodes => {
    const empty = nodes.find(node => !node.textContent.trim());
    return empty?.getAttribute("data-start-point");
  });
  assert.ok(available);
  await page.locator(`[data-start-point="${available}"]`).click();
  await page.locator(".starting-point-start").click();
  await boardClose();
  assert.deepEqual((await settled()).starts.BLACK, available.split(",").map(Number));
  record(phase, { randomStarts: random.initial.starts, customBlack: available });

  phase = "legacy schema-1 replay imports and undo review guard";
  await setup({ undo: true });
  for (const filename of ["replay-valid.json", "replay-cut-case.json", "replay-territory-case.json"]) {
    const fixture = path.join(root, "web/web前端/tests/fixtures", filename);
    const document = JSON.parse(fs.readFileSync(fixture, "utf8"));
    await boardOpen();
    await page.locator(".replay-file-input").setInputFiles(fixture);
    await page.waitForFunction(() => {
      const vm = document.querySelector("#app")._vnode.component.proxy;
      return !vm.replayBusy && vm.replayDocument && !vm.replayError;
    });
    await page.getByRole("button", { name: /^Review imported replay/ }).click();
    await boardClose();
    await page.waitForFunction(() => document.querySelector("#app")._vnode.component.proxy.replayMode);
    await assertUndoBlocked("review");
    await page.getByRole("button", { name: "Last", exact: true }).click();
    await page.waitForFunction(count => document.querySelector("#app")._vnode.component.proxy.replayCursor === count, document.actions.length);
    assert.equal((await state()).replayError, "");
    await page.getByRole("button", { name: "First", exact: true }).click();
    await page.getByRole("button", { name: "Exit review", exact: true }).click();
    record("legacy replay imported through UI", { filename, eventCount: document.actions.length });
  }

  phase = "tutorial and challenge undo guards";
  await menuClick("Tutorial");
  await page.waitForFunction(() => document.querySelector("#app")._vnode.component.proxy.tutorialActive);
  await assertUndoBlocked("tutorial");
  await skipTutorial();
  await menuClick("Challenges");
  assert.equal(await page.locator(".campaign-level-card").count(), 24);
  await page.locator(".campaign-level-card").first().click();
  await page.waitForFunction(() => document.querySelector("#app")._vnode.component.proxy.challengeActive);
  await assertUndoBlocked("challenge");
  await page.getByRole("button", { name: "Back to levels", exact: true }).click();
  if (await page.locator(".utility-overlay-campaign").isVisible()) await page.locator(".utility-overlay-campaign .utility-close").click();
  if (await page.locator(".player-menu").getAttribute("open") !== null) await page.locator(".player-menu > summary").click();
  record(phase);

  phase = "bilingual offline guide chapters and math";
  for (const language of ["zh", "en"]) {
    const preferences = page.locator(".player-preferences");
    if (await preferences.getAttribute("open") === null) await preferences.locator(":scope > summary").click();
    await preferences.locator("select").first().selectOption(language);
    await preferences.locator(":scope > summary").click();
    await page.locator(".dock-launcher-guide").click();
    for (const [entryIndex, tabIndex] of [[0, 2], [1, 1]]) {
      await page.locator(".guide-section-button").nth(entryIndex).click();
      await page.locator(".guide-sub-tab").nth(tabIndex).click();
      await page.locator(".guide-reader mjx-container").first().waitFor({ state: "attached", timeout: 30_000 });
      const content = await page.locator(".guide-reader-body").innerText();
      assert.match(content, language === "zh" ? /目录/ : /Contents/);
      assert.match(content, language === "zh" ? /数学/ : /Mathematics/i);
      assert.match(content, language === "zh" ? /算法/ : /Algorithms/i);
      assert.match(content, /AI/);
      assert.equal(await page.locator(".guide-reader mjx-merror").count(), 0);
      const brokenImages = await page.locator(".guide-reader img").evaluateAll(async images => {
        for (const image of images) { image.loading = "eager"; try { await image.decode(); } catch {} }
        return images.filter(image => !image.naturalWidth).map(image => image.src);
      });
      assert.deepEqual(brokenImages, []);
      const contents = await checkGuideContents();
      record("packaged guide chapter rendered", { language, entryIndex, tabIndex, textLength: content.length,
        mathCount: await page.locator(".guide-reader mjx-container").count(), contents });
      await page.screenshot({ path: path.join(evidence, `guide-${language}-${entryIndex}.png`), fullPage: true });
      await page.locator(".guide-close-button").click();
    }
    await page.locator(".utility-overlay-guide .utility-close").click();
  }
  assert.deepEqual(receipt.errors, []);
  assert.deepEqual(receipt.badResponses, []);
  assert.deepEqual(receipt.externalRequests, []);
  assert.equal(hash(archive(executable)), receipt.packageSha256);
  assert.equal(hash(archive(legacyExecutable)), receipt.legacyPackageSha256);
  receipt.status = "PACKAGED_WEB_SYNC_SCOPED_PASS";
} catch (error) {
  receipt.status = "FAIL";
  receipt.phase = phase;
  receipt.error = String(error.stack ?? error);
  if (page) await page.screenshot({ path: path.join(evidence, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (application) await close().catch(error => { receipt.closeError = String(error); process.exitCode = 1; });
  if (receipt.closeError) receipt.status = "FAIL";
  fs.writeFileSync(path.join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ status: receipt.status, phase: receipt.phase, evidence, milestones: receipt.milestones.length, error: receipt.error }));
}
