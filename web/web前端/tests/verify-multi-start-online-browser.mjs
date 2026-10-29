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
const baseUrl = option("--base-url", "http://127.0.0.1:8768");
const vueRuntime = option("--vue-runtime", undefined);
const screenshotDirectory = option("--screenshots", undefined);
const outputPath = option("--output", undefined);
if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });

const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const clients = [];

async function createClient(label) {
  const context = await browser.newContext({ viewport: { width: 1180, height: 900 }, locale: "zh-CN" });
  if (vueRuntime) await context.route("**/vue@3/dist/vue.global.prod.js", route => route.fulfill({ path: vueRuntime, contentType: "application/javascript" }));
  await context.route("https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js", route => route.fulfill({
    contentType: "application/javascript",
    body: "globalThis.MathJax = globalThis.MathJax || {}; globalThis.MathJax.typesetPromise = () => Promise.resolve();",
  }));
  await context.route("https://fonts.googleapis.com/**", route => route.fulfill({ contentType: "text/css", body: "" }));
  await context.addInitScript(() => localStorage.setItem("triaxis-language", "zh"));
  const client = { label, context, page: null, consoleErrors: [], badResponses: [], unexpectedExternal: [] };
  clients.push(client);
  await openClientPage(client);
  return client;
}

async function openClientPage(client) {
  const page = await client.context.newPage();
  client.page = page;
  page.on("pageerror", error => client.consoleErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") client.consoleErrors.push(message.text()); });
  page.on("response", response => {
    if (response.status() >= 400 && !/favicon\.ico/.test(response.url())) client.badResponses.push({ url: response.url(), status: response.status() });
  });
  page.on("request", request => {
    if (/^(https?|wss?):/i.test(request.url()) && !request.url().startsWith(baseUrl)
      && !/vue@3\/dist\/vue\.global\.prod\.js/.test(request.url())
      && request.url() !== "https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js"
      && !request.url().startsWith("https://fonts.googleapis.com/")) client.unexpectedExternal.push(request.url());
  });
  await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForFunction(() => document.querySelector("#app")?._vnode?.component?.proxy?.controller?.renderer?.layout, null, { timeout: 30_000 });
  const tutorial = page.getByRole("button", { name: /^(跳过教学|Skip tutorial)$/ });
  if (await tutorial.isVisible()) await tutorial.click();
  return page;
}

const vmState = page => page.evaluate(() => {
  const vm = document.querySelector("#app")?._vnode?.component?.proxy;
  const engine = vm?.controller?.engine;
  const snapshot = engine?.getSnapshot?.();
  if (!vm || !snapshot) return null;
  return {
    roomStatus: vm.roomStatus,
    roomId: vm.session?.roomId ?? null,
    playerId: vm.session?.playerId ?? null,
    color: vm.session?.color ?? null,
    playerCount: vm.roomInfo?.players?.length ?? 0,
    players: (vm.roomInfo?.players ?? []).map(player => ({
      playerId: player.playerId,
      color: player.color,
      connected: player.connected,
      ready: player.ready,
    })),
    matchPhase: vm.roomInfo?.matchPhase ?? null,
    undo: vm.roomInfo?.undo ?? null,
    connectionState: vm.connectionState ?? null,
    rootMode: snapshot.rootMode,
    rootRulesVersion: snapshot.rootRulesVersion,
    rulesVersion: snapshot.rulesVersion,
    revision: snapshot.positionRevision,
    currentPlayer: snapshot.currentPlayer,
    roots: snapshot.roots,
    initialRoots: snapshot.initialRoots,
    rootActionsRemaining: snapshot.rootActionsRemaining,
    consecutiveSkips: snapshot.consecutiveSkips,
    turnCount: snapshot.turnCount,
    edges: snapshot.edges,
    boardMatrix: snapshot.boardMatrix,
    legalMoves: snapshot.legalMoves.map(move => ({ ...move, point: [...move.point] })),
    legalRootActions: snapshot.legalRootActions.map(action => ({ ...action, point: [...action.point] })),
    historyHashes: [...engine.historyHashes],
    positionKeys: [...engine.positionKeys],
    lastServerActionIndex: vm.controller?._lastServerActionIndex ?? 0,
    interactionLocked: vm.gameState?.interactionLocked ?? null,
  };
});

function authoritativeState(state) {
  return {
    roomId: state.roomId,
    rootMode: state.rootMode,
    rootRulesVersion: state.rootRulesVersion,
    rulesVersion: state.rulesVersion,
    revision: state.revision,
    currentPlayer: state.currentPlayer,
    roots: state.roots,
    initialRoots: state.initialRoots,
    rootActionsRemaining: state.rootActionsRemaining,
    consecutiveSkips: state.consecutiveSkips,
    turnCount: state.turnCount,
    edges: state.edges,
    boardMatrix: state.boardMatrix,
    historyHashes: state.historyHashes,
    positionKeys: state.positionKeys,
    lastServerActionIndex: state.lastServerActionIndex,
  };
}

async function registerAndLogin(client, username, password) {
  const page = client.page;
  await page.locator(".dock-launcher-network").click();
  await page.locator(".panel-auth").waitFor({ state: "visible" });
  await page.locator(".panel-auth .auth-tab").nth(1).click();
  await page.locator("#auth-username").fill(username);
  await page.locator("#auth-password").fill(password);
  await page.locator(".panel-auth .action-button-primary").click();
  await page.waitForFunction(() => {
    const vm = document.querySelector("#app")?._vnode?.component?.proxy;
    return vm?.authMode === "login" && !vm?.authBusy;
  });
  await page.locator("#auth-password").fill(password);
  await page.locator(".panel-auth .action-button-primary").click();
  await page.locator(".panel-auth .auth-welcome").waitFor({ state: "visible", timeout: 15_000 });
}

async function configureHost(client) {
  const page = client.page;
  await page.locator(".utility-close").click();
  await page.locator(".dock-launcher-board").click();
  await page.locator('[data-root-mode="add"]').click();
  const undo = page.locator("#undo-enabled");
  if (!(await undo.isChecked())) await undo.check();
  await page.waitForFunction(() => {
    const vm = document.querySelector("#app")?._vnode?.component?.proxy;
    return vm?.selectedStartingPoints?.rootMode === "add" && vm?.selectedUndoEnabled === true;
  });
  await page.locator(".utility-close").click();
}

async function createRoom(client) {
  const page = client.page;
  await page.locator(".dock-launcher-network").click();
  await page.locator(".panel-network .actions-stack > .action-button-secondary").nth(0).click();
  await page.waitForFunction(() => Boolean(document.querySelector("#app")?._vnode?.component?.proxy?.session?.roomId), null, { timeout: 15_000 });
  return (await vmState(page)).roomId;
}

async function joinRoom(client, roomId) {
  const page = client.page;
  await page.locator("#room-id").fill(roomId);
  await page.locator(".panel-network .actions-stack > .action-button-secondary").nth(1).click();
  await page.waitForFunction(expected => document.querySelector("#app")?._vnode?.component?.proxy?.session?.roomId === expected, roomId, { timeout: 15_000 });
}

async function ready(client) {
  await client.page.locator(".room-action-row .action-button-primary").click();
}

async function waitForMatch(client) {
  await client.page.waitForFunction(() => document.querySelector("#app")?._vnode?.component?.proxy?.roomStatus === "inProgress", null, { timeout: 20_000 });
}

async function closeUtility(client) {
  const close = client.page.locator(".utility-close");
  if (await close.isVisible()) await close.click();
}

async function clickPlacement(client, chooseMove = moves => moves[0]) {
  const page = client.page;
  const before = await vmState(page);
  assert.ok(before.legalMoves.length, `${client.label}: expected a legal placement`);
  const move = chooseMove(before.legalMoves);
  assert.ok(move?.point, `${client.label}: move selector must return a legal move`);
  const pixel = await page.evaluate(point => {
    const vm = document.querySelector("#app")._vnode.component.proxy;
    return vm.controller.renderer.getPointPixelCoordinates(point);
  }, move.point);
  await page.locator("canvas.game-canvas").click({ position: pixel });
  return { point: move.point, revision: before.revision };
}

async function waitForRevision(client, minimum) {
  await client.page.waitForFunction(value => {
    const vm = document.querySelector("#app")?._vnode?.component?.proxy;
    return vm?.gameState?.positionRevision >= value;
  }, minimum, { timeout: 15_000 });
}

function clientForColor(host, guest, color, hostState, guestState) {
  if (hostState.color === color) return host;
  if (guestState.color === color) return guest;
  throw new Error(`No browser client owns ${color}`);
}

const runId = Date.now().toString(36);
const password = `multi-start-${runId}`;
let receipt;

try {
  const host = await createClient("host");
  const guest = await createClient("guest");
  await registerAndLogin(host, `ms_host_${runId}`, password);
  await configureHost(host);
  const roomId = await createRoom(host);
  await registerAndLogin(guest, `ms_guest_${runId}`, password);
  await joinRoom(guest, roomId);

  await host.page.waitForFunction(() => document.querySelector("#app")?._vnode?.component?.proxy?.roomInfo?.players?.length === 2);
  await guest.page.waitForFunction(() => document.querySelector("#app")?._vnode?.component?.proxy?.roomInfo?.players?.length === 2);
  await ready(host);
  await ready(guest);
  await Promise.all([waitForMatch(host), waitForMatch(guest)]);
  await Promise.all([closeUtility(host), closeUtility(guest)]);

  let hostState = await vmState(host.page);
  let guestState = await vmState(guest.page);
  assert.equal(hostState.rootMode, "add");
  assert.equal(hostState.rootRulesVersion, "root-v2");
  assert.equal(hostState.rulesVersion, "territory-v3");
  assert.deepEqual(authoritativeState(hostState), authoritativeState(guestState));

  const black = clientForColor(host, guest, "BLACK", hostState, guestState);
  const white = clientForColor(host, guest, "WHITE", hostState, guestState);
  const first = await clickPlacement(black);
  await Promise.all([waitForRevision(host, first.revision + 1), waitForRevision(guest, first.revision + 1)]);
  const second = await clickPlacement(white, moves => moves.reduce((best, move) => {
    const distance = (move.point[0] - first.point[0]) ** 2 + (move.point[1] - first.point[1]) ** 2;
    const bestDistance = (best.point[0] - first.point[0]) ** 2 + (best.point[1] - first.point[1]) ** 2;
    return distance > bestDistance ? move : best;
  }, moves[0]));
  await Promise.all([waitForRevision(host, second.revision + 1), waitForRevision(guest, second.revision + 1)]);

  hostState = await vmState(host.page);
  guestState = await vmState(guest.page);
  const blackAfterMoves = clientForColor(host, guest, "BLACK", hostState, guestState);
  const beforeRootRevision = (await vmState(blackAfterMoves.page)).revision;
  await blackAfterMoves.page.locator(".root-action-targets button").first().click();
  await Promise.all([waitForRevision(host, beforeRootRevision + 1), waitForRevision(guest, beforeRootRevision + 1)]);

  hostState = await vmState(host.page);
  guestState = await vmState(guest.page);
  assert.equal(hostState.roots.BLACK.length, 2);
  assert.equal(hostState.rootActionsRemaining.BLACK.add, 0);
  assert.deepEqual(authoritativeState(hostState), authoritativeState(guestState));
  const beforeReconnect = authoritativeState(hostState);

  const reconnecting = hostState.color === "BLACK" ? host : guest;
  const observer = reconnecting === host ? guest : host;
  await reconnecting.page.close();
  await observer.page.waitForFunction(color => {
    const vm = document.querySelector("#app")?._vnode?.component?.proxy;
    return vm?.roomInfo?.players?.some(player => player.color === color && player.connected === false);
  }, "BLACK", { timeout: 15_000 }).catch(() => {});
  await openClientPage(reconnecting);
  await reconnecting.page.waitForFunction(expected => {
    const vm = document.querySelector("#app")?._vnode?.component?.proxy;
    return vm?.session?.roomId === expected && vm?.roomStatus === "inProgress" && vm?.connectionState === "connected";
  }, roomId, { timeout: 20_000 });
  await observer.page.waitForFunction(() => document.querySelector("#app")?._vnode?.component?.proxy?.roomInfo?.players?.every(player => player.connected), null, { timeout: 15_000 });

  hostState = await vmState(host.page);
  guestState = await vmState(guest.page);
  assert.deepEqual(authoritativeState(hostState), beforeReconnect);
  assert.deepEqual(authoritativeState(guestState), beforeReconnect);

  const blackReconnected = clientForColor(host, guest, "BLACK", hostState, guestState);
  const whiteObserver = blackReconnected === host ? guest : host;
  const undoButton = blackReconnected.page.locator(".duel-actions button").filter({ hasText: /悔棋|Undo/ }).first();
  await undoButton.click();
  await whiteObserver.page.waitForFunction(() => document.querySelector("#app")?._vnode?.component?.proxy?.onlineUndoPending === true, null, { timeout: 15_000 });
  await whiteObserver.page.getByRole("button", { name: /同意悔棋|Agree to undo/ }).click();
  await Promise.all([
    host.page.waitForFunction(value => document.querySelector("#app")?._vnode?.component?.proxy?.gameState?.positionRevision === value, beforeRootRevision, { timeout: 15_000 }),
    guest.page.waitForFunction(value => document.querySelector("#app")?._vnode?.component?.proxy?.gameState?.positionRevision === value, beforeRootRevision, { timeout: 15_000 }),
  ]);

  hostState = await vmState(host.page);
  guestState = await vmState(guest.page);
  assert.equal(hostState.roots.BLACK.length, 1);
  assert.equal(hostState.rootActionsRemaining.BLACK.add, 1);
  assert.equal(hostState.currentPlayer, "BLACK");
  assert.deepEqual(authoritativeState(hostState), authoritativeState(guestState));

  if (screenshotDirectory) {
    await host.page.screenshot({ path: join(screenshotDirectory, "host-after-reconnect-undo.png"), fullPage: true });
    await guest.page.screenshot({ path: join(screenshotDirectory, "guest-after-reconnect-undo.png"), fullPage: true });
  }

  for (const client of clients) {
    assert.deepEqual(client.consoleErrors, [], `${client.label}: console must be clean`);
    assert.deepEqual(client.badResponses, [], `${client.label}: HTTP responses must be clean`);
    assert.deepEqual(client.unexpectedExternal, [], `${client.label}: no unexpected external dependency may be requested`);
  }

  receipt = {
    status: "PASS",
    browser: "two isolated headless Chromium contexts",
    roomId,
    mode: "add",
    played: [first.point, second.point],
    beforeReconnect: {
      revision: beforeReconnect.revision,
      currentPlayer: beforeReconnect.currentPlayer,
      roots: beforeReconnect.roots,
      rootActionsRemaining: beforeReconnect.rootActionsRemaining,
      consecutiveSkips: beforeReconnect.consecutiveSkips,
      historyHashCount: beforeReconnect.historyHashes.length,
      actionIndex: beforeReconnect.lastServerActionIndex,
    },
    afterUndo: {
      revision: hostState.revision,
      currentPlayer: hostState.currentPlayer,
      roots: hostState.roots,
      rootActionsRemaining: hostState.rootActionsRemaining,
      consecutiveSkips: hostState.consecutiveSkips,
      historyHashCount: hostState.historyHashes.length,
      actionIndex: hostState.lastServerActionIndex,
    },
    coverage: [
      "UI registration and login",
      "root-v2 room creation and join",
      "two-client ready and start",
      "authoritative placement and dynamic root action",
      "tab close and authenticated reconnect",
      "roots, quotas, actor, PASS, history and action index recovery",
      "two-client undo vote and atomic quota restoration",
    ],
  };
} finally {
  for (const client of clients) await client.context.close().catch(() => {});
  await browser.close();
}

if (outputPath) await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
