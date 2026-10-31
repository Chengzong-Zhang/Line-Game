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
fs.mkdirSync(path.join(root, "local_artifacts"), { recursive: true });
const evidence = fs.mkdtempSync(path.join(root, "local_artifacts/parent-desktop-ux-"));
const profile = path.join(evidence, "profile");
const saveFile = path.join(profile, "saves/current.json");
const preferencesFile = path.join(profile, "profile/settings/preferences.json");
const receipt = { status: "RUNNING", evidence, packageSha256: hash(archive), milestones: [], findings: [], errors: [], badResponses: [], externalRequests: [] };
let app, page;
let phase = "startup";
const launch = async () => {
  const env = { ...process.env, LIFELINE_TEST_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ executablePath: executable, env, timeout: 60_000 });
  page = await app.firstWindow();
  page.on("pageerror", error => receipt.errors.push(error.message));
  page.on("request", request => { if (/^(https?|wss?):/i.test(request.url())) receipt.externalRequests.push(request.url()); });
  page.on("response", response => { if (response.status() >= 400) receipt.badResponses.push({ url: response.url(), status: response.status() }); });
  await page.waitForFunction(() => document.querySelector("#app")?._vnode?.component?.proxy?.controller?.renderer?.layout);
};
const close = async () => { if (app) await app.close(); app = null; page = null; };
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const prefs = async (open = true) => {
  const panel = page.locator(".player-preferences");
  const current = (await panel.getAttribute("open")) !== null;
  if (current !== open) await panel.locator(":scope > summary").click();
  await settle();
};
const savedPreferences = () => JSON.parse(fs.readFileSync(preferencesFile, "utf8")).payload;
const snapshot = () => page.evaluate(() => {
  const vm = document.querySelector("#app")._vnode.component.proxy;
  const s = vm.controller.engine.getSnapshot();
  return { actions: JSON.parse(JSON.stringify(vm.localGameActions)), board: s.boardMatrix, edges: s.edges, territories: s.territories,
    currentPlayer: s.currentPlayer, turnCount: s.turnCount, history: [...vm.controller.engine.historyHashes].sort(),
    players: JSON.parse(JSON.stringify(vm.activeLocalPlayers)), tutorial: vm.tutorialActive, language: vm.language };
});
const clickLegal = async (index = 0) => {
  const target = await page.evaluate(index => {
    const vm = document.querySelector("#app")._vnode.component.proxy;
    const renderer = vm.controller.renderer;
    const legal = vm.controller.engine.getSnapshot().legalMoves;
    const point = legal[index % legal.length]?.point;
    if (!point) throw new Error("No legal move for scale/input check");
    const pixel = renderer.getPointPixelCoordinates(point);
    const rect = renderer.canvas.getBoundingClientRect();
    return { point, x: rect.left + pixel.x * rect.width / renderer.layout.cssWidth,
      y: rect.top + pixel.y * rect.height / renderer.layout.cssHeight, revision: vm.gameState.positionRevision };
  }, index);
  await page.mouse.click(target.x, target.y);
  await page.waitForFunction(previous => document.querySelector("#app")._vnode.component.proxy.gameState.positionRevision > previous, target.revision, { timeout: 5_000 });
  const state = await snapshot();
  assert.deepEqual(state.actions.at(-1).point, target.point, "scaled click must land on exactly the intended legal point");
  return target;
};
const setVolume = async value => {
  await prefs();
  const range = page.locator(".player-preferences input[type=range]");
  await range.focus();
  await range.press("Home");
  for (let count = 0; count < value / 5; count += 1) await range.press("ArrowRight");
  await settle();
  assert.equal(savedPreferences().audioVolume, value);
  await prefs(false);
};
const installAudioTrace = () => page.evaluate(() => {
  // Observe native AudioNodes without replacing the audio context or output.
  globalThis.__parentAudio = { starts: [], gains: [] };
  const proto = (globalThis.AudioContext ?? globalThis.webkitAudioContext).prototype;
  const createGain = proto.createGain;
  const createOscillator = proto.createOscillator;
  proto.createGain = function (...args) {
    const node = createGain.apply(this, args);
    for (const method of ["setValueAtTime", "linearRampToValueAtTime", "exponentialRampToValueAtTime"]) {
      const native = node.gain[method];
      node.gain[method] = function (value, time) {
        globalThis.__parentAudio.gains.push({ value, time, method });
        return native.call(this, value, time);
      };
    }
    return node;
  };
  proto.createOscillator = function (...args) {
    const node = createOscillator.apply(this, args);
    const native = node.start;
    node.start = function (...startArgs) {
      globalThis.__parentAudio.starts.push({ frequency: node.frequency.value, type: node.type });
      return native.apply(this, startArgs);
    };
    return node;
  };
});
const audioTrace = () => page.evaluate(() => JSON.parse(JSON.stringify(globalThis.__parentAudio)));
const clearAudioTrace = () => page.evaluate(() => { globalThis.__parentAudio.starts.length = 0; globalThis.__parentAudio.gains.length = 0; });
const checkLayout = async scale => {
  const state = await page.evaluate(() => {
    const canvas = document.querySelector("canvas.game-canvas").getBoundingClientRect();
    const controls = document.querySelector(".duel-actions").getBoundingClientRect();
    const menu = document.querySelector(".player-menu > summary").getBoundingClientRect();
    const board = document.querySelector(".dock-launcher-board").getBoundingClientRect();
    const overlapWidth = Math.max(0, Math.min(menu.right, board.right) - Math.max(menu.left, board.left));
    const overlapHeight = Math.max(0, Math.min(menu.bottom, board.bottom) - Math.max(menu.top, board.top));
    return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollWidth: document.documentElement.scrollWidth,
      canvas: { x: canvas.x, y: canvas.y, width: canvas.width, height: canvas.height, bottom: canvas.bottom },
      controls: { top: controls.top, bottom: controls.bottom }, menuBoardOverlapArea: overlapWidth * overlapHeight,
      zoom: getComputedStyle(document.querySelector(".app-shell")).zoom };
  });
  receipt.milestones.push({ scale, layout: state });
  if (state.scrollWidth > state.width) receipt.findings.push(`Scale ${scale} overflows horizontally: ${state.scrollWidth} > ${state.width}.`);
  if (state.canvas.height < 150 || state.canvas.bottom > state.height) receipt.findings.push(`Scale ${scale} does not keep the board inside the viewport: bottom ${state.canvas.bottom}, height ${state.height}.`);
  if (state.controls.bottom > state.height) receipt.findings.push(`Scale ${scale} puts required controls below the viewport: bottom ${state.controls.bottom}, height ${state.height}.`);
  if (state.menuBoardOverlapArea > 0) receipt.findings.push(`Scale ${scale} overlaps Menu with Board Deck by ${state.menuBoardOverlapArea} square CSS pixels.`);
};

try {
  await launch();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 720));
  await page.locator(".welcome-overlay").getByRole("button", { name: "English", exact: true }).click();
  await page.locator(".welcome-overlay").waitFor({ state: "detached" });
  assert.equal(savedPreferences().language, "en");
  const skip = page.getByRole("button", { name: "Skip tutorial", exact: true });
  if (await skip.isVisible()) await skip.click();
  await page.locator(".dock-launcher-board").click();
  await page.locator("#grid-size").getByRole("radio", { name: "7", exact: true }).click();
  await page.locator("#local-player-BLACK").selectOption("human");
  await page.locator("#local-player-WHITE").selectOption("human");
  await page.locator("#hint-enabled").check();
  await page.locator(".utility-overlay-board .utility-close").click();
  await page.locator(".utility-overlay-board").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Start match", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("#app")._vnode.component.proxy.localSetupPending);
  await installAudioTrace();

  phase = "audio and scaled mouse input";
  await setVolume(25);
  await clearAudioTrace();
  await clickLegal();
  const quarterAudio = await audioTrace();
  assert.ok(quarterAudio.starts.length > 0 && quarterAudio.gains.some(gain => gain.value > 0), "a real move must generate native audio nodes");
  await prefs();
  await page.locator(".player-preferences input[type=checkbox]").nth(0).uncheck();
  assert.equal(await page.locator(".player-preferences input[type=range]").isDisabled(), true);
  await prefs(false);
  await clearAudioTrace();
  await clickLegal();
  assert.deepEqual((await audioTrace()).starts, [], "mute must suppress sound generation");
  await prefs();
  await page.locator(".player-preferences input[type=checkbox]").nth(0).check();
  await prefs(false);
  await setVolume(0);
  await clearAudioTrace();
  await clickLegal();
  const zeroAudio = await audioTrace();
  assert.ok(zeroAudio.starts.length === 0 || zeroAudio.gains.every(gain => gain.value === 0), "zero volume must be genuinely silent");
  await setVolume(70);
  for (const scale of [0.9, 1.1, 1]) {
    await prefs();
    await page.locator(".player-preferences select").nth(1).selectOption(String(scale));
    await prefs(false);
    await settle();
    await checkLayout(scale);
    await clickLegal();
  }
  receipt.milestones.push({ audio: { quarterAudio, zeroAudio }, result: "native sound, mute, zero volume and scaled real clicks passed" });
  await page.screenshot({ path: path.join(evidence, "english-720p.png"), fullPage: true });

  phase = "shortcut and canvas reduced motion";
  await prefs();
  await page.locator(".player-preferences input[type=checkbox]").nth(1).check();
  await prefs(false);
  await page.keyboard.press("h");
  await page.waitForFunction(() => document.querySelector("#app")._vnode.component.proxy.controller.renderer.hintPoint, null, { timeout: 30_000 });
  const still = await page.evaluate(() => {
    const renderer = document.querySelector("#app")._vnode.component.proxy.controller.renderer;
    return { reduced: renderer.reducedMotion, frame: renderer._animationFrameId, point: renderer.hintPoint, phase: renderer._hintPulsePhase };
  });
  assert.equal(still.reduced, true);
  assert.equal(still.frame, null, "reduced motion must stop the canvas hint animation loop");
  await prefs();
  await page.locator(".player-preferences input[type=checkbox]").nth(1).uncheck();
  await prefs(false);
  await page.waitForFunction(() => document.querySelector("#app")._vnode.component.proxy.controller.renderer._animationFrameId !== null);
  await prefs();
  await page.locator(".player-preferences input[type=checkbox]").nth(1).check();
  await prefs(false);
  await settle();
  assert.equal(await page.evaluate(() => document.querySelector("#app")._vnode.component.proxy.controller.renderer._animationFrameId), null);
  await page.keyboard.press("Control+s");
  await page.waitForFunction(() => /Current match saved/i.test(document.querySelector(".action-feedback")?.textContent ?? ""));
  const ordinary = await snapshot();
  let ordinaryBytes = fs.readFileSync(saveFile, "utf8");
  await page.locator(".dock-launcher-board").click();
  await page.locator("#hint-max-count").focus();
  await page.keyboard.press("h");
  await page.keyboard.press("Control+s");
  assert.deepEqual(await snapshot(), ordinary, "typing/modal shortcuts must not alter the match");
  await page.keyboard.press("Escape");
  await page.locator(".utility-overlay-board").waitFor({ state: "detached" });
  assert.equal(fs.readFileSync(saveFile, "utf8"), ordinaryBytes);
  receipt.milestones.push("H requested a real hint; reduced motion stopped/resumed/stopped its Canvas loop; Ctrl+S and typing/modal shortcut guards passed");

  phase = "fullscreen and menu exit";
  await page.keyboard.press("F11");
  await page.waitForFunction(() => Boolean(document.fullscreenElement), null, { timeout: 5_000 });
  receipt.fullscreenWindow = await app.evaluate(({ BrowserWindow }) => ({ fullScreen: BrowserWindow.getAllWindows()[0].isFullScreen(), bounds: BrowserWindow.getAllWindows()[0].getBounds() }));
  assert.equal(savedPreferences().fullscreen, true);
  await page.keyboard.press("F11");
  await page.waitForFunction(() => !document.fullscreenElement);
  await prefs();
  await page.getByRole("button", { name: "Save current match", exact: true }).click();
  await prefs(false);
  ordinaryBytes = fs.readFileSync(saveFile, "utf8");
  await page.locator(".player-menu > summary").click();
  await page.locator(".player-menu").getByRole("button", { name: "Continue", exact: true }).click();
  if ((await page.locator(".player-menu").getAttribute("open")) !== null) {
    receipt.findings.push("Menu Continue leaves its menu panel open over the board.");
    await page.locator(".player-menu > summary").click();
  }
  assert.deepEqual(await snapshot(), ordinary);
  await page.keyboard.press("F11");
  await page.waitForFunction(() => Boolean(document.fullscreenElement));
  const beforeQuitPrefs = savedPreferences();
  await page.locator(".player-menu > summary").click();
  const exited = app.waitForEvent("close", { timeout: 15_000 });
  await page.locator(".player-menu").getByRole("button", { name: "Exit game", exact: true }).click({ noWaitAfter: true });
  await exited;
  app = null; page = null;
  await launch();
  assert.equal(await page.locator(".welcome-overlay").isVisible(), false, "returning player keeps selected language");
  assert.deepEqual(await snapshot(), ordinary, "actual Exit game and restart retain the ordinary match without forced teaching");
  const restoredFullScreen = await page.evaluate(() => Boolean(document.fullscreenElement));
  if (!restoredFullScreen) receipt.findings.push("Stored fullscreen=true did not restore actual fullscreen after restart.");
  assert.deepEqual(savedPreferences(), beforeQuitPrefs);
  assert.equal(fs.readFileSync(saveFile, "utf8"), ordinaryBytes);
  receipt.milestones.push("actual fullscreen controls, manual-save button, menu preservation and native Exit game/reopen passed");

  phase = "campaign copy and scrolling";
  await page.locator(".dock-launcher-campaign").click();
  await page.locator(".campaign-level-list").waitFor();
  const listState = await page.evaluate(() => {
    const list = document.querySelector(".campaign-level-list");
    return { count: list.querySelectorAll(".campaign-level-card").length,
      defaultHints: list.querySelectorAll(".campaign-level-card em").length,
      nestedScroll: ["auto", "scroll"].includes(getComputedStyle(list).overflowY) && list.scrollHeight > list.clientHeight + 1 };
  });
  assert.ok(listState.count >= 24);
  assert.equal(listState.defaultHints, 0, "authoring designIntent must not reveal reference moves on default cards");
  assert.equal(listState.nestedScroll, false, "campaign list must use the surrounding modal's single scroll surface");
  await page.locator(".campaign-level-card").last().scrollIntoViewIfNeeded();
  assert.equal(await page.locator(".campaign-level-card").last().isVisible(), true);
  await page.screenshot({ path: path.join(evidence, "campaign-last-level.png"), fullPage: true });
  await page.locator(".utility-overlay-campaign .utility-close").click();
  assert.deepEqual(await snapshot(), ordinary);
  receipt.milestones.push({ campaignPresentation: listState, lastLevelAccessible: true });
  assert.deepEqual(receipt.errors, []);
  assert.deepEqual(receipt.badResponses, []);
  assert.deepEqual(receipt.externalRequests, []);
  assert.equal(hash(archive), receipt.packageSha256);
  receipt.status = receipt.findings.length ? "DESKTOP_UX_PASS_WITH_FINDINGS" : "DESKTOP_UX_PASS";
  if (receipt.findings.length) process.exitCode = 1;
} catch (error) {
  receipt.status = "FAIL"; receipt.phase = phase; receipt.error = String(error.stack ?? error);
  if (page) await page.screenshot({ path: path.join(evidence, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await close().catch(error => { receipt.closeError = String(error); });
  fs.writeFileSync(path.join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
}
